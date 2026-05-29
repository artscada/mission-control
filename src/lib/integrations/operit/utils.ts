import type { OperitDeviceConfig } from './types'

export function maskOperitToken(token: string | null | undefined): string | null {
  if (!token) return null
  if (token.length <= 8) return '•'.repeat(token.length)
  return `${token.slice(0, 4)}••••••${token.slice(-4)}`
}

export function mapOperitDeviceRow(row: any): OperitDeviceConfig {
  return {
    id: Number(row.id),
    name: String(row.name),
    baseUrl: String(row.base_url),
    bearerToken: String(row.bearer_token),
    enabled: !!row.enabled,
    agentName: row.agent_name || null,
    defaultMode: row.default_mode || 'sse',
    defaultShowFloating: !!row.default_show_floating,
    defaultReturnToolStatus: row.default_return_tool_status == null ? true : !!row.default_return_tool_status,
    defaultInitialMode: row.default_initial_mode || null,
    versionName: row.version_name || null,
    lastHealthStatus: row.last_health_status || null,
    lastHealthAt: row.last_health_at || null,
  }
}

export function isValidOperitBaseUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function parseTaskMetadata(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
