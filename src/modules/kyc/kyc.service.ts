import type { Request } from 'express';
import { cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { decryptField, encryptField } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { withTx } from '../../lib/mongo.js';
import { Account, type AccountDoc } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { StoredFile, type FileDoc } from '../files/file.model.js';
import { assertOwnFile, open as openFile, view as fileView } from '../files/files.service.js';
import { ocrText, readDocument, readerEnabled } from '../documents/reader.js';
import { parseLicence } from '../documents/parsers.js';
import { useStepUp } from '../auth/stepUp.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../notifications/notifications.service.js';
import { ensureSectionVersions, refreshCompletion } from '../profile/profile.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';

/** P-06 reject reasons ("Other" needs a note). */
export const REJECT_REASONS = ['Document unclear', 'Name does not match', 'PAN invalid', 'Licence expired', 'Other'] as const;

export interface SubmitBody { version: number; pan: string; nameOnPan: string; panFileId: string; licenceFileId: string; declaration: true; confirm: string[] }
export interface DecisionBody { version: number; decision: 'VERIFY' | 'REJECT'; reason?: string | null; note?: string | null; checklist?: KycChecklist | null }
/** Change #48: the reviewer's four ticks (§9.9: stored with the decision, to confirm). */
export interface KycChecklist { panReadable: boolean; nameMatches: boolean; licenceValid: boolean; photoClear: boolean }

async function files(ids: Array<string | null | undefined>) {
  const list = await StoredFile.find({ _id: { $in: ids.filter(Boolean) } }).lean<FileDoc[]>();
  const byId = new Map(list.map((f) => [f._id, fileView(f)]));
  return (id: string | null | undefined) => (id ? byId.get(id) ?? null : null);
}

/** Working days (Mon–Fri, IST) from a moment until now: for the CFG-125 review target. */
export function workingDaysSince(from: Date, now = clock.now()): number {
  const day = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000); // IST wall clock
  let n = 0;
  const cur = day(from);
  cur.setUTCHours(0, 0, 0, 0);
  const end = day(now);
  end.setUTCHours(0, 0, 0, 0);
  while (cur < end) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

function kycOf(acc: AccountDoc) {
  return { k: acc.profile?.kyc ?? {}, status: acc.profile?.kycStatus ?? 'NOT_SUBMITTED', version: acc.profile?.sectionVersions?.kyc ?? 1 };
}

/** The advisor's own KYC screen: the full PAN is shown here (P-06 backend rule). */
async function advisorView(acc: AccountDoc) {
  const { k, status, version } = kycOf(acc);
  const f = await files([k.panFileId, k.licenceFileId]);
  return {
    status, version,
    pan: k.panEnc ? decryptField(k.panEnc) : null,
    nameOnPan: k.nameOnPan ?? null,
    panFile: f(k.panFileId), licenceFile: f(k.licenceFileId),
    submittedAt: k.submittedAt ?? null, decidedAt: k.decidedAt ?? null,
    rejection: status === 'REJECTED' ? { reason: k.rejectReason, note: k.rejectNote, message: msg('PRF-06', { reason: reasonText(k.rejectReason, k.rejectNote) }) } : null,
    ...(status === 'PENDING_REVIEW' ? { messageId: 'PRF-04', message: msg('PRF-04') } : {}),
  };
}

const reasonText = (reason?: string | null, note?: string | null) => (reason === 'Other' && note ? note : reason ?? '');

export async function getKyc(ctx: AuthContext) {
  await ensureSectionVersions(ctx.accountId!);
  const acc = await Account.findById(ctx.accountId).lean<AccountDoc>();
  if (!acc) throw AppError.notFound();
  return advisorView(acc);
}

/**
 * Submit for review (P-06 steps 1–2). Editing VERIFIED KYC needs PRF-07 confirmed and returns it to
 * PENDING_REVIEW (AC-P06-3). The write is conditional on the KYC version (GR-11).
 */
export async function submitKyc(ctx: AuthContext, b: SubmitBody, req: Request) {
  await ensureSectionVersions(ctx.accountId!);
  const acc = await Account.findById(ctx.accountId).lean<AccountDoc>();
  if (!acc) throw AppError.notFound();
  const { k, status, version } = kycOf(acc);
  if (b.version !== version) throw AppError.versionConflict('KYC', await advisorView(acc));
  await assertOwnFile(ctx, b.panFileId, 'KYC_PAN', 'panFileId');
  await assertOwnFile(ctx, b.licenceFileId, 'KYC_LICENCE', 'licenceFileId');

  const changed = (k.panEnc ? decryptField(k.panEnc) : null) !== b.pan || k.nameOnPan !== b.nameOnPan
    || k.panFileId !== b.panFileId || k.licenceFileId !== b.licenceFileId;
  if (status === 'VERIFIED' && !changed) return { view: await advisorView(acc), messageId: 'PRF-05' as const };
  if (status === 'VERIFIED' && !b.confirm.includes('PRF-07')) {
    throw new AppError(409, 'CONFIRMATION_REQUIRED', 'PRF-07', {}, { warnings: [{ messageId: 'PRF-07', message: msg('PRF-07') }] });
  }

  const now = clock.now();
  const updated = await withTx(async (session) => {
    const u = await Account.findOneAndUpdate(
      { _id: acc._id, 'profile.sectionVersions.kyc': version },
      {
        $set: {
          'profile.kycStatus': 'PENDING_REVIEW',
          'profile.kyc.panEnc': encryptField(b.pan), 'profile.kyc.nameOnPan': b.nameOnPan,
          'profile.kyc.panFileId': b.panFileId, 'profile.kyc.licenceFileId': b.licenceFileId,
          'profile.kyc.declaredAt': now, 'profile.kyc.submittedAt': now,
          'profile.kyc.decidedAt': null, 'profile.kyc.decidedBy': null, 'profile.kyc.rejectReason': null, 'profile.kyc.rejectNote': null,
        },
        $inc: { 'profile.sectionVersions.kyc': 1 },
      },
      { new: true, session: session ?? undefined },
    ).lean<AccountDoc>();
    if (!u) throw AppError.versionConflict('KYC', null);
    const name = (await User.findById(ctx.userId, { name: 1 }).lean<{ name: string }>())?.name ?? '';
    await refreshCompletion(acc._id, ctx.userId, u, name, session);
    // P-10 DSH-21: every active SkyUp reviewer is told, once per submission.
    const reviewers = await User.find({ role: { $in: ['STF', 'ADM'] }, status: 'ACTIVE' }, { _id: 1 }).session(session).lean<Array<{ _id: string }>>();
    for (const r of reviewers) {
      await notify({
        userId: r._id, accountId: null, kind: 'KYC_WAITING', messageId: 'DSH-21', params: { 'advisor name': name },
        dedupeKey: `DSH-21|${acc._id}|${now.toISOString()}`, link: { type: 'KYC_REVIEW', id: acc._id },
      }, session);
    }
    await audit({ entity: 'kyc', entityId: acc._id, action: status === 'VERIFIED' ? 'KYC_RESUBMITTED_AFTER_VERIFIED' : 'KYC_SUBMITTED',
      before: { status }, after: { status: 'PENDING_REVIEW' } }, { req, session });
    return u;
  });
  await startKycReading(ctx, acc._id, b.panFileId, b.licenceFileId, updated.profile?.kyc?.submittedAt ?? now, req);
  return { view: await advisorView(updated), messageId: 'PRF-04' as const };
}

// ── Change #48: read the PAN and licence images for the reviewer ──────────────

/**
 * Read both images after a submission and keep what was found (encrypted: it holds the PAN) for the review screen.
 * Never awaited by the submit; only the submission it was started for is written (a newer one starts its own).
 * No reader set up → OFF; a failure → FAILED: the reviewer compares by eye, nothing else changes.
 */
export async function readKycImages(ctx: AuthContext, accountId: string, panFileId: string, licenceFileId: string, submittedAt: Date, req: Request) {
  const mine = { _id: accountId, 'profile.kyc.submittedAt': submittedAt };
  try {
    const [pan, lic] = await Promise.all([openFile(ctx, panFileId, req), openFile(ctx, licenceFileId, req)]);
    const panRead = await readDocument('PAN', pan.bytes, pan.file.mime);
    const licText = await ocrText(lic.bytes, lic.file.mime);
    const values = { pan: panRead?.values.pan ?? null, name: panRead?.values.name ?? null, ...parseLicence(licText) };
    await Account.updateOne(mine, { $set: { 'profile.kyc.readStatus': 'DONE', 'profile.kyc.readAt': clock.now(), 'profile.kyc.readValuesEnc': encryptField(JSON.stringify(values)) } });
  } catch (e) {
    logger.warn({ accountId, reason: (e as Error).message }, 'KYC image reading failed: the reviewer compares by eye');
    await Account.updateOne(mine, { $set: { 'profile.kyc.readStatus': 'FAILED', 'profile.kyc.readAt': clock.now(), 'profile.kyc.readValuesEnc': null } }).catch(() => undefined);
  }
}
async function startKycReading(ctx: AuthContext, accountId: string, panFileId: string, licenceFileId: string, submittedAt: Date, req: Request) {
  const enabled = readerEnabled();
  await Account.updateOne({ _id: accountId }, { $set: { 'profile.kyc.readStatus': enabled ? 'PENDING' : 'OFF', 'profile.kyc.readAt': null, 'profile.kyc.readValuesEnc': null, 'profile.kyc.checklist': null } });
  if (enabled) setImmediate(() => { void readKycImages(ctx, accountId, panFileId, licenceFileId, submittedAt, req); });
}

const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
type Result = 'MATCH' | 'MISMATCH' | 'NOT_READ';
const compare = (typed: string | null, read: string | null): Result => (!read ? 'NOT_READ' : !typed ? 'MISMATCH' : norm(typed) === norm(read) ? 'MATCH' : 'MISMATCH');

/** The review screen's comparison: each typed value beside the value read from the image, with the result. */
function comparison(acc: AccountDoc) {
  const k = (acc.profile?.kyc ?? {}) as { panEnc?: string | null; nameOnPan?: string | null; readStatus?: string | null; readValuesEnc?: string | null; readAt?: Date | null };
  const read = k.readValuesEnc ? (JSON.parse(decryptField(k.readValuesEnc)) as { pan?: string | null; name?: string | null; licenceNumber?: string | null; validUntil?: string | null }) : {};
  const typedPan = k.panEnc ? decryptField(k.panEnc) : null;
  const lic = acc.profile?.professional;
  const until = lic?.licenceValidUntil ?? null;
  const readUntil = read.validUntil ?? null;
  return {
    readStatus: (k.readStatus ?? 'OFF') as 'OFF' | 'PENDING' | 'DONE' | 'FAILED', readAt: k.readAt ?? null,
    pan: { typed: typedPan, read: read.pan ?? null, result: compare(typedPan, read.pan ?? null) },
    nameOnPan: { typed: k.nameOnPan ?? null, read: read.name ?? null, result: compare(k.nameOnPan ?? null, read.name ?? null) },
    licenceNumber: { typed: lic?.licenceNumber ?? null, read: read.licenceNumber ?? null, result: compare(lic?.licenceNumber ?? null, read.licenceNumber ?? null) },
    licenceValidUntil: { typed: until, read: readUntil, result: (!readUntil ? 'NOT_READ' : until === readUntil ? 'MATCH' : 'MISMATCH') as Result, expired: (until ?? readUntil ?? '9999') < istToday() },
  };
}

// ── SkyUp review (STF, ADM) ──────────────────────────────────────────────────

/** Admin → Approvals → Advisor KYC: pending items, oldest first, against the CFG-125 target. */
export async function reviewQueue() {
  const accs = await Account.find({ 'profile.kycStatus': 'PENDING_REVIEW' }, { 'profile.kyc.submittedAt': 1 })
    .sort({ 'profile.kyc.submittedAt': 1 }).limit(200).lean<AccountDoc[]>();
  const advisors = await User.find({ accountId: { $in: accs.map((a) => a._id) }, role: 'ADV' }, { name: 1, accountId: 1, mobile: 1 }).lean();
  const byAcc = new Map(advisors.map((u) => [u.accountId, u]));
  const target = cfgNum('CFG-125');
  return {
    targetWorkingDays: target,
    items: accs.map((a) => {
      const submittedAt = a.profile?.kyc?.submittedAt ?? null;
      const waited = submittedAt ? workingDaysSince(submittedAt) : 0;
      const adv = byAcc.get(a._id);
      return { accountId: a._id, advisorName: adv?.name ?? null, mobile: adv ? `${adv.mobile.slice(0, 5)}XXXXX${adv.mobile.slice(-2)}` : null, submittedAt, workingDaysWaiting: waited, overdue: waited > target };
    }),
  };
}

/** One review item: documents next to the typed details (P-06 step 4). Full PAN is shown on this screen. */
export async function reviewItem(accountId: string, req: Request) {
  const acc = await Account.findById(accountId).lean<AccountDoc>();
  if (!acc) throw AppError.notFound();
  const adv = await User.findOne({ accountId, role: 'ADV' }, { name: 1 }).lean<{ name: string }>();
  const view = await advisorView(acc);
  await audit({ entity: 'kyc', entityId: accountId, action: 'KYC_REVIEW_OPENED' }, { req });
  return {
    ...view, accountId, advisorName: adv?.name ?? null,
    licence: { number: acc.profile?.professional?.licenceNumber ?? null, validUntil: acc.profile?.professional?.licenceValidUntil ?? null, type: acc.profile?.professional?.advisorType ?? null },
    dob: acc.profile?.personal?.dob ?? null,
    rejectReasons: REJECT_REASONS,
    comparison: comparison(acc), // change #48
    checklistItems: ['panReadable', 'nameMatches', 'licenceValid', 'photoClear'] as const,
  };
}

/**
 * Verify or Reject (P-06 step 4–5). Only a PENDING_REVIEW item at the version the reviewer saw can be
 * decided, so when two reviewers open the same item the second decision gets GEN-04.
 */
export async function decide(ctx: AuthContext, accountId: string, b: DecisionBody, req: Request) {
  if (b.decision === 'REJECT' && !b.reason) throw AppError.field('reason', 'GEN-01', { 'Field label': 'Reason' });
  if (b.decision === 'REJECT' && b.reason === 'Other' && !b.note) throw AppError.field('note', 'GEN-01', { 'Field label': 'Note' });

  const now = clock.now();
  const verified = b.decision === 'VERIFY';
  const out = await withTx(async (session) => {
    const u = await Account.findOneAndUpdate(
      { _id: accountId, 'profile.kycStatus': 'PENDING_REVIEW', 'profile.sectionVersions.kyc': b.version },
      {
        $set: {
          'profile.kycStatus': verified ? 'VERIFIED' : 'REJECTED', 'profile.kyc.decidedAt': now, 'profile.kyc.decidedBy': ctx.userId,
          'profile.kyc.rejectReason': verified ? null : b.reason, 'profile.kyc.rejectNote': verified ? null : (b.note ?? null),
          'profile.kyc.checklist': b.checklist ?? null,
        },
        $inc: { 'profile.sectionVersions.kyc': 1 },
      },
      { new: true, session: session ?? undefined },
    ).lean<AccountDoc>();
    if (!u) {
      const cur = await Account.findById(accountId, { 'profile.kycStatus': 1 }).lean<AccountDoc>();
      if (!cur) throw AppError.notFound();
      if (cur.profile?.kycStatus !== 'PENDING_REVIEW') throw AppError.invalidState('KYC', String(cur.profile?.kycStatus).replace(/_/g, ' ')); // GEN-04
      throw AppError.versionConflict('KYC', null);
    }
    const adv = await User.findOne({ accountId, role: 'ADV' }, { _id: 1, name: 1 }).lean<{ _id: string; name: string }>();
    if (adv) {
      await refreshCompletion(accountId, adv._id, u, adv.name, session);
      await notify({
        userId: adv._id, accountId, kind: verified ? 'KYC_VERIFIED' : 'KYC_REJECTED',
        messageId: verified ? 'PRF-05' : 'PRF-06', params: verified ? {} : { reason: reasonText(b.reason, b.note) },
        dedupeKey: `KYC|${accountId}|${u.profile?.sectionVersions?.kyc ?? 0}`, link: { type: 'PROFILE', id: accountId },
      }, session);
      // Email (P-06 step 5) goes through the communications outbox, built with P-39 to P-43.
    }
    if (verified) await useStepUp(req.stepUpId, 'KYC_VERIFIED', session); // the OTP is used once
    await audit({ entity: 'kyc', entityId: accountId, action: verified ? 'KYC_VERIFIED' : 'KYC_REJECTED',
      before: { status: 'PENDING_REVIEW' }, after: { status: verified ? 'VERIFIED' : 'REJECTED', reason: b.reason ?? null, note: b.note ?? null, checklist: b.checklist ?? null }, stepUpId: req.stepUpId }, { req, session });
    return u;
  });
  return { status: out.profile?.kycStatus, messageId: verified ? 'PRF-05' : 'PRF-06' };
}