import { z } from 'zod';

export const Priority = z.enum(['low', 'medium', 'high']);

const ActionA = z.object({ kind: z.literal('A'), id: z.string(), weight: z.number().int().min(0) });
const ActionB = z.object({ kind: z.literal('B'), name: z.string(), tags: z.array(z.string()).default([]) });
const ActionC = z.object({ kind: z.literal('C'), when: z.string(), priority: Priority });

export const Item = z.union([ActionA, ActionB, ActionC]);

export const DeepCombo = z.object({
  meta: z.object({ version: z.number().int().min(1), source: z.string() }),
  items: z.array(Item).min(1),
  flags: z.array(z.enum(['x', 'y', 'z'])).default([]),
});

export type DeepCombo = z.infer<typeof DeepCombo>;
