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
  console.log('- Problem: brittle JSON + tool orchestration in LLM streams');
  console.log('- Our solution: partial-JSON framing, single-repair fallback, mid-stream tools, determinism, and artifacts.');
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
    'Streams tokens from the provider using deterministic config (temperature, seed, max_tokens) and sentinel framing.',
    async () => {
    const s = await readSSE('/v1/stream', { mode: 'provider_demo', prompt: 'Follow the sentinel instructions. Emit a short AssistantReply after demonstrating JSON framing.' });
    const metrics = readMetrics();
    printSectionSummary(s, metrics);
  });

  await section('Provider tools (places.search → bookings.create)',
    'Orchestrates mid-stream tools with the provider: pause → execute local tool → resume and finalize AssistantReply.',
    async () => {
    const s = await readSSE('/v1/stream', { mode: 'provider_tools_demo', prompt: 'First emit an Action object. Then call places.search with {"query":"pizza","radius_km":3}. If any place is open, call bookings.create with {"place_id":"p1","time":"19:00","party_size":2}. Finally return AssistantReply.' });
    const metrics = readMetrics();
    printSectionSummary(s, metrics);
  });

  await section('Provider tools (retry + idempotency with test.failOnce)',
    'Demonstrates automatic retry on a failing tool and idempotent re-run using the same Idempotency-Key header across two requests.',
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
    'Instructs the provider to call test.sleep with ms > TOOL_TIMEOUT_MS and shows graceful timeout handling in the final AssistantReply.',
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
    'Runs 21 targeted cases to validate event ordering, repair behavior, provider fallback, backpressure, timeouts, idempotency, and schema conformance.',
    async () => {
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
