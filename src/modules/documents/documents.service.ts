import type { Request } from 'express';
import type { PipelineStage } from 'mongoose';
import { z } from 'zod';
import { cfgList, cfgNum } from '../../config/cfg.js';
import { clock } from '../../lib/clock.js';
import { decryptField, encryptField, lookupHash } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import {
  aadhaar, date, dateOfBirth, enumOf, masks, optional, pan, personName, policyNumber, recordId, required, rupees, shortText,
} from '../../lib/fields.js';
import { msg, type MessageId } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { toField } from '../../middleware/validate.js';
import { audit } from '../audit/audit.service.js';
import { personalDataConsent } from '../customers/consent.service.js';
import { Customer, FamilyMember, GENDERS, type CustomerDoc } from '../customers/customer.model.js';
import { StoredFile, type FileDoc } from '../files/file.model.js';
import { assertOwnFile, open as openFile, view as fileView } from '../files/files.service.js';
import { Insurer } from '../insurers/insurer.model.js';
import { escapeRegex, pageMeta, pageSize } from '../../lib/pagination.js';
import { piiSearch } from '../../lib/pii.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { CustomerDocument, DocumentLabel, VEHICLE_TYPES, VERIFY_TYPES, type DocumentDoc, type LabelDoc } from './document.model.js';
import { readDocument, readerEnabled } from './reader.js';
import { logger } from '../../lib/logger.js';

export interface UploadBody { customerId?: string; personKey?: string; type?: string; name?: string | null; fileId: string; saveAsType?: boolean }

const isVerify = (t: string) => (VERIFY_TYPES as readonly string[]).includes(t);
const isIdentity = (t: string) => t === 'Aadhaar' || t === 'PAN';
const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const seriesKeyOf = (personKey: string, type: string, name?: string | null) => `${personKey}|${type}${type === 'Other' && name ? `|${nameKey(name)}` : ''}`;

async function loadCustomer(ctx: AuthContext, id: string) {
  const c = await Customer.findOne({ _id: id, accountId: ctx.accountId }).lean<CustomerDoc>();
  if (!c) throw AppError.notFound();
  return c;
}

/** The person must be this customer or one of their ACTIVE household members (P-18 step 2). */
async function resolvePerson(ctx: AuthContext, c: CustomerDoc, key: string): Promise<string> {
  if (key === `C:${c._id}`) return c.name;
  const m = /^F:(fam_[a-f0-9]{28})$/.exec(key);
  if (m) {
    const f = await FamilyMember.findOne({ _id: m[1], customerId: c._id, accountId: ctx.accountId, status: 'ACTIVE' }, { name: 1 }).lean<{ name: string }>();
    if (f) return f.name;
  }
  throw AppError.field('personKey', 'VAL-22');
}

/** P-17: identity documents and old policies need the customer's personal-data consent (CU-23 / CU-30). */
async function assertConsent(c: CustomerDoc) {
  const consent = await personalDataConsent(c.accountId, c._id);
  if (consent === 'WITHDRAWN') throw new AppError(409, 'CONSENT_REQUIRED', 'CU-30', { Customer: c.name });
  if (consent !== 'GIVEN') throw new AppError(409, 'CONSENT_REQUIRED', 'CU-23', { customer: c.name });
}

const decode = (enc: string | null | undefined) => (enc ? (JSON.parse(decryptField(enc)) as Record<string, unknown>) : null);

function versionView(d: DocumentDoc, file?: ReturnType<typeof fileView> | null) {
  return {
    id: d._id, customerId: d.customerId, personKey: d.personKey, type: d.type, name: d.name, version: d.version,
    label: d.label, originalName: d.originalName, status: d.status, rev: d.rev, uploadedAt: d.createdAt, uploadedBy: d.uploadedBy,
    confirmedAt: d.confirmedAt, file: file ?? null, vehicleId: d.vehicleId, slot: d.slot,
  };
}

// ── Upload (P-18 steps 1–4, 7) ────────────────────────────────────────────────

