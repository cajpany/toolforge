#!/usr/bin/env tsx
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

const BASE = process.env.BASE_URL || 'http://localhost:3000';

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
        const summary = summarize(event, parsed);
        process.stdout.write(`${event}${summary ? `  ${summary}` : ''}\n`);
      } catch {
        process.stdout.write(`${event}\n`);
      }
    }
  }
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

  await section('Happy path (two tools -> AssistantReply)',
    'Demonstrates end-to-end tool orchestration (places.search → bookings.create) with structured AssistantReply frames.',
    async () => {
    await readSSE('/v1/stream', { prompt: 'Find pizza; book at 7pm' });
  });

  await section('Deep combo streaming (union/enum + deltas)',
    'Streams partial JSON across multiple deltas and shows union/enum handling in the DeepCombo schema.',
    async () => {
    await readSSE('/v1/stream', { mode: 'deep_combo_test' });
  });

  await section('JSON repair (invalid → minimal fallback)',
    'Emits an invalid AssistantReply and validates single-repair fallback to a minimal valid object with diagnostics.error.',
    async () => {
    await readSSE('/v1/stream', { mode: 'repair_test' });
  });

  await section('Provider fallback (soft minimal result)',
    'Simulates a provider producing no usable result; the server emits a degraded minimal AssistantReply with diagnostics.error=provider_no_result.',
    async () => {
    await readSSE('/v1/stream', { mode: 'provider_fallback_test' });
  });

  await section('Retry + Idempotency (failOnce → retry)',
    'Shows automatic retry for a failing tool and idempotency behavior to avoid duplicate work (attempt=2).',
    async () => {
    await readSSE('/v1/stream', { mode: 'retry_test', testKey: 'walkthrough-1' });
  });

  await section('Timeout handling (tool timeout)',
    'Executes a long-running tool and demonstrates graceful timeout handling with an acknowledgment in the final result.',
    async () => {
    await readSSE('/v1/stream', { mode: 'timeout_test' });
  });

  await section('Artifacts viewer (latest run)',
    'Pretty-prints the frames.ndjson timeline and shows saved prompt, result, and metrics for traceability.',
    async () => {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'demo/artifacts-viewer.ts', 'artifacts'], { stdio: 'inherit' });
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
