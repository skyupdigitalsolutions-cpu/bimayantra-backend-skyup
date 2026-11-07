import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { v2 as cloudinary } from 'cloudinary';
import { env } from '../../config/env.js';

/**
 * Storage driver. Only `put` and `get`: there is deliberately no delete or overwrite.
 * The API is the only door to a file: storage locations are never sent to browsers, and every read is
 * re-checked against the SHA-256 recorded at upload (files.service.ts) to detect tampering.
 */
export interface Storage {
  readonly name: string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

function checkKey(key: string) {
  if (!/^[a-z0-9_/]+$/.test(key)) throw new Error('invalid storage key');
}

// ── local: development only ─────────────────────────────────────────────────
const root = () => resolve(env.FILE_STORAGE_DIR);
function localPath(key: string) {
  checkKey(key);
  const p = resolve(join(root(), key));
  if (!p.startsWith(root())) throw new Error('storage key escapes the storage folder');
  return p;
}
export const localStorage: Storage = {
  name: 'local',
  async put(key, bytes) {
    const p = localPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes, { flag: 'wx' }); // never overwrite
  },
  async get(key) {
    return readFile(localPath(key));
  },
};

// ── cloudinary ──────────────────────────────────────────────────────────────
/**
 * Files are uploaded as resource_type "raw" (bytes kept exactly: no resizing, re-encoding or format
 * conversion, and PDFs are not subject to Cloudinary's PDF delivery restriction) with type "authenticated",
 * so they cannot be fetched without a signed URL. overwrite:false; an existing id is treated as an error.
 */
let configured = false;
function client() {
  if (!configured) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET,
      secure: true, ...(env.CLOUDINARY_UPLOAD_PREFIX ? { upload_prefix: env.CLOUDINARY_UPLOAD_PREFIX } : {}),
    });
    configured = true;
  }
  return cloudinary;
}
const publicId = (key: string) => { checkKey(key); return `${env.CLOUDINARY_FOLDER}/${key}`; };

export const cloudinaryStorage: Storage = {
  name: 'cloudinary',
  async put(key, bytes) {
    const id = publicId(key);
    // asset_folder: accounts with Cloudinary "dynamic folders" (the default for newer accounts) show an asset
    // in the Media Library folder named here, NOT the path inside its public_id. Without it, every file
    // appears at Home instead of under CLOUDINARY_FOLDER. Accounts with fixed folders ignore it.
    const folder = id.slice(0, id.lastIndexOf('/'));
    const result = await new Promise<{ existing?: boolean; public_id: string; bytes: number }>((ok, fail) => {
      const up = client().uploader.upload_stream(
        { public_id: id, asset_folder: folder, resource_type: 'raw', type: 'authenticated', overwrite: false, unique_filename: false, use_filename: false, invalidate: false },
        (error, res) => (error || !res ? fail(error ?? new Error('Cloudinary returned no result')) : ok(res as never)),
      );
      Readable.from(bytes).pipe(up);
    });
    if (result.existing) throw new Error(`storage key already exists: ${id}`); // never overwrite
    if (result.bytes !== bytes.length) throw new Error(`Cloudinary stored ${result.bytes} bytes, expected ${bytes.length}`);
  },
  async get(key) {
    const url = client().url(publicId(key), { resource_type: 'raw', type: 'authenticated', sign_url: true, secure: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Cloudinary read failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
};

export const storage: Storage = {
  get name() { return env.FILE_STORAGE; },
  put: (key, bytes) => (env.FILE_STORAGE === 'cloudinary' ? cloudinaryStorage : localStorage).put(key, bytes),
  get: (key) => (env.FILE_STORAGE === 'cloudinary' ? cloudinaryStorage : localStorage).get(key),
};