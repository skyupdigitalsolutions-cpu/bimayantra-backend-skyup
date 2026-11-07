/** Personal data at rest: names, mobiles, emails and KYC values are ciphertext in MongoDB and plain through the API. */
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, newMobile, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { User } from '../src/modules/users/user.model.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { runEncryptPii } from '../src/modules/migrations/encryptPii.js';
import { encryptDet, isEncrypted, piiSearch, PiiQueryError, searchTokens } from '../src/lib/pii.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

/** Every string anywhere in every collection, with where it was found. */
async function rawStrings() {
  const out: Array<{ where: string; value: string }> = [];
  const walk = (v: unknown, where: string) => {
    if (typeof v === 'string') out.push({ where, value: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object' && !(v instanceof Date) && v.constructor?.name === 'Object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  for (const c of await mongoose.connection.db!.collections()) {
    for (const d of await c.find({}).toArray()) walk(d, c.collectionName);
  }
  return out;
}

const raw = (collection: string, filter: object = {}) => mongoose.connection.db!.collection(collection).findOne(filter);

describe('personal data is encrypted in the database', () => {
  it('names, mobiles and emails never appear in plain text, and the API shows them normally', async () => {
    const advMobile = newMobile();
    const adv = await registerAdvisor('Asha Rao', advMobile);
    const c = as(adv.token);
    const mob = newMobile();
    const alt = newMobile();
    const cus = (await c.post('/customers', { name: 'Meena Iyer', mobile: mob, altMobile: alt, email: 'meena.iyer@example.com' })).body.data;
    expect(cus).toMatchObject({ name: 'Meena Iyer', email: 'meena.iyer@example.com' });
    const famMobile = newMobile();
    expect((await c.post(`/customers/${cus.id}/family`, { name: 'Arjun Iyer', relationship: 'Son', mobile: famMobile })).status).toBe(201);
    await c.post(`/customers/${cus.id}/consents`, { personType: 'CUSTOMER', personId: cus.id, channel: 'WHATSAPP', action: 'GIVE', howGiven: 'Replied on WhatsApp', declaration: true });
    const pipelines = (await c.get('/pipelines')).body.data as Array<{ id: string }>;
    const leadMobile = newMobile();
    const lead = (await c.post('/leads', { pipelineId: pipelines[0]!.id, name: 'Ravi Kumar', mobile: leadMobile, email: 'ravi.k@example.org', source: 'Walk-in or personal contact' })).body.data;
    expect(lead).toMatchObject({ name: 'Ravi Kumar' });

    // Edits go through the update path: the new values are encrypted and searchable too.
    const edited = await c.patch(`/customers/${cus.id}`, { version: 1, name: 'Meenakshi Iyer' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.name).toBe('Meenakshi Iyer');

    // The API reads plain values back.
    expect((await c.get(`/customers/${cus.id}`)).body.data).toMatchObject({ name: 'Meenakshi Iyer', mobile: `+91${mob}`, altMobile: `+91${alt}`, email: 'meena.iyer@example.com' });
    expect((await c.get(`/customers/${cus.id}`)).body.data.family[0]).toMatchObject({ name: 'Arjun Iyer', mobile: `+91${famMobile}` });

    // Nothing readable in the database.
    const secrets = ['Meena', 'Iyer', 'Arjun', 'Ravi Kumar', 'Asha Rao', 'meena.iyer@example.com', 'ravi.k@example.org', mob, alt, famMobile, leadMobile, advMobile];
    const leaks = (await rawStrings()).filter((s) => secrets.some((x) => s.value.includes(x)));
    expect(leaks).toEqual([]);

    const rc = (await raw('customers', { _id: cus.id }))!;
    for (const k of ['name', 'nameKey', 'mobile', 'altMobile', 'email']) expect(isEncrypted(rc[k]), k).toBe(true);
    expect(rc.searchIndex.name.length).toBeGreaterThan(0);
    expect(isEncrypted((await raw('users', { _id: adv.user.id }))!.name)).toBe(true);
    expect(isEncrypted((await raw('consents', { customerId: cus.id, channel: 'WHATSAPP' }))!.address)).toBe(true);
    expect(isEncrypted((await raw('audit_log', { entityId: cus.id, action: 'CUSTOMER_CREATED' }))!.after)).toBe(true);
  });

  it('search, duplicate checks and sign-in still work on encrypted values', async () => {
    const advMobile = newMobile();
    const adv = await registerAdvisor('Asha Rao', advMobile);
    const c = as(adv.token);
    const mob = newMobile();
    const cus = (await c.post('/customers', { name: 'Meena Iyer', mobile: mob, email: 'meena.iyer@example.com' })).body.data;

    const ids = async (q: string) => ((await c.get(`/customers?search=${encodeURIComponent(q)}`)).body.data as Array<{ id: string }>).map((x) => x.id);
    expect(await ids('meen')).toEqual([cus.id]); // word prefix, any case
    expect(await ids('iyer meena')).toEqual([cus.id]); // words in any order
    expect(await ids(mob.slice(-4))).toEqual([cus.id]); // last digits
    expect(await ids(mob.slice(2, 8))).toEqual([cus.id]); // digits in the middle
    expect(await ids('meena.iyer@')).toEqual([cus.id]); // email prefix
    expect(await ids('example.com')).toEqual([cus.id]); // email domain
    expect(await ids(cus.number)).toEqual([cus.id]); // record number, plain
    expect(await ids('ravi')).toEqual([]);

    const global = (await c.get('/search?q=Iyer')).body.data;
    expect(global.groups.find((g: { group: string }) => g.group === 'CUSTOMERS').items).toHaveLength(1);

    // Exact duplicate (same name, any case, and mobile) is still found through the encrypted values.
    expect((await c.post('/customers', { name: 'MEENA IYER', mobile: mob })).body.error.messageId).toBe('CU-02');
    // Lookups by exact value are encrypted the same way.
    expect((await Customer.findOne({ mobile: `+91${mob}` }).lean())?._id).toBe(cus.id);
    expect((await User.findOne({ mobile: `+91${advMobile}` }).lean())?.name).toBe('Asha Rao');
  });

  it('advisor KYC and contact details are encrypted', async () => {
    const adv = await registerAdvisor('Asha Rao');
    await Account.updateOne({ _id: adv.user.accountId }, { $set: { 'profile.kyc.nameOnPan': 'Asha Rao', 'profile.contact.email': 'asha@example.com', 'profile.professional.licenceNumber': 'LIC-778899' } });
    const r = (await raw('accounts', { _id: adv.user.accountId }))!;
    expect(isEncrypted(r.profile.kyc.nameOnPan)).toBe(true);
    expect(isEncrypted(r.profile.contact.email)).toBe(true);
    expect(isEncrypted(r.profile.professional.licenceNumber)).toBe(true);
    const a = (await Account.findById(adv.user.accountId).lean())!;
    expect(a.profile?.kyc?.nameOnPan).toBe('Asha Rao');
    expect(a.profile?.contact?.email).toBe('asha@example.com');
  });
});

describe('db:migrate:encrypt-pii', () => {
  it('encrypts rows saved before encryption; a dry run writes nothing and a second run changes nothing', async () => {
    const adv = await registerAdvisor('Asha Rao');
    const db = mongoose.connection.db!;
    const mob = `+91${newMobile()}`;
    // A customer and an OTP lock as an older version of the API saved them: plain text, no search tokens.
    await db.collection('customers').insertOne({ _id: 'cus_0000000000000000000000000001' as never, accountId: adv.user.accountId, number: 'CU-9001', name: 'Old Record', nameKey: 'old record', mobile: mob, altMobile: null, email: 'old@example.com', status: 'ACTIVE', createdBy: adv.user.id, version: 1, createdAt: new Date(), updatedAt: new Date() });
    await db.collection('otp_locks').insertOne({ _id: `LOGIN:${mob}` as never, lockedUntil: new Date(Date.now() + 3_600_000), reason: 'WRONG_TRIES' });

    const dry = await runEncryptPii({ apply: false });
    expect(dry.collections.customers!.toEncrypt).toBe(1);
    expect(dry.collections.otp_locks).toMatchObject({ toEncrypt: 1, idsRewritten: 1 });
    expect((await raw('customers', { number: 'CU-9001' }))!.name).toBe('Old Record');

    await runEncryptPii({ apply: true });
    const r = (await raw('customers', { number: 'CU-9001' }))!;
    expect([r.name, r.nameKey, r.mobile, r.email].every(isEncrypted)).toBe(true);
    expect(await db.collection('otp_locks').countDocuments({ _id: `LOGIN:${mob}` as never })).toBe(0);
    expect(await db.collection('otp_locks').countDocuments({})).toBe(1);

    // The app finds the migrated rows by exact value and by search.
    expect((await Customer.findOne({ mobile: mob }).lean())?.name).toBe('Old Record');
    const found = (await as(adv.token).get('/customers?search=old')).body.data as Array<{ number: string }>;
    expect(found.map((x) => x.number)).toEqual(['CU-9001']);

    const again = await runEncryptPii({ apply: true });
    expect(Object.entries(again.collections).filter(([, c]) => c.toEncrypt).map(([k]) => k)).toEqual([]);
  });
});

describe('the encryption layer', () => {
  it('is deterministic only where it must be, and refuses queries it cannot answer', async () => {
    expect(encryptDet('mobile', '+919876543210')).toBe(encryptDet('mobile', '+919876543210'));
    expect(encryptDet('mobile', '+919876543210')).not.toBe(encryptDet('email', '+919876543210'));
    expect(searchTokens('name', 'Asha Rao')).toHaveLength(7); // a, as, ash, asha, r, ra, rao
    expect(piiSearch('ab', { mobile: 4 })).toEqual([]);
    await expect(Lead.find({ name: /asha/i }).lean()).rejects.toBeInstanceOf(PiiQueryError);
  });
});