# NYCE FM — Phase 2B execution

## Real capabilities added
1. **Durable media storage** — local filesystem abstraction with size limit, MIME allow-list, SHA-256 integrity and path traversal protection.
2. **Raw audio ingestion** — `POST /api/media/upload`; audio is streamed to disk instead of buffered in memory. Metadata travels in `x-media-*` headers.
3. **FFprobe processing** — uploaded media begins as `processing`; FFprobe derives authoritative duration; valid assets become `ready`.
4. **Queue-driven broadcast** — optional worker claims the next queued track transactionally and updates `now_playing`.
5. **Real FFmpeg HLS** — FFmpeg reads the stored audio in real time and emits an HLS playlist plus segments.
6. **Optional Icecast** — if `ICECAST_HOST`, `ICECAST_PORT`, `ICECAST_SOURCE_PASSWORD` and optional `ICECAST_MOUNT` are configured, a second FFmpeg process publishes the same track as an MP3 Icecast source.
7. **Live synchronization** — `now_playing.elapsed_ms` is updated every second while the track is on air.
8. **Stream observability** — `stream_events` records track start/finish/failure events.
9. **Docker runtime** — production-oriented container includes FFmpeg/FFprobe and persistent media/stream volumes.

## HLS endpoint
`GET /streams/hls/:stationId/index.m3u8`

## Upload contract
Send the request body as raw audio, with `Content-Type` set to one of the supported audio MIME types and `x-media-title` required. Example:

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/media/upload \
  -H 'Content-Type: audio/mpeg' \
  -H 'x-media-title: Example Track' \
  --data-binary @example.mp3
```

## Run locally
Install FFmpeg/FFprobe and set `BROADCAST_WORKER_ENABLED=true`. Run migrations, start PostgreSQL/Redis, then `npm run dev`.

## Run with Docker
Set real secrets in `docker-compose.yml` or, preferably, inject them through your deployment secret manager. Then `docker compose up --build`.

## External infrastructure boundary
This implementation does not fabricate an Icecast server, CDN, object-storage credentials or DNS. HLS works from the application host. Icecast becomes live when actual Icecast credentials/server are supplied.
