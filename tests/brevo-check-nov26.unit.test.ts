import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkBrevo } from '../src/modules/comms/brevo.js';
import { msg } from '../src/lib/messages.js';

const answer = (status: number, json: object) => vi.fn().mockResolvedValue({ status, json: async () => json });
afterEach(() => vi.unstubAllGlobals());

describe('Brevo connection check (client report, Nov 2026: a good key was refused)', () => {
  it('Brevo blocking the server IP is told apart from a wrong key, with the address to authorise', async () => {
    vi.stubGlobal('fetch', answer(401, { code: 'unauthorized', message: 'We have detected you are using an unrecognised IP address 34.93.12.7. If you performed this action make sure to add the new IP address in this link: https://app.brevo.com/security/authorised_ips' }));
    expect(await checkBrevo('xkeysib-abc', 'a@b.com')).toEqual({ ok: false, reason: 'IP', detail: '34.93.12.7' });
    expect(msg('INT-10', { ip: '34.93.12.7' })).toContain('add 34.93.12.7');
  });
  it('a key Brevo does not know stays a key problem, with Brevo\'s own words', async () => {
    vi.stubGlobal('fetch', answer(401, { code: 'unauthorized', message: 'Key not found' }));
    expect(await checkBrevo('xkeysib-abc', 'a@b.com')).toEqual({ ok: false, reason: 'KEY', detail: 'Key not found' });
    expect(msg('INT-11', { provider: 'Brevo', reason: 'Key not found' })).toBe('Brevo did not accept this key. Brevo said: "Key not found". Copy the key again from your Brevo account (SMTP & API → API keys) and paste it here.');
  });
});