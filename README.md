# NYCE FM — Production Closeout Bundle

This bundle contains the hardened NYCE FM dashboard and backend through the production closeout pass.

## Included
- Production dashboard wired to the real API, cookie-backed auth, fenced broadcast control, server-governed AI actions, real media upload, audience/broadcast state, and Stripe Checkout.
- Complete local migration chain 001–012, including the production security/data-plane/control-plane migrations that were previously applied only to the live database.
- Supabase private object-storage support with server-only service credentials and signed URLs.
- Server-side Anthropic integration; no AI provider secret is present in frontend code.
- Server-side Stripe Checkout and webhook HMAC verification.
- AI provider failure recording and audit events.

## Deployment
1. Create a clean environment and run `npm ci`.
2. Configure `.env` from `.env.example`.
3. Set `MEDIA_STORAGE_PROVIDER=supabase` for the private Supabase media bucket.
4. Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`.
5. Configure `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` only when AI is desired.
6. Configure Stripe secret, webhook secret, price IDs, and success/cancel URLs.
7. Run `npm run migrate`, `npm run build`, and `npm test` in CI.
8. Deploy the API and dashboard behind the same origin (or explicitly configure CORS and cookie settings).
9. Run exactly one broadcast worker per station until distributed leader election is introduced.

## Honest verification status
The live Supabase project was successfully updated with migration 012 and its control-plane functions remain present. The supplied container previously had incomplete/corrupted `node_modules`; a clean dependency reinstall timed out, so this artifact does not claim a clean TypeScript build or test run from the current container. Dashboard JavaScript syntax was verified successfully.

## Remaining architectural evolution
The broadcast worker currently produces HLS per track. It is operational and auditable, but a truly gapless 24/7 playout engine should eventually use a persistent media process/stream server rather than starting a new FFmpeg process per track.
