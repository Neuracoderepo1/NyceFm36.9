import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/rbac.js";
import { recordAuditEvent } from "../services/audit.js";

export const paymentsRouter = Router();

const checkoutSchema = z.object({
  kind: z.enum(["tip", "subscription"]),
  amountCents: z.number().int().min(100).max(50000).optional(),
  plan: z.string().regex(/^[A-Z0-9_-]{2,40}$/).optional(),
});

function requireStripe() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("PAYMENTS_NOT_CONFIGURED");
  return secret;
}

async function stripeRequest(path: string, params: URLSearchParams) {
  const secret = requireStripe();
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`STRIPE_ERROR_${response.status}:${String(payload.error && (payload.error as { message?: string }).message ?? "request failed")}`);
  return payload;
}

paymentsRouter.post("/checkout", requireAuth, async (req, res) => {
  const body = checkoutSchema.parse(req.body ?? {});
  const successUrl = process.env.STRIPE_SUCCESS_URL ?? `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}/?payment=success`;
  const cancelUrl = process.env.STRIPE_CANCEL_URL ?? `${process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"}/?payment=cancelled`;
  const params = new URLSearchParams({
    mode: body.kind === "subscription" ? "subscription" : "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: req.session.userId!,
    "metadata[user_id]": req.session.userId!,
    "metadata[kind]": body.kind,
  });

  if (body.kind === "tip") {
    if (!body.amountCents) throw new Error("TIP_AMOUNT_REQUIRED");
    params.set("line_items[0][price_data][currency]", process.env.STRIPE_CURRENCY ?? "usd");
    params.set("line_items[0][price_data][product_data][name]", "NYCE FM listener tip");
    params.set("line_items[0][price_data][unit_amount]", String(body.amountCents));
    params.set("line_items[0][quantity]", "1");
  } else {
    if (!body.plan) throw new Error("SUBSCRIPTION_PLAN_REQUIRED");
    const priceId = process.env[`STRIPE_PRICE_${body.plan}`];
    if (!priceId) throw new Error("SUBSCRIPTION_PRICE_NOT_CONFIGURED");
    params.set("line_items[0][price]", priceId);
    params.set("line_items[0][quantity]", "1");
  }

  const session = await stripeRequest("checkout/sessions", params);
  await recordAuditEvent({ actorId: req.session.userId!, action: "PAYMENT_CHECKOUT_CREATED", resourceType: "stripe_checkout_session", resourceId: String(session.id), afterState: { kind: body.kind, plan: body.plan ?? null, amountCents: body.amountCents ?? null }, correlationId: req.id });
  res.status(201).json({ checkoutUrl: session.url, sessionId: session.id });
});

export async function handleStripeWebhook(req: Request, res: Response) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: { code: "PAYMENTS_NOT_CONFIGURED", message: "Stripe webhook verification is not configured." } });
  const signature = req.header("stripe-signature");
  if (!signature) return res.status(400).json({ error: { code: "STRIPE_SIGNATURE_REQUIRED", message: "Missing Stripe signature." } });
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
  const fields = Object.fromEntries(signature.split(",").map((part) => { const [k,v] = part.split("=",2); return [k,v]; }));
  const timestamp = Number(fields.t);
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw.toString("utf8")}`).digest("hex");
  const received = fields.v1 ?? "";
  const valid = Number.isFinite(timestamp) && Math.abs(Date.now()/1000 - timestamp) <= 300 && received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) return res.status(400).json({ error: { code: "STRIPE_SIGNATURE_INVALID", message: "Invalid Stripe webhook signature." } });
  let event: { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
  try { event = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).json({ error: { code: "STRIPE_WEBHOOK_INVALID_JSON", message: "Invalid webhook payload." } }); }
  await recordAuditEvent({ actorId: null, action: `STRIPE_WEBHOOK_${String(event.type ?? "UNKNOWN").toUpperCase().replace(/[^A-Z0-9_]+/g, "_")}`, resourceType: "stripe_event", resourceId: String(event.id ?? "unknown"), afterState: { type: event.type, object: event.data?.object ?? {} }, correlationId: req.id });
  res.json({ received: true });
}