/**
 * Add a document version. Called by the Add document screen and (with vehicle fields) by P-54.
 * Verify types start UNCONFIRMED; nothing read from them is applied anywhere before Confirm (AC-P18-4).
 */
export async function upload(ctx: AuthContext, b: UploadBody, req: Request, vehicle?: { vehicleId: string; slot?: string | null; type: (typeof VEHICLE_TYPES)[number] }) {
  if (!b.customerId || !b.personKey || !(vehicle?.type ?? b.type)) throw new AppError(400, 'VALIDATION_FAILED', 'DOC-01'); // AC-P18-1
  const type = vehicle?.type ?? b.type!;
  if (!vehicle && (!cfgList('CFG-171').includes(type) || (VEHICLE_TYPES as readonly string[]).includes(type))) throw AppError.field('type', 'VAL-22');
  if (type === 'Other' && !b.name) throw AppError.field('name', 'DOC-02');

  const c = await loadCustomer(ctx, b.customerId);
  if (c.status !== 'ACTIVE') throw AppError.invalidState('customer', c.status);
  const person = await resolvePerson(ctx, c, b.personKey);
  if (isVerify(type)) await assertConsent(c);
  await assertOwnFile(ctx, b.fileId, 'CUSTOMER_DOCUMENT', 'fileId');
  const file = await StoredFile.findById(b.fileId).lean<FileDoc>();

  // GR-26: the document is saved first; reading runs afterwards in the background (startReading below).
  const reading = isVerify(type) && readerEnabled();

  // Change #25: an "Other" name is linked to the account's saved type (saved now when asked).
  const accountDocumentTypeId = !vehicle && type === 'Other' && b.name ? await (await import('./accountDocTypes.service.js')).resolve(ctx, b.name, !!b.saveAsType, req) : null;
  const seriesKey = vehicle ? `V:${vehicle.vehicleId}|${type}${vehicle.slot ? `|${vehicle.slot}` : ''}` : seriesKeyOf(b.personKey, type, b.name);
  for (let attempt = 0; ; attempt++) {
    const last = await CustomerDocument.findOne({ accountId: ctx.accountId, seriesKey }, { version: 1 }).sort({ version: -1 }).lean<{ version: number }>();
    const version = (last?.version ?? 0) + 1;
    try {
      const doc = await new CustomerDocument({
        accountId: ctx.accountId, customerId: c._id, personKey: b.personKey, type, name: type === 'Other' ? b.name : null, seriesKey, version, accountDocumentTypeId,
        fileId: b.fileId, originalName: file!.name, label: file!.name, labelKey: nameKey(file!.name),
        status: isVerify(type) ? 'UNCONFIRMED' : 'CONFIRMED', readStatus: reading ? 'PENDING' : 'OFF', readStartedAt: reading ? clock.now() : null,
        vehicleId: vehicle?.vehicleId ?? null, slot: vehicle?.slot ?? null, uploadedBy: ctx.userId,
      }).save();
      await audit({ entity: 'document', entityId: doc._id, action: 'DOCUMENT_UPLOADED', after: { customerId: c._id, type, version, person: b.personKey } }, { req });
      if (reading) startReading(ctx, doc._id, b.fileId, type, req);
      const d = doc.toObject() as DocumentDoc;
      return {
        document: versionView(d, fileView(file!)), personName: person,
        params: { 'Document type': type === 'Other' && b.name ? b.name : type, n: version },
        verify: !isVerify(type) ? null
          : reading ? { reading: true, values: {} } // the check screen asks again until the reading is done
          : { reading: false, values: {}, messageId: 'DOC-10' as MessageId, message: msg('DOC-10') },
      };
    } catch (e) {
      if (isDuplicateKey(e, 'one_version_number_per_series') && attempt < 4) continue; // a parallel upload took this number
      throw e;
    }
  }
}

// ── Background reading (P-18 step 5, GR-26) ───────────────────────────────────

/**
 * Read the document after it is saved. Never awaited by the upload. Writes only the read values and the read
 * status, and only while the document is still PENDING: it can never change a confirmed document, and a
 * failure or the CFG-38 time limit just means manual entry (DOC-10). Logs never contain the text read.
 */
