import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { ensureOperitAgentRecord, resolveOperitLinkedAgentName } from '@/lib/integrations/operit/agent-link'
import { mapOperitDeviceRow, parseTaskMetadata } from '@/lib/integrations/operit/utils'
import { eventBus } from '@/lib/event-bus'
import { healthCheckLinkedDevice, runTaskOnLinkedDevice } from '@/lib/integrations/afd-mcp/bridge'

export const dynamic = 'force-dynamic'

function preview(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const now = Math.floor(Date.now() / 1000)

  try {
    const { id } = await params
    const taskId = Number.parseInt(id, 10)
    if (!Number.isFinite(taskId)) return NextResponse.json({ error: 'Invalid task id' }, { status: 400 })

    const body = await request.json().catch(() => ({}))
    const deviceId = Number.parseInt(String(body?.deviceId || ''), 10)
    if (!Number.isFinite(deviceId)) return NextResponse.json({ error: 'deviceId is required' }, { status: 400 })

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as any
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

    const deviceRow = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ? AND enabled = 1').get(deviceId, workspaceId) as any
    if (!deviceRow) return NextResponse.json({ error: 'Operit device not found or disabled' }, { status: 404 })
    const device = mapOperitDeviceRow(deviceRow)
    const linkedAgentName = resolveOperitLinkedAgentName(device)
    const requestedMode = body?.mode === 'sync' ? 'sync' : body?.mode === 'async_callback' ? 'async_callback' : (device.defaultMode || 'sse')
    const mode = `afd_mcp:${requestedMode}`

    const { fleetDevice, health } = await healthCheckLinkedDevice(device)
    if (!health.healthy) {
      throw new Error(health.error || `AFD-MCP reports ${fleetDevice.id} as unhealthy`)
    }

    db.prepare(`
      UPDATE operit_devices
      SET version_name = ?, last_health_status = ?, last_health_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(device.versionName || null, health.busy ? 'busy' : 'ok', now, now, deviceId, workspaceId)
    ensureOperitAgentRecord(db, workspaceId, {
      ...device,
      lastHealthStatus: health.busy ? 'busy' : 'ok',
      lastHealthAt: now,
      versionName: device.versionName || null,
    }, {
      status: 'busy',
      lastActivity: `AFD-MCP task starting: ${task.title}`,
      now,
    })

    const initialResult = db.prepare(`
      INSERT INTO operit_runs (task_id, device_id, device_name, agent_name, mode, status, started_at, workspace_id)
      VALUES (?, ?, ?, ?, ?, 'started', ?, ?)
    `).run(taskId, deviceId, device.name, linkedAgentName, mode, now, workspaceId)
    const runId = Number(initialResult.lastInsertRowid)

    const currentMetadata = parseTaskMetadata(task.metadata)
    const nextMetadata = {
      ...currentMetadata,
      executor_type: 'operit_http',
      operit: {
        ...(currentMetadata.operit || {}),
        device_id: device.id,
        device_name: device.name,
        mode,
        transport: 'afd_mcp',
        last_run_id: runId,
        group: 'mission-control',
      },
    }

    db.prepare(`
      UPDATE tasks
      SET status = 'in_progress',
          assigned_to = COALESCE(?, assigned_to),
          error_message = NULL,
          metadata = ?,
          updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(linkedAgentName, JSON.stringify(nextMetadata), now, taskId, workspaceId)

    db_helpers.logActivity(
      'operit_run_started',
      'task',
      taskId,
      auth.user.username,
      `Started AFD-MCP run on ${device.name} for task ${task.title}`,
      { runId, deviceId, mode, fleetDeviceId: fleetDevice.id },
      workspaceId,
    )
    eventBus.broadcast('task.updated', { id: taskId, status: 'in_progress', workspace_id: workspaceId })

    const result = await runTaskOnLinkedDevice(
      { title: task.title, description: task.description || null },
      device,
      { timeoutSec: Number.isFinite(Number(body?.timeoutSec)) ? Number(body.timeoutSec) : 180 },
    )

    if (result.run.status !== 'completed') {
      throw new Error(result.run.errorText || `AFD-MCP run finished with status ${result.run.status}`)
    }

    const finishedAt = Math.floor(Date.now() / 1000)
    db.prepare(`
      UPDATE operit_runs
      SET request_id = ?, chat_id = ?, status = 'completed', prompt_text = ?, response_text = ?, raw_stream = ?, finished_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(
      result.run.remoteRunId,
      null,
      result.prompt,
      result.run.responseText,
      null,
      finishedAt,
      runId,
      workspaceId,
    )

    const successMetadata = {
      ...nextMetadata,
      operit: {
        ...(nextMetadata.operit || {}),
        request_id: result.run.remoteRunId,
        chat_id: null,
        last_run_id: runId,
        last_status: 'completed',
      },
    }

    db.prepare(`
      UPDATE tasks
      SET status = 'review', resolution = ?, error_message = NULL, metadata = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(result.run.responseText, JSON.stringify(successMetadata), finishedAt, taskId, workspaceId)

    db_helpers.logActivity(
      'operit_run_completed',
      'task',
      taskId,
      auth.user.username,
      `Completed AFD-MCP run on ${device.name} for task ${task.title}`,
      { runId, deviceId, requestId: result.run.remoteRunId, chatId: null, fleetJobId: result.summary.jobId, preview: preview(result.run.responseText || '') },
      workspaceId,
    )
    ensureOperitAgentRecord(db, workspaceId, {
      ...device,
      lastHealthStatus: health.busy ? 'busy' : 'ok',
      lastHealthAt: finishedAt,
      versionName: device.versionName || null,
    }, {
      status: 'idle',
      lastActivity: `AFD-MCP task completed: ${task.title}`,
      now: finishedAt,
    })
    eventBus.broadcast('task.updated', { id: taskId, status: 'review', workspace_id: workspaceId })

    return NextResponse.json({
      ok: true,
      run: {
        id: runId,
        device: device.name,
        mode,
        requestId: result.run.remoteRunId,
        chatId: null,
        preview: preview(result.run.responseText || ''),
      },
      task: {
        id: taskId,
        status: 'review',
      },
    })
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/integrations/operit/tasks/[id]/run error')

    try {
      const { id } = await params
      const taskId = Number.parseInt(id, 10)
      if (Number.isFinite(taskId)) {
        const failedAt = Math.floor(Date.now() / 1000)
        const existingRun = db.prepare(`
          SELECT id FROM operit_runs
          WHERE task_id = ? AND workspace_id = ?
          ORDER BY id DESC LIMIT 1
        `).get(taskId, workspaceId) as { id?: number } | undefined
        if (existingRun?.id) {
          db.prepare(`
            UPDATE operit_runs
            SET status = 'failed', error_message = ?, finished_at = ?
            WHERE id = ? AND workspace_id = ?
          `).run(error?.message || 'Operit run failed', failedAt, existingRun.id, workspaceId)
        }

        const taskRow = db.prepare('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, workspaceId) as { metadata?: string } | undefined
        const failedMetadata = parseTaskMetadata(taskRow?.metadata)
        if (failedMetadata.operit) {
          failedMetadata.operit.last_status = 'failed'
          failedMetadata.operit.last_error = error?.message || 'Operit run failed'
        }

        db.prepare(`
          UPDATE tasks
          SET status = 'failed', error_message = ?, metadata = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?
        `).run(error?.message || 'Operit run failed', JSON.stringify(failedMetadata), failedAt, taskId, workspaceId)

        db_helpers.logActivity(
          'operit_run_failed',
          'task',
          taskId,
          auth.user.username,
          `Operit run failed for task ${taskId}`,
          { error: error?.message || 'Operit run failed' },
          workspaceId,
        )
        const deviceRow = db.prepare('SELECT * FROM operit_devices WHERE id = ? AND workspace_id = ?').get((failedMetadata.operit?.device_id || null), workspaceId) as any
        if (deviceRow) {
          const device = mapOperitDeviceRow(deviceRow)
          ensureOperitAgentRecord(db, workspaceId, {
            ...device,
            lastHealthStatus: device.lastHealthStatus || `error:${error?.message || 'Operit run failed'}`,
            lastHealthAt: failedAt,
          }, {
            status: 'error',
            lastActivity: `Operit task failed: ${error?.message || 'Operit run failed'}`,
            now: failedAt,
          })
        }
        eventBus.broadcast('task.updated', { id: taskId, status: 'failed', workspace_id: workspaceId })
      }
    } catch {
      // best effort failure handling
    }

    return NextResponse.json({ error: error?.message || 'Operit run failed' }, { status: 502 })
  }
}
