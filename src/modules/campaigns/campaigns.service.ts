import type { Request } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { cfgNum } from '../../config/cfg.js';
import { env } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { sourceLabel, type LeadSourceCode } from '../../lib/leadSources.js';
import { normalizeMobile } from '../../lib/phone.js';
import { hitCounter } from '../../lib/rateCounter.js';
import { Account } from '../accounts/account.model.js';
import { nextNumber } from '../accounts/numbers.js';
import { effectiveStatus } from '../accounts/subscription.js';
import { audit } from '../audit/audit.service.js';
import { flagOn, plansOf, type FlagKey } from '../flags/flags.js';
import { Consent, Customer } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import { notify } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Task } from '../tasks/task.model.js';
import { User } from '../users/user.model.js';
import { Connection, LeadForm, Submission, type Channel, type ConnectionDoc, type FormDoc, type SubmissionDoc } from './campaign.model.js';

/** Connect-form details shared by every channel (see campaign.model.ts). */
export type ConnDetails = { defaultStatus?: 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'FOLLOW_UP'; adSetName?: string | null; parentCampaign?: string | null; category?: string | null };
type ConnExtras = { defaultStatus?: string; adSetName?: string | null; parentCampaign?: string | null; category?: string | null; contactPageUrl?: string | null; campaignFilter?: string[] };
const extrasOf = (c: ConnectionDoc) => c as ConnectionDoc & ConnExtras;
const cleanIds = (v?: string[]) => [...new Set((v ?? []).map((x) => x.trim()).filter(Boolean))];
/** Only the details given are set (undefined = unchanged, null/blank = cleared). */
const detailSet = (b: ConnDetails) => Object.fromEntries((['defaultStatus', 'adSetName', 'parentCampaign', 'category'] as const).filter((k) => b[k] !== undefined).map((k) => [k, b[k] ?? (k === 'defaultStatus' ? 'NEW' : null)]));

/** Lead source of an imported lead, by channel (stable codes, lib/leadSources.ts). */
const SOURCE: Record<Channel, LeadSourceCode> = { WEBSITE: 'WEBSITE_FORM', GOOGLE: 'GOOGLE_ADS', META: 'META_ADS', LINKEDIN: 'LINKEDIN_ADS' };
const LABEL: Record<Channel, string> = { WEBSITE: 'Website form', GOOGLE: 'Google Ads', META: 'Meta Ads', LINKEDIN: 'LinkedIn' };
/** Rollout switch per channel (change analysis §7.4 step 8); LinkedIn has its own (client request). */
const CHANNEL_FLAG: Record<Channel, FlagKey | null> = { WEBSITE: 'campaigns_website', GOOGLE: 'campaigns_google', META: 'campaigns_meta', LINKEDIN: 'campaigns_linkedin' };
const channelOn = (channel: Channel, accountId: string) => { const f = CHANNEL_FLAG[channel]; return !f || flagOn(f, accountId); };
const FIELDS = ['name', 'first_name', 'last_name', 'mobile', 'email', 'city', 'consent', 'ignore'] as const;
type Answer = { key: string; label: string; value: string };

// ── Keys: shown once, stored as a keyed hash (one lookup, no decrypting anyone's secrets) ──
const hashKey = (k: string) => createHmac('sha256', `${env.WEBHOOK_SECRET}:campaign-keys`).update(k.trim()).digest('hex');
const newKey = (channel: Channel) => `${channel === 'GOOGLE' ? 'byg' : 'byw'}_${randomBytes(24).toString('base64url')}`;
export async function connectionByKey(key: string | undefined | null, channel: Channel) {
  if (!key || key.length < 16 || key.length > 200) return null;
  const h = hashKey(key);
  const c = await Connection.findOne({ channel, status: 'CONNECTED', $or: [{ keyHash: h }, { prevKeyHash: h, prevKeyUntil: { $gt: clock.now() } }] }).lean<ConnectionDoc>();
  return c;
}

const hookUrl = (c: { _id: string; channel: string }) => `${process.env.PUBLIC_API_URL ?? 'http://localhost:4000'}/v1/hooks/${c.channel === 'GOOGLE' ? 'google' : 'website'}`;
const view = (c: ConnectionDoc) => ({
  id: c._id, channel: c.channel, name: c.name, status: c.status, keyLast4: c.keyLast4, pipelineId: c.pipelineId, lastLeadAt: c.lastLeadAt, createdAt: c.createdAt,
  mode: (c as { mode?: string }).mode ?? 'OAUTH', formFilter: (c as { formFilter?: string[] }).formFilter ?? [], lastError: c.lastError ?? null,
  webhookUrl: (c as { mode?: string }).mode === 'MANUAL' ? manualHookUrl(c) : hookUrl(c),
  defaultStatus: extrasOf(c).defaultStatus ?? 'NEW', adSetName: extrasOf(c).adSetName ?? null, parentCampaign: extrasOf(c).parentCampaign ?? null,
  category: extrasOf(c).category ?? null, contactPageUrl: extrasOf(c).contactPageUrl ?? null, campaignFilter: extrasOf(c).campaignFilter ?? [],
});
const manualHookUrl = (c: ConnectionDoc) => `${process.env.PUBLIC_API_URL ?? 'http://localhost:4000'}/v1/hooks/${c.channel === 'META' ? 'meta' : 'linkedin'}/c/${c._id}`;
/** Manual connections may limit which forms are imported (Meta form ID, or a LinkedIn lead-form URN inside the versioned URN). */
const formAllowed = (c: ConnectionDoc, formId: string) => { const f = (c as { formFilter?: string[] }).formFilter ?? []; return !f.length || f.some((x) => formId === x || formId.includes(x)); };


/** + Website form / + Google Ads: the key is in the answer once (CMP-02). Meta and LinkedIn connect by sign-in (later). */
export async function connect(ctx: AuthContext, b: ConnDetails & {
  channel: 'WEBSITE' | 'GOOGLE'; name: string; pipelineId?: string | null;
  key?: string | null; contactPageUrl?: string | null; campaignIds?: string[]; formIds?: string[];
}, req: Request) {
  if (!channelOn(b.channel, ctx.accountId!)) throw new AppError(409, 'INVALID_STATE', 'CMP-08', { channel: LABEL[b.channel] });
  // The advisor may set their own key (Google Ads asks for one); it must not open anyone else's connection.
  const own = (b.key ?? '').trim();
  const key = own || newKey(b.channel);
  if (own && await Connection.exists({ $or: [{ keyHash: hashKey(own) }, { prevKeyHash: hashKey(own) }] })) throw AppError.field('key', 'CMP-24');
  const google = b.channel === 'GOOGLE';
  let c;
  try {
    c = await Connection.create({
      accountId: ctx.accountId, channel: b.channel, name: b.name, keyHash: hashKey(key), keyLast4: key.slice(-4), pipelineId: b.pipelineId ?? null, createdBy: ctx.userId,
      ...detailSet(b),
      contactPageUrl: b.channel === 'WEBSITE' ? b.contactPageUrl ?? null : null,
      campaignFilter: google ? cleanIds(b.campaignIds) : [], formFilter: google ? cleanIds(b.formIds) : [],
    });
  } catch (e) { if (isDuplicateKey(e)) throw AppError.field('key', 'CMP-24'); throw e; }
  await audit({ entity: 'campaign', entityId: c._id, action: 'CAMPAIGN_CONNECTED', after: { channel: b.channel, name: b.name, ownKey: !!own, defaultStatus: b.defaultStatus ?? 'NEW' } }, { req });
  return { connection: view(c.toObject() as ConnectionDoc), key };
}

