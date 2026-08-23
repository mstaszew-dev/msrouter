/**
 * Director tools: terminal (allowlisted commands) + web_search (DuckDuckGo Lite HTML scrape)
 * + RAG semantic search over THE shared campaign index + write-prompt-override.
 * NO Playwright. No browser MCP. Pure TypeScript + fetch() (+ one-shot python CLI for RAG).
 */


import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

import { env } from '../config/env.js';
import { RagClient } from './rag.js';

const execFileP = promisify(execFile);

export interface ToolResult {
  content: string;
  isError?: boolean;
}

function getAllowlist(): string[] {
  return env().TERMINAL_ALLOWLIST;
}

/** The OpenAI-style tool definitions advertised to the model. */
export function toolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'terminal',
        description: 'Run a shell command from a fixed allowlist (git, ls, cat, ...).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The allowlisted executable name.' },
            args: { type: 'array', items: { type: 'string' } },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web via DuckDuckGo Lite (no API key). Returns top results with title, URL, and snippet.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query string.' },
            maxResults: { type: 'number', default: 5, minimum: 1, maximum: 20 },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rag_search_apps',
        description:
          'Semantic search over past job applications (the shared dedupe index). Use to check whether a company/role was already applied to before proposing anything.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language query (company, role, stack, location).' },
            k: { type: 'number', default: 5, minimum: 1, maximum: 20 },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rag_search_docs',
        description:
          'Semantic search over campaign docs/context chunks (same shared index). Useful for recalling prior decisions and notes.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language query.' },
            k: { type: 'number', default: 3, minimum: 1, maximum: 20 },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_prompt_override',
        description: 'Append text to the Director prompt override file. This text will be appended to the agent message on next restart.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to append to the prompt override file.' },
          },
          required: ['text'],
        },
      },
    },
  ];
}

export async function callTool(name: string, args: unknown, log: unknown): Promise<ToolResult> {
  if (name === 'terminal') {
    return terminal(args as { command: string; args?: string[] });
  }
  if (name === 'web_search') {
    return webSearch(args as { query: string; maxResults?: number });
  }
  if (name === 'rag_search_apps' || name === 'rag_search_docs') {
    const { query, k } = args as { query?: string; k?: number };
    if (!query || !query.trim()) {
      return { content: `${name}: query is required`, isError: true };
    }
    const rag = new RagClient({
      campaignDir: env().DIRECTOR_CAMPAIGN_DIR,
      log: log as Logger,
    });
    const hits =
      name === 'rag_search_apps'
        ? await rag.ragSearchApps(query, k ?? 5)
        : await rag.ragSearchDocs(query, k ?? 3);
    return { content: JSON.stringify({ result: hits }) };
  }
  if (name === 'write_prompt_override') {
    return writePromptOverride(args as { text: string });
  }
  return { content: `unknown tool: ${name}`, isError: true };
}

async function terminal({ command, args = [] }: { command: string; args?: string[] }): Promise<ToolResult> {
  if (!getAllowlist().includes(command)) {
    return { content: `command '${command}' is not in the allowlist`, isError: true };
  }
  try {
    const { stdout, stderr } = await execFileP(command, args, { timeout: 30_000 });
    return { content: stdout + (stderr ? `\n[stderr]\n${stderr}` : '') };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: `terminal: ${msg}`, isError: true };
  }
}

async function webSearch({ query }: { query: string; maxResults?: number }): Promise<ToolResult> {
  if (!query || !query.trim()) {
    return { content: 'web_search: query is required', isError: true };
  }
  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Director/1.0)',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      return { content: `web_search: HTTP ${res.status}`, isError: true };
    }
    const html = await res.text();

    // DuckDuckGo HTML (lite) results: each result in a table row with class "result"
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const titleRegex = /<a[^>]*class="result__snippet"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
    const snippetRegex = /<a[^>]*class="result__url"[^>]*>([^<]+)<\/a>/g;

    const links: Array<{ url: string; title: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = titleRegex.exec(html)) !== null) {
      links.push({ url: match[1] ?? '', title: match[2] ?? '' });
    }
    const snippets: string[] = [];
    let match2: RegExpExecArray | null;
    while ((match2 = snippetRegex.exec(html)) !== null) {
      snippets.push(match2[1] ?? '');
    }
    for (let i = 0; i < Math.min(links.length, snippets.length, 5); i++) {
      const link = links[i];
      const snippet = snippets[i];
      results.push({
        title: link?.title.trim() ?? '',
        url: link?.url ?? '',
        snippet: snippet?.trim().slice(0, 300) ?? '',
      });
    }
    if (results.length === 0) {
      return { content: 'web_search: no results found for query', isError: false };
    }
    const output = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n');
    return { content: output };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: `web_search failed: ${msg}`, isError: true };
  }
}

async function writePromptOverride({ text }: { text: string }): Promise<ToolResult> {
  if (!text || !text.trim()) {
    return { content: 'write_prompt_override: text is required', isError: true };
  }
  try {
    const dir = join(homedir(), '.campaign-agent');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const mdPath = join(dir, 'director-prompt-overrides.md');
    // Append with timestamp header
    const timestamp = new Date().toISOString();
    const entry = `\n\n--- ${timestamp} ---\n${text}\n`;
    appendFileSync(mdPath, entry, { mode: 0o644 });
    return { content: `Prompt override appended to ${mdPath}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: `write_prompt_override failed: ${msg}`, isError: true };
  }
}