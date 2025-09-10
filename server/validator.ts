import { z } from 'zod';
import { SchemaRegistry } from './schemas.js';

export type ValidationNote = {
  frameId: string;
  schema?: string;
  ok: boolean;
  errors?: unknown;
  kind: 'json' | 'result';
};

export class Validator {
  private jsonBuf: Record<string, { schema: string; buf: string }> = {};
  private resultBuf: Record<string, { schema: string; buf: string }> = {};
  public notes: ValidationNote[] = [];

  onJsonBegin(id: string, schema: string) {
    this.jsonBuf[id] = { schema, buf: '' };
  }
  onJsonDelta(id: string, chunk: string) {
    const e = this.jsonBuf[id];
    if (e) e.buf += chunk;
  }
  onJsonEnd(id: string) {
    const e = this.jsonBuf[id];
    if (!e) return;
    delete this.jsonBuf[id];
    try {
      const obj = JSON.parse(e.buf);
      const schema = SchemaRegistry[e.schema];
      if (schema) (schema as z.ZodTypeAny).parse(obj);
      this.notes.push({ frameId: id, schema: e.schema, ok: true, kind: 'json' });
    } catch (err) {
      this.notes.push({ frameId: id, schema: e.schema, ok: false, errors: err, kind: 'json' });
    }
  }

  onResultBegin(id: string, schema: string) {
    this.resultBuf[id] = { schema, buf: '' };
  }
  onResultDelta(id: string, chunk: string) {
    const e = this.resultBuf[id];
    if (e) e.buf += chunk;
  }
  onResultEnd(id: string) {
    const e = this.resultBuf[id];
    if (!e) return;
    delete this.resultBuf[id];
    try {
      const obj = JSON.parse(e.buf);
      const schema = SchemaRegistry[e.schema];
      if (schema) (schema as z.ZodTypeAny).parse(obj);
      this.notes.push({ frameId: id, schema: e.schema, ok: true, kind: 'result' });
    } catch (err) {
      this.notes.push({ frameId: id, schema: e.schema, ok: false, errors: err, kind: 'result' });
    }
  }
}
