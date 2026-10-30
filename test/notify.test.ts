import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Alert } from '../src/app/cycle.js';
import { createAlertDispatcher, createWebhookNotifier, type Notifier } from '../src/app/notify.js';
import { TestClock } from './helpers.js';

const critical: Alert = { severity: 'critical', message: '2 kommando(n) har permanent misslyckats' };
const warning: Alert = { severity: 'warning', tenantId: 'T1', message: '1 utbetalning(ar) avvisades och kräver granskning' };

describe('createWebhookNotifier', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  async function listen(handler: (req: IncomingMessage, body: string) => { status: number; delayMs?: number }) {
    const received: Array<{ headers: IncomingMessage['headers']; body: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        const { status, delayMs } = handler(req, body);
        setTimeout(() => res.writeHead(status).end(), delayMs ?? 0);
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/SECRET-TOKEN`, received };
  }

  it('skickar Slack-kompatibel JSON med nivå, kund och text', async () => {
    const { url, received } = await listen(() => ({ status: 200 }));
    await createWebhookNotifier({ url, label: 'prod' }).send(warning);
    const body = JSON.parse(received[0]!.body) as Record<string, unknown>;
    expect(received[0]!.headers['content-type']).toBe('application/json');
    expect(body.text).toContain('Varning');
    expect(body.text).toContain('prod');
    expect(body.text).toContain('kund T1');
    expect(body).toMatchObject({ severity: 'warning', tenantId: 'T1' });
  });

  it('kritiska larm märks tydligt', async () => {
    const { url, received } = await listen(() => ({ status: 200 }));
    await createWebhookNotifier({ url }).send(critical);
    expect((JSON.parse(received[0]!.body) as { text: string }).text).toContain('KRITISKT');
  });

  it('läcker aldrig webhook-adressen i felmeddelanden (status, timeout, anslutningsfel)', async () => {
    const bad = await listen(() => ({ status: 500 }));
    const e1 = await createWebhookNotifier({ url: bad.url }).send(critical).catch((e: Error) => e);
    expect((e1 as Error).message).toContain('500');
    expect((e1 as Error).message).not.toContain('SECRET-TOKEN');

    const slow = await listen(() => ({ status: 200, delayMs: 500 }));
    const e2 = await createWebhookNotifier({ url: slow.url, timeoutMs: 50 }).send(critical).catch((e: Error) => e);
    expect((e2 as Error).message).toContain('timeout');
    expect((e2 as Error).message).not.toContain('SECRET-TOKEN');

    const e3 = await createWebhookNotifier({ url: 'http://127.0.0.1:1/hook/SECRET-TOKEN', timeoutMs: 500 })
      .send(critical)
      .catch((e: Error) => e);
    expect((e3 as Error).message).not.toContain('SECRET-TOKEN');
    expect(String((e3 as Error).stack)).not.toContain('SECRET-TOKEN');
  });
});

describe('createAlertDispatcher', () => {
  function setup(failures = 0) {
    const sent: Alert[] = [];
    let remaining = failures;
    const notifier: Notifier = {
      async send(a) {
        if (remaining-- > 0) throw new Error('nere');
        sent.push(a);
      },
    };
    const clock = new TestClock();
    return { sent, clock, dispatcher: createAlertDispatcher({ notifier, clock }) };
  }

  it('skickar nya larm och dämpar samma larm i varje cykel', async () => {
    const { dispatcher, sent, clock } = setup();
    expect(await dispatcher.dispatch([critical, warning])).toBe(2);
    clock.advance(60_000);
    expect(await dispatcher.dispatch([critical, warning])).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('upprepar kritiska larm efter en timme och varningar efter sex', async () => {
    const { dispatcher, sent, clock } = setup();
    await dispatcher.dispatch([critical, warning]);
    clock.advance(61 * 60_000);
    expect(await dispatcher.dispatch([critical, warning])).toBe(1);
    expect(sent.at(-1)).toEqual(critical);
    clock.advance(6 * 3_600_000);
    expect(await dispatcher.dispatch([critical, warning])).toBe(2);
  });

  it('ett larm som försvinner och kommer tillbaka skickas direkt igen', async () => {
    const { dispatcher, sent, clock } = setup();
    await dispatcher.dispatch([critical]);
    clock.advance(60_000);
    await dispatcher.dispatch([]);
    clock.advance(60_000);
    expect(await dispatcher.dispatch([critical])).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it('ett misslyckat utskick försöks igen nästa cykel och stoppar aldrig något', async () => {
    const { dispatcher, sent, clock } = setup(1);
    expect(await dispatcher.dispatch([critical])).toBe(0);
    clock.advance(60_000);
    expect(await dispatcher.dispatch([critical])).toBe(1);
    expect(sent).toEqual([critical]);
  });

  it('olika kunder med samma text är olika larm', async () => {
    const { dispatcher } = setup();
    const a = { ...warning, tenantId: 'T1' };
    const b = { ...warning, tenantId: 'T2' };
    expect(await dispatcher.dispatch([a, b])).toBe(2);
  });
});
