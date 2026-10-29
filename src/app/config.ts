import { z } from 'zod';

/** Läser och validerar miljövariabler. Hemligheter returneras aldrig i felmeddelanden. */
const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL saknas'),
  /** Server-pepper för API-nycklar. 32 byte, hex (64 tecken) eller base64. */
  API_KEY_PEPPER: z.string().min(1, 'API_KEY_PEPPER saknas'),
  /** Huvudnycklar för kryptering av åtkomsttoken: "id1:hex,id2:hex". Första är aktuell. */
  MASTER_KEYS: z.string().min(1, 'MASTER_KEYS saknas'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** 0 stänger av körcykeln (bara API). */
  CYCLE_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  /** Webhook (Slack-kompatibel) dit larm skickas. Utelämnad = larm bara loggas. Adressen är en hemlighet. */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /** Prefix i larmmeddelanden, t.ex. miljön. */
  ALERT_LABEL: z.string().max(40).optional(),
  /** Bearer-token för GET /metrics. Utelämnad = /metrics finns inte. Minst 24 tecken. */
  METRICS_TOKEN: z.string().min(24, 'METRICS_TOKEN måste vara minst 24 tecken').optional(),
});

export interface AppEnv {
  databaseUrl: string;
  apiKeyPepper: Buffer;
  masterKeys: Array<{ id: string; key: Buffer }>;
  port: number;
  host: string;
  cycleIntervalMs: number;
  alertWebhookUrl: string | undefined;
  alertLabel: string | undefined;
  metricsToken: string | undefined;
}

function decodeKey(value: string, label: string): Buffer {
  const trimmed = value.trim();
  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (buffer.length !== 32) throw new Error(`${label} måste vara exakt 32 byte (64 hextecken eller base64)`);
  return buffer;
}

export function parseEnv(env: Record<string, string | undefined>): AppEnv {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Bara fältnamn och regler, aldrig värden.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Ogiltig konfiguration: ${problems.join('; ')}`);
  }
  const e = parsed.data;

  const masterKeys = e.MASTER_KEYS.split(',').map((part, index) => {
    const [id, key, ...rest] = part.trim().split(':');
    if (!id || !key || rest.length > 0) throw new Error(`MASTER_KEYS: post ${index + 1} måste ha formen id:nyckel`);
    return { id, key: decodeKey(key, `MASTER_KEYS (${id})`) };
  });
  if (new Set(masterKeys.map((k) => k.id)).size !== masterKeys.length) throw new Error('MASTER_KEYS: dubbla nyckel-id');

  return {
    databaseUrl: e.DATABASE_URL,
    apiKeyPepper: decodeKey(e.API_KEY_PEPPER, 'API_KEY_PEPPER'),
    masterKeys,
    port: e.PORT,
    host: e.HOST,
    cycleIntervalMs: e.CYCLE_INTERVAL_MS,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
    alertLabel: e.ALERT_LABEL,
    metricsToken: e.METRICS_TOKEN,
  };
}
