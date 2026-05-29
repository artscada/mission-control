# Operit HTTP Fleet Guide

This guide describes the phone-farm oriented integration added in this branch for using Android devices running Operit as first-class Mission Control agents over the local network.

## What this integration is for

Mission Control can now treat an Operit-enabled phone as a real worker instead of a generic external system.

That gives you a practical split of responsibilities:

- Mission Control acts as the control plane: visibility, scheduling, task board, cron, message dispatch, and operator UX.
- Operit on the phone acts as the execution runtime: local Codex-style reasoning, root-capable tool access, UI/system automation, HTTP API, and device-native context.

This model is especially useful for phone farms where devices are already configured with Operit, model access, and tool permissions.

## Capabilities added in Mission Control

The branch in this workspace includes the following Operit-focused additions:

- Operit HTTP device discovery and health polling.
- Mission Control-side agent records for Operit devices.
- Task dispatch to Operit over HTTP from the existing orchestration flow.
- Direct operator-to-agent messaging through `/api/agents/message`.
- Live device preview thumbnails in Agent Squad.
- Operit integration panel in the UI.
- Scheduler support so cron-created tasks can be auto-dispatched to Operit-backed agents.
- Better response summarization for tool-style agent output.
- SSE status propagation fixes so Operit agent cards and selectors stay in sync without manual refresh.

## Architecture

The integration assumes each device runs Operit with its HTTP service enabled.

```
Mission Control -> Operit HTTP API -> Operit runtime on Android -> local tools / root / UI / model
```

Typical flow:

1. Mission Control health-checks known Operit devices.
2. Healthy devices are materialized as agents such as `operit-204` or `operit-205`.
3. The operator, scheduler, or task dispatcher targets that agent.
4. Mission Control sends the task or message over the Operit HTTP API.
5. Operit executes the request on-device and returns a response.
6. Mission Control stores the result, updates task state, and reflects status changes in the UI.

## Recommended phone-farm topology

For a local device farm, the most practical layout is:

- One Mission Control instance on the PC.
- One Operit installation per phone.
- One HTTP token per phone.
- A stable LAN IP or DHCP reservation for each device.
- Shared naming convention that maps a device number to the Mission Control agent name.

Example naming:

- `192.168.28.204` -> `operit-204`
- `192.168.28.205` -> `operit-205`

## Device-side requirements

Each phone should have:

- Operit installed and running.
- HTTP external call service enabled.
- A working LLM provider and model configured inside Operit.
- Tool permissions configured for the desired automation depth.
- Root, ADB-root, or accessibility channels configured as needed for the workload.

If the phone is intended to run unattended, the tool permission policy matters just as much as the network connection.

## Mission Control-side behavior

### Agent materialization

Healthy devices are represented as regular Mission Control agents with Operit-specific metadata. This lets existing UI surfaces continue to work with minimal special casing.

### Messaging and dispatch

Mission Control can send a direct message or a task payload to an Operit agent even when there is no classic gateway `session_key`, as long as the agent is linked through the Operit HTTP transport.

### Live previews

Agent Squad can request preview images from the Operit integration and display a low-cost visual heartbeat for each phone.

Recommended operational pattern:

- Use thumbnails for all devices.
- Open a full live panel only for the device currently under operator attention.
- Avoid continuous full-motion streams on every card unless you intentionally want heavy LAN and CPU usage.

### Real-time status correctness

This branch also fixes a stale-state edge case for Operit agents.

Before the fix:

- Operit health updates changed the database record.
- Agent Squad paused polling once SSE connected.
- No SSE event was emitted for some Operit updates.
- The UI could keep showing `error` or `busy` even when the backend already said `idle`.

Now:

- Operit agent creation and status updates emit SSE events.
- The orchestration selector and Agent Squad share the same live store.
- UI status follows backend truth without requiring a manual refresh.

## Cron and autonomous orchestration

This integration is intentionally useful even if you do not use Operit's internal workflow editor.

Mission Control can stay the orchestrator while Operit stays the executor.

Practical pattern:

1. Create recurring work in Mission Control Cron.
2. Let the scheduler spawn or assign tasks.
3. Auto-dispatch assigned tasks to `operit-204`, `operit-205`, and similar agents.
4. Let Operit handle on-device reasoning and tool execution.
5. Review outcomes from the central Mission Control dashboard.

This is a good fit when you want one place for:

- schedule management,
- fleet visibility,
- audit trail,
- operator overrides,
- and device routing.

## Example use cases

### Example 1: Broadcast-style operator command

An operator selects `operit-205` in the Orchestration bar and sends a plain-language command such as opening an app, checking state, or collecting a device-specific result.

Mission Control forwards that message over Operit HTTP and shows a summarized response back in the command result area.

### Example 2: Scheduled device maintenance

A cron rule creates a nightly task assigned to `operit-204`.

The task might instruct the phone to:

- open a target app,
- validate login state,
- clear a temporary UI blocker,
- collect a screenshot,
- and report success or failure.

Mission Control keeps the schedule and task history while Operit performs the local execution.

### Example 3: Root-backed invisible execution

On devices where Operit can use root or adb-root tooling, the agent can act against virtual displays or non-primary display targets.

This is useful for:

- parallelized app sessions,
- background UI workflows,
- less intrusive device usage,
- and scenarios where the main display should remain available for monitoring or another task.

## Known operational dependencies

The Mission Control integration depends on the following external realities being healthy:

- the phone is reachable over LAN,
- the Operit HTTP service is enabled,
- the Bearer token matches,
- Operit itself has a valid upstream or local model configured,
- and reverse callbacks, if used, can reach the PC across the network.

If a request is accepted by Operit but no useful answer comes back, the most common cause is not the MC connector itself but device-side model or permission configuration.

## Suggested deployment practice

For a serious device farm, the most stable workflow is:

1. Reserve static IPs for the phones.
2. Record one token per device.
3. Pre-configure tool permissions on the device.
4. Verify LLM connectivity directly in Operit first.
5. Then connect the phone to Mission Control.
6. Use Mission Control Cron and Agent Squad as the central operator surface.

## Files involved in this branch

The integration work in this workspace primarily touches:

- `src/app/api/integrations/operit/*`
- `src/lib/integrations/operit/*`
- `src/lib/task-dispatch.ts`
- `src/lib/scheduler.ts`
- `src/components/panels/operit-panel.tsx`
- `src/components/panels/agent-squad-panel-phase3.tsx`
- `src/components/panels/orchestration-bar.tsx`
- `src/app/api/agents/message/route.ts`

## Summary

The practical result is that Mission Control can function as a useful control plane for a fleet of Operit-powered Android workers without needing to reduce those phones to dumb remote screens.

Each phone keeps its own execution intelligence through Operit, while Mission Control adds central orchestration, monitoring, scheduling, and operator workflow on top.
