/**
 * Output helpers: aligned tables for humans; JSON, NDJSON and CSV for scripts
 * and spreadsheets (`--output json|ndjson|csv`, `--json` = `--output json`).
 */
import { formatVnd } from '@ferryvn/sdk';

export interface Writer {
  write(chunk: string): unknown;
}

export type OutputFormat = 'table' | 'json' | 'ndjson' | 'csv';
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['table', 'json', 'ndjson', 'csv'];

export interface Column<T> {
  header: string;
  get: (row: T) => unknown;
  /** Max display width in tables; longer values are truncated with "…" (never in CSV). */
  max?: number;
}

/** A VND amount: shown as `1.250.000 ₫` in tables, written as the raw number in CSV. */
export class Vnd {
  constructor(readonly amount: number) {}
  toString(): string {
    return formatVnd(this.amount);
  }
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Vnd) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function truncate(s: string, max?: number): string {
  if (!max || s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Display width: code points, ignoring combining marks (so NFD Vietnamese aligns too). */
const width = (s: string): number => [...s.replace(/[̀-ͯ]/g, '')].length;

export function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const matrix = rows.map((r) => columns.map((c) => truncate(cell(c.get(r)), c.max)));
  const widths = columns.map((c, i) => Math.max(width(c.header), ...matrix.map((m) => width(m[i] ?? ''))));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v + ' '.repeat(Math.max(0, (widths[i] ?? 0) - width(v))))
      .join('  ')
      .trimEnd();
  return [line(columns.map((c) => c.header)), line(widths.map((w) => '─'.repeat(w))), ...matrix.map(line)].join('\n');
}

/** RFC 4180 field quoting; also neutralises spreadsheet formula injection (=, +, -, @ prefixes). */
export function csvField(value: unknown): string {
  // Amounts stay numeric so spreadsheets can sum them.
  let s = value instanceof Vnd ? String(Math.round(value.amount)) : cell(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv<T>(rows: readonly T[], columns: readonly Column<T>[]): string {
  const lines = [columns.map((c) => csvField(c.header)), ...rows.map((r) => columns.map((c) => csvField(c.get(r))))];
  // UTF-8 BOM so Excel opens Vietnamese text correctly.
  return `﻿${lines.map((l) => l.join(',')).join('\r\n')}\r\n`;
}

export function printJson(out: Writer, data: unknown): void {
  out.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function printTable<T>(out: Writer, rows: readonly T[], columns: readonly Column<T>[], footer?: string): void {
  if (rows.length === 0) {
    out.write('(no results)\n');
  } else {
    out.write(`${renderTable(rows, columns)}\n`);
  }
  if (footer) out.write(`${footer}\n`);
}

/** VND amount for tables/CSV (`1.250.000 ₫` / `1250000`); '' for non-numbers. Interpolates as text. */
export function vnd(amount: unknown): Vnd | '' {
  const n =
    typeof amount === 'number' ? amount : typeof amount === 'string' && amount.trim() ? Number(amount) : Number.NaN;
  return Number.isFinite(n) ? new Vnd(n) : '';
}

/** `2026-10-20T08:00:00.000Z` → `2026-10-20 15:00` (Vietnam time). */
export function vnDateTime(iso: unknown): string {
  if (typeof iso !== 'string' || !iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + 7 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}
