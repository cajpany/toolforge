import { executePlacesSearch } from '../tools/places.search.js';
import { executeBookingsCreate } from '../tools/bookings.create.js';

export type ToolExecutor = (args: any, idempotencyKey?: string) => Promise<any>;

export const ToolsRegistry: Record<string, ToolExecutor> = {
  'places.search': executePlacesSearch,
  'bookings.create': executeBookingsCreate,
};
