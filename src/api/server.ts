import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OnboardingService } from '../db/onboarding.js';
import { registerWebUi } from '../web/serve.js';
import type {
  AuditLog,
  Clock,
  CommandRepository,
  ExceptionRepository,
  GatewayGuardStore,
  PayoutRepository,
  ProposalRepository,
  Repositories,
  StoredCommand,
  StoredException,
  StoredProposal,
  PayoutRecord,
  UnitOfWork,
} from '../ports/index.js';
import { RateLimiter, resolveRateLimitConfig, type RateLimitConfig } from './rateLimit.js';

export interface ApiDeps {
  exceptions: ExceptionRepository;
  payouts: PayoutRepository;
  commands: CommandRepository;
  /** Returnerar tenantId för en giltig API-nyckel, annars null. */
  authenticate: (apiKey: string) => Promise<string | null>;
  clock: Clock;
  /** Revisionslogg för mänskliga åtgärder via API:t. Bör alltid anges i drift. */
  audit?: AuditLog;
  /**
   * Gör en mänsklig åtgärd och dess revisionspost atomiskt: misslyckas loggningen rullas åtgärden
   * tillbaka. Utan den utförs de var för sig (bara för tester).
   */
  uow?: UnitOfWork;
  /**
   * Som `authenticate` men returnerar även nyckelns offentliga id. Har företräde när den finns, och id:t
   * hamnar då i revisionsposterna som `api:<nyckel-id>` (annars bara `api`).
   */
  authenticateDetailed?: (apiKey: string) => Promise<{ tenantId: string; keyId: string } | null>;
  /** Sparade dry_run-förslag. Saknas den finns inte /v1/proposals-rutterna (404). */
  proposals?: ProposalRepository;
  /** Journal över gateway-anrop med okänt utfall. Saknas den finns inte /v1/guard-rutterna (404). */
  guard?: GatewayGuardStore;
  /**
   * Ger en variant av `guard` som skriver i samma transaktion som `repos` (uow.run). Med den (och `uow`)
   * blir guard.resolve + revisionspost helt atomiskt. Utan den görs guard.resolve först och revisionsposten
   * direkt efter (inte atomiskt: misslyckas loggningen är avgörandet ändå sparat).
   */
  guardForUow?: (repos: Repositories) => GatewayGuardStore;
  /** Onboarding: checklista, godkännande av go-live och anslutningstest. Saknas den finns inte /v1/onboarding-rutterna (404). */
  onboarding?: OnboardingService;
  /** Kontrollerar att databasen svarar (kasta vid fel). Saknas den svarar /ready alltid 200. */
  ping?: () => Promise<void>;
  /** Bearer-token för /metrics. Saknas den, eller saknas `metrics`, finns rutten inte (404). */
  metricsToken?: string;
  /** Ger mätvärdena i Prometheus textformat (se src/db/metrics.ts). */
  metrics?: () => Promise<string>;
  /** Rate limiting. `false` stänger av. Delvis konfiguration slås ihop med standardvärdena. */
  rateLimit?: false | Partial<RateLimitConfig>;
  /** Största tillåtna body i byte. Standard 65 536. */
  bodyLimit?: number;
  /** Sätt true bakom en betrodd proxy så att klientens IP läses ur X-Forwarded-For (annars socketens adress). */
  trustProxy?: boolean;
  /** Katalog med webbgränssnittet (`web/`). Anges den levereras det på `/app`. Se src/web/serve.ts. */
  webRoot?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    /** `api:<nyckel-id>` när nyckelns id är känt, annars `api`. */
    actor: string;
  }
}

const MAX_KEY_LENGTH = 256;
const DEFAULT_BODY_LIMIT = 64 * 1024;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;
const MAX_PAGE_OFFSET = 1_000_000;
const READY_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------- fel

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

function rateLimited(retryAfterSec: number): HttpError {
  return new HttpError(429, 'rate_limited', 'För många anrop, försök igen senare', { 'retry-after': String(retryAfterSec) });
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ error: { code, message } });
}

// ---------------------------------------------------------------- scheman

const idParam = z.string().min(1).max(128);
const exceptionStatus = z.enum(['open', 'resolved', 'dismissed']);
const payoutStatus = z.enum(['rejected', 'partial', 'complete']);

const idParams = z.strictObject({ id: idParam });
const intParam = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, 'måste vara ett icke-negativt heltal')
    .transform(Number)
    .pipe(z.number().min(min, `måste vara minst ${min}`).max(max, `får vara högst ${max}`));
