import { LedgerError } from '../ports/index.js';
import { classifyHttpFailure, safePath, toLedgerError, type HttpFailureInput } from './errors.js';
import type { RateLimiter } from './rateLimiter.js';
import type { AuthHeaderSource } from './oauth.js';

export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface HttpClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string> | undefined;
  /** Gäller hela anropet inklusive läsning av svarskroppen. Standard 30 s. */
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  rateLimiter?: Pick<RateLimiter, 'acquire'> | undefined;
  /** Ger värdet för Authorization-headern. Om `invalidate` finns förnyas token en gång vid 401. */
  getAuthHeader?: AuthHeaderSource | undefined;
  maxResponseBytes?: number | undefined;
  /** Namn på idempotens-headern. Standard 'Idempotency-Key'. */
  idempotencyHeader?: string | undefined;
}

export type QueryValue = string | number | boolean | undefined;

export interface HttpRequest {
  method: string;
  /** Börjar med '/'. Läggs efter baseUrl. */
  path: string;
  query?: Record<string, QueryValue> | undefined;
  /** Objekt/array serialiseras som JSON; string och URLSearchParams skickas som de är. */
  body?: unknown;
  headers?: Record<string, string> | undefined;
  idempotencyKey?: string | undefined;
  /**
   * Statuskoder utöver 2xx som returneras i stället för att kasta (t.ex. [404] för en
   * "finns den redan?"-kontroll). 401 omfattas inte av tokenförnyelsen om den anges här.
   */
  acceptStatuses?: readonly number[] | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Tolkad JSON om content-type är JSON, annars undefined. */
  json: unknown;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

class ResponseTooLarge extends Error {}
class InvalidJson extends Error {}

function buildUrl(baseUrl: string, path: string, query: HttpRequest['query']): URL {
  if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('path måste börja med en enkel "/"');
  const base = new URL(baseUrl);
  const url = new URL(base.href.replace(/\/+$/, '') + path);
  if (url.origin !== base.origin) throw new TypeError('path pekar utanför baseUrl');
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function readBody(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
  }
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
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isJson(contentType: string | null): boolean {
  return contentType !== null && /(^|[/+;\s])json($|[;\s])/i.test(contentType);
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const idemHeader = options.idempotencyHeader ?? 'Idempotency-Key';
  new URL(options.baseUrl); // fel direkt vid konstruktion om baseUrl är ogiltig

  /** Ett försök. Kastar LedgerError vid transportfel; statusklassning görs av anroparen. */
  async function attempt(req: HttpRequest, authHeader: string | undefined): Promise<HttpResponse> {
    const ctx = { method: req.method, path: req.path };
    const wrap = (input: HttpFailureInput): LedgerError =>
      toLedgerError(classifyHttpFailure(input), ctx) as LedgerError;

    const headers = new Headers(options.defaultHeaders);
    headers.set('accept', 'application/json');
    if (authHeader !== undefined) headers.set('authorization', authHeader);
    let body: BodyInit | undefined;
    if (req.body !== undefined) {
      if (typeof req.body === 'string' || req.body instanceof URLSearchParams) {
        body = req.body;
      } else {
        body = JSON.stringify(req.body);
        headers.set('content-type', 'application/json');
      }
    }
    for (const [k, v] of Object.entries(req.headers ?? {})) headers.set(k, v);
    if (req.idempotencyKey !== undefined) headers.set(idemHeader, req.idempotencyKey);

    const url = buildUrl(options.baseUrl, req.path, req.query);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method: req.method.toUpperCase(),
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });
      const accepted = (res.status >= 200 && res.status < 300) || (req.acceptStatuses ?? []).includes(res.status);
      if (!accepted) {
        void res.body?.cancel().catch(() => undefined);
        return { status: res.status, headers: res.headers, json: undefined };
      }
      const text = await readBody(res, maxBytes);
      let json: unknown;
      if (text !== '' && isJson(res.headers.get('content-type'))) {
        try {
          json = JSON.parse(text);
        } catch {
          throw new InvalidJson();
        }
      }
      return { status: res.status, headers: res.headers, json };
    } catch (error) {
      if (error instanceof ResponseTooLarge) throw wrap({ kind: 'response-too-large' });
      if (error instanceof InvalidJson) throw wrap({ kind: 'invalid-response' });
      if (error instanceof LedgerError) throw error;
      // Medvetet ingen `cause`: underliggande fel kan innehålla URL:er med query.
      throw wrap({ kind: 'network', error, timedOut });
    } finally {
      clearTimeout(timer);
    }
  }

  async function getAuth(req: HttpRequest): Promise<string | undefined> {
    if (!options.getAuthHeader) return undefined;
    try {
      return await options.getAuthHeader();
    } catch (error) {
      if (error instanceof LedgerError) throw error;
      // Inre felmeddelanden kan innehålla hemligheter, så de tas inte med.
      throw new LedgerError(
        `${req.method.toUpperCase()} ${safePath(req.path)}: kunde inte hämta autentisering`,
        true,
        undefined,
        true,
      );
    }
  }

  return {
    async request(req) {
      const accept = req.acceptStatuses ?? [];
      for (let round = 0; ; round++) {
        await options.rateLimiter?.acquire();
        const authHeader = await getAuth(req);
        const response = await attempt(req, authHeader);
        const cls = classifyHttpFailure({
          kind: 'status',
          status: response.status,
          retryAfter: response.headers.get('retry-after'),
        });
        if (cls.kind === 'ok' || accept.includes(response.status)) return response;

        // 401: kommandot utfördes inte, så det är säkert att förnya token och göra om anropet EN gång.
        if (cls.authExpired && round === 0 && options.getAuthHeader?.invalidate) {
          options.getAuthHeader.invalidate(authHeader);
          continue;
        }
        throw toLedgerError(cls, { method: req.method, path: req.path, status: response.status }) as LedgerError;
      }
    },
  };
}
