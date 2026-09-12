import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { requirePermission } from "../middleware/rbac.js";
import { getDefaultStationId } from "../services/broadcast.js";
import { recordAuditEvent } from "../services/audit.js";

export const playlistsRouter = Router();

playlistsRouter.get("/", requirePermission("playlist.read"), async (req,res) => {
  const stationId = typeof req.query.stationId === "string" ? req.query.stationId : await getDefaultStationId();
  const { rows } = await pool.query(`SELECT p.*, COUNT(pi.id)::int AS item_count FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id=p.id WHERE p.station_id=$1 GROUP BY p.id ORDER BY p.created_at DESC`,[stationId]);
  res.json({ playlists: rows });
});

playlistsRouter.post("/", requirePermission("playlist.modify"), async (req,res) => {
  const body = z.object({stationId:z.string().uuid().optional(),name:z.string().trim().min(1).max(200),description:z.string().max(1000).optional(),kind:z.enum(["manual","smart","system"]).default("manual")}).parse(req.body);
  const stationId=body.stationId??await getDefaultStationId();
  const {rows}=await pool.query(`INSERT INTO playlists(station_id,name,description,kind,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[stationId,body.name,body.description??null,body.kind,req.session.userId]);
  await recordAuditEvent({actorId:req.session.userId??null,action:"PLAYLIST_CREATED",resourceType:"playlist",resourceId:rows[0].id,afterState:{name:body.name,stationId},correlationId:req.id});
  res.status(201).json({playlist:rows[0]});
});

playlistsRouter.post("/:playlistId/items", requirePermission("playlist.modify"), async (req,res) => {
  const body=z.object({mediaAssetId:z.string().uuid(),position:z.number().int().nonnegative().optional()}).parse(req.body);
  const playlist=await pool.query<{station_id:string}>(`SELECT station_id FROM playlists WHERE id=$1`,[req.params.playlistId]);
  if(!playlist.rows[0]) return res.status(404).json({error:{code:"PLAYLIST_NOT_FOUND",message:"Playlist not found.",request_id:req.id}});
  const asset=await pool.query<{station_id:string}>(`SELECT station_id FROM media_assets WHERE id=$1 AND status='ready'`,[body.mediaAssetId]);
  if(!asset.rows[0] || asset.rows[0].station_id !== playlist.rows[0].station_id) return res.status(404).json({error:{code:"MEDIA_ASSET_NOT_FOUND",message:"Ready media asset not found for playlist station.",request_id:req.id}});
  const maxResult=await pool.query<{max:string|null}>(`SELECT MAX(position)::text AS max FROM playlist_items WHERE playlist_id=$1`,[req.params.playlistId]);
  const position=body.position ?? (maxResult.rows[0]?.max === null ? 0 : Number(maxResult.rows[0].max)+1);
  const {rows}=await pool.query(`INSERT INTO playlist_items(playlist_id,media_asset_id,position) VALUES($1,$2,$3) RETURNING *`,[req.params.playlistId,body.mediaAssetId,position]);
  await recordAuditEvent({actorId:req.session.userId??null,action:"PLAYLIST_ITEM_ADDED",resourceType:"playlist_item",resourceId:rows[0].id,afterState:{playlistId:req.params.playlistId,mediaAssetId:body.mediaAssetId,position},correlationId:req.id});
  res.status(201).json({item:rows[0]});
});

playlistsRouter.get("/:playlistId/items", requirePermission("playlist.read"), async (req,res) => {
  const {rows}=await pool.query(`SELECT pi.*, ma.title, ma.artist, ma.album, ma.duration_ms, ma.cover_art_key FROM playlist_items pi JOIN media_assets ma ON ma.id=pi.media_asset_id WHERE pi.playlist_id=$1 ORDER BY pi.position`,[req.params.playlistId]);
  res.json({items:rows});
});
