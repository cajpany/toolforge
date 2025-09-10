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

async function main() {
  const cases = [
    { name: 'basic_two_tools', fn: case_basic_two_tools },
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
