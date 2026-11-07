/** P-18 step 5: field-finders on OCR text shaped like Document AI output for real cards. */
import { describe, expect, it } from 'vitest';
import { verhoeffComplete } from '../src/lib/fields.js';
import { parseAadhaar, parseOldPolicy, parsePan } from '../src/modules/documents/parsers.js';

const AADHAAR = verhoeffComplete('23456789012'); // a number that passes the check digit
const spaced = `${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8)} ${AADHAAR.slice(8)}`;

describe('PAN', () => {
  it('new layout: labelled name, father\u2019s name, date of birth, PAN', () => {
    const text = `आयकर विभाग INCOME TAX DEPARTMENT
भारत सरकार GOVT. OF INDIA
स्थायी लेखा संख्या कार्ड
Permanent Account Number Card
ABCPE1234F
नाम / Name
MEENA IYER
पिता का नाम / Father's Name
RAMESH IYER
जन्म की तारीख / Date of Birth
15/04/1988
हस्ताक्षर / Signature`;
    expect(parsePan(text)).toEqual({ pan: 'ABCPE1234F', name: 'Meena Iyer', fatherName: 'Ramesh Iyer', dob: '15-04-1988' });
  });

  it('old layout: no labels; name and father\u2019s name are the two lines above the date of birth', () => {
    const text = `INCOME TAX DEPARTMENT GOVT. OF INDIA
HARISH PATIL
SURESH PATIL
07/09/2003
Permanent Account Number
IARPB4117E
Signature`;
    expect(parsePan(text)).toEqual({ pan: 'IARPB4117E', name: 'Harish Patil', fatherName: 'Suresh Patil', dob: '07-09-2003' });
  });

  it('a blurred card gives only what it can read, never a guess', () => {
    expect(parsePan('INCOME TAX DEPARTMENT\nPermanent Account Number\nA8CPE12?4F')).toEqual({});
  });
});

describe('Aadhaar', () => {
  it('reads name, date of birth, gender and a number that passes the check digit; ignores the VID', () => {
    const text = `भारत सरकार
Government of India
मीना अय्यर
Meena Iyer
जन्म तिथि/DOB: 15/04/1988
महिला / FEMALE
${spaced}
VID : 9134 5678 2345 6789
मेरा आधार, मेरी पहचान`;
    expect(parseAadhaar(text)).toEqual({ aadhaar: AADHAAR, name: 'Meena Iyer', dob: '15-04-1988', gender: 'FEMALE' });
  });

  it('a masked copy (CU-17) gives no number; a misread number that fails the check is left empty', () => {
    expect(parseAadhaar('Government of India\nMeena Iyer\nDOB: 15/04/1988\nFEMALE\nXXXX XXXX 9012').aadhaar).toBeUndefined();
    const wrong = AADHAAR.slice(0, 11) + String((Number(AADHAAR[11]) + 1) % 10);
    expect(parseAadhaar(`Meena Iyer\nDOB: 15/04/1988\n${wrong}`).aadhaar).toBeUndefined();
  });
});

describe('Old policy', () => {
  it('reads policy number, period, sum insured and premium from a schedule', () => {
    const text = `Alpha General Insurance Company Limited
Policy Schedule
Policy No: 2311/40125678/00/000
Period of Insurance: From 01/04/2025 00:00 To 31/03/2026 23:59
Sum Insured: ₹ 5,00,000
Total Premium (incl. GST): ₹ 12,500.00`;
    expect(parseOldPolicy(text)).toEqual({ policyNumber: '2311/40125678/00/000', startDate: '01-04-2025', endDate: '31-03-2026', sumInsured: '5,00,000', premium: '12,500.00' });
  });
});