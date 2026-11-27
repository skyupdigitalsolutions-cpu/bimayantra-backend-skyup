import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Proposal } from '../src/modules/proposals/proposal.model.js';
import { Policy } from '../src/modules/policies/policy.model.js';
import { stagesOf } from '../src/modules/quotations/quotations.service.js';
import { resetState, startTestEnv, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

describe('accepted quotations show where they are now (client report, Nov 2026)', () => {
  it('the policy wins over the proposal; a cancelled proposal is ignored; another account sees nothing', async () => {
    const base = { accountId: 'acc_a', customerId: 'cus_1', revision: 1, createdBy: 'usr_1' };
    await Proposal.create({ ...base, quotationId: 'qt_1', number: 'PR-202611-00001', status: 'SUBMITTED' });
    await Policy.create({ accountId: 'acc_a', customerId: 'cus_1', quotationId: 'qt_1', policyNumber: '24234454', status: 'ISSUED' });
    await Proposal.create({ ...base, quotationId: 'qt_2', number: 'PR-202611-00002', status: 'SUBMITTED' });
    await Proposal.create({ ...base, quotationId: 'qt_3', number: 'PR-202611-00003', status: 'CANCELLED' });
    const s = await stagesOf('acc_a', ['qt_1', 'qt_2', 'qt_3', 'qt_4']);
    expect(s.get('qt_1')).toMatchObject({ kind: 'POLICY', number: '24234454', label: 'Policy issued' });
    expect(s.get('qt_2')).toMatchObject({ kind: 'PROPOSAL', number: 'PR-202611-00002', label: 'Proposal submitted' });
    expect(s.has('qt_3')).toBe(false);
    expect(s.has('qt_4')).toBe(false);
    expect((await stagesOf('acc_b', ['qt_1'])).size).toBe(0);
  });
});