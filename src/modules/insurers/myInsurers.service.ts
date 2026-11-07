import type { Request } from 'express';
import { clock, istDate, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg, type MessageId } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { StoredFile, type FileDoc } from '../files/file.model.js';
import { assertOwnFile, view as fileView } from '../files/files.service.js';
import { refreshCompletionFor } from '../profile/profile.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { Insurer, type InsurerDoc } from './insurer.model.js';
import { InsurerMapping, MAPPING_UNIQUE_INDEX, type MappingDoc } from './mapping.model.js';
import { raiseFlag } from './agentCodeFlags.service.js';

export interface AddBody { insurerId: string; agentCode: string; validUntil?: string | null; appointmentLetterFileId?: string | null; declaration: true }
export interface EditBody { version: number; agentCode?: string; validUntil?: string | null; appointmentLetterFileId?: string | null }

const insurerView = (i: InsurerDoc | undefined) => (i ? { id: i._id, name: i.name, shortCode: i.shortCode, category: i.category, status: i.status } : null);

/**
 * Whether NEW quotations may be created for an insurer (P-07 failure and recovery; used by P-27).
 * Existing quotations and policies are never affected by any of these.
 */
export async function quoteReadiness(accountId: string, insurerId: string, today = istToday()) {
  const [insurer, m] = await Promise.all([
    Insurer.findById(insurerId).lean<InsurerDoc>(),
    InsurerMapping.findOne({ accountId, insurerId }).lean<MappingDoc>(),
  ]);
  const name = insurer?.name ?? '';
  const no = (reason: string, messageId: MessageId | null = null, message: string | null = null) => ({ ok: false as const, reason, messageId, message });
  if (!insurer || insurer.status !== 'ACTIVE') return no('INSURER_INACTIVE', 'PRF-10', msg('PRF-10', { Insurer: name }));
  if (!m) return no('NOT_MAPPED');
  if (m.status !== 'ACTIVE') return no('MAPPING_INACTIVE');
  if (m.validUntil && m.validUntil < today) return no('CODE_EXPIRED', 'PRF-11', msg('PRF-11', { insurer: name, date: istDate(m.validUntil) }));
  return { ok: true as const, agentCode: m.agentCode }; // copied into each quotation and policy snapshot
}

async function views(rows: MappingDoc[]) {
  const [insurers, files] = await Promise.all([
    Insurer.find({ _id: { $in: rows.map((r) => r.insurerId) } }).lean<InsurerDoc[]>(),
    StoredFile.find({ _id: { $in: rows.map((r) => r.appointmentLetterFileId).filter(Boolean) } }).lean<FileDoc[]>(),
  ]);
  const ins = new Map(insurers.map((i) => [i._id, i]));
  const fil = new Map(files.map((f) => [f._id, fileView(f)]));
  const today = istToday();
  return rows.map((m) => {
    const i = ins.get(m.insurerId);
    const warnings: Array<{ messageId: MessageId; message: string }> = [];
    if (i && i.status !== 'ACTIVE') warnings.push({ messageId: 'PRF-10', message: msg('PRF-10', { Insurer: i.name }) });
    if (m.validUntil && m.validUntil < today) warnings.push({ messageId: 'PRF-11', message: msg('PRF-11', { insurer: i?.name ?? '', date: istDate(m.validUntil) }) });
    return {
      id: m._id, insurer: insurerView(i), agentCode: m.agentCode, validUntil: m.validUntil, status: m.status, version: m.version,
      appointmentLetter: m.appointmentLetterFileId ? fil.get(m.appointmentLetterFileId) ?? null : null, warnings,
    };
  });
}

export async function listMine(ctx: AuthContext) {
  const rows = await InsurerMapping.find({ accountId: ctx.accountId }).sort({ createdAt: 1 }).lean<MappingDoc[]>();
  return views(rows);
}

/** The Add insurer picker: ACTIVE insurers this account has not added yet (P-07 step 2). */
export async function available(ctx: AuthContext, q?: string) {
  const taken = await InsurerMapping.distinct('insurerId', { accountId: ctx.accountId });
  const filter: Record<string, unknown> = { status: 'ACTIVE', _id: { $nin: taken }, ownerAccountId: { $in: [null, ctx.accountId] } }; // + private (change #3)
  if (q) filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  const list = await Insurer.find(filter).sort({ name: 1 }).limit(100).lean<InsurerDoc[]>();
  return list.map(insurerView);
}

async function load(ctx: AuthContext, id: string) {
  const m = await InsurerMapping.findOne({ _id: id, accountId: ctx.accountId }).lean<MappingDoc>();
  if (!m) throw AppError.notFound();
  return m;
}

/** DEC-09 [TO CONFIRM]: the same insurer and agent code in another account flags both, silently. */
async function flagSharedCode(m: Pick<MappingDoc, '_id' | 'accountId' | 'insurerId' | 'agentCode'>, req: Request) {
  const others = await InsurerMapping.find({ insurerId: m.insurerId, agentCode: m.agentCode, accountId: { $ne: m.accountId } }, { _id: 1 }).lean();
  if (!others.length) return;
  const ids = [m._id, ...others.map((o) => o._id)];
  await InsurerMapping.updateMany({ _id: { $in: ids }, flaggedAt: null }, { $set: { flaggedAt: clock.now() } });
  const accounts = (await InsurerMapping.find({ _id: { $in: ids } }, { accountId: 1 }).lean<Array<{ accountId: string }>>()).map((x) => x.accountId);
  const flag = await raiseFlag(m.insurerId, m.agentCode, accounts); // change #55: one review item per code
  await audit({ entity: 'insurerMapping', entityId: m._id, action: 'AGENT_CODE_SHARED_FLAGGED', after: { insurerId: m.insurerId, mappings: ids, flagId: flag._id } }, { req });
}

