export type FrameEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'json.begin'; id: string; schema: string }
  | { type: 'json.delta'; id: string; chunk: string }
  | { type: 'json.end'; id: string; length: number }
  | { type: 'tool.call'; id: string; name: string; args: unknown }
  | { type: 'tool.result'; id: string; name: string; result: unknown }
  | { type: 'result.begin'; id: string; schema: string }
  | { type: 'result.delta'; id: string; chunk: string }
  | { type: 'result.end'; id: string; length: number };

const SENT_BEGIN_OBJECT = '⟦BEGIN_OBJECT';
const SENT_END_OBJECT = '⟦END_OBJECT';
const SENT_BEGIN_TOOL = '⟦BEGIN_TOOL_CALL';
const SENT_END_TOOL = '⟦END_TOOL_CALL';
const SENT_BEGIN_RESULT = '⟦BEGIN_RESULT';
const SENT_END_RESULT = '⟦END_RESULT';
const SENT_END = '⟧';

type ActiveFrame =
  | { kind: 'object'; id: string; schema: string; buf: string }
  | { kind: 'tool'; id: string; name: string; buf: string }
  | { kind: 'result'; id: string; schema: string; buf: string };

export class FrameStream {
  private buffer = '';
  private frame: ActiveFrame | null = null;

  constructor(private emit: (e: FrameEvent) => void) {}

  ingest(chunk: string) {
    this.buffer += chunk;
    this.process();
  }

  private process() {
    // If inside a frame, look for end sentinel; otherwise look for begin sentinel
    while (true) {
      if (this.frame) {
        const endToken = this.frame.kind === 'object'
          ? SENT_END_OBJECT
          : this.frame.kind === 'tool'
          ? SENT_END_TOOL
          : SENT_END_RESULT;
        const idx = indexOfTokenOutsideStrings(this.buffer, endToken);
        if (idx === -1) {
          // No end yet; emit available JSON as delta and keep in buf
          if (this.buffer.length) {
            const delta = this.buffer;
            this.buffer = '';
            this.frame.buf += delta;
            if (this.frame.kind === 'object') {
              this.emit({ type: 'json.delta' as const, id: (this.frame as any).id, chunk: delta });
            } else if (this.frame.kind === 'result') {
              this.emit({ type: 'result.delta' as const, id: (this.frame as any).id, chunk: delta });
            }
            // For tool frames, do not emit deltas; only emit tool.call on END_TOOL_CALL
          }
          return;
        }
        // We found end sentinel; take preceding JSON chunk
        const jsonChunk = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + endToken.length);
        this.frame.buf += jsonChunk;
        const f = this.frame;
        this.frame = null;
        if (f.kind === 'object') {
          if (jsonChunk.length > 0) {
            this.emit({ type: 'json.delta', id: f.id, chunk: jsonChunk });
          }
          this.emit({ type: 'json.end', id: f.id, length: f.buf.length });
        } else if (f.kind === 'tool') {
          try {
            const args = JSON.parse(f.buf);
            this.emit({ type: 'tool.call', id: f.id, name: f.name, args });
          } catch {
            this.emit({ type: 'tool.call', id: f.id, name: f.name, args: null });
          }
        } else if (f.kind === 'result') {
          if (jsonChunk.length > 0) {
            this.emit({ type: 'result.delta', id: f.id, chunk: jsonChunk });
          }
          this.emit({ type: 'result.end', id: f.id, length: f.buf.length });
        }
        // Continue loop: there may be more tokens in buffer
      } else {
        // Search for next begin sentinel
        const begins = [SENT_BEGIN_OBJECT, SENT_BEGIN_TOOL, SENT_BEGIN_RESULT];
        let nextIdx = -1;
        let token: string | null = null;
        for (const t of begins) {
          const i = this.buffer.indexOf(t);
          if (i !== -1 && (nextIdx === -1 || i < nextIdx)) {
            nextIdx = i;
            token = t;
          }
        }
        if (nextIdx === -1 || token == null) {
          // No begin; all buffer is plain text
          if (this.buffer.length) {
            this.emit({ type: 'text.delta', text: this.buffer });
            this.buffer = '';
          }
          return;
        }
        // Emit any text before sentinel as text.delta
        if (nextIdx > 0) {
          const text = this.buffer.slice(0, nextIdx);
          this.emit({ type: 'text.delta', text });
          this.buffer = this.buffer.slice(nextIdx);
        }
        // Now buffer starts with a BEGIN_* header; parse until closing ⟧
        const endHeader = this.buffer.indexOf(SENT_END);
        if (endHeader === -1) return; // wait for complete header
        const header = this.buffer.slice(0, endHeader + SENT_END.length);
        this.buffer = this.buffer.slice(endHeader + SENT_END.length);
        // Parse header fields
        if (token === SENT_BEGIN_OBJECT) {
          const m = header.match(/BEGIN_OBJECT id=([^\s]+) schema=([^⟧\s]+)/);
          if (m) {
            const [, id, schema] = m;
            this.frame = { kind: 'object', id, schema, buf: '' };
            this.emit({ type: 'json.begin', id, schema });
          }
        } else if (token === SENT_BEGIN_TOOL) {
          const m = header.match(/BEGIN_TOOL_CALL id=([^\s]+) name=([^⟧\s]+)/);
          if (m) {
            const [, id, name] = m;
            this.frame = { kind: 'tool', id, name, buf: '' };
            // tool args will be emitted on END_TOOL_CALL as tool.call
          }
        } else if (token === SENT_BEGIN_RESULT) {
          const m = header.match(/BEGIN_RESULT id=([^\s]+) schema=([^⟧\s]+)/);
          if (m) {
            const [, id, schema] = m;
            this.frame = { kind: 'result', id, schema, buf: '' };
            this.emit({ type: 'result.begin', id, schema });
          }
        }
      }
    }
  }
}

// Find the first index of `token` in `s` that occurs outside of JSON strings.
// Tracks double-quoted strings and escape sequences. Does not handle single quotes
// (not valid in JSON) or template literals.
function indexOfTokenOutsideStrings(s: string, token: string): number {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    } else {
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (s.startsWith(token, i)) return i;
    }
  }
  return -1;
}
