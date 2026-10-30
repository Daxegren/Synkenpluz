import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * Levererar webbgränssnittet för granskning (katalogen `web/`). Inga beroenden och ingen byggsteg:
 * fyra statiska filer som läses vid start. Gränssnittet pratar bara med samma servers /v1-API med en
 * API-nyckel och kan inte göra något API:t inte redan tillåter.
 *
 * Säkerhet: en strikt allowlist av filer (ingen sökvägsparameter alls, alltså ingen path traversal),
 * strikt Content-Security-Policy (inga inline-skript, inga externa resurser, ingen inbäddning i ramar),
 * ingen cachelagring av hemligheter, och inga uppgifter i själva filerna.
 */

const FILES: Record<string, { file: string; type: string }> = {
  '/app': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app/lib.js': { file: 'lib.js', type: 'text/javascript; charset=utf-8' },
  '/app/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

/** Gränssnittet får bara ladda sitt eget innehåll och prata med sitt eget API. */
export const WEB_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Hittar `web/`-katalogen. Källträdet (src/web) och det kompilerade (dist/src/web) ligger på olika djup,
 * så båda kandidaterna provas. `WEB_DIR` i miljön har företräde.
 */
export function resolveWebRoot(env: Record<string, string | undefined> = process.env): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [env.WEB_DIR, join(here, '../../web'), join(here, '../../../web')].filter((c): c is string => !!c);
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
}

export function registerWebUi(app: FastifyInstance, root: string): void {
  const assets = new Map<string, { body: Buffer; type: string; etag: string }>();
  for (const [route, { file, type }] of Object.entries(FILES)) {
    const body = readFileSync(join(root, file));
    assets.set(route, { body, type, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"` });
  }

  for (const route of assets.keys()) {
    app.get(route, async (request, reply) => {
      const asset = assets.get(route)!;
      reply
        .header('content-security-policy', WEB_CSP)
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('cross-origin-opener-policy', 'same-origin')
        .header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
        // Revalidera alltid så att en ny version syns direkt, men tillåt 304 via ETag.
        .header('cache-control', 'no-cache')
        .header('etag', asset.etag);
      if (request.headers['if-none-match'] === asset.etag) return reply.code(304).send();
      return reply.header('content-type', asset.type).send(asset.body);
    });
  }
}
