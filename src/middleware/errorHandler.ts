import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../lib/errors.js';
import { errorBody } from '../lib/response.js';
import { logger } from '../lib/logger.js';

export const notFound: RequestHandler = (_req, _res, next) => next(AppError.notFound());

/** Section 2.5: every known cause has its own code and message ID; anything else is GEN-99 with the reference. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId ?? 'unknown';
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error({ err, requestId }, err.message);
    return res.status(err.status).json(errorBody(err, requestId));
  }
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    const e = new AppError(err.type === 'entity.too.large' ? 413 : 400, 'VALIDATION_FAILED', 'GEN-99', { errorId: requestId });
    return res.status(e.status).json(errorBody(e, requestId));
  }
  if (err instanceof mongoose.Error.ValidationError || err?.code === 11000) {
    logger.warn({ err, requestId }, 'Database rule refused a write that the service did not anticipate');
  } else {
    logger.error({ err, requestId }, 'Unhandled error');
  }
  const e = new AppError(500, 'INTERNAL_ERROR', 'GEN-99', { errorId: requestId });
  return res.status(500).json(errorBody(e, requestId));
};
