import type pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { RotationQueue } from './rotation.js';

const silent = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as pino.Logger;

describe('RotationQueue', () => {
  it('starts in the given order', () => {
    const q = new RotationQueue(['a', 'b', 'c'], { log: silent });
    expect(q.length).toBe(3);
    expect(q.snapshot()).toEqual(['a', 'b', 'c']);
  });

  it('at() returns the item at the logical index', () => {
    const q = new RotationQueue(['a', 'b', 'c'], { log: silent });
    expect(q.at(0)).toBe('a');
    expect(q.at(2)).toBe('c');
  });

  it('at() wraps around for out-of-range indices (round-robin)', () => {
    const q = new RotationQueue(['a', 'b'], { log: silent });
    expect(q.at(2)).toBe('a');
    expect(q.at(3)).toBe('b');
  });

  it('demote() moves the item to the back', () => {
    const q = new RotationQueue(['a', 'b', 'c'], { log: silent });
    q.demote('a');
    expect(q.snapshot()).toEqual(['b', 'c', 'a']);
  });

  it('demote() is idempotent (already at back stays at back)', () => {
    const q = new RotationQueue(['a', 'b'], { log: silent });
    q.demote('a');
    expect(q.snapshot()).toEqual(['b', 'a']);
    q.demote('a');
    expect(q.snapshot()).toEqual(['b', 'a']);
  });

  it('demote() of a middle item preserves relative order of others', () => {
    const q = new RotationQueue(['a', 'b', 'c', 'd'], { log: silent });
    q.demote('b');
    expect(q.snapshot()).toEqual(['a', 'c', 'd', 'b']);
    q.demote('c');
    expect(q.snapshot()).toEqual(['a', 'd', 'b', 'c']);
  });

  it('demote() on a single-item queue is a no-op', () => {
    const q = new RotationQueue(['only'], { log: silent });
    q.demote('only');
    expect(q.snapshot()).toEqual(['only']);
  });

  it('multiple demotions order worst-first at the back', () => {
    const q = new RotationQueue(['a', 'b', 'c', 'd'], { log: silent });
    q.demote('a'); // first to fail
    q.demote('c'); // second to fail
    expect(q.snapshot()).toEqual(['b', 'd', 'a', 'c']);
  });

  it('indexOf() returns the current queue position (-1 if absent)', () => {
    const q = new RotationQueue(['a', 'b', 'c'], { log: silent });
    expect(q.indexOf('a')).toBe(0);
    q.demote('a');
    expect(q.indexOf('a')).toBe(2);
    expect(q.indexOf('zzz')).toBe(-1);
  });

  it('demote() of an absent item is a silent no-op', () => {
    const q = new RotationQueue(['a', 'b'], { log: silent });
    q.demote('zzz');
    expect(q.snapshot()).toEqual(['a', 'b']);
  });

  it('demote() logs a warning with the label and item', () => {
    const log = { ...silent, warn: vi.fn() } as unknown as pino.Logger;
    const q = new RotationQueue(['a', 'b'], { log, label: 'opencode' });
    q.demote('a');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'opencode' }),
      expect.stringContaining('demoted'),
    );
  });
});
