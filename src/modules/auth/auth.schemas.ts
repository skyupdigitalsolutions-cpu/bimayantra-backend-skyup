import { z } from 'zod';
import { cfgNum } from '../../config/cfg.js';
import { declaration, email, fail, mobile, optional, personName, required } from '../../lib/fields.js';

// FLD-18 OTP: exactly CFG-01 digits.
const otp = () => z.string({ invalid_type_error: 'VAL-19' }).transform((v, ctx) => {
  const code = v.trim();
  return new RegExp(`^\\d{${cfgNum('CFG-01')}}$`).test(code) ? code : fail(ctx, 'VAL-19');
});

export const labels = { email: 'Email', name: 'Full name', mobile: 'Mobile number', termsAccepted: 'Terms', code: 'OTP', newMobile: 'New mobile', changeToken: 'Change request' };

/** Gap fix: the sign-up form (A4) also asks for an email; optional, stored on the advisor and the profile contact. */
export const registerOtpBody = z.object({ name: required(personName()), mobile: required(mobile()), email: optional(email()), termsAccepted: required(declaration()) });
export const loginOtpBody = z.object({ mobile: required(mobile()) });
export const verifyBody = z.object({ mobile: required(mobile()), code: required(otp()) });
export const codeBody = z.object({ code: required(otp()) });
export const refreshBody = z.object({ refreshToken: z.string().min(20).max(4096).optional() });
export const newMobileOtpBody = z.object({ changeToken: required(z.string().min(20).max(200)), newMobile: required(mobile()) });
export const newMobileVerifyBody = newMobileOtpBody.extend({ code: required(otp()) });
export const sessionParams = z.object({ id: z.string().regex(/^ses_[a-f0-9]{28}$/) });