import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { clock } from '../../lib/clock.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import type { MessageId, MessageParams } from '../../lib/messages.js';
import { accountOf } from '../../middleware/authorize.js';
import { audit } from '../audit/audit.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Consent, Customer, FamilyMember, type ConsentChannel, type ConsentDoc } from './customer.model.js';

export const CHANNEL_LABEL: Record<ConsentChannel, string> = { WHATSAPP: 'WhatsApp', EMAIL: 'Email', SMS: 'SMS', PERSONAL_DATA: 'Personal-data' };
const MESSAGE_CHANNELS: ConsentChannel[] = ['WHATSAPP', 'EMAIL', 'SMS'];
export const personKey = (type: 'C' | 'F' | 'L', id: string) => `${type}:${id}`;

const cell = (c: ConsentDoc | undefined) => ({
  status: c?.status ?? 'NOT_RECORDED', at: c?.recordedAt ?? null, howGiven: c?.howGiven ?? null, address: c?.address ?? null,
  termsVersion: c?.termsVersion ?? null, version: c?.version ?? null,
});

/** GR-37: is the customer's personal-data consent currently GIVEN? */
export async function personalDataConsent(accountId: string, customerId: string) {
  const c = await Consent.findOne({ accountId, personKey: personKey('C', customerId), channel: 'PERSONAL_DATA' }).lean<ConsentDoc>();
  return c?.status ?? 'NOT_RECORDED';
}

/**
 * P-15 backend rule: consent belongs to the exact mobile or email. When it changes, that consent
 * goes back to NOT_RECORDED (and queued messages to the old address are cancelled — none exist yet).
 */
export async function resetConsents(accountId: string, key: string, channels: ConsentChannel[], note: string, by: string, session: ClientSession | null) {
  const now = clock.now();
  const rows = await Consent.find({ accountId, personKey: key, channel: { $in: channels }, status: { $ne: 'NOT_RECORDED' } }).session(session).lean<ConsentDoc[]>();
  for (const r of rows) {
    await Consent.updateOne({ _id: r._id }, {
      $set: { status: 'NOT_RECORDED', address: null, howGiven: null, recordedBy: by, recordedAt: now }, $inc: { version: 1 },
      $push: { history: { from: r.status, to: 'NOT_RECORDED', address: null, note, source: 'SYSTEM', by, at: now } },
    }, { session: session ?? undefined });
  }
  return rows.length;
}

/** P-14 step 4: consent recorded on the lead (referral form, P-46) is copied to the customer. */
export async function copyLeadConsents(accountId: string, leadId: string, customerId: string, by: string, session: ClientSession | null) {
  const now = clock.now();
  const rows = await Consent.find({ accountId, personKey: personKey('L', leadId), status: 'GIVEN' }).session(session).lean<ConsentDoc[]>();
  for (const r of rows) {
    const exists = await Consent.exists({ accountId, personKey: personKey('C', customerId), channel: r.channel }).session(session);
    if (exists) continue;
    await new Consent({
      accountId, personKey: personKey('C', customerId), customerId, channel: r.channel, status: 'GIVEN', address: r.address, howGiven: r.howGiven,
      termsVersion: r.termsVersion, recordedBy: by, recordedAt: now,
      history: [{ from: null, to: 'GIVEN', address: r.address, howGiven: r.howGiven, note: `Copied from lead ${leadId}`, source: 'LEAD_CONVERSION', by, at: now }],
    }).save({ session: session ?? undefined });
  }
}

/** P-17 step 1: one row per person (customer and each ACTIVE family member), one column per channel. */
export async function getConsents(ctx: AuthContext, customerId: string) {
  const accountId = accountOf(ctx);
  const customer = await Customer.findOne({ _id: customerId, accountId }).lean();
  if (!customer) throw AppError.notFound();
  const members = await FamilyMember.find({ accountId, customerId, status: 'ACTIVE' }).sort({ createdAt: 1 }).lean();
  const consents = await Consent.find({ accountId, customerId }).lean<ConsentDoc[]>();
  const find = (key: string, ch: ConsentChannel) => consents.find((c) => c.personKey === key && c.channel === ch);
  const people = [
    { type: 'CUSTOMER' as const, id: customer._id, name: customer.name, relationship: 'Customer', mobile: customer.mobile, email: customer.email, key: personKey('C', customer._id) },
    ...members.map((m) => ({ type: 'FAMILY' as const, id: m._id, name: m.name, relationship: m.relationship, mobile: m.mobile, email: m.email, key: personKey('F', m._id) })),
  ];
  const names = new Map(people.map((p) => [p.key, p.name]));
  return {
    rows: people.map(({ key, ...p }) => ({ person: p, channels: Object.fromEntries(MESSAGE_CHANNELS.map((ch) => [ch, cell(find(key, ch))])) })),
    personalData: cell(find(personKey('C', customer._id), 'PERSONAL_DATA')),
    history: consents
      .flatMap((c) => c.history.map((h) => ({ ...h, channel: c.channel, person: names.get(c.personKey) ?? 'Former family member' })))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 200),
  };
}

