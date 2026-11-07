/**
 * Cloudinary storage driver (decision Q29), against a stand-in SDK: proves what is sent to Cloudinary.
 * The live round trip is `npm run storage:check` on a machine that can reach Cloudinary.
 */
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploads: Array<{ options: Record<string, unknown>; bytes: Buffer }> = [];
let nextResult: Record<string, unknown> = {};
vi.mock('cloudinary', () => ({
  v2: {
    config: vi.fn(),
    url: vi.fn((id: string, o: Record<string, unknown>) => `https://res.cloudinary.test/${o.type}/${o.resource_type}/s--sig--/${id}`),
    uploader: {
      upload_stream: (options: Record<string, unknown>, cb: (e: unknown, r: unknown) => void) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write(c, _e, done) { chunks.push(Buffer.from(c)); done(); },
          final(done) {
            const bytes = Buffer.concat(chunks);
            uploads.push({ options, bytes });
            cb(null, { public_id: options.public_id, bytes: bytes.length, ...nextResult });
            done();
          },
        });
      },
    },
  },
}));

const { cloudinaryStorage } = await import('../src/modules/files/storage.js');
const { v2: sdk } = await import('cloudinary');

beforeEach(() => { uploads.length = 0; nextResult = {}; });
afterEach(() => vi.unstubAllGlobals());

describe('Cloudinary storage driver', () => {
  it('uploads PRIVATE (authenticated), RAW (bytes kept exactly), never overwriting, in the configured folder', async () => {
    const bytes = Buffer.from('%PDF-1.4 test');
    await cloudinaryStorage.put('acc_x/fil_y', bytes);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.options).toMatchObject({ public_id: 'bimayantra-dev/acc_x/fil_y', asset_folder: 'bimayantra-dev/acc_x', resource_type: 'raw', type: 'authenticated', overwrite: false });
    expect(uploads[0]!.bytes.equals(bytes)).toBe(true);
  });

  it('treats an existing id as an error (never overwrite)', async () => {
    nextResult = { existing: true };
    await expect(cloudinaryStorage.put('acc_x/fil_y', Buffer.from('a'))).rejects.toThrow(/already exists/);
  });

  it('refuses a partial upload (stored size differs)', async () => {
    nextResult = { bytes: 3 };
    await expect(cloudinaryStorage.put('acc_x/fil_z', Buffer.from('abcdef'))).rejects.toThrow(/stored 3 bytes, expected 6/);
  });

  it('refuses unsafe keys', async () => {
    await expect(cloudinaryStorage.put('../etc/passwd', Buffer.from('a'))).rejects.toThrow(/invalid storage key/);
  });

  it('reads through a SIGNED authenticated URL, server-side', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from('hello')));
    vi.stubGlobal('fetch', fetchMock);
    const out = await cloudinaryStorage.get('acc_x/fil_y');
    expect(out.toString()).toBe('hello');
    expect(sdk.url).toHaveBeenCalledWith('bimayantra-dev/acc_x/fil_y', expect.objectContaining({ resource_type: 'raw', type: 'authenticated', sign_url: true }));
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/authenticated/raw/s--sig--/');
  });

  it('a failed read is an error, never empty content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(cloudinaryStorage.get('acc_x/fil_y')).rejects.toThrow(/HTTP 401/);
  });
});