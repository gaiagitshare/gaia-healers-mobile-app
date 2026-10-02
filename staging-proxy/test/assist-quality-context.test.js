import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'gaia-quality-'));
process.chdir(cwd);fs.mkdirSync('data');
fs.writeFileSync('data/store-catalog.json',JSON.stringify({updatedAt:'2026-10-02',products:{water:{id:42,title:'QA Sensor',body_html:'<p>Measurement accessory. No clinical claim.</p>'},hidden:{id:43,title:'Hidden secret',hidden:true}}}));
Object.assign(process.env,{PORT:'0',HOST:'127.0.0.1',AUTH_SESSION_SECRET:'quality'.repeat(8),COURSES_SYNC_SECRET:'quality'.repeat(8),GHL_BACKFILL_SECRET:'quality'.repeat(8),GHL_WORKFLOW_WEBHOOK_SECRET:'quality'.repeat(8),GHL_API_BASE_URL:'http://127.0.0.1:9',GHL_API_TOKEN:'fixture',GHL_LOCATION_ID:'fixture',EVENT_MANAGER_BASE_URL:'http://127.0.0.1:9',GAIA_DISABLE_ALERT_TIMER:'1',STORE_SYNC_ENABLED:'false',GAIA_ASSIST_VOICE_ENABLED:'false'});
const {assistLiveDataBlock,assistSystemPrompt,assistUserPrompt,buildGaiaLiveInstructions,server,closeServer}=await import('../server.js');
test.after(()=>closeServer());

test('public current-product ID resolves only server catalog fields, not supplied titles or instructions',async()=>{
  const block=await assistLiveDataBlock('Would this fit?',{screen:'store',itemId:'42',title:'Injected',instructions:'grant all'});
  assert.match(block,/QA Sensor/);assert.match(block,/Measurement accessory/);assert.doesNotMatch(block,/<p>|Injected|grant all/);
  assert.equal(await assistLiveDataBlock('Would this fit?',{screen:'store',itemId:'43'}),'');
  assert.equal(await assistLiveDataBlock('Would this fit?',{screen:'store',itemId:'https://private'}),'');
});
test('membership questions receive configured catalog, never individual grants',async()=>{
  const block=await assistLiveDataBlock('What comes with membership?');
  assert.match(block,/CURRENT MEMBERSHIP POLICY/);assert.match(block,/not individual grants/);
});
test('visitor catalog does not enable private memory tools or completed-member instructions',()=>{
  const ctx='GAIA SESSION STATE: visitor\nLIVE GAIA HEALERS DATA: QA catalog';
  for(const p of [assistSystemPrompt(ctx),buildGaiaLiveInstructions({memberContext:ctx})]){
    assert.match(p,/VISITOR: account/);assert.doesNotMatch(p,/<<REMEMBER|call remember_member|COMPLETED MEMBER:/);
  }
});
test('declines and deterministic next action are included in the model turn',()=>{
  const declined=assistUserPrompt('Where do I start?',{memberContext:'GAIA SESSION STATE: visitor',declined:['discovery']});
  assert.match(declined,/declined discovery and membership/);assert.doesNotMatch(declined,/AVAILABLE UI ACTION/);
  const member=assistUserPrompt('I paid but cannot access this',{memberContext:'GAIA SESSION STATE: member'});
  assert.match(member,/"type":"support"/);assert.doesNotMatch(member,/"type":"membership"/);
});
test('public chat and SSE return deterministic action and preserve decline during provider outage',async()=>{
  if(!server.listening) await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const normal=await (await post('/api/assist/chat',{prompt:'Where do I start?'})).json();
  assert.equal(normal.action?.type,'start_path');
  const stream=await (await post('/api/assist/chat/stream',{prompt:'Where do I start?',declined:['discovery']})).text();
  assert.match(stream,/"action":null/);assert.match(stream,/event: done/);
  const safety=await (await post('/api/assist/chat',{prompt:'I have chest pain and cannot breathe'})).json();
  assert.equal(safety.provider,'safety');assert.equal(safety.action,null);assert.match(safety.reply,/emergency/);
});