const pageShape = { limit: intParam(1, MAX_PAGE_LIMIT).optional(), offset: intParam(0, MAX_PAGE_OFFSET).optional() };

const exceptionsQuery = z.strictObject({ status: exceptionStatus.optional(), payoutId: idParam.optional(), ...pageShape });
const payoutsQuery = z.strictObject({ status: payoutStatus.optional(), ...pageShape });
const proposalsQuery = z.strictObject({ status: payoutStatus.optional(), ...pageShape });
const pageQuery = z.strictObject(pageShape);
const payoutIdParams = z.strictObject({ payoutId: idParam });
const guardResolveBody = z
  .strictObject({
    key: z.string().min(1).max(256),
    applied: z.boolean(),
    externalId: z.string().trim().min(1).max(128).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.applied && b.externalId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['externalId'], message: 'krävs när applied är true' });
    }
    if (!b.applied && b.externalId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['externalId'], message: 'får inte anges när applied är false' });
    }
  });
const goLiveBody = z.strictObject({ approvedProposalCount: z.number().int().min(0).max(1_000_000) });
const resolveBody = z.strictObject({
  status: z.enum(['resolved', 'dismissed']),
  note: z.string().trim().min(1, 'note får inte vara tom').max(2000, 'note får vara högst 2000 tecken'),
});

function parse<T extends z.ZodType>(schema: T, data: unknown, where: string): z.infer<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const details = r.error.issues
    .map((i) => `${i.path.length ? i.path.join('.') : where}: ${i.message}`)
    .join('; ');
  throw new HttpError(400, 'validation_error', `Ogiltig indata (${where}): ${details}`);
}

// ---------------------------------------------------------------- presentation (ingen intern/känslig data)

function presentException(e: StoredException) {
  return {
    id: e.id,
    payoutId: e.payoutId,
    code: e.code,
    lineId: e.lineId,
    message: e.message,
    status: e.status,
    resolutionNote: e.resolutionNote,
    createdAt: e.createdAt.toISOString(),
    resolvedAt: e.resolvedAt ? e.resolvedAt.toISOString() : null,
  };
}

function presentPayout(p: PayoutRecord) {
  return { payoutId: p.payoutId, status: p.status, processedAt: p.processedAt.toISOString() };
}

/** Utelämnar tenantId, idempotensnyckel, kommandoinnehåll (konton, belopp, fakturor), externt id och felmeddelanden. */
function presentCommand(c: StoredCommand) {
  return {
    id: c.id,
    kind: c.command.kind,
    status: c.status,
    attempts: c.attempts,
    nextAttemptAt: c.nextAttemptAt.toISOString(),
    hasError: c.lastError !== null,
  };
}

