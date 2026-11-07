/**
 * Module 6 Stage 3 — P-54 Manage a client's vehicles. Test names cite the BPD acceptance checks.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, as, err, login, newMobile, registerAdvisor, resetState, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { CustomerDocument } from '../src/modules/documents/document.model.js';
import { Vehicle } from '../src/modules/vehicles/vehicle.model.js';
import { ConfigValue, loadConfigOverrides } from '../src/config/cfg.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fieldIds = (res: request.Response) => Object.fromEntries((res.body.error?.fields ?? []).map((f: { field: string; messageId: string }) => [f.field, f.messageId]));

async function setup() {
  const adv = await registerAdvisor('Asha Rao');
  const c = as(adv.token);
  const customer = async (name = 'Meena Iyer') => (await c.post('/customers', { name, mobile: newMobile() })).body.data as { id: string; name: string };
  const cus = await customer();
  const file = async (token = adv.token) =>
    (await request(app).post('/v1/files?purpose=CUSTOMER_DOCUMENT').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').set('X-File-Name', 'photo.png').send(PNG)).body.data.id as string;
  const photos = async (n: number, token = adv.token) => {
    const slots = ['Front', 'Rear', 'Left', 'Right', 'Odometer', 'Chassis number'];
    return Promise.all(slots.slice(0, n).map(async (slot) => ({ slot, fileId: await file(token) })));
  };
  const add = async (customerId: string, extra: object = {}, n = 4, token = adv.token) =>
    as(token).post(`/customers/${customerId}/vehicles`, { registration: 'ka 01 ab-1234', vehicleType: 'Private car', make: 'Maruti', model: 'Swift', year: 2021, fuel: 'Petrol', rcFileId: await file(token), photos: await photos(n, token), ...extra });
  return { adv, c, cus, customer, file, photos, add };
}

describe('P-54 vehicles', () => {
  it('AC-P54-1: fewer than CFG-154 photos cannot be saved (VEH-02), and nothing is saved', async () => {
    const { cus, add } = await setup();
    const res = await add(cus.id, {}, 3);
    expect(fieldIds(res)).toEqual({ photos: 'VEH-02' });
    expect(JSON.stringify(res.body)).toContain('Add at least 4 photos before saving.');
    expect(await Vehicle.countDocuments()).toBe(0);
    expect(await CustomerDocument.countDocuments({ type: { $in: ['Vehicle RC', 'Vehicle photo'] } })).toBe(0);
  });

  it('saves the vehicle, its RC and photos together (VEH-01); the registration is stored in capitals without spaces', async () => {
    const { c, cus, add } = await setup();
    const res = await add(cus.id);
    expect(res.status).toBe(201);
    expect(res.body.meta.message).toBe('Vehicle KA01AB1234 added for Meena Iyer.');
    expect(res.body.data).toMatchObject({ registration: 'KA01AB1234', status: 'ACTIVE' });
    expect(res.body.data.rc).toHaveLength(1);
    expect(res.body.data.photos.filter((s: { versions: unknown[] }) => s.versions.length).map((s: { slot: string }) => s.slot)).toEqual(['Front', 'Rear', 'Left', 'Right']);
    // photos belong to the vehicle: they are not in the customer's general Documents list
    expect((await c.get(`/customers/${cus.id}/documents`)).body.data.groups).toEqual([]);
  });

  it('AC-P54-2: one customer can have several vehicles, each with its own RC and photos', async () => {
    const { c, cus, add } = await setup();
    await add(cus.id);
    await add(cus.id, { registration: '22BH1234AA', vehicleType: 'Two-wheeler', fuel: 'Electric' });
    const list = (await c.get(`/customers/${cus.id}/vehicles`)).body.data.vehicles;
    expect(list.map((v: { registration: string }) => v.registration).sort()).toEqual(['22BH1234AA', 'KA01AB1234']);
    const [a, b] = list;
    expect(a.rc[0].file.id).not.toBe(b.rc[0].file.id);
  });

  it('AC-P54-3: a registration already ACTIVE in the account is refused (VEH-03), even from two tabs at once', async () => {
    const { cus, customer, add } = await setup();
    await add(cus.id);
    const other = await customer('Ravi Kumar');
    const dup = await add(other.id);
    expect(err(dup)).toMatchObject({ status: 409, messageId: 'VEH-03' });
    expect(dup.body.error.message).toBe('Vehicle KA01AB1234 is already recorded for Meena Iyer.');
    const fresh = await customer('Kavya Nair');
    const [x, y] = await Promise.all([add(fresh.id, { registration: 'MH12DE3456' }), add(fresh.id, { registration: 'MH12DE3456' })]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await Vehicle.countDocuments({ registration: 'MH12DE3456' })).toBe(1);
  });

  it('Q36: once sold, the same registration can be recorded for the buyer; reactivating the old one is then refused', async () => {
    const { c, cus, customer, add } = await setup();
    const v = (await add(cus.id)).body.data;
    await c.post(`/vehicles/${v.id}/status`, { version: v.version, status: 'INACTIVE' });
    const buyer = await customer('Ravi Kumar');
    expect((await add(buyer.id)).status).toBe(201);
    const back = await c.post(`/vehicles/${v.id}/status`, { version: v.version + 1, status: 'ACTIVE' });
    expect(err(back)).toMatchObject({ status: 409, messageId: 'VEH-03' });
  });

  it('AC-P54-4: marking a vehicle sold keeps its RC and photos; it can be marked active again', async () => {
    const { c, cus, add } = await setup();
    const v = (await add(cus.id)).body.data;
    const sold = await c.post(`/vehicles/${v.id}/status`, { version: v.version, status: 'INACTIVE' });
    expect(sold.body.meta.message).toBe('Vehicle saved.');
    expect(sold.body.data).toMatchObject({ status: 'INACTIVE' });
    expect(sold.body.data.rc).toHaveLength(1);
    expect(await CustomerDocument.countDocuments({ vehicleId: v.id })).toBe(5);
    expect((await c.post(`/vehicles/${v.id}/status`, { version: v.version + 1, status: 'ACTIVE' })).body.data.status).toBe('ACTIVE');
  });

  it('P-54 step 4: a newer photo for a slot adds version 2 and keeps version 1; a newer RC too', async () => {
    const { c, cus, add, file } = await setup();
    const v = (await add(cus.id)).body.data;
    const r = await c.post(`/vehicles/${v.id}/files`, { kind: 'PHOTO', slot: 'Front', fileId: await file() });
    expect(r.body.meta.message).toBe('Front photo saved as version 2.');
    expect(r.body.data.photos.find((s: { slot: string }) => s.slot === 'Front').versions.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    expect((await c.post(`/vehicles/${v.id}/files`, { kind: 'RC', fileId: await file() })).body.meta.message).toBe('Vehicle RC saved as version 2.');
    expect(fieldIds(await c.post(`/vehicles/${v.id}/files`, { kind: 'PHOTO', slot: 'Roof', fileId: await file() }))).toEqual({ slot: 'VAL-22' });
  });

  it('VEH-04: a client can have up to CFG-156 ACTIVE vehicles', async () => {
    const { cus, add } = await setup();
    // Change the setting the way an admin does: a stored override, then reload.
    await ConfigValue.updateOne({ _id: 'CFG-156' }, { $set: { value: 1, updatedBy: 'test' } }, { upsert: true });
    await loadConfigOverrides();
    try {
      await add(cus.id);
      const second = await add(cus.id, { registration: 'KA02CD5678' });
      expect(err(second)).toMatchObject({ status: 409, messageId: 'VEH-04' });
      expect(second.body.error.message).toBe('A client can have up to 1 vehicles.');
    } finally { await ConfigValue.deleteOne({ _id: 'CFG-156' }); await loadConfigOverrides(); }
  });

  it('field rules: registration (VAL-40), year from CFG-181 to this year (VAL-12), photo slots one each', async () => {
    const { cus, add, photos } = await setup();
    const res = await add(cus.id, { registration: 'KA1234', year: 1940 });
    expect(fieldIds(res)).toMatchObject({ registration: 'VAL-40', year: 'VAL-12' });
    const p = await photos(4);
    p[1]!.slot = 'Front'; // two Front photos
    expect(fieldIds(await add(cus.id, { photos: p }))).toEqual({ photos: 'VAL-22' });
  });

  it('an assistant can add vehicles; another account cannot see or change them', async () => {
    const { adv, c, cus, add } = await setup();
    const m = newMobile();
    await c.post('/assistants', { name: 'Priya Shah', mobile: m }, { 'X-Step-Up-Token': await stepUp(adv.token, adv.mobile) });
    const ast = await login(m);
    const v = await add(cus.id, {}, 4, ast.token);
    expect(v.status).toBe(201);
    const O = as((await registerAdvisor('Ravi Kumar')).token);
    expect(err(await O.get(`/customers/${cus.id}/vehicles`))).toMatchObject({ status: 404, messageId: 'GEN-11' });
    expect(err(await O.get(`/vehicles/${v.body.data.id}`))).toMatchObject({ status: 404 });
    expect(err(await O.post(`/vehicles/${v.body.data.id}/status`, { version: 1, status: 'INACTIVE' }))).toMatchObject({ status: 404 });
  });
});