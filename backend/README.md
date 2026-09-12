# NYCE FM — Backend

Production-oriented radio backend: PostgreSQL + Redis + TypeScript/Express, with authenticated control-plane APIs, durable media ingestion, FFprobe inspection, queue-driven FFmpeg broadcast, HLS delivery, optional Icecast publishing, and auditability.

## Phase 2B quick start

```bash
npm install
cp .env.example .env
npm run migrate
# ensure ffmpeg + ffprobe are installed
npm run dev
```

Set `BROADCAST_WORKER_ENABLED=true` to enable automatic queue playback.

### Upload audio
The ingestion endpoint deliberately accepts the audio as a streaming request body so large files are not first buffered into Express JSON memory.

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/media/upload \
  -H 'Content-Type: audio/mpeg' \
  -H 'x-media-title: My Track' \
  -H 'x-media-artist: Artist' \
  --data-binary @my-track.mp3
```

The asset is initially `processing`. FFprobe derives its real duration and promotes it to `ready`.

### HLS

`GET /streams/hls/:stationId/index.m3u8`

Use `/api/broadcast/now-playing` for synchronized metadata. `now_playing.elapsed_ms` is updated while the worker is playing a track.

### Icecast

Configure `ICECAST_HOST`, `ICECAST_PORT`, `ICECAST_SOURCE_PASSWORD`, and optionally `ICECAST_MOUNT` and `ICECAST_AUDIO_BITRATE`. The worker then publishes an MP3 source in parallel with HLS.

No fake/default production credentials are included.

## Docker

```bash
docker compose up --build
```

The container includes FFmpeg/FFprobe and uses persistent volumes for media and stream output. Replace all sample secrets before deployment.
