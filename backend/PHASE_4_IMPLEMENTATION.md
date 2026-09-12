# NYCE FM — Phase 4: AI DJ & Station Intelligence

## Delivered
- Provider-neutral AI boundary (`AiProvider`).
- Deterministic local rules provider (`local-rules-v1`) requiring no external credential.
- Context assembly from now-playing, queue, audience, recent events and AI policy.
- Auditable `ai_runs` and `ai_actions` records.
- Explicit policy validation before any action can execute.
- Human approval path for proposed actions.
- Opt-in autonomous worker with hourly action budget.
- AI station configuration with human-approval default ON.
- AI voice segment records (text only; TTS provider remains an adapter boundary).
- RBAC permissions: `ai.read`, `ai.control`, `ai.configure`.
- REST API under `/api/ai`.

## Safety model
AI cannot directly execute arbitrary SQL, spawn processes, control FFmpeg, or bypass broadcast controls. It emits typed actions. The application validates each action, records the decision, and only then invokes an existing broadcast/media path. `skip_track` is deliberately blocked from AI execution until it is wired through the existing broadcast-control authorization path.

Autonomous execution is disabled unless both `AI_WORKER_ENABLED=true` and station `autonomous_mode=true`; human approval remains the default.

## API
- `GET /api/ai/config`
- `PUT /api/ai/config`
- `GET /api/ai/runs`
- `GET /api/ai/actions`
- `POST /api/ai/decide`
- `POST /api/ai/actions/:actionId/execute`

## Migration
`006_ai_station_intelligence.sql`

## Runtime flags
`AI_WORKER_ENABLED=false` is the safe default. Autonomous operation additionally requires the station's `autonomous_mode=true` and `enabled=true`. Human approval remains the default (`require_human_approval=true`).
