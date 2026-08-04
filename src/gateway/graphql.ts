/**
 * GraphQL endpoint for the gateway: POST /graphql.
 *
 * Exposes read-only queries (models, health) and a completion mutation that
 * calls the ProviderChain (non-streaming; streaming stays on /v1/chat/completions).
 * Uses graphql-js directly on the framework-free node:http stack - no yoga/apollo.
 *
 * NOTE: resolvers are attached to the schema field definitions (.resolve),
 * NOT passed as rootValue methods - graphql 17 does not route mutation args
 * to rootValue methods reliably (verified empirically).
 */
import {
  buildSchema,
  graphql,
  type GraphQLSchema,
} from 'graphql';
import type { ServerResponse } from 'node:http';
import type { Logger } from 'pino';

import { sendJson, type HttpRequest } from '../common/http.js';
import type { ProviderChain } from '../providers/chain.js';
import { buildModelList } from './handlers.js';

const typeDefs = `
  type Query {
    models: [Model!]!
    health: Health!
  }
  type Mutation {
    completion(input: CompletionInput!): CompletionResult!
  }
  type Model {
    id: String!
    owned_by: String!
  }
  type Health {
    status: String!
    uptime: Float!
  }
  input MessageInput {
    role: String!
    content: String!
  }
  input CompletionInput {
    model: String
    messages: [MessageInput!]!
    max_tokens: Int
    temperature: Float
  }
  type CompletionResult {
    model: String!
    provider: String!
    content: String!
    finish_reason: String
  }
`;

export const schema: GraphQLSchema = buildSchema(typeDefs);

interface CompletionArgs {
  input: {
    model?: string;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
  };
}

const queryType = schema.getQueryType();
if (queryType) {
  queryType.getFields().models!.resolve = () => buildModelList();
  queryType.getFields().health!.resolve = () => ({
    status: 'ok',
    uptime: process.uptime(),
  });
}

const mutationType = schema.getMutationType();
if (!mutationType) throw new Error('graphql schema missing Mutation type');
mutationType.getFields().completion!.resolve = async (
  _src: unknown,
  { input }: CompletionArgs,
  ctx: { chain: ProviderChain },
) => {
  const body = {
    model: input.model ?? 'mst/free',
    messages: input.messages,
    ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };
  const result = await ctx.chain.handle(body, new AbortController().signal);
  const text = await result.response.text();
  const parsed = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = parsed.choices?.[0];
  return {
    model: result.servedBy.model,
    provider: result.servedBy.provider,
    content: choice?.message?.content ?? '',
    finish_reason: choice?.finish_reason ?? 'stop',
  };
};

/**
 * Build the POST /graphql handler. The request body (already parsed by
 * readJsonBody) is `{ query, variables }`; the GraphQL result is sent as JSON
 * with HTTP 200 (GraphQL errors ride in the result body, per convention).
 */
export function createGraphqlHandler(chain: ProviderChain, _log: Logger) {
  return async (req: HttpRequest, res: ServerResponse): Promise<void> => {
    const body = (req.body ?? {}) as { query?: string; variables?: Record<string, unknown> };
    if (!body.query || typeof body.query !== 'string') {
      sendJson(res, 400, {
        errors: [{ message: 'GraphQL query is required in the request body' }],
      });
      return;
    }
    const result = await graphql({
      schema,
      source: body.query,
      contextValue: { chain },
      variableValues: body.variables,
    });
    sendJson(res, 200, result);
  };
}
