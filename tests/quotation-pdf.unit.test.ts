/** Quotation and comparison PDFs: ₹, ≥ and other characters the standard fonts cannot print no longer fail the PDF (QT-13). */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { printable, wrap } from '../src/lib/pdfText.js';
import { buildPdf as comparisonPdf } from '../src/modules/quotations/comparisons.service.js';
import { buildPdf as quotationPdf } from '../src/modules/quotations/quotations.service.js';

const ROWS = [
  ['Sum insured', [500000, 500000, 500000]],
  ['Room rent', ['No limit (actuals)', 'No limit (actuals)', 'No limit']],
  ['Restore benefit', ['Super Reload: 100% of base sum insured, unlimited times, from 2nd claim in policy life', 'Super Reload: 100% of base sum insured, unlimited times, from 2nd claim in policy life', 'Unlimited automatic recharge of base sum insured, unlimited times, same or unrelated illness']],
  ['Road ambulance', ['Up to sum insured', 'Up to sum insured', 'Up to sum insured if SI ≥ ₹15 lakh; up to ₹10,000 if SI below ₹15 lakh']],
  ['No-claim bonus', ['Super Credit: 100% of base sum insured a year irrespective of claims, up to 500% (max ₹3 crore)', 'Super Credit: 100% of base sum insured a year irrespective of claims, up to 500% (max ₹3 crore)', '50% of sum insured per year, up to 100%']],
  ['Key exclusions', ['Standard IRDAI exclusions Excl01–Excl18 incl. maternity', 'Standard IRDAI exclusions Excl01–Excl18 incl. maternity', 'Maternity; infertility; obesity; cosmetic surgery; hazardous sports; alcohol/drug abuse; refractive error; unproven treatments; non-medical items list']],
  ...Array.from({ length: 26 }, (_, i) => [`Feature ${i + 1}`, ['Yes', 'No', 'Not stated by insurer']]),
] as Array<[string, unknown[]]>;
const SNAP = {
  number: 'CQ-000004', date: '13-11-2026', customer: { name: 'ललित Lalit' },
  columns: [
    { productId: 'p1', name: 'Activ One MAX', insurer: 'Aditya Birla Health Insurance Co. Ltd.', uin: 'ADIHLIP25035V022425', agentCode: 'D-ABHI-28D2', premium: 32800, lowest: true, of: 1 },
    { productId: 'p2', name: 'Activ One MAX+', insurer: 'Aditya Birla Health Insurance Co. Ltd.', uin: 'ADIHLIP25036V022425', agentCode: 'D-ABHI-28D2', premium: 43800, of: 1 },
    { productId: 'p3', name: 'Care Supreme', insurer: 'Care Health Insurance Ltd.', uin: 'CHIHLIP27061V032627', agentCode: 'D-CARE-28D2', premium: 54800, of: 1 },
  ],
  rows: ROWS.map(([label, values]) => ({ label, values })),
  recommendedProductId: 'p1', recommendedReason: 'it is budget friendly and suitable for the user — premium under ₹35,000',
  advisor: { name: 'Shashi', businessName: 'SkyUp Insurance Advisory' },
  disclaimer: 'Premiums are indicative as on 13-11-2026 and subject to the insurer’s underwriting. Insurance is the subject matter of solicitation.',
};

describe('PDF text', () => {
  it('printable: ₹ → Rs., ≥ → >=, accents dropped, other scripts → ?', async () => {
    const f = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    expect(printable(f, 'max ₹3 crore, SI ≥ ₹15 lakh')).toBe('max Rs.3 crore, SI >= Rs.15 lakh');
    expect(printable(f, 'Café – “quoted” · 5%')).toBe('Café – “quoted” · 5%'); // all WinAnsi: kept
    expect(printable(f, 'ललित')).toBe('????');
    expect(printable(f, 'line\none')).toBe('line one');
    expect(printable(f, null)).toBe('');
  });
  it('wrap keeps every line inside the width', async () => {
    const f = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const lines = wrap(f, ROWS[4]![1][0], 8, 180);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => f.widthOfTextAtSize(l, 8) <= 180)).toBe(true);
    expect(wrap(f, 'x'.repeat(300), 8, 100).every((l) => f.widthOfTextAtSize(l, 8) <= 100)).toBe(true); // one long word is cut
    expect(wrap(f, 'Advisor: Shashi   Valid for 15 days', 8, 500)).toEqual(['Advisor: Shashi   Valid for 15 days']); // spacing kept
  });
});

describe('comparison PDF', () => {
  it('builds with ₹ and ≥ in feature text, a Hindi name and 32 rows; long tables continue on a second page', async () => {
    const pdf = await comparisonPdf(SNAP);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    if (process.env.PDF_OUT) (await import('node:fs')).writeFileSync(process.env.PDF_OUT, pdf);
  });
});

describe('quotation PDF', () => {
  it('builds with ₹ in an add-on and a benefit', async () => {
    const pdf = await quotationPdf({
      advisor: { businessName: 'SkyUp', name: 'Shashi', agentCode: 'D-CARE-28D2', licenceNumber: 'POSP-1' }, number: 'QT-000001', revision: 1, calculationDate: '13-11-2026',
      customer: { name: 'Lalit', number: 'CU-000002' }, people: [{ name: 'Lalit', age: 34 }], product: { name: 'Care Supreme', variantName: 'Standard', uin: 'CHIHLIP27061V032627' },
      insurer: { name: 'Care Health Insurance Ltd.' }, inputs: { sumInsured: 500000, policyTerm: 1 }, startDate: '14-11-2026',
      breakdown: { entryMode: 'TYPED', base: 46440, riders: [{ name: 'Room upgrade (up to ₹5,000/day)', amount: 1200 }], override: null, discount: 0, taxPercent: 18, tax: 8575, final: 56215 },
      benefits: [{ name: 'Free health check-up ≥ ₹2,000', showOnPdf: true, cost: 2000 }], disclaimer: SNAP.disclaimer,
    });
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });
});