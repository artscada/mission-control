import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const { searchParams } = new URL(request.url)
    const limit = Math.min(Number.parseInt(searchParams.get('limit') || '50', 10) || 50, 200)
    const taskId = Number.parseInt(searchParams.get('task_id') || '', 10)
    const deviceId = Number.parseInt(searchParams.get('device_id') || '', 10)

    const filters = ['r.workspace_id = ?']
    const params: any[] = [workspaceId]
    if (Number.isFinite(taskId)) {
      filters.push('r.task_id = ?')
      params.push(taskId)
    }
    if (Number.isFinite(deviceId)) {
      filters.push('r.device_id = ?')
      params.push(deviceId)
    }
    params.push(limit)

    const runs = db.prepare(`
      SELECT r.*, t.title AS task_title
      FROM operit_runs r
      LEFT JOIN tasks t ON t.id = r.task_id AND t.workspace_id = r.workspace_id
      WHERE ${filters.join(' AND ')}
      ORDER BY r.started_at DESC
      LIMIT ?
    `).all(...params)

    return NextResponse.json({ runs })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/integrations/operit/runs error')
    return NextResponse.json({ error: 'Failed to list Operit runs' }, { status: 500 })
  }
}
