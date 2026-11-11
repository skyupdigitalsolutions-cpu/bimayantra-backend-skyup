/**
 * Automatic reading of Aadhaar, PAN and old policies (P-18 step 5).
 *
 * google: Google Document AI's plain OCR processor turns the image into text; our own parsers (parsers.ts)
 * find the fields. No generative-AI extractor is used: P-18 forbids PAN and Aadhaar in AI requests.
 * The processor's location decides where images are processed: use asia-south1 (Mumbai), see OPEN-QUESTIONS Q33.
 */
import { v1 } from '@google-cloud/documentai';
import { env } from '../../config/env.js';
import { parseFor, type Parsed } from './parsers.js';

export const readerEnabled = () => env.DOCUMENT_READER !== 'none';

let client: InstanceType<typeof v1.DocumentProcessorServiceClient> | null = null;
function google() {
  client ??= new v1.DocumentProcessorServiceClient({
    apiEndpoint: `${env.DOCUMENT_AI_LOCATION}-documentai.googleapis.com`, // regional endpoint: processing stays in that region
    ...(env.DOCUMENT_AI_KEY_FILE ? { keyFilename: env.DOCUMENT_AI_KEY_FILE } : {}),
  });
  return client;
}

/** Plain OCR text of one file. */
export async function ocrText(bytes: Buffer, mimeType: string): Promise<string> {
  const name = `projects/${env.DOCUMENT_AI_PROJECT_ID}/locations/${env.DOCUMENT_AI_LOCATION}/processors/${env.DOCUMENT_AI_PROCESSOR_ID}`;
  // One call: at most 30 seconds and one retry. Google's default retries for minutes, and the user is waiting
  // on the check screen; a failure just means manual entry (DOC-10).
  const [result] = await google().processDocument(
    { name, rawDocument: { content: bytes.toString('base64'), mimeType }, skipHumanReview: true },
    { timeout: 30_000, maxRetries: 1 },
  );
  return result.document?.text ?? '';
}

/** Text and the fields found in it; null when no reader is set up. */
export async function readDocument(type: string, bytes: Buffer, mimeType: string): Promise<{ text: string; values: Parsed } | null> {
  if (env.DOCUMENT_READER === 'none') return null;
  const text = await ocrText(bytes, mimeType);
  return { text, values: parseFor(type, text) };
}

type OcrPage = { number: number; text: string; confidence: number };
/** Pages per Document AI request: a synchronous OCR request takes at most 15 pages, so longer PDFs are sent in parts. */
export const OCR_PAGES_PER_REQUEST = 15;

/**
 * P-23: OCR text page by page, with each page's confidence (0 to 1), for brochure reading. A PDF longer than
 * OCR_PAGES_PER_REQUEST is split into parts (pdf-lib), read two at a time, and joined back with the right page numbers.
 */
export async function ocrPages(bytes: Buffer, mimeType: string): Promise<{ text: string; pages: OcrPage[] }> {
  if (env.DOCUMENT_READER === 'none') throw new Error('No document reader is set up');
  if (mimeType === 'application/pdf') {
    const parts = await splitPdf(bytes, OCR_PAGES_PER_REQUEST);
    if (parts.length > 1) {
      const read: Array<{ text: string; pages: OcrPage[] }> = new Array(parts.length);
      for (let i = 0; i < parts.length; i += 2) {
        await Promise.all(parts.slice(i, i + 2).map(async (part, k) => { read[i + k] = await ocrOnce(part.bytes, mimeType); }));
      }
      const pages = read.flatMap((r, i) => r.pages.map((pg) => ({ ...pg, number: parts[i]!.firstPage + pg.number - 1 })));
      return { text: read.map((r) => r.text).join('\n'), pages };
    }
  }
  return ocrOnce(bytes, mimeType);
}

/** A PDF as parts of at most `size` pages (one part when it is short, or when it cannot be opened: Google decides). */
export async function splitPdf(bytes: Buffer, size: number): Promise<Array<{ firstPage: number; bytes: Buffer }>> {
  const { PDFDocument } = await import('pdf-lib');
  let src: Awaited<ReturnType<typeof PDFDocument.load>>;
  let count: number;
  try { src = await PDFDocument.load(bytes, { ignoreEncryption: true }); count = src.getPageCount(); } catch { return [{ firstPage: 1, bytes }]; }
  if (count <= size) return [{ firstPage: 1, bytes }];
  const parts: Array<{ firstPage: number; bytes: Buffer }> = [];
  for (let start = 0; start < count; start += size) {
    const out = await PDFDocument.create();
    const idx = Array.from({ length: Math.min(size, count - start) }, (_, i) => start + i);
    for (const pg of await out.copyPages(src, idx)) out.addPage(pg);
    parts.push({ firstPage: start + 1, bytes: Buffer.from(await out.save()) });
  }
  return parts;
}

async function ocrOnce(bytes: Buffer, mimeType: string): Promise<{ text: string; pages: OcrPage[] }> {
  const name = `projects/${env.DOCUMENT_AI_PROJECT_ID}/locations/${env.DOCUMENT_AI_LOCATION}/processors/${env.DOCUMENT_AI_PROCESSOR_ID}`;
  const [result] = await google().processDocument(
    { name, rawDocument: { content: bytes.toString('base64'), mimeType }, skipHumanReview: true },
    { timeout: 120_000, maxRetries: 1 },
  );
  const doc = result.document;
  const text = doc?.text ?? '';
  const pages = (doc?.pages ?? []).map((pg, i) => {
    const segs = pg.layout?.textAnchor?.textSegments ?? [];
    const t = segs.map((sg) => text.slice(Number(sg.startIndex ?? 0), Number(sg.endIndex ?? 0))).join('');
    return { number: Number(pg.pageNumber ?? i + 1), text: t, confidence: Number(pg.layout?.confidence ?? 0.9) };
  });
  return { text, pages: pages.length ? pages : [{ number: 1, text, confidence: 0.9 }] };
}