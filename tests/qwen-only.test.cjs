const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'..',name),'utf8');
test('stale Gemini tokens cannot select a browser audio connection',()=>{
 const source=read('gaia-realtime-voice.js');const fn=source.slice(source.indexOf('function socketUrl(meta)'),source.indexOf('    function sendWs('));
 const socketUrl=new Function(fn+';return socketUrl;')();
 assert.equal(socketUrl({provider:'qwen',relayUrl:'wss://qa.test/relay'}),'wss://qa.test/relay');
 assert.throws(()=>socketUrl({provider:'gemini',token:'old'}),/voice relay unavailable/); // 9ce6bcf: calm internal message; the member sees VOICE_UNAVAILABLE_COPY
 assert.doesNotMatch(source,/switchToGemini|provider: 'gemini'|new window.MediaRecorder/);
});
test('voice settings and reply playback cannot restore a saved alternate provider',()=>{
 const source=read('gaia-ui.js');
 assert.match(source,/localStorage.setItem\(VOICE_PROVIDER_KEY, 'qwen'\)/);
 assert.doesNotMatch(source,/<option value="(?:browser|elevenlabs|openai)">|speechSynthesis\.speak\(/);
 const speak=source.slice(source.indexOf('async function speakReply('),source.indexOf('function dockButtons()'));
 assert.doesNotMatch(speak,/fetch\(|SpeechSynthesisUtterance/);
});