export function startReading(ctx: AuthContext, documentId: string, fileId: string, type: string, req: Request) {
  const limit = cfgNum('CFG-38') * 60_000;
  void (async () => {
    try {
      const { file, bytes } = await openFile(ctx, fileId, req);
      const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('OCR time limit (CFG-38) reached')), limit).unref());
      const read = await Promise.race([readDocument(type, bytes, file.mime), timeout]);
      const values: Record<string, unknown> = { ...(read?.values ?? {}) };
      if (type === 'Old policy' && read?.text) { // the insurer: a catalogue name printed on the policy
        const text = read.text.toLowerCase();
        const hit = (await Insurer.find({ ownerAccountId: { $in: [null, ctx.accountId] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).find((i) => text.includes(i.name.toLowerCase()));
        if (hit) values.insurerId = hit._id;
      }
      await CustomerDocument.updateOne({ _id: documentId, readStatus: 'PENDING' }, { $set: { readStatus: 'DONE', readValuesEnc: encryptField(JSON.stringify(values)) } });
    } catch (e) {
      logger.warn({ documentId, type, reason: (e as Error).message }, 'Document reading failed: manual entry (DOC-10)');
      await CustomerDocument.updateOne({ _id: documentId, readStatus: 'PENDING' }, { $set: { readStatus: 'FAILED' } }).catch(() => undefined);
    }
  })();
}

/** A reading still PENDING after CFG-38 (for example the server restarted) counts as failed. */
function readState(d: Pick<DocumentDoc, 'readStatus' | 'readStartedAt'>): 'OFF' | 'PENDING' | 'DONE' | 'FAILED' {
  const s = (d.readStatus ?? 'OFF') as 'OFF' | 'PENDING' | 'DONE' | 'FAILED';
  if (s === 'PENDING' && d.readStartedAt && clock.now().getTime() - new Date(d.readStartedAt).getTime() > cfgNum('CFG-38') * 60_000) return 'FAILED';
  return s;
}

// ── Verify and Confirm (P-18 steps 5–6) ───────────────────────────────────────

const confirmSchemas: Record<string, z.ZodTypeAny> = {
  Aadhaar: z.object({ name: required(personName()), dob: optional(dateOfBirth()), gender: optional(enumOf(GENDERS)), aadhaar: required(aadhaar()) }).strict(),
  PAN: z.object({ name: required(personName()), fatherName: optional(personName()), dob: optional(dateOfBirth()), pan: required(pan()) }).strict(),
  'Old policy': z.object({
    insurerId: required(recordId('ins')), policyNumber: required(policyNumber()), productName: optional(shortText()),
    startDate: optional(date()), endDate: optional(date()), sumInsured: optional(rupees()), premium: optional(rupees()),
    insuredPeople: z.array(personName()).max(20).optional(), nominees: z.array(personName()).max(20).optional(),
  }).strict(),
};
const confirmLabels = {
  name: 'Name', dob: 'Date of birth', gender: 'Gender', aadhaar: 'Aadhaar number', fatherName: "Father's name", pan: 'PAN',
  insurerId: 'Insurer', policyNumber: 'Policy number', productName: 'Product name', startDate: 'Start date', endDate: 'End date',
  sumInsured: 'Sum insured', premium: 'Premium', insuredPeople: 'Insured people', nominees: 'Nominees',
};

/**
 * Confirm the checked values. Only an UNCONFIRMED version at the rev the user saw; a double click gets GEN-06.
 * Aadhaar/PAN of the customer are copied to the customer's encrypted fields when those are empty. When they
 * hold a DIFFERENT number the customer is not changed: the reply reports it, and the screen offers the P-15
 * identity change (the BPD has no message for this confirmation: OPEN-QUESTIONS Q32).
 */
