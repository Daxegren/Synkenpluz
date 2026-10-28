import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AuditLog,
  Clock,
  CommandRepository,
  ExceptionRepository,
  PayoutRepository,
  StoredCommand,
  StoredException,
  PayoutRecord,
  UnitOfWork,
} from '../ports/index.js';

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
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

const MAX_KEY_LENGTH = 256;

// ---------------------------------------------------------------- fel

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ error: { code, message } });
}

// ---------------------------------------------------------------- scheman

const idParam = z.string().min(1).max(128);
const exceptionStatus = z.enum(['open', 'resolved', 'dismissed']);
const payoutStatus = z.enum(['rejected', 'partial', 'complete']);

const idParams = z.strictObject({ id: idParam });
const exceptionsQuery = z.strictObject({ status: exceptionStatus.optional(), payoutId: idParam.optional() });
const payoutsQuery = z.strictObject({ status: payoutStatus.optional() });
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

type Repos = { exceptions: ExceptionRepository; commands: CommandRepository; audit: AuditLog | undefined };

/** Kör `fn` i en transaktion om en arbetsenhet finns, annars direkt mot repositorierna. */
function atomically<T>(deps: ApiDeps, fn: (repos: Repos) => Promise<T>): Promise<T> {
  if (deps.uow) return deps.uow.run((r) => fn({ exceptions: r.exceptions, commands: r.commands, audit: r.audit }));
  return fn({ exceptions: deps.exceptions, commands: deps.commands, audit: deps.audit });
}

// ---------------------------------------------------------------- server

export function buildServer(deps: ApiDeps): FastifyInstance {
  // Logger avstängd som standard: headers (x-api-key) ska aldrig hamna i loggar.
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 256 } });

  app.decorateRequest('tenantId', '');

  app.setErrorHandler((err: FastifyError | HttpError, request, reply) => {
    if (err instanceof HttpError) return sendError(reply, err.statusCode, err.code, err.message);
    const status = (err as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Fastifys egna klientfel (ogiltig JSON, för stor body, fel content-type).
      const code = status === 400 ? 'bad_request' : 'request_error';
      return sendError(reply, status, code, status === 400 ? 'Ogiltig begäran' : 'Begäran kunde inte behandlas');
    }
    // Intern information läcks aldrig. Loggar bara felklass, inte meddelande/headers.
    request.log.error({ errName: err.name }, 'internal error');
    return sendError(reply, 500, 'internal_error', 'Internt fel');
  });

  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'not_found', 'Resursen finns inte'));

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(async (v1) => {
    v1.addHook('onRequest', async (request: FastifyRequest) => {
      const header = request.headers['x-api-key'];
      if (typeof header !== 'string' || header.length === 0 || header.length > MAX_KEY_LENGTH) {
        throw new HttpError(401, 'unauthorized', 'API-nyckel saknas eller är ogiltig');
      }
      const tenantId = await deps.authenticate(header);
      if (tenantId === null || tenantId === '') {
        throw new HttpError(401, 'unauthorized', 'API-nyckel saknas eller är ogiltig');
      }
      request.tenantId = tenantId;
    });

    v1.get('/exceptions', async (request) => {
      const q = parse(exceptionsQuery, request.query, 'query');
      const filter: { status?: z.infer<typeof exceptionStatus>; payoutId?: string } = {};
      if (q.status !== undefined) filter.status = q.status;
      if (q.payoutId !== undefined) filter.payoutId = q.payoutId;
      const items = await deps.exceptions.list(request.tenantId, filter);
      return { items: items.map(presentException) };
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
          { tenantId, actor: 'api', action: 'exception.resolved', details: { exceptionId: id, status: body.status, code: existing.code } },
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
        await r.audit?.append({ tenantId, actor: 'api', action: 'command.requeued', details: { commandId: id } }, now);
        return true;
      });
      if (!ok) throw new HttpError(409, 'conflict', 'Kommandot finns inte eller är inte permanent misslyckat');
      return { id, status: 'pending' };
    });

    v1.get('/payouts', async (request) => {
      const q = parse(payoutsQuery, request.query, 'query');
      const items = await deps.payouts.list(request.tenantId, q.status !== undefined ? { status: q.status } : undefined);
      return { items: items.map(presentPayout) };
    });

    v1.get('/payouts/:id', async (request) => {
      const { id } = parse(idParams, request.params, 'path');
      const p = await deps.payouts.get(request.tenantId, id);
      if (!p) throw new HttpError(404, 'not_found', 'Utbetalningen finns inte');
      const cmds = await deps.commands.listByPayout(request.tenantId, id);
      return { ...presentPayout(p), commands: cmds.map(presentCommand) };
    });
  }, { prefix: '/v1' });

  return app;
}
