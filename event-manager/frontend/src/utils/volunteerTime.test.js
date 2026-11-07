import { dayLabel, timeLabel, shiftTime } from './volunteerTime';

test('days and times are the event\'s own, whatever the device time zone', () => {
    expect(dayLabel('2026-11-20')).toBe('Friday, November 20');
    expect(dayLabel('2026-11-19')).toBe('Thursday, November 19');
    expect(timeLabel('09:00')).toBe('9:00 AM');
    expect(timeLabel('12:00')).toBe('12:00 PM');
    expect(timeLabel('16:50')).toBe('4:50 PM');
    expect(shiftTime({ start_time: '13:00', end_time: '16:00' })).toBe('1:00 PM – 4:00 PM');
});
