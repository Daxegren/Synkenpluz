import { describe, expect, it } from 'vitest';
import { LedgerError } from '../../src/ports/index.js';
import { classifyHttpFailure, parseRetryAfter, toLedgerError, type HttpFailureInput } from '../../src/http/errors.js';

const netErr = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) });

type Row = [string, HttpFailureInput, { retryable: boolean; notApplied: boolean; authExpired?: boolean; retryAfterMs?: number }];

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

const rows: Row[] = [
  ...[400, 403, 404, 409, 422, 405, 410, 413].map((s): Row => [`HTTP ${s}`, { kind: 'status', status: s }, { retryable: false, notApplied: true }]),
  ['HTTP 401', { kind: 'status', status: 401 }, { retryable: false, notApplied: true, authExpired: true }],
  ['HTTP 408', { kind: 'status', status: 408 }, { retryable: true, notApplied: false }],
  ['HTTP 425', { kind: 'status', status: 425 }, { retryable: true, notApplied: false }],
  ['HTTP 429', { kind: 'status', status: 429 }, { retryable: true, notApplied: true }],
  ['HTTP 429 Retry-After 7', { kind: 'status', status: 429, retryAfter: '7' }, { retryable: true, notApplied: true, retryAfterMs: 7000 }],
  ...[500, 502, 503, 504, 599].map((s): Row => [`HTTP ${s}`, { kind: 'status', status: s }, { retryable: true, notApplied: false }]),
  ['HTTP 503 Retry-After 3', { kind: 'status', status: 503, retryAfter: '3' }, { retryable: true, notApplied: false, retryAfterMs: 3000 }],
  ['HTTP 302', { kind: 'status', status: 302 }, { retryable: false, notApplied: false }],
  ...['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].map(
    (c): Row => [c, { kind: 'network', error: netErr(c) }, { retryable: true, notApplied: true }],
  ),
  ['timeout', { kind: 'network', error: new Error('aborted'), timedOut: true }, { retryable: true, notApplied: false }],
  ['ECONNRESET', { kind: 'network', error: netErr('ECONNRESET') }, { retryable: true, notApplied: false }],
  ['avbruten under svar', { kind: 'network', error: new TypeError('terminated') }, { retryable: true, notApplied: false }],
  ['okänt fel', { kind: 'network', error: 'konstigt' }, { retryable: true, notApplied: false }],
  ['för stort svar', { kind: 'response-too-large' }, { retryable: false, notApplied: false }],
  ['ogiltig JSON', { kind: 'invalid-response' }, { retryable: false, notApplied: false }],
];

describe('classifyHttpFailure', () => {
  it.each(rows)('%s', (_name, input, expected) => {
    const withNow = input.kind === 'status' ? { ...input, nowMs: NOW } : input;
    const c = classifyHttpFailure(withNow);
    expect(c.kind).toBe('failure');
    if (c.kind !== 'failure') return;
    expect(c.retryable).toBe(expected.retryable);
    expect(c.notApplied).toBe(expected.notApplied);
    expect(c.authExpired).toBe(expected.authExpired ?? false);
    expect(c.retryAfterMs).toBe(expected.retryAfterMs);
    const err = toLedgerError(c, { method: 'post', path: '/x?token=hemlig', status: input.kind === 'status' ? input.status : undefined });
    expect(err).toBeInstanceOf(LedgerError);
    expect(err!.retryable).toBe(expected.retryable);
    expect(err!.notApplied).toBe(expected.notApplied);
    expect(err!.retryAfterMs).toBe(expected.retryAfterMs);
    expect(err!.message).not.toContain('hemlig');
    expect(err!.message).toContain('POST /x');
  });

  it.each([200, 201, 204, 299])('%i är ok', (status) => {
    expect(classifyHttpFailure({ kind: 'status', status })).toEqual({ kind: 'ok' });
    expect(toLedgerError({ kind: 'ok' }, { method: 'GET', path: '/' })).toBeUndefined();
  });

  it('cause-kedjan på djupare nivå hittas', () => {
    const deep = new Error('a', { cause: new Error('b', { cause: Object.assign(new Error('c'), { code: 'ECONNREFUSED' }) }) });
    const c = classifyHttpFailure({ kind: 'network', error: deep });
    expect(c).toMatchObject({ retryable: true, notApplied: true });
  });
});

describe('parseRetryAfter', () => {
  const date = (ms: number) => new Date(NOW + ms).toUTCString();
  const cases: Array<[string, string | null | undefined, number | undefined]> = [
    ['sekunder', '120', 120_000],
    ['noll', '0', 0],
    ['blanksteg runt', ' 5 ', 5000],
    ['datum i framtiden', date(30_000), 30_000],
    ['datum i det förflutna', date(-30_000), undefined],
    ['skräp', 'snart', undefined],
    ['skräp med siffra', 'foo 1', undefined],
    ['negativt', '-5', undefined],
    ['decimal', '1.5', undefined],
    ['NaN', 'NaN', undefined],
    ['Infinity', 'Infinity', undefined],
    ['tomt', '', undefined],
    ['null', null, undefined],
    ['saknas', undefined, undefined],
    ['enormt tal', '99999999999999999999999', 3_600_000],
    ['över taket', '7200', 3_600_000],
    ['datum långt fram', date(10 * 24 * 3600_000), 3_600_000],
  ];
  it.each(cases)('%s', (_n, value, expected) => {
    expect(parseRetryAfter(value, NOW)).toBe(expected);
  });
});
