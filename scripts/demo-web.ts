/**
 * Demoläge för webbgränssnittet, med färdig exempeldata och simulerade system:
 *   npm run demo:web
 * Startar en server med en databas i minnet (försvinner när du stänger den), skapar två påhittade kunder och skriver ut
 * adressen och nycklarna. Inget går till Mondido, Fortnox eller någon riktig kund, och ingenting sparas.
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../src/app/compose.js';
import { createPgliteDb } from '../src/db/db.js';
import { migrate } from '../src/db/migrations.js';
import { DEMO_TENANTS, seedDemo } from '../src/demo/seed.js';
import { FakeLedgerGateway } from '../src/gateways/fake.js';
import { FakeLedgerProvider } from '../src/gateways/fakeProvider.js';
import { FakePayoutSource } from '../src/gateways/fakeSource.js';
import { StaticKeyProvider } from '../src/security/crypto.js';

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1';

  const db = createPgliteDb(new PGlite());
  await migrate(db);
  const clock = { now: () => new Date() };
  const ledger = new FakeLedgerGateway();
  const pepper = randomBytes(32);
  const keyProvider = new StaticKeyProvider({ demo: randomBytes(32) }, 'demo');

  const app = createApp({
    db,
    clock,
    apiKeyPepper: pepper,
    rateLimit: false,
    adapters: { source: new FakePayoutSource(), invoices: ledger, gateway: ledger, provider: new FakeLedgerProvider('fortnox') },
  });
  const keys = await seedDemo({ app, db, clock, pepper, ledger, keyProvider });

  await app.server.listen({ port, host });
  console.log(`\n\x1b[1mDemo av webbgränssnittet\x1b[0m  (simulerade data, ingenting sparas)\n`);
  console.log(`Öppna:  http://${host}:${port}/app\n`);
  for (const k of keys) {
    console.log(`${k.label}  [${k.tenantId}, roll ${k.role}]\n  ${k.key}\n`);
  }
  console.log(`Tips: logga in som godkännare på ${DEMO_TENANTS.test} och gå till "Kom igång". Avsluta med Ctrl+C.`);

  const stop = async () => {
    await app.server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
