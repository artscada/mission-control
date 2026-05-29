import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { OperitClient } from '@/lib/integrations/operit/client'
import { ensureOperitAgentRecord } from '@/lib/integrations/operit/agent-link'
import { mapOperitDeviceRow } from '@/lib/integrations/operit/utils'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { id } = await params
    const deviceId = Number.parseInt(id, 10)
    if (!Number.isFinite(deviceId)) return NextResponse.json({ error: 'Invalid device id' }, { status: 400 })

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const row = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ?').get(deviceId, workspaceId) as any
    if (!row) return NextResponse.json({ error: 'Operit device not found' }, { status: 404 })
    const device = mapOperitDeviceRow(row)
    const client = new OperitClient(device)

    try {
      const health = await client.health()
      db.prepare(`
        UPDATE operit_devices
        SET version_name = ?, last_health_status = ?, last_health_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ? AND workspace_id = ?
      `).run(health.version_name || null, health.status || 'ok', deviceId, workspaceId)

      ensureOperitAgentRecord(db, workspaceId, {
        ...device,
        versionName: health.version_name || null,
        lastHealthStatus: health.status || 'ok',
        lastHealthAt: Math.floor(Date.now() / 1000),
      }, {
        status: 'idle',
        lastActivity: `Operit health OK (${health.version_name || 'unknown version'})`,
      })

      db_helpers.logActivity('operit_device_health_ok', 'operit_device', deviceId, auth.user.username, `Operit health check succeeded for ${device.name}`, health, workspaceId)
      return NextResponse.json({ ok: true, health })
    } catch (error: any) {
      db.prepare(`
        UPDATE operit_devices
        SET last_health_status = ?, last_health_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ? AND workspace_id = ?
      `).run(`error:${error.message}`, deviceId, workspaceId)
      ensureOperitAgentRecord(db, workspaceId, {
        ...device,
        lastHealthStatus: `error:${error.message}`,
        lastHealthAt: Math.floor(Date.now() / 1000),
      }, {
        status: 'error',
        lastActivity: `Operit health failed: ${error.message}`,
      })
      throw error
    }
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/integrations/operit/devices/[id]/health error')
    return NextResponse.json({ error: error?.message || 'Operit health check failed' }, { status: 502 })
  }
}
