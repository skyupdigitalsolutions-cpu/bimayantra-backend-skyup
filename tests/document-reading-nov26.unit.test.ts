import { describe, expect, it } from 'vitest';
import { parseAadhaar, parseOldPolicy, parsePan } from '../src/modules/documents/parsers.js';
import { readMessage } from '../src/modules/documents/documents.service.js';

// Text as Google Document AI returns it for typical cards (made-up people; the Aadhaar number passes Verhoeff).
const AADHAAR_FRONT = `भारत सरकार
Government of India
मीना अय्यर
Meena Iyer
जन्म तिथि/DOB: 15/08/1990
महिला/ FEMALE
2345 6789 0124
मेरा आधार, मेरी पहचान`;
const AADHAAR_BACK = `भारतीय विशिष्ट पहचान प्राधिकरण
Unique Identification Authority of India
पता:
Address: W/O Ravi Iyer, 12, 3rd Cross,
Jayanagar 4th Block,
Bengaluru, Karnataka - 560011
2345 6789 0124
1947 help@uidai.gov.in www.uidai.gov.in`;
const AADHAAR_LABEL_NEXT_LINE = `Government of India
Arjun Iyer
DOB
1 / 2 / 2012
MALE
Aadhaar no. issued: 05/06/2018
XXXX XXXX 0124`;
const PAN_NEW = `आयकर विभाग INCOME TAX DEPARTMENT
भारत सरकार GOVT. OF INDIA
स्थायी लेखा संख्या कार्ड Permanent Account Number Card
ABCPE1234F
नाम / Name
MEENA IYER
पिता का नाम / Father's Name
SUNDAR IYER
जन्म की तारीख / Date of Birth
15/08/1990`;

describe('document reading (Nov 2026 fixes)', () => {
  it('Aadhaar front: date of birth as YYYY-MM-DD (the date field could not show DD-MM-YYYY), name, gender, number', () => {
    expect(parseAadhaar(AADHAAR_FRONT)).toMatchObject({ name: 'Meena Iyer', dob: '1990-08-15', gender: 'FEMALE', aadhaar: '234567890124' });
  });
  it('Aadhaar back: the address up to the PIN code, without Hindi, number or help lines', () => {
    expect(parseAadhaar(AADHAAR_BACK).address).toBe('W/O Ravi Iyer, 12, 3rd Cross, Jayanagar 4th Block, Bengaluru, Karnataka - 560011');
  });
  it('a date on the line after "DOB", spaced by OCR; the issue date is never the date of birth; a masked copy is noted', () => {
    const v = parseAadhaar(AADHAAR_LABEL_NEXT_LINE);
    expect(v).toMatchObject({ dob: '2012-02-01', name: 'Arjun Iyer', gender: 'MALE', aadhaarMasked: 'true' });
    expect(v.aadhaar).toBeUndefined();
  });
  it('PAN: date of birth on the line after its label', () => {
    expect(parsePan(PAN_NEW)).toMatchObject({ pan: 'ABCPE1234F', name: 'Meena Iyer', fatherName: 'Sundar Iyer', dob: '1990-08-15' });
  });
  it('old policy dates come back as YYYY-MM-DD too', () => {
    expect(parseOldPolicy('Policy No: HX/123/45 Period of Insurance From 01/04/2025 To 31/03/2026')).toMatchObject({ startDate: '2025-04-01', endDate: '2026-03-31' });
  });
  it('the check screen says what was read and what to type', () => {
    expect(readMessage('Aadhaar', 'DONE', { name: 'A', dob: '1990-01-01', aadhaarMasked: 'true' })).toMatchObject({
      messageId: 'DOC-12', message: 'Read from the document: name and date of birth. Aadhaar number (it is masked on this copy), gender and address could not be read: type them in, then select Confirm.',
      missing: ['aadhaar', 'gender', 'address'],
    });
    expect(readMessage('PAN', 'DONE', {}).messageId).toBe('DOC-10');
    expect(readMessage('PAN', 'FAILED', null).messageId).toBe('DOC-13');
    expect(readMessage('PAN', 'DONE', { name: 'A', pan: 'B', fatherName: 'C', dob: 'D' }).messageId).toBe('DOC-04');
  });
});

import { policyReadMessage } from '../src/modules/documents/policyReader.js';
describe('policy document reading (Nov 2026)', () => {
  it('reads the issue date too, as YYYY-MM-DD', () => {
    expect(parseOldPolicy('Policy Number: 2311/40125678 Date of Issue: 28/03/2025 Period of Insurance From 01/04/2025 To 31/03/2026')).toMatchObject({ issueDate: '2025-03-28', startDate: '2025-04-01', endDate: '2026-03-31' });
  });
  it('says which of the policy details could not be read', () => {
    expect(policyReadMessage({ policyNumber: 'P1', insurerId: 'ins_1', startDate: 'x', endDate: 'y' })).toMatchObject({
      messageId: 'POL-21', missing: ['typeId', 'productName', 'variantName'],
      message: 'Details read from the policy document are filled in. Category, product and variant could not be read: choose or type them, then save.',
    });
    expect(policyReadMessage(null, true).messageId).toBe('POL-23');
    expect(policyReadMessage({}).messageId).toBe('POL-22');
  });
});