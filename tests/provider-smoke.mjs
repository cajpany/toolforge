/* Provider smoke tester: runs server /v1/stream with provider modes and summarizes results. */
import 'dotenv/config';

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

function get(events, ev) {
  return events.filter((e) => e.event === ev).map((e) => e.data);
}

async function listProviderModels() {
  const url = `${(process.env.GROQ_BASE_URL || '').replace(/\/$/, '')}/models`;
  const key = process.env.GROQ_API_KEY || '';
  if (!url || !key) return { ok: false, error: 'missing_url_or_key' };
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  const json = await res.json().catch(() => ({}));
  return { ok: true, json };
}

function summarize(name, events) {
  const order = events.map((e) => e.event);
  const hasResult = order.includes('result.begin') && order.includes('result.end');
  const toolCalls = get(events, 'tool.call');
  const errors = get(events, 'error');
  return {
    name,
    counts: {
      json: order.filter((x) => x.startsWith('json.')).length,
      result: order.filter((x) => x.startsWith('result.')).length,
      tool: order.filter((x) => x.startsWith('tool.')).length,
      errors: errors.length,
    },
    toolCalls,
    hasResult,
    lastError: errors[errors.length - 1] || null,
  };
}

async function save(path, data) {
  const fs = await import('node:fs');
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

async function main() {
  const ts = new Date().toISOString().replaceAll(':', '-');
  const model = process.env.MODEL_ID || '(unset)';
  console.log(`[smoke] BASE=${BASE} MODEL_ID=${model}`);

  // Optional: list provider models
  if (process.env.GROQ_BASE_URL && process.env.GROQ_API_KEY) {
    try {
      const m = await listProviderModels();
      if (m.ok) {
        const ids = (m.json?.data || m.json?.models || []).map((x) => x.id || x.name).filter(Boolean).slice(0, 10);
        console.log(`[smoke] provider models sample: ${ids.join(', ') || '(none)'}`);
      } else {
        console.log(`[smoke] model list error: ${m.error}`);
      }
    } catch (e) {
      console.log(`[smoke] model list failed: ${e}`);
    }
  }

  const results = [];

  // 1) provider_demo mild
  const ev1 = await readSSE('/v1/stream', {
    mode: 'provider_demo',
    prompt: 'Follow the sentinel instructions. Emit an Action object, then a short AssistantReply.'
  });
  results.push(summarize('provider_demo_mild', ev1));
  await save(`artifacts/smoke-${ts}-provider_demo_mild.json`, ev1);

  // 2) provider_demo strict
  const ev2 = await readSSE('/v1/stream', {
    mode: 'provider_demo',
    prompt: 'Output exactly: ⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧ {"answer":"ok","citations":[]} ⟦END_RESULT id=R1⟧ Only these frames. No extra text.'
  });
  results.push(summarize('provider_demo_strict', ev2));
  await save(`artifacts/smoke-${ts}-provider_demo_strict.json`, ev2);

  // 3) provider_tools_demo
  const ev3 = await readSSE('/v1/stream', {
    mode: 'provider_tools_demo',
    prompt: 'Emit ⟦BEGIN_TOOL_CALL id=T1 name=places.search⟧ {"query":"pizza","radius_km":3} ⟦END_TOOL_CALL id=T1⟧ then ⟦BEGIN_TOOL_CALL id=T2 name=bookings.create⟧ {"place_id":"p1","time":"19:00","party_size":2} ⟦END_TOOL_CALL id=T2⟧ then ⟦BEGIN_RESULT id=R1 schema=AssistantReply⟧ {"answer":"ok","citations":[]} ⟦END_RESULT id=R1⟧. No extra text.'
  });
  results.push(summarize('provider_tools_demo', ev3));
  await save(`artifacts/smoke-${ts}-provider_tools_demo.json`, ev3);

  const summary = { ts, model, results };
  console.log('\n[summary]');
  console.log(JSON.stringify(summary, null, 2));
  await save(`artifacts/smoke-${ts}-summary.json`, summary);
}

main().catch((e) => {
  console.error('[smoke] error', e);
  process.exit(1);
});
