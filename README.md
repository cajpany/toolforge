# ToolForge

Production-grade, streaming function-calling for gpt-oss with partial-JSON frames, mid-stream tool execution, and automatic JSON repair.

See `requirements.md` for the full MVP scope and phase-wise plan.

Quickstart
- Install deps: `npm i`
- Dev server: `npm run dev` (http://localhost:3000)
- Demo CLI: `npm run demo`

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

Run the seed harness (8/8 passing):

```
npm run test:conformance
```

Includes: retry, timeout, backpressure, repair, interruption, idempotency, silence (frame timeout).

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
