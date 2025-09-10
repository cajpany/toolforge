import { z } from 'zod';

export const PlacesSearch = z.object({
  query: z.string().min(1),
  radius_km: z.number().int().min(1).max(50).default(5),
  open_now: z.boolean().optional(),
});

export type PlacesSearchInput = z.infer<typeof PlacesSearch>;
