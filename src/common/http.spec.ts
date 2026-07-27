import { describe, expect, it } from 'vitest';

import { matchPath, Router } from './http.js';

describe('matchPath', () => {
  it('matches a literal path', () => {
    expect(matchPath('api/v1/models', 'api/v1/models')).toEqual({});
  });

  it('captures :params', () => {
    expect(matchPath('orgs/:id/deployments', 'orgs/org-1/deployments')).toEqual({
      id: 'org-1',
    });
  });

  it('returns null on mismatched segment count', () => {
    expect(matchPath('a/b', 'a')).toBeNull();
  });

  it('returns null on a differing literal', () => {
    expect(matchPath('a/b', 'a/c')).toBeNull();
  });
});

describe('Router', () => {
  it('resolves a parametrized route and exposes params', () => {
    const router = new Router();
    const seen: Record<string, string> = {};
    router.add('GET', 'v1/deployments/:id', (req) => {
      Object.assign(seen, req.params);
    });
    const matched = router.resolve('GET', 'v1/deployments/dep-9');
    expect(matched).not.toBeNull();
    expect(matched?.params).toEqual({ id: 'dep-9' });
  });

  it('returns null for an unknown route', () => {
    const router = new Router();
    router.add('GET', 'v1/x', () => undefined);
    expect(router.resolve('GET', 'v1/nope')).toBeNull();
  });
});