export async function add(ctx: AuthContext, b: AddBody, req: Request) {
  const insurer = await Insurer.findOne({ _id: b.insurerId, status: 'ACTIVE', ownerAccountId: { $in: [null, ctx.accountId] } }).lean<InsurerDoc>();
  if (!insurer) throw AppError.field('insurerId', 'VAL-22'); // FLD-20: must exist and be ACTIVE (AC-P07-3)
  const dup = () => new AppError(409, 'DUPLICATE', 'PRF-09', { insurer: insurer.name });
  if (await InsurerMapping.exists({ accountId: ctx.accountId, insurerId: insurer._id })) throw dup();
  if (b.appointmentLetterFileId) await assertOwnFile(ctx, b.appointmentLetterFileId, 'APPOINTMENT_LETTER', 'appointmentLetterFileId');

  const created = await withTx(async (session) => {
    let m;
    try {
      [m] = await InsurerMapping.create([{
        accountId: ctx.accountId, insurerId: insurer._id, agentCode: b.agentCode, validUntil: b.validUntil ?? null,
        appointmentLetterFileId: b.appointmentLetterFileId ?? null, declaredAt: clock.now(), createdBy: ctx.userId,
      }], { session: session ?? undefined });
    } catch (e) {
      if (isDuplicateKey(e, MAPPING_UNIQUE_INDEX)) throw dup(); // two tabs: the database keeps one
      throw e;
    }
    await refreshCompletionFor(ctx.accountId!, session);
    await audit({ entity: 'insurerMapping', entityId: m!._id, action: 'INSURER_MAPPING_ADDED', after: { insurerId: insurer._id, agentCode: b.agentCode, validUntil: b.validUntil ?? null } }, { req, session });
    return m!.toObject() as MappingDoc;
  });
  await flagSharedCode(created, req);
  return { view: (await views([created]))[0]!, params: { Insurer: insurer.name, code: created.agentCode } };
}

/** Edit code, validity or appointment letter (P-07 step 4). Audited with before and after. */
export async function edit(ctx: AuthContext, id: string, b: EditBody, req: Request) {
  const m = await load(ctx, id);
  if (b.appointmentLetterFileId) await assertOwnFile(ctx, b.appointmentLetterFileId, 'APPOINTMENT_LETTER', 'appointmentLetterFileId');
  const set: Record<string, unknown> = {};
  for (const k of ['agentCode', 'validUntil', 'appointmentLetterFileId'] as const) if (b[k] !== undefined) set[k] = b[k];
  const u = await InsurerMapping.findOneAndUpdate({ _id: m._id, accountId: ctx.accountId, version: b.version }, { $set: set, $inc: { version: 1 } }, { new: true }).lean<MappingDoc>();
  if (!u) throw AppError.versionConflict('insurer', (await views([await load(ctx, id)]))[0]);
  await audit({ entity: 'insurerMapping', entityId: m._id, action: 'INSURER_MAPPING_EDITED',
    before: { agentCode: m.agentCode, validUntil: m.validUntil, appointmentLetterFileId: m.appointmentLetterFileId },
    after: { agentCode: u.agentCode, validUntil: u.validUntil, appointmentLetterFileId: u.appointmentLetterFileId } }, { req });
  if (u.agentCode !== m.agentCode) await flagSharedCode(u, req);
  return (await views([u]))[0]!;
}

/** Deactivate asks PRF-12 first (P-07 step 4); existing quotations and policies are untouched. */
export async function deactivate(ctx: AuthContext, id: string, b: { version: number; confirm: string[] }, req: Request) {
  const m = await load(ctx, id);
  if (m.status !== 'ACTIVE') throw AppError.invalidState('insurer', m.status);
  const name = (await Insurer.findById(m.insurerId, { name: 1 }).lean<{ name: string }>())?.name ?? '';
  if (!b.confirm.includes('PRF-12')) {
    throw new AppError(409, 'CONFIRMATION_REQUIRED', 'PRF-12', { insurer: name }, { warnings: [{ messageId: 'PRF-12', message: msg('PRF-12', { insurer: name }) }] });
  }
  return setStatus(ctx, m, b.version, 'INACTIVE', req);
}

export async function activate(ctx: AuthContext, id: string, b: { version: number }, req: Request) {
  const m = await load(ctx, id);
  if (m.status !== 'INACTIVE') throw AppError.invalidState('insurer', m.status);
  const insurer = await Insurer.findById(m.insurerId, { name: 1, status: 1 }).lean<{ name: string; status: string }>();
  if (insurer?.status !== 'ACTIVE') throw new AppError(409, 'INVALID_STATE', 'PRF-10', { Insurer: insurer?.name ?? '' });
  return setStatus(ctx, m, b.version, 'ACTIVE', req);
}

async function setStatus(ctx: AuthContext, m: MappingDoc, version: number, status: 'ACTIVE' | 'INACTIVE', req: Request) {
  const u = await withTx(async (session) => {
    const r = await InsurerMapping.findOneAndUpdate({ _id: m._id, accountId: ctx.accountId, version }, { $set: { status }, $inc: { version: 1 } }, { new: true, session: session ?? undefined }).lean<MappingDoc>();
    if (!r) throw AppError.versionConflict('insurer', null);
    await refreshCompletionFor(ctx.accountId!, session);
    await audit({ entity: 'insurerMapping', entityId: m._id, action: status === 'ACTIVE' ? 'INSURER_MAPPING_ACTIVATED' : 'INSURER_MAPPING_DEACTIVATED', before: { status: m.status }, after: { status } }, { req, session });
    return r;
  });
  return (await views([u]))[0]!;
}