import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { ensureOperitAgentRecord, hideOperitAgentRecord } from '@/lib/integrations/operit/agent-link'
import { mapOperitDeviceRow, maskOperitToken, isValidOperitBaseUrl } from '@/lib/integrations/operit/utils'

export const dynamic = 'force-dynamic'

async function resolveId(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params
  return Number.parseInt(id, 10)
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const id = await resolveId(params)
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid device id' }, { status: 400 })
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const row = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as any
    if (!row) return NextResponse.json({ error: 'Operit device not found' }, { status: 404 })
    const mapped = mapOperitDeviceRow(row)
    return NextResponse.json({ device: { ...mapped, bearerToken: undefined, maskedToken: maskOperitToken(row.bearer_token) } })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/integrations/operit/devices/[id] error')
    return NextResponse.json({ error: 'Failed to fetch Operit device' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const id = await resolveId(params)
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid device id' }, { status: 400 })
    const body = await request.json()
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const existing = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as any
    if (!existing) return NextResponse.json({ error: 'Operit device not found' }, { status: 404 })

    const updates: string[] = ['updated_at = unixepoch()']
    const values: any[] = []

    if (body?.name !== undefined) {
      const name = String(body.name || '').trim()
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      updates.push('name = ?')
      values.push(name)
    }
    if (body?.baseUrl !== undefined) {
      const baseUrl = String(body.baseUrl || '').trim()
      if (!isValidOperitBaseUrl(baseUrl)) return NextResponse.json({ error: 'baseUrl must be a valid http(s) URL' }, { status: 400 })
      updates.push('base_url = ?')
      values.push(baseUrl)
    }
    if (body?.bearerToken !== undefined) {
      const token = String(body.bearerToken || '').trim()
      if (!token) return NextResponse.json({ error: 'bearerToken cannot be empty' }, { status: 400 })
      updates.push('bearer_token = ?')
      values.push(token)
    }
    if (body?.enabled !== undefined) {
      updates.push('enabled = ?')
      values.push(body.enabled ? 1 : 0)
    }
    if (body?.agentName !== undefined) {
      const agentName = typeof body.agentName === 'string' && body.agentName.trim() ? body.agentName.trim() : null
      updates.push('agent_name = ?')
      values.push(agentName)
    }
    if (body?.defaultMode !== undefined) {
      const defaultMode = body.defaultMode === 'sync' ? 'sync' : body.defaultMode === 'async_callback' ? 'async_callback' : 'sse'
      updates.push('default_mode = ?')
      values.push(defaultMode)
    }
    if (body?.defaultShowFloating !== undefined) {
      updates.push('default_show_floating = ?')
      values.push(body.defaultShowFloating ? 1 : 0)
    }
    if (body?.defaultReturnToolStatus !== undefined) {
      updates.push('default_return_tool_status = ?')
      values.push(body.defaultReturnToolStatus === false ? 0 : 1)
    }
    if (body?.defaultInitialMode !== undefined) {
      const initialMode = typeof body.defaultInitialMode === 'string' && body.defaultInitialMode.trim() ? body.defaultInitialMode.trim() : null
      updates.push('default_initial_mode = ?')
      values.push(initialMode)
    }

    values.push(id, workspaceId)
    db.prepare(`UPDATE operit_devices SET ${updates.join(', ')} WHERE id = ? AND workspace_id = ?`).run(...values)

    const row = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as any
    const mapped = mapOperitDeviceRow(row)
    const linkedAgent = ensureOperitAgentRecord(db, workspaceId, mapped, {
      status: mapped.enabled ? 'idle' : 'offline',
      lastActivity: `Operit device ${mapped.name} settings updated`,
    })

    db_helpers.logActivity(
      'operit_device_updated',
      'operit_device',
      id,
      auth.user.username,
      `Updated Operit device ${existing.name}`,
      { id },
      workspaceId,
    )

    return NextResponse.json({ device: { ...mapped, bearerToken: undefined, linkedAgentName: linkedAgent.name, maskedToken: maskOperitToken(row.bearer_token) } })
  } catch (error: any) {
    if (String(error?.message || '').includes('UNIQUE constraint')) {
      return NextResponse.json({ error: 'An Operit device with that name already exists' }, { status: 409 })
    }
    logger.error({ err: error }, 'PUT /api/integrations/operit/devices/[id] error')
    return NextResponse.json({ error: 'Failed to update Operit device' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const id = await resolveId(params)
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid device id' }, { status: 400 })
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const existing = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as any
    if (!existing) return NextResponse.json({ error: 'Operit device not found' }, { status: 404 })
    db.prepare('DELETE FROM operit_devices WHERE id = ? AND workspace_id = ?').run(id, workspaceId)
    hideOperitAgentRecord(db, workspaceId, id)
    db_helpers.logActivity('operit_device_deleted', 'operit_device', id, auth.user.username, `Deleted Operit device ${existing.name}`, { id }, workspaceId)
    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/integrations/operit/devices/[id] error')
    return NextResponse.json({ error: 'Failed to delete Operit device' }, { status: 500 })
  }
}