interface ConsentInput {
  personType: 'CUSTOMER' | 'FAMILY'; personId: string; channel: ConsentChannel; action: 'GIVE' | 'WITHDRAW';
  howGiven?: string | null; declaration?: boolean; version?: number;
  /** Change #24: optional proof; why consent was withdrawn (a note when "Other"); personal-data withdrawal acknowledgement. */
  evidenceFileId?: string | null; withdrawReason?: 'ASKED_TO_STOP' | 'REPLIED_STOP' | 'OTHER' | null; withdrawNote?: string | null; acknowledgedEffects?: boolean;
}

/** P-17 steps 2–3: record (with how it was given and the declaration) or withdraw, per person and channel. */
export async function recordConsent(ctx: AuthContext, customerId: string, b: ConsentInput, req: Request): Promise<{ messageId: MessageId; params: MessageParams }> {
  const accountId = accountOf(ctx);
  const customer = await Customer.findOne({ _id: customerId, accountId }).lean();
  if (!customer) throw AppError.notFound();
  let person: { name: string; mobile: string | null; email: string | null; key: string };
  if (b.personType === 'CUSTOMER') {
    if (b.personId !== customer._id) throw AppError.field('personId', 'VAL-22');
    person = { name: customer.name, mobile: customer.mobile, email: customer.email ?? null, key: personKey('C', customer._id) };
  } else {
    if (b.channel === 'PERSONAL_DATA') throw AppError.field('personType', 'VAL-22');
    const m = await FamilyMember.findOne({ _id: b.personId, accountId, customerId, status: 'ACTIVE' }).lean();
    if (!m) throw AppError.field('personId', 'VAL-22');
    person = { name: m.name, mobile: m.mobile ?? null, email: m.email ?? null, key: personKey('F', m._id) };
  }
  const existing = await Consent.findOne({ accountId, personKey: person.key, channel: b.channel }).lean<ConsentDoc>();
  if (b.version !== undefined && existing && existing.version !== b.version) throw AppError.versionConflict('consent', cell(existing));
  const label = CHANNEL_LABEL[b.channel];
  const now = clock.now();

  let next: { status: 'GIVEN' | 'WITHDRAWN'; address: string | null; howGiven: string | null };
  if (b.action === 'GIVE') {
    if (customer.status !== 'ACTIVE') throw new AppError(409, 'INVALID_STATE', 'CU-20', { Customer: customer.name });
    const errs: Array<{ field: string; messageId: MessageId; params?: MessageParams }> = [];
    if (!b.howGiven) errs.push({ field: 'howGiven', messageId: 'GEN-01', params: { 'Field label': 'How it was given' } });
    if (b.declaration !== true) errs.push({ field: 'declaration', messageId: 'VAL-29' });
    if (errs.length) throw AppError.fields(errs);
    let address: string | null = null;
    if (b.channel === 'WHATSAPP' || b.channel === 'SMS') {
      if (!person.mobile) throw new AppError(409, 'INVALID_STATE', 'CU-13', { name: person.name, channel: label });
      address = person.mobile;
    } else if (b.channel === 'EMAIL') {
      if (!person.email) throw new AppError(409, 'INVALID_STATE', 'CU-14', { name: person.name });
      address = person.email;
    }
    next = { status: 'GIVEN', address, howGiven: b.howGiven! };
    if (existing?.status === 'GIVEN' && existing.address === address) return { messageId: 'CU-11', params: { Channel: label, name: person.name } };
  } else {
    if (existing?.status !== 'GIVEN') {
      throw AppError.invalidState('consent', existing?.status === 'WITHDRAWN' ? 'withdrawn' : 'not recorded');
    }
    if (b.withdrawReason === 'OTHER' && !b.withdrawNote) throw AppError.field('withdrawNote', 'GEN-01', { 'Field label': 'Note' });
    next = { status: 'WITHDRAWN', address: existing.address ?? null, howGiven: existing.howGiven ?? null };
  }
  const extra = next.status === 'GIVEN'
    ? { evidenceFileId: b.evidenceFileId ?? null, withdrawReason: null, withdrawNote: null, acknowledgedEffects: null }
    : { withdrawReason: b.withdrawReason ?? null, withdrawNote: b.withdrawNote ?? null, acknowledgedEffects: b.channel === 'PERSONAL_DATA' ? (b.acknowledgedEffects ?? null) : null };

  const change = { from: existing?.status ?? 'NOT_RECORDED', to: next.status, address: next.address, howGiven: next.howGiven, note: next.status === 'WITHDRAWN' ? ([b.withdrawReason, b.withdrawNote].filter(Boolean).join(': ') || null) : null, source: 'USER', by: ctx.userId, at: now };
  const termsVersion = b.channel === 'PERSONAL_DATA' ? env.TERMS_VERSION : null;
  try {
    await withTx(async (session) => {
      if (existing) {
        const r = await Consent.updateOne(
          { _id: existing._id, version: existing.version },
          { $set: { ...extra, status: next.status, address: next.address, howGiven: next.howGiven, termsVersion: termsVersion ?? existing.termsVersion, recordedBy: ctx.userId, recordedAt: now }, $inc: { version: 1 }, $push: { history: change } },
          { session: session ?? undefined },
        );
        if (r.modifiedCount === 0) throw AppError.versionConflict('consent', null);
      } else {
        await new Consent({ accountId, personKey: person.key, customerId, channel: b.channel, ...next, ...extra, termsVersion, recordedBy: ctx.userId, recordedAt: now, history: [change] }).save({ session: session ?? undefined });
      }
      await audit({
        entity: 'consent', entityId: customerId, entityRef: customer.number, action: next.status === 'GIVEN' ? 'CONSENT_GIVEN' : 'CONSENT_WITHDRAWN',
        before: { status: change.from }, after: { person: person.name, channel: b.channel, status: next.status, howGiven: next.howGiven, termsVersion },
      }, { req, session });
    });
  } catch (err) {
    if (isDuplicateKey(err, 'accountId_1_personKey_1_channel_1')) throw AppError.versionConflict('consent', null);
    throw err;
  }
  if (next.status === 'GIVEN') return { messageId: 'CU-11', params: { Channel: label, name: person.name } };
  if (b.channel === 'PERSONAL_DATA') return { messageId: 'CU-30', params: { Customer: customer.name } };
  return { messageId: 'CU-12', params: { Channel: label, name: person.name, channel: label } };
}

