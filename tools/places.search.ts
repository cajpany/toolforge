import { PlacesSearch, type PlacesSearchInput } from '../schemas/places.search.js';

const FIXTURES = [
  { id: 'p1', name: 'Central Pizza', distance_km: 0.8, open_now: true },
  { id: 'p2', name: 'Roma Slice', distance_km: 1.2, open_now: true },
  { id: 'p3', name: 'Neapolitan Corner', distance_km: 2.4, open_now: false },
] as const;

export async function executePlacesSearch(args: PlacesSearchInput, _idempotencyKey?: string) {
  const parsed = PlacesSearch.parse(args);
  const maxR = parsed.radius_km;
  const open = parsed.open_now;
  const results = FIXTURES.filter((p) => p.distance_km <= maxR && (open === undefined || p.open_now === open));
  return results;
}