export async function confirm(ctx: AuthContext, id: string, b: { rev: number; values: Record<string, unknown> }, req: Request) {
  const d = await CustomerDocument.findOne({ _id: id, accountId: ctx.accountId }).lean<DocumentDoc>();
  if (!d) throw AppError.notFound();
  if (!isVerify(d.type)) throw AppError.invalidState('document', 'CONFIRMED');
  if (d.status === 'CONFIRMED') throw new AppError(409, 'ALREADY_SUBMITTED', 'GEN-06');
  const parsed = confirmSchemas[d.type]!.safeParse(b.values ?? {});
  if (!parsed.success) throw AppError.fields(parsed.error.issues.map((i) => toField(i, confirmLabels)));
  const values = parsed.data as Record<string, unknown>;
  if (d.type === 'Old policy' && !(await Insurer.exists({ _id: values.insurerId, ownerAccountId: { $in: [null, ctx.accountId] } }))) throw AppError.field('insurerId', 'VAL-22');

  const c = await loadCustomer(ctx, d.customerId);
  await assertConsent(c);
  const now = clock.now();
  const out = await withTx(async (session) => {
    const u = await CustomerDocument.findOneAndUpdate(
      { _id: id, accountId: ctx.accountId, status: 'UNCONFIRMED', rev: b.rev },
      { $set: { status: 'CONFIRMED', confirmedValuesEnc: encryptField(JSON.stringify(values)), confirmedAt: now, confirmedBy: ctx.userId }, $inc: { rev: 1 } },
      { new: true, session: session ?? undefined },
    ).lean<DocumentDoc>();
    if (!u) {
      const cur = await CustomerDocument.findById(id, { status: 1 }).lean<{ status: string }>();
      if (cur?.status === 'CONFIRMED') throw new AppError(409, 'ALREADY_SUBMITTED', 'GEN-06');
      throw AppError.versionConflict('document', null);
    }
    let identity: { field: 'PAN' | 'AADHAAR'; copied: boolean; differs: boolean; current?: string | null; fromDocument?: string } | null = null;
    if (isIdentity(d.type) && d.personKey === `C:${c._id}`) {
      const cust = await Customer.findById(c._id).select('+identity.panEnc +identity.aadhaarEnc').session(session).lean<CustomerDoc>();
      const isPan = d.type === 'PAN';
      const value = String(isPan ? values.pan : values.aadhaar);
      const existing = isPan ? cust?.identity?.panEnc : cust?.identity?.aadhaarEnc;
      const mask = isPan ? masks.pan(value) : masks.aadhaar(value);
      if (!existing) {
        const set = isPan
          ? { 'identity.panEnc': encryptField(value), 'identity.panHash': lookupHash(value), 'identity.panMasked': mask }
          : { 'identity.aadhaarEnc': encryptField(value), 'identity.aadhaarHash': lookupHash(value), 'identity.aadhaarMasked': mask };
        await Customer.updateOne({ _id: c._id, accountId: ctx.accountId }, { $set: set, $inc: { version: 1 } }, { session: session ?? undefined });
        await audit({ entity: 'customer', entityId: c._id, entityRef: c.number, action: 'IDENTITY_UPDATED', after: { [isPan ? 'panMasked' : 'aadhaarMasked']: mask, source: `document ${id}` } }, { req, session });
        identity = { field: isPan ? 'PAN' : 'AADHAAR', copied: true, differs: false };
      } else {
        const same = decryptField(existing) === value;
        identity = { field: isPan ? 'PAN' : 'AADHAAR', copied: false, differs: !same, ...(same ? {} : { current: (isPan ? cust?.identity?.panMasked : cust?.identity?.aadhaarMasked) ?? null, fromDocument: mask }) };
      }
    }
    await audit({ entity: 'document', entityId: id, action: 'DOCUMENT_CONFIRMED', after: { type: d.type, version: d.version } }, { req, session });
    return { u, identity };
  });
  return {
    document: versionView(out.u), identity: out.identity,
    // A confirmed old policy offers "Record as existing policy" (P-34, a later module) with these values.
    existingPolicyPrefill: d.type === 'Old policy' ? values : null,
  };
}

// ── Labels (P-18 step 8) ──────────────────────────────────────────────────────

