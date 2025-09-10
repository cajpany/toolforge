# ToolForge — Requirements and Phase-wise Plan

Status legend
- [TODO] Not started
- [IN PROGRESS] Currently being worked on
- [DONE] Completed

Project snapshot (decisions locked)
- Category: Best Overall (primary), Wildcard (secondary)
- Provider/runtime: Groq with gpt-oss-20b for demo; optional local vLLM profile (stretch)
- SDK scope: TypeScript SDK for MVP; Go SDK is stretch
- Transport: Server-Sent Events (SSE) for MVP; WebSocket is stretch
- Repair policy: One repair retry; on failure emit minimal valid object with `diagnostics.error = "schema_repair_failed"`, keep stream going; mark frame as degraded in logs
- Tools: Demo mocks (e.g., `places.search`, `bookings.create`) with deterministic fixture-backed results; optional Idempotency-Key pass-through
- Determinism: temperature=0.2, seed=42, capped max_tokens in demo profile
- Env vars: `GROQ_API_KEY`, `GROQ_BASE_URL`, `MODEL_ID=gpt-oss-20b`, `REPAIR_RETRIES=1`, `FRAME_TIMEOUT_MS=15000`, `TOOL_TIMEOUT_MS=8000`

Success criteria (aligned to judging)
- Application of gpt-oss: Deterministic framed streaming, mid-stream tool calling, JSON guarantees, artifacts saved
- Design: Clean protocol, safe defaults, polished demo UI + TS SDK with backpressure
- Potential impact: 100+ conformance tests with green matrix and trace logs
- Novelty: Mid-stream pause/execute/resume + partial-JSON frames + single-repair fallback
- Performance budget: p50 end-to-end ≤ 1.5s (single tool), ≤ 2.5s (two tools); 0 schema failures on conformance suite

Planned repo layout
```
toolforge/
  server/            # Fastify emitter/validator/repair, tool exec
  schemas/           # Zod & JSON-Schema
  prompts/           # system.txt, repair.txt
  clients/ts/        # TypeScript SDK
  tools/             # demo tools: places.search, bookings.create
  tests/             # conformance cases + harness
  demo/              # tiny web UI & CLI
  artifacts/         # saved frames & transcripts
  README.md
  requirements.md
```

Environments & profiles
- Demo profile (Groq):
  - `MODEL_ID=gpt-oss-20b`, `temperature=0.2`, `seed=42`, `max_tokens` capped
- Dev profile (local):
  - `DEV_MODEL_ID=llama-3.1-8b-instruct` or smaller; optional vLLM
- Optional Local Agent profile (stretch):
  - Local-only tools: `fs.read` (whitelist), `sqlite.query` (embedded), `time.now`

Wire protocol (streaming, model-agnostic)
- Frame types (server → client events):
  - `text.delta`, `json.begin`, `json.delta`, `json.end`, `tool.call`, `tool.result`, `result.begin`, `result.delta`, `result.end`, `error`, `done`
- Model emission contract: use sentinels
  - `⟦BEGIN_OBJECT id=<ID> schema=<SchemaName>⟧ ... ⟦END_OBJECT id=<ID>⟧`
  - `⟦BEGIN_TOOL_CALL id=<ID> name=<ToolName>⟧ ... ⟦END_TOOL_CALL id=<ID>⟧`
  - `⟦BEGIN_RESULT id=<ID> schema=AssistantReply⟧ ... ⟦END_RESULT id=<ID>⟧`

Sentinel grammar and constraints
- Sentinels are locked to U+27E6 (⟦) and U+27E7 (⟧).
- Sentinels are never allowed inside JSON strings; if present, they MUST be escaped as `\u27E6`/`\u27E7`.
- Exactly one active frame at a time; no nested frames; IDs must be unique per stream.

EBNF mini-spec
```
frame         := begin_object | end_object | begin_tool | end_tool | begin_result | end_result
begin_object  := "⟦BEGIN_OBJECT id=" id " schema=" name "⟧"
end_object    := "⟦END_OBJECT id=" id "⟧"
begin_tool    := "⟦BEGIN_TOOL_CALL id=" id " name=" name "⟧"
end_tool      := "⟦END_TOOL_CALL id=" id "⟧"
begin_result  := "⟦BEGIN_RESULT id=" id " schema=" name "⟧"
end_result    := "⟦END_RESULT id=" id "⟧"
```