/** Edit a connection's details: name, pipeline, starting status, campaign labels, website page, Google filters. */
export async function saveSettings(ctx: AuthContext, id: string, b: ConnDetails & {
  name?: string; pipelineId?: string | null; contactPageUrl?: string | null; campaignIds?: string[]; formIds?: string[];
}, req: Request) {
  const c = await loadConn(ctx, id);
  const manual = (c as { mode?: string }).mode === 'MANUAL';
  if (b.contactPageUrl !== undefined && c.channel !== 'WEBSITE') throw AppError.field('contactPageUrl', 'VAL-22');
  if (b.campaignIds !== undefined && c.channel !== 'GOOGLE') throw AppError.field('campaignIds', 'VAL-22');
  if (b.formIds !== undefined && !(c.channel === 'GOOGLE' || manual)) throw AppError.field('formIds', 'VAL-22');
  const set: Record<string, unknown> = {
    ...(b.name ? { name: b.name } : {}), ...(b.pipelineId !== undefined ? { pipelineId: b.pipelineId } : {}), ...detailSet(b),
    ...(b.contactPageUrl !== undefined ? { contactPageUrl: b.contactPageUrl } : {}),
    ...(b.campaignIds !== undefined ? { campaignFilter: cleanIds(b.campaignIds) } : {}), ...(b.formIds !== undefined ? { formFilter: cleanIds(b.formIds) } : {}),
  };
  if (Object.keys(set).length) await Connection.updateOne({ _id: id }, { $set: set });
  await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_SETTINGS_SAVED', after: Object.keys(set) }, { req });
  return view((await Connection.findById(id).lean<ConnectionDoc>())!);
}
async function loadConn(ctx: AuthContext, id: string) { const c = await Connection.findOne({ _id: id, accountId: ctx.accountId }).lean<ConnectionDoc>(); if (!c) throw AppError.notFound(); return c; }
export async function rotateKey(ctx: AuthContext, id: string, req: Request) {
  const c = await loadConn(ctx, id);
  if (c.channel === 'META' || c.channel === 'LINKEDIN') throw AppError.invalidState('connection', 'connected by sign-in');
  const key = newKey(c.channel as Channel);
  await Connection.updateOne({ _id: id }, { $set: { keyHash: hashKey(key), keyLast4: key.slice(-4), prevKeyHash: c.keyHash, prevKeyUntil: new Date(clock.now().getTime() + cfgNum('CFG-196') * 86_400_000) } });
  await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_KEY_ROTATED' }, { req });
  return { connection: view((await Connection.findById(id).lean<ConnectionDoc>())!), key };
}
export async function setStatus(ctx: AuthContext, id: string, on: boolean, req: Request) {
  const c = await loadConn(ctx, id);
  await Connection.updateOne({ _id: id }, { $set: { status: on ? 'CONNECTED' : 'DISCONNECTED' } });
  await audit({ entity: 'campaign', entityId: id, action: on ? 'CAMPAIGN_RECONNECTED' : 'CAMPAIGN_DISCONNECTED' }, { req });
  return { connection: view((await Connection.findById(id).lean<ConnectionDoc>())!), params: { name: c.name } };
}
export async function connections(ctx: AuthContext) {
  const rows = await Connection.find({ accountId: ctx.accountId }).sort({ createdAt: -1 }).lean<ConnectionDoc[]>();
  const since = new Date(clock.now().getTime() - 30 * 86_400_000);
  return Promise.all(rows.map(async (c) => {
    const counts = await Submission.aggregate<{ _id: string; n: number }>([{ $match: { connectionId: c._id, createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    return { ...view(c), last30Days: Object.fromEntries(counts.map((x) => [x._id, x.n])) };
  }));
}

// ── Forms and mapping ──
export async function forms(ctx: AuthContext, connectionId?: string) {
  return LeadForm.find({ accountId: ctx.accountId, ...(connectionId ? { connectionId } : {}) }).sort({ createdAt: -1 }).lean<FormDoc[]>();
}
export async function saveForm(ctx: AuthContext, id: string, b: { name?: string; campaignName?: string | null; fieldMap?: Record<string, string>; pipelineId?: string | null; active?: boolean }, req: Request) {
  const f = await LeadForm.findOne({ _id: id, accountId: ctx.accountId }).lean<FormDoc>();
  if (!f) throw AppError.notFound();
  if (b.fieldMap && Object.values(b.fieldMap).some((v) => !(FIELDS as readonly string[]).includes(v))) throw AppError.field('fieldMap', 'VAL-22');
  await LeadForm.updateOne({ _id: id }, { $set: { ...(b.name ? { name: b.name } : {}), ...(b.campaignName !== undefined ? { campaignName: b.campaignName } : {}), ...(b.fieldMap ? { fieldMap: b.fieldMap } : {}), ...(b.pipelineId !== undefined ? { pipelineId: b.pipelineId } : {}), ...(b.active !== undefined ? { active: b.active } : {}) } });
  await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_FORM_SAVED', after: b }, { req });
  return (await LeadForm.findById(id).lean<FormDoc>())!;
}
/** Our own embeddable website form: fields shown, a public key for the link (no secret in the page). */
export async function createEmbedForm(ctx: AuthContext, connectionId: string, b: { name: string; campaignName?: string | null; consentText?: string | null }, req: Request) {
  const c = await loadConn(ctx, connectionId);
  if (c.channel !== 'WEBSITE') throw AppError.invalidState('connection', c.channel);
  const publicKey = randomBytes(12).toString('base64url');
  const fields = [{ key: 'name', label: 'Your name', type: 'text', required: true }, { key: 'mobile', label: 'Mobile', type: 'tel', required: true }, { key: 'email', label: 'Email', type: 'email', required: false }, { key: 'city', label: 'City', type: 'text', required: false }, { key: 'message', label: 'What are you looking for?', type: 'textarea', required: false }, { key: 'consent', label: b.consentText ?? 'I agree to be contacted by phone and WhatsApp about insurance.', type: 'checkbox', required: true }];
  const f = await LeadForm.create({ accountId: ctx.accountId, connectionId, channel: 'WEBSITE', externalId: `embed:${publicKey}`, name: b.name, campaignName: b.campaignName ?? null, fields, publicKey, fieldMap: { name: 'name', mobile: 'mobile', email: 'email', city: 'city', consent: 'consent' } });
  await audit({ entity: 'campaign', entityId: f._id, action: 'CAMPAIGN_EMBED_FORM_CREATED' }, { req });
  return f.toObject();
}

// ── The import: store first, then map, check, link or create, consent, task, bell ──
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
const AUTO: Record<string, string> = {
  fullname: 'name', name: 'name', yourname: 'name', firstname: 'first_name', lastname: 'last_name',
  phonenumber: 'mobile', phone: 'mobile', mobile: 'mobile', mobilenumber: 'mobile', contact: 'mobile', contactnumber: 'mobile', whatsapp: 'mobile',
  email: 'email', emailaddress: 'email', workemail: 'email', city: 'city', consent: 'consent',
};
function mapAnswers(answers: Answer[], fieldMap: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const a of answers) {
    const to = fieldMap[a.key] ?? AUTO[norm(a.key)];
    if (to && to !== 'ignore' && a.value && !out[to]) out[to] = a.value.trim();
  }
  const name = out.name || [out.first_name, out.last_name].filter(Boolean).join(' ');
  return { name: name.trim(), mobile: out.mobile ? normalizeMobile(out.mobile) : null, email: out.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email) ? out.email.toLowerCase() : null, city: out.city ?? null, consent: /^(yes|true|1|on|checked|agree|agreed|y)$/i.test(out.consent ?? '') };
}

/** Store first. A repeated platform lead ID returns the stored submission, so the platform's retries never duplicate. */
export async function ingest(conn: ConnectionDoc, b: { externalId: string; formExternalId: string; formName: string; answers: Answer[]; meta?: Record<string, unknown>; isTest?: boolean }) {
  let form = await LeadForm.findOne({ connectionId: conn._id, externalId: b.formExternalId }).lean<FormDoc>();
  if (!form) {
    try { form = (await LeadForm.create({ accountId: conn.accountId, connectionId: conn._id, channel: conn.channel, externalId: b.formExternalId, name: b.formName })).toObject() as FormDoc; }
    catch (e) { if (!isDuplicateKey(e)) throw e; form = (await LeadForm.findOne({ connectionId: conn._id, externalId: b.formExternalId }).lean<FormDoc>())!; }
  }
  const keys = b.answers.map((a) => a.key).filter((k) => !form!.seenKeys.includes(k));
  if (keys.length) await LeadForm.updateOne({ _id: form._id }, { $addToSet: { seenKeys: { $each: keys } } });
  let sub: SubmissionDoc;
  try { sub = (await Submission.create({ accountId: conn.accountId, connectionId: conn._id, formId: form._id, channel: conn.channel, externalId: b.externalId, answers: b.answers, meta: b.meta ?? {}, isTest: !!b.isTest })).toObject() as SubmissionDoc; }
  catch (e) { if (isDuplicateKey(e)) return { submission: (await Submission.findOne({ connectionId: conn._id, externalId: b.externalId }).lean<SubmissionDoc>())!, duplicate: true }; throw e; }
  await Connection.updateOne({ _id: conn._id }, { $set: { lastLeadAt: clock.now() } });
  return { submission: await processSubmission(sub._id), duplicate: false };
}

/** Import one stored submission. Safe to run again (Retry): an IMPORTED or LINKED one is left as it is. */
export async function processSubmission(id: string): Promise<SubmissionDoc> {
  const s = await Submission.findById(id).lean<SubmissionDoc>();
  if (s && ['META', 'GOOGLE'].includes(s.channel)) await (await import('./campaigns.analytics.js')).linkCampaign(s).catch(() => undefined); // Stage H
  if (!s || ['IMPORTED', 'LINKED'].includes(s.status)) return s!;
  const done = async (status: string, set: Record<string, unknown> = {}) => (await Submission.findOneAndUpdate({ _id: id }, { $set: { status, ...set }, $inc: { attempts: 1 } }, { new: true }).lean<SubmissionDoc>())!;
  try {
    const [conn, form, acc] = await Promise.all([Connection.findById(s.connectionId).lean<ConnectionDoc>(), s.formId ? LeadForm.findById(s.formId).lean<FormDoc>() : null, Account.findById(s.accountId).lean<{ status: string; subscription: Parameters<typeof effectiveStatus>[0]; pipelines: Array<{ _id: string; position?: number }> }>()]);
    if (!conn || !acc) return done('FAILED', { reason: 'Connection removed' });
    if (s.isTest) return done('SKIPPED', { reason: 'Test lead · not counted' });
    if (form && !form.active) return done('SKIPPED', { reason: 'Form switched off' });
    // Google filters set on the connection: other campaigns / forms are kept (SKIPPED with the reason) so a changed filter + Retry imports them
    if (conn.channel === 'GOOGLE') {
      const cf = extrasOf(conn).campaignFilter ?? []; const ff = (conn as { formFilter?: string[] }).formFilter ?? [];
      const cid = String((s.meta as { campaignId?: unknown }).campaignId ?? '');
      if (cf.length && !cf.includes(cid)) return done('SKIPPED', { reason: `Campaign ${cid || '(none)'} is not in this connection's campaign filter` });
      if (ff.length && form && !ff.includes(form.externalId)) return done('SKIPPED', { reason: `Form ${form.externalId} is not in this connection's form filter` });
    }
    // Kept as FAILED (not lost): Retry imports it once the channel is switched on for the account.
    if (!channelOn(conn.channel as Channel, s.accountId)) return done('FAILED', { reason: `${LABEL[conn.channel as Channel]} is not switched on for this account` });
    if (acc.status !== 'ACTIVE') return done('FAILED', { reason: acc.status === 'SUSPENDED' ? 'Account suspended' : 'Account closed' });
    if (effectiveStatus(acc.subscription, clock.now()) === 'EXPIRED') return done('FAILED', { reason: 'Account is read-only: renew the plan, then Retry' });
    const m = mapAnswers(s.answers as unknown as Answer[], (form?.fieldMap ?? {}) as Record<string, string>);
    if (!m.mobile) return done('SKIPPED', { reason: 'No valid Indian mobile number in the form' });
    // Duplicates: an open lead or a customer with this mobile is linked, never duplicated
    const open = await Lead.findOne({ accountId: s.accountId, isOpen: true, $or: [{ mobile: m.mobile }, { altMobile: m.mobile }] }, { _id: 1, name: 1 }).lean<{ _id: string; name: string }>();
    if (open) return done('LINKED', { leadId: open._id, reason: 'Already an open lead' });
    const cus = await Customer.findOne({ accountId: s.accountId, $or: [{ mobile: m.mobile }, { altMobile: m.mobile }] }, { _id: 1 }).lean<{ _id: string }>();
    if (cus) return done('LINKED', { customerId: cus._id, reason: 'Already a customer' });
    const pipelineId = form?.pipelineId ?? conn.pipelineId ?? [...acc.pipelines].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))[0]?._id;
    const adv = await User.findOne({ accountId: s.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
    const name = m.name || `${LABEL[conn.channel as Channel]} lead`;
    const x = extrasOf(conn);
    const connCampaign = [x.parentCampaign, x.adSetName].filter(Boolean).join(' · ') || null;
    const campaign = form?.campaignName ?? (s.meta as { campaignName?: string }).campaignName ?? connCampaign ?? form?.name ?? null;
    const startStatus = (x.defaultStatus ?? 'NEW') as 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'FOLLOW_UP';
    const leadId = await withTx(async (session) => {
      const number = await nextNumber(s.accountId, 'lead', session);
      const now = clock.now();
      const [lead] = await Lead.create([{ accountId: s.accountId, number, pipelineId, name, nameKey: name.toLowerCase().replace(/\s+/g, ' '), mobile: m.mobile, email: m.email,
        source: sourceLabel(SOURCE[conn.channel as Channel]), sourceCode: SOURCE[conn.channel as Channel], campaign, adRef: { channel: conn.channel, connectionId: conn._id, formId: s.formId, externalId: s.externalId, submissionId: s._id },
        notes: m.city ? `City: ${m.city}` : null, status: startStatus, isOpen: true, createdBy: adv?._id ?? 'SYSTEM', nextFollowUpAt: new Date(now.getTime() + cfgNum('CFG-195') * 60_000),
        stageHistory: [{ from: null, to: startStatus, by: adv?._id ?? 'SYSTEM', at: now }] }], { session: session ?? undefined });
      if (m.consent) await Consent.create([{ accountId: s.accountId, personKey: `L:${lead!._id}`, channel: 'WHATSAPP', status: 'GIVEN', address: m.mobile, howGiven: conn.channel === 'WEBSITE' ? 'Website form tick' : 'Ad form tick', recordedBy: adv?._id ?? 'SYSTEM', recordedAt: now }], { session: session ?? undefined });
      await Task.create([{ accountId: s.accountId, kind: 'LEAD_FOLLOW_UP', title: `Call ${name} (new ${LABEL[conn.channel as Channel]} lead)`, dueAt: new Date(now.getTime() + cfgNum('CFG-195') * 60_000), linkedType: 'LEAD', linkedId: lead!._id, createdBy: adv?._id ?? null }], { session: session ?? undefined });
      return lead!._id as string;
    });
    if (adv) await notify({ userId: adv._id, accountId: s.accountId, kind: 'AD_LEAD_ARRIVED', messageId: 'CMP-01', params: { channel: LABEL[conn.channel as Channel], name }, dedupeKey: `CMP-01|${s._id}`, link: { type: 'LEAD', id: leadId } }).catch(() => undefined);
    return done('IMPORTED', { leadId, reason: null });
  } catch (e) {
    return done('FAILED', { reason: (e as Error).message.slice(0, 200) });
  }
}

export async function retry(ctx: AuthContext, id: string, req: Request) {
  const s = await Submission.findOne({ _id: id, accountId: ctx.accountId }).lean<SubmissionDoc>();
  if (!s) throw AppError.notFound();
  if (!['FAILED', 'SKIPPED', 'RECEIVED'].includes(s.status) || s.isTest) throw AppError.invalidState('submission', s.status);
  await Submission.updateOne({ _id: id }, { $set: { status: 'RECEIVED' } });
  const out = (await retryPlatform(id)) ?? (await processSubmission(id));
  await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_SUBMISSION_RETRIED', after: { status: out.status } }, { req });
  return out;
}
/** The sync log (every submission with its outcome and reason). */
export async function submissions(ctx: AuthContext, q: { status?: string; channel?: string; connectionId?: string }) {
  return Submission.find({ accountId: ctx.accountId, ...(q.status ? { status: q.status } : {}), ...(q.channel ? { channel: q.channel } : {}), ...(q.connectionId ? { connectionId: q.connectionId } : {}) }).sort({ createdAt: -1 }).limit(300).lean<SubmissionDoc[]>();
}
/** All form submissions behind a lead (the original import and any later linked ones), answers as submitted. */
export async function leadAnswers(ctx: AuthContext, leadId: string) {
  return (await Submission.find({ accountId: ctx.accountId, leadId }).sort({ createdAt: -1 }).lean<SubmissionDoc[]>()).map((s) => ({ id: s._id, channel: s.channel, status: s.status, at: s.createdAt, answers: s.answers, campaign: (s.meta as { campaignName?: string }).campaignName ?? null }));
}

// ── Receivers ──
/**
 * Google Ads lead form webhook (ported from the previous CRM, with fixes): google_key found by keyed hash; the
 * stable column_id read first (column_name is deprecated); test leads kept but not counted; repeats by lead_id ignored.
 */
export async function googleHook(body: Record<string, unknown>) {
  const conn = await connectionByKey(String(body.google_key ?? ''), 'GOOGLE');
  if (!conn) throw AppError.forbidden();
  const leadId = String(body.lead_id ?? '').slice(0, 200);
  if (!leadId) throw AppError.field('lead_id', 'GEN-01', { 'Field label': 'lead_id' });
  const cols = Array.isArray(body.user_column_data) ? (body.user_column_data as Array<Record<string, unknown>>) : [];
  const answers: Answer[] = cols.slice(0, 100).map((c) => { const key = String(c.column_id ?? c.column_name ?? 'FIELD').slice(0, 80); return { key, label: String(c.column_name ?? key).slice(0, 120), value: String(c.string_value ?? '').slice(0, 2000) }; });
  const formId = String(body.form_id ?? 'google-form');
  return ingest(conn, { externalId: leadId, formExternalId: formId, formName: `Google Ads form ${formId}`, answers, isTest: body.is_test === true || body.is_test === 'true',
    meta: { campaignId: body.campaign_id ?? null, adGroupId: body.adgroup_id ?? null, creativeId: body.creative_id ?? null, gclid: body.gcl_id ?? null } });
}

/** Website webhook (your own form or WordPress): key in X-Bimayantra-Key or the body; per-IP limit; spam trap. */
export async function websiteHook(body: Record<string, unknown>, key: string | null, ip: string) {
  const ipHits = await hitCounter(`web-form:${createHmac('sha256', 'ip').update(ip).digest('hex').slice(0, 24)}`, 3600);
  if (ipHits.count > cfgNum('CFG-194')) throw new AppError(429, 'RATE_LIMITED', 'REF-09');
  const conn = await connectionByKey(key ?? String(body.key ?? body.secret ?? ''), 'WEBSITE');
  if (!conn) throw AppError.forbidden();
  if (body.website) return { trapped: true }; // the invisible spam-trap field: looks accepted, stores nothing
  const answers = toAnswers(body, ['key', 'secret', 'formName', 'form', 'submissionId', 'website', 'pageUrl']);
  const formName = String(body.formName ?? body.form ?? 'Website form').slice(0, 120);
  const externalId = String(body.submissionId ?? `${formName}:${answers.map((a) => a.value).join('|')}:${Math.floor(clock.now().getTime() / 60_000)}`).slice(0, 300); // a double submit in the same minute is one
  return ingest(conn, { externalId, formExternalId: formName, formName, answers, meta: { pageUrl: body.pageUrl ?? null } });
}
function toAnswers(body: Record<string, unknown>, skip: string[]): Answer[] {
  const flat: Record<string, unknown> = { ...body, ...((body.fields && typeof body.fields === 'object') ? (body.fields as Record<string, unknown>) : {}) };
  delete flat.fields;
  return Object.entries(flat).filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && typeof v !== 'object').slice(0, 60).map(([k, v]) => ({ key: k.slice(0, 80), label: k.slice(0, 120), value: String(v).slice(0, 2000) }));
}

/** Our embeddable form: the public page reads its fields; submitting needs no secret (per-IP limit and spam trap). */
export async function publicForm(publicKey: string) {
  const f = await LeadForm.findOne({ publicKey, active: true }).lean<FormDoc>();
  const conn = f ? await Connection.findOne({ _id: f.connectionId, status: 'CONNECTED' }).lean<ConnectionDoc>() : null;
  if (!f || !conn) return { valid: false };
  const adv = await User.findOne({ accountId: f.accountId, role: 'ADV' }, { name: 1 }).lean<{ name: string }>();
  return { valid: true, name: f.name, advisorName: adv?.name ?? '', fields: f.fields };
}
export async function submitPublicForm(publicKey: string, body: Record<string, unknown>, ip: string) {
  const ipHits = await hitCounter(`web-form:${createHmac('sha256', 'ip').update(ip).digest('hex').slice(0, 24)}`, 3600);
  if (ipHits.count > cfgNum('CFG-194')) throw new AppError(429, 'RATE_LIMITED', 'REF-09');
  const f = await LeadForm.findOne({ publicKey, active: true }).lean<FormDoc>();
  const conn = f ? await Connection.findOne({ _id: f.connectionId, status: 'CONNECTED' }).lean<ConnectionDoc>() : null;
  if (!f || !conn) throw AppError.notFound();
  const first = String(body.name ?? '').trim().split(' ')[0] ?? '';
  if (body.website) return { params: { 'first name': first } };
  const fields = (f.fields ?? []) as Array<{ key: string; label: string; required: boolean }>;
  for (const x of fields) if (x.required && !String(body[x.key] ?? '').trim()) throw AppError.field(x.key, 'GEN-01', { 'Field label': x.label });
  if (!normalizeMobile(String(body.mobile ?? ''))) throw AppError.field('mobile', 'VAL-01');
  const answers = fields.map((x) => ({ key: x.key, label: x.label, value: String(body[x.key] ?? '').slice(0, 2000) })).filter((a) => a.value);
  await ingest(conn, { externalId: `${publicKey}:${answers.map((a) => a.value).join('|')}:${Math.floor(clock.now().getTime() / 60_000)}`, formExternalId: f.externalId, formName: f.name, answers });
  return { params: { 'first name': first } };
}
void msg;

// ════════ Meta and LinkedIn (connected by sign-in) ════════
import { createHmac as hmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { WebhookEvent } from '../comms/outbox.model.js';
import { JobRun } from '../renewals/renewal.model.js';
import { ReconnectNeeded, google, isConfigured, linkedin, linkedinAnswers, linkedinConfig, meta, metaAnswers, metaConfig, redirectUri } from './platforms.js';

type Social = 'META' | 'LINKEDIN' | 'GOOGLE';
const stateKey = () => `${env.WEBHOOK_SECRET}:oauth-state`;

/** Start sign-in: a signed, single-use, 10-minute state (CMP-08 while switched off; CMP-10 if the app is not set up yet). */
export async function oauthStart(ctx: AuthContext, channel: Social, connectionId?: string) {
  if (!channelOn(channel, ctx.accountId!)) throw new AppError(409, 'INVALID_STATE', 'CMP-08', { channel: LABEL[channel] });
  if (!isConfigured(channel)) throw new AppError(409, 'INVALID_STATE', 'CMP-10', { channel: LABEL[channel] });
  // Google: the sign-in adds status and spend to an existing Google lead-form connection (leads arrive by its webhook)
  if (channel === 'GOOGLE' && !(connectionId && (await Connection.exists({ _id: connectionId, accountId: ctx.accountId, channel: 'GOOGLE' })))) throw AppError.field('connectionId', 'CMP-15');
  const body = Buffer.from(JSON.stringify({ a: ctx.accountId, u: ctx.userId, c: channel, x: connectionId ?? null, n: randomUUID(), e: clock.now().getTime() + 10 * 60_000 })).toString('base64url');
  const state = `${body}.${hmac('sha256', stateKey()).update(body).digest('base64url')}`;
  return { url: channel === 'META' ? meta.authUrl(state) : channel === 'GOOGLE' ? google.authUrl(state) : linkedin.authUrl(state) };
}
async function readState(state: string, channel: Social) {
  const [body, sig] = String(state).split('.');
  if (!body || !sig) throw AppError.forbidden();
  const want = hmac('sha256', stateKey()).update(body).digest('base64url');
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) throw AppError.forbidden();
  const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as { a: string; u: string; c: string; x?: string | null; n: string; e: number };
  if (s.c !== channel || s.e < clock.now().getTime()) throw AppError.forbidden();
  try { await WebhookEvent.create({ _id: `oauth|${s.n}`, source: 'oauth', at: clock.now() }); } catch (e) { if (isDuplicateKey(e)) throw AppError.forbidden(); throw e; } // single use
  return s;
}
/**
 * The platform sends the browser back here. One connection per account and channel (reconnecting updates it); the
 * token is stored encrypted. The person then chooses which Pages / ad accounts to take leads from.
 */
export async function oauthCallback(channel: Social, code: string, state: string) {
  const s = await readState(state, channel);
  let t: { token: string; expiresIn: number | null };
  let list: Array<{ id: string; name: string }>;
  if (channel === 'GOOGLE') { const g = await google.exchange(code); t = { token: g.refreshToken, expiresIn: null }; list = await google.customers(g.accessToken); } // the refresh token is what is kept
  else { t = channel === 'META' ? await meta.exchange(code) : await linkedin.exchange(code); list = channel === 'META' ? (await meta.pages(t.token)).map((p) => ({ id: p.id, name: p.name })) : await linkedin.adAccounts(t.token); }
  const existing = channel === 'GOOGLE' ? await Connection.findOne({ _id: s.x, accountId: s.a, channel }).lean<ConnectionDoc>() : await Connection.findOne({ accountId: s.a, channel }).lean<ConnectionDoc>();
  if (channel === 'GOOGLE' && !existing) throw AppError.forbidden();
  const keep = new Map((existing?.sources ?? []).map((x) => [x.id, x]));
  const sources = list.map((x) => ({ id: x.id, name: x.name, tokenEnc: keep.get(x.id)?.tokenEnc ?? null, subscribed: keep.get(x.id)?.subscribed ?? false }));
  const set = { status: channel === 'GOOGLE' ? (existing?.status ?? 'CONNECTED') : 'CONNECTED', tokenEnc: encryptField(t.token), tokenExpiresAt: t.expiresIn ? new Date(clock.now().getTime() + t.expiresIn * 1000) : null, sources, lastError: null };
  const conn = existing
    ? await Connection.findOneAndUpdate({ _id: existing._id }, { $set: set }, { new: true }).lean<ConnectionDoc>()
    : (await Connection.create({ accountId: s.a, channel, name: LABEL[channel], createdBy: s.u, ...set })).toObject() as ConnectionDoc;
  // reconnecting: re-subscribe what was chosen before, with fresh tokens
  if (existing) await saveSources({ accountId: s.a, userId: s.u } as AuthContext, conn!._id, sources.filter((x) => x.subscribed).map((x) => x.id), null);
  await audit({ entity: 'campaign', entityId: conn!._id, action: existing ? 'CAMPAIGN_RECONNECTED' : 'CAMPAIGN_CONNECTED', after: { channel, sources: list.length } }, { ctx: { userId: s.u, accountId: s.a, role: 'ADV' } as AuthContext });
  return conn!;
}
export async function sources(ctx: AuthContext, id: string) {
  const c = await loadConn(ctx, id);
  return c.sources.map((x) => ({ id: x.id, name: x.name, subscribed: !!x.subscribed }));
}
/** Choose Pages / ad accounts: Meta subscribes each Page to leadgen with its own Page token; LinkedIn subscribes owner-level notifications. */
export async function saveSources(ctx: AuthContext, id: string, ids: string[], req: Request | null) {
  const c = await Connection.findOne({ _id: id, accountId: ctx.accountId }).lean<ConnectionDoc>();
  if (!c || !c.tokenEnc) throw AppError.notFound();
  const token = decryptField(c.tokenEnc);
  const pageTokens = c.channel === 'META' ? new Map((await withReconnect(c, () => meta.pages(token))).map((p) => [p.id, p.token])) : null;
  const out = [];
  for (const s of c.sources) {
    const want = ids.includes(s.id);
    let tokenEnc = s.tokenEnc ?? null;
    if (want) {
      if (c.channel === 'GOOGLE') { /* status and spend only: no subscription on Google's side */ }
      else if (c.channel === 'META') { const pt = pageTokens!.get(s.id); if (!pt) continue; await withReconnect(c, () => meta.subscribe(s.id, pt)); tokenEnc = encryptField(pt); }
      else if (!s.subscribed) await withReconnect(c, () => linkedin.subscribe(s.id, token));
    }
    out.push({ id: s.id, name: s.name, tokenEnc: want ? tokenEnc : null, subscribed: want });
  }
  await Connection.updateOne({ _id: id }, { $set: { sources: out } });
  if (req) await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_SOURCES_SAVED', after: { subscribed: ids.length } }, { req });
  return out.map((x) => ({ id: x.id, name: x.name, subscribed: x.subscribed }));
}
/** A token error stops the connection (RECONNECT_NEEDED) and tells the advisor once a day (CMP-09). */
async function withReconnect<T>(c: ConnectionDoc, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof ReconnectNeeded) {
      await Connection.updateOne({ _id: c._id }, { $set: { status: 'RECONNECT_NEEDED', lastError: e.message.slice(0, 200) } });
      const adv = await User.findOne({ accountId: c.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
      if (adv) await notify({ userId: adv._id, accountId: c.accountId, kind: 'CONNECTION_RECONNECT_NEEDED', messageId: 'CMP-09', params: { channel: LABEL[c.channel as Channel], name: c.name }, dedupeKey: `CMP-09|${c._id}|${clock.now().toISOString().slice(0, 10)}` }).catch(() => undefined);
    }
    throw e;
  }
}

/** Store first (the platform's lead ID, before anything else can fail), then fetch the answers and import. */
async function receivePlatformLead(conn: ConnectionDoc, b: { externalId: string; formExternalId: string; formName: string; meta?: Record<string, unknown> }) {
  let form = await LeadForm.findOne({ connectionId: conn._id, externalId: b.formExternalId }).lean<FormDoc>();
  if (!form) {
    try { form = (await LeadForm.create({ accountId: conn.accountId, connectionId: conn._id, channel: conn.channel, externalId: b.formExternalId, name: b.formName })).toObject() as FormDoc; }
    catch (e) { if (!isDuplicateKey(e)) throw e; form = (await LeadForm.findOne({ connectionId: conn._id, externalId: b.formExternalId }).lean<FormDoc>())!; }
  }
  try { return { sub: (await Submission.create({ accountId: conn.accountId, connectionId: conn._id, formId: form._id, channel: conn.channel, externalId: b.externalId, answers: [], meta: b.meta ?? {} })).toObject() as SubmissionDoc, duplicate: false }; }
  catch (e) { if (isDuplicateKey(e)) return { sub: (await Submission.findOne({ connectionId: conn._id, externalId: b.externalId }).lean<SubmissionDoc>())!, duplicate: true }; throw e; }
}
/** Fetch the answers for a stored Meta / LinkedIn submission and import it. A failed fetch is FAILED; Retry fetches again. */
async function completePlatformLead(subId: string) {
  const s = (await Submission.findById(subId).lean<SubmissionDoc>())!;
  const conn = await Connection.findById(s.connectionId).lean<ConnectionDoc>();
  if (!conn) return s;
  try {
    let answers: Answer[]; let extra: Record<string, unknown> = {}; let isTest = false;
    if (conn.channel === 'META') {
      const pageId = String((s.meta as { pageId?: string }).pageId ?? '');
      const src = conn.sources.find((x) => x.id === pageId && x.tokenEnc);
      if (!src) throw new Error('This Facebook Page is no longer chosen in Campaigns');
      const lead = await withReconnect(conn, () => meta.lead(s.externalId, decryptField(src.tokenEnc!)));
      answers = metaAnswers(lead);
      extra = { campaignId: lead.campaign_id ?? null, adSetId: lead.adset_id ?? null, campaignName: lead.campaign_name ?? null, adSetName: lead.adset_name ?? null, adName: lead.ad_name ?? null, adId: lead.ad_id ?? null, isOrganic: lead.is_organic ?? null };
    } else {
      const r = await withReconnect(conn, () => linkedin.response(s.externalId, decryptField(conn.tokenEnc!)));
      answers = linkedinAnswers(r); isTest = !!r.testLead;
      extra = { formName: r.form?.name ?? null };
    }
    await Submission.updateOne({ _id: subId }, { $set: { answers, isTest, meta: { ...(s.meta as object), ...extra }, status: 'RECEIVED', reason: null } });
    return processSubmission(subId);
  } catch (e) {
    return (await Submission.findOneAndUpdate({ _id: subId }, { $set: { status: 'FAILED', reason: `Could not fetch the lead from ${LABEL[conn.channel as Channel]}: ${(e as Error).message.slice(0, 150)}` }, $inc: { attempts: 1 } }, { new: true }).lean<SubmissionDoc>())!;
  }
}
/** Retry also re-fetches a Meta / LinkedIn lead whose answers never arrived. */
export async function retryPlatform(id: string) { const s = await Submission.findById(id).lean<SubmissionDoc>(); return s && ['META', 'LINKEDIN'].includes(s.channel) && !s.answers.length ? completePlatformLead(id) : null; }

// ── Receivers ──
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const rawOf = (req: Request) => (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from('');
/** Meta's subscription check (GET). */
export function metaVerify(q: Record<string, unknown>) {
  const c = metaConfig();
  if (q['hub.mode'] !== 'subscribe' || !c.verifyToken || !safeEq(String(q['hub.verify_token'] ?? ''), c.verifyToken)) throw AppError.forbidden();
  return String(q['hub.challenge'] ?? '');
}
/** Meta lead webhook: X-Hub-Signature-256 checked on the raw body, and refused when the App Secret is missing (fail closed). */
export async function metaHook(req: Request, only?: ConnectionDoc) {
  const secret = only ? decryptField((only as { appSecretEnc: string }).appSecretEnc) : metaConfig().appSecret;
  const got = String(req.headers['x-hub-signature-256'] ?? '');
  if (!secret || !safeEq(got, `sha256=${hmac('sha256', secret).update(rawOf(req)).digest('hex')}`)) throw AppError.forbidden();
  const out: Array<{ status: string; duplicate: boolean }> = [];
  for (const entry of ((req.body?.entry ?? []) as Array<Record<string, any>>).slice(0, 50)) {
    for (const ch of ((entry.changes ?? []) as Array<Record<string, any>>)) {
      if (ch.field !== 'leadgen' || !ch.value?.leadgen_id) continue;
      const v = ch.value;
      const conn = only
        ? (only.status === 'CONNECTED' && only.sources.some((x) => x.id === String(v.page_id) && x.subscribed) ? only : null)
        : await Connection.findOne({ channel: 'META', status: 'CONNECTED', mode: { $ne: 'MANUAL' }, sources: { $elemMatch: { id: String(v.page_id), subscribed: true } } }).lean<ConnectionDoc>();
      if (!conn) continue; // a Page no account has chosen
      if (!formAllowed(conn, String(v.form_id ?? ''))) { out.push({ status: 'SKIPPED', duplicate: false }); continue; }
      const { sub, duplicate } = await receivePlatformLead(conn, { externalId: String(v.leadgen_id), formExternalId: String(v.form_id ?? 'meta-form'), formName: `Facebook form ${v.form_id ?? ''}`.trim(), meta: { pageId: String(v.page_id), adId: v.ad_id ?? null } });
      out.push({ status: duplicate ? sub.status : (await completePlatformLead(sub._id)).status, duplicate });
    }
  }
  return { received: out.length, results: out };
}
/** LinkedIn's webhook check (GET): challengeResponse = hex(HMAC-SHA256(clientSecret, challengeCode)). */
export function linkedinChallenge(code: string, only?: ConnectionDoc) {
  const secret = only ? decryptField((only as { appSecretEnc: string }).appSecretEnc) : linkedinConfig().clientSecret;
  if (!secret || !code) throw AppError.forbidden();
  return { challengeCode: code, challengeResponse: hmac('sha256', secret).update(code).digest('hex') };
}
/** LinkedIn lead notifications: X-LI-Signature = hex(HMAC-SHA256(clientSecret, "hmacsha256=" + raw body)). DELETED clears the answers. */
export async function linkedinHook(req: Request, only?: ConnectionDoc) {
  const secret = only ? decryptField((only as { appSecretEnc: string }).appSecretEnc) : linkedinConfig().clientSecret;
  const got = String(req.headers['x-li-signature'] ?? '');
  if (!secret || !safeEq(got, hmac('sha256', secret).update(Buffer.concat([Buffer.from('hmacsha256='), rawOf(req)])).digest('hex'))) throw AppError.forbidden();
  const items = (Array.isArray(req.body) ? req.body : Array.isArray(req.body?.elements) ? req.body.elements : [req.body]) as Array<Record<string, any>>;
  const out: Array<{ status: string; duplicate?: boolean }> = [];
  for (const n of items.slice(0, 20)) {
    if (n?.type !== 'LEAD_ACTION' || !n.leadGenFormResponse) continue;
    const urn = String(n.leadGenFormResponse);
    if (n.leadAction === 'DELETED') { // the person withdrew: keep the record of the event, remove what they submitted
      await Submission.updateMany({ channel: 'LINKEDIN', externalId: urn, ...(only ? { connectionId: only._id } : {}) }, { $set: { answers: [], reason: 'Deleted by the person on LinkedIn' } });
      // Q97 (client decision): only the answers are cleared; the advisor is told and chooses to keep or remove the lead.
      const linked = await Submission.find({ channel: 'LINKEDIN', externalId: urn, leadId: { $ne: null } }, { leadId: 1 }).lean<Array<{ leadId: string }>>();
      await (await import('../leads/withdrawal.service.js')).markWithdrawn(linked.map((x) => x.leadId), 'LINKEDIN');
      out.push({ status: 'DELETED' }); continue;
    }
    const owner = String(n.owner?.sponsoredAccount ?? n.owner?.organization ?? '');
    const conn = only
      ? (only.status === 'CONNECTED' && only.sources.some((x) => x.id === owner && x.subscribed) ? only : null)
      : await Connection.findOne({ channel: 'LINKEDIN', status: 'CONNECTED', mode: { $ne: 'MANUAL' }, sources: { $elemMatch: { id: owner, subscribed: true } } }).lean<ConnectionDoc>();
    if (!conn) continue;
    if (!formAllowed(conn, String(n.leadGenForm ?? ''))) { out.push({ status: 'SKIPPED' }); continue; }
    const { sub, duplicate } = await receivePlatformLead(conn, { externalId: urn, formExternalId: String(n.leadGenForm ?? 'linkedin-form'), formName: 'LinkedIn lead form', meta: { owner } });
    out.push({ status: duplicate ? sub.status : (await completePlatformLead(sub._id)).status, duplicate });
  }
  return { received: out.length, results: out };
}

/**
 * Catch-up every 15 minutes (ported from the previous CRM's auto-sync): anything a webhook missed since the last run
 * (first run: 24 hours). Already-known leads are skipped by the database rule. Token errors → RECONNECT_NEEDED.
 */
export async function catchUp(now = clock.now(), onlyConnectionId?: string) {
  const out = { connections: 0, found: 0, imported: 0, errors: 0 };
  for await (const c of Connection.find({ $or: [{ channel: { $in: ['META', 'LINKEDIN'] } }, { channel: 'GOOGLE', tokenEnc: { $ne: null } }], status: 'CONNECTED', ...(onlyConnectionId ? { _id: onlyConnectionId } : {}) }).lean<ConnectionDoc>().cursor()) {
    out.connections++;
    const since = c.lastSyncAt ?? new Date(now.getTime() - 86_400_000);
    try {
      for (const src of c.channel === 'GOOGLE' ? [] : c.sources.filter((x) => x.subscribed)) {
        if (c.channel === 'META' && src.tokenEnc) {
          const pt = decryptField(src.tokenEnc);
          for (const f of (await withReconnect(c, () => meta.forms(src.id, pt))).filter((x) => formAllowed(c, x.id))) {
            for (const lead of await withReconnect(c, () => meta.formLeads(f.id, pt, Math.floor(since.getTime() / 1000) - 300))) {
              out.found++;
              const r = await ingest(c, { externalId: String(lead.id), formExternalId: f.id, formName: f.name, answers: metaAnswers(lead), meta: { pageId: src.id, campaignId: lead.campaign_id ?? null, adId: lead.id ? lead.ad_id ?? null : null, adSetId: lead.adset_id ?? null, campaignName: lead.campaign_name ?? null, adSetName: lead.adset_name ?? null, adName: lead.ad_name ?? null, viaCatchUp: true } });
              if (!r.duplicate) out.imported++;
            }
          }
        } else if (c.channel === 'LINKEDIN' && c.tokenEnc) {
          for (const r of (await withReconnect(c, () => linkedin.responses(src.id, decryptField(c.tokenEnc!), since.getTime() - 300_000))).filter((x: { versionedLeadGenFormUrn?: string }) => formAllowed(c, String(x.versionedLeadGenFormUrn ?? '')))) {
            out.found++;
            const x = await ingest(c, { externalId: String(r.id), formExternalId: String(r.versionedLeadGenFormUrn ?? 'linkedin-form'), formName: r.form?.name ?? 'LinkedIn lead form', answers: linkedinAnswers(r), isTest: !!r.testLead, meta: { owner: src.id, viaCatchUp: true } });
            if (!x.duplicate) out.imported++;
          }
        }
      }
      // Stage H: campaign status and spend (Meta, Google)
      // (own-app Meta connections hold a Page token, which cannot read ad spend: leads only)
      if ((c.channel === 'META' && (c as { mode?: string }).mode !== 'MANUAL') || c.channel === 'GOOGLE') await withReconnect(c, () => import('./campaigns.analytics.js').then((x) => x.syncCampaigns(c)));
      await Connection.updateOne({ _id: c._id }, { $set: { lastSyncAt: now, lastError: null } });
    } catch (e) {
      out.errors++;
      await Connection.updateOne({ _id: c._id }, { $set: { lastError: (e as Error).message.slice(0, 200) } });
      // Change #23: a sync that fails for another reason than sign-in (that one is CMP-09) tells the advisor once a day
      if (!(e instanceof ReconnectNeeded)) {
        const adv = await User.findOne({ accountId: c.accountId, role: 'ADV' }, { _id: 1 }).lean<{ _id: string }>();
        if (adv) await notify({ userId: adv._id, accountId: c.accountId, kind: 'CAMPAIGN_SYNC_FAILED', messageId: 'CMP-12', params: { channel: LABEL[c.channel as Channel], name: c.name }, dedupeKey: `CMP-12|${c._id}|${now.toISOString().slice(0, 10)}`, link: { type: 'CAMPAIGN', id: c._id } }).catch(() => undefined);
      }
    }
  }
  // LinkedIn tokens last about 60 days: past expiry → reconnect needed
  await Connection.updateMany({ channel: 'LINKEDIN', status: 'CONNECTED', tokenExpiresAt: { $lt: now } }, { $set: { status: 'RECONNECT_NEEDED', lastError: 'Sign-in expired' } });
  return out;
}
/** From the minute sweep: once per quarter hour (a JobRun record keeps it to one run). */
export async function maybeCatchUp(now = clock.now()) {
  const slot = new Date(Math.floor(now.getTime() / 900_000) * 900_000).toISOString();
  try { await JobRun.create({ _id: `CAMPAIGN-SYNC|${slot}`, at: now }); } catch (e) { if (isDuplicateKey(e)) return null; throw e; }
  return catchUp(now);
}
/**
 * Can this account connect each channel? `configured`: the app credentials are in the API settings; `on`: the
 * channel's rollout switch is on for this account (SkyUp Admin → Feature switches); `redirectUri`: what must be
 * registered in the platform's developer app. The Campaigns screen explains whatever is missing.
 */
export function platformReady(accountId?: string | null) {
  const one = (c: 'META' | 'LINKEDIN' | 'GOOGLE') => ({ configured: isConfigured(c), on: accountId ? channelOn(c, accountId) : true, redirectUri: redirectUri(c), plans: CHANNEL_FLAG[c] ? plansOf(CHANNEL_FLAG[c]!) : [] });
  // Google lead forms connect by webhook (no sign-in); the Google sign-in only adds status and spend afterwards
  const g = one('GOOGLE');
  return { META: one('META'), LINKEDIN: one('LINKEDIN'), GOOGLE: { ...g, configured: true, signInConfigured: g.configured }, WEBSITE: { configured: true, on: accountId ? channelOn('WEBSITE', accountId) : true, redirectUri: null } };
}

/** Stage H "Sync now": the same catch-up and status/spend sync for one connection, at most once a minute. */
export async function syncNow(ctx: AuthContext, id: string) {
  const c = await Connection.findOne({ _id: id, accountId: ctx.accountId }).lean<ConnectionDoc>();
  if (!c) throw AppError.notFound();
  if (c.status !== 'CONNECTED') throw AppError.invalidState('connection', c.status);
  const hits = await hitCounter(`campaign-sync:${id}`, 60);
  if (hits.count > 1) throw new AppError(429, 'RATE_LIMITED', 'CMP-14');
  const out = await catchUp(clock.now(), id);
  return { ...out, connection: view((await Connection.findById(id).lean<ConnectionDoc>())!) };
}
/* ───────────────────────── Own-app (manual) connections ───────────────────────── */

const ownedElsewhere = async (accountId: string, channel: 'META' | 'LINKEDIN', sourceId: string, exceptId?: string) =>
  !!(await Connection.exists({ channel, accountId: { $ne: accountId }, status: { $ne: 'DISCONNECTED' }, 'sources.id': sourceId, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }));

/**
 * Connect with the advisor's own Meta / LinkedIn app (no SkyUp app needed): the advisor pastes their Page ID and Page
 * token + app secret (Meta) or ad account / organization URN, access token and client secret (LinkedIn). The token is
 * checked with the platform, the Page / account is subscribed, and the answer carries this connection's own webhook URL
 * (and, for Meta, the verify token) to paste into their app — shown once.
 * One Page / ad account belongs to one Bimayantra account (CMP-21): leads never land in two advisors' pipelines.
 */
export async function connectManual(ctx: AuthContext, b: ConnDetails & {
  channel: 'META' | 'LINKEDIN'; name: string; pipelineId?: string | null; formIds?: string[];
  pageId?: string; pageToken?: string; appSecret?: string; verifyToken?: string | null;
  accountUrn?: string; accessToken?: string; clientSecret?: string;
}, req: Request) {
  if (!channelOn(b.channel, ctx.accountId!)) throw new AppError(409, 'INVALID_STATE', 'CMP-08', { channel: LABEL[b.channel] });
  const sourceId = b.channel === 'META' ? String(b.pageId ?? '').trim() : String(b.accountUrn ?? '').trim();
  if (await ownedElsewhere(ctx.accountId!, b.channel, sourceId)) throw new AppError(409, 'DUPLICATE', 'CMP-21', { channel: LABEL[b.channel] });
  const conn = new Connection({ accountId: ctx.accountId, channel: b.channel, name: b.name, pipelineId: b.pipelineId ?? null, createdBy: ctx.userId, mode: 'MANUAL', formFilter: (b.formIds ?? []).map((x) => x.trim()).filter(Boolean), ...detailSet(b) });
  let verifyToken: string | null = null;
  if (b.channel === 'META') {
    let page;
    try { page = await meta.page(sourceId, b.pageToken!); } catch (e) { throw AppError.field('pageToken', 'CMP-22', { reason: (e as Error).message.slice(0, 160) }); }
    try { await meta.subscribe(sourceId, b.pageToken!); } catch (e) { throw AppError.field('pageToken', 'CMP-23', { reason: (e as Error).message.slice(0, 160) }); }
    verifyToken = (b.verifyToken ?? '').trim() || randomBytes(18).toString('base64url');
    conn.set({ tokenEnc: encryptField(b.pageToken!), sources: [{ id: page.id, name: page.name, tokenEnc: encryptField(b.pageToken!), subscribed: true }], appSecretEnc: encryptField(b.appSecret!), verifyTokenEnc: encryptField(verifyToken) });
  } else {
    conn.set({ tokenEnc: encryptField(b.accessToken!), sources: [{ id: sourceId, name: sourceId, subscribed: true }], appSecretEnc: encryptField(b.clientSecret!) });
    try { await linkedin.subscribe(sourceId, b.accessToken!, manualHookUrl(conn.toObject() as ConnectionDoc)); } catch (e) { throw AppError.field('accessToken', 'CMP-22', { reason: (e as Error).message.slice(0, 160) }); }
  }
  await conn.save();
  // never the token or secrets in the audit log
  await audit({ entity: 'campaign', entityId: conn._id, action: 'CAMPAIGN_CONNECTED', after: { channel: b.channel, mode: 'MANUAL', source: sourceId, forms: (b.formIds ?? []).length } }, { req });
  const c = conn.toObject() as ConnectionDoc;
  return { connection: view(c), webhookUrl: manualHookUrl(c), verifyToken };
}

/** Replace an expired token or secret, or change the form filter, on a manual connection; it is CONNECTED again. */
export async function updateManual(ctx: AuthContext, id: string, b: { pageToken?: string; appSecret?: string; accessToken?: string; clientSecret?: string; formIds?: string[]; name?: string }, req: Request) {
  const c = await loadConn(ctx, id);
  if ((c as { mode?: string }).mode !== 'MANUAL') throw AppError.invalidState('connection', 'connected by sign-in');
  const set: Record<string, unknown> = {};
  if (b.name) set.name = b.name;
  if (b.formIds) set.formFilter = b.formIds.map((x) => x.trim()).filter(Boolean);
  if (c.channel === 'META' && b.pageToken) {
    const src = c.sources[0]!;
    try { await meta.page(src.id, b.pageToken); await meta.subscribe(src.id, b.pageToken); } catch (e) { throw AppError.field('pageToken', 'CMP-22', { reason: (e as Error).message.slice(0, 160) }); }
    set.tokenEnc = encryptField(b.pageToken); set.sources = [{ ...src, tokenEnc: encryptField(b.pageToken), subscribed: true }];
  }
  if (c.channel === 'LINKEDIN' && b.accessToken) {
    try { await linkedin.subscribe(c.sources[0]!.id, b.accessToken, manualHookUrl(c)); } catch (e) { throw AppError.field('accessToken', 'CMP-22', { reason: (e as Error).message.slice(0, 160) }); }
    set.tokenEnc = encryptField(b.accessToken);
  }
  if (b.appSecret || b.clientSecret) set.appSecretEnc = encryptField((b.appSecret ?? b.clientSecret)!);
  if (set.tokenEnc) { set.status = 'CONNECTED'; set.lastError = null; }
  await Connection.updateOne({ _id: id }, { $set: set });
  await audit({ entity: 'campaign', entityId: id, action: 'CAMPAIGN_UPDATED', after: { fields: Object.keys(set).filter((k) => !k.endsWith('Enc') && k !== 'sources') } }, { req });
  return view((await Connection.findById(id).lean<ConnectionDoc>())!);
}

/** The connection a manual webhook URL points to (any account: the path itself is the routing). */
export async function manualConnection(channel: 'META' | 'LINKEDIN', id: string) {
  const c = await Connection.findOne({ _id: id, channel, mode: 'MANUAL' }).lean<ConnectionDoc>();
  if (!c) throw AppError.forbidden();
  return c;
}
export function metaVerifyFor(c: ConnectionDoc, q: Record<string, unknown>) {
  const want = decryptField((c as { verifyTokenEnc: string }).verifyTokenEnc);
  if (q['hub.mode'] !== 'subscribe' || !safeEq(String(q['hub.verify_token'] ?? ''), want)) throw AppError.forbidden();
  return String(q['hub.challenge'] ?? '');
}