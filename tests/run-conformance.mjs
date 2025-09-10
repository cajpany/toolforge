/* Minimal conformance harness (MVP) */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function readSSE(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? { prompt: 'demo' }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
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


      try {
        const parsed = data ? JSON.parse(data) : {};
        events.push({ event, data: parsed });
      } catch {
        events.push({ event, data: data });
      }
    }
  }
  return events;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function get(events, ev) {
  return events.filter((e) => e.event === ev).map((e) => e.data);
}

async function case_basic_two_tools() {
  const events = await readSSE('/v1/stream', { prompt: 'Find pizza; book at 7pm' });
  const order = events.map((e) => e.event);
  const reqSequence = ['json.begin', 'json.end', 'tool.call', 'tool.result', 'tool.call', 'tool.result', 'result.begin', 'result.end', 'done'];
  const present = reqSequence.every((ev) => order.includes(ev));
  assert(present, `Missing events. Saw: ${order.join(',')}`);
  const toolCalls = get(events, 'tool.call');
  assert(toolCalls[0]?.name === 'places.search', 'First tool.call should be places.search');
  assert(toolCalls[1]?.name === 'bookings.create', 'Second tool.call should be bookings.create');
  const resultDeltas = get(events, 'result.delta');
  const finalDelta = resultDeltas[resultDeltas.length - 1] || {};
  const chunk = finalDelta.chunk || '';
  assert(chunk.includes('Booked at') || chunk.includes('none open'), 'Final result should mention booking or none open');
  return { pass: true };
}

async function case_retry_test() {
  const events = await readSSE('/v1/stream', { mode: 'retry_test', testKey: 'rt-unique-1' });
  const calls = get(events, 'tool.call');
  assert(calls[0]?.name === 'test.failOnce', 'Expected test.failOnce tool.call');
  const results = get(events, 'tool.result');
  const res = results.find((r) => r.name === 'test.failOnce')?.result || {};
  assert(res.attempt === 2, `Expected attempt 2 after retry, got ${res.attempt}`);
  const deltas = get(events, 'result.delta');
  const last = deltas[deltas.length - 1] || {};
  assert((last.chunk || '').includes('Retry attempts 2'), 'Expected Retry attempts 2 in final result');
  return { pass: true };
}

async function case_timeout_test() {
  const events = await readSSE('/v1/stream', { mode: 'timeout_test' });
  const results = get(events, 'tool.result');
  const res = results.find((r) => r.name === 'test.sleep')?.result || {};
  assert(res.error, 'Expected error field due to timeout');
  const deltas = get(events, 'result.delta');
  const last = deltas[deltas.length - 1] || {};
  assert((last.chunk || '').includes('Timeout test: timed out'), 'Expected timed out acknowledgment in final result');
  return { pass: true };
}

async function case_backpressure_test() {
  const events = await readSSE('/v1/stream', { mode: 'backpressure_test' });
  const deltas = get(events, 'result.delta');
  assert(deltas.length >= 10, `Expected many result.delta frames, got ${deltas.length}`);
  const hasBegin = get(events, 'result.begin').length === 1;
  const hasEnd = get(events, 'result.end').length === 1;
  assert(hasBegin && hasEnd, 'Expected single result.begin and result.end');
  return { pass: true };
}

async function case_repair_test() {
  const events = await readSSE('/v1/stream', { mode: 'repair_test' });
  const deltas = get(events, 'result.delta');
  const text = deltas.map((d) => d.chunk || '').join('');
  assert(text.includes('schema_repair_failed'), 'Expected repaired object with diagnostics.error=schema_repair_failed');
  // Optionally assert metrics.degraded
  try {
    const fs = await import('node:fs');
    const metrics = JSON.parse(fs.readFileSync('artifacts/metrics.json', 'utf8'));
    assert(metrics.degraded === true, 'Expected degraded=true in metrics');
  } catch {}
  return { pass: true };
}

async function case_interrupt_test() {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/v1/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'interrupt_test' }),
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  try {
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
        const parsed = data ? JSON.parse(data) : {};
        events.push({ event, data: parsed });
        if (event === 'tool.call' && parsed?.name === 'test.sleep') {
          controller.abort();
          // exit both loops
          break;
        }
      }
      if (controller.signal.aborted) break;
    }
  } catch {}
  // We should have seen the tool.call but not the final done
  const calls = events.filter((e) => e.event === 'tool.call').map((e) => e.data);
  assert(calls.some((c) => c.name === 'test.sleep'), 'Expected tool.call for test.sleep before abort');
  const hasDone = events.some((e) => e.event === 'done');
  assert(!hasDone, 'Should not receive done after client abort');
  return { pass: true };
}

async function case_idempotency_test() {
  async function readWithHeaders(headers, testKey) {
    const res = await fetch(`${BASE}/v1/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ mode: 'retry_test', testKey }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
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
        const parsed = data ? JSON.parse(data) : {};
        events.push({ event, data: parsed });
      }
    }
    return events;
  }

  const key1 = 'IDEMP-1';
  const ev1 = await readWithHeaders({ 'Idempotency-Key': key1 }, 'idem-unique-1');
  const r1 = get(ev1, 'tool.result').find((r) => r.name === 'test.failOnce')?.result || {};
  assert(r1.attempt === 2, `First run expected attempt 2, got ${r1.attempt}`);

  const ev2 = await readWithHeaders({ 'Idempotency-Key': key1 }, 'idem-unique-1');
  const r2 = get(ev2, 'tool.result').find((r) => r.name === 'test.failOnce')?.result || {};
  assert(r2.attempt === 2, `Second run expected cached attempt 2, got ${r2.attempt}`);

  const ev3 = await readWithHeaders({ 'Idempotency-Key': 'IDEMP-2' }, 'idem-unique-2');
  const r3 = get(ev3, 'tool.result').find((r) => r.name === 'test.failOnce')?.result || {};
  assert(r3.attempt === 2, `Third run expected attempt 2 (new args), got ${r3.attempt}`);
  return { pass: true };
}

async function case_silence_timeout_test() {
  const events = await readSSE('/v1/stream', { mode: 'silence_test' });
  const errs = get(events, 'error');
  assert(errs.length >= 1, 'Expected at least one error event');
  const hasTimeout = errs.some((e) => e.code === 'frame_timeout');
  assert(hasTimeout, 'Expected frame_timeout error');
  return { pass: true };
}

async function main() {
  const cases = [
    { name: 'basic_two_tools', fn: case_basic_two_tools },
    { name: 'retry_test', fn: case_retry_test },
    { name: 'timeout_test', fn: case_timeout_test },
    { name: 'backpressure_test', fn: case_backpressure_test },
    { name: 'repair_test', fn: case_repair_test },
    { name: 'interrupt_test', fn: case_interrupt_test },
    { name: 'idempotency_test', fn: case_idempotency_test },
    { name: 'silence_timeout_test', fn: case_silence_timeout_test },
  ];
  let pass = 0;
  for (const c of cases) {
    try {
      const res = await c.fn();
      pass++;
      console.log(`[PASS] ${c.name}`, res || '');
    } catch (err) {
      console.error(`[FAIL] ${c.name}:`, err?.message || err);
    }
  }
  console.log(`\nSummary: ${pass}/${cases.length} passed`);
}

main().catch((e) => {
  console.error('Harness error', e);
  process.exit(1);
});
