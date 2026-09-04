/**
 * Object Store — pluggable large-file storage for trace I/O.
 *
 * Backends (selected by OBJECT_STORE_PROVIDER env, default 'fs'):
 *   - fs:  local filesystem under DATA_DIR (default; PVC-mounted in K8s).
 *   - s3:  S3-compatible object store (MinIO / AWS S3). Lazy-imports
 *          @aws-sdk/client-s3 at runtime via a VARIABLE import name so tsc
 *          does not resolve it; install the package (optionalDependency)
 *          when the s3 backend is selected, otherwise put/get throw clearly.
 *
 * Write path (offloadLargeIo) stays SYNCHRONOUS for the fs backend (deterministic,
 * immediately available) and uses a fire-and-forget async put for s3 (the DB
 * output_ref is set to the deterministic s3:// ref upfront; the object lands in
 * S3 within ~100ms, well before any later trace replay). Read path (HTTP route)
 * is async either way.
 *
 * The stored `output_ref` is an opaque string: an absolute fs path (fs backend)
 * or `s3://<bucket>/<key>` (s3 backend). Both write & read go through here so the
 * two ends stay symmetric (see issue: trace read/write path mismatch).
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export type ObjectStoreProvider = 'fs' | 's3';

export const objectStoreProvider: ObjectStoreProvider =
  (process.env.OBJECT_STORE_PROVIDER as ObjectStoreProvider) || 'fs';

const S3_BUCKET = process.env.S3_BUCKET || 'deepthink';
const S3_ENDPOINT = process.env.S3_ENDPOINT || ''; // e.g. http://minio:9000
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== 'false'; // MinIO needs true

/** True when the S3 backend is selected. fs is the default. */
export const isS3Enabled = objectStoreProvider === 's3' && !!S3_ENDPOINT;

interface S3Handle { client: any; mod: any; }
let _s3Handle: S3Handle | null = null;
let _s3ImportAttempted = false;

/**
 * Lazy-load @aws-sdk/client-s3. The module name is held in a variable so tsc's
 * module resolution cannot statically resolve it — the package is an
 * optionalDependency and may be absent in fs-only deployments.
 */
async function loadS3(): Promise<S3Handle> {
  if (_s3Handle) return _s3Handle;
  if (_s3ImportAttempted) throw new Error('S3 client unavailable (see prior error)');
  _s3ImportAttempted = true;
  try {
    const modName = '@aws-sdk/client-s3';
    const mod = await import(modName);
    _s3Handle = {
      mod,
      client: new mod.S3Client({
        endpoint: S3_ENDPOINT,
        region: S3_REGION,
        forcePathStyle: S3_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
        },
      }),
    };
    return _s3Handle;
  } catch (err) {
    logger.error({ err }, 'Failed to load @aws-sdk/client-s3 — install it for the S3 backend');
    throw err;
  }
}

/**
 * Build the object-store ref for a trace I/O blob. Deterministic so write &
 * read agree without coordination.
 */
export function buildTraceIoRef(traceId: string, spanId: string, side: 'in' | 'out'): string {
  const key = `trace-io/${traceId}/${spanId}.${side}.json`;
  if (isS3Enabled) return `s3://${S3_BUCKET}/${key}`;
  return join(DATA_DIR, 'trace-io', traceId, `${spanId}.${side}.json`);
}

/**
 * Put a trace I/O blob.
 * - fs backend: synchronous write (returns immediately, file on disk).
 * - s3 backend: fire-and-forget async upload; the ref is already deterministic.
 */
export function putTraceIo(
  ref: string,
  content: string,
  _traceId: string,
): void {
  if (isS3Enabled) {
    const key = ref.replace(`s3://${S3_BUCKET}/`, '');
    // Fire-and-forget; errors logged, do not block the sync persist path.
    loadS3()
      .then(async ({ client, mod }) => {
        await client.send(new mod.PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: content,
          ContentType: 'application/json',
        }));
      })
      .catch((err: unknown) => {
        logger.warn({ err, ref }, 'S3 putObject failed for trace I/O');
      });
    return;
  }
  // fs: ensure parent dir, sync write (current behavior).
  mkdirSync(dirname(ref), { recursive: true });
  writeFileSync(ref, content, 'utf8');
}

/**
 * Read a trace I/O blob by ref. Async (HTTP route caller awaits).
 * - fs backend: synchronous readFileSync wrapped in a resolved promise.
 * - s3 backend: GetObject → Body.transformToString.
 */
export async function getTraceIo(ref: string): Promise<string> {
  if (ref.startsWith('s3://')) {
    const { client, mod } = await loadS3();
    const key = ref.replace(`s3://${S3_BUCKET}/`, '');
    const resp = await client.send(new mod.GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return resp.Body.transformToString('utf8');
  }
  return readFileSync(ref, 'utf8');
}
