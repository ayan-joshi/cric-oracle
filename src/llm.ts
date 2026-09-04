import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from './config';
import { describeError } from './errors';

/**
 * Generation layer.
 *
 * Claude is the primary provider; OpenAI is the automatic fallback. Both sit
 * behind one interface so the RAG pipeline never branches on provider.
 *
 * Note on scope: this covers generation only. Embeddings stay on OpenAI in
 * embedder.ts because Anthropic has no embeddings endpoint -- the retrieval
 * half of the system is provider-locked regardless of what we do here.
 *
 * This also replaces Toolhouse. Claude exposes a server-side web_search tool,
 * so live data no longer needs a third-party SDK, an extra API key, or the
 * tool_call_id remapping that Toolhouse required.
 */

export type Tier = 'answer' | 'utility';

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Ask for raw JSON back. Both providers get an explicit instruction. */
  json?: boolean;
  /** Allow the model to reach the live web. Claude only. */
  webSearch?: boolean;
}

export interface CompletionResult {
  text: string;
  provider: 'anthropic' | 'openai';
  model: string;
  usedWebSearch: boolean;
}

let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAI | null = null;

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: config.anthropicApiKey!,
      // Unset by default -> the official API. Overridable via ANTHROPIC_BASE_URL,
      // which is the SDK's own standard variable.
      ...(config.anthropicBaseUrl ? { baseURL: config.anthropicBaseUrl } : {}),
      maxRetries: 2,
      timeout: 60_000, // milliseconds in the TS SDK
    });
  }
  return anthropicClient;
}

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 2, timeout: 45_000 });
  }
  return openaiClient;
}

function anthropicModel(tier: Tier): string {
  return tier === 'answer' ? config.models.claudeAnswer : config.models.claudeUtility;
}

function openaiModel(tier: Tier): string {
  return tier === 'answer' ? config.models.openaiAnswer : config.models.openaiUtility;
}

/**
 * Claude's server-side web search. Results are produced on Anthropic's
 * infrastructure and arrive as content blocks in the same response, so there
 * is no client-side tool loop to run and nothing to fail halfway through --
 * which is exactly how the old Toolhouse path broke production.
 */
const WEB_SEARCH_TOOL = {
  type: 'web_search_20260209' as const,
  name: 'web_search' as const,
  max_uses: 4,
};

async function callAnthropic(req: CompletionRequest, tier: Tier): Promise<CompletionResult> {
  const model = anthropicModel(tier);
  const isUtility = tier === 'utility';

  const system = req.json
    ? `${req.system}\n\nRespond with a single raw JSON object and nothing else. No prose, no markdown fences.`
    : req.system;

  const response = await getAnthropic().messages.create({
    model,
    max_tokens: req.maxTokens,
    system,
    messages: [{ role: 'user', content: req.user }],
    // Haiku does not accept output_config.effort, and the utility calls
    // (rewrite, rerank) are mechanical -- no reason to spend thinking on them.
    ...(isUtility ? {} : { output_config: { effort: config.models.effort } }),
    ...(req.webSearch ? { tools: [WEB_SEARCH_TOOL] } : {}),
  });

  // A refusal returns HTTP 200 with empty-ish content; check before reading.
  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'unknown'})`);
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  const usedWebSearch = response.content.some((block) => block.type === 'web_search_tool_result');

  return { text, provider: 'anthropic', model, usedWebSearch };
}

async function callOpenAI(req: CompletionRequest, tier: Tier): Promise<CompletionResult> {
  const model = openaiModel(tier);

  const response = await getOpenAI().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
    temperature: tier === 'answer' ? 0.2 : 0,
    max_tokens: req.maxTokens,
  });

  return {
    text: (response.choices[0]?.message?.content ?? '').trim(),
    provider: 'openai',
    model,
    // OpenAI has no web search in this integration; web-dependent questions
    // are answered from the indexed corpus only.
    usedWebSearch: false,
  };
}

/**
 * Runs the request on Claude, falling back to OpenAI on any failure.
 * Both providers unavailable is a hard error -- there is nothing to answer with.
 */
export async function complete(req: CompletionRequest, tier: Tier): Promise<CompletionResult> {
  if (config.anthropicEnabled) {
    try {
      return await callAnthropic(req, tier);
    } catch (err) {
      console.warn(`Claude call failed, falling back to OpenAI: ${describeError(err)}`);
    }
  }

  return callOpenAI(req, tier);
}

/** Parses a JSON completion, tolerating a stray markdown fence. */
export function parseJson<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

/** Reports generation-provider health for /health. */
export async function checkLLM(): Promise<{ ok: boolean; detail: string }> {
  const parts: string[] = [];

  if (config.anthropicEnabled) {
    parts.push(
      `Claude primary (${config.models.claudeAnswer}) via ${config.anthropicBaseUrl ?? 'api.anthropic.com'}`
    );
  } else {
    parts.push('Claude not configured');
  }

  parts.push(`OpenAI ${config.anthropicEnabled ? 'fallback' : 'primary'} (${config.models.openaiAnswer})`);

  return { ok: true, detail: parts.join('; ') };
}
