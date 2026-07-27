/**
 * Direct tool implementations for the scheduled agent. Per the plan, no MCP SDK:
 *   - terminal: child_process.execFile with an allowlist + timeout
 *   - browser: Playwright connectOverCDP at the user's existing Chrome CDP
 *
 * Tools are exposed to the model as OpenAI-style `tools` (function-call schema).
 * On a tool_call we execute it and feed the result back as a tool message.
 *
 * Playwright is an OPTIONAL dependency (optionalDependencies in package.json)
 * because it may not be installed and the browser tool should fail gracefully.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

import { env } from '../config/env.js';

const execFileP = promisify(execFile);

export interface ToolResult {
  content: string;
  isError?: boolean;
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
        name: 'browser_navigate',
        description: 'Navigate the connected browser (CDP) to a URL and return the page text.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
      },
    },
  ];
}

/** Dispatch a tool call by name. Unknown tools return an error result. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  log: Logger,
): Promise<ToolResult> {
  switch (name) {
    case 'terminal':
      return runTerminal(args, log);
    case 'browser_navigate':
      return runBrowserNavigate(args, log);
    default:
      return { content: `unknown tool: ${name}`, isError: true };
  }
}

async function runTerminal(args: Record<string, unknown>, log: Logger): Promise<ToolResult> {
  const cmdRaw = args['command'];
  const command = (typeof cmdRaw === 'string' ? cmdRaw : '').trim();
  const argv = Array.isArray(args['args']) ? (args['args'] as string[]).map(String) : [];
  const allow = env().TERMINAL_ALLOWLIST;
  if (!command) return { content: 'terminal: command is required', isError: true };
  // Strict allowlist: exact match on the executable name.
  if (!allow.includes(command)) {
    return {
      content: `terminal: "${command}" is not in the allowlist [${allow.join(', ')}]`,
      isError: true,
    };
  }
  log.info({ command, args: argv }, 'terminal tool exec');
  try {
    const { stdout, stderr } = await execFileP(command, argv, {
      timeout: 30_000,
      maxBuffer: 512 * 1024,
      cwd: process.cwd(),
    });
    const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(0, 8000);
    return { content: out || '(no output)' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: `terminal failed: ${msg}`, isError: true };
  }
}

/** Minimal structural types for the parts of playwright-core we use, so the
 *  gateway compiles without playwright installed (it is an optional dep). */
interface PwPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
}
interface PwContext {
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
}
interface PwBrowser {
  contexts(): PwContext[];
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwChromium {
  connectOverCDP(endpoint: string): Promise<PwBrowser>;
}

async function runBrowserNavigate(args: Record<string, unknown>, log: Logger): Promise<ToolResult> {
  const urlRaw = args['url'];
  const url = typeof urlRaw === 'string' ? urlRaw.trim() : '';
  if (!url) return { content: 'browser_navigate: url is required', isError: true };
  let chromium: PwChromium;
  try {
    // Dynamic import so the gateway works without playwright installed.
    const mod = (await import('playwright-core')) as { chromium: PwChromium };
    chromium = mod.chromium;
  } catch {
    return {
      content: 'browser tool unavailable: playwright-core not installed',
      isError: true,
    };
  }
  log.info({ url, cdp: env().CDP_URL }, 'browser navigate');
  let browser: PwBrowser | undefined;
  try {
    browser = await chromium.connectOverCDP(env().CDP_URL);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const text = (await page.textContent('body')) ?? '';
    return { content: text.slice(0, 8000) || '(empty page)' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: `browser failed: ${msg}`, isError: true };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
