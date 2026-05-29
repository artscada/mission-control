import { randomUUID } from 'node:crypto'
import { OperitClient } from './client'
import { buildOperitPrompt } from './prompt'
import type { OperitDeviceConfig, OperitExecutionResult, OperitMode } from './types'

export interface ExecuteOperitTaskInput {
  task: { title: string; description?: string | null }
  device: OperitDeviceConfig
  mode: OperitMode
  showFloating?: boolean
  returnToolStatus?: boolean
  createNewChat?: boolean
  group?: string
  initialMode?: string | null
}

export interface ExecuteOperitTaskOutput extends OperitExecutionResult {
  prompt: string
  mode: OperitMode
}

export async function executeOperitTask(input: ExecuteOperitTaskInput): Promise<ExecuteOperitTaskOutput> {
  const prompt = buildOperitPrompt(input.task, input.device.name)
  const requestId = randomUUID()
  const client = new OperitClient(input.device)
  const payload = {
    request_id: requestId,
    message: prompt,
    group: input.group || 'mission-control',
    create_new_chat: input.createNewChat ?? true,
    show_floating: input.showFloating ?? input.device.defaultShowFloating,
    return_tool_status: input.returnToolStatus ?? input.device.defaultReturnToolStatus,
    initial_mode: input.initialMode || input.device.defaultInitialMode || undefined,
  }

  const result = input.mode === 'sync'
    ? await client.runSync(payload)
    : await client.runSse(payload)

  return {
    ...result,
    prompt,
    mode: input.mode,
  }
}
