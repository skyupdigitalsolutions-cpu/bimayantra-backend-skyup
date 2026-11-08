import { env } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import { maskMobile } from '../../lib/phone.js';
import { redisCache } from '../../lib/redis.js';
import { sendFlowSms, sendOtp } from '../../lib/msg91.js';

/**
 * SMS provider. Production: MSG91 with the TRAI DLT-registered sender ID and templates (Section 1.2, DEC-19,
 * lib/msg91.ts): the OTP goes through MSG91's SMS (Flow) API with our own code and the DLT-verified OTP SMS template
 * MSG91_OTP_TEMPLATE_ID (variables ##otp## and ##name##); the mobile-change notice through a DLT
 * Flow template when MSG91_MOBILE_CHANGED_TEMPLATE_ID is set (it is a courtesy notice, so it is skipped otherwise).
 * Development: messages go to a test inbox in Redis that the web console shows, so OTP flows can be tested without
 * a phone. The inbox is refused in production at boot (config/env.ts).
 */
const OUTBOX = 'dev:sms:outbox';
const FAIL = 'dev:sms:fail';
export type SmsKind = 'OTP' | 'MOBILE_CHANGED';

/** vars: OTP → { code, minutes, name }; MOBILE_CHANGED → { masked_mobile, support } (the DLT template's variables). */
export async function sendSms(to: string, kind: SmsKind, text: string, vars: Record<string, string> = {}): Promise<void> {
  if (env.SMS_PROVIDER === 'dev') {
    const r = redisCache();
    if (await r.get(FAIL)) throw new Error('Simulated SMS provider failure (dev tools)');
    await r.multi().lpush(OUTBOX, JSON.stringify({ to, kind, text, at: clock.now().toISOString() })).ltrim(OUTBOX, 0, 49).exec();
    // Development only (SMS_PROVIDER=dev is refused in production): show the message in the API terminal too.
    if (env.NODE_ENV !== 'test') logger.info(`[dev SMS] to ${to} (${kind}): ${text}`);
    return;
  }
  if (!env.MSG91_AUTH_KEY || !env.MSG91_OTP_TEMPLATE_ID) throw new Error('MSG91 is not configured');
  if (kind === 'OTP') {
    const { id } = await sendOtp(to, vars.code ?? '', vars.name ?? '');
    // The request ID finds this message in MSG91's reports and is what MSG91 support asks for.
    logger.info({ msg91RequestId: id, to: maskMobile(to) }, 'OTP SMS accepted by MSG91');
    return;
  }
  if (!env.MSG91_MOBILE_CHANGED_TEMPLATE_ID) { logger.info({ kind }, 'No MSG91 template for this SMS; not sent'); return; }
  await sendFlowSms(env.MSG91_MOBILE_CHANGED_TEMPLATE_ID, to, vars);
}

export const devSms = {
  async list(mobile?: string) {
    const items = (await redisCache().lrange(OUTBOX, 0, 49)).map((s) => JSON.parse(s) as { to: string; kind: SmsKind; text: string; at: string });
    return mobile ? items.filter((m) => m.to === mobile) : items;
  },
  clear: () => redisCache().del(OUTBOX),
  async setFailing(fail: boolean) { await (fail ? redisCache().set(FAIL, '1') : redisCache().del(FAIL)); },
  failing: async () => (await redisCache().get(FAIL)) === '1',
};