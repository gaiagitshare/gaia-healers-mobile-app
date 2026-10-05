// Desk ↔ printer pairing and the connect time limit, against a fake Web
// Bluetooth chooser and a fake driver. Four desks, four B1 Pros that all say
// "B1 Pro-…": these pin that a desk keeps its own printer and is told, by
// name, when it picked a neighbour's.
//
// Run: CI=true npx react-scripts test --watchAll=false BadgeLabelDialog.printer
import { b1Connect, b1Disconnect, savedStationPrinter, rememberStationPrinter, STATION_PRINTER_KEY, printerTag, isAppleMobile, canPrintBluetooth } from './BadgeLabelDialog';

jest.mock('../utils/api', () => ({ badgeLabelBlob: jest.fn(), recordBadgePrint: jest.fn(), reportPrinter: jest.fn(() => Promise.resolve({ data: {} })) }));

let nextName = 'B1 Pro-H123';
let connectHangs = false;
let gattDisconnects = 0;

beforeEach(() => {
    localStorage.clear();
    nextName = 'B1 Pro-H123'; connectHangs = false; gattDisconnects = 0;
    const requestDevice = jest.fn(() => Promise.resolve({ name: nextName, gatt: { disconnect: () => { gattDisconnects += 1; } } }));
    Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice }, configurable: true });
    // The driver's identify(): opens the chooser, then talks to the printer.
    window.Niimbot = {
        DEBUG: false,
        identify: async () => {
            await navigator.bluetooth.requestDevice({});
            if (connectHangs) await new Promise(() => {});       // a printer held by another desk never answers
            return { task: 'v4', label: 'NIIMBOT B1 Pro', dpi: 300 };
        },
        probe: async () => null,
        disconnect: jest.fn(async () => {}),
        isConnected: () => false,
    };
});
afterEach(async () => { jest.useRealTimers(); await b1Disconnect(); });

test('the first printer a desk connects to becomes its printer', async () => {
    const info = await b1Connect();
    expect(info.device).toBe('B1 Pro-H123');
    expect(savedStationPrinter()).toBe('B1 Pro-H123');
    expect(localStorage.getItem(STATION_PRINTER_KEY)).toBe('B1 Pro-H123');
});

test("a neighbour's printer is refused with both names, and the link is dropped", async () => {
    rememberStationPrinter('B1 Pro-H123');
    nextName = 'B1 Pro-K456';
    await expect(b1Connect()).rejects.toMatchObject({ name: 'WrongPrinter', device: 'B1 Pro-K456', expected: 'B1 Pro-H123' });
    expect(window.Niimbot.disconnect).toHaveBeenCalled();
    expect(savedStationPrinter()).toBe('B1 Pro-H123');      // refusing never rewrites the desk's printer
});

test('"use this one for this desk" makes the next connect accept it', async () => {
    rememberStationPrinter('B1 Pro-H123');
    nextName = 'B1 Pro-K456';
    await expect(b1Connect()).rejects.toMatchObject({ name: 'WrongPrinter' });
    rememberStationPrinter('B1 Pro-K456');
    const info = await b1Connect();
    expect(info.device).toBe('B1 Pro-K456');
});

test('the chooser is put back exactly as it was', async () => {
    const before = navigator.bluetooth.requestDevice;
    await b1Connect();
    expect(navigator.bluetooth.requestDevice).toBe(before);
});

test('a picked printer that never answers fails after 20 s instead of "connecting…" for good', async () => {
    jest.useFakeTimers();
    connectHangs = true;
    const p = b1Connect();
    const caught = p.catch((e) => e);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();   // loader, chooser, pick
    jest.advanceTimersByTime(20001);
    const err = await caught;
    expect(err.name).toBe('ConnectTimeout');
    expect(gattDisconnects).toBe(1);                         // the half-open link is dropped
    expect(err.trace.some((l) => l.includes('picked "B1 Pro-H123"'))).toBe(true);
});

test('the tag is the part on the sticker', () => {
    expect(printerTag('B1 Pro-H123')).toBe('H123');
    expect(printerTag('B1-77AB')).toBe('77AB');
    expect(printerTag('Printer')).toBe('Printer');
});

test('an iPad reports as a Mac in Safari; touch is what tells it apart', () => {
    const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    const tp = Object.getOwnPropertyDescriptor(window.navigator, 'maxTouchPoints');
    try {
        Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15', configurable: true });
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });
        expect(isAppleMobile()).toBe(true);
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 0, configurable: true });
        expect(isAppleMobile()).toBe(false);                 // a real Mac
    } finally {
        if (ua) Object.defineProperty(window.navigator, 'userAgent', ua); else delete window.navigator.userAgent;
        if (tp) Object.defineProperty(window.navigator, 'maxTouchPoints', tp); else delete window.navigator.maxTouchPoints;
    }
});

test('Safari with beacio looks like any Web Bluetooth browser: the injected navigator.bluetooth is all it takes', () => {
    expect(canPrintBluetooth()).toBe(true);                  // beforeEach installs one, as the extension does
    Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    expect(canPrintBluetooth()).toBe(false);                 // plain Safari: the setup hint shows instead
});
