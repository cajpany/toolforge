# ToolForge

Make AI answers reliable and actionable. ToolForge structures model output into small, checkable pieces, auto-fixes small mistakes once, runs real tools mid-stream, keeps runs predictable (seed/temperature), and logs everything for replay.

See `requirements.md` for the full MVP scope and phase-wise plan.

Quickstart
- Install deps: `npm i`
- Dev server: `npm run dev` (http://localhost:3000)
- Demo CLI: `npm run demo`

## Automated Walkthrough (one command)

Run a provider-only, judge-friendly demo that prints short Problem → Solution notes and compact summaries for each section.

```
npm run demo:walkthrough
# Shows provider demo, provider tools (orchestration, retry+idempotency, timeout),
# a compact artifacts summary, and the conformance suite summary.
```

## Demo Walkthrough (Terminal)

1) Start the server (new terminal)

```
npm run dev
```

2) Run the conformance suite (shows streaming protocol + guarantees)

```
npm run test:conformance
# Expected: Summary: 21/21 passed
```

3) Try a few focused scenarios via curl (SSE)

```
# Provider fallback (soft minimal result, degraded=true in metrics)
curl -N -H 'Content-Type: application/json' \
  -d '{"mode":"provider_fallback_test"}' \
  http://localhost:3000/v1/stream

# JSON repair path (invalid result repaired to minimal AssistantReply)
curl -N -H 'Content-Type: application/json' \
  -d '{"mode":"repair_test"}' \
  http://localhost:3000/v1/stream

# Deep complex streaming (union/enum + deltas)
curl -N -H 'Content-Type: application/json' \
  -d '{"mode":"deep_combo_test"}' \
  http://localhost:3000/v1/stream
```

4) Inspect artifacts (prompt, frames, metrics, result)

```
ls -lah artifacts
cat artifacts/metrics.json | jq .
```

## Artifacts Viewer (CLI)

Run a small terminal viewer to pretty-print the latest run timeline and summaries. You can pass a custom directory; defaults to `artifacts/`.

```
# Using npm script
npm run viewer

# Or directly
npx tsx demo/artifacts-viewer.ts artifacts --no-delta --compact
```

Example output (varies by run):

```
Artifact Viewer: artifacts

Prompt:
{ "request": { ... }, "model": "gpt-oss-20b", ... }

Timeline:
[+    0ms] json.begin  schema=Action
[+   20ms] json.delta  chunk_len=34
[+   40ms] json.end    length=1
[+  120ms] tool.call   name=places.search
[+  350ms] tool.result name=places.search
[+  420ms] result.begin  schema=AssistantReply
[+  500ms] result.delta  chunk_len=64
[+  540ms] result.end    length=1
[+  540ms] done

Final Result:
{ "answer": "Found 2 places...", "citations": [] }

Metrics:
{ "totalMs": 612, "validation": { ... }, "degraded": false }
```

Artifacts
- Per run, see `artifacts/` for frames, prompts, results, tool logs, and metrics.

License
- MIT or Apache-2.0 (TBD in submission)

## Environment Setup

Create a `.env` file (see `.env.example`) with at least:

```
GROQ_BASE_URL=https://api.groq.com/openai/v1
GROQ_API_KEY=your_api_key_here
MODEL_ID=llama-3.1-70b-versatile
REPAIR_RETRIES=1
FRAME_TIMEOUT_MS=15000
TOOL_TIMEOUT_MS=8000
TEMPERATURE=0.2
SEED=42
MAX_TOKENS=384
# Optional: extra provider headers (JSON)
# PROVIDER_EXTRA_HEADERS='{"X-Title":"ToolForge","HTTP-Referer":"https://your.site"}'
```

Notes:
- The server auto-loads `.env` via `dotenv/config`. Restart after changes.
- Choose a Groq model you have access to (examples: `llama-3.1-70b-versatile`, `llama-3.1-8b-instant`, `gemma2-9b-it`, `mixtral-8x7b-32768`).
- You can list models via:
  - `curl -H "Authorization: Bearer $GROQ_API_KEY" "$GROQ_BASE_URL/models"`
 - Some providers require extra headers (e.g., OpenRouter). You can set `PROVIDER_EXTRA_HEADERS` as JSON in `.env`.

## Streaming Modes

All modes are served at `POST /v1/stream` and emit SSE events: `json.*`, `tool.*`, `result.*`, `error`, `done`.

1) Local demo (deterministic tools)
- CLI: `npm run demo`
- Happy path: two tool calls and a structured `AssistantReply`.

