import type { OperitDeviceConfig } from '../operit/types'
import { buildOperitPrompt } from '../operit/prompt'
import { listFleetDevices, runFleetHealthCheck, runFleetPromptOnDevices, type FleetDeviceRecord, type FleetHealthDevice, type FleetRunEntry, type FleetRunSummary } from './client'

export interface LinkedFleetHealthResult {
  fleetDevice: FleetDeviceRecord
  health: FleetHealthDevice
}

export interface LinkedFleetRunResult {
  prompt: string
  fleetDevice: FleetDeviceRecord
  summary: FleetRunSummary
  run: FleetRunEntry
}

function normalizeUrl(value: string | null | undefined): string {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase()
}

function matchFleetDevice(localDevice: OperitDeviceConfig, devices: FleetDeviceRecord[]): FleetDeviceRecord | null {
  const localBaseUrl = normalizeUrl(localDevice.baseUrl)
  const localName = localDevice.name.trim().toLowerCase()
  const localAgentName = (localDevice.agentName || '').trim().toLowerCase()

  return devices.find((device) => {
    const fleetId = device.id.trim().toLowerCase()
    const fleetName = device.name.trim().toLowerCase()
    const fleetBaseUrl = normalizeUrl(device.baseUrl)

    return fleetId === localName
      || fleetName === localName
      || (localAgentName && (fleetId === localAgentName || fleetName === localAgentName))
      || (localBaseUrl && fleetBaseUrl === localBaseUrl)
  }) ?? null
}

export async function resolveLinkedFleetDevice(localDevice: OperitDeviceConfig): Promise<FleetDeviceRecord> {
  const listing = await listFleetDevices()
  const matched = matchFleetDevice(localDevice, listing.devices)
  if (!matched) {
    throw new Error(`AFD-MCP does not have a linked device for ${localDevice.name}`)
  }
  return matched
}

export async function healthCheckLinkedDevice(localDevice: OperitDeviceConfig): Promise<LinkedFleetHealthResult> {
  const fleetDevice = await resolveLinkedFleetDevice(localDevice)
  const health = await runFleetHealthCheck()
  const deviceHealth = health.devices.find((device) => device.id === fleetDevice.id)
  if (!deviceHealth) {
    throw new Error(`AFD-MCP health check did not return ${fleetDevice.id}`)
  }

  return { fleetDevice, health: deviceHealth }
}

export async function runTaskOnLinkedDevice(
  task: { title: string; description?: string | null },
  localDevice: OperitDeviceConfig,
  options?: { timeoutSec?: number },
): Promise<LinkedFleetRunResult> {
  const prompt = buildOperitPrompt(task, localDevice.name)
  return runPromptOnLinkedDevice(localDevice, prompt, options)
}

export async function runPromptOnLinkedDevice(
  localDevice: OperitDeviceConfig,
  prompt: string,
  options?: { timeoutSec?: number },
): Promise<LinkedFleetRunResult> {
  const fleetDevice = await resolveLinkedFleetDevice(localDevice)
  const summary = await runFleetPromptOnDevices({
    deviceIds: [fleetDevice.id],
    prompt,
    timeoutSec: options?.timeoutSec ?? 180,
    waitMode: 'all',
  })

  const run = summary.results.find((entry) => entry.deviceId === fleetDevice.id)
  if (!run) {
    throw new Error(`AFD-MCP did not return a run result for ${fleetDevice.id}`)
  }

  return {
    prompt,
    fleetDevice,
    summary,
    run,
  }
}

export function buildMissionControlMessagePrompt(from: string, message: string): string {
  return `Сообщение из Mission Control от ${from}.\n\n${message}`
}
