import { venueTimeLabel } from './datetime';

test('names the zone and the venue city', () => {
    expect(venueTimeLabel('America/New_York', 'Rosen Shingle Creek, Orlando, FL')).toBe('Venue time: Eastern (Orlando)');
});
test('falls back to the city in the zone id', () => {
    expect(venueTimeLabel('America/Los_Angeles', '')).toBe('Venue time: Pacific (Los Angeles)');
});
test('no zone, no chip text', () => {
    expect(venueTimeLabel('', 'Somewhere')).toBe('');
});