export async function changeLabel(ctx: AuthContext, id: string, b: { rev: number; label: string }, req: Request) {
  const d = await CustomerDocument.findOne({ _id: id, accountId: ctx.accountId }).lean<DocumentDoc>();
  if (!d) throw AppError.notFound();
  const key = nameKey(b.label);
  if (await CustomerDocument.exists({ accountId: ctx.accountId, customerId: d.customerId, labelKey: key, _id: { $ne: id } })) throw AppError.field('label', 'DOC-06');
  const u = await withTx(async (session) => {
    const r = await CustomerDocument.findOneAndUpdate({ _id: id, accountId: ctx.accountId, rev: b.rev }, { $set: { label: b.label, labelKey: key }, $inc: { rev: 1 } }, { new: true, session: session ?? undefined }).lean<DocumentDoc>();
    if (!r) throw AppError.versionConflict('document', null);
    await new DocumentLabel({ accountId: ctx.accountId, documentId: id, from: d.label, to: b.label, by: ctx.userId }).save({ session: session ?? undefined });
    await audit({ entity: 'document', entityId: id, action: 'DOCUMENT_LABEL_CHANGED', before: { label: d.label }, after: { label: b.label } }, { req, session });
    return r;
  });
  return versionView(u);
}

// ── Read ───────────────────────────────────────────────────────────────────────

/** One version with its read/confirmed values (for the verify screen) and its label history. */
export async function getDocument(ctx: AuthContext, id: string) {
  const d = await CustomerDocument.findOne({ _id: id, accountId: ctx.accountId }).select('+readValuesEnc +confirmedValuesEnc').lean<DocumentDoc & { readValuesEnc?: string; confirmedValuesEnc?: string }>();
  if (!d) throw AppError.notFound();
  const [file, labels] = await Promise.all([
    StoredFile.findById(d.fileId).lean<FileDoc>(),
    DocumentLabel.find({ documentId: id }).sort({ createdAt: 1 }).lean<LabelDoc[]>(),
  ]);
  return {
    ...versionView(d, file ? fileView(file) : null),
    readValues: decode(d.readValuesEnc), confirmedValues: decode(d.confirmedValuesEnc),
    history: [{ event: 'UPLOADED', name: d.originalName, by: d.uploadedBy, at: d.createdAt }, ...labels.map((l) => ({ event: 'LABEL_CHANGED', from: l.from, to: l.to, by: l.by, at: l.createdAt }))],
    readStatus: readState(d),
    ...(d.status === 'UNCONFIRMED' && readState(d) !== 'PENDING'
      ? (() => {
          const found = Object.keys(decode(d.readValuesEnc) ?? {}).length > 0;
          return { messageId: found ? 'DOC-04' : 'DOC-10', message: msg(found ? 'DOC-04' : 'DOC-10') };
        })()
      : {}),
  };
}

/**
 * Customers → a customer → Documents: what is on file by person and type, every version (newest first),
 * and the Missing box (DOC-08): Aadhaar and PAN of the customer when no confirmed version exists.
 */
export async function listForCustomer(ctx: AuthContext, customerId: string) {
  const c = await loadCustomer(ctx, customerId);
  const docs = await CustomerDocument.find({ accountId: ctx.accountId, customerId, vehicleId: null }).sort({ seriesKey: 1, version: -1 }).lean<DocumentDoc[]>();
  const [files, members] = await Promise.all([
    StoredFile.find({ _id: { $in: docs.map((d) => d.fileId) } }).lean<FileDoc[]>(),
    FamilyMember.find({ customerId, accountId: ctx.accountId }, { name: 1 }).lean<Array<{ _id: string; name: string }>>(),
  ]);
  const fil = new Map(files.map((f) => [f._id, fileView(f)]));
  const names = new Map<string, string>([[`C:${c._id}`, c.name], ...members.map((m) => [`F:${m._id}`, m.name] as [string, string])]);
  const groups = new Map<string, { personKey: string; personName: string; type: string; name: string | null; versions: ReturnType<typeof versionView>[] }>();
  for (const d of docs) {
    if (!groups.has(d.seriesKey)) groups.set(d.seriesKey, { personKey: d.personKey, personName: names.get(d.personKey) ?? '', type: d.type, name: d.name ?? null, versions: [] });
    groups.get(d.seriesKey)!.versions.push(versionView(d, fil.get(d.fileId)));
  }
  const own = docs.filter((d) => d.personKey === `C:${c._id}`);
  const missing = (['Aadhaar', 'PAN'] as const).flatMap((t) => {
    const of = own.filter((d) => d.type === t);
    if (of.some((d) => d.status === 'CONFIRMED')) return [];
    return [of.length ? `${t} (waiting to be checked)` : t]; // closed during verify: stays UNCONFIRMED
  });
  return {
    groups: [...groups.values()],
    missing: missing.length ? { items: missing, messageId: 'DOC-08', message: msg('DOC-08', { customer: c.name, list: missing.join(', ') }) } : null,
    aadhaarReminder: { messageId: 'CU-17', message: msg('CU-17') }, // shown above an Aadhaar upload
  };
}

