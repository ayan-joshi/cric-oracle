/**
 * Retrieval + answer evaluation harness.
 *
 *   npm run eval              retrieval only (embeddings only -- cheap)
 *   npm run eval -- --answers adds end-to-end answers and an LLM judge
 *
 * Retrieval quality is the part of a RAG system you can measure cheaply and
 * improve deliberately; answer quality mostly follows from it. So this reports
 * dense-only and hybrid side by side -- without that comparison, "we added
 * hybrid search" is a claim rather than a result.
 */

import fs from 'fs';
import path from 'path';
import { embedText } from './embedder';
import { searchSimilar, hybridSearch, RetrievedChunk } from './supabase';
import { queryRAG } from './rag';
import { describeError } from './errors';
import { complete, parseJson } from './llm';

interface EvalCase {
  id: string;
  question: string;
  expectedLaws: string[];
  keywords: string[];
  category: string;
  format?: string;
  note?: string;
}

const K = Number(process.env.EVAL_K) || 6;
const CANDIDATES = Number(process.env.EVAL_CANDIDATES) || 20;

function loadCases(): EvalCase[] {
  const file = path.join(__dirname, '../eval/dataset.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: EvalCase[] };
  return parsed.cases;
}

/**
 * A chunk counts as relevant if its law_number metadata matches an expected
 * law, or the text itself cites it. Law "36" matches "36" and "36.1.2" but
 * must not match "3" or "136" -- hence the boundary-aware check.
 */
function isRelevant(chunk: RetrievedChunk, testCase: EvalCase): boolean {
  if (testCase.expectedLaws.length > 0) {
    for (const law of testCase.expectedLaws) {
      const meta = chunk.law_number ?? '';
      if (meta === law || meta.startsWith(`${law}.`)) return true;

      const escaped = law.replace('.', '\\.');

      // "Law 36.1.2" / "Clause 41.6"
      const prefixed = new RegExp(`\\b(?:law|clause)\\s+${escaped}(?:\\.\\d+)*\\b`, 'i');
      if (prefixed.test(chunk.content)) return true;

      // Bare clause headings as they appear in the source text: "36.1 Out LBW".
      // Requires a sub-clause digit so "36" alone cannot match a stray year or
      // run count, and anchors to a line start so "136.1" cannot match either.
      const bare = new RegExp(`(?:^|\\n)\\s*${escaped}\\.\\d`, 'm');
      if (bare.test(chunk.content)) return true;
    }
    return false;
  }

  // No law number available (preamble, ICC conditions): fall back to keywords.
  const haystack = chunk.content.toLowerCase();
  return testCase.keywords.some((kw) => haystack.includes(kw.toLowerCase()));
}

function firstRelevantRank(chunks: RetrievedChunk[], testCase: EvalCase): number | null {
  for (let i = 0; i < chunks.length; i++) {
    if (isRelevant(chunks[i], testCase)) return i + 1;
  }
  return null;
}

interface Metrics {
  hits: number;
  total: number;
  mrrSum: number;
  precisionSum: number;
}

function emptyMetrics(): Metrics {
  return { hits: 0, total: 0, mrrSum: 0, precisionSum: 0 };
}

function record(metrics: Metrics, chunks: RetrievedChunk[], testCase: EvalCase): number | null {
  const rank = firstRelevantRank(chunks, testCase);
  metrics.total++;
  if (rank !== null) {
    metrics.hits++;
    metrics.mrrSum += 1 / rank;
  }
  const relevantCount = chunks.filter((c) => isRelevant(c, testCase)).length;
  metrics.precisionSum += chunks.length > 0 ? relevantCount / chunks.length : 0;
  return rank;
}

function summarise(name: string, m: Metrics): string {
  const pct = (n: number) => `${((n / m.total) * 100).toFixed(1)}%`;
  return [
    name.padEnd(10),
    `recall@${K}: ${pct(m.hits).padStart(6)}`,
    `MRR: ${(m.mrrSum / m.total).toFixed(3)}`,
    `precision@${K}: ${pct(m.precisionSum).padStart(6)}`,
  ].join('  ');
}

const JUDGE_PROMPT = `You grade a cricket-umpire assistant's answer. Return strict JSON:
{"grounded": 0-2, "correct": 0-2, "cited": true|false, "reason": string}

- grounded: 2 = every factual claim is supported by the supplied passages, 1 = mostly, 0 = contains unsupported claims.
- correct: 2 = the cricket ruling is right, 1 = partially right, 0 = wrong.
- cited: true if the answer references at least one specific Law or Clause number.
Be strict. Reason in one sentence.`;

async function judge(
  question: string,
  answer: string,
  passages: string
): Promise<{ grounded: number; correct: number; cited: boolean; reason: string } | null> {
  try {
    // The judge runs on the cheap utility model: it is a bulk grader, not the
    // thing under test, and grading answers with the same model that wrote
    // them would bias the score.
    const result = await complete(
      {
        system: JUDGE_PROMPT,
        user: `Question: ${question}\n\nPassages:\n${passages}\n\nAnswer:\n${answer}`,
        maxTokens: 300,
        json: true,
      },
      'utility'
    );
    return parseJson(result.text);
  } catch (err) {
    console.warn(`  judge failed: ${describeError(err)}`);
    return null;
  }
}

/**
 * Sweeps RRF fusion weights against the golden set.
 *
 * The dense and lexical arms are not equally good at this corpus, so a 1:1
 * fusion is an assumption, not a default. This measures it. Retrieval-only, so
 * the whole sweep costs 22 cached embeddings and nothing else.
 */
async function sweep(cases: EvalCase[]) {
  const combos: { fullText: number; semantic: number }[] = [
    { fullText: 0.0, semantic: 1.0 }, // dense only, via the fusion path
    { fullText: 0.25, semantic: 1.0 },
    { fullText: 0.5, semantic: 1.0 },
    { fullText: 1.0, semantic: 1.0 }, // the naive default
    { fullText: 1.0, semantic: 0.5 },
    { fullText: 1.0, semantic: 0.0 }, // lexical only
  ];

  console.log('\n--- RRF weight sweep ---');
  console.log(`lexical  semantic  recall@${K}      MRR  precision@${K}`);

  const embeddings = new Map<string, number[]>();
  for (const c of cases) embeddings.set(c.id, await embedText(c.question));

  for (const combo of combos) {
    const m = emptyMetrics();
    for (const testCase of cases) {
      const chunks = (
        await hybridSearch(testCase.question, embeddings.get(testCase.id)!, CANDIDATES, null, combo)
      ).slice(0, K);
      record(m, chunks, testCase);
    }
    const pct = (n: number) => `${((n / m.total) * 100).toFixed(1)}%`;
    console.log(
      `${combo.fullText.toFixed(2).padStart(7)}  ${combo.semantic.toFixed(2).padStart(8)}   ` +
        `${pct(m.hits).padStart(7)}  ${(m.mrrSum / m.total).toFixed(3)}   ${pct(m.precisionSum).padStart(9)}`
    );
  }
  console.log('');
}

async function main() {
  const withAnswers = process.argv.includes('--answers');
  const cases = loadCases();

  if (process.argv.includes('--sweep')) {
    console.log(`\nCricOracle RRF weight sweep -- ${cases.length} cases, k=${K}`);
    await sweep(cases);
    return;
  }

  console.log(`\nCricOracle evaluation -- ${cases.length} cases, k=${K}, candidates=${CANDIDATES}`);
  console.log(`Mode: ${withAnswers ? 'retrieval + answers (LLM judge)' : 'retrieval only'}\n`);

  const dense = emptyMetrics();
  const hybrid = emptyMetrics();

  const answerScores = { grounded: 0, correct: 0, cited: 0, judged: 0 };
  const failures: string[] = [];

  for (const testCase of cases) {
    const embedding = await embedText(testCase.question);

    const [denseChunks, hybridChunks] = await Promise.all([
      searchSimilar(embedding, K, null),
      hybridSearch(testCase.question, embedding, CANDIDATES, null).then((c) => c.slice(0, K)),
    ]);

    const denseRank = record(dense, denseChunks, testCase);
    const hybridRank = record(hybrid, hybridChunks, testCase);

    const mark = (r: number | null) => (r === null ? ' -- ' : `#${r}`.padStart(4));
    const delta =
      denseRank === null && hybridRank !== null ? ' [hybrid saved]'
        : denseRank !== null && hybridRank === null ? ' [hybrid lost]'
          : '';

    console.log(
      `${testCase.id.padEnd(24)} dense ${mark(denseRank)}   hybrid ${mark(hybridRank)}${delta}`
    );

    if (hybridRank === null) failures.push(testCase.id);

    if (withAnswers) {
      try {
        const result = await queryRAG(testCase.question);
        const passages = result.sources.map((s) => `[${s.n}] ${s.law ?? s.source}: ${s.snippet}`).join('\n');
        const verdict = await judge(testCase.question, result.answer, passages);

        if (verdict) {
          answerScores.grounded += verdict.grounded;
          answerScores.correct += verdict.correct;
          answerScores.cited += verdict.cited ? 1 : 0;
          answerScores.judged++;
          console.log(
            `${''.padEnd(24)} answer: grounded ${verdict.grounded}/2  correct ${verdict.correct}/2  ` +
              `cited ${verdict.cited ? 'yes' : 'no'} -- ${verdict.reason}`
          );
        }
      } catch (err) {
        console.log(`${''.padEnd(24)} answer FAILED: ${describeError(err)}`);
      }
    }
  }

  console.log('\n--- Retrieval ---');
  console.log(summarise('dense', dense));
  console.log(summarise('hybrid', hybrid));

  if (withAnswers && answerScores.judged > 0) {
    const n = answerScores.judged;
    console.log('\n--- Answers ---');
    console.log(`groundedness: ${(answerScores.grounded / (n * 2) * 100).toFixed(1)}%`);
    console.log(`correctness:  ${(answerScores.correct / (n * 2) * 100).toFixed(1)}%`);
    console.log(`cited a law:  ${(answerScores.cited / n * 100).toFixed(1)}%`);
  }

  if (failures.length > 0) {
    console.log(`\nMissed by hybrid retrieval (${failures.length}): ${failures.join(', ')}`);
  }

  console.log('');
}

main().catch((err) => {
  console.error(`Evaluation failed: ${describeError(err)}`);
  process.exit(1);
});
