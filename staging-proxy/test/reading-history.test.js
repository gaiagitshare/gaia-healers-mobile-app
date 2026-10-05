import test from 'node:test';
import assert from 'node:assert/strict';
import { readingSeries, recentAverage } from '../reading-history.js';
test('newest three scans are averaged chronologically, without rounding before arithmetic', () => {
 const s = readingSeries([{id:'b',scanned_at:'2026-10-02T10:00:00Z',energy:60,stress:3}, {id:'a',scanned_at:'2026-10-01T10:00:00Z',energy:30,stress:0}, {id:'d',scanned_at:'2026-10-03T11:00:00Z',energy:90,stress:6}, {id:'c',scanned_at:'2026-10-03T10:00:00Z',energy:0,stress:0}]);
 assert.deepEqual(s.map(p=>p.id),['a','b','c','d']);
 assert.equal(recentAverage(s).energy,50); assert.equal(recentAverage(s).stress,3);
 assert.notEqual(s[2].id,s[3].id, 'two scans on one day remain distinguishable');
});
test('invalid dates, duplicate scans and non-finite values cannot contaminate averages', () => {
 const p={id:'a',scanned_at:'2026-10-01T10:00:00Z',energy:0,stress:0};
 assert.equal(readingSeries([p,p,{id:'x',scanned_at:'bad',energy:1}, {id:'z',scanned_at:p.scanned_at,energy:Infinity,stress:NaN}]).length,1);
 assert.equal(recentAverage(readingSeries([p])),null);
 assert.equal(recentAverage([{e:2,s:1},{e:3,s:2},{e:4,s:null}]),null, 'do not skip an incomplete latest scan to claim latest three');
});

import { modelView } from '../assist-tools.js';
test('selected scan history and averages stay on the screen and out of model replies', () => {
 const result={found:true,client:{id:'example'},series:[{id:'scan',e:12,s:2}],average_recent:{energy:12,stress:2}};
 const safe=modelView('practitioner_compare_sessions',result,{});
 assert.equal(safe.opened,true); assert.equal(safe.series,undefined); assert.equal(safe.average_recent,undefined);
});