/**
 * Change #24: several channels in one record. Everything that could refuse any one channel is checked first (person,
 * contact details, declaration, current state), so a refusal writes nothing; then one row per channel is saved
 * through recordConsent, exactly as a single-channel request would.
 */
export async function recordConsents(ctx: AuthContext, customerId: string, b: Omit<ConsentInput, 'channel'> & { channels: ConsentChannel[] }, req: Request) {
  const accountId = accountOf(ctx);
  const customer = await Customer.findOne({ _id: customerId, accountId }).lean();
  if (!customer) throw AppError.notFound();
  const channels = [...new Set(b.channels)];
  const fam = b.personType === 'FAMILY' ? await FamilyMember.findOne({ _id: b.personId, accountId, customerId, status: 'ACTIVE' }).lean() : null;
  if (b.personType === 'CUSTOMER' ? b.personId !== customer._id : !fam) throw AppError.field('personId', 'VAL-22');
  if (b.personType === 'FAMILY' && channels.includes('PERSONAL_DATA')) throw AppError.field('personType', 'VAL-22');
  const person = b.personType === 'CUSTOMER' ? { name: customer.name, mobile: customer.mobile, email: customer.email ?? null, key: personKey('C', customer._id) } : { name: fam!.name, mobile: fam!.mobile ?? null, email: fam!.email ?? null, key: personKey('F', fam!._id) };
  if (b.action === 'GIVE') {
    if (customer.status !== 'ACTIVE') throw new AppError(409, 'INVALID_STATE', 'CU-20', { Customer: customer.name });
    const errs: Array<{ field: string; messageId: MessageId; params?: MessageParams }> = [];
    if (!b.howGiven) errs.push({ field: 'howGiven', messageId: 'GEN-01', params: { 'Field label': 'How it was given' } });
    if (b.declaration !== true) errs.push({ field: 'declaration', messageId: 'VAL-29' });
    if (errs.length) throw AppError.fields(errs);
    for (const ch of channels) {
      if ((ch === 'WHATSAPP' || ch === 'SMS') && !person.mobile) throw new AppError(409, 'INVALID_STATE', 'CU-13', { name: person.name, channel: CHANNEL_LABEL[ch] });
      if (ch === 'EMAIL' && !person.email) throw new AppError(409, 'INVALID_STATE', 'CU-14', { name: person.name });
    }
  } else {
    if (b.withdrawReason === 'OTHER' && !b.withdrawNote) throw AppError.field('withdrawNote', 'GEN-01', { 'Field label': 'Note' });
    const rows = await Consent.find({ accountId, personKey: person.key, channel: { $in: channels } }, { channel: 1, status: 1 }).lean<Array<{ channel: string; status: string }>>();
    for (const ch of channels) if (rows.find((r) => r.channel === ch)?.status !== 'GIVEN') throw AppError.invalidState('consent', `${CHANNEL_LABEL[ch]} not given`);
  }
  for (const channel of channels) await recordConsent(ctx, customerId, { ...b, channel, version: undefined }, req);
  return { messageId: (b.action === 'GIVE' ? 'CU-31' : 'CU-32') as MessageId, params: { name: person.name, channels: channels.map((c) => CHANNEL_LABEL[c]).join(', ') } };
}