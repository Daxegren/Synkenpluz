import { LedgerError, type Clock } from '../ports/index.js';
import { classifyHttpFailure, safePath, toLedgerError, type HttpFailureInput } from './errors.js';

/** Funktion som ger värdet för Authorization-headern. `invalidate` gör att klienten kan förnya vid 401. */
export type AuthHeaderSource = (() => Promise<string>) & {
  /** `staleHeader` är headern som nekades; ett redan förnyat token kastas inte i onödan. */
  invalidate?: (staleHeader?: string) => void;
};

export interface OAuth2Options {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Saknas det används client_credentials. */
  refreshToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  clock?: Clock | undefined;
  /** Förnya så här lång tid före utgång. Standard 60 s. */
  marginMs?: number | undefined;
  timeoutMs?: number | undefined;
  /** 'basic' (standard) eller 'body' för leverantörer som vill ha klientuppgifter i formuläret. */
  clientAuth?: 'basic' | 'body' | undefined;
  /** Används om svaret saknar expires_in. Standard 3600 s. */
  defaultExpiresInSec?: number | undefined;
  /**
   * Anropas när leverantören roterat refresh-token. Anroparen ansvarar för att spara det KRYPTERAT.
   * Det här modulen lagrar det aldrig i klartext på disk. Kastar callbacken försöker vi igen vid
   * nästa getAccessToken (det gamla tokenet är redan förbrukat).
   */
  onRefreshTokenRotated?: ((newToken: string) => void | Promise<void>) | undefined;
}

export interface OAuth2TokenProvider {
  getAccessToken(): Promise<string>;
  /** "Bearer <token>" */
  getAuthHeader(): Promise<string>;
  /** Kastar cachat token (om det är samma som `staleHeader`, när det anges) så nästa anrop förnyar. */
  invalidate(staleHeader?: string): void;
  /** Funktionsform för createHttpClient({ getAuthHeader }) med invalidate kopplad. */
  asAuthHeaderSource(): AuthHeaderSource;
}

const TOKEN_ERROR_CONTEXT = (tokenUrl: string) => {
  let path = '/';
  try {
    path = new URL(tokenUrl).pathname;
  } catch {
    // ogiltig URL fångas vid första anropet
  }
  return { method: 'POST', path: safePath(path) };
};

export function createOAuth2TokenProvider(options: OAuth2Options): OAuth2TokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? { now: () => new Date() };
  const marginMs = options.marginMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const clientAuth = options.clientAuth ?? 'basic';
  const ctx = TOKEN_ERROR_CONTEXT(options.tokenUrl);

  let refreshToken = options.refreshToken;
  let cached: { token: string; expiresAtMs: number } | undefined;
  let inflight: Promise<string> | undefined;
  /** Roterat token som callbacken ännu inte tagit emot. */
  let unpersisted: string | undefined;

  const fail = (input: HttpFailureInput): LedgerError => {
    const base = toLedgerError(classifyHttpFailure(input), {
      ...ctx,
      status: input.kind === 'status' ? input.status : undefined,
    });
    const message = `Tokenförnyelse misslyckades: ${base?.message ?? 'okänt fel'}`;
    // En förnyelse kan aldrig ha utfört ett bokföringskommando: notApplied alltid true.
    // 401 på tokenändpunkten betyder ogiltiga uppgifter/refresh-token och går inte att försöka om.
    return new LedgerError(message, base?.retryable ?? false, base?.retryAfterMs, true);
  };

  const persistRotation = async (): Promise<void> => {
    if (unpersisted === undefined) return;
    const token = unpersisted;
    try {
      await options.onRefreshTokenRotated?.(token);
      if (unpersisted === token) unpersisted = undefined;
    } catch {
      throw new LedgerError('Tokenförnyelse: det roterade refresh-tokenet kunde inte sparas', true, undefined, true);
    }
  };

  const refresh = async (): Promise<string> => {
    const form = new URLSearchParams();
    if (refreshToken !== undefined) {
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', refreshToken);
    } else {
      form.set('grant_type', 'client_credentials');
    }
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (clientAuth === 'basic') {
      headers.authorization = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`;
    } else {
      form.set('client_id', options.clientId);
      form.set('client_secret', options.clientSecret);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let status: number;
    let text: string;
    try {
      const res = await fetchImpl(options.tokenUrl, {
        method: 'POST',
        headers,
        body: form,
        redirect: 'manual',
        signal: controller.signal,
      });
      status = res.status;
      const retryAfter = res.headers.get('retry-after');
      if (status < 200 || status >= 300) {
        void res.body?.cancel().catch(() => undefined);
        throw fail({ kind: 'status', status, retryAfter, nowMs: clock.now().getTime() });
      }
      text = await readCapped(res, 1_000_000);
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      if (error instanceof TooLarge) throw fail({ kind: 'response-too-large' });
      throw fail({ kind: 'network', error, timedOut });
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw fail({ kind: 'invalid-response' });
    }
    const obj = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const accessToken = obj.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') throw fail({ kind: 'invalid-response' });
    const expiresIn =
      typeof obj.expires_in === 'number' && Number.isFinite(obj.expires_in) && obj.expires_in > 0
        ? obj.expires_in
        : (options.defaultExpiresInSec ?? 3600);

    cached = { token: accessToken, expiresAtMs: clock.now().getTime() + expiresIn * 1000 };

    const rotated = obj.refresh_token;
    if (typeof rotated === 'string' && rotated !== '' && rotated !== refreshToken) {
      refreshToken = rotated;
      unpersisted = rotated;
    }
    await persistRotation();
    return accessToken;
  };

  const getAccessToken = async (): Promise<string> => {
    if (cached && clock.now().getTime() < cached.expiresAtMs - marginMs) {
      await persistRotation(); // försök igen om en tidigare sparning misslyckades
      return cached.token;
    }
    // Alla samtidiga anropare delar ett enda förnyelseanrop.
    inflight ??= refresh().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  const invalidate = (staleHeader?: string): void => {
    if (!cached) return;
    if (staleHeader !== undefined && `Bearer ${cached.token}` !== staleHeader) return;
    cached = undefined;
  };

  const getAuthHeader = async () => `Bearer ${await getAccessToken()}`;

  return {
    getAccessToken,
    getAuthHeader,
    invalidate,
    asAuthHeaderSource() {
      const source: AuthHeaderSource = () => getAuthHeader();
      source.invalidate = invalidate;
      return source;
    },
  };
}

class TooLarge extends Error {}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
