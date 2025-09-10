import { z } from 'zod';

export const BookingsCreate = z.object({
  place_id: z.string().min(1),
  time: z.string().min(1), // ISO time or natural string for demo
  party_size: z.number().int().min(1).max(12).default(2),
});

export type BookingsCreateInput = z.infer<typeof BookingsCreate>;
