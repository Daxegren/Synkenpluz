import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../ports/index.js';

/**
 * API-nycklar: `synk_<id>_<hemlighet>` där id är 12 hex-tecken (offentligt, används för uppslag,
 * revision och loggning) och hemligheten är 32 slumpbyte base64url (43 tecken).
 * Bara HMAC-SHA256(pepper, hela nyckeln) lagras, som hex. Pepparn ligger i secret manager,
 * inte i databasen, så ett databasläckage ensamt räcker inte för att verifiera gissningar.
 * Nycklarna har hög entropi, så en snabb hash är lämplig (ingen lösenordshash behövs).
 */

export const API_KEY_PREFIX = 'synk_';
const ID_HEX_LEN = 12;
const SECRET_LEN = 43; // 32 byte base64url utan padding
const KEY_RE = new RegExp(`^synk_([0-9a-f]{${ID_HEX_LEN}})_([A-Za-z0-9_-]{${SECRET_LEN}})$`);
const MIN_PEPPER_BYTES = 32;

/**
 * Roller, i stigande ordning. viewer läser. operator hanterar även avvikelser, köar om kommandon och avgör osäkra
 * anrop. approver godkänner även att kunden går live. Nya nycklar får operator om inget annat anges.
 */
export const API_KEY_ROLES = ['viewer', 'operator', 'approver'] as const;
export type ApiKeyRole = (typeof API_KEY_ROLES)[number];
export const DEFAULT_API_KEY_ROLE: ApiKeyRole = 'operator';

export function isApiKeyRole(value: unknown): value is ApiKeyRole {
  return typeof value === 'string' && (API_KEY_ROLES as readonly string[]).includes(value);
}

/** Har `role` minst rollen `minimum`? */
export function hasRole(role: ApiKeyRole, minimum: ApiKeyRole): boolean {
  return API_KEY_ROLES.indexOf(role) >= API_KEY_ROLES.indexOf(minimum);
}

export interface GeneratedApiKey {
  /** Offentligt id, säkert att logga. */
  id: string;
  /** Visas för kunden en enda gång, lagras aldrig. */
  rawKey: string;
  /** Det som lagras. */
  hash: string;
}

function assertPepper(pepper: Buffer): void {
  if (!Buffer.isBuffer(pepper) || pepper.length < MIN_PEPPER_BYTES) {
    throw new Error(`Pepper måste vara minst ${MIN_PEPPER_BYTES} byte`);
  }
}

export function hashApiKey(rawKey: string, pepper: Buffer): string {
  assertPepper(pepper);
  return createHmac('sha256', pepper).update(rawKey, 'utf8').digest('hex');
}

export function generateApiKey(pepper: Buffer): GeneratedApiKey {
  const id = randomBytes(ID_HEX_LEN / 2).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const rawKey = `${API_KEY_PREFIX}${id}_${secret}`;
  return { id, rawKey, hash: hashApiKey(rawKey, pepper) };
}

/** Plockar ut det offentliga id:t, eller null om formatet inte stämmer. */
export function parseApiKeyId(rawKey: string): string | null {
  const m = KEY_RE.exec(rawKey);
  return m ? (m[1] as string) : null;
}

export function verifyApiKey(rawKey: string, storedHash: string, pepper: Buffer): boolean {
  const actual = Buffer.from(hashApiKey(rawKey, pepper), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(actual, expected);
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  hash: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  tenantStatus: 'active' | 'suspended';
  role: ApiKeyRole;
}

export interface ApiKeyStore {
  findById(id: string): Promise<ApiKeyRecord | null>;
  touchLastUsed(id: string, now: Date): Promise<void>;
}

// Används för att göra jämförelsen lika dyr när nyckeln inte finns.
const DUMMY_HASH = '0'.repeat(64);

export interface AuthenticatedKey {
  tenantId: string;
  /** Nyckelns offentliga id (aldrig hemligheten). Säkert att logga och skriva i revisionsposter. */
  keyId: string;
  role: ApiKeyRole;
}

export interface AuthenticatorDeps {
  store: ApiKeyStore;
  pepper: Buffer;
  clock: Clock;
}

/** Som createAuthenticator men returnerar även nyckelns offentliga id, så att revisionen kan ange vilken nyckel som användes. */
export function createDetailedAuthenticator(deps: AuthenticatorDeps): (rawKey: string) => Promise<AuthenticatedKey | null> {
  assertPepper(deps.pepper);
  return async (rawKey) => {
    const id = typeof rawKey === 'string' ? parseApiKeyId(rawKey) : null;
    if (id === null) return null;
    const record = await deps.store.findById(id);
    const ok = verifyApiKey(rawKey, record?.hash ?? DUMMY_HASH, deps.pepper);
    if (!record || !ok) return null;
    const now = deps.clock.now();
    if (record.revokedAt !== null) return null;
    if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) return null;
    if (record.tenantStatus !== 'active') return null;
    await deps.store.touchLastUsed(record.id, now);
    return { tenantId: record.tenantId, keyId: record.id, role: record.role };
  };
}

/** Bygger `authenticate` som matchar ApiDeps i src/api/server.ts. Returnerar tenantId eller null. */
export function createAuthenticator(deps: AuthenticatorDeps): (rawKey: string) => Promise<string | null> {
  const detailed = createDetailedAuthenticator(deps);
  return async (rawKey) => (await detailed(rawKey))?.tenantId ?? null;
}
