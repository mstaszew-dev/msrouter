/**
 * Request validation at the gateway boundary. zod schema for the chat
 * completions body, so malformed requests are rejected with a stable error
 * envelope before any upstream call. See NODEJS_CODE_REVIEW.md section 1 + 4.
 */

import { z } from 'zod';

const messageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.any()).optional(),
  })
  .passthrough();

export const chatCompletionSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    // Default 512 so reasoning models (nemotron, big-pickle, etc. picked by
    // openrouter/free) have room to think AND emit content. Omitting it let
    // upstreams default low and return content=null.
    max_tokens: z.number().int().positive().default(512),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    response_format: z.any().optional(),
    // Pass through any other fields the provider may understand.
  })
  .passthrough();

export type ValidatedChatRequest = z.infer<typeof chatCompletionSchema>;
