import pg from 'pg';
import { createApp } from './app/compose.js';
import { parseEnv } from './app/config.js';
import type { Logger } from './app/cycle.js';
import { notConfiguredAdapters } from './app/notConfigured.js';
import { createPgDb } from './db/pg.js';
import { migrate } from './db/migrations.js';

/** JSON-rader på stdout. Skicka aldrig hemligheter, tokens eller personuppgifter hit. */
const logger: Logger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.log(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

async function main() {
  const env = parseEnv(process.env);
  const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
  // Utan en error-hanterare kraschar processen när en ledig anslutning bryts (t.ex. vid databasomstart).
  // Poolen återskapar anslutningen vid nästa användning.
  pool.on('error', (error) => logger.error('Databasanslutning bröts', { error: error.message.slice(0, 300) }));
  const db = createPgDb(pool);

  const ran = await migrate(db);
  if (ran.length > 0) logger.info('Migrationer körda', { migrations: ran });

  // TODO: ersätt med riktiga adaptrar per kund när Mondido- och Fortnox-adaptrarna finns.
  logger.warn('Inga riktiga adaptrar är konfigurerade. Synk kommer att misslyckas tydligt per kund.');
  const app = createApp({
    db,
    clock: { now: () => new Date() },
    apiKeyPepper: env.apiKeyPepper,
    adapters: notConfiguredAdapters,
    logger,
  });

  await app.server.listen({ port: env.port, host: env.host });
  logger.info('API startat', { port: env.port });

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  // Kedjade timeouts i stället för setInterval, så att två cykler aldrig överlappar i samma process.
  const schedule = () => {
    if (stopping || env.cycleIntervalMs === 0) return;
    timer = setTimeout(() => {
      running = app
        .runCycle()
        .then((report) => {
          for (const alert of report.alerts) logger.warn('Larm', { ...alert });
        })
        .catch((error: unknown) => logger.error('Körcykeln kraschade', { error: String(error).slice(0, 300) }))
        .finally(schedule);
    }, env.cycleIntervalMs);
  };
  schedule();

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('Stänger ner', { signal });
    if (timer) clearTimeout(timer);
    await running; // låt pågående cykel bli klar
    await app.server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error('Start misslyckades', { error: error instanceof Error ? error.message : 'okänt fel' });
  process.exit(1);
});
