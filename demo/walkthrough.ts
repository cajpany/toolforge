#!/usr/bin/env tsx
import 'dotenv/config';
/*
 Automated terminal walkthrough for video/demo.
 - Starts server if not running
 - Runs a sequence of streaming demos
 - Runs conformance suite
 - Prints artifacts via viewer
 - Cleans up spawned server
*/

import { spawn } from 'node:child_process';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ARGS = process.argv.slice(2);
const SHOW_DELTAS = ARGS.includes('--show-deltas');
const VERBOSE_EVENTS = ARGS.includes('--verbose-events');

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function isServerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp()) return true;
    await sleep(300);
  }
  return false;
}

function startServer(): { proc: ReturnType<typeof spawn>, owned: boolean } {
  // Start a one-shot server (no watch) so we can cleanly stop it later
  const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'server/index.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  proc.stdout?.on('data', (d) => {
    const s = String(d);
    if (s.includes('ToolForge server running')) {
      // no-op, just for visibility
    }
  });
  proc.stderr?.on('data', (d) => {
    // keep stderr quiet for demo unless needed
    const s = String(d);
    if (s.toLowerCase().includes('error')) process.stdout.write(s);
  });
  return { proc, owned: true };
}

async function readSSE(path: string, body: any, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Compact printing: aggregate contiguous delta events by type
  let pendingDeltaType: 'json.delta' | 'result.delta' | '' = '';
  let pendingDeltaCount = 0;
  let pendingDeltaBytes = 0;
  // Totals across this stream (for summary when deltas are hidden)
  let totalJsonDeltaCount = 0;
  let totalJsonDeltaBytes = 0;
  let totalResultDeltaCount = 0;
  let totalResultDeltaBytes = 0;
  const toolNames: string[] = [];
  function flushDelta() {
    if (pendingDeltaCount > 0 && pendingDeltaType) {
      if (VERBOSE_EVENTS && SHOW_DELTAS) {
        process.stdout.write(`${pendingDeltaType}  × ${pendingDeltaCount} (bytes=${pendingDeltaBytes})\n`);
      }
      if (pendingDeltaType === 'json.delta') {
        totalJsonDeltaCount += pendingDeltaCount;
        totalJsonDeltaBytes += pendingDeltaBytes;
      } else if (pendingDeltaType === 'result.delta') {
        totalResultDeltaCount += pendingDeltaCount;
        totalResultDeltaBytes += pendingDeltaBytes;
      }
      pendingDeltaType = '';
      pendingDeltaCount = 0;
      pendingDeltaBytes = 0;
    }
  }
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = chunk.split('\n').filter(Boolean);
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      // Condensed printing for video
      try {
        const parsed = data ? JSON.parse(data) : {};
        if (event === 'json.delta' || event === 'result.delta') {
          const len = (parsed?.chunk ? String(parsed.chunk) : '').length;
          if (pendingDeltaType && pendingDeltaType !== event) {
            flushDelta();
          }
          pendingDeltaType = event as typeof pendingDeltaType;
          pendingDeltaCount++;
          pendingDeltaBytes += len;
        } else {
          flushDelta();
          if (event === 'tool.call' && parsed && typeof parsed.name === 'string') {
            toolNames.push(parsed.name);
          }
          if (VERBOSE_EVENTS) {
            const summary = summarize(event, parsed);
            process.stdout.write(`${event}${summary ? `  ${summary}` : ''}\n`);
          }
        }
      } catch {
        flushDelta();
        if (VERBOSE_EVENTS) {
          process.stdout.write(`${event}\n`);
        }
      }
    }
  }
  flushDelta();
  if (VERBOSE_EVENTS && !SHOW_DELTAS) {
    process.stdout.write(`delta summary: json.delta chunks=${totalJsonDeltaCount} bytes=${totalJsonDeltaBytes}; result.delta chunks=${totalResultDeltaCount} bytes=${totalResultDeltaBytes}\n`);
  }
  return {
    jsonDeltaChunks: totalJsonDeltaCount,
    jsonDeltaBytes: totalJsonDeltaBytes,
    resultDeltaChunks: totalResultDeltaCount,
    resultDeltaBytes: totalResultDeltaBytes,
    tools: toolNames,
  };
}

function summarize(event: string, data: any): string {
  switch (event) {
    case 'json.begin':
    case 'result.begin':
      return `schema=${data?.schema ?? ''}`;
    case 'json.delta':
    case 'result.delta': {
      const len = (data?.chunk ? String(data.chunk) : '').length;
      return `chunk_len=${len}`;
    }
    case 'json.end':
    case 'result.end':
      return `length=${data?.length ?? ''}`;
    case 'tool.call':
      return `name=${data?.name ?? ''}`;
    case 'tool.result': {
      const err = data?.result?.error ? ` error=${String(data.result.error)}` : '';
      return `name=${data?.name ?? ''}${err}`;
    }
    case 'error':
      return `code=${data?.code ?? ''}`;
    default:
      return '';
  }
}

