# NYCE FM Production Closeout

## Closed in this pass
- Server `/api/auth/me` now returns authoritative user identity and rejects disabled/stale sessions.
- Supabase private object storage is supported as the media source of truth, with server-only credentials, bucket bootstrap, upload, signed URLs, and FFprobe access.
- Broadcast worker can play Supabase-backed media through short-lived signed URLs while preserving control-revision fencing.
- AI has a real server-side Anthropic adapter and records provider failures as failed `ai_runs`; browser clients never receive provider keys.
- Current Anthropic default is `claude-sonnet-5`; the prior retired Sonnet 4 model is no longer used.
- Stripe Checkout infrastructure is server-side. Tips and subscriptions redirect to Stripe Checkout; webhook HMAC verification is implemented server-side.
- Dashboard media upload now uses the real `/api/media/upload` endpoint rather than simulated progress.
- Dashboard payment controls use the real backend Checkout endpoint and no longer report fake successful purchases.
- Removed the demo crowd-spike operational control.
- Listener playback state is kept separate from authoritative broadcast state.
- Browser production bundle contains no direct Anthropic API call.

## Explicit deployment requirements
1. Set `MEDIA_STORAGE_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET=nycefm-media`.
2. Keep `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and AI keys server-only.
3. Set `AI_PROVIDER=anthropic` only after `ANTHROPIC_API_KEY` is configured and model access is confirmed.
4. Configure `STRIPE_PRICE_<PLAN>` variables and public success/cancel URLs.
5. Set `BROADCAST_WORKER_ENABLED=true` on exactly one worker instance per station unless a distributed leader-election layer is added.
6. Run a clean `npm ci`, `npm run build`, and `npm test` in CI before deployment. The supplied environment previously had incomplete `node_modules`; this pass does not falsely claim a clean build from that environment.
7. Keep the private Supabase media bucket private. Use signed URLs from the server for processor/playout access.
8. The per-track FFmpeg HLS architecture is safe and auditable but is not yet a mathematically seamless 24/7 playout engine; replacing it with a persistent playout process remains the next infrastructure evolution if broadcast-grade gapless continuity is required.
