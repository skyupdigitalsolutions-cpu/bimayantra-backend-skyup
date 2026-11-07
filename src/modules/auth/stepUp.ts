import type { Request, RequestHandler } from 'express';
import type { ClientSession } from 'mongoose';
import { cfgBool } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { maskMobile } from '../../lib/phone.js';
import { findGrant, useGrant } from './otp.service.js';

/**
 * Step-up OTP before a sensitive action (CFG-83, AUTH-26): the client calls /auth/step-up/otp and
 * /auth/step-up/verify, then sends the returned token in "X-Step-Up-Token". The token is checked here
 * and used up by the service only when the action succeeds, so a refused action can be corrected and retried.
 */
export const requireStepUp: RequestHandler = async (req, _res, next) => {
  if (!cfgBool('CFG-83')) return next();
  const grant = await findGrant('STEP_UP', req.auth!, req.get('x-step-up-token'));
  if (!grant) throw new AppError(403, 'STEP_UP_REQUIRED', 'AUTH-26', { 'masked mobile': maskMobile(req.auth!.mobile)! });
  req.stepUpId = grant._id;
  next();
};

export async function useStepUp(stepUpId: string | undefined, usedFor: string, session: ClientSession | null) {
  if (stepUpId) await useGrant(stepUpId, usedFor, session);
}

/** Reads the step-up token when one is sent (a bad one is refused); without one the request continues. */
export const optionalStepUp: RequestHandler = async (req, res, next) => {
  if (!cfgBool('CFG-83') || !req.get('x-step-up-token')) return next();
  return requireStepUp(req, res, next);
};
/** For actions that publish directly (no admin approval, client decision Q92): the OTP is required at that moment. */
export function assertStepUp(req: Request) {
  if (!cfgBool('CFG-83')) return;
  if (!req.stepUpId) throw new AppError(403, 'STEP_UP_REQUIRED', 'AUTH-26', { 'masked mobile': maskMobile(req.auth!.mobile)! });
}