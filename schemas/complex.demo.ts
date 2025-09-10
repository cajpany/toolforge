import { z } from 'zod';

export const Mode = z.enum(['search', 'book']);
export const Target = z.union([
  z.object({ kind: z.literal('place'), id: z.string() }),
  z.object({ kind: z.literal('time'), at: z.string() }),
]);

export const ComplexDemo = z.object({
  mode: Mode,
  targets: z.array(Target).min(1),
  notes: z.array(z.string()).default([]),
});

export type ComplexDemo = z.infer<typeof ComplexDemo>;
