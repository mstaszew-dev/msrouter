/**
 * Smoke tests for the architecture documentation page: all major sections
 * must render (this page doubles as the project's architecture README).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AboutPage } from './AboutPage';

vi.mock('../api/client', () => ({
  tokenStore: { get: () => null, set: () => {}, clear: () => {} },
  unauthorizedHandler: { set: () => {} },
  api: {},
}));

describe('AboutPage', () => {
  it('renders every architecture section', () => {
    render(
      <main>
        <AboutPage />
      </main>,
    );
    for (const heading of [
      'What msrouter is',
      'The Director',
      'Orchestration loops',
      'Queues',
      'Kafka outbound queue',
      'Slack integration',
      'RAG',
      'Node.js concurrency and the event loop',
      'The tiny data layer',
      'This web console',
      'Microservice architecture',
      'Open source',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });

  it('links the GitHub repository', () => {
    render(
      <main>
        <AboutPage />
      </main>,
    );
    const link = screen.getByRole('link', { name: /github.com\/mstaszew-dev\/msrouter/i });
    expect(link).toHaveAttribute('href', 'https://github.com/mstaszew-dev/msrouter');
  });
});
