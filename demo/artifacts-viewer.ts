#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';

function readJsonSafe<T = any>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readLines(p: string): string[] {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return txt.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function pad(n: number, w = 5) {
  const s = String(n);
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function summarize(event: string, data: any): string {
  try {
    switch (event) {
      case 'json.begin':
        return `schema=${data?.schema ?? ''}`;
      case 'json.delta': {
        const len = (data?.chunk ? String(data.chunk) : '').length;
        return `chunk_len=${len}`;
      }
      case 'json.end':
        return `length=${data?.length ?? ''}`;
      case 'result.begin':
        return `schema=${data?.schema ?? ''}`;
      case 'result.delta': {
        const len = (data?.chunk ? String(data.chunk) : '').length;
        return `chunk_len=${len}`;
      }
      case 'result.end':
        return `length=${data?.length ?? ''}`;
      case 'tool.call':
        return `name=${data?.name ?? ''}`;
      case 'tool.result': {
        const name = data?.name ?? '';
        const err = data?.result?.error ? ` error=${String(data.result.error)}` : '';
        return `name=${name}${err}`;
      }
      case 'error':
        return `code=${data?.code ?? ''}`;
      case 'done':
        return '';
      default:
        return '';
    }
  } catch {
    return '';
  }
}

function main() {
  const args = process.argv.slice(2);
  const baseDir = args[0] || 'artifacts';
  const flags = new Set(args.slice(1));
  const NO_DELTA = flags.has('--no-delta');
  const COMPACT = flags.has('--compact');
  const ONLY_SUMMARY = flags.has('--only-summary');
  const framesPath = path.join(baseDir, 'frames.ndjson');
  const promptPath = path.join(baseDir, 'prompt.json');
  const metricsPath = path.join(baseDir, 'metrics.json');
  const resultPath = path.join(baseDir, 'result.json');

  if (!fs.existsSync(baseDir)) {
    console.error(`No artifacts found at ${baseDir}`);
    process.exit(1);
  }

  const prompt = readJsonSafe(promptPath);
  const metrics = readJsonSafe(metricsPath);
  const result = readJsonSafe(resultPath);
  const lines = readLines(framesPath);

  console.log(`\nArtifact Viewer: ${baseDir}\n`);
  if (prompt) {
    console.log('Prompt:');
    console.log(JSON.stringify(prompt, null, 2));
    console.log();
  }

  if (lines.length === 0) {
    console.log('No frames.ndjson found or it is empty.');
  } else {
    if (!ONLY_SUMMARY) console.log('Timeline:');
    let t0 = 0;
    // Aggregate contiguous deltas regardless of chunk size
    let pendingType: 'json.delta' | 'result.delta' | '' = '';
    let pendingCount = 0;
    let pendingBytes = 0;
    let pendingFirstDt = 0;
    // Totals for summary when --no-delta
    let totalJsonDeltaCount = 0;
    let totalJsonDeltaBytes = 0;
    let totalResultDeltaCount = 0;
    let totalResultDeltaBytes = 0;
    function flushDelta() {
      if (pendingCount > 0 && pendingType) {
        if (!NO_DELTA && !ONLY_SUMMARY) console.log(`[+${pad(pendingFirstDt)}ms] ${pendingType}  × ${pendingCount} (bytes=${pendingBytes})`);
        if (pendingType === 'json.delta') { totalJsonDeltaCount += pendingCount; totalJsonDeltaBytes += pendingBytes; }
        if (pendingType === 'result.delta') { totalResultDeltaCount += pendingCount; totalResultDeltaBytes += pendingBytes; }
        pendingType = '';
        pendingCount = 0;
        pendingBytes = 0;
        pendingFirstDt = 0;
      }
    }
    lines.forEach((line, i) => {
      try {
        const rec = JSON.parse(line);
        if (i === 0) t0 = rec.t || 0;
        const dt = rec.t && t0 ? rec.t - t0 : 0;
        const event = rec.event as string;
        const data = rec.data;
        if (event === 'json.delta' || event === 'result.delta') {
          const len = (data?.chunk ? String(data.chunk) : '').length;
          if (pendingType && pendingType !== event) {
            flushDelta();
          }
          if (!pendingType) pendingFirstDt = dt;
          pendingType = event as typeof pendingType;
          pendingCount++;
          pendingBytes += len;
        } else {
          flushDelta();
          if (!ONLY_SUMMARY && !(COMPACT && event.startsWith('json.'))) {
            const sum = summarize(event, data);
            console.log(`[+${pad(dt)}ms] ${event}${sum ? '  ' + sum : ''}`);
          }
        }
      } catch {}
    });
    flushDelta();
    if (NO_DELTA || ONLY_SUMMARY) {
      console.log(`Delta summary: json.delta chunks=${totalJsonDeltaCount} bytes=${totalJsonDeltaBytes}; result.delta chunks=${totalResultDeltaCount} bytes=${totalResultDeltaBytes}`);
    }
    console.log();
  }

  if (result) {
    console.log('Final Result:');
    console.log(JSON.stringify(result, null, 2));
    console.log();
  }

  if (metrics) {
    console.log('Metrics:');
    console.log(JSON.stringify(metrics, null, 2));
    console.log();
  }
}

main();
