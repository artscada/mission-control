import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { OperitClient } from '@/lib/integrations/operit/client'
import { mapOperitDeviceRow } from '@/lib/integrations/operit/utils'

export const dynamic = 'force-dynamic'

async function resolveId(params: Promise<{ id: string }>): Promise<number> {
  const { id } = await params
  return Number.parseInt(id, 10)
}

function clamp(value: number | null, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value as number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value as number)))
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const id = await resolveId(params)
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid device id' }, { status: 400 })

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const row = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ? AND enabled = 1').get(id, workspaceId) as any
    if (!row) return NextResponse.json({ error: 'Operit device not found or disabled' }, { status: 404 })

    const display = request.nextUrl.searchParams.get('display') === 'virtual' ? 'virtual' : 'main'
    const format = request.nextUrl.searchParams.get('format') === 'png' ? 'png' : 'jpg'
    const quality = clamp(Number.parseInt(request.nextUrl.searchParams.get('quality') || '', 10), 10, 100, 48)
    const scale = clamp(Number.parseInt(request.nextUrl.searchParams.get('scale') || '', 10), 10, 100, 28)

    const device = mapOperitDeviceRow(row)
    const preview = await new OperitClient(device).preview({ display, format, quality, scale })

    return new NextResponse(Buffer.from(preview.bytes), {
      status: 200,
      headers: {
        'Content-Type': preview.contentType,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    })
  } catch (error: any) {
    logger.error({ err: error }, 'GET /api/integrations/operit/devices/[id]/preview error')
    const message = error?.message || 'Failed to fetch Operit preview'
    const status = / 404 /.test(message) ? 404 : / 409 /.test(message) ? 409 : / 401 /.test(message) ? 502 : 502
    return NextResponse.json({ error: message }, { status })
  }
}