/**
 * B-03 · GET /documents: the account-wide library. One row per document SERIES (the newest version), with its customer and
 * person. Filters: customerId, type, status (of the newest version), search (label, type, file name, customer number or name).
 * Vehicle files (RC, photos) belong to the vehicle screen and are not listed here.
 */
export async function listAll(ctx: AuthContext, q: { page: number; limit?: number; customerId?: string | null; type?: string; status?: 'UNCONFIRMED' | 'CONFIRMED'; search?: string }) {
  const match: Record<string, unknown> = { accountId: ctx.accountId, vehicleId: null };
  if (q.customerId) match.customerId = q.customerId;
  if (q.type) match.type = q.type;
  if (q.search) {
    const re = new RegExp(escapeRegex(q.search), 'i');
    const customers = await Customer.find({ accountId: ctx.accountId, $or: [{ number: re }, ...piiSearch(q.search, { name: true, mobile: 4, email: true })] }, { _id: 1 }).limit(200).lean<Array<{ _id: string }>>();
    match.$or = [{ label: re }, { type: re }, { originalName: re }, { name: re }, ...(customers.length ? [{ customerId: { $in: customers.map((c) => c._id) } }] : [])];
  }
  const limit = pageSize(q.limit);
  const newest: PipelineStage[] = [
    { $match: match },
    { $sort: { seriesKey: 1, version: -1 } },
    { $group: { _id: '$seriesKey', doc: { $first: '$$ROOT' }, versions: { $sum: 1 } } },
    ...(q.status ? [{ $match: { 'doc.status': q.status } }] : []),
  ];
  const [rows, count] = await Promise.all([
    CustomerDocument.aggregate<{ doc: DocumentDoc; versions: number }>([...newest, { $sort: { 'doc.createdAt': -1, 'doc._id': -1 } }, { $skip: (q.page - 1) * limit }, { $limit: limit }]),
    CustomerDocument.aggregate<{ n: number }>([...newest, { $count: 'n' }]),
  ]);
  const customerIds = [...new Set(rows.map((r) => r.doc.customerId))];
  const [customers, members, files] = await Promise.all([
    Customer.find({ _id: { $in: customerIds }, accountId: ctx.accountId }).lean<CustomerDoc[]>(),
    FamilyMember.find({ customerId: { $in: customerIds }, accountId: ctx.accountId }, { name: 1 }).lean<Array<{ _id: string; name: string }>>(),
    StoredFile.find({ _id: { $in: rows.map((r) => r.doc.fileId) } }).lean<FileDoc[]>(),
  ]);
  const cus = new Map(customers.map((c) => [c._id, c]));
  const fam = new Map(members.map((m) => [`F:${m._id}`, m.name]));
  const fil = new Map(files.map((f) => [f._id, fileView(f)]));
  const items = rows.map(({ doc, versions }) => {
    const c = cus.get(doc.customerId);
    const personName = doc.personKey.startsWith('C:') ? c?.name ?? '' : fam.get(doc.personKey) ?? '';
    return { ...versionView(doc, fil.get(doc.fileId)), versions, personName, customer: c ? { id: c._id, number: c.number, name: c.name } : null };
  });
  return { items, meta: pageMeta(q.page, limit, count[0]?.n ?? 0) };
}