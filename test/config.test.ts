import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/app/config.js';

const hex = (c: string) => c.repeat(64);
const valid = {
  DATABASE_URL: 'postgres://u:LÖSENORD@db/x',
  API_KEY_PEPPER: hex('a'),
  MASTER_KEYS: `k1:${hex('b')}`,
};

describe('parseEnv', () => {
  it('läser giltig konfiguration med standardvärden', () => {
    const env = parseEnv(valid);
    expect(env).toMatchObject({ databaseUrl: valid.DATABASE_URL, port: 3000, host: '0.0.0.0', cycleIntervalMs: 60_000 });
    expect(env.apiKeyPepper).toHaveLength(32);
    expect(env.masterKeys).toEqual([{ id: 'k1', key: Buffer.from(hex('b'), 'hex') }]);
    expect(env.alertWebhookUrl).toBeUndefined();
    expect(env.metricsToken).toBeUndefined();
  });

  it('läser valfria värden och base64-nycklar', () => {
    const env = parseEnv({
      ...valid,
      PORT: '8080',
      CYCLE_INTERVAL_MS: '0',
      ALERT_WEBHOOK_URL: 'https://hooks.example.com/T/B/X',
      ALERT_LABEL: 'prod',
      METRICS_TOKEN: 'x'.repeat(24),
      API_KEY_PEPPER: Buffer.alloc(32, 7).toString('base64'),
    });
    expect(env).toMatchObject({ port: 8080, cycleIntervalMs: 0, alertLabel: 'prod' });
    expect(env.apiKeyPepper).toEqual(Buffer.alloc(32, 7));
    expect(env.alertWebhookUrl).toBe('https://hooks.example.com/T/B/X');
  });

  it('stöder flera huvudnycklar där den första är aktuell', () => {
    const env = parseEnv({ ...valid, MASTER_KEYS: `ny:${hex('c')},gammal:${hex('d')}` });
    expect(env.masterKeys.map((k) => k.id)).toEqual(['ny', 'gammal']);
  });

  it.each([
    ['saknad databas', { DATABASE_URL: undefined }],
    ['saknad pepper', { API_KEY_PEPPER: undefined }],
    ['saknade huvudnycklar', { MASTER_KEYS: undefined }],
    ['för kort pepper', { API_KEY_PEPPER: 'abcd' }],
    ['huvudnyckel utan id', { MASTER_KEYS: hex('b') }],
    ['dubbla nyckel-id', { MASTER_KEYS: `k:${hex('b')},k:${hex('c')}` }],
    ['för kort huvudnyckel', { MASTER_KEYS: 'k1:abcd' }],
    ['ogiltig port', { PORT: '70000' }],
    ['port som text', { PORT: 'abc' }],
    ['negativt intervall', { CYCLE_INTERVAL_MS: '-1' }],
    ['ogiltig webhook-adress', { ALERT_WEBHOOK_URL: 'inte-en-url' }],
    ['för kort metrics-token', { METRICS_TOKEN: 'kort' }],
  ])('avvisar %s', (_name, override) => {
    expect(() => parseEnv({ ...valid, ...override })).toThrow();
  });

  it('läcker aldrig hemliga värden i felmeddelanden', () => {
    const secrets = ['LÖSENORD', hex('a'), hex('b'), 'hemlig-metrics-token-1234567890'];
    const attempts = [
      { ...valid, PORT: 'abc' },
      { ...valid, API_KEY_PEPPER: hex('a').slice(0, 10) },
      { ...valid, MASTER_KEYS: hex('b') },
      { ...valid, MASTER_KEYS: `k1:${hex('b').slice(0, 20)}` },
      { ...valid, METRICS_TOKEN: 'hemlig-metrics-token-1234567890'.slice(0, 5) },
      { ...valid, ALERT_WEBHOOK_URL: 'inte-en-url-hemlig-metrics-token-1234567890' },
    ];
    for (const attempt of attempts) {
      const message = (() => {
        try {
          parseEnv(attempt);
          return '';
        } catch (e) {
          return String((e as Error).message);
        }
      })();
      expect(message).not.toBe('');
      for (const secret of secrets) expect(message).not.toContain(secret);
      expect(message).not.toContain('postgres://');
    }
  });
});
