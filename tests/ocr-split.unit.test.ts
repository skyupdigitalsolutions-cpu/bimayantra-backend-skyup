/** Long brochures are sent to Document AI in parts of at most 15 pages (a synchronous request's limit). */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { OCR_PAGES_PER_REQUEST, splitPdf } from '../src/modules/documents/reader.js';

async function pdf(pages: number) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([200, 200]).drawText(`page ${i + 1}`);
  return Buffer.from(await d.save());
}

describe('splitting a brochure for OCR', () => {
  it('40 pages → parts of 15, 15 and 10 with their first page numbers', async () => {
    const parts = await splitPdf(await pdf(40), OCR_PAGES_PER_REQUEST);
    expect(parts.map((p) => p.firstPage)).toEqual([1, 16, 31]);
    const counts = await Promise.all(parts.map(async (p) => (await PDFDocument.load(p.bytes)).getPageCount()));
    expect(counts).toEqual([15, 15, 10]);
  });
  it('a short PDF, or one that cannot be opened, goes as it is', async () => {
    const short = await pdf(12);
    expect((await splitPdf(short, 15))).toEqual([{ firstPage: 1, bytes: short }]);
    const broken = Buffer.from('%PDF-1.4 not really');
    expect((await splitPdf(broken, 15))).toEqual([{ firstPage: 1, bytes: broken }]);
  });
});