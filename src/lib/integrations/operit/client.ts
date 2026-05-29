import { logger } from '@/lib/logger'
import type {
  OperitChatRequest,
  OperitDeviceConfig,
  OperitExecutionResult,
  OperitHealthResponse,
  OperitStreamEvent,
  OperitSyncResponse,
} from './types'

const DEFAULT_TIMEOUT_MS = 120_000

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function buildHeaders(token: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  headers.set('Authorization', `Bearer ${token}`)
  return headers
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timeout)
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

async function safeJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T
  } catch {
    return null
  }
}

export class OperitClient {
  constructor(private readonly device: OperitDeviceConfig) {}

  async preview(options: {
    display?: 'main' | 'virtual'
    format?: 'jpg' | 'png'
    quality?: number
    scale?: number
  } = {}): Promise<{ contentType: string; bytes: Uint8Array }> {
    const url = new URL(`${normalizeBaseUrl(this.device.baseUrl)}/api/screen-preview`)
    url.searchParams.set('display', options.display === 'virtual' ? 'virtual' : 'main')
    url.searchParams.set('format', options.format === 'png' ? 'png' : 'jpg')
    if (Number.isFinite(options.quality)) url.searchParams.set('quality', String(options.quality))
    if (Number.isFinite(options.scale)) url.searchParams.set('scale', String(options.scale))

    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: buildHeaders(this.device.bearerToken),
    }, 20_000)

    if (!response.ok) {
      const body = await safeText(response)
      throw new Error(`Operit preview request failed: ${response.status} ${body || response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    return {
      contentType: response.headers.get('content-type') || 'image/jpeg',
      bytes: new Uint8Array(buffer),
    }
  }

  async health(): Promise<OperitHealthResponse> {
    const url = `${normalizeBaseUrl(this.device.baseUrl)}/api/health`
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: buildHeaders(this.device.bearerToken),
    }, 15_000)

    if (!response.ok) {
      const body = await safeText(response)
      throw new Error(`Operit health check failed: ${response.status} ${body || response.statusText}`)
    }

    const json = await safeJson<OperitHealthResponse>(response)
    if (!json) throw new Error('Operit health check returned invalid JSON')
    return json
  }

  async runSync(payload: OperitChatRequest): Promise<OperitExecutionResult> {
    const url = `${normalizeBaseUrl(this.device.baseUrl)}/api/external-chat`
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: buildHeaders(this.device.bearerToken, {
        'Content-Type': 'application/json; charset=utf-8',
      }),
      body: JSON.stringify({
        ...payload,
        response_mode: 'sync',
      }),
    })

    const bodyText = await safeText(response)
    if (!response.ok) {
      throw new Error(`Operit sync request failed: ${response.status} ${bodyText || response.statusText}`)
    }

    let parsed: OperitSyncResponse
    try {
      parsed = JSON.parse(bodyText) as OperitSyncResponse
    } catch {
      throw new Error('Operit sync response was not valid JSON')
    }

    if (!parsed.success) {
      throw new Error(parsed.error || 'Operit sync execution failed')
    }

    return {
      requestId: parsed.request_id || payload.request_id,
      chatId: parsed.chat_id || null,
      aiResponse: parsed.ai_response || '',
      rawStream: bodyText,
    }
  }

  async runSse(payload: OperitChatRequest, onEvent?: (event: OperitStreamEvent) => void): Promise<OperitExecutionResult> {
    const url = `${normalizeBaseUrl(this.device.baseUrl)}/api/external-chat`
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: buildHeaders(this.device.bearerToken, {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json; charset=utf-8',
      }),
      body: JSON.stringify({
        ...payload,
        stream: true,
      }),
    })

    if (!response.ok || !response.body) {
      const bodyText = await safeText(response)
      throw new Error(`Operit SSE request failed: ${response.status} ${bodyText || response.statusText}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let requestId = payload.request_id
    let chatId: string | null = null
    let aiResponse = ''
    let rawStream = ''
    let terminalError: string | null = null

    const processBlock = (block: string) => {
      const raw = block.trim()
      if (!raw) return
      rawStream += `${raw}\n\n`

      const lines = raw.split(/\r?\n/)
      let eventName = 'message'
      const dataLines: string[] = []
      for (const line of lines) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || 'message'
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim())
        }
      }

      const dataText = dataLines.join('\n')
      let data: any = dataText
      try {
        data = JSON.parse(dataText)
      } catch {
        // keep raw text
      }

      if (data && typeof data === 'object') {
        if (typeof data.request_id === 'string' && data.request_id) requestId = data.request_id
        if (typeof data.chat_id === 'string' && data.chat_id) chatId = data.chat_id
        if (typeof data.delta === 'string') aiResponse += data.delta
        if (typeof data.ai_response === 'string') aiResponse = data.ai_response
        if (eventName === 'error' || data.success === false) terminalError = data.error || 'Operit SSE execution failed'
      }

      onEvent?.({ event: eventName, data, raw })
    }

    const findBoundary = (input: string): { index: number; length: number } | null => {
      const lf = input.indexOf('\n\n')
      const crlf = input.indexOf('\r\n\r\n')
      if (lf === -1 && crlf === -1) return null
      if (lf === -1) return { index: crlf, length: 4 }
      if (crlf === -1) return { index: lf, length: 2 }
      return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = findBoundary(buffer)
      while (boundary) {
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        processBlock(block)
        boundary = findBoundary(buffer)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) processBlock(buffer)

    if (terminalError) {
      logger.warn({ device: this.device.name, requestId, terminalError }, 'Operit SSE run finished with error')
      throw new Error(terminalError)
    }

    return {
      requestId,
      chatId,
      aiResponse,
      rawStream,
    }
  }
}
