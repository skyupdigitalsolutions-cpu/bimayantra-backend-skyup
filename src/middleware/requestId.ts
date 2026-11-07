import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

// Accept an upstream ID from Nginx (X-Request-Id) only if it is well-formed; otherwise mint one.
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};