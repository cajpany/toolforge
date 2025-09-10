import { z } from 'zod';
import { PlacesSearch } from '../schemas/places.search.js';
import { AssistantReply } from '../schemas/assistantReply.js';
import { BookingsCreate } from '../schemas/bookings.create.js';

export const SchemaRegistry: Record<string, z.ZodTypeAny> = {
  'PlacesSearch': PlacesSearch,
  'AssistantReply': AssistantReply,
  'BookingsCreate': BookingsCreate,
  // Add more schemas here as needed
};
