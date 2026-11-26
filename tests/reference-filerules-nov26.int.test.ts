import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, registerAdvisor, resetState, startTestEnv, stopTestEnv } from './helpers.js';

beforeAll(startTestEnv);
afterAll(stopTestEnv);
beforeEach(resetState);

describe('upload rules on /reference (Nov 2026)', () => {
  it('each upload purpose says its formats and size limit, for the hint and the check before uploading', async () => {
    const adv = await registerAdvisor();
    const r = (await as(adv.token).get('/reference')).body.data;
    expect(r.fileRules.PROFILE_PHOTO).toEqual({ types: ['JPG', 'JPEG', 'PNG'], maxMb: 2 });
    expect(r.fileRules.CUSTOMER_DOCUMENT).toEqual({ types: ['PDF', 'JPG', 'JPEG', 'PNG'], maxMb: 10 });
  });
});