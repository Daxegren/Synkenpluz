import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Håller dokumentationen komplett. Testet kontrollerar att namn och sökvägar FINNS i
 * dokumenten, inte att beskrivningarna är bra. Regeln står i docs/INDEX.md.
 * Faller ett test här: lägg till det som saknas i den dokumentation som nämns i felet.
 */

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(rel, accept));
    else if (accept(rel)) out.push(rel);
  }
  return out.sort();
}

const map = read('docs/FUNKTIONSKARTA.md');
const mentioned = (text: string, name: string) => new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(text);

function missing(items: string[], text: string): string[] {
  return items.filter((item) => !mentioned(text, item));
}

describe('funktionskartan är komplett', () => {
  it('nämner varje fil i web/ (webbgränssnittet)', () => {
    expect(missing(walk('web', () => true), map)).toEqual([]);
  });

  it('nämner varje kodfil i src/', () => {
    expect(missing(walk('src', (f) => f.endsWith('.ts')), map)).toEqual([]);
  });

  it('nämner varje fil i scripts/ och CI-arbetsflödet', () => {
    expect(missing([...walk('scripts', () => true), ...walk('.github', (f) => f.endsWith('.yml'))], map)).toEqual([]);
  });

  it('nämner varje testfil', () => {
    expect(missing(walk('test', (f) => f.endsWith('.ts')), map)).toEqual([]);
  });

  it('nämner varje exporterad funktion, klass och konstant i src/', () => {
    const names: string[] = [];
    for (const file of walk('src', (f) => f.endsWith('.ts'))) {
      for (const m of read(file).matchAll(/^export (?:async )?(?:function|class|const) ([A-Za-z0-9_]+)/gm)) names.push(m[1]!);
    }
    expect(names.length).toBeGreaterThan(40); // skydd mot att regexen slutar matcha
    expect(missing([...new Set(names)], map)).toEqual([]);
  });

  it('nämner varje tabell och migration', () => {
    const sql = read('src/db/migrations.ts');
    const tables = [...sql.matchAll(/create table (?:if not exists )?([a-z_]+)/g)].map((m) => m[1]!);
    const ids = [...sql.matchAll(/id: '(\d{3}_[a-z_]+)'/g)].map((m) => m[1]!);
    expect(tables.length).toBeGreaterThanOrEqual(8);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(missing([...new Set(tables), ...ids], map)).toEqual([]);
  });

  it('nämner varje npm-skript, adminkommando och miljövariabel', () => {
    const scripts = Object.keys(JSON.parse(read('package.json')).scripts as Record<string, string>);
    const asCommand = (s: string) => (s === 'test' ? 'npm test' : s === 'start' ? 'npm start' : `npm run ${s}`);
    expect(missing(scripts.map(asCommand), map)).toEqual([]);

    const commands = [...read('scripts/admin.ts').matchAll(/case '([a-z-]+)'/g)].map((m) => m[1]!);
    expect(commands.length).toBeGreaterThanOrEqual(8);
    expect(missing(commands, map)).toEqual([]);

    const env = [...read('src/app/config.ts').matchAll(/^\s+([A-Z][A-Z_]+): z\./gm)].map((m) => m[1]!);
    expect(env.length).toBeGreaterThanOrEqual(6);
    expect(missing(env, map)).toEqual([]);
  });

  it('nämner varje revisionspost som koden skriver', () => {
    const sources = [...walk('src', (f) => f.endsWith('.ts')), 'scripts/admin.ts'].map(read).join('\n');
    const actions = [
      ...new Set([...sources.matchAll(/'((?:payout|command|exception|tenant|api_key|connection)\.[a-z_]+)'/g)].map((m) => m[1]!)),
    ];
    expect(actions.length).toBeGreaterThanOrEqual(7);
    expect(missing(actions, map)).toEqual([]);
  });

  it('nämner varje kommandosort och statusvärde', () => {
    const types = read('src/domain/types.ts');
    const ports = read('src/ports/index.ts');
    const kinds = [...types.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!);
    expect(kinds).toHaveLength(3);
    const statuses = [...(/type CommandStatus = ([^;]+);/.exec(ports)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(statuses).toHaveLength(5);
    expect(missing([...kinds, ...statuses], map)).toEqual([]);
  });
});

describe('API och driftdokumentation är komplett', () => {
  const server = read('src/api/server.ts');
  const routes = [...server.matchAll(/\b(app|v1)\.(get|post|put|patch|delete)\('([^']+)'/g)].map(
    (m) => `${m[2]!.toUpperCase()} ${m[1] === 'v1' ? '/v1' : ''}${m[3]!}`,
  );

  it('hittar rutterna i server.ts', () => {
    expect(routes.length).toBeGreaterThanOrEqual(7);
  });

  it('API.md och kartan nämner varje rutt', () => {
    expect(missing(routes, read('docs/API.md'))).toEqual([]);
    expect(missing(routes, map)).toEqual([]);
  });

  it('RUNBOOK.md och kartan nämner varje avvikelsekod', () => {
    const block = /export type ExceptionCode =([^;]+);/.exec(read('src/domain/types.ts'))?.[1] ?? '';
    const codes = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(15);
    expect(missing(codes, read('docs/RUNBOOK.md'))).toEqual([]);
    expect(missing(codes, map)).toEqual([]);
  });
});

describe('dokumentens struktur', () => {
  const docs = walk('docs', (f) => f.endsWith('.md'));
  const index = read('docs/INDEX.md');

  it('INDEX.md listar varje dokument i docs/', () => {
    const names = docs.map((d) => d.replace(/^docs\//, '')).filter((d) => d !== 'INDEX.md');
    expect(missing(names, index)).toEqual([]);
  });

  it('README.md pekar på kartan och indexet', () => {
    const readme = read('README.md');
    expect(readme).toContain('docs/FUNKTIONSKARTA.md');
    expect(readme).toContain('docs/INDEX.md');
  });

  it('inga trasiga relativa länkar mellan dokumenten', () => {
    const broken: string[] = [];
    for (const file of ['README.md', ...docs]) {
      for (const m of read(file).matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = resolve(root, dirname(file), m[1]!);
        if (!existsSync(target)) broken.push(`${file} -> ${m[1]} (${relative(root, target)})`);
      }
    }
    expect(broken).toEqual([]);
  });
});
