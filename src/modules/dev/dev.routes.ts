import { Router } from 'express';
import { z } from 'zod';
import { ConfigValue, isCfgId, listCfg, loadConfigOverrides, validateCfgValue } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { clock, istDateTime } from '../../lib/clock.js';
import { normalizeMobile } from '../../lib/phone.js';
import { redisCache } from '../../lib/redis.js';
import { sendData } from '../../lib/response.js';
import { OtpLock } from '../auth/otp.model.js';
import { devSms } from '../auth/sms.js';
import { OtpChallenge } from '../auth/otp.model.js';
import { INSURER_CATEGORIES, INSURER_STATUSES, Insurer } from '../insurers/insurer.model.js';
import { runSweep } from '../notifications/sweep.js';

/**
 * TEST TOOLS — mounted only when DEV_TOOLS=true, which the API refuses in production (config/env.ts).
 * They let the web console test OTP flows without a phone, move the clock (NFR-13) to test expiry and
 * read-only mode, and change CFG values without the P-49 maker-checker flow.
 */
export function devRoutes() {
  const r = Router();

  r.get('/sms', async (req, res) => {
    const mobile = typeof req.query.mobile === 'string' ? normalizeMobile(req.query.mobile) ?? undefined : undefined;
    sendData(res, { failing: await devSms.failing(), messages: await devSms.list(mobile) });
  });
  r.delete('/sms', async (_req, res) => { await devSms.clear(); sendData(res, { cleared: true }); });
  r.post('/sms/failing', async (req, res) => { await devSms.setFailing(req.body?.failing === true); sendData(res, { failing: await devSms.failing() }); });

  const clockView = () => ({ offsetMs: clock.offsetMs(), now: clock.now(), ist: istDateTime(clock.now()) });
  r.get('/clock', (_req, res) => sendData(res, clockView()));
  r.post('/clock', (req, res) => {
    const b = z.object({ offsetMs: z.number().int().optional(), advanceMinutes: z.number().optional(), reset: z.boolean().optional() }).parse(req.body ?? {});
    if (b.reset) clock.setOffset(0);
    if (b.offsetMs !== undefined) clock.setOffset(b.offsetMs);
    if (b.advanceMinutes) clock.setOffset(clock.offsetMs() + Math.round(b.advanceMinutes * 60_000));
    sendData(res, clockView());
  });

  // Insurers until the catalogue module (P-20, Module 8): create ACTIVE or INACTIVE insurers for testing,
  // without the maker-checker approval.
  r.get('/insurers', async (_req, res) => sendData(res, await Insurer.find().sort({ name: 1 }).lean()));
  r.post('/insurers', async (req, res) => {
    const b = z.object({
      name: z.string().trim().min(2).max(100),
      category: z.enum(INSURER_CATEGORIES).default('General'),
      status: z.enum(INSURER_STATUSES).default('ACTIVE'),
    }).parse(req.body ?? {});
    const n = Date.now().toString(36).toUpperCase();
    const doc = await Insurer.create({
      name: b.name, nameKey: b.name.toLowerCase(), shortCode: `${b.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase()}${n.slice(-4)}`,
      category: b.category, irdaiRegNo: `DEV-${n}`, paymentDomains: ['example.com'], status: b.status,
    });
    sendData(res, doc.toObject(), 201);
  });
  r.post('/insurers/:id/status', async (req, res) => {
    const status = z.enum(INSURER_STATUSES).parse(req.body?.status);
    const doc = await Insurer.findByIdAndUpdate(String(req.params.id), { $set: { status }, $inc: { version: 1 } }, { new: true }).lean();
    if (!doc) throw AppError.notFound();
    sendData(res, doc);
  });

  // Communications test tools (Section 15): the provider test inbox, failure switch, signed webhooks, gateway payments, jobs.
  r.get('/comms/inbox', async (_req, res) => sendData(res, (await import('../comms/comms.service.js')).devProvider.inbox));
  r.post('/comms/fail-mode', async (req, res) => { (await import('../comms/comms.service.js')).devProvider.setFailMode(req.body?.mode ?? 'none'); sendData(res, { mode: req.body?.mode ?? 'none' }); });
  r.post('/comms/send-now', async (_req, res) => sendData(res, await (await import('../comms/comms.service.js')).sendDue()));
  r.post('/comms/run-greetings', async (_req, res) => sendData(res, await (await import('../comms/comms.service.js')).runGreetingJob()));
  r.post('/comms/webhook', async (req, res) => { // signs a test event like the provider would, and delivers it
    const c = await import('../comms/comms.service.js');
    const body = { eventId: `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`, ...req.body };
    const fake = { headers: { 'x-bimayantra-signature': c.sign(JSON.stringify(body)) }, rawBody: Buffer.from(JSON.stringify(body)), body } as never;
    sendData(res, await c.messageWebhook(fake));
  });
  r.post('/comms/pay', async (req, res) => { // the gateway confirming a recharge (the only way a wallet is credited)
    const c = await import('../comms/comms.service.js');
    const body = { eventId: `dev_${Date.now()}`, orderId: req.body?.orderId, paymentId: `pay_dev_${Date.now()}`, status: req.body?.status ?? 'captured' };
    const fake = { headers: { 'x-bimayantra-signature': c.sign(JSON.stringify(body)) }, rawBody: Buffer.from(JSON.stringify(body)), body } as never;
    sendData(res, await c.paymentWebhook(fake));
  });

  // P-47: the gateway confirming a subscription payment (signed), and SYS-05 now
  r.post('/billing/pay', async (req, res) => {
    const a = await import('../admin/admin.service.js');
    const { SubscriptionOrder } = await import('../admin/admin.model.js');
    const o = await SubscriptionOrder.findById(req.body?.orderId).lean<{ totalPaise: number }>();
    const body = { eventId: `dev_${Date.now()}`, orderId: req.body?.orderId, paymentId: `pay_dev_${Date.now()}`, status: req.body?.status ?? 'captured', amountPaise: req.body?.amountPaise ?? o?.totalPaise ?? 0 };
    const fake = { headers: { 'x-bimayantra-signature': a.devSign(body) }, rawBody: Buffer.from(JSON.stringify(body)), body } as never;
    sendData(res, await a.subscriptionWebhook(fake));
  });
  r.post('/run-subscription-job', async (_req, res) => sendData(res, await (await import('../admin/admin.service.js')).runSubscriptionJob()));

  // Run the daily renewal job (SYS-03) now, at the test clock's date (safe to repeat: AC-P37-1).
  r.post('/run-renewal-job', async (_req, res) => sendData(res, await (await import('../renewals/renewals.service.js')).runRenewalJob()));

  // Extend an advisor account's trial (read-only mode, GR-33, starts when it ends). Plans and renewals are P-47.
  r.post('/extend-trial', async (req, res) => {
    const { User } = await import('../users/user.model.js');
    const { Account } = await import('../accounts/account.model.js');
    const { normalizeMobile } = await import('../../lib/phone.js');
    const days = Math.min(365, Math.max(1, Number(req.body?.days ?? 30)));
    const user = await User.findOne({ mobile: normalizeMobile(String(req.body?.mobile ?? '')) }, { accountId: 1 }).lean<{ accountId: string | null }>();
    if (!user?.accountId) throw AppError.notFound();
    const endsAt = new Date(Date.now() + days * 86_400_000);
    await Account.updateOne({ _id: user.accountId }, { $set: { 'subscription.status': 'TRIAL', 'subscription.endsAt': endsAt } });
    sendData(res, { accountId: user.accountId, status: 'TRIAL', endsAt });
  });

  // Run the minute sweep now (DSH-11 reminders, bell clean-up), at the test clock's time.
  r.post('/run-sweep', async (_req, res) => sendData(res, await runSweep()));

  r.get('/config', (_req, res) => sendData(res, listCfg()));
  r.put('/config/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!isCfgId(id)) throw AppError.notFound();
    const problem = validateCfgValue(id, req.body?.value);
    if (problem) throw new AppError(400, 'VALIDATION_FAILED', 'GEN-99', { errorId: problem });
    await ConfigValue.updateOne({ _id: id }, { $set: { value: req.body.value, updatedBy: 'dev-tools' } }, { upsert: true });
    await loadConfigOverrides();
    sendData(res, listCfg().find((c) => c.id === id));
  });
  r.delete('/config/:id', async (req, res) => {
    await ConfigValue.deleteOne({ _id: String(req.params.id) });
    await loadConfigOverrides();
    sendData(res, listCfg());
  });

  /** Clears per-IP/per-user counters and OTP locks, so a test run can start clean. */
  r.post('/reset-limits', async (_req, res) => {
    const keys = await redisCache().keys('rl:*');
    if (keys.length) await redisCache().del(...keys);
    const locks = await OtpLock.deleteMany({});
    // The per-number hourly limit (CFG-05) and the resend wait (CFG-04) count OTP records by issue time. Move recent
    // ones out of those windows so the limits really reset; codes already sent stay valid until they expire.
    const hourAgo = new Date(Date.now() - 61 * 60_000);
    const sends = await OtpChallenge.updateMany({ issuedAt: { $gt: hourAgo } }, { $set: { issuedAt: hourAgo } });
    sendData(res, { counters: keys.length, otpLocks: locks.deletedCount, otpSends: sends.modifiedCount });
  });
  return r;
}