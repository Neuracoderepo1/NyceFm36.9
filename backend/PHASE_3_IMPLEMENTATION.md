# NYCE FM — Phase 3 Listener & Audience Platform

Implemented on top of Phase 2C.

## Audience capabilities
- Real-time station snapshot: now playing, listener presence, recent chat, reactions and active polls.
- Anonymous or authenticated listener identity without requiring authentication for public engagement.
- Presence heartbeat with 90-second active-listener window.
- Song requests with moderation lifecycle.
- Dedications with moderation lifecycle.
- Reactions tied optionally to the current media asset.
- Polls and one-vote-per-user/anonymous-identity constraints.
- Listener chat with persisted moderation state.
- Generic audience telemetry/event collection for future analytics and AI-DJ context.
- Moderator APIs for message and request queues.

## API
- GET `/api/audience/snapshot`
- POST `/api/audience/presence`
- POST `/api/audience/events`
- POST `/api/audience/requests`
- POST `/api/audience/dedications`
- POST `/api/audience/reactions`
- GET `/api/audience/polls`
- POST `/api/audience/polls/:pollId/vote`
- GET `/api/audience/chat`
- POST `/api/audience/chat`
- GET `/api/audience/moderation/messages`
- POST `/api/audience/moderation/messages/:messageId`
- GET `/api/audience/moderation/requests`
- POST `/api/audience/moderation/requests/:requestId`

## Database migration
`src/db/migrations/005_audience_platform.sql`

The migration adds listener profiles/presence, requests, dedications, reactions, polls/votes, chat/moderation and an audience event stream. New `audience.*` permissions are wired to moderator/admin roles.

## Security
- Public endpoints are rate-limited.
- Authenticated sessions are used when present; anonymous IDs are generated client-side/server-side for public participation.
- Moderation actions require server-side RBAC and are audit logged.
- Polls use partial unique indexes to prevent duplicate votes per identity.

## Deliberate boundary
Phase 3 does not introduce a websocket dependency. The API is designed around polling/SSE-compatible state and durable events. WebSocket/SSE fanout can be added as a transport optimization after the data contract is stable.

## Additional Phase 3 execution
- Public media search for listener requests.
- Admin-configurable polls with publish/close lifecycle.
- 5-second Server-Sent Events audience snapshot stream for listener/studio clients.
- 24-hour audience analytics summary.
- Request moderation transitions are audit logged.
