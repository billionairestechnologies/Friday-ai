import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]{8,128}$/;

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const supplied = req.header("x-request-id");
  req.requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
}
