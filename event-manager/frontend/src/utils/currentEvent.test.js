import { pickCurrentEvent } from './currentEvent';

const NOW = Date.parse('2026-11-07T20:00:00Z');
const ev = (id, start, end, extra = {}) => ({ id, start_date: start, end_date: end, is_archived: false, is_active: true, ...extra });

test('opens the nearest upcoming event when none is running', () => {
    const list = [ev(2, '2025-11-07T10:00:00', '2025-11-09T10:00:00', { is_archived: true }),
        ev(1, '2026-11-20T09:00:00', '2026-11-22T18:00:00'), ev(3, '2027-03-01T09:00:00', '2027-03-02T18:00:00')];
    expect(pickCurrentEvent(list, NOW).id).toBe(1);
});

test('a running event wins over an upcoming one', () => {
    const list = [ev(1, '2026-11-20T09:00:00', '2026-11-22T18:00:00'), ev(4, '2026-11-06T09:00:00', '2026-11-08T18:00:00')];
    expect(pickCurrentEvent(list, NOW).id).toBe(4);
});

test('an event stays current through its last day', () => {
    expect(pickCurrentEvent([ev(5, '2026-11-05T09:00:00', '2026-11-07T09:00:00')], NOW).id).toBe(5);
});

test('never an archived, finished or deactivated event', () => {
    const list = [ev(2, '2026-11-01', '2026-11-30', { is_archived: true }), ev(6, '2026-10-01', '2026-10-02'),
        ev(7, '2026-12-01', '2026-12-02', { is_active: false })];
    expect(pickCurrentEvent(list, NOW)).toBeNull();
    expect(pickCurrentEvent([], NOW)).toBeNull();
});
