/**
 * npm run ocr:check <file> <PAN|Aadhaar|"Old policy">
 * Sends ONE local file to the configured Document AI processor and shows the fields found. Writes nothing.
 * PAN and Aadhaar numbers are printed masked, and the full OCR text is never printed (personal data).
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { env } from '../config/env.js';
import { masks } from '../lib/fields.js';
import { readDocument } from '../modules/documents/reader.js';

async function main() {
  // npm on Windows drops the quotes around a path, so "WhatsApp Image … PM.jpeg" arrives as several words.
  // The document type is the last word(s) when it is a known type; everything before it is the path.
  const args = process.argv.slice(2);
  const known = ['PAN', 'Aadhaar', 'Old policy'];
  let type = 'PAN';
  if (args.length >= 2 && args.slice(-2).join(' ').toLowerCase() === 'old policy') { type = 'Old policy'; args.splice(-2); }
  else if (args.length >= 2 && known.some((k) => k.toLowerCase() === args[args.length - 1]!.toLowerCase())) {
    type = known.find((k) => k.toLowerCase() === args[args.length - 1]!.toLowerCase())!; args.pop();
  }
  const path = args.join(' ');
  if (!path) throw new Error('Usage: npm run ocr:check <file> <PAN|Aadhaar|"Old policy">');
  if (env.DOCUMENT_READER !== 'google') throw new Error('Set DOCUMENT_READER=google (and the DOCUMENT_AI_* settings) in .env first.');
  const mime = ({ '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' } as Record<string, string>)[extname(path).toLowerCase()];
  if (!mime) throw new Error(`Use a .pdf, .png, .jpg or .jpeg file. Got: "${path}"${extname(path) ? '' : ' (no extension: Windows hides it; WhatsApp images end in .jpeg)'}`);
  console.log(`Document AI: project ${env.DOCUMENT_AI_PROJECT_ID}, location ${env.DOCUMENT_AI_LOCATION}, processor ${env.DOCUMENT_AI_PROCESSOR_ID}`);
  const started = Date.now();
  const out = await readDocument(type, await readFile(path), mime);
  console.log(`Read ${out?.text.length ?? 0} characters in ${Date.now() - started} ms.`);
  const v = { ...(out?.values ?? {}) } as Record<string, unknown>;
  if (typeof v.pan === 'string') v.pan = masks.pan(v.pan);
  if (typeof v.aadhaar === 'string') v.aadhaar = masks.aadhaar(v.aadhaar);
  console.log(Object.keys(v).length ? 'Fields found:' : 'No fields found (the check screen would open empty: DOC-10).');
  for (const [k, val] of Object.entries(v)) console.log(`  ${k}: ${Array.isArray(val) ? val.join(', ') : String(val)}`);
}

main().then(() => process.exit(0)).catch((e: Error) => { console.error(`\nOCR CHECK FAILED: ${e.message}`); process.exit(1); });