import { describe, expect, it } from 'vitest';
import { matchFeatures } from '../src/modules/catalogue/ocr.service.js';

const FEATURES = [
  ['inpatient', 'In-patient hospitalisation', 'Yes/No'], ['pre', 'Pre-hospitalisation cover', 'Days'], ['post', 'Post-hospitalisation cover', 'Days'],
  ['daycare', 'Day-care procedures', 'Yes/No'], ['ayush', 'AYUSH treatment', 'Yes/No'], ['dom', 'Domiciliary treatment', 'Yes/No'],
  ['mat', 'Maternity cover', 'Yes/No'], ['nb', 'Newborn cover', 'Yes/No'], ['opd', 'OPD cover', 'Yes/No'], ['amb', 'Road ambulance', 'Amount in ₹'],
  ['iwp', 'Initial waiting period', 'Days'], ['ped', 'Pre-existing disease waiting period', 'Months'],
].map(([key, name, dataType]) => ({ key, name, dataType }));
// How an HDFC-style health brochure table reads after OCR (American spelling, joined words, values in the next cell).
const PAGE = `Benefits Summary
Inpatient Hospitalization  Covered up to Sum Insured
Pre-Hospitalization Medical Expenses  60 days
Post-Hospitalization Medical Expenses  180 days
Day Care Treatments  All day care procedures covered
AYUSH Benefit  Up to Sum Insured
Domiciliary Hospitalization
Emergency Ambulance  Rs. 2,000 per hospitalisation
New Born Baby  Covered from day 91
Initial Waiting Period: 30 days
Pre-existing Diseases  36 months of continuous coverage
Exclusions
Maternity expenses are not covered`;

describe('brochure features (Nov 2026: every feature read as Not stated)', () => {
  it('matches brochure wording to the template names', () => {
    const rows = Object.fromEntries(matchFeatures(FEATURES as never, [{ number: 2, text: PAGE, confidence: 0.95 }]).map((r) => [r.key, r.found ? r.value : null]));
    expect(rows).toMatchObject({ inpatient: 'Yes', pre: '60', post: '180', daycare: 'Yes', ayush: 'Yes', dom: 'Yes', nb: 'Yes', amb: '2000', iwp: '30', ped: '36', mat: 'No' });
    expect(rows.opd).toBeNull(); // not in the brochure: stays Not stated
  });
});