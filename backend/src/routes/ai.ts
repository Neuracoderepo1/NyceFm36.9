import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/rbac.js";
import { getAiActions, getAiConfig, getAiRuns, runAiCycle, approveAndExecuteAction, upsertAiConfig } from "../services/aiDj.js";

export const aiRouter = Router();
const station = z.string().uuid().optional();

aiRouter.get("/config", requirePermission("ai.read"), async (req,res)=>res.json({config:await getAiConfig(typeof req.query.stationId==='string'?req.query.stationId:undefined)}));
aiRouter.get("/actions", requirePermission("ai.read"), async (req,res)=>res.json({actions:await getAiActions(typeof req.query.stationId==='string'?req.query.stationId:undefined)}));
aiRouter.get("/runs", requirePermission("ai.read"), async (req,res)=>res.json({runs:await getAiRuns(typeof req.query.stationId==='string'?req.query.stationId:undefined)}));

aiRouter.post("/decide", requirePermission("ai.control"), async (req,res)=>{
  const b=z.object({stationId:station,mode:z.enum(["recommendation","autonomous"]).default("recommendation"),requestedActionType:z.enum(["speak"]).optional(),hint:z.enum(["shoutout","track_intro"]).optional()}).parse(req.body??{});
  res.status(201).json(await runAiCycle({stationId:b.stationId,mode:b.mode,requestedActionType:b.requestedActionType,hint:b.hint,actorId:req.session.userId!,correlationId:req.id}));
});

aiRouter.post("/actions/:actionId/execute", requirePermission("ai.control"), async (req,res)=>{
  res.json(await approveAndExecuteAction({actionId:req.params.actionId,actorId:req.session.userId!,correlationId:req.id}));
});

aiRouter.put("/config", requirePermission("ai.configure"), async (req,res)=>{
  const b=z.object({stationId:station,enabled:z.boolean(),autonomousMode:z.boolean(),maxActionsPerHour:z.number().int().min(1).max(500).default(30),maxConsecutiveAiTracks:z.number().int().min(1).max(20).default(3),minRequestConfidence:z.number().min(0).max(1).default(.75),requireHumanApproval:z.boolean().default(true),systemPrompt:z.string().max(10000).optional()}).parse(req.body??{});
  res.json({config:await upsertAiConfig({stationId:b.stationId,actorId:req.session.userId!,enabled:b.enabled,autonomousMode:b.autonomousMode,maxActionsPerHour:b.maxActionsPerHour,maxConsecutiveAiTracks:b.maxConsecutiveAiTracks,minRequestConfidence:b.minRequestConfidence,requireHumanApproval:b.requireHumanApproval,systemPrompt:b.systemPrompt,correlationId:req.id})});
});
