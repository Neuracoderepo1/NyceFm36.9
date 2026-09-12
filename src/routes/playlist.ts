import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requirePermission } from "../middleware/rbac.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import {
  addTrackToPlaylist,
  createPlaylist,
  getPlaylistTracks,
  listPlaylists,
  removeTrackFromPlaylist,
  reorderPlaylist,
  setPlaylistActive,
} from "../services/playlist.js";

export const playlistRouter = Router();

async function resolveStationId(slug: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT id FROM stations WHERE slug = $1", [slug]);
  return rows[0]?.id ?? null;
}

function stationNotFound(req: Request, res: Response) {
  return res.status(404).json({ error: { code: "STATION_NOT_FOUND", message: "Unknown station.", request_id: req.id } });
}

playlistRouter.get("/:station/playlists", requirePermission("playlist.read"), asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return stationNotFound(req, res);
  const playlists = await listPlaylists(stationId);
  res.json({ playlists });
}));

const createSchema = z.object({ name: z.string().min(1).max(120) });

playlistRouter.post("/:station/playlists", requirePermission("playlist.modify"), asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return stationNotFound(req, res);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, request_id: req.id } });
  }
  const id = await createPlaylist(stationId, parsed.data.name, req.session.userId ?? null);
  res.status(201).json({ playlistId: id });
}));

playlistRouter.get("/:station/playlists/:playlistId/tracks", requirePermission("playlist.read"), asyncHandler(async (req, res) => {
  const tracks = await getPlaylistTracks(req.params.playlistId);
  res.json({ tracks });
}));

const addTrackSchema = z.object({ trackId: z.string().uuid() });

playlistRouter.post("/:station/playlists/:playlistId/tracks", requirePermission("playlist.modify"), asyncHandler(async (req, res) => {
  const parsed = addTrackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, request_id: req.id } });
  }
  try {
    await addTrackToPlaylist(req.params.playlistId, parsed.data.trackId);
    res.status(204).send();
  } catch (err) {
    res.status(422).json({ error: { code: "ADD_TRACK_FAILED", message: (err as Error).message, request_id: req.id } });
  }
}));

playlistRouter.delete("/:station/playlists/:playlistId/tracks/:trackId", requirePermission("playlist.modify"), asyncHandler(async (req, res) => {
  await removeTrackFromPlaylist(req.params.playlistId, req.params.trackId);
  res.status(204).send();
}));

const reorderSchema = z.object({ trackIds: z.array(z.string().uuid()).min(1) });

playlistRouter.put("/:station/playlists/:playlistId/order", requirePermission("playlist.modify"), asyncHandler(async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, request_id: req.id } });
  }
  try {
    await reorderPlaylist(req.params.playlistId, parsed.data.trackIds);
    res.status(204).send();
  } catch (err) {
    res.status(422).json({ error: { code: "REORDER_FAILED", message: (err as Error).message, request_id: req.id } });
  }
}));

const activeSchema = z.object({ isActive: z.boolean() });

playlistRouter.patch("/:station/playlists/:playlistId/active", requirePermission("playlist.modify"), asyncHandler(async (req, res) => {
  const stationId = await resolveStationId(req.params.station);
  if (!stationId) return stationNotFound(req, res);
  const parsed = activeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, request_id: req.id } });
  }
  await setPlaylistActive(stationId, req.params.playlistId, parsed.data.isActive);
  res.status(204).send();
}));
