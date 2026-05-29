'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

interface OperitDevice {
  id: number
  name: string
  baseUrl: string
  enabled: boolean
  agentName?: string | null
  defaultMode: 'sync' | 'sse' | 'async_callback'
  defaultShowFloating: boolean
  defaultReturnToolStatus: boolean
  defaultInitialMode?: string | null
  versionName?: string | null
  lastHealthStatus?: string | null
  lastHealthAt?: number | null
  maskedToken?: string | null
}

interface OperitRun {
  id: number
  task_id: number
  task_title?: string | null
  device_name: string
  mode: string
  status: string
  request_id?: string | null
  chat_id?: string | null
  started_at: number
  finished_at?: number | null
  error_message?: string | null
}

const emptyForm = {
  id: null as number | null,
  name: '',
  baseUrl: '',
  bearerToken: '',
  enabled: true,
  agentName: '',
  defaultMode: 'sse' as 'sync' | 'sse',
  defaultShowFloating: false,
  defaultReturnToolStatus: true,
  defaultInitialMode: 'WINDOW',
}

export function OperitPanel() {
  const [devices, setDevices] = useState<OperitDevice[]>([])
  const [runs, setRuns] = useState<OperitRun[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [devicesRes, runsRes] = await Promise.all([
        fetch('/api/integrations/operit/devices'),
        fetch('/api/integrations/operit/runs?limit=12'),
      ])
      const devicesJson = await devicesRes.json()
      const runsJson = await runsRes.json()
      if (!devicesRes.ok) throw new Error(devicesJson.error || 'Failed to load Operit devices')
      if (!runsRes.ok) throw new Error(runsJson.error || 'Failed to load Operit runs')
      setDevices(devicesJson.devices || [])
      setRuns(runsJson.runs || [])
    } catch (error: any) {
      setStatus(error?.message || 'Failed to load Operit data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const resetForm = () => setForm(emptyForm)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setStatus(null)
    try {
      const url = form.id ? `/api/integrations/operit/devices/${form.id}` : '/api/integrations/operit/devices'
      const method = form.id ? 'PUT' : 'POST'
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          baseUrl: form.baseUrl,
          bearerToken: form.bearerToken || undefined,
          enabled: form.enabled,
          agentName: form.agentName || null,
          defaultMode: form.defaultMode,
          defaultShowFloating: form.defaultShowFloating,
          defaultReturnToolStatus: form.defaultReturnToolStatus,
          defaultInitialMode: form.defaultInitialMode || null,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to save Operit device')
      setStatus(form.id ? 'Operit device updated' : 'Operit device added')
      resetForm()
      fetchData()
    } catch (error: any) {
      setStatus(error?.message || 'Failed to save Operit device')
    } finally {
      setSaving(false)
    }
  }

  const handleEdit = (device: OperitDevice) => {
    setForm({
      id: device.id,
      name: device.name,
      baseUrl: device.baseUrl,
      bearerToken: '',
      enabled: device.enabled,
      agentName: device.agentName || '',
      defaultMode: device.defaultMode === 'sync' ? 'sync' : 'sse',
      defaultShowFloating: device.defaultShowFloating,
      defaultReturnToolStatus: device.defaultReturnToolStatus,
      defaultInitialMode: device.defaultInitialMode || 'WINDOW',
    })
    setStatus(`Editing ${device.name}. Leave token blank to keep the current one.`)
  }

  const handleHealth = async (deviceId: number) => {
    setStatus('Running health check...')
    try {
      const response = await fetch(`/api/integrations/operit/devices/${deviceId}/health`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Health check failed')
      setStatus(`Health OK: ${data.health?.version_name || 'unknown version'}`)
      fetchData()
    } catch (error: any) {
      setStatus(error?.message || 'Health check failed')
    }
  }

  const handleDelete = async (deviceId: number, name: string) => {
    if (!confirm(`Delete Operit device ${name}?`)) return
    try {
      const response = await fetch(`/api/integrations/operit/devices/${deviceId}`, { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Delete failed')
      setStatus(`Deleted ${name}`)
      fetchData()
    } catch (error: any) {
      setStatus(error?.message || 'Delete failed')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Operit</h2>
          <p className="text-sm text-muted-foreground">Register LAN-reachable Operit devices and launch Mission Control tasks on them.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={fetchData}>Refresh</Button>
      </div>

      {status && (
        <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm text-foreground/80">
          {status}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
        <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-card/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-foreground">{form.id ? 'Edit device' : 'Add device'}</h3>
            {form.id && <Button type="button" variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>}
          </div>

          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Name</span>
            <input className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} placeholder="operit-204" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Base URL</span>
            <input className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.baseUrl} onChange={(e) => setForm((prev) => ({ ...prev, baseUrl: e.target.value }))} placeholder="http://192.168.28.204:8094" />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Bearer token</span>
            <input className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono" value={form.bearerToken} onChange={(e) => setForm((prev) => ({ ...prev, bearerToken: e.target.value }))} placeholder={form.id ? 'Leave blank to keep current token' : '9479...'} />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Linked agent name</span>
            <input className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.agentName} onChange={(e) => setForm((prev) => ({ ...prev, agentName: e.target.value }))} placeholder="operit-204" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Default mode</span>
              <select className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.defaultMode} onChange={(e) => setForm((prev) => ({ ...prev, defaultMode: e.target.value as 'sync' | 'sse' }))}>
                <option value="sse">SSE</option>
                <option value="sync">Sync</option>
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Initial mode</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2" value={form.defaultInitialMode} onChange={(e) => setForm((prev) => ({ ...prev, defaultInitialMode: e.target.value }))} placeholder="WINDOW" />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground/90">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))} />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground/90">
            <input type="checkbox" checked={form.defaultShowFloating} onChange={(e) => setForm((prev) => ({ ...prev, defaultShowFloating: e.target.checked }))} />
            Show floating UI by default
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground/90">
            <input type="checkbox" checked={form.defaultReturnToolStatus} onChange={(e) => setForm((prev) => ({ ...prev, defaultReturnToolStatus: e.target.checked }))} />
            Return tool status
          </label>

          <Button type="submit" disabled={saving}>{saving ? 'Saving...' : form.id ? 'Update device' : 'Add device'}</Button>
        </form>

        <div className="space-y-6">
          <section className="rounded-xl border border-border bg-card/60 p-4">
            <h3 className="font-medium text-foreground mb-3">Devices</h3>
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading Operit devices...</div>
            ) : devices.length === 0 ? (
              <div className="text-sm text-muted-foreground">No Operit devices configured yet.</div>
            ) : (
              <div className="space-y-3">
                {devices.map((device) => (
                  <div key={device.id} className="rounded-lg border border-border/70 bg-background/50 p-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{device.name}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${device.enabled ? 'bg-green-500/15 text-green-400' : 'bg-zinc-500/15 text-zinc-400'}`}>
                            {device.enabled ? 'enabled' : 'disabled'}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">{device.baseUrl}</div>
                        <div className="text-xs text-muted-foreground">Token: {device.maskedToken || 'not set'}</div>
                        {device.agentName && <div className="text-xs text-muted-foreground">Agent: {device.agentName}</div>}
                      </div>
                      <div className="flex gap-2">
                        <Button variant="secondary" size="sm" onClick={() => handleHealth(device.id)}>Ping</Button>
                        <Button variant="ghost" size="sm" onClick={() => handleEdit(device)}>Edit</Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(device.id, device.name)}>Delete</Button>
                      </div>
                    </div>
                    <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                      <div>Default mode: <span className="text-foreground/90">{device.defaultMode}</span></div>
                      <div>Health: <span className="text-foreground/90">{device.lastHealthStatus || 'unknown'}</span></div>
                      <div>Version: <span className="text-foreground/90">{device.versionName || 'unknown'}</span></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card/60 p-4">
            <h3 className="font-medium text-foreground mb-3">Recent runs</h3>
            {runs.length === 0 ? (
              <div className="text-sm text-muted-foreground">No Operit runs yet.</div>
            ) : (
              <div className="space-y-2">
                {runs.map((run) => (
                  <div key={run.id} className="rounded-lg border border-border/70 bg-background/50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-foreground">{run.task_title || `Task #${run.task_id}`}</div>
                        <div className="text-xs text-muted-foreground">{run.device_name} · {run.mode} · {new Date(run.started_at * 1000).toLocaleString()}</div>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${run.status === 'completed' ? 'bg-green-500/15 text-green-400' : run.status === 'failed' ? 'bg-red-500/15 text-red-400' : 'bg-blue-500/15 text-blue-400'}`}>
                        {run.status}
                      </span>
                    </div>
                    {run.error_message && <div className="mt-2 text-xs text-red-400 whitespace-pre-wrap">{run.error_message}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