2) Provider demo (Groq, OpenAI-compatible)
- Start server: `npm run dev`
- Run:

```
curl -N -H 'Content-Type: application/json' \
  -d '{"mode":"provider_demo","prompt":"Follow the sentinel instructions. Emit an Action object, then a short AssistantReply."}' \
  http://localhost:3000/v1/stream
```

3) Provider tools demo (pause/execute/resume)
- Orchestrates mid-stream tool calls with the provider: pause → execute local tool → resume with appended context.

```
curl -N -H 'Content-Type: application/json' \
  -d '{"mode":"provider_tools_demo","prompt":"First emit an Action object. Then call places.search with {\"query\":\"pizza\",\"radius_km\":3}. If any place is open, call bookings.create with {\"place_id\":\"p1\",\"time\":\"19:00\",\"party_size\":2}. Finally return AssistantReply."}' \
  http://localhost:3000/v1/stream
```

## Conformance

Proof it works (21 checks):

```
npm run test:conformance
# Expected: Summary: 21/21 passed
```

Problem: It's hard to trust a demo without proof.
Solution: We run 21 fast checks to show the stream stays in order, errors are handled (repair/fallback), tools are safe (retry/timeout), and results match the schema — finishing with a green summary.

### What these checks mean (plain English)

- basic_two_tools — Runs two tools in order (search → booking) and returns a sensible final answer.
- retry_test — If a tool flakes once, we retry and confirm it succeeded on attempt 2.
- timeout_test — A slow tool times out safely and the final answer explains the timeout.
- backpressure_test — Lots of tiny updates still arrive smoothly with a single start/end.
- repair_test — If the model’s answer is invalid JSON, we auto-fix once and mark it degraded.
- interrupt_test — If the user cancels, we stop mid-stream without sending a final “done”.
- idempotency_test — Same request + Idempotency-Key returns the same cached tool result (no double work).
- silence_timeout_test — If nothing arrives for too long, we emit a clear frame timeout error.
- provider_fallback_test — If the provider produces nothing useful, we return a minimal fallback answer (marked degraded).
- complex_schema_test — The “ComplexDemo” object streams correctly and the final answer is well-formed.
- deep_combo_test — The “DeepCombo” object includes all required variants and a proper final answer.
- complex_late_keys_test — Keys can arrive late (out of order) and still form a correct object.
- deep_combo_no_flags_test — Optional fields may be absent; we accept valid minimal objects.
- union_order_test — Even with mixed variants, we keep items in the intended order.
- sentinel_escape_test — Special markers are correctly escaped so JSON stays valid.
- deep_combo_many_items_test — Handles many items without breaking structure.
- complex_enum_validation_test — Validates a specific mode and mixed targets together.
- complex_schema_repair_test — Auto-fix once for ComplexDemo if the model’s answer is invalid.
- deep_combo_repair_test — Auto-fix once for DeepCombo if the model’s answer is invalid.
- deep_combo_nested_matrix_test — Handles nested arrays/objects for deeper structures.
- deep_combo_massive_strings_test — Handles very long strings without breaking the stream.

## Troubleshooting

- `model_not_found` from provider
  - Update `MODEL_ID` in `.env` to a model you have access to (e.g., `llama-3.1-70b-versatile`). Restart server.
- `Missing GROQ_API_KEY`
  - Set `GROQ_API_KEY` in `.env` and restart.
- Silent streams or early timeouts
  - `FRAME_TIMEOUT_MS` default is 15000. `error: frame_timeout` is emitted if no frames arrive in time.

## Design Highlights

- Sentinel grammar with string-aware parser; no empty terminal deltas
- Backpressure-aware SSE queue (N=128) with heartbeats
- Tool execution with timeout + retry + idempotency cache
- Single-repair fallback and degraded metrics
- Deterministic config (temperature, seed, max_tokens)

## TypeScript SDK (clients/ts)

Simple usage example using callbacks for JSON frames, tool calls, result frames, and lifecycle:

```ts
import { startStream } from "../clients/ts/index";

const h = startStream({
  url: "http://localhost:3000/v1/stream",
  body: { prompt: "Find pizza near me; book a table at 7pm if open." },
  onJSON: (j) => console.log("json:", j),
  onToolCall: async (t) => console.log("tool.call:", t),
  onResult: (r) => console.log("result:", r),
  onError: (e) => console.error("error:", e),
  onDone: () => console.log("done"),
  onPing: () => console.log("ping"),
});

// h.pause() to abort; h.isClosed() to check closed state
```
