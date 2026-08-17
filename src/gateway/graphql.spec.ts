import { graphql } from 'graphql';
import { describe, expect, it, vi } from 'vitest';

import { Router } from '../common/http.js';

import { createGraphqlHandler, schema } from './graphql.js';
import { registerHandlers } from './handlers.js';

const silentLogger = {
  warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(),
} as unknown as Parameters<typeof registerHandlers>[1]['log'];

/** A chain whose handle() resolves to a non-streaming text response. */
function textChain(content = 'Hello from model', provider = 'opencode', model = 'test-model') {
  const body = JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  return {
    handle: vi.fn(async () => ({
      response: new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      servedBy: { provider, model },
    })),
  } as never;
}

async function execute(query: string, chain: unknown, variables?: Record<string, unknown>) {
  return graphql({
    schema,
    source: query,
    contextValue: { chain },
    variableValues: variables,
  });
}

/** Narrow GraphQL result data for safe access in tests. */
function dataAs<T>(res: { data?: unknown }): T {
  return res.data as T;
}

describe('graphql schema', () => {
  it('exposes Query.models and Query.health', async () => {
    const res = await execute('{ __schema { queryType { fields { name } } } }', textChain());
    const d = dataAs<{ __schema: { queryType: { fields: Array<{ name: string }> } } }>(res);
    const fields = d.__schema.queryType.fields.map((f) => f.name);
    expect(fields).toContain('models');
    expect(fields).toContain('health');
  });

  it('exposes Mutation.completion', async () => {
    const res = await execute('{ __schema { mutationType { fields { name } } } }', textChain());
    const d = dataAs<{ __schema: { mutationType: { fields: Array<{ name: string }> } } }>(res);
    const fields = d.__schema.mutationType.fields.map((f) => f.name);
    expect(fields).toContain('completion');
  });

  it('Query.health returns ok with uptime', async () => {
    const res = await execute('{ health { status uptime } }', textChain());
    const d = dataAs<{ health: { status: string; uptime: number } }>(res);
    expect(d.health.status).toBe('ok');
    expect(d.health.uptime).toBeGreaterThanOrEqual(0);
  });

  it('Query.models returns the env-driven model list', async () => {
    const res = await execute('{ models { id owned_by } }', textChain());
    const d = dataAs<{ models: Array<{ id: string; owned_by: string }> }>(res);
    expect(d.models.length).toBeGreaterThan(0);
    expect(d.models.some((m) => m.id === 'mst/free')).toBe(true);
  });

  it('Mutation.completion returns content + provider + finish_reason', async () => {
    const chain = textChain('Greetings', 'opencode', 'nemotron');
    const res = await execute(
      'mutation { completion(input: { messages: [{ role: "user", content: "hi" }], model: "mst/free" }) { model provider content finish_reason } }',
      chain,
    );
    const d = dataAs<{
      completion: { content: string; provider: string; model: string; finish_reason: string };
    }>(res);
    expect(d.completion.content).toBe('Greetings');
    expect(d.completion.provider).toBe('opencode');
    expect(d.completion.model).toBe('nemotron');
    expect(d.completion.finish_reason).toBe('stop');
    // chain.handle was called with the messages + model from the input
    const handleMock = (chain as { handle: ReturnType<typeof vi.fn> }).handle;
    const callBody = handleMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
      model: string;
    };
    expect(callBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(callBody.model).toBe('mst/free');
  });

  it('Mutation.completion surfaces chain errors in GraphQL errors', async () => {
    const chain = {
      handle: vi.fn(async () => { throw new Error('all providers failed'); }),
    } as never;
    const res = await execute(
      'mutation { completion(input: { messages: [{ role: "user", content: "hi" }] }) { content } }',
      chain,
    );
    expect(res.errors?.[0]?.message).toContain('all providers failed');
  });

  it('accepts variables for the completion input', async () => {
    const chain = textChain('VarOK');
    const res = await execute(
      'mutation ($input: CompletionInput!) { completion(input: $input) { content } }',
      chain,
      { input: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 } },
    );
    const d = dataAs<{ completion: { content: string } }>(res);
    expect(d.completion.content).toBe('VarOK');
    const handleMock = (chain as { handle: ReturnType<typeof vi.fn> }).handle;
    const callBody = handleMock.mock.calls[0]![0] as { max_tokens: number };
    expect(callBody.max_tokens).toBe(64);
  });
});

describe('createGraphqlHandler', () => {
  it('responds 400 with a GraphQL error when query is missing', async () => {
    const handler = createGraphqlHandler(textChain(), silentLogger);
    let status = 0;
    let body: unknown;
    const res = {
      writeHead: (s: number) => { status = s; },
      end: (b: string) => { body = JSON.parse(b); },
    } as never;
    await handler({ body: { variables: {} } } as never, res);
    expect(status).toBe(400);
    const errBody = body as { errors: Array<{ message: string }> };
    expect(errBody.errors[0]!.message).toContain('query');
  });

  it('executes the query and returns the result', async () => {
    const handler = createGraphqlHandler(textChain('Via handler'), silentLogger);
    let status = 0;
    let body: unknown;
    const res = {
      writeHead: (s: number) => { status = s; },
      end: (b: string) => { body = JSON.parse(b); },
    } as never;
    await handler({
      body: { query: '{ health { status } }' },
    } as never, res);
    expect(status).toBe(200);
    const resultBody = body as { data: { health: { status: string } } };
    expect(resultBody.data.health.status).toBe('ok');
  });
});

describe('route registration', () => {
  it('registers POST /graphql', () => {
    const router = new Router();
    registerHandlers(router, { chain: textChain(), log: silentLogger });
    expect(router.resolve('POST', '/graphql')).not.toBeNull();
  });
});
