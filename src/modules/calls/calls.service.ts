import type { Request } from 'express';
import { cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { normalizeMobile } from '../../lib/phone.js';
import { audit } from '../audit/audit.service.js';
import { Customer, FamilyMember } from '../customers/customer.model.js';
import { detectAudio, open as openFile, storeServerFile } from '../files/files.service.js';
import { Lead } from '../leads/lead.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { CALL_TYPES, Call, type CallDoc } from './call.model.js';

type Party = { leadId: string | null; customerId: string | null; name: string; leadOpen: boolean };
const fmtDuration = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);

/** Whose number is this, within the account? An open lead first (the advisor is working it), then a customer. */
async function partyFor(accountId: string, phone: string, hint?: { leadId?: string | null; customerId?: string | null }): Promise<Party | null> {
  if (hint?.leadId) {
    const l = await Lead.findOne({ _id: hint.leadId, accountId }, { name: 1, isOpen: 1, customerId: 1, mobile: 1, altMobile: 1 }).lean<{ _id: string; name: string; isOpen: boolean; customerId: string | null; mobile: string; altMobile: string | null }>();
    if (l && (l.mobile === phone || l.altMobile === phone)) return { leadId: l._id, customerId: l.customerId ?? null, name: l.name, leadOpen: l.isOpen };
  }
  if (hint?.customerId) {
    const c = await Customer.findOne({ _id: hint.customerId, accountId }, { name: 1, mobile: 1, altMobile: 1 }).lean<{ _id: string; name: string; mobile: string; altMobile: string | null }>();
    if (c && (c.mobile === phone || c.altMobile === phone)) return { leadId: null, customerId: c._id, name: c.name, leadOpen: false };
  }
  const lead = await Lead.findOne({ accountId, $or: [{ mobile: phone }, { altMobile: phone }] }, { name: 1, isOpen: 1, customerId: 1 }).sort({ isOpen: -1, createdAt: -1 }).lean<{ _id: string; name: string; isOpen: boolean; customerId: string | null }>();
  const customer = await Customer.findOne({ accountId, $or: [{ mobile: phone }, { altMobile: phone }] }, { name: 1 }).sort({ status: 1, createdAt: -1 }).lean<{ _id: string; name: string }>();
  if (lead?.isOpen) return { leadId: lead._id, customerId: customer?._id ?? lead.customerId ?? null, name: lead.name, leadOpen: true };
  if (customer) return { leadId: lead?._id ?? null, customerId: customer._id, name: customer.name, leadOpen: false };
  if (lead) return { leadId: lead._id, customerId: lead.customerId ?? null, name: lead.name, leadOpen: false };
  const fam = await FamilyMember.findOne({ accountId, mobile: phone }, { customerId: 1, name: 1 }).lean<{ customerId: string; name: string }>();
  if (fam) return { leadId: null, customerId: fam.customerId, name: fam.name, leadOpen: false };
  return null;
}

/** A synced call counts as contact on an open lead (P-13): answered → spoke; an unanswered outgoing call → not reachable. */
async function logAsContact(call: CallDoc, party: Party) {
  if (!party.leadId || !party.leadOpen || call.contactLogged) return;
  const outcome = call.durationSec > 0 && ['outgoing', 'incoming'].includes(call.callType) ? 'SPOKE_TO_CUSTOMER' : call.callType === 'outgoing' || call.callType === 'rejected' ? 'NOT_REACHABLE' : null;
  if (!outcome) return; // a missed incoming call is not the advisor's contact attempt
  const note = `Phone call (${call.callType}) · ${fmtDuration(call.durationSec)}${call.durationEstimated ? ' (approx.)' : ''} · synced from the phone`;
  const u = await Call.updateOne({ _id: call._id, contactLogged: false }, { $set: { contactLogged: true } });
  if (u.modifiedCount) await Lead.updateOne({ _id: party.leadId, accountId: call.accountId }, { $push: { contacts: { _id: newId('act'), outcome, note, at: call.at, by: call.userId } } });
}

export interface DeviceLog { phoneNumber: string; callType?: string; duration?: number; timestamp: number | string; name?: string; leadId?: string | null }
const parseTime = (t: number | string) => { const n = typeof t === 'number' ? t : /^\d+$/.test(String(t)) ? Number(t) : Date.parse(String(t)); return Number.isFinite(n) && n > 0 ? new Date(n) : null; };

/**
 * POST /call-logs/sync — the app's batch (up to CFG-193). Calls to the account's leads and customers are stored once
 * each; every other number (the advisor's personal calls) is counted as ignored and never stored.
 */
