import { Router, type Response } from 'express';
import { authenticate, authIpLimit } from '../../middleware/authenticate.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';

import { normalizeMobile } from '../../lib/phone.js';
import { sendData, sendDone } from '../../lib/response.js';
import { codeBody, labels, loginOtpBody, newMobileOtpBody, newMobileVerifyBody, refreshBody, registerOtpBody, sessionParams, verifyBody } from './auth.schemas.js';
import * as auth from './auth.service.js';
import type { OtpSendResult } from './otp.service.js';

const otpReply = (res: Response, r: OtpSendResult) => sendData(res, r, 200, { messageId: r.messageId, message: r.message });
const outcome = (res: Response, o: auth.Outcome<unknown>, status = 200) =>
  o.messageId ? sendDone(res, o.data, o.messageId, o.params, status) : sendData(res, o.data, status);

/** Double-click on Verify before sign-in: the key is scoped to the mobile number (AC-P01-6). */
const byMobile = idempotent({
  scope: (req) => `otp:${normalizeMobile(String(req.body?.mobile ?? '')) ?? 'invalid'}`,
  redact: ['accessToken', 'refreshToken', 'tokens'],
});

export function authRoutes() {
  const r = Router();

  // P-01 and P-02 (public, CFG-10 per IP)
  r.post('/register/otp', authIpLimit, validate({ body: registerOtpBody }, labels), async (req, res) => otpReply(res, await auth.sendRegisterOtp(req.body, req)));
  r.post('/register/verify', authIpLimit, validate({ body: verifyBody }, labels), byMobile, async (req, res) => outcome(res, await auth.verifyRegister(req.body, req, res), 201));
  r.post('/login/otp', authIpLimit, validate({ body: loginOtpBody }, labels), async (req, res) => otpReply(res, await auth.sendLoginOtp(req.body, req)));
  r.post('/login/verify', authIpLimit, validate({ body: verifyBody }, labels), byMobile, async (req, res) => outcome(res, await auth.verifyLogin(req.body, req, res)));

  // P-03
  r.post('/refresh', validate({ body: refreshBody }), async (req, res) => sendData(res, await auth.refresh(req, res)));
  r.post('/logout', async (req, res) => { await auth.logout(req, res); sendDone(res, null, 'AUTH-16'); });
  r.get('/me', authenticate, async (req, res) => sendData(res, await auth.me(req.auth!)));
  r.get('/sessions', authenticate, async (req, res) => sendData(res, await auth.sessions(req.auth!)));
  r.delete('/sessions/:id', authenticate, validate({ params: sessionParams }), async (req, res) => outcome(res, await auth.endOwnSession(req.auth!, String(req.params.id), req)));

  // Step-up OTP (CFG-83)
  r.post('/step-up/otp', authenticate, async (req, res) => otpReply(res, await auth.sendStepUpOtp(req.auth!, req)));
  r.post('/step-up/verify', authenticate, validate({ body: codeBody }, labels), async (req, res) => sendData(res, await auth.verifyStepUp(req.auth!, req.body.code, req)));

  // P-04
  r.post('/mobile/current/otp', authenticate, async (req, res) => otpReply(res, await auth.sendCurrentMobileOtp(req.auth!, req)));
  r.post('/mobile/current/verify', authenticate, validate({ body: codeBody }, labels), async (req, res) => sendData(res, await auth.verifyCurrentMobile(req.auth!, req.body.code, req)));
  r.post('/mobile/new/otp', authenticate, validate({ body: newMobileOtpBody }, labels), async (req, res) => otpReply(res, await auth.sendNewMobileOtp(req.auth!, req.body, req)));
  r.post('/mobile/new/verify', authenticate, validate({ body: newMobileVerifyBody }, labels), idempotent(), async (req, res) => outcome(res, await auth.verifyNewMobile(req.auth!, req.body, req)));

  return r;
}

