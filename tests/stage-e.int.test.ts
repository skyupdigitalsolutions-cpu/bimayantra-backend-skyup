/** Stage E1 — no admin approval: items left waiting from before are listed, then published or returned to draft. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetState, startTestEnv, stopTestEnv } from './helpers.js';
import { cfgNum } from '../src/config/cfg.js';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { ConfigChange } from '../src/modules/admin/admin.model.js';
import { MessageTemplate } from '../src/modules/comms/outbox.model.js';
import { Insurer } from '../src/modules/insurers/insurer.model.js';
import { runPendingApprovals } from '../src/modules/migrations/pendingApprovals.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

async function waiting() {
  await Insurer.create({ name: 'Old Pending Insurer', nameKey: 'old pending insurer', shortCode: 'OPI', category: 'General', irdaiRegNo: 'R-9', paymentDomains: ['opi.in'], status: 'PENDING_APPROVAL', makerId: 'usr_old_maker' });
  await ConfigChange.create({ cfgId: 'CFG-114', oldValue: 3, newValue: 7, reason: 'More exports', requestedBy: 'usr_old_maker', status: 'PENDING_APPROVAL' });
  await MessageTemplate.create({ code: 'T-A', name: 'KYC result A', channel: 'EMAIL', purpose: 'KYC_RESULT', body: 'Hello {advisor name}', status: 'PENDING_APPROVAL', makerId: 'usr_old_maker' });
  await MessageTemplate.create({ code: 'T-B', name: 'KYC result B', channel: 'EMAIL', purpose: 'KYC_RESULT', body: 'Hi {advisor name}', status: 'PENDING_APPROVAL', makerId: 'usr_old_maker' });
  await MessageTemplate.create({ code: 'T-W', name: 'With Meta', channel: 'WHATSAPP', purpose: 'BIRTHDAY', body: 'Hi {name}', status: 'PENDING_APPROVAL', metaStatus: 'SUBMITTED', makerId: 'usr_old_maker' });
}

describe('items left waiting for approval', () => {
  it('the dry run lists them (Meta’s own review excluded) and changes nothing; publish makes them live with the original maker recorded; a failing check returns to draft with the reason; a second run finds nothing', async () => {
    await waiting();
    const dry = await runPendingApprovals({ mode: 'dry' });
    expect(dry.count).toBe(4);
    expect(dry.items.map((i) => i.kind).sort()).toEqual(['CONFIG_CHANGE', 'INSURER', 'MESSAGE_TEMPLATE', 'MESSAGE_TEMPLATE']);
    expect(await Insurer.countDocuments({ status: 'ACTIVE' })).toBe(0);

    const run = await runPendingApprovals({ mode: 'publish' });
    expect((await Insurer.findOne({ name: 'Old Pending Insurer' }).lean())!.status).toBe('ACTIVE');
    expect(cfgNum('CFG-114')).toBe(7);
    const results = Object.fromEntries(run.items.map((i) => [i.name, i.result]));
    expect(results['KYC result A']).toBe('PUBLISHED');
    expect(results['KYC result B']).toMatch(/^RETURNED_TO_DRAFT: /); // only one active template per purpose (COM-05)
    expect((await MessageTemplate.findOne({ name: 'KYC result B' }).lean())!.status).toBe('DRAFT');
    expect((await MessageTemplate.findOne({ name: 'With Meta' }).lean())!.status).toBe('PENDING_APPROVAL'); // Meta decides that one
    // Audit snapshots are encrypted as a whole (lib/pii.ts), so match inside them after reading.
    const published = await AuditLog.find({ action: 'PENDING_ITEM_PUBLISHED' }).lean<Array<{ after?: { kind?: string } }>>();
    expect(published.find((a) => a.after?.kind === 'INSURER')).toMatchObject({ after: { originalMaker: 'usr_old_maker' } });
    expect((await runPendingApprovals({ mode: 'dry' })).count).toBe(0);
  });

  it('to-draft returns every waiting item to draft for its maker to publish', async () => {
    await waiting();
    const run = await runPendingApprovals({ mode: 'toDraft' });
    expect(run.items.every((i) => i.result === 'RETURNED_TO_DRAFT')).toBe(true);
    expect((await Insurer.findOne({ name: 'Old Pending Insurer' }).lean())!.status).toBe('DRAFT');
    expect(await MessageTemplate.countDocuments({ status: 'DRAFT' })).toBe(2);
    expect((await ConfigChange.findOne({}).lean())!.status).toBe('REJECTED');
    expect(cfgNum('CFG-114')).toBe(3);
  });
});