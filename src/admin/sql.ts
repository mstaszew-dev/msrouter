/**
 * The quasi-SQL console engine: free-form SQL over the bound users array
 * (`FROM ?`) executed by AlaSQL. The statement is parser-verified (AST, not
 * regex) to be a single read-only SELECT before execution:
 *   - exactly one statement (no `SELECT 1; DROP TABLE x`),
 *   - a Select (no UPDATE/DELETE/INSERT/DDL),
 *   - no INTO sink (AlaSQL can write files via SELECT INTO CSV(...)),
 *   - every FROM source is the bound parameter `?` (AlaSQL can read files via
 *     FROM CSV(...); non-param sources are refused).
 * Mutations of the users data go through the structured, zod-validated admin
 * endpoints - never through the SQL console.
 */

import alasql from 'alasql';

import { ValidationError, errorMessage } from '../common/errors.js';
import type { QueryResponse } from '../shared/schema.js';

/** A parsed statement node we only inspect structurally (library AST). */
interface AstStatement {
  constructor?: { name?: string };
  into?: unknown;
  from?: Array<{ param?: unknown }>;
}

export async function runUsersQuery(
  sql: string,
  users: readonly unknown[],
  knownColumns: readonly string[],
): Promise<QueryResponse> {
  assertReadOnlySelect(sql);
  let raw: unknown;
  try {
    raw = await alasql.promise(sql, [[...users]]);
  } catch (e) {
    throw new ValidationError(`SQL execution failed: ${errorMessage(e)}`);
  }
  const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  return {
    columns: rows.length > 0 ? collectColumns(rows) : [...knownColumns],
    rows,
    rowCount: rows.length,
  };
}

/** Column names in first-seen order across all returned rows. */
function collectColumns(rows: Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function assertReadOnlySelect(sql: string): void {
  let statements: AstStatement[];
  try {
    const ast = alasql.parse(sql) as { statements?: AstStatement[] } | undefined;
    statements = ast?.statements ?? [];
  } catch (e) {
    throw new ValidationError(`invalid SQL: ${errorMessage(e)}`);
  }
  const top = statements[0];
  const ok =
    statements.length === 1 &&
    top?.constructor?.name === 'Select' &&
    top.into === undefined &&
    Array.isArray(top.from) &&
    top.from.length > 0 &&
    top.from.every((src) => typeof src?.param === 'number');
  if (!ok) {
    throw new ValidationError('only a single read-only SELECT ... FROM ? statement is allowed');
  }
  // Deep-walk the whole statement: subqueries (any `queriesidx` node) and any
  // non-param FROM source nested anywhere (WHERE IN (...), expressions, ...)
  // are rejected, closing the FROM-file hole outside the top level too.
  const violation = inspectNode(top, 0);
  if (violation) {
    throw new ValidationError('only a single read-only SELECT ... FROM ? statement is allowed');
  }
}

const MAX_AST_DEPTH = 64;

function inspectNode(node: unknown, depth: number): string | null {
  if (node === null || typeof node !== 'object' || depth > MAX_AST_DEPTH) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const bad = inspectNode(item, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'queriesidx') return 'subquery';
    if (key === 'from' && Array.isArray(value)) {
      const paramOnly = value.every(
        (src) => src !== null && typeof src === 'object' && typeof (src as Record<string, unknown>)['param'] === 'number',
      );
      if (!paramOnly) return 'non-param FROM source';
    }
    const bad = inspectNode(value, depth + 1);
    if (bad) return bad;
  }
  return null;
}
