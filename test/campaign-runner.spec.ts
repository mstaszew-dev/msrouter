/**
 * Campaign runner classification unit tests.
 * Verifies that the regex and failure classification patterns used in
 * openclaw-job-search/run-one-job correctly classify context overflow messages,
 * rate limit errors, transient gateway failures, and true success.
 */

import { describe, expect, it } from 'vitest';

const CONTEXT_OVERFLOW_RE =
  /context overflow|prompt too large|compaction failed|Compaction timed out|token.*(limit|too large)|maximum context/i;

const RATE_LIMIT_RE =
  /rate limit|Retry-After|429|Too Many Requests|timed out|timeout|transient|GatewayClient|ECONN|ETIMEDOUT|socket/i;

const TRANSIENT_RE =
  /FailoverError|model was not found|API rate limit reached|rate limit reached|service unavailable|503|502|Upstream|all providers failed|NO_PROVIDER_AVAILABLE|assistant turn failed/i;

const HAS_ERROR_RE =
  /context overflow|prompt too large|compaction failed|Compaction timed out|token.*(limit|too large)|maximum context|assistant turn failed|all providers failed|NO_PROVIDER_AVAILABLE|502|503/i;

function classifyFailure(output: string): 'context' | 'rate' | 'transient' | 'fatal' {
  if (CONTEXT_OVERFLOW_RE.test(output)) return 'context';
  if (RATE_LIMIT_RE.test(output)) return 'rate';
  if (TRANSIENT_RE.test(output)) return 'transient';
  return 'fatal';
}

function isSuccess(rc: number, output: string): boolean {
  const hasError = HAS_ERROR_RE.test(output);
  return rc === 0 && !hasError;
}

describe('Campaign Runner - Failure Classification', () => {
  it('classifies prompt overflow message as context failure', () => {
    const output =
      'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.';
    expect(classifyFailure(output)).toBe('context');
  });

  it('classifies compaction timed out as context failure', () => {
    const output = 'Error: Compaction timed out after 120000ms';
    expect(classifyFailure(output)).toBe('context');
  });

  it('classifies gateway 502 / all providers failed as transient failure', () => {
    const output =
      '502 Gateway Error: Upstream service unavailable or NO_PROVIDER_AVAILABLE';
    expect(classifyFailure(output)).toBe('transient');
  });

  it('classifies 429 rate limit as rate failure', () => {
    const output = 'HTTP 429 Too Many Requests - Retry-After 30s';
    expect(classifyFailure(output)).toBe('rate');
  });

  it('classifies unknown errors as fatal failure', () => {
    const output = 'Error: Invalid authentication token or missing config';
    expect(classifyFailure(output)).toBe('fatal');
  });
});

describe('Campaign Runner - Success Evaluation', () => {
  it('rejects success when exit code is 0 but output has Context overflow', () => {
    const rc = 0;
    const output =
      'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session...';
    expect(isSuccess(rc, output)).toBe(false);
  });

  it('rejects success when exit code is 0 but output has assistant turn failed', () => {
    const rc = 0;
    const output = '[assistant turn failed before producing content]';
    expect(isSuccess(rc, output)).toBe(false);
  });

  it('accepts success when exit code is 0 and output is clean', () => {
    const rc = 0;
    const output = 'Successfully applied for job Senior Java Developer at Company X via LinkedIn.';
    expect(isSuccess(rc, output)).toBe(true);
  });
});
