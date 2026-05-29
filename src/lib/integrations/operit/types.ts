export type OperitMode = 'sync' | 'sse' | 'async_callback'

export interface OperitDeviceConfig {
  id: number
  name: string
  baseUrl: string
  bearerToken: string
  enabled: boolean
  agentName?: string | null
  defaultMode: OperitMode
  defaultShowFloating: boolean
  defaultReturnToolStatus: boolean
  defaultInitialMode?: string | null
  versionName?: string | null
  lastHealthStatus?: string | null
  lastHealthAt?: number | null
}

export interface OperitHealthResponse {
  status?: string
  enabled?: boolean
  service_running?: boolean
  port?: number
  version_name?: string
}

export interface OperitChatRequest {
  request_id: string
  message: string
  group?: string
  create_new_chat?: boolean
  chat_id?: string
  create_if_none?: boolean
  show_floating?: boolean
  return_tool_status?: boolean
  initial_mode?: string
  auto_exit_after_ms?: number
  stop_after?: boolean
  response_mode?: 'sync' | 'async_callback'
  callback_url?: string
  stream?: boolean
}

export interface OperitSyncResponse {
  request_id?: string
  success: boolean
  chat_id?: string
  ai_response?: string
  error?: string
}

export interface OperitStreamEvent {
  event: string
  data: any
  raw: string
}

export interface OperitExecutionResult {
  requestId: string
  chatId?: string | null
  aiResponse: string
  rawStream?: string | null
}
