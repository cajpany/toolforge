import { z } from 'zod';
import { PlacesSearch } from '../schemas/places.search.js';
import { AssistantReply } from '../schemas/assistantReply.js';
import { BookingsCreate } from '../schemas/bookings.create.js';
import { ComplexDemo } from '../schemas/complex.demo.js';
import { DeepCombo } from '../schemas/deep.combo.js';

export const SchemaRegistry: Record<string, z.ZodTypeAny> = {
  'PlacesSearch': PlacesSearch,
  'AssistantReply': AssistantReply,
  'BookingsCreate': BookingsCreate,
  'ComplexDemo': ComplexDemo,
  'DeepCombo': DeepCombo,
  // Add more schemas here as needed
};
