import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { ensureOperitAgentRecord } from '@/lib/integrations/operit/agent-link'
import { mapOperitDeviceRow, maskOperitToken, isValidOperitBaseUrl } from '@/lib/integrations/operit/utils'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const devices = db.prepare(`
      SELECT * FROM operit_devices
      WHERE workspace_id = ?
      ORDER BY name COLLATE NOCASE ASC
    `).all(workspaceId) as any[]

    return NextResponse.json({
      devices: devices.map((row) => {
        const mapped = mapOperitDeviceRow(row)
        return {
          ...mapped,
          bearerToken: undefined,
          maskedToken: maskOperitToken(row.bearer_token),
        }
      }),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/integrations/operit/devices error')
    return NextResponse.json({ error: 'Failed to list Operit devices' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json()
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const bearerToken = typeof body?.bearerToken === 'string' ? body.bearerToken.trim() : ''
    const agentName = typeof body?.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : null
    const defaultMode = body?.defaultMode === 'sync' ? 'sync' : body?.defaultMode === 'async_callback' ? 'async_callback' : 'sse'
    const defaultShowFloating = body?.defaultShowFloating ? 1 : 0
    const defaultReturnToolStatus = body?.defaultReturnToolStatus === false ? 0 : 1
    const defaultInitialMode = typeof body?.defaultInitialMode === 'string' && body.defaultInitialMode.trim() ? body.defaultInitialMode.trim() : null
    const enabled = body?.enabled === false ? 0 : 1

    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    if (!baseUrl || !isValidOperitBaseUrl(baseUrl)) {
      return NextResponse.json({ error: 'baseUrl must be a valid http(s) URL' }, { status: 400 })
    }
    if (!bearerToken) return NextResponse.json({ error: 'bearerToken is required' }, { status: 400 })

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const result = db.prepare(`
      INSERT INTO operit_devices (
        name, base_url, bearer_token, enabled, agent_name,
        default_mode, default_show_floating, default_return_tool_status, default_initial_mode,
        workspace_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      name,
      baseUrl,
      bearerToken,
      enabled,
      agentName,
      defaultMode,
      defaultShowFloating,
      defaultReturnToolStatus,
      defaultInitialMode,
      workspaceId,
    )

    const createdDevice = mapOperitDeviceRow({
      id: Number(result.lastInsertRowid),
      name,
      base_url: baseUrl,
      bearer_token: bearerToken,
      enabled,
      agent_name: agentName,
      default_mode: defaultMode,
      default_show_floating: defaultShowFloating,
      default_return_tool_status: defaultReturnToolStatus,
      default_initial_mode: defaultInitialMode,
      version_name: null,
      last_health_status: enabled ? 'pending' : null,
      last_health_at: null,
    })
    const linkedAgent = ensureOperitAgentRecord(db, workspaceId, createdDevice, {
      status: enabled ? 'idle' : 'offline',
      lastActivity: `Operit device ${name} registered in Mission Control`,
    })

    db_helpers.logActivity(
      'operit_device_created',
      'operit_device',
      Number(result.lastInsertRowid),
      auth.user.username,
      `Added Operit device ${name}`,
      { name, baseUrl, agentName, defaultMode },
      workspaceId,
    )

    return NextResponse.json({
      ok: true,
      device: {
        id: Number(result.lastInsertRowid),
        name,
        baseUrl,
        enabled: !!enabled,
        agentName,
        defaultMode,
        defaultShowFloating: !!defaultShowFloating,
        defaultReturnToolStatus: !!defaultReturnToolStatus,
        defaultInitialMode,
        linkedAgentName: linkedAgent.name,
        maskedToken: maskOperitToken(bearerToken),
      },
    }, { status: 201 })
  } catch (error: any) {
    if (String(error?.message || '').includes('UNIQUE constraint')) {
      return NextResponse.json({ error: 'An Operit device with that name already exists' }, { status: 409 })
    }
    logger.error({ err: error }, 'POST /api/integrations/operit/devices error')
    return NextResponse.json({ error: 'Failed to create Operit device' }, { status: 500 })
  }
}
