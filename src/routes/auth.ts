import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authenticate, AuthError, getUserPermissions, registerUser } from "../services/auth.js";
import { requireAuth } from "../middleware/rbac.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." },
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(128),
  displayName: z.string().min(1).max(80),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

authRouter.post("/register", registerLimiter, asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, request_id: req.id },
    });
  }
  try {
    const user = await registerUser(
      parsed.data.email.toLowerCase(),
      parsed.data.password,
      parsed.data.displayName
    );
    req.session.userId = user.id;
    req.session.roles = user.roles;
    res.status(201).json({ user });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(409).json({ error: { code: err.code, message: err.message, request_id: req.id } });
    }
    throw err;
  }
}));

authRouter.post("/login", loginLimiter, asyncHandler(async (req, res, next) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message, request_id: req.id },
    });
  }
  try {
    const user = await authenticate(
      parsed.data.email.toLowerCase(),
      parsed.data.password,
      req.ip ?? null
    );
    // IMPORTANT: `throw` inside this callback runs on a separate call stack
    // from the surrounding async function — it is NOT caught by the
    // try/catch here, nor by asyncHandler's .catch(next), and would crash
    // the process as an uncaught exception (the same bug class found in
    // the queue advance race). Route it to next(err) explicitly instead.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      req.session.roles = user.roles;
      res.json({ user });
    });
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === "ACCOUNT_LOCKED" ? 423 : 401;
      return res.status(status).json({ error: { code: err.code, message: err.message, request_id: req.id } });
    }
    throw err;
  }
}));

authRouter.post("/logout", requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: { code: "LOGOUT_FAILED", message: "Could not log out.", request_id: req.id } });
    }
    res.clearCookie("nycefm.sid");
    res.status(204).send();
  });
});

authRouter.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const permissions = await getUserPermissions(req.session.userId!);
  res.json({
    userId: req.session.userId,
    roles: req.session.roles ?? [],
    permissions,
  });
}));