function presentProposalSummary(p: StoredProposal) {
  return {
    payoutId: p.payoutId,
    status: p.status,
    commandCount: p.result.commands.length,
    exceptionCount: p.result.exceptions.length,
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** Förslagets innehåll är det kunden ska granska. Idempotensnyckeln är intern och utelämnas. */
function presentProposal(p: StoredProposal) {
  return {
    ...presentProposalSummary(p),
    commands: p.result.commands.map(({ key: _key, ...rest }) => rest),
    exceptions: p.result.exceptions.map((e) => ({ code: e.code, lineId: e.lineId ?? null, message: e.message })),
  };
}

type Pagination = { limit?: number | undefined; offset?: number | undefined };

/** Hämtar limit+1 rader för att kunna avgöra hasMore. */
async function paginated<T, U>(
  q: Pagination,
  fetchRows: (limit: number, offset: number) => Promise<T[]>,
  present: (row: T) => U,
) {
  const limit = q.limit ?? DEFAULT_PAGE_LIMIT;
  const offset = q.offset ?? 0;
  const rows = await fetchRows(limit + 1, offset);
  return { items: rows.slice(0, limit).map(present), limit, offset, hasMore: rows.length > limit };
}

/** Sidindelning i minnet, för portar som ännu saknar limit/offset. */
function paginateInMemory<T, U>(all: T[], q: Pagination, present: (row: T) => U) {
  return paginated(q, async (limit, offset) => all.slice(offset, offset + limit), present);
}

const sha256 = (v: string): Buffer => createHash('sha256').update(v, 'utf8').digest();

/** Tidskonstant jämförelse (hashar först så att längden inte avslöjas). */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

type Repos = { exceptions: ExceptionRepository; commands: CommandRepository; audit: AuditLog | undefined };

/** Kör `fn` i en transaktion om en arbetsenhet finns, annars direkt mot repositorierna. */
function atomically<T>(deps: ApiDeps, fn: (repos: Repos) => Promise<T>): Promise<T> {
  if (deps.uow) return deps.uow.run((r) => fn({ exceptions: r.exceptions, commands: r.commands, audit: r.audit }));
  return fn({ exceptions: deps.exceptions, commands: deps.commands, audit: deps.audit });
}

// ---------------------------------------------------------------- server

export function buildServer(deps: ApiDeps): FastifyInstance {
  // Logger avstängd som standard: headers (x-api-key) ska aldrig hamna i loggar.
  const app = Fastify({
    logger: false,
    routerOptions: { maxParamLength: 256 },
    bodyLimit: deps.bodyLimit ?? DEFAULT_BODY_LIMIT,
    trustProxy: deps.trustProxy ?? false,
  });

  app.decorateRequest('tenantId', '');
  app.decorateRequest('actor', 'api');

  // Rate limiting. Alla hinkar delar injicerad klocka; minnet begränsas av RateLimiter.
  const rl = deps.rateLimit === false ? null : resolveRateLimitConfig(deps.rateLimit);
  const nowMs = () => deps.clock.now().getTime();
  const limiters = rl
    ? {
        perKey: new RateLimiter({ ...rl.perKey, now: nowMs, maxBuckets: rl.maxBuckets }),
        authFailure: new RateLimiter({ ...rl.perIpAuthFailure, now: nowMs, maxBuckets: rl.maxBuckets }),
        anonymous: new RateLimiter({ ...rl.perIpAnonymous, now: nowMs, maxBuckets: rl.maxBuckets }),
      }
    : null;

  // Öppna rutter (utom /health, som lastbalanserare anropar ofta) begränsas per IP.
  app.addHook('onRequest', async (request) => {
    if (!limiters) return;
    const path = request.url.split('?')[0] ?? '';
    if (path === '/health' || path === '/v1' || path.startsWith('/v1/')) return;
    const d = limiters.anonymous.take(request.ip);
    if (!d.allowed) throw rateLimited(d.retryAfterSec);
  });

  app.setErrorHandler((err: FastifyError | HttpError, request, reply) => {
    if (err instanceof HttpError) {
      if (err.headers) reply.headers(err.headers);
      return sendError(reply, err.statusCode, err.code, err.message);
    }
    const status = (err as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Fastifys egna klientfel (ogiltig JSON, för stor body, fel content-type).
      if (status === 400) return sendError(reply, 400, 'bad_request', 'Ogiltig begäran');
      if (status === 413) return sendError(reply, 413, 'payload_too_large', 'Begäran är för stor');
      if (status === 415) return sendError(reply, 415, 'unsupported_media_type', 'Innehållstypen stöds inte');
      return sendError(reply, status, 'request_error', 'Begäran kunde inte behandlas');
    }
    // Intern information läcks aldrig. Loggar bara felklass, inte meddelande/headers.
    request.log.error({ errName: err.name }, 'internal error');
    return sendError(reply, 500, 'internal_error', 'Internt fel');
  });

  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'not_found', 'Resursen finns inte'));

  app.get('/health', async () => ({ status: 'ok' }));

  if (deps.webRoot) registerWebUi(app, deps.webRoot);

  // Beredskap: databasen måste svara. Inga detaljer om orsaken lämnas ut.
  app.get('/ready', async (_request, reply) => {
    if (!deps.ping) return { status: 'ready' };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        deps.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  const metricsToken = deps.metricsToken;
  const metricsFn = deps.metrics;
  if (metricsToken !== undefined && metricsToken !== '' && metricsFn) {
    app.get('/metrics', async (request, reply) => {
      const header = request.headers.authorization;
      const m = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
      if (!m || !safeEqual(m[1] as string, metricsToken)) {
        reply.header('www-authenticate', 'Bearer');
        throw new HttpError(401, 'unauthorized', 'Token saknas eller är ogiltig');
      }
      const body = await metricsFn();
      return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(body);
    });
  }

  app.register(async (v1) => {
    v1.addHook('onRequest', async (request: FastifyRequest) => {
      const ip = request.ip;
      // Många misslyckade försök från samma IP stoppas innan nyckeln ens slås upp.
      if (limiters) {
        const blocked = limiters.authFailure.peek(ip);
        if (!blocked.allowed) throw rateLimited(blocked.retryAfterSec);
      }
      const reject = (): never => {
        if (limiters) {
          const d = limiters.authFailure.take(ip);
          if (!d.allowed) throw rateLimited(d.retryAfterSec);
        }
        throw new HttpError(401, 'unauthorized', 'API-nyckel saknas eller är ogiltig');
      };

      const header = request.headers['x-api-key'];
      if (typeof header !== 'string' || header.length === 0 || header.length > MAX_KEY_LENGTH) return reject();

      let tenantId: string | null;
      let keyId: string | undefined;
      if (deps.authenticateDetailed) {
        const r = await deps.authenticateDetailed(header);
        tenantId = r?.tenantId ?? null;
        keyId = r?.keyId;
      } else {
        tenantId = await deps.authenticate(header);
      }
      if (tenantId === null || tenantId === '') return reject();

      if (limiters) {
        const d = limiters.perKey.take(keyId ? `key:${keyId}` : `tenant:${tenantId}`);
        if (!d.allowed) throw rateLimited(d.retryAfterSec);
      }
      request.tenantId = tenantId;
      // Bara det offentliga id:t, aldrig nyckelns hemlighet.
      request.actor = keyId ? `api:${keyId}` : 'api';
    });

    v1.get('/exceptions', async (request) => {
      const q = parse(exceptionsQuery, request.query, 'query');
      return paginated(
        q,
        (limit, offset) => {
          const filter: { status?: z.infer<typeof exceptionStatus>; payoutId?: string; limit: number; offset: number } = { limit, offset };
          if (q.status !== undefined) filter.status = q.status;
          if (q.payoutId !== undefined) filter.payoutId = q.payoutId;
          return deps.exceptions.list(request.tenantId, filter);
        },
        presentException,
      );
    });

    v1.get('/exceptions/:id', async (request) => {
      const { id } = parse(idParams, request.params, 'path');
      const e = await deps.exceptions.get(request.tenantId, id);
      if (!e) throw new HttpError(404, 'not_found', 'Avvikelsen finns inte');
      return presentException(e);
    });

    v1.post('/exceptions/:id/resolve', async (request) => {
      const { id } = parse(idParams, request.params, 'path');
      const body = parse(resolveBody, request.body, 'body');
      const tenantId = request.tenantId;
      const now = deps.clock.now();

      const outcome = await atomically(deps, async (r) => {
        const existing = await r.exceptions.get(tenantId, id);
        if (!existing) return 'not_found' as const;
        if (!(await r.exceptions.resolve(tenantId, id, body, now))) return 'conflict' as const;
        // Anteckningen är fri text från en människa och loggas därför inte. Bara id och utfall.
        await r.audit?.append(
          { tenantId, actor: request.actor, action: 'exception.resolved', details: { exceptionId: id, status: body.status, code: existing.code } },
          now,
        );
        return 'ok' as const;
      });
      if (outcome === 'not_found') throw new HttpError(404, 'not_found', 'Avvikelsen finns inte');
      if (outcome === 'conflict') throw new HttpError(409, 'conflict', 'Avvikelsen är inte öppen');

      const updated = await deps.exceptions.get(tenantId, id);
      if (!updated) throw new HttpError(404, 'not_found', 'Avvikelsen finns inte');
      return presentException(updated);
    });

    v1.post('/commands/:id/retry', async (request) => {
      const { id } = parse(idParams, request.params, 'path');
      const tenantId = request.tenantId;
      const now = deps.clock.now();
      const ok = await atomically(deps, async (r) => {
        if (!(await r.commands.requeue(tenantId, id, now))) return false;
        await r.audit?.append({ tenantId, actor: request.actor, action: 'command.requeued', details: { commandId: id } }, now);
        return true;
      });
      if (!ok) throw new HttpError(409, 'conflict', 'Kommandot finns inte eller är inte permanent misslyckat');
      return { id, status: 'pending' };
    });

    v1.get('/payouts', async (request) => {
      const q = parse(payoutsQuery, request.query, 'query');
      return paginated(
        q,
        (limit, offset) => deps.payouts.list(request.tenantId, q.status !== undefined ? { status: q.status, limit, offset } : { limit, offset }),
        presentPayout,
      );
    });

    v1.get('/payouts/:id', async (request) => {
      const { id } = parse(idParams, request.params, 'path');
      const p = await deps.payouts.get(request.tenantId, id);
      if (!p) throw new HttpError(404, 'not_found', 'Utbetalningen finns inte');
      const cmds = await deps.commands.listByPayout(request.tenantId, id);
      return { ...presentPayout(p), commands: cmds.map(presentCommand) };
    });

    const proposals = deps.proposals;
    if (proposals) {
      v1.get('/proposals', async (request) => {
        const q = parse(proposalsQuery, request.query, 'query');
        const all = await proposals.list(request.tenantId, q.status !== undefined ? { status: q.status } : undefined);
        return paginateInMemory(all, q, presentProposalSummary);
      });

      v1.get('/proposals/:payoutId', async (request) => {
        const { payoutId } = parse(payoutIdParams, request.params, 'path');
        const p = await proposals.get(request.tenantId, payoutId);
        if (!p) throw new HttpError(404, 'not_found', 'Förslaget finns inte');
        return presentProposal(p);
      });
    }

    const onboarding = deps.onboarding;
    if (onboarding) {
      v1.get('/onboarding', async (request) => {
        const status = await onboarding.status(request.tenantId);
        if (!status) throw new HttpError(404, 'not_found', 'Kunden finns inte');
        return status;
      });

      v1.post('/onboarding/go-live', async (request) => {
        const body = parse(goLiveBody, request.body, 'body');
        const outcome = await onboarding.goLive(request.tenantId, body, request.actor);
        switch (outcome.result) {
          case 'ok':
            return { mode: 'live' };
          case 'not_found':
            throw new HttpError(404, 'not_found', 'Kunden finns inte');
          case 'already_live':
            throw new HttpError(409, 'already_live', 'Kunden bokför redan på riktigt');
          case 'not_ready':
            throw new HttpError(409, 'not_ready', `Onboardingen är inte klar: ${outcome.blockers.join(', ')}`);
          case 'stale_review':
            throw new HttpError(409, 'stale_review', `Antalet förslag har ändrats (nu ${outcome.proposalCount}). Granska igen innan du godkänner`);
        }
      });

      v1.post('/onboarding/check-connection', async (request) => {
        const check = await onboarding.checkConnection(request.tenantId);
        if (!check) throw new HttpError(404, 'not_found', 'Ingen leverantör av affärssystem är kopplad till tjänsten');
        return check;
      });
    }

    const guard = deps.guard;
    if (guard) {
      v1.get('/guard/in-doubt', async (request) => {
        const q = parse(pageQuery, request.query, 'query');
        const tenantId = request.tenantId;
        const all = (await guard.listInDoubt(tenantId)).filter((g) => g.tenantId === tenantId);
        return paginateInMemory(all, q, (g) => ({ key: g.key, startedAt: g.startedAt.toISOString() }));
      });

      v1.post('/guard/resolve', async (request) => {
        const body = parse(guardResolveBody, request.body, 'body');
        const tenantId = request.tenantId;
        const now = deps.clock.now();
        const outcome = body.applied ? { applied: true as const, externalId: body.externalId as string } : { applied: false as const };
        // Bara en kort checksumma av nyckeln och utfallet loggas: inga fritexter, inget externt id.
        const entry = {
          tenantId,
          actor: request.actor,
          action: 'guard.resolved',
          details: { keyRef: createHash('sha256').update(body.key, 'utf8').digest('hex').slice(0, 16), applied: body.applied },
        };

        let ok: boolean;
        if (deps.uow && deps.guardForUow) {
          // Helt atomiskt: avgörandet och revisionsposten skrivs i samma transaktion.
          const forUow = deps.guardForUow;
          ok = await deps.uow.run(async (r) => {
            if (!(await forUow(r).resolve(tenantId, body.key, outcome, now))) return false;
            await r.audit.append(entry, now);
            return true;
          });
        } else {
          // Utan guardForUow går guard-journalen inte att få med i transaktionen (en transaktion på en enda
          // anslutning skulle dessutom låsa sig). Avgörandet görs först, revisionsposten direkt efter.
          ok = await guard.resolve(tenantId, body.key, outcome, now);
          if (ok) await deps.audit?.append(entry, now);
        }
        if (!ok) throw new HttpError(409, 'conflict', 'Det finns inget osäkert anrop med den nyckeln');
        return { key: body.key, applied: body.applied, resolved: true };
      });
    }
  }, { prefix: '/v1' });

  return app;
}
