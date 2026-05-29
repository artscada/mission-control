import type Database from 'better-sqlite3'
import type { OperitDeviceConfig } from './types'
import { eventBus } from '@/lib/event-bus'

type AgentStatus = 'offline' | 'idle' | 'busy' | 'error'

interface EnsureOperitAgentOptions {
  status?: AgentStatus
  lastActivity?: string | null
  now?: number
}

function parseAgentConfig(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function buildAgentEventPayload(
  db: Database.Database,
  workspaceId: number,
  agentId: number,
) {
  const row = db.prepare(`
    SELECT * FROM agents
    WHERE id = ? AND workspace_id = ?
    LIMIT 1
  `).get(agentId, workspaceId) as any

  if (!row) return null

  return {
    ...row,
    config: parseAgentConfig(row.config),
    taskStats: {
      total: 0,
      assigned: 0,
      in_progress: 0,
      quality_review: 0,
      done: 0,
      completed: 0,
    },
  }
}

export function resolveOperitLinkedAgentName(device: Pick<OperitDeviceConfig, 'name' | 'agentName'>): string {
  const linked = typeof device.agentName === 'string' ? device.agentName.trim() : ''
  return linked || device.name
}

export function deriveOperitAgentStatus(device: Pick<OperitDeviceConfig, 'enabled' | 'lastHealthStatus'>, fallback: AgentStatus = 'idle'): AgentStatus {
  if (!device.enabled) return 'offline'
  if (typeof device.lastHealthStatus === 'string' && device.lastHealthStatus.startsWith('error:')) return 'error'
  return fallback
}

export function ensureOperitAgentRecord(
  db: Database.Database,
  workspaceId: number,
  device: OperitDeviceConfig,
  options: EnsureOperitAgentOptions = {},
): { id: number | null; name: string; created: boolean; adoptedExisting: boolean } {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const agentName = resolveOperitLinkedAgentName(device)
  const status = options.status ?? deriveOperitAgentStatus(device)
  const lastSeen = status === 'offline' ? null : now

  const operitConfig = {
    integration: 'operit_http',
    operit: {
      deviceId: device.id,
      deviceName: device.name,
      agentName,
      baseUrl: device.baseUrl,
      defaultMode: device.defaultMode,
      defaultInitialMode: device.defaultInitialMode || null,
      enabled: device.enabled,
      versionName: device.versionName || null,
      lastHealthStatus: device.lastHealthStatus || null,
      lastHealthAt: device.lastHealthAt || null,
    },
  }

  const byDeviceId = db.prepare(`
    SELECT * FROM agents
    WHERE workspace_id = ?
      AND source = 'operit'
      AND json_extract(config, '$.operit.deviceId') = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(workspaceId, device.id) as any

  if (byDeviceId) {
    const mergedConfig = {
      ...parseAgentConfig(byDeviceId.config),
      ...operitConfig,
      operit: {
        ...parseAgentConfig(byDeviceId.config).operit,
        ...operitConfig.operit,
      },
    }
    db.prepare(`
      UPDATE agents
      SET name = ?,
          role = 'assistant',
          status = ?,
          last_seen = ?,
          last_activity = ?,
          updated_at = ?,
          config = ?,
          source = 'operit',
          runtime_type = 'codex',
          hidden = 0
      WHERE id = ? AND workspace_id = ?
    `).run(
      agentName,
      status,
      lastSeen,
      options.lastActivity || `Operit device ${device.name} linked`,
      now,
      JSON.stringify(mergedConfig),
      byDeviceId.id,
      workspaceId,
    )
    const payload = buildAgentEventPayload(db, workspaceId, Number(byDeviceId.id))
    if (payload) {
      eventBus.broadcast('agent.status_changed', {
        ...payload,
        status,
        last_seen: lastSeen,
        last_activity: options.lastActivity || `Operit device ${device.name} linked`,
      })
    }
    return { id: Number(byDeviceId.id), name: agentName, created: false, adoptedExisting: false }
  }

  const byName = db.prepare(`
    SELECT * FROM agents
    WHERE name = ? AND workspace_id = ?
    LIMIT 1
  `).get(agentName, workspaceId) as any

  if (byName) {
    return { id: Number(byName.id), name: agentName, created: false, adoptedExisting: true }
  }

  const result = db.prepare(`
    INSERT INTO agents (
      name, role, status, last_seen, last_activity,
      created_at, updated_at, config, workspace_id, runtime_type, source, hidden
    ) VALUES (?, 'assistant', ?, ?, ?, ?, ?, ?, ?, 'codex', 'operit', 0)
  `).run(
    agentName,
    status,
    lastSeen,
    options.lastActivity || `Operit device ${device.name} registered`,
    now,
    now,
    JSON.stringify(operitConfig),
    workspaceId,
  )

  const createdId = Number(result.lastInsertRowid)
  const payload = buildAgentEventPayload(db, workspaceId, createdId)
  if (payload) {
    eventBus.broadcast('agent.created', payload)
  }

  return { id: createdId, name: agentName, created: true, adoptedExisting: false }
}

export function hideOperitAgentRecord(
  db: Database.Database,
  workspaceId: number,
  deviceId: number,
  now = Math.floor(Date.now() / 1000),
) {
  const row = db.prepare(`
    SELECT id, name FROM agents
    WHERE workspace_id = ?
      AND source = 'operit'
      AND json_extract(config, '$.operit.deviceId') = ?
    LIMIT 1
  `).get(workspaceId, deviceId) as { id?: number; name?: string } | undefined

  db.prepare(`
    UPDATE agents
    SET status = 'offline',
        hidden = 1,
        last_activity = ?,
        updated_at = ?
    WHERE workspace_id = ?
      AND source = 'operit'
      AND json_extract(config, '$.operit.deviceId') = ?
  `).run('Operit device removed', now, workspaceId, deviceId)

  if (row?.id) {
    const payload = buildAgentEventPayload(db, workspaceId, Number(row.id))
    if (payload) {
      eventBus.broadcast('agent.status_changed', {
        ...payload,
        status: 'offline',
        hidden: 1,
        last_activity: 'Operit device removed',
      })
    }
  }
}
