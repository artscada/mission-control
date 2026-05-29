import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { id } = await params
    const runId = Number.parseInt(id, 10)
    if (!Number.isFinite(runId)) return NextResponse.json({ error: 'Invalid run id' }, { status: 400 })
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const run = db.prepare(`
      SELECT r.*, t.title AS task_title
      FROM operit_runs r
      LEFT JOIN tasks t ON t.id = r.task_id AND t.workspace_id = r.workspace_id
      WHERE r.id = ? AND r.workspace_id = ?
    `).get(runId, workspaceId)
    if (!run) return NextResponse.json({ error: 'Operit run not found' }, { status: 404 })
    return NextResponse.json({ run })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/integrations/operit/runs/[id] error')
    return NextResponse.json({ error: 'Failed to fetch Operit run' }, { status: 500 })
  }
}
