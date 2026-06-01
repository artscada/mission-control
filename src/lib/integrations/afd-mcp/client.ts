import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { logger } from '@/lib/logger'

interface ToolTextContent {
  type?: string
  text?: string
}

interface ToolResultLike {
  content?: ToolTextContent[]
  isError?: boolean
}

interface JsonRpcSuccess<T> {
  jsonrpc?: string
  id: number
  result: T
}

interface JsonRpcFailure {
  jsonrpc?: string
  id: number | null
  error: {
    code?: number
    message?: string
    data?: unknown
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

interface AfdMcpServerParameters {
  command: string
  args: string[]
  cwd?: string
}

interface McpInitializeResult {
  protocolVersion?: string
  serverInfo?: {
    name?: string
    version?: string
  }
}

interface McpToolCallResponse extends ToolResultLike {}

const DEFAULT_AFD_MCP_COMMAND = 'C:\\AFD-MCP\\start-mcp-server.cmd'
const DEFAULT_AFD_MCP_CWD = 'C:\\AFD-MCP'
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

let afdMcpCallQueue: Promise<unknown> = Promise.resolve()

export interface FleetDeviceRecord {
  id: string
  name: string
  baseUrl: string
  groups: string[]
  enabled: boolean
  healthy: boolean
  busy: boolean
  lastSeenAt: string | null
  lastError: string | null
  updatedAt: string
}

export interface FleetListDevicesResult {
  devices: FleetDeviceRecord[]
  groups: string[]
  total: number
}

export interface FleetHealthDevice extends FleetDeviceRecord {
  error?: string
  version?: string
}

export interface FleetHealthCheckResult {
  checked: number
  healthy: number
  unhealthy: number
  devices: FleetHealthDevice[]
}

export interface FleetRunEntry {
  runId: string
  deviceId: string
  remoteRunId: string | null
  status: string
  responseText: string | null
  errorText: string | null
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface FleetRunSummary {
  jobId: string
  status: string
  mode: string
  waitMode: string
  total: number
  pending: number
  running: number
  completed: number
  failed: number
  timedOut: number
  cancelled: number
  selectedDevices: string[]
  results: FleetRunEntry[]
}

function readTextPayload<T>(result: unknown): T {
  const toolResult = result as ToolResultLike | null | undefined
  const textContent = toolResult?.content?.find((item) => item.type === 'text' && typeof item.text === 'string')
  const text = textContent?.text?.trim()

  if (!text) {
    throw new Error('AFD-MCP tool result does not contain text content')
  }

  if (toolResult?.isError) {
    throw new Error(text.replace(/^Error:\s*/i, '').trim() || 'AFD-MCP tool call failed')
  }

  return JSON.parse(text) as T
}

function parseArgsJson(raw: string | undefined): string[] {
  if (!raw?.trim()) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
      throw new Error('AFD_MCP_ARGS_JSON must be a JSON array of strings')
    }
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid AFD_MCP_ARGS_JSON: ${message}`)
  }
}

function resolveServerParameters(): AfdMcpServerParameters {
  const configuredCommand = process.env.AFD_MCP_COMMAND?.trim() || DEFAULT_AFD_MCP_COMMAND
  const configuredArgs = parseArgsJson(process.env.AFD_MCP_ARGS_JSON)
  const cwd = process.env.AFD_MCP_CWD?.trim() || DEFAULT_AFD_MCP_CWD

  if (/\.(cmd|bat)$/i.test(configuredCommand)) {
    return {
      command: 'cmd.exe',
      args: ['/c', configuredCommand, ...configuredArgs],
      cwd,
    }
  }

  return {
    command: configuredCommand,
    args: configuredArgs,
    cwd,
  }
}

class AfdMcpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly stdoutReader: readline.Interface
  private readonly pending = new Map<number, PendingRequest>()
  private readonly stderrChunks: string[] = []
  private nextId = 1
  private closed = false

  constructor(private readonly server: AfdMcpServerParameters) {
    this.child = spawn(server.command, server.args, {
      cwd: server.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.stdoutReader = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.stdoutReader.on('line', (line) => this.handleStdoutLine(line))
    this.child.stderr.on('data', (chunk) => this.captureStderr(chunk))
    this.child.on('error', (error) => this.failAllPending(new Error(`AFD-MCP process error: ${error.message}`)))
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        const reason = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
        this.failAllPending(new Error(`AFD-MCP process exited with ${reason}${this.formatStderrSuffix()}`))
      }
    })
  }

  async initialize(): Promise<void> {
    const result = await this.sendRequest<McpInitializeResult>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'mission-control-afd-mcp',
        version: '1.0.0',
      },
    }, DEFAULT_CONNECT_TIMEOUT_MS)

    logger.info({ server: this.server, serverInfo: result.serverInfo, protocolVersion: result.protocolVersion }, 'Connected Mission Control to AFD-MCP')
    this.sendNotification('notifications/initialized', {})
  }

  async callTool<T>(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const result = await this.sendRequest<McpToolCallResponse>('tools/call', {
      name,
      arguments: args,
    }, timeoutMs)
    return readTextPayload<T>(result)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    this.stdoutReader.close()
    this.child.stdin.end()

    if (!this.child.killed) {
      this.child.kill()
    }

    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve()
        return
      }

      const timer = setTimeout(() => {
        if (!this.child.killed) {
          this.child.kill('SIGKILL')
        }
      }, 2_000)

      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params })
    this.child.stdin.write(`${payload}\n`)
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`AFD-MCP request timed out for ${method}${this.formatStderrSuffix()}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return

        const pending = this.pending.get(id)
        if (!pending) return

        clearTimeout(pending.timeout)
        this.pending.delete(id)
        reject(new Error(`Failed to write ${method} request to AFD-MCP: ${error.message}`))
      })
    })
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let message: JsonRpcSuccess<unknown> | JsonRpcFailure
    try {
      message = JSON.parse(trimmed) as JsonRpcSuccess<unknown> | JsonRpcFailure
    } catch (error) {
      this.failAllPending(new Error(`AFD-MCP returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    if (typeof message.id !== 'number') {
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pending.delete(message.id)

    if ('error' in message) {
      pending.reject(new Error(message.error?.message || `AFD-MCP request failed with code ${message.error?.code ?? 'unknown'}`))
      return
    }

    pending.resolve(message.result)
  }

  private captureStderr(chunk: string | Buffer): void {
    const text = String(chunk)
    this.stderrChunks.push(text)

    const joined = this.stderrChunks.join('')
    if (joined.length > 8_000) {
      this.stderrChunks.splice(0, this.stderrChunks.length, joined.slice(-8_000))
    }
  }

  private failAllPending(error: Error): void {
    if (this.closed && this.pending.size === 0) {
      return
    }

    const enriched = new Error(`${error.message}${this.formatStderrSuffix()}`)
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(enriched)
      this.pending.delete(id)
    }
  }

  private formatStderrSuffix(): string {
    const stderr = this.stderrChunks.join('').trim()
    return stderr ? ` | stderr: ${stderr}` : ''
  }
}

async function withAfdMcpClient<T>(operation: string, callback: (client: AfdMcpStdioClient) => Promise<T>): Promise<T> {
  const runCall = async (): Promise<T> => {
    const server = resolveServerParameters()
    const client = new AfdMcpStdioClient(server)

    try {
      await client.initialize()
      return await callback(client)
    } catch (error) {
      logger.error({ err: error, operation, server }, 'AFD-MCP client call failed')
      throw error
    } finally {
      await client.close().catch(() => undefined)
    }
  }

  const queued = afdMcpCallQueue.then(runCall, runCall)
  afdMcpCallQueue = queued.then(() => undefined, () => undefined)
  return queued
}

export async function listFleetDevices(): Promise<FleetListDevicesResult> {
  return withAfdMcpClient('fleet.list_devices', async (client) => client.callTool<FleetListDevicesResult>('fleet.list_devices', {}, DEFAULT_REQUEST_TIMEOUT_MS))
}

export async function runFleetHealthCheck(): Promise<FleetHealthCheckResult> {
  return withAfdMcpClient('fleet.health_check', async (client) => client.callTool<FleetHealthCheckResult>('fleet.health_check', {}, DEFAULT_REQUEST_TIMEOUT_MS))
}

export async function runFleetPromptOnDevices(input: {
  deviceIds: string[]
  prompt: string
  timeoutSec?: number
  waitMode?: 'none' | 'all' | 'first' | 'count' | 'deadline'
  waitForCount?: number
  waitDeadlineSec?: number
}): Promise<FleetRunSummary> {
  const timeoutSec = input.timeoutSec ?? 180
  const requestTimeoutMs = Math.max(DEFAULT_REQUEST_TIMEOUT_MS, (timeoutSec + 60) * 1_000)

  return withAfdMcpClient('fleet.run_on_devices', async (client) => client.callTool<FleetRunSummary>('fleet.run_on_devices', {
    device_ids: input.deviceIds,
    prompt: input.prompt,
    timeout_sec: timeoutSec,
    wait_mode: input.waitMode ?? 'all',
    wait_for_count: input.waitForCount,
    wait_deadline_sec: input.waitDeadlineSec,
  }, requestTimeoutMs))
}
