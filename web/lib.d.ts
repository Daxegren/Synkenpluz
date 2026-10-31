// Typer för lib.js, så att testerna (TypeScript) kan importera den rena logiken.
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';
export function formatAmount(minor: number, currency?: string): string;
export function ageText(iso: string, nowMs?: number): string;
export const PAYOUT_STATUS: Record<string, { label: string; tone: Tone; help: string }>;
export const COMMAND_STATUS: Record<string, { label: string; tone: Tone }>;
export const EXCEPTION_STATUS: Record<string, { label: string; tone: Tone }>;
export const COMMAND_KIND: Record<string, string>;
export const EXCEPTION_INFO: Record<string, { title: string; meaning: string; action: string }>;
export function describeCommand(command: Record<string, unknown>): {
  title: string;
  rows: Array<[string, string]>;
  voucher?: Array<{ account: number; debit: number; credit: number }>;
};
export function voucherBalance(lines: Array<{ debit: number; credit: number }>): { debit: number; credit: number; balanced: boolean };
export const PAGES: string[];
export function parseHash(hash: string): { page: string; id: string | null };
export function apiErrorMessage(status: number, body: unknown, retryAfterSec?: number): string;
export function validateResolve(input: { status?: string | undefined; note?: string | undefined }): string | null;
export function validateGuardResolve(input: { applied?: boolean | undefined; externalId?: string | undefined }): string | null;
export const ONBOARDING_PHASE: Record<string, { label: string; tone: Tone; help: string }>;
export function validateGoLive(input: { reviewed?: boolean | undefined }): string | null;
export const ROLE_LABEL: Record<string, string>;
export function formatPercent(rate: number | null | undefined): string;
