# NYCE FM Phase 2C — Broadcast Continuity & Control Plane

Implemented on top of Phase 2B.

## Delivered
- Continuous queue worker with scheduled-for eligibility.
- Persistent track heartbeat and control revision.
- Authorized pause/resume/skip/next/stop/emergency-stop control API.
- Automation/DJ/emergency broadcast override state.
- Crash/failure incident recording and watchdog heartbeat timeout.
- Worker process termination/recovery path.
- Broadcast programs and recurring weekly schedule schema/API.
- Queue scheduled-for support.
- Full audit events for privileged broadcast controls and overrides.
- Worker status surfaced with now-playing.

## Migration
Run migrations through the existing migration runner; `004_broadcast_continuity.sql` is forward-only.

## API
- GET `/api/broadcast/now-playing`
- GET `/api/broadcast/control-state`
- GET `/api/broadcast/queue`
- GET `/api/broadcast/schedules`
- POST `/api/broadcast/start`
- POST `/api/broadcast/stop`
- POST `/api/broadcast/control`
- POST `/api/broadcast/override`
- POST `/api/broadcast/queue`
- POST `/api/broadcast/schedule`

## Control semantics
- `skip` finishes the current item as `skipped` and automation immediately selects the next item.
- `stop`/`emergency_stop` interrupts the active FFmpeg process; emergency state prevents automation from claiming another track until the override is changed.
- `dj` override establishes an auditable operator-controlled mode; automation will continue only when the override returns to `automation`.

## Verification
The environment did not contain an installed dependency tree, so full TypeScript compilation/integration tests require `npm ci` in a network-enabled project environment. Source-level checks and the Phase 2B FFmpeg behavior remain intact.
