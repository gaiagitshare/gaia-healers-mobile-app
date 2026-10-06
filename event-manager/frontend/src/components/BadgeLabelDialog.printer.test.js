// Desk ↔ printer pairing and the connect time limit, against a fake Web
// Bluetooth chooser and a fake driver. Four desks, four B1 Pros that all say
// "B1 Pro-…": these pin that a desk keeps its own printer and is told, by
// name, when it picked a neighbour's.
//
// Run: CI=true npx react-scripts test --watchAll=false BadgeLabelDialog.printer
import { b1Connect, b1Disconnect, savedStationPrinter, rememberStationPrinter, STATION_PRINTER_KEY, printerTag, isAppleMobile, isIPad, iosBluetoothSetup, canPrintBluetooth, logPrinter, b1Dpi, PRINTER_KEY, isFramed, needsOwnWindow } from './BadgeLabelDialog';

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

test('an iPad is sent to Bluefy (beacio is iPhone-only); an iPhone is offered both', () => {
    const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    const tp = Object.getOwnPropertyDescriptor(window.navigator, 'maxTouchPoints');
    const set = (u, t) => {
        Object.defineProperty(window.navigator, 'userAgent', { value: u, configurable: true });
        Object.defineProperty(window.navigator, 'maxTouchPoints', { value: t, configurable: true });
    };
    try {
        set('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15', 5);
        expect(isIPad()).toBe(true);
        expect(iosBluetoothSetup()).toContain('Bluefy');
        expect(iosBluetoothSetup()).not.toContain('install the free “beacio”');
        set('Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1', 5);
        expect(isIPad()).toBe(false);
        expect(iosBluetoothSetup()).toContain('beacio');
        expect(iosBluetoothSetup()).toContain('Bluefy');
    } finally {
        if (ua) Object.defineProperty(window.navigator, 'userAgent', ua); else delete window.navigator.userAgent;
        if (tp) Object.defineProperty(window.navigator, 'maxTouchPoints', tp); else delete window.navigator.maxTouchPoints;
    }
});

test('logPrinter hands back a promise: a desk that connected is not told it failed', async () => {
    // 5 Oct: it returned undefined, the station's `.then` threw, and a printer
    // that had just connected was reported as "Could not connect".
    const p = logPrinter(1, { stage: 'connect', ok: true });
    expect(p && typeof p.then).toBe('function');
    await expect(p).resolves.not.toBeUndefined();   // the server's answer, or null — never a throw
    await expect(logPrinter(null, {})).resolves.toBeNull();
});

test('a B21 Pro (model 785, unknown to the driver) prints as itself: 300 dpi, 591-dot head', async () => {
    nextName = 'B21_Pro-I204050468';
    window.Niimbot.identify = async () => { await navigator.bluetooth.requestDevice({}); return { modelId: 785, task: null, label: 'unknown (id 785)' }; };
    const info = await b1Connect();
    expect(info.label).toBe('NIIMBOT B21 Pro');
    expect(info.dpi).toBe(300);
    expect(b1Dpi()).toBe(300);
    expect(info.device).toBe('B21_Pro-I204050468');
});

test('a desk can set the B21 Pro by hand, and an old forced setting still reads', async () => {
    localStorage.setItem(PRINTER_KEY, 'b21pro');
    const info = await b1Connect();
    expect(info.label).toBe('NIIMBOT B21 Pro (set on this station)');
    localStorage.setItem(PRINTER_KEY, 'v4');
    await b1Disconnect();
    expect((await b1Connect()).label).toBe('NIIMBOT B1 Pro (set on this station)');
});

test('a tap is reported at once, and a device list left open 20 s says so', async () => {
    jest.useFakeTimers();
    navigator.bluetooth.requestDevice = jest.fn(() => new Promise(() => {}));   // Bluefy's list, nothing picked
    window.Niimbot.identify = async () => { await navigator.bluetooth.requestDevice({}); return null; };
    const phases = [];
    b1Connect(false, { onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(['started']);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(19000);
    expect(phases).toEqual(['started']);
    jest.advanceTimersByTime(1500);
    expect(phases).toEqual(['started', 'waiting']);
});

test('picking in time is not "waiting"', async () => {
    const phases = [];
    await b1Connect(false, { onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(['started']);
});

test('framed in the Admin on an iPad: the page asks to open on its own instead of hanging', () => {
    const ua = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
    const top = Object.getOwnPropertyDescriptor(window, 'top');
    try {
        Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (iPad; CPU OS 16_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Version/3.9.3  Bluefy/3.9.3', configurable: true });
        expect(isFramed()).toBe(false);
        expect(needsOwnWindow()).toBe(false);                // check-in opened directly: connect as normal
        Object.defineProperty(window, 'top', { value: {}, configurable: true });
        expect(isFramed()).toBe(true);
        expect(needsOwnWindow()).toBe(true);                 // inside the Admin: open full screen first
        Object.defineProperty(window.navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36', configurable: true });
        expect(needsOwnWindow()).toBe(false);                // Chrome on a laptop prints from inside the frame
    } finally {
        if (ua) Object.defineProperty(window.navigator, 'userAgent', ua); else delete window.navigator.userAgent;
        if (top) Object.defineProperty(window, 'top', top);
    }
});