SSE event schema (server → client)
```
event: json.begin
data: {"id":"O1","schema":"Action"}

event: json.delta
data: {"id":"O1","chunk":"{\"type\":\"search\""}

event: json.end
data: {"id":"O1","length":142}

event: tool.call
data: {"id":"T1","name":"places.search","args":{"query":"pizza","radius_km":3}}

event: tool.result
data: {"id":"T1","name":"places.search","result":[{...}]}

event: result.begin
data: {"id":"R1","schema":"AssistantReply"}

event: result.delta
data: {"id":"R1","chunk":"{\"answer\":\"...\""}

event: result.end
data: {"id":"R1","length":220}

event: error
data: {"code":"...","message":"..."}

event: done
data: {}

# Heartbeat every 15s so proxies don’t kill the stream
event: ping
data: {}
```

Determinism & backpressure invariants
- Demo profile: `temperature=0.2`, `seed=42`, `max_tokens<=384`.
- Backpressure: server pauses provider when outbound queue > N chunks (N=128); resumes when drained.
- Idempotent tools: if `Idempotency-Key` repeats, return cached `tool.result` for the same key.

Schemas (initial)
- Tool: `places.search` (Zod)
- Tool: `bookings.create` (Zod)
- Final: `AssistantReply` (Zod)
- JSON-Schema equivalents for validator parity and docs

Example enum/union schema (common failure mode coverage)
```ts
import { z } from "zod";

export const Mode = z.enum(["search","book"]);
export const Target = z.union([
  z.object({ kind: z.literal("place"), id: z.string() }),
  z.object({ kind: z.literal("time"), at: z.string() })
]);

export const Action = z.object({
  mode: Mode,
  target: Target
});
```

Prompts
- `prompts/system.txt`: strict framing & JSON contract
- `prompts/repair.txt`: diff-backoff, single retry, minimal edit constraints

Artifacts (per run)
- `artifacts/frames.ndjson`
- `artifacts/prompt.json`
- `artifacts/result.json`
- `artifacts/tool_logs.json`
- Conformance matrix snapshot (image/JSON)
- `artifacts/metrics.json` (latency stats, repair count, tool timings, degraded frames)

Security & limits
- Sentinel-safe parser (ignore inside JSON strings, handle escapes)
- Max frame size: 64KB; max JSON depth: 16; max tool args size: 32KB
- Tool result size cap; strip or escape sentinel-like sequences before emit
- Timeouts and retries (request, frame, tool)
- Redact secrets in logs (patterns: `sk_`, `api_key`, `authorization`)

Demo (3 minutes)
- Query: “Find pizza near me; book a table at 7pm if open.”
- Show Action object → `tool.call(places.search)` → `tool.result`
- Model issues `tool.call(bookings.create)` → `tool.result`
- Finish with structured `AssistantReply`
- Briefly simulate network/client hiccup → pause/resume
- Show single malformed JSON repaired successfully

Phase-wise plan and microtasks

D0 — Project setup [TODO]
- Repo bootstrap
  - Initialize `package.json` workspaces or single-package
  - Lint/format: `eslint`, `prettier`
  - TS config: `tsconfig.json` (server, sdk, tests)
  - Scripts: `dev`, `build`, `test`, `demo`, `test:conformance`
- CI (lightweight): Node LTS matrix, tests, lint
- README skeleton with badges and quick start

D1 — Framing + SSE + Single-tool happy path [TODO]
- Framing parser
  - Sentinel tokenizer with string/escape tracking
  - Frame lifecycle: `json.begin/δ/end`, `tool.call`, `result.*`
  - Depth/size enforcement
- SSE Emitter (Fastify)
  - Endpoint: `POST /v1/stream`
  - Backpressure-aware SSE write queue
  - Artifacts writer (frames.ndjson)
  - Heartbeat `event: ping` every 15s
- Zod schemas
  - `schemas/places.search.ts`, `schemas/assistantReply.ts`
  - JSON-Schema generation (for docs/tests)
- Provider integration (Groq)
  - OpenAI-compatible stream client
  - Demo profile (temp/seed/max_tokens)
- Tool runner (mock)
  - `tools/places.search` returning fixture results deterministically
  - Validate args via Zod; shape tool results
- Prompts
  - `prompts/system.txt` (strict)
  - Hook into request context
- Minimal CLI example
  - `demo/cli.ts` to call `/v1/stream` and print event trace