async function section(title: string, description: string, fn: () => Promise<void>) {
  console.log(`\n\n=== ${title} ===\n`);
  if (description) console.log(description + '\n');
  await fn();
}

async function run() {
  let serverOwned = false;
  let serverProc: ReturnType<typeof spawn> | null = null;

  function cleanup() {
    if (serverOwned && serverProc) {
      try {
        serverProc.kill('SIGINT');
      } catch {}
      serverProc = null;
      serverOwned = false;
    }
  }
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  process.on('exit', () => { cleanup(); });

  // Intro narrative
  console.log('\nToolForge: production-grade streaming function-calling for gpt-oss');
  console.log('- Problem: AI answers can be messy, and models can’t actually do tasks.');
  console.log('- Solution: ToolForge makes answers reliable and actionable — we structure the stream, auto-fix small mistakes once, run real tools, keep runs predictable, and log everything.');
  // Provider preflight
  const groqBase = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  const modelId = process.env.MODEL_ID || 'gpt-oss-20b';
  const hasKey = !!process.env.GROQ_API_KEY;
  console.log(`- Provider: ${groqBase}`);
  console.log(`- Model: ${modelId}`);
  if (!hasKey) {
    console.error('Missing GROQ_API_KEY. Please set it in .env to run provider-only walkthrough.');
    process.exit(1);
  }

  if (!(await isServerUp())) {
    console.log('Server not detected on :3000. Starting...');
    const { proc } = startServer();
    serverOwned = true;
    serverProc = proc;
    const ok = await waitForServer(15000);
    if (!ok) {
      console.error('Server failed to start. Exiting.');
      try { proc.kill('SIGINT'); } catch {}
      process.exit(1);
    }
    console.log('Server ready.');
  } else {
    console.log('Server already running.');
  }

  await section('Provider demo (pure provider)',
    'Problem: Raw model output can be messy or out of order — hard to trust.\nSolution: ToolForge streams in small, checkable pieces and auto-corrects once if needed. Everything is logged for replay, with predictable settings (seed, temperature).',
    async () => {
    const s = await readSSE('/v1/stream', { mode: 'provider_demo', prompt: 'Follow the sentinel instructions. Emit a short AssistantReply after demonstrating JSON framing.' });
    const metrics = readMetrics();
    printSectionSummary(s, metrics);
  });

  await section('Provider tools (places.search → bookings.create)',
    'Problem: Models “talk about” actions but don’t actually do them; wiring tools is fragile.\nSolution: ToolForge pauses the model, runs real tools, resumes with the results, and returns a clean final answer.',
    async () => {
    const s = await readSSE('/v1/stream', { mode: 'provider_tools_demo', prompt: 'First emit an Action object. Then call places.search with {"query":"pizza","radius_km":3}. If any place is open, call bookings.create with {"place_id":"p1","time":"19:00","party_size":2}. Finally return AssistantReply.' });
    const metrics = readMetrics();
    printSectionSummary(s, metrics);
  });

  await section('Provider tools (retry + idempotency with test.failOnce)',
    'Problem: Flaky tools and duplicate clicks lead to inconsistent or double actions.\nSolution: ToolForge retries once automatically and de-duplicates work with an Idempotency-Key — no double booking.',
    async () => {
    const key = 'WALK-IDEMP-1';
    const prompt = 'Call test.failOnce with {"key":"idem-walk-1"} then return an AssistantReply summarizing the attempt number.';
    // First run (attempt=2 due to retry)
    await readSSE('/v1/stream', { mode: 'provider_tools_demo', prompt }, { 'Idempotency-Key': key });
    // Second run with same Idempotency-Key (should reuse cached tool.result)
    const s = await readSSE('/v1/stream', { mode: 'provider_tools_demo', prompt }, { 'Idempotency-Key': key });
    const metrics = readMetrics();
    printSectionSummary(s, metrics);
  });

  await section('Provider tools (timeout handling)',
    'Problem: Slow tools can stall the demo.\nSolution: ToolForge sets strict time limits, emits a clear timeout result, and gracefully explains it in the final answer — the stream stays responsive.',
    async () => {
    const ms = Number(process.env.TOOL_TIMEOUT_MS ?? 8000) + 1000;
    const prompt = `Call test.sleep with {"ms":${ms}} then acknowledge the timeout in an AssistantReply.`;
    const s = await readSSE('/v1/stream', { mode: 'provider_tools_demo', prompt });
    const metrics = readMetrics();
    printSectionSummary(s, metrics);
  });

  await section('Artifacts viewer (latest run)',
    'Pretty-prints the frames.ndjson timeline and shows saved prompt, result, and metrics for traceability.',
    async () => {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(
          process.platform === 'win32' ? 'npx.cmd' : 'npx',
          ['tsx', 'demo/artifacts-viewer.ts', 'artifacts', '--no-delta', '--compact', '--only-summary'],
          { stdio: 'inherit' }
        );
        proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`viewer exit ${code}`)));
      });
    });

  await section('Conformance suite (summary)',
    'Problem: It’s hard to trust a demo without proof.\nSolution: We run 21 fast checks to show the stream stays in order, errors are handled (repair/fallback), tools are safe (retry/timeout), and results match the schema — finishing with a green summary.',
    async () => {
    // Judge-friendly explanations of each check
    console.log('What this verifies (plain English):');
    console.log('- basic_two_tools — Runs two tools in order (search → booking) and returns a sensible final answer.');
    console.log('- retry_test — If a tool flakes once, we retry and confirm it succeeded on attempt 2.');
    console.log('- timeout_test — A slow tool times out safely and the final answer explains the timeout.');
    console.log('- backpressure_test — Lots of tiny updates still arrive smoothly with a single start/end.');
    console.log('- repair_test — If the model’s answer is invalid JSON, we auto-fix once and mark it degraded.');
    console.log('- interrupt_test — If the user cancels, we stop mid-stream without sending a final “done”.');
    console.log('- idempotency_test — Same request + Idempotency-Key returns the same cached tool result (no double work).');
    console.log('- silence_timeout_test — If nothing arrives for too long, we emit a clear frame timeout error.');
    console.log('- provider_fallback_test — If the provider produces nothing useful, we return a minimal fallback answer (marked degraded).');
    console.log('- complex_schema_test — The “ComplexDemo” object streams correctly and the final answer is well-formed.');
    console.log('- deep_combo_test — The “DeepCombo” object includes all required variants and a proper final answer.');
    console.log('- complex_late_keys_test — Keys can arrive late (out of order) and still form a correct object.');
    console.log('- deep_combo_no_flags_test — Optional fields may be absent; we accept valid minimal objects.');
    console.log('- union_order_test — Even with mixed variants, we keep items in the intended order.');
    console.log('- sentinel_escape_test — Special markers are correctly escaped so JSON stays valid.');
    console.log('- deep_combo_many_items_test — Handles many items without breaking structure.');
    console.log('- complex_enum_validation_test — Validates a specific mode and mixed targets together.');
    console.log('- complex_schema_repair_test — Auto-fix once for ComplexDemo if the model’s answer is invalid.');
    console.log('- deep_combo_repair_test — Auto-fix once for DeepCombo if the model’s answer is invalid.');
    console.log('- deep_combo_nested_matrix_test — Handles nested arrays/objects for deeper structures.');
    console.log('- deep_combo_massive_strings_test — Handles very long strings without breaking the stream.');

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('node', ['tests/run-conformance.mjs'], { stdio: 'inherit' });
      proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`conformance exit ${code}`)));
    });
  });

  if (serverOwned) {
    console.log('\nShutting down server...');
    cleanup();
  }

  // Outro narrative
  console.log('\nWalkthrough complete.');
  console.log('- Deterministic streaming, tool orchestration, JSON repair, and artifacts achieved.');
  console.log('- See artifacts/ for frames.ndjson, prompt, result, and metrics.');
}

run().catch((e) => {
  console.error('Walkthrough error:', e);
  process.exit(1);
});

// Helpers
function readMetrics(): any {
  try {
    const p = path.join('artifacts', 'metrics.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function printSectionSummary(s: { jsonDeltaChunks: number; jsonDeltaBytes: number; resultDeltaChunks: number; resultDeltaBytes: number; tools: string[] }, metrics: any) {
  const tools = s.tools.length ? s.tools.join(',') : '-';
  const degraded = metrics && typeof metrics.degraded === 'boolean' ? metrics.degraded : undefined;
  const totalMs = metrics && typeof metrics.totalMs === 'number' ? metrics.totalMs : undefined;
  const parts = [
    `tools=[${tools}]`,
    `jsonΔ=${s.jsonDeltaChunks}/${s.jsonDeltaBytes}B`,
    `resultΔ=${s.resultDeltaChunks}/${s.resultDeltaBytes}B`,
  ];
  if (typeof degraded !== 'undefined') parts.push(`degraded=${degraded}`);
  if (typeof totalMs !== 'undefined') parts.push(`totalMs=${totalMs}`);
  console.log(`Summary: ${parts.join(' | ')}`);
}
