import type { Request } from 'express';
import { cfgList, cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import { Customer, type CustomerDoc } from '../customers/customer.model.js';
import { CustomerDocument, type DocumentDoc } from '../documents/document.model.js';
import { StoredFile, type FileDoc } from '../files/file.model.js';
import { assertOwnFile, view as fileView } from '../files/files.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { FUELS, VEHICLE_TYPES, Vehicle, VEHICLE_REG_INDEX, type VehicleDoc } from './vehicle.model.js';

export interface CreateBody {
  registration: string; vehicleType: string; make: string; model: string; year: number; fuel: string;
  rcFileId: string; photos: Array<{ slot: string; fileId: string }>;
}

async function loadCustomer(ctx: AuthContext, id: string) {
  const c = await Customer.findOne({ _id: id, accountId: ctx.accountId }).lean<CustomerDoc>();
  if (!c) throw AppError.notFound();
  return c;
}
async function loadVehicle(ctx: AuthContext, id: string) {
  const v = await Vehicle.findOne({ _id: id, accountId: ctx.accountId }).lean<VehicleDoc>();
  if (!v) throw AppError.notFound();
  return v;
}

const seriesKey = (vehicleId: string, type: 'Vehicle RC' | 'Vehicle photo', slot?: string) => `V:${vehicleId}|${type}${slot ? `|${slot}` : ''}`;

/** One document row for the vehicle (RC or a slot photo), at the next version of its series. */
async function addVersion(ctx: AuthContext, v: Pick<VehicleDoc, '_id' | 'customerId'>, type: 'Vehicle RC' | 'Vehicle photo', fileId: string, slot: string | null, session: Parameters<typeof withTx>[0] extends (s: infer S) => unknown ? S : never) {
  const file = await StoredFile.findById(fileId).session(session).lean<FileDoc>();
  const key = seriesKey(v._id, type, slot ?? undefined);
  const last = await CustomerDocument.findOne({ accountId: ctx.accountId, seriesKey: key }, { version: 1 }).sort({ version: -1 }).session(session).lean<{ version: number }>();
  const [d] = await CustomerDocument.create([{
    accountId: ctx.accountId, customerId: v.customerId, personKey: `C:${v.customerId}`, type, seriesKey: key, version: (last?.version ?? 0) + 1,
    fileId, originalName: file!.name, label: file!.name, labelKey: file!.name.toLowerCase(), status: 'CONFIRMED',
    vehicleId: v._id, slot, uploadedBy: ctx.userId,
  }], { session: session ?? undefined });
  return d!.toObject() as DocumentDoc;
}

/**
 * + Vehicle (P-54 steps 1–3). Everything is saved together or not at all: the vehicle, its RC and at least
 * CFG-154 photos (one per CFG-155 slot). A vehicle can never exist with too few photos (AC-P54-1), and closing
 * the form midway saves nothing.
 */
export async function create(ctx: AuthContext, customerId: string, b: CreateBody, req: Request) {
  const c = await loadCustomer(ctx, customerId);
  if (c.status !== 'ACTIVE') throw AppError.invalidState('customer', c.status);
  const max = cfgNum('CFG-156');
  if ((await Vehicle.countDocuments({ accountId: ctx.accountId, customerId, status: 'ACTIVE' })) >= max) {
    throw new AppError(409, 'LIMIT_REACHED', 'VEH-04', { 'CFG-156': max });
  }
  const min = cfgNum('CFG-154');
  const slots = cfgList('CFG-155');
  if (b.photos.some((p) => !slots.includes(p.slot))) throw AppError.field('photos', 'VAL-22');
  if (new Set(b.photos.map((p) => p.slot)).size !== b.photos.length) throw AppError.field('photos', 'VAL-22'); // one per slot
  if (b.photos.length < min) throw AppError.field('photos', 'VEH-02', { 'CFG-154': min });
  await assertOwnFile(ctx, b.rcFileId, 'CUSTOMER_DOCUMENT', 'rcFileId');
  for (const p of b.photos) await assertOwnFile(ctx, p.fileId, 'CUSTOMER_DOCUMENT', 'photos');

  const dup = () => new AppError(409, 'DUPLICATE', 'VEH-03', { registration: b.registration, customer: c.name });
  const existing = await Vehicle.findOne({ accountId: ctx.accountId, registration: b.registration, status: 'ACTIVE' }, { customerId: 1 }).lean<{ customerId: string }>();
  if (existing) {
    const owner = existing.customerId === c._id ? c : await Customer.findById(existing.customerId, { name: 1 }).lean<{ name: string }>();
    throw new AppError(409, 'DUPLICATE', 'VEH-03', { registration: b.registration, customer: owner?.name ?? '' }); // AC-P54-3
  }

  const v = await withTx(async (session) => {
    let created;
    try {
      [created] = await Vehicle.create([{
        accountId: ctx.accountId, customerId, registration: b.registration, vehicleType: b.vehicleType, make: b.make, model: b.model,
        year: b.year, fuel: b.fuel, createdBy: ctx.userId,
      }], { session: session ?? undefined });
    } catch (e) {
      if (isDuplicateKey(e, VEHICLE_REG_INDEX)) throw dup(); // two tabs saving the same registration
      throw e;
    }
    const vd = created!.toObject() as VehicleDoc;
    await addVersion(ctx, vd, 'Vehicle RC', b.rcFileId, null, session);
    for (const p of b.photos) await addVersion(ctx, vd, 'Vehicle photo', p.fileId, p.slot, session);
    await audit({ entity: 'vehicle', entityId: vd._id, action: 'VEHICLE_ADDED', after: { customerId, registration: b.registration, photos: b.photos.map((p) => p.slot) } }, { req, session });
    return vd;
  });
  return { vehicle: await detail(ctx, v._id), params: { registration: v.registration, customer: c.name } };
}

/** A newer RC or slot photo adds a version; older ones stay (P-54 step 4). */
export async function addFile(ctx: AuthContext, id: string, b: { kind: 'RC' | 'PHOTO'; slot?: string | null; fileId: string }, req: Request) {
  const v = await loadVehicle(ctx, id);
  if (b.kind === 'PHOTO' && (!b.slot || !cfgList('CFG-155').includes(b.slot))) throw AppError.field('slot', 'VAL-22');
  await assertOwnFile(ctx, b.fileId, 'CUSTOMER_DOCUMENT', 'fileId');
  const type = b.kind === 'RC' ? 'Vehicle RC' : 'Vehicle photo';
  for (let attempt = 0; ; attempt++) {
    try {
      const d = await withTx(async (session) => {
        const row = await addVersion(ctx, v, type, b.fileId, b.kind === 'PHOTO' ? b.slot! : null, session);
        await audit({ entity: 'vehicle', entityId: v._id, action: b.kind === 'RC' ? 'VEHICLE_RC_VERSION_ADDED' : 'VEHICLE_PHOTO_VERSION_ADDED', after: { slot: b.slot ?? null, version: row.version } }, { req, session });
        return row;
      });
      return { vehicle: await detail(ctx, id), params: { 'Document type': b.kind === 'RC' ? 'Vehicle RC' : `${b.slot} photo`, n: d.version } };
    } catch (e) {
      if (isDuplicateKey(e, 'one_version_number_per_series') && attempt < 4) continue;
      throw e;
    }
  }
}

/** Mark as sold (INACTIVE) or active again. Reversible (§4: ACTIVE ↔ INACTIVE); documents are kept (AC-P54-4). */
export async function setStatus(ctx: AuthContext, id: string, b: { version: number; status: 'ACTIVE' | 'INACTIVE' }, req: Request) {
  const v = await loadVehicle(ctx, id);
  if (v.status === b.status) throw AppError.invalidState('vehicle', v.status);
  if (b.status === 'ACTIVE') {
    const max = cfgNum('CFG-156');
    if ((await Vehicle.countDocuments({ accountId: ctx.accountId, customerId: v.customerId, status: 'ACTIVE' })) >= max) throw new AppError(409, 'LIMIT_REACHED', 'VEH-04', { 'CFG-156': max });
  }
  try {
    const u = await Vehicle.findOneAndUpdate({ _id: id, accountId: ctx.accountId, version: b.version }, { $set: { status: b.status }, $inc: { version: 1 } }, { new: true }).lean<VehicleDoc>();
    if (!u) throw AppError.versionConflict('vehicle', await detail(ctx, id));
  } catch (e) {
    if (isDuplicateKey(e, VEHICLE_REG_INDEX)) { // reactivating while the registration is ACTIVE elsewhere
      const other = await Vehicle.findOne({ accountId: ctx.accountId, registration: v.registration, status: 'ACTIVE' }, { customerId: 1 }).lean<{ customerId: string }>();
      const owner = other ? await Customer.findById(other.customerId, { name: 1 }).lean<{ name: string }>() : null;
      throw new AppError(409, 'DUPLICATE', 'VEH-03', { registration: v.registration, customer: owner?.name ?? '' });
    }
    throw e;
  }
  await audit({ entity: 'vehicle', entityId: id, action: b.status === 'INACTIVE' ? 'VEHICLE_MARKED_SOLD' : 'VEHICLE_REACTIVATED', before: { status: v.status }, after: { status: b.status } }, { req });
  return detail(ctx, id);
}

/** The vehicle with its RC and every photo version, newest first per slot. */
export async function detail(ctx: AuthContext, id: string) {
  const v = await loadVehicle(ctx, id);
  const docs = await CustomerDocument.find({ accountId: ctx.accountId, vehicleId: id }).sort({ version: -1 }).lean<DocumentDoc[]>();
  const files = new Map((await StoredFile.find({ _id: { $in: docs.map((d) => d.fileId) } }).lean<FileDoc[]>()).map((f) => [f._id, fileView(f)]));
  const ver = (d: DocumentDoc) => ({ documentId: d._id, version: d.version, uploadedAt: d.createdAt, file: files.get(d.fileId) ?? null });
  const slots = cfgList('CFG-155');
  return {
    id: v._id, customerId: v.customerId, registration: v.registration, vehicleType: v.vehicleType, make: v.make, model: v.model,
    year: v.year, fuel: v.fuel, status: v.status, version: v.version, createdAt: v.createdAt,
    rc: docs.filter((d) => d.type === 'Vehicle RC').map(ver),
    photos: slots.map((slot) => ({ slot, versions: docs.filter((d) => d.type === 'Vehicle photo' && d.slot === slot).map(ver) })),
  };
}

export async function listForCustomer(ctx: AuthContext, customerId: string) {
  await loadCustomer(ctx, customerId);
  const list = await Vehicle.find({ accountId: ctx.accountId, customerId }).sort({ status: 1, createdAt: -1 }).lean<VehicleDoc[]>();
  return {
    vehicles: await Promise.all(list.map((v) => detail(ctx, v._id))),
    rules: { minPhotos: cfgNum('CFG-154'), slots: cfgList('CFG-155'), maxVehicles: cfgNum('CFG-156'), earliestYear: cfgNum('CFG-181'), vehicleTypes: VEHICLE_TYPES, fuels: FUELS },
    tooFewPhotosMessage: msg('VEH-02', { 'CFG-154': cfgNum('CFG-154') }),
  };
}

/** For a Motor quotation (P-27): the customer's ACTIVE vehicles. */
export async function activeVehicles(accountId: string, customerId: string) {
  return Vehicle.find({ accountId, customerId, status: 'ACTIVE' }).sort({ createdAt: 1 }).lean<VehicleDoc[]>();
}