export async function sync(ctx: AuthContext, logs: DeviceLog[], req: Request) {
  const batch = logs.slice(0, cfgNum('CFG-193'));
  const out = { received: logs.length, saved: 0, duplicates: 0, ignored: 0, invalid: 0 };
  const cache = new Map<string, Party | null>();
  for (const l of batch) {
    const phone = normalizeMobile(String(l.phoneNumber ?? ''));
    const at = parseTime(l.timestamp);
    if (!phone || !at || at.getTime() > clock.now().getTime() + 5 * 60_000) { out.invalid++; continue; }
    const callType = (CALL_TYPES as readonly string[]).includes(String(l.callType ?? '').toLowerCase()) ? String(l.callType).toLowerCase() : 'unknown';
    const key = `${phone}|${l.leadId ?? ''}`;
    if (!cache.has(key)) cache.set(key, await partyFor(ctx.accountId!, phone, { leadId: l.leadId ?? null }));
    const party = cache.get(key)!;
    if (!party) { out.ignored++; continue; }
    try {
      const c = await Call.create({ accountId: ctx.accountId, userId: ctx.userId, phone, callType, at, durationSec: Math.max(0, Math.round(Number(l.duration) || 0)), source: 'DEVICE', leadId: party.leadId, customerId: party.customerId });
      out.saved++;
      await logAsContact(c.toObject() as CallDoc, party);
    } catch (e) { if (isDuplicateKey(e)) out.duplicates++; else throw e; }
  }
  if (out.saved) await audit({ entity: 'call', action: 'CALLS_SYNCED', after: out }, { req });
  return out;
}

/** POST /call-logs/app-call — a call dialled from the web app (iPhone): the time away is an estimate of the duration. */
export async function appCall(ctx: AuthContext, b: { leadId?: string | null; customerId?: string | null; phoneNumber: string; startedAt: number | string; returnedAt?: number | string | null }, req: Request) {
  const phone = normalizeMobile(b.phoneNumber);
  const at = parseTime(b.startedAt);
  if (!phone) throw AppError.field('phoneNumber', 'VAL-01');
  if (!at) throw AppError.field('startedAt', 'VAL-07');
  const party = await partyFor(ctx.accountId!, phone, b);
  if (!party) throw AppError.field('phoneNumber', 'CALL-04');
  const back = b.returnedAt ? parseTime(b.returnedAt) : null;
  try {
    const c = await Call.create({ accountId: ctx.accountId, userId: ctx.userId, phone, callType: 'outgoing', at, durationSec: back ? Math.max(0, Math.round((back.getTime() - at.getTime()) / 1000)) : 0, durationEstimated: true, source: 'APP', leadId: party.leadId, customerId: party.customerId });
    await logAsContact(c.toObject() as CallDoc, party);
    await audit({ entity: 'call', entityId: c._id, action: 'CALL_LOGGED_FROM_APP' }, { req });
    return view(c.toObject() as CallDoc);
  } catch (e) { if (isDuplicateKey(e)) return view((await Call.findOne({ userId: ctx.userId, phone, at, callType: 'outgoing' }).lean<CallDoc>())!); throw e; }
}

/**
 * POST /call-logs/recording — the app's multipart upload (recording, phoneNumber, timestamp, fileKey, leadId?).
 * Checked by content; stored once per fileKey; attached to the nearest call within CFG-191 minutes (by the same user
 * to the same number), else a call row is made for it. A number that is not a lead or customer is not stored, and the
 * answer says so with 200 so the app stops retrying.
 */
export async function attachRecording(ctx: AuthContext, f: { bytes: Buffer; originalName: string }, b: { phoneNumber: string; timestamp?: string; fileKey?: string; leadId?: string; customerId?: string; source?: string }, req: Request) {
  const phone = normalizeMobile(String(b.phoneNumber ?? ''));
  if (!phone) throw AppError.field('phoneNumber', 'VAL-01');
  if (f.bytes.length > cfgNum('CFG-192') * 1024 * 1024) throw AppError.field('recording', 'CALL-03', { 'CFG-192': cfgNum('CFG-192') });
  const audio = detectAudio(f.bytes);
  if (!audio) throw AppError.field('recording', 'CALL-02');
  const at = parseTime(b.timestamp ?? Date.now()) ?? clock.now();
  const fileKey = (b.fileKey && b.fileKey.trim().slice(0, 300)) || `${phone}::${f.originalName}::${at.getTime()}`;
  const existing = await Call.findOne({ accountId: ctx.accountId, 'recordings.fileKey': fileKey }).lean<CallDoc>();
  if (existing) return { stored: true, duplicate: true, call: view(existing) };
  const party = await partyFor(ctx.accountId!, phone, { leadId: b.leadId ?? null, customerId: b.customerId ?? null });
  if (!party) return { stored: false, reason: 'CALL-04' };
  const win = cfgNum('CFG-191') * 60_000;
  const near = await Call.find({ accountId: ctx.accountId, userId: ctx.userId, phone, at: { $gte: new Date(at.getTime() - win - 6 * 3_600_000), $lte: new Date(at.getTime() + win) } }).lean<CallDoc[]>();
  // the file is written when the call ends: compare with the call's end, and its start for safety
  const scored = near.map((c) => ({ c, d: Math.min(Math.abs(at.getTime() - (c.at.getTime() + c.durationSec * 1000)), Math.abs(at.getTime() - c.at.getTime())) })).filter((x) => x.d <= win).sort((x, y) => x.d - y.d);
  const target = scored[0]?.c ?? null;
  const file = await storeServerFile(ctx, 'CALL_RECORDING', f.bytes, f.originalName || `recording.${audio.ext}`, 'AUDIO', audio.mime);
  const rec = { _id: newId('rec'), fileId: file.id, fileKey, name: f.originalName, size: f.bytes.length, mime: audio.mime, source: b.source === 'manual' ? 'MANUAL' : 'AUTO', uploadedAt: clock.now(), uploadedBy: ctx.userId };
  let callId: string;
  try {
    if (target) { await Call.updateOne({ _id: target._id }, { $push: { recordings: rec } }); callId = target._id; }
    else {
      const c = await Call.create({ accountId: ctx.accountId, userId: ctx.userId, phone, callType: 'unknown', at, source: 'RECORDING', leadId: party.leadId, customerId: party.customerId, recordings: [rec] });
      callId = c._id;
    }
  } catch (e) {
    if (isDuplicateKey(e)) { const d = await Call.findOne({ accountId: ctx.accountId, 'recordings.fileKey': fileKey }).lean<CallDoc>(); return { stored: true, duplicate: true, call: d ? view(d) : null }; }
    throw e;
  }
  await audit({ entity: 'call', entityId: callId, action: 'CALL_RECORDING_UPLOADED', after: { size: f.bytes.length, mime: audio.mime, source: rec.source } }, { req });
  return { stored: true, duplicate: false, call: view((await Call.findById(callId).lean<CallDoc>())!), params: { name: party.name } };
}

const view = (c: CallDoc) => ({
  id: c._id, phone: c.phone, callType: c.callType, at: c.at, durationSec: c.durationSec, durationEstimated: c.durationEstimated, source: c.source,
  leadId: c.leadId, customerId: c.customerId, userId: c.userId,
  recordings: c.recordings.map((r) => ({ id: r._id, name: r.name, size: r.size, mime: r.mime, source: r.source, uploadedAt: r.uploadedAt })),
});

/** Calls for a lead or customer, or a day (IST). Assistants see calls; only the advisor plays recordings. */
export async function list(ctx: AuthContext, q: { leadId?: string; customerId?: string; date?: string }) {
  const filter: Record<string, unknown> = { accountId: ctx.accountId };
  if (q.leadId) filter.leadId = q.leadId;
  if (q.customerId) filter.customerId = q.customerId;
  if (!q.leadId && !q.customerId) {
    const day = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : istToday();
    filter.at = { $gte: new Date(`${day}T00:00:00+05:30`), $lt: new Date(new Date(`${day}T00:00:00+05:30`).getTime() + 86_400_000) };
  }
  const rows = await Call.find(filter).sort({ at: -1 }).limit(300).lean<CallDoc[]>();
  const names = new Map((await User.find({ _id: { $in: [...new Set(rows.map((r) => r.userId))] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((u) => [u._id, u.name]));
  return rows.map((r) => ({ ...view(r), by: names.get(r.userId) ?? null }));
}

/** GET /call-logs/match?phone= — the app asks whose number this is before or after a call. */
export async function match(ctx: AuthContext, phoneRaw: string) {
  const phone = normalizeMobile(phoneRaw);
  if (!phone) return { matched: false };
  const p = await partyFor(ctx.accountId!, phone);
  return p ? { matched: true, leadId: p.leadId, customerId: p.customerId, name: p.name } : { matched: false };
}

/** The recording's bytes for playback (advisor only), with the call it belongs to checked against the account. */
export async function recordingFile(ctx: AuthContext, callId: string, recId: string, req: Request) {
  const c = await Call.findOne({ _id: callId, accountId: ctx.accountId }).lean<CallDoc>();
  const r = c?.recordings.find((x) => x._id === recId);
  if (!c || !r) throw AppError.notFound();
  const out = await openFile(ctx, r.fileId, req);
  return { ...out, mime: r.mime, name: r.name || `recording-${c.at.toISOString().slice(0, 10)}` };
}