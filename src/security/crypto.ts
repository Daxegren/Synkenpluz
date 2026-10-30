import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption av hemligheter (AES-256-GCM).
 *
 * Nycklarna hanteras av en KeyProvider. I drift ska den implementeras mot KMS/secret
 * manager; StaticKeyProvider är bara för test/dev.
 *
 * Blobformat (sträng): `v1.<keyId som base64url>.<nonce>.<chiffertext>.<tag>` där alla delar
 * utom versionen är base64url. Key id ligger i blobben så att gamla blobbar går att läsa efter
 * nyckelrotation. AAD (version, tenantId, connectionId, fält, key id) autentiseras men lagras inte.
 */

export interface KeyProvider {
  /** Id för nyckeln som används för nya krypteringar. */
  currentKeyId(): string;
  /** Hämtar nyckeln (32 byte) för ett id. Ska kasta om id:t är okänt. */
  getKey(keyId: string): Promise<Buffer>;
}

export interface SecretContext {
  tenantId: string;
  connectionId: string;
  /** Vilket fält som krypteras, t.ex. 'credentials'. */
  field: string;
}

export type CryptoErrorCode = 'invalid_key' | 'unknown_key' | 'invalid_blob' | 'decryption_failed';

/** Felmeddelanden är fasta och innehåller aldrig klartext, nyckelmaterial eller blob. */
export class CryptoError extends Error {
  constructor(readonly code: CryptoErrorCode) {
    super(
      {
        invalid_key: 'Ogiltig krypteringsnyckel (måste vara 32 byte)',
        unknown_key: 'Okänt nyckel-id',
        invalid_blob: 'Ogiltigt format på krypterad data',
        decryption_failed: 'Dekryptering misslyckades',
      }[code],
    );
    this.name = 'CryptoError';
  }
}

const VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export class StaticKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    keys: Readonly<Record<string, Buffer>>,
    private readonly current: string,
  ) {
    for (const [id, key] of Object.entries(keys)) {
      if (!KEY_ID_PATTERN.test(id)) throw new CryptoError('unknown_key');
      assertKey(key);
      this.keys.set(id, Buffer.from(key)); // kopia
    }
    if (!this.keys.has(current)) throw new CryptoError('unknown_key');
  }

  currentKeyId(): string {
    return this.current;
  }

  async getKey(keyId: string): Promise<Buffer> {
    const key = this.keys.get(keyId);
    if (!key) throw new CryptoError('unknown_key');
    return Buffer.from(key);
  }
}

function assertKey(key: unknown): asserts key is Buffer {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new CryptoError('invalid_key');
}

function buildAad(keyId: string, ctx: SecretContext): Buffer {
  // JSON-array av strängar är entydigt (ingen separatorkollision mellan fälten).
  return Buffer.from(JSON.stringify([VERSION, keyId, ctx.tenantId, ctx.connectionId, ctx.field]), 'utf8');
}

async function loadKey(provider: KeyProvider, keyId: string): Promise<Buffer> {
  let key: Buffer;
  try {
    key = await provider.getKey(keyId);
  } catch {
    throw new CryptoError('unknown_key');
  }
  assertKey(key);
  return key;
}

export async function encryptSecret(plaintext: string, provider: KeyProvider, aad: SecretContext): Promise<string> {
  const keyId = provider.currentKeyId();
  if (!KEY_ID_PATTERN.test(keyId)) throw new CryptoError('unknown_key');
  const key = await loadKey(provider, keyId);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad(keyId, aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, Buffer.from(keyId, 'utf8').toString('base64url'), nonce.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
}

export interface ParsedBlob {
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export function parseBlob(blob: string): ParsedBlob {
  if (typeof blob !== 'string') throw new CryptoError('invalid_blob');
  const parts = blob.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) throw new CryptoError('invalid_blob');
  const [, k, n, c, t] = parts as [string, string, string, string, string];
  const keyId = Buffer.from(k, 'base64url').toString('utf8');
  const nonce = Buffer.from(n, 'base64url');
  const tag = Buffer.from(t, 'base64url');
  if (!KEY_ID_PATTERN.test(keyId) || nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError('invalid_blob');
  }
  return { keyId, nonce, ciphertext: Buffer.from(c, 'base64url'), tag };
}

/** Key id som en blob är krypterad med (utan att dekryptera). */
export function blobKeyId(blob: string): string {
  return parseBlob(blob).keyId;
}

export async function decryptSecret(blob: string, provider: KeyProvider, aad: SecretContext): Promise<string> {
  const { keyId, nonce, ciphertext, tag } = parseBlob(blob);
  const key = await loadKey(provider, keyId);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAad(keyId, aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new CryptoError('decryption_failed');
  }
}
