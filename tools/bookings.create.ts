import { BookingsCreate, type BookingsCreateInput } from '../schemas/bookings.create.js';

export async function executeBookingsCreate(args: BookingsCreateInput, _idempotencyKey?: string) {
  const parsed = BookingsCreate.parse(args);
  // Deterministic confirmation number for demo
  const conf = `CONF-${parsed.place_id}-T${parsed.time.replace(/[^0-9]/g, '')}-P${parsed.party_size}`;
  return {
    confirmation_id: conf,
    place_id: parsed.place_id,
    time: parsed.time,
    party_size: parsed.party_size,
    status: 'confirmed' as const,
  };
}
