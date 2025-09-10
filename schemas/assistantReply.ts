import { z } from 'zod';

export const AssistantReply = z.object({
  answer: z.string(),
  citations: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().url(),
      }),
    )
    .default([]),
  diagnostics: z
    .object({
      error: z.string(),
      last_validator_errors: z.array(z.any()).optional(),
    })
    .optional(),
});

export type AssistantReplyType = z.infer<typeof AssistantReply>;
