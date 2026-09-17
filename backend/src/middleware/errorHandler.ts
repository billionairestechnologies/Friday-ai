import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const status = err instanceof HttpError ? err.status : err instanceof ZodError ? 400 : 500;
  const message =
    err instanceof HttpError
      ? err.message
      : err instanceof ZodError
        ? (err.issues[0]?.message ?? "Invalid request")
        : "Unexpected server error";
  if (status >= 500) {
    console.error(`[${req.requestId}]`, err);
  }
  res.status(status).json({ error: message, requestId: req.requestId });
}
