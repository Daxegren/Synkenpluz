import type { Clock } from '../ports/index.js';
import type { Alert } from './cycle.js';
import type { Logger } from './cycle.js';

/** Skickar ett larm till en människa (webhook, e-post, pager). */
export interface Notifier {
  send(alert: Alert): Promise<void>;
}

export interface WebhookNotifierOptions {
  /** Webhook-adressen är en hemlighet (Slack-webhooks innehåller en token). Den loggas aldrig. */
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Prefix i meddelandet, t.ex. miljön ("prod"). */
  label?: string;
}

/**
 * Skickar larm som JSON till en webhook. Formatet är kompatibelt med Slack ("text") och innehåller även
 * strukturerade fält. Innehåller bara larmets nivå, kund-id (internt) och text: aldrig belopp,
 * referenser eller personuppgifter, eftersom larmtexterna byggs bara av koder och antal.
 */
export function createWebhookNotifier(options: WebhookNotifierOptions): Notifier {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async send(alert) {
      const icon = alert.severity === 'critical' ? '🚨' : '⚠️';
      const where = alert.tenantId ? ` [kund ${alert.tenantId}]` : '';
      const label = options.label ? `${options.label}: ` : '';
      const text = `${icon} ${label}${alert.severity === 'critical' ? 'KRITISKT' : 'Varning'}${where}: ${alert.message}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, severity: alert.severity, tenantId: alert.tenantId ?? null, message: alert.message }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Webhook svarade ${response.status}`);
      } catch (error) {
        // Aldrig webhook-adressen i feltexten.
        const reason = error instanceof Error && error.name === 'AbortError' ? 'timeout' : error instanceof Error ? error.message : 'okänt fel';
        throw new Error(`Larm kunde inte skickas: ${reason.replaceAll(options.url, '[webhook]')}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface AlertDispatcherOptions {
  notifier: Notifier;
  clock: Clock;
  logger?: Logger;
  /** Hur länge innan samma larm skickas igen (default: kritiskt 1 h, varning 6 h). */
  repeatAfterMs?: { critical?: number; warning?: number };
}

const HOUR = 3_600_000;

/**
 * Skickar larm från körcykeln utan att översvämma: ett larm som redan skickats skickas om först efter
 * `repeatAfterMs`. Ett larm som försvinner glöms, så att det skickas direkt igen om det kommer tillbaka.
 * Ett misslyckat utskick räknas som inte skickat och försöks igen nästa cykel. Ett fel i utskicket
 * stoppar aldrig körcykeln.
 */
export function createAlertDispatcher(options: AlertDispatcherOptions) {
  const repeat = { critical: options.repeatAfterMs?.critical ?? HOUR, warning: options.repeatAfterMs?.warning ?? 6 * HOUR };
  const lastSent = new Map<string, number>();
  const keyOf = (a: Alert) => JSON.stringify([a.severity, a.tenantId ?? null, a.message]);

  return {
    /** Returnerar hur många larm som faktiskt skickades. */
    async dispatch(alerts: readonly Alert[]): Promise<number> {
      const now = options.clock.now().getTime();
      const current = new Set(alerts.map(keyOf));
      for (const key of lastSent.keys()) if (!current.has(key)) lastSent.delete(key);

      let sent = 0;
      for (const alert of alerts) {
        const key = keyOf(alert);
        const previous = lastSent.get(key);
        if (previous !== undefined && now - previous < repeat[alert.severity]) continue;
        try {
          await options.notifier.send(alert);
          lastSent.set(key, now);
          sent++;
        } catch (error) {
          options.logger?.error('Larm kunde inte skickas', { error: error instanceof Error ? error.message.slice(0, 200) : 'okänt fel' });
        }
      }
      return sent;
    },
  };
}
