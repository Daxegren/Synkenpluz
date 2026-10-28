/**
 * Administrationsverktyg för den som driftar tjänsten. Körs mot databasen i DATABASE_URL.
 *   npx tsx scripts/admin.ts <kommando> [argument]
 * Hemligheter (API-nycklar, uppgifter) skrivs bara ut/läses in en gång och loggas aldrig.
 */
import pg from 'pg';
import { z } from 'zod';
import { parseEnv } from '../src/app/config.js';
import { createConnectionRepository } from '../src/db/connections.js';
import { createPgDb } from '../src/db/pg.js';
import { migrate } from '../src/db/migrations.js';
import { createAuditLog } from '../src/db/repositories.js';
import { setTenantAccounts } from '../src/db/syncState.js';
import { createApiKeyRepository, createTenantRepository } from '../src/db/tenants.js';
import { StaticKeyProvider } from '../src/security/crypto.js';

const credentialsSchema = z.record(z.string(), z.string());

const USAGE = `Kommandon:
  create-tenant <id> <namn>
  set-accounts <tenant> <bank> <clearing> <feeExpense> <feeVat>
  set-mode <tenant> <dry_run|live>
  suspend <tenant> | activate <tenant>
  issue-key <tenant> [dagar]
  revoke-key <tenant> <nyckel-id>
  set-connection <tenant> <provider>     (JSON med uppgifter på stdin)
  list-tenants`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.log(USAGE);
    return;
  }
  const env = parseEnv(process.env);
  const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 2 });
  const db = createPgDb(pool);
  try {
    await migrate(db);
    const now = new Date();
    const tenants = createTenantRepository(db);
    const audit = createAuditLog(db);
    const log = (tenantId: string, action: string, details: Record<string, unknown> = {}) =>
      audit.append({ tenantId, actor: 'admin-cli', action, details }, now);
    const need = (value: string | undefined, name: string): string => {
      if (!value) throw new Error(`Saknar argument: ${name}\n\n${USAGE}`);
      return value;
    };

    switch (command) {
      case 'create-tenant': {
        const tenant = await tenants.create({ id: need(args[0], 'id'), name: need(args[1], 'namn') }, now);
        await log(tenant.id, 'tenant.created');
        console.log(`Skapade kund ${tenant.id} (läge: ${tenant.mode}, status: ${tenant.status})`);
        break;
      }
      case 'set-accounts': {
        const [t, bank, clearing, feeExpense, feeVat] = args.map((a) => a);
        const ok = await setTenantAccounts(db, need(t, 'tenant'), {
          bank: Number(need(bank, 'bank')),
          clearing: Number(need(clearing, 'clearing')),
          feeExpense: Number(need(feeExpense, 'feeExpense')),
          feeVat: Number(need(feeVat, 'feeVat')),
        });
        if (!ok) throw new Error('Okänd kund');
        await log(t!, 'tenant.accounts_set');
        console.log('Kontoplan sparad');
        break;
      }
      case 'set-mode': {
        const mode = need(args[1], 'läge');
        if (mode !== 'dry_run' && mode !== 'live') throw new Error('Läge måste vara dry_run eller live');
        if (!(await tenants.setMode(need(args[0], 'tenant'), mode))) throw new Error('Okänd kund');
        await log(args[0]!, 'tenant.mode_set', { mode });
        console.log(`Läge satt till ${mode}`);
        break;
      }
      case 'suspend':
      case 'activate': {
        const status = command === 'suspend' ? 'suspended' : 'active';
        if (!(await tenants.setStatus(need(args[0], 'tenant'), status))) throw new Error('Okänd kund');
        await log(args[0]!, `tenant.${status}`);
        console.log(`Kund ${args[0]} är nu ${status}`);
        break;
      }
      case 'issue-key': {
        const tenantId = need(args[0], 'tenant');
        const days = args[1] === undefined ? null : Number(args[1]);
        if (days !== null && (!Number.isInteger(days) || days <= 0)) throw new Error('Antal dagar måste vara ett positivt heltal');
        const expiresAt = days ? new Date(now.getTime() + days * 86_400_000) : null;
        const key = await createApiKeyRepository(db).issue(tenantId, { expiresAt }, now, env.apiKeyPepper);
        await log(tenantId, 'api_key.issued', { keyId: key.id });
        console.log(`Nyckel-id: ${key.id}\nNyckel (visas bara nu, spara den säkert):\n${key.rawKey}`);
        break;
      }
      case 'revoke-key': {
        const ok = await createApiKeyRepository(db).revoke(need(args[0], 'tenant'), need(args[1], 'nyckel-id'), now);
        if (ok) await log(args[0]!, 'api_key.revoked', { keyId: args[1] });
        console.log(ok ? 'Nyckeln är återkallad' : 'Nyckeln hittades inte eller var redan återkallad');
        break;
      }
      case 'set-connection': {
        const tenantId = need(args[0], 'tenant');
        const provider = need(args[1], 'provider');
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readStdin());
        } catch {
          // Själva JSON-felet innehåller ett utdrag av indata, och därmed delar av hemligheten. Skriv inte ut det.
          throw new Error('Indata är inte giltig JSON');
        }
        const credentials = credentialsSchema.safeParse(parsed);
        if (!credentials.success) throw new Error('Uppgifterna måste vara ett JSON-objekt med textvärden');
        const keys = Object.fromEntries(env.masterKeys.map((k) => [k.id, k.key]));
        const repo = createConnectionRepository(db, new StaticKeyProvider(keys, env.masterKeys[0]!.id));
        const info = await repo.upsert(tenantId, provider, credentials.data, now);
        await log(tenantId, 'connection.set', { provider, connectionId: info.id });
        console.log(`Koppling ${provider} sparad (krypterad med nyckel ${info.keyId})`);
        break;
      }
      case 'list-tenants': {
        const rows = await db.query<{ id: string; name: string; status: string; mode: string; configured: boolean }>(
          'select id, name, status, mode, accounts is not null as configured from tenant order by id',
        );
        for (const r of rows) console.log(`${r.id}\t${r.name}\t${r.status}\t${r.mode}\tkontoplan: ${r.configured ? 'ja' : 'nej'}`);
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'okänt fel');
  process.exit(1);
});
