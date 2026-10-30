import { LedgerError } from '../ports/index.js';

/**
 * Enda stället som översätter HTTP-utfall till LedgerError. Adaptrar ska inte duplicera den här logiken.
 *
 * Semantiken bygger på frågan "kan kommandot ha utförts?":
 *   notApplied = true  -> det är SÄKERT att inget utfördes (säkert att försöka igen utan dubblettrisk)
 *   notApplied = false -> utfallet är okänt (kan ha utförts)
 *
 * Tabell (låst av test/http/errors.test.ts):
 *
 *   Utfall                                          | retryable | notApplied | Övrigt
 *   ------------------------------------------------+-----------+------------+--------------------------
 *   2xx                                             | (ok)      |            | inget fel
 *   400, 403, 404, 409, 422                         | false     | true       |
 *   401                                             | false     | true       | authExpired = true
 *   övriga 4xx (t.ex. 405, 410, 413)                | false     | true       |
 *   408, 425                                        | true      | false      | okänt utfall
 *   429                                             | true      | true       | retryAfterMs från Retry-After
 *   5xx                                             | true      | false      | okänt; 503 läser Retry-After
 *   3xx (omdirigering följs aldrig)                 | false     | false      |
 *   ECONNREFUSED, ENOTFOUND, EAI_AGAIN,             | true      | true       | ingen anslutning upprättades
 *     ENETUNREACH, EHOSTUNREACH, UND_ERR_CONNECT_TIMEOUT
 *   timeout (vår AbortController)                   | true      | false      |
 *   ECONNRESET, EPIPE, avbruten under svar,         | true      | false      |
 *     övriga okända nätverksfel
 *   svar större än maxgränsen                       | false     | false      | svaret fanns, utfallet okänt
 *   ogiltig JSON i ett 2xx-svar                     | false     | false      |
 *
 * Retry-After: heltal sekunder eller HTTP-datum. Ogiltigt, negativt, NaN eller datum i det förflutna
 * ignoreras. Tak 1 timme.
 *
 * Hemligheter: felmeddelanden byggs ENBART av metod + path utan query/fragment + statuskod/kategori.
 * Svarskroppar, headers och underliggande fel (cause) tas aldrig med.
 */

export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export type FailureCategory =
  | 'client-error'
  | 'unauthorized'
  | 'request-timeout'
  | 'rate-limited'
  | 'server-error'
  | 'redirect'
  | 'no-connection'
  | 'timeout'
  | 'connection-lost'
  | 'response-too-large'
  | 'invalid-response';

export type HttpClassification =
  | { kind: 'ok' }
  | {
      kind: 'failure';
      category: FailureCategory;
      retryable: boolean;
      notApplied: boolean;
      retryAfterMs?: number;
      /** true vid 401: anroparen kan förnya token och försöka en gång till. */
      authExpired: boolean;
    };

export type HttpFailureInput =
  | { kind: 'status'; status: number; retryAfter?: string | null | undefined; nowMs?: number | undefined }
  | { kind: 'network'; error: unknown; timedOut?: boolean | undefined }
  | { kind: 'response-too-large' }
  | { kind: 'invalid-response' };

