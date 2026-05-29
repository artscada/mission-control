import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { runOpenClaw } from '@/lib/command'
import { requireRole } from '@/lib/auth'
import { validateBody, createMessageSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { scanForInjection } from '@/lib/injection-guard'
import { scanForSecrets } from '@/lib/secret-scanner'
import { logSecurityEvent } from '@/lib/security-events'
import { randomUUID } from 'node:crypto'
import { OperitClient } from '@/lib/integrations/operit/client'
import { ensureOperitAgentRecord } from '@/lib/integrations/operit/agent-link'
import { mapOperitDeviceRow } from '@/lib/integrations/operit/utils'

function parseJsonObject(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function preview(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, createMessageSchema)
    if ('error' in result) return result.error
    const { to, message } = result.data
    const from = auth.user.display_name || auth.user.username || 'system'

    // Scan message for injection — this gets forwarded directly to an agent
    const injectionReport = scanForInjection(message, { context: 'prompt' })
    if (!injectionReport.safe) {
      const criticals = injectionReport.matches.filter(m => m.severity === 'critical')
      if (criticals.length > 0) {
        logger.warn({ to, rules: criticals.map(m => m.rule) }, 'Blocked agent message: injection detected')
        return NextResponse.json(
          { error: 'Message blocked: potentially unsafe content detected', injection: criticals.map(m => ({ rule: m.rule, description: m.description })) },
          { status: 422 }
        )
      }
    }

    const secretHits = scanForSecrets(message)
    if (secretHits.length > 0) {
      try { logSecurityEvent({ event_type: 'secret_exposure', severity: 'critical', source: 'agent-message', agent_name: from, detail: JSON.stringify({ count: secretHits.length, types: secretHits.map(s => s.type) }), workspace_id: auth.user.workspace_id ?? 1, tenant_id: 1 }) } catch {}
    }

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1;
    const agent = db
      .prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?')
      .get(to, workspaceId) as any
    if (!agent) {
      return NextResponse.json({ error: 'Recipient agent not found' }, { status: 404 })
    }

    const agentConfig = parseJsonObject(agent.config)
    const operitInfo = agentConfig.operit && typeof agentConfig.operit === 'object' ? agentConfig.operit : null
    const isOperitAgent = agent.source === 'operit' || agentConfig.integration === 'operit_http'

    if (isOperitAgent) {
      const deviceId = Number.parseInt(String(operitInfo?.deviceId || ''), 10)
      if (!Number.isFinite(deviceId)) {
        return NextResponse.json({ error: 'Operit agent is missing a linked device id' }, { status: 400 })
      }

      const deviceRow = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ? AND enabled = 1').get(deviceId, workspaceId) as any
      if (!deviceRow) {
        return NextResponse.json({ error: 'Linked Operit device not found or disabled' }, { status: 404 })
      }

      const device = mapOperitDeviceRow(deviceRow)
      const client = new OperitClient(device)
      const now = Math.floor(Date.now() / 1000)

      const result = await client.runSync({
        request_id: randomUUID(),
        message: `Сообщение из Mission Control от ${from}.\n\n${message}`,
        group: 'mission-control',
        create_new_chat: true,
        show_floating: device.defaultShowFloating,
        return_tool_status: device.defaultReturnToolStatus,
        initial_mode: device.defaultInitialMode || undefined,
      })

      ensureOperitAgentRecord(db, workspaceId, {
        ...device,
        lastHealthStatus: device.lastHealthStatus || 'ok',
        lastHealthAt: now,
        versionName: device.versionName || null,
      }, {
        status: 'idle',
        lastActivity: `Direct Operit message completed: ${preview(message, 80)}`,
        now,
      })

      db_helpers.createNotification(
        to,
        'message',
        'Operit Direct Message',
        `${from}: ${preview(result.aiResponse, 200)}`,
        'agent',
        agent.id,
        workspaceId
      )

      db_helpers.logActivity(
        'agent_message',
        'agent',
        agent.id,
        from,
        `Sent direct message to ${to} via Operit`,
        { to, transport: 'operit_http', requestId: result.requestId, chatId: result.chatId, response_preview: preview(result.aiResponse) },
        workspaceId
      )

      return NextResponse.json({
        success: true,
        transport: 'operit_http',
        requestId: result.requestId,
        chatId: result.chatId,
        response: result.aiResponse,
        responsePreview: preview(result.aiResponse),
      })
    }

    if (!agent.session_key) {
      return NextResponse.json(
        { error: 'Recipient agent has no session key configured' },
        { status: 400 }
      )
    }

    await runOpenClaw(
      [
        'gateway',
        'sessions_send',
        '--session',
        agent.session_key,
        '--message',
        `Message from ${from}: ${message}`
      ],
      { timeoutMs: 10000 }
    )

    db_helpers.createNotification(
      to,
      'message',
      'Direct Message',
      `${from}: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`,
      'agent',
      agent.id,
      workspaceId
    )

    db_helpers.logActivity(
      'agent_message',
      'agent',
      agent.id,
      from,
      `Sent message to ${to}`,
      { to },
      workspaceId
    )

    return NextResponse.json({ success: true })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/message error')
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}
