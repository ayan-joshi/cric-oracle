import OpenAI from 'openai';
import { Toolhouse } from '@toolhouseai/sdk';
import { embedText } from './embedder';
import { searchSimilar } from './supabase';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const toolhouse = new Toolhouse({
  apiKey: process.env.TOOLHOUSE_API_KEY,
  provider: 'openai',
  metadata: { id: 'cricoracle-user' },
});

const SYSTEM_PROMPT = `You are CricOracle, an expert AI cricket umpire with complete knowledge of the MCC Laws of Cricket and ICC Playing Conditions for all formats (Test, ODI, T20I). You also have access to web search tools to fetch live or recent cricket information.

Your job is to give clear, accurate, authoritative answers to any cricket-related question.

Rules:
- For cricket law questions: cite the exact law or clause (e.g. "Law 36.1.2", "Law 28.3", "ICC T20I Clause 41.6"). Give a direct verdict first, then explain the reasoning.
- For live data (points tables, match results, recent news, tournament standings): ALWAYS use your web search tools — never say you cannot access real-time data.
- For league-specific rules (IPL, BBL, CPL etc.) not in MCC/ICC docs: use web search to fetch the accurate current rules.
- If the answer differs by format (Test vs ODI vs T20), clearly explain the difference.
- Use plain language — explain as if talking to a player or fan, not a lawyer.
- Keep answers focused: 3-6 sentences for simple rules, up to 10 for complex ones.`;

export interface RAGResult {
  answer: string;
  sources: { url: string; snippet: string }[];
  usedWebSearch?: boolean;
}

export async function queryRAG(question: string): Promise<RAGResult> {
  const queryEmbedding = await embedText(question);
  const matches = await searchSimilar(queryEmbedding, 10);

  const ragContext = matches.length > 0
    ? matches.map((m, i) => `[Source ${i + 1} — ${m.url}]\n${m.content}`).join('\n\n---\n\n')
    : null;

  const userContent = ragContext
    ? `Context from the Laws of Cricket:\n\n${ragContext}\n\n---\n\nQuestion: ${question}`
    : `Question: ${question}\n\nNote: No static law chunks found. Use web search to find relevant ICC/MCC cricket law information.`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  const tools = await toolhouse.getTools() as OpenAI.Chat.ChatCompletionTool[];

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    tools,
    temperature: 0.2,
    max_tokens: 800,
  });

  const toolCallsMade = response.choices[0]?.finish_reason === 'tool_calls';

  let answer: string;

  if (toolCallsMade) {
    const toolhouseMessages = await toolhouse.runTools(response) as OpenAI.Chat.ChatCompletionMessageParam[];

    // Toolhouse backend returns UUID-style tool_call_ids — fix them to match OpenAI's call_XXX IDs
    const openaiToolCalls = response.choices[0].message.tool_calls || [];
    let toolIndex = 0;
    const fixedMessages = toolhouseMessages.map((msg) => {
      if (msg.role === 'tool') {
        const fixedId = openaiToolCalls[toolIndex]?.id;
        toolIndex++;
        return fixedId ? { ...msg, tool_call_id: fixedId } : msg;
      }
      // For the assistant message, use OpenAI's original to guarantee correct tool_calls array
      if (msg.role === 'assistant') {
        return response.choices[0].message as OpenAI.Chat.ChatCompletionMessageParam;
      }
      return msg;
    });

    const finalMessages = [...messages, ...fixedMessages];
    const finalResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: finalMessages,
      temperature: 0.2,
      max_tokens: 800,
    });
    answer = finalResponse.choices[0].message.content || 'No answer generated.';
  } else {
    answer = response.choices[0].message.content || 'No answer generated.';
  }

  const sources = matches.map((m) => ({
    url: m.url,
    snippet: m.content.slice(0, 150) + '...',
  }));

  return { answer, sources, usedWebSearch: toolCallsMade };
}
