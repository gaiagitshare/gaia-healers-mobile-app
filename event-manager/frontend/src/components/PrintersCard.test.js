// The dashboard's door-printer card renders what the server says: a row per
// desk, failing desks marked, the shared printer called out by its sticker tag.
//
// Run: CI=true npx react-scripts test --watchAll=false PrintersCard
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import PrintersCard from './PrintersCard';
import { getPrinterStatus } from '../utils/api';

jest.mock('../utils/api', () => ({ getPrinterStatus: jest.fn() }));

const now = new Date(Date.now() - 5 * 60000).toISOString().replace('Z', '');
const SAMPLE = {
    event_id: 1, hours: 24, printed: 12, failed: 2,
    shared_printers: [{ device: 'B1 Pro-H123', desks: ['Desk 1', 'Desk 2'] }],
    desks: [
        { station: 'Desk 2', named: true, operators: ['desk2@gaiahealers.app'], device: 'B1 Pro-H123', printer: 'NIIMBOT B1 Pro 300 dpi',
          browser: 'iPad/Safari', status: 'failed', printed: 0, print_failed: 0, connect_failed: 2,
          last: { at: now, stage: 'connect', result: 'failed', error: 'ConnectTimeout: The printer did not answer.' },
          last_failure: { at: now, stage: 'connect', error: 'ConnectTimeout: The printer did not answer.', trace: ['picked "B1 Pro-H123"'] },
          shares_printer_with: ['Desk 1'] },
        { station: 'Desk 1', named: true, operators: ['desk1@gaiahealers.app'], device: 'B1 Pro-H123', printer: 'NIIMBOT B1 Pro 300 dpi',
          browser: 'iPad/Bluefy', status: 'ok', printed: 12, print_failed: 2, connect_failed: 0,
          last: { at: now, stage: 'print', result: 'ok', error: null }, last_failure: null, shares_printer_with: ['Desk 2'] },
    ],
};

let container; let root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

test('a row per desk, the failing one marked, the shared printer named by its tag', async () => {
    getPrinterStatus.mockResolvedValue({ data: SAMPLE });
    await act(async () => { root.render(<PrintersCard eventId={1} eventName="Elevate 2026" />); });
    const text = container.textContent;
    expect(getPrinterStatus).toHaveBeenCalledWith(1, 24);
    expect(text).toContain('Door printers');
    expect(text).toContain('12 printed · 2 failed');
    expect(text).toContain('1 desk failing');
    expect(text).toContain('Printer H123 is being used by Desk 1 and Desk 2');
    expect(text).toContain('iPad/Safari');
    expect(text).toContain('Failing');
    expect(text).toContain('2 connect');
    expect(text).toContain('5 min ago — ConnectTimeout: The printer did not answer.');
    expect(container.querySelectorAll('tbody tr').length).toBe(2);
});

test('no activity says so instead of an empty table', async () => {
    getPrinterStatus.mockResolvedValue({ data: { ...SAMPLE, desks: [], shared_printers: [], printed: 0, failed: 0 } });
    await act(async () => { root.render(<PrintersCard eventId={1} />); });
    expect(container.textContent).toContain('No printer activity in the last 24 hours');
    expect(container.querySelector('table')).toBeNull();
});
