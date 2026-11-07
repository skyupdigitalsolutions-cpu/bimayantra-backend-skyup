/**
 * npm run storage:check — live round trip against the configured FILE_STORAGE.
 *   1. uploads a small test file under <CLOUDINARY_FOLDER>/_storage-check/
 *   2. reads it back and compares the bytes
 *   3. (cloudinary) confirms the file is NOT reachable without a signed URL
 * Writes nothing to the database. Each run creates one tiny check file in the storage folder.
 */
import { createHash, randomBytes } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';
import { storage } from '../modules/files/storage.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function main() {
  console.log(`Storage: ${storage.name}${storage.name === 'cloudinary' ? ` (cloud ${env.CLOUDINARY_CLOUD_NAME}, folder ${env.CLOUDINARY_FOLDER}${env.CLOUDINARY_UPLOAD_PREFIX ? `, API ${env.CLOUDINARY_UPLOAD_PREFIX}` : ''})` : ` (${env.FILE_STORAGE_DIR})`}`);
  const key = `_storage_check/${Date.now()}_${randomBytes(4).toString('hex')}`;
  const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n% Bimayantra storage check\n'), randomBytes(64), Buffer.from('\n%%EOF\n')]);

  await storage.put(key, bytes);
  console.log('1. Upload ............... OK');
  const back = await storage.get(key);
  if (sha(back) !== sha(bytes)) throw new Error('Read-back bytes differ from what was uploaded.');
  console.log('2. Read back, identical . OK');
  try { await storage.put(key, Buffer.from('overwrite attempt')); throw new Error('An existing file was overwritten.'); }
  catch (e) { if ((e as Error).message.startsWith('An existing')) throw e; console.log('3. Overwrite refused .... OK'); }

  if (storage.name === 'cloudinary') {
    const unsigned = cloudinary.url(`${env.CLOUDINARY_FOLDER}/${key}`, { resource_type: 'raw', type: 'authenticated', secure: true });
    const res = await fetch(unsigned);
    if (res.ok) throw new Error(`The file is PUBLIC: ${unsigned} returned ${res.status}. Check the upload type.`);
    console.log(`4. Private (unsigned link refused with ${res.status}) OK`);
    console.log('\nAll storage checks passed. Confirm the storage region with Cloudinary (decision Q29).');
  } else {
    console.log('\nAll storage checks passed.');
  }
}

main().then(() => process.exit(0)).catch((e: Error) => { console.error(`\nSTORAGE CHECK FAILED: ${e.message}`); process.exit(1); });