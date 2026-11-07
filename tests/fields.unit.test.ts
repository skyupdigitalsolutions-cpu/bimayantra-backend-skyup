import { describe, expect, it } from 'vitest';
import { aadhaar, email, mobile, nameKey, pan, personName, verhoeffComplete, verhoeffValid } from '../src/lib/fields.js';
import { maskMobile, normalizeMobile } from '../src/lib/phone.js';
import { allowedMoves, canMove } from '../src/modules/leads/leadStatus.js';
import { effectiveStatus } from '../src/modules/accounts/subscription.js';

describe('FLD-01 mobile', () => {
  it.each([['98123 45678', '+919812345678'], ['+91-98123-45678', '+919812345678'], ['098123 45678', '+919812345678'], ['919812345678', '+919812345678']])('%s → %s', (raw, out) => {
    expect(normalizeMobile(raw)).toBe(out);
  });
  it.each(['5812345678', '981234567', '+14155550100'])('rejects %s', (raw) => expect(mobile().safeParse(raw).success).toBe(false));
  it('masks as 98XXXXXX78 (GR-31)', () => expect(maskMobile('+919812345678')).toBe('98XXXXXX78'));
});

describe('FLD-02 / FLD-03 / FLD-15 / FLD-33', () => {
  it('names: letters in any script, collapse spaces, at least 2 letters, no emoji', () => {
    expect(personName().parse('  Asha   Rao ')).toBe('Asha Rao');
    expect(personName().safeParse('ಆಶಾ ರಾವ್').success).toBe(true);
    expect(personName().safeParse('A1').success).toBe(false);
    expect(personName().safeParse('Asha 😀').success).toBe(false);
    expect(nameKey('Ravi K. Kumar')).toBe(nameKey('ravi k kumar'));
  });
  it('email is lowercased and needs a real domain', () => {
    expect(email().parse(' Name@Example.COM ')).toBe('name@example.com');
    expect(email().safeParse('name@example').success).toBe(false);
  });
  it('PAN: individual (4th letter P), uppercased', () => {
    expect(pan().parse('abcpe1234f')).toBe('ABCPE1234F');
    expect(pan().safeParse('ABCCE1234F').success).toBe(false);
  });
  it('Aadhaar: 12 digits, first 2–9, Verhoeff check digit', () => {
    const ok = verhoeffComplete('23456789012');
    expect(verhoeffValid(ok)).toBe(true);
    expect(aadhaar().safeParse(ok.replace(/(.{4})/g, '$1 ')).success).toBe(true);
    expect(aadhaar().safeParse(`${ok.slice(0, 11)}${(Number(ok[11]) + 1) % 10}`).success).toBe(false);
    expect(aadhaar().safeParse(`1${ok.slice(1)}`).success).toBe(false);
  });
});

describe('Lead state machine (4.3)', () => {
  it('matches the table exactly', () => {
    expect(canMove('NEW', 'QUALIFIED')).toBe(false);
    expect(canMove('QUALIFIED', 'CONTACTED')).toBe(false);
    expect(canMove('LOST', 'CONTACTED')).toBe(true);
    expect(canMove('LOST', 'FOLLOW_UP')).toBe(false);
    expect(allowedMoves('FOLLOW_UP', 'ADV')).toEqual(['CONTACTED', 'QUALIFIED', 'LOST']);
    expect(allowedMoves('FOLLOW_UP', 'AST')).toEqual(['CONTACTED', 'QUALIFIED']);
    expect(allowedMoves('LOST', 'AST')).toEqual([]);
  });
});

describe('Subscription (4.3, GR-33)', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date('2026-10-08T00:00:00Z');
  it('trial past its end is EXPIRED; ACTIVE past its end is GRACE for CFG-79, then EXPIRED', () => {
    expect(effectiveStatus({ status: 'TRIAL', endsAt: end }, start)).toBe('TRIAL');
    expect(effectiveStatus({ status: 'TRIAL', endsAt: end }, new Date('2026-10-08T00:00:01Z'))).toBe('EXPIRED');
    expect(effectiveStatus({ status: 'ACTIVE', endsAt: end }, new Date('2026-10-10T00:00:00Z'))).toBe('GRACE');
    expect(effectiveStatus({ status: 'ACTIVE', endsAt: end }, new Date('2026-10-16T00:00:00Z'))).toBe('EXPIRED');
  });
});
