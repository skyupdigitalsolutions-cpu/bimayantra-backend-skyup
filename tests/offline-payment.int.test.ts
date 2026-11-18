/** Admin records an offline subscription payment with a start date (the admin dialog sends DD-MM-YYYY). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, registerAdvisor, resetState, seedAdmin, startTestEnv, stepUp, stopTestEnv } from './helpers.js';
import { istToday } from '../src/lib/clock.js';
import { Account } from '../src/modules/accounts/account.model.js';
import { SubscriptionOrder } from '../src/modules/admin/admin.model.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

const dmy = (iso: string) => iso.split('-').reverse().join('-');

describe('offline subscription payment', () => {
  for (const plan of ['NORMAL', 'PREMIUM'] as const) {
    it(`${plan}: start date as DD-MM-YYYY (what the admin dialog sends) activates the plan`, async () => {
      const a = await seedAdmin();
      const adv = await registerAdvisor('Johnson');
      const today = istToday();
      const r = await as(a.token).post(`/admin/accounts/${adv.user.accountId}/offline-payment`,
        { plan, cycle: 'YEARLY', amount: 49000, reference: `john-${plan}`, startDate: dmy(today) },
        { 'X-Step-Up-Token': await stepUp(a.token, a.mobile) });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const o = await SubscriptionOrder.findById(r.body.data.orderId).lean();
      expect(o?.status).toBe('SUCCESS');
      expect(o?.periodStart).toBe(today);
      const acc = await Account.findById(adv.user.accountId).lean<{ subscription: { status: string; plan: string } }>();
      expect(acc?.subscription).toMatchObject({ status: 'ACTIVE', plan });
    });
  }
});