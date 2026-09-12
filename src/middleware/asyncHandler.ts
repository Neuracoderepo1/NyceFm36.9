import type { NextFunction, Request, Response } from "express";

/**
 * Express 4 does not forward rejected promises from async route handlers
 * to the error-handling middleware automatically — an uncaught rejection
 * there becomes an unhandled promise rejection, which crashes the process
 * by default on modern Node. Wrap every async handler with this so errors
 * always reach the centralized error handler instead of taking the server
 * (and the whole broadcast) down.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