/** Tolkar Retry-After. Returnerar millisekunder eller undefined om värdet är ogiltigt. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) {
    const ms = Number(text) * 1000;
    return Number.isFinite(ms) ? Math.min(ms, MAX_RETRY_AFTER_MS) : MAX_RETRY_AFTER_MS;
  }
  // HTTP-datum (IMF-fixdate, RFC 850 eller asctime). Kräver veckodag och klockslag så att
  // lösa tolkningar av skräp inte släpps igenom.
  if (/^[A-Za-z]{3,9},? .*\d{1,2}:\d{2}:\d{2}/.test(text)) {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return undefined;
    const delta = at - nowMs;
    if (!(delta >= 0)) return undefined;
    return Math.min(delta, MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

const NO_CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Letar efter ett felkodsfält i felet och dess cause-kedja (fetch lägger koden i cause). */
export function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function failure(
  category: FailureCategory,
  retryable: boolean,
  notApplied: boolean,
  retryAfterMs?: number,
  authExpired = false,
): HttpClassification {
  return {
    kind: 'failure',
    category,
    retryable,
    notApplied,
    authExpired,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

export function classifyHttpFailure(input: HttpFailureInput): HttpClassification {
  switch (input.kind) {
    case 'response-too-large':
      return failure('response-too-large', false, false);
    case 'invalid-response':
      return failure('invalid-response', false, false);
    case 'network': {
      if (input.timedOut) return failure('timeout', true, false);
      const code = errorCode(input.error);
      if (code !== undefined && NO_CONNECTION_CODES.has(code)) return failure('no-connection', true, true);
      const name = input.error instanceof Error ? input.error.name : '';
      if (name === 'TimeoutError') return failure('timeout', true, false);
      // ECONNRESET, avbrutet svar och allt okänt: begäran kan ha nått fram.
      return failure('connection-lost', true, false);
    }
    case 'status': {
      const s = input.status;
      if (s >= 200 && s < 300) return { kind: 'ok' };
      if (s === 401) return failure('unauthorized', false, true, undefined, true);
      if (s === 408 || s === 425) return failure('request-timeout', true, false);
      if (s === 429) {
        return failure('rate-limited', true, true, parseRetryAfter(input.retryAfter, input.nowMs));
      }
      if (s >= 400 && s < 500) return failure('client-error', false, true);
      if (s >= 500) {
        const ra = s === 503 ? parseRetryAfter(input.retryAfter, input.nowMs) : undefined;
        return failure('server-error', true, false, ra);
      }
      // 1xx/3xx: följs aldrig automatiskt, utfallet är oklart.
      return failure('redirect', false, false);
    }
  }
}

/** LedgerError med extra fält. Meddelandet innehåller aldrig hemligheter. */
export class HttpLedgerError extends LedgerError {
  readonly category: FailureCategory;
  readonly status: number | undefined;
  /** true vid 401: token kan förnyas. */
  readonly authExpired: boolean;

  constructor(
    message: string,
    c: Extract<HttpClassification, { kind: 'failure' }>,
    status?: number,
  ) {
    super(message, c.retryable, c.retryAfterMs, c.notApplied);
    this.name = 'HttpLedgerError';
    this.category = c.category;
    this.status = status;
    this.authExpired = c.authExpired;
  }
}

/** Path utan query och fragment. Query kan innehålla token och får aldrig loggas. */
export function safePath(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

const DESCRIPTIONS: Record<FailureCategory, string> = {
  'client-error': 'avvisades',
  unauthorized: 'nekades (autentisering krävs)',
  'request-timeout': 'tog för lång tid enligt servern',
  'rate-limited': 'begränsades (för många anrop)',
  'server-error': 'serverfel',
  redirect: 'oväntat svar (omdirigering)',
  'no-connection': 'ingen anslutning kunde upprättas',
  timeout: 'svarade inte i tid',
  'connection-lost': 'anslutningen bröts',
  'response-too-large': 'svaret var för stort',
  'invalid-response': 'svaret kunde inte tolkas',
};

/**
 * Bygger LedgerError av en klassning. Returnerar undefined för ok.
 * `context.path` får innehålla query, den tas bort.
 */
export function toLedgerError(
  classification: HttpClassification,
  context: { method: string; path: string; status?: number | undefined },
): HttpLedgerError | undefined {
  if (classification.kind === 'ok') return undefined;
  const status = context.status !== undefined ? ` (HTTP ${context.status})` : '';
  const message = `${context.method.toUpperCase()} ${safePath(context.path)}: ${DESCRIPTIONS[classification.category]}${status}`;
  return new HttpLedgerError(message, classification, context.status);
}

/** Genväg: klassa och bygg fel i ett steg. */
export function failureToLedgerError(
  input: HttpFailureInput,
  context: { method: string; path: string },
): HttpLedgerError | undefined {
  return toLedgerError(classifyHttpFailure(input), {
    ...context,
    status: input.kind === 'status' ? input.status : undefined,
  });
}
