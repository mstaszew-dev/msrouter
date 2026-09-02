import '@testing-library/jest-dom/vitest';

import { afterEach } from 'vitest';

import { cleanup } from '@testing-library/react';

// jsdom does not reliably expose localStorage under vitest (and Node >= 22
// shadows it behind an experimental flag), so provide an in-memory stand-in.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});
