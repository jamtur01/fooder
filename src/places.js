const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.priceLevel',
  'places.nationalPhoneNumber',
  'places.googleMapsUri',
  'places.photos',
].join(',');

const PRICE_LEVEL_MAP = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

function normalize(place) {
  const photoName = place.photos?.[0]?.name ?? null;
  return {
    id: place.id,
    name: place.displayName?.text ?? '(unnamed)',
    address: place.formattedAddress ?? '',
    phone: place.nationalPhoneNumber ?? null,
    mapsUrl: place.googleMapsUri ?? null,
    rating: typeof place.rating === 'number' ? place.rating : null,
    priceLevel: place.priceLevel ? PRICE_LEVEL_MAP[place.priceLevel] ?? null : null,
    photoUrl: photoName ? `/api/photo/${photoName}` : null,
  };
}

export function makePlacesClient({ db: _db, fetch, apiKey, home, radiusMeters, now: _now }) {
  async function searchRestaurants(cuisine) {
    const body = {
      textQuery: `${cuisine} restaurants`,
      locationBias: {
        circle: {
          center: { latitude: home.lat, longitude: home.lng },
          radius: radiusMeters,
        },
      },
      maxResultCount: 10,
      openNow: true,
    };
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Places API ${res.status}`);
    }
    const data = await res.json();
    return (data.places ?? []).map(normalize);
  }
  return { searchRestaurants };
}