D2 — Mid-stream tools, timeouts, backpressure, 30 tests [TODO]
- Mid-stream pause/execute/resume
  - Pause model stream on `BEGIN_TOOL_CALL`
  - Validate args, run tool with timeout+retry
  - Emit `tool.result`, resume model by appending tool_result to context
- Backpressure
  - Pause when client buffer full; resume on drain
  - Server pauses provider when outbound queue > N chunks (N=128); resume when drained
  - Provider buffering policy + abort/continue fallback
- Idempotency
  - Accept `Idempotency-Key` header and pass-through to tools
  - If `Idempotency-Key` repeats, return cached `tool.result`
- Conformance (first 30)
  - Valid JSON under stream (nested arrays/objects)
  - Early `END_OBJECT` repaired
  - Multiple `tool.call`s; tool error then retry
  - Interruptions: cancel mid-gen; resume new request

D3 — Repair loop, complex schemas, 80+ tests, TS SDK [TODO]
- Repair loop
  - Single retry with low temperature; minimal edit constraints
  - On failure: emit minimal valid object with diagnostics block and continue stream
    ```json
    {
      "answer": "",
      "citations": [],
      "diagnostics": {
        "error": "schema_repair_failed",
        "last_validator_errors": [
          {"path":".field","message":"expected string"}
        ]
      }
    }
    ```
  - Mark the frame as degraded in `artifacts/frames.ndjson`
- Complex schemas
  - Enums, unions, nested arrays; late required keys
- TypeScript SDK (clients/ts)
  - `startStream({ onToolCall, onJSON, onResult })`
  - Backpressure hooks: `pause()`, `resume()`
  - Timeouts: per tool, per request
  - Example app + docs
  - SDK callback types
    ```ts
    export type OnToolCall = (t: { id: string; name: string; args: unknown }) => Promise<unknown>;
    export type OnJSON     = (j: { id: string; delta?: string; end?: boolean }) => void;
    export type OnResult   = (r: { id: string; delta?: string; end?: boolean }) => void;
    ```
- Conformance (to 80+)
  - Security: depth/size limits enforced
  - Determinism with fixed seed across runs

D4 — 100+ tests, demo app, artifacts, docs [TODO]
- Conformance to 100+ with matrix output
- Demo web UI (tiny)
  - Event timeline UI for frames and tools
- Artifacts & logging polish
  - Save prompts, results, tool logs per run
- README
  - Model usage (gpt-oss), deterministic config, setup for Groq + optional vLLM
  - Guarantees & limitations section
  - Test matrix snapshot

Definition of Done per phase
- D0: Repo boots, lint/test scripts run green locally and in CI.
- D1: Single tool happy path streams end-to-end; artifacts written; ping heartbeat visible.
- D2: Mid-stream tools with backpressure and idempotency verified; first 30 tests green.
- D3: Repair + complex schemas + TS SDK callbacks working; 80+ tests green.
- D4: 100+ tests green; demo UI shows timeline; artifacts complete; README polished.
- D5: Video recorded; Devpost submission prepared; final QA pass.

D5 — Polish, video, submission packaging [TODO]
- 3-minute demo video (script + recording)
- Devpost submission text and links
- License (Apache-2.0 or MIT)
- Final QA pass of conformance & demo paths

Conformance test categories (outline)
- Valid JSON under stream: nested objects/arrays, unions, enums
- Partial frames & resume: spread across many deltas, early `END_OBJECT`
- Mid-stream tools: multiple tools; tool error then retry; late keys
- Interruptions: cancel mid-generation; resume new request; client disconnect
- Backpressure: slow consumer; pause/resume correctness
- Repair: trailing commas, wrong types, missing required keys → single repair success
- Security: no code execution in strings; length & depth limits enforced
- Compliance: deterministic outputs with fixed seed (Groq path)

Initial seed cases (to implement early)
- `cases/nested_arrays_early_end.json`
- `cases/multi_tool_call_with_retry.json`
- `cases/repair_missing_required_key.json`
- `cases/backpressure_slow_client.json`
- `cases/interrupt_cancel_resume.json`

Open questions
- None — decisions locked for MVP. Future stretches: Go SDK, WebSocket transport, full Local Agent profile.

Changelog
- 2025-09-10: Created `requirements.md` and initialized phase-wise plan.
- 2025-09-10: Upgraded spec with sentinel grammar, SSE schema + heartbeat, determinism/backpressure invariants, explicit fallback object, security limits, enum/union schema example, metrics artifact, EBNF, SDK callback types, and phase DoD.
