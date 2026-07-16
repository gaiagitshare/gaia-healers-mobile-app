/** Gaia Assist — Gemini Live API voice (WebSocket + ephemeral token). */
(function () {
  'use strict';

  const TOKEN_ERRORS = {
    gaia_voice_disabled: 'Live voice is not enabled yet. Type your question instead.',
    missing_gemini_api_key: 'Live voice is not configured yet. Type your question instead.',
    gemini_live_token_failed: 'Voice is temporarily unavailable. Type your question instead.',
  };

  const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

  const CAPTURE_WORKLET = `
    class AudioCaptureProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0] && inputs[0][0];
        if (input) this.port.postMessage({ type: 'audio', data: input });
        return true;
      }
    }
    registerProcessor('gaia-audio-capture', AudioCaptureProcessor);
  `;

  const PLAYBACK_WORKLET = `
    class GaiaPcmProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.audioQueue = [];
        this.currentOffset = 0;
        this.port.onmessage = (event) => {
          if (event.data === 'interrupt') {
            this.audioQueue = [];
            this.currentOffset = 0;
            return;
          }
          if (event.data instanceof Float32Array) {
            this.audioQueue.push(event.data);
          }
        };
      }
      process(_inputs, outputs) {
        const output = outputs[0];
        if (!output.length) return true;
        const channel = output[0];
        let outputIndex = 0;
        while (outputIndex < channel.length && this.audioQueue.length > 0) {
          const currentBuffer = this.audioQueue[0];
          if (!currentBuffer || !currentBuffer.length) {
            this.audioQueue.shift();
            this.currentOffset = 0;
            continue;
          }
          const remainingOutput = channel.length - outputIndex;
          const remainingBuffer = currentBuffer.length - this.currentOffset;
          const copyLength = Math.min(remainingOutput, remainingBuffer);
          for (let i = 0; i < copyLength; i += 1) {
            channel[outputIndex++] = currentBuffer[this.currentOffset++];
          }
          if (this.currentOffset >= currentBuffer.length) {
            this.audioQueue.shift();
            this.currentOffset = 0;
          }
        }
        while (outputIndex < channel.length) channel[outputIndex++] = 0;
        return true;
      }
    }
    registerProcessor('gaia-pcm-playback', GaiaPcmProcessor);
  `;

  function proxyBase() {
    return (window.GAIA_SYNC?.proxyBase || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }

  function currentView() {
    return window.GaiaAppShell?.currentView?.()
      || new URLSearchParams(window.location.search).get('view')
      || 'today';
  }

  function tokenErrorMessage(payload, status) {
    const reason = typeof payload?.reason === 'string' ? payload.reason : '';
    if (reason && TOKEN_ERRORS[reason]) return TOKEN_ERRORS[reason];
    if (payload?.disabled === true) return TOKEN_ERRORS.gaia_voice_disabled;
    if (status === 401 || reason === 'auth_required') return TOKEN_ERRORS.gemini_live_token_failed;
    if (status === 503) return TOKEN_ERRORS.missing_gemini_api_key;
    return payload?.error || TOKEN_ERRORS.gemini_live_token_failed;
  }

  function workletUrl(source) {
    return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  }

  function floatToPcm16(float32Array) {
    const int16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = sample * 0x7fff;
    }
    return int16;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  function parseGeminiMessages(data) {
    const responses = [];
    const serverContent = data?.serverContent;

    if (data?.error) {
      responses.push({
        kind: 'error',
        message: data.error.message || data.error.status || 'Gaia voice error',
      });
    }

    if (data?.setupComplete) {
      responses.push({ kind: 'setup' });
    }

    if (serverContent?.interrupted) {
      responses.push({ kind: 'interrupted' });
    }

    const parts = serverContent?.modelTurn?.parts;
    if (parts?.length) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          responses.push({ kind: 'audio', data: part.inlineData.data });
        } else if (part.text) {
          responses.push({ kind: 'text', text: part.text });
        }
      }
    }

    if (serverContent?.inputTranscription?.text) {
      responses.push({
        kind: 'inputTranscription',
        text: serverContent.inputTranscription.text,
        finished: Boolean(serverContent.inputTranscription.finished),
      });
    }

    if (serverContent?.outputTranscription?.text) {
      responses.push({
        kind: 'outputTranscription',
        text: serverContent.outputTranscription.text,
        finished: Boolean(serverContent.outputTranscription.finished),
      });
    }

    if (serverContent?.turnComplete) {
      responses.push({ kind: 'turnComplete' });
    }

    // Function calling: when the model decides to navigate, it sends a
    // toolCall with one or more functionCall parts. Surface each as a
    // toolCall event so handleGeminiMessage can run it + reply.
    const toolCalls = data?.toolCall?.functionCalls;
    if (Array.isArray(toolCalls) && toolCalls.length) {
      for (const call of toolCalls) {
        const id = String(call.id || call.name || '');
        const name = String(call.name || '');
        const args = (call.args && typeof call.args === 'object') ? call.args : {};
        responses.push({ kind: 'toolCall', id, name, args });
      }
    }

    if (data?.error) {
      responses.push({ kind: 'error', message: data.error.message || 'Gaia voice error' });
    }

    return responses;
  }

  function createGaiaRealtimeVoice(options = {}) {
    const maxMessages = options.maxMessages || 40;
    let status = 'idle';
    let error = null;
    let muted = false;
    let messages = [];
    let streamMessage = null;
    let startPromise = null;
    let sessionMeta = null;
    let setupDone = false;
    let setupWaiters = [];
    let holding = false;
    let maySendAudio = false;

    const wsRef = { current: null };
    const streamRef = { current: null };
    const captureCtxRef = { current: null };
    const captureNodeRef = { current: null };
    const playbackCtxRef = { current: null };
    const playbackNodeRef = { current: null };
    const timeoutRef = { current: null };
    const meterContextRef = { current: null };
    const meterRafRef = { current: null };
    const workletUrls = [];

    const listeners = {
      status: new Set(),
      message: new Set(),
      error: new Set(),
      audioLevel: new Set(),
    };

    function emit(kind, payload) {
      listeners[kind].forEach((fn) => {
        try { fn(payload); } catch { /* ignore */ }
      });
    }

    function setStatus(next) {
      status = next;
      emit('status', status);
    }

    function setErrorMessage(next) {
      error = next;
      emit('error', error);
    }

    function trimMessages(items) {
      return items.slice(-maxMessages);
    }

    function joinTranscriptText(previous, next) {
      const left = String(previous || '');
      const right = String(next || '');
      if (!left) return right;
      if (!right) return left;
      if (/[\s"'([{/<-]$/.test(left) || /^[\s.,!?;:)'"\]}]/.test(right)) return `${left}${right}`;
      return `${left} ${right}`;
    }

    function upsertStreamingMessage(role, chunk, finalize) {
      const text = String(chunk || '').trim();
      if (!text && finalize) {
        streamMessage = null;
        return;
      }
      if (!text && !finalize) return;

      if (streamMessage && streamMessage.role === role) {
        messages = trimMessages(messages.map((item) => (
          item.id === streamMessage.id
            ? { ...item, text: finalize ? text : joinTranscriptText(item.text, chunk) }
            : item
        )));
        if (finalize) streamMessage = null;
      } else {
        const id = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (!finalize) streamMessage = { id, role };
        messages = trimMessages([...messages, { id, role, text: finalize ? text : chunk }]);
      }
      emit('message', { messages: [...messages], role, text: chunk, finalize });
    }

    function stopAudioMeter() {
      if (meterRafRef.current != null) {
        window.cancelAnimationFrame(meterRafRef.current);
        meterRafRef.current = null;
      }
      const ctx = meterContextRef.current;
      meterContextRef.current = null;
      if (ctx && ctx.state !== 'closed') {
        void ctx.close().catch(() => undefined);
      }
      emit('audioLevel', 0);
    }

    function startAudioMeter(stream) {
      stopAudioMeter();
      try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return;
        const ctx = new AudioContextCtor();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);
        const samples = new Uint8Array(analyser.frequencyBinCount);
        meterContextRef.current = ctx;

        const tick = () => {
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) {
            const centered = (sample - 128) / 128;
            sum += centered * centered;
          }
          emit('audioLevel', Math.min(1, Math.sqrt(sum / samples.length) * 4.5));
          meterRafRef.current = window.requestAnimationFrame(tick);
        };
        tick();
      } catch {
        emit('audioLevel', 0);
      }
    }

    async function ensurePlayback() {
      if (playbackNodeRef.current) {
        const ctx = playbackCtxRef.current;
        if (ctx?.state === 'suspended') await ctx.resume();
        return;
      }
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error('Web Audio is unavailable');
      const ctx = new AudioContextCtor({ sampleRate: 24000 });
      const url = workletUrl(PLAYBACK_WORKLET);
      workletUrls.push(url);
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'gaia-pcm-playback');
      node.connect(ctx.destination);
      playbackCtxRef.current = ctx;
      playbackNodeRef.current = node;
      if (ctx.state === 'suspended') await ctx.resume();
    }

    async function resumePlayback() {
      const ctx = playbackCtxRef.current;
      if (ctx?.state === 'suspended') {
        await ctx.resume();
      }
    }

    async function playPcmChunk(base64Audio) {
      await ensurePlayback();
      const ctx = playbackCtxRef.current;
      if (ctx?.state === 'suspended') await ctx.resume();
      const binary = window.atob(base64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const pcm = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i += 1) float32[i] = pcm[i] / 32768;
      playbackNodeRef.current.port.postMessage(float32);
    }

    function interruptPlayback() {
      playbackNodeRef.current?.port.postMessage('interrupt');
    }

    function resolveSetup() {
      if (setupDone) return;
      setupDone = true;
      setupWaiters.forEach((fn) => fn());
      setupWaiters = [];
    }

    function waitForSetup(timeoutMs = 15000) {
      if (setupDone) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error('Voice setup timed out. Tap the orb to retry.'));
        }, timeoutMs);
        setupWaiters.push(() => {
          window.clearTimeout(timer);
          resolve();
        });
      });
    }

    function buildSetupMessage(meta) {
      const model = String(meta.model || 'gemini-2.5-flash-native-audio-preview-12-2025').replace(/^models\//, '');
      return {
        setup: {
          model: `models/${model}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            temperature: 0.8,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: meta.voice || 'Puck',
                },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: meta.instructions || 'You are Gaia Assist for Gaia Healers.' }],
          },
          // Tighter turn-taking so Gaia replies quickly after you stop talking
          // (the default end-of-speech pause is what makes voice feel laggy).
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
              endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
              prefixPaddingMs: 20,
              silenceDurationMs: 500,
            },
          },
          // Expose the in-app navigation as a callable tool. When a member asks
          // to go somewhere, the model emits a functionCall(name='navigate').
          tools: [{
            functionDeclarations: [{
              name: 'navigate',
              description: 'Navigate the member to a screen in the Gaia Healers app. Call this whenever the member asks to open, go to, show, or see a specific screen, tab, or feature — for example "take me to my courses", "open the store", "show my profile", "find a healer", "go to wellness". Do not just describe the path; call this tool to actually move them there.',
              parameters: {
                type: 'object',
                properties: {
                  screen: {
                    type: 'string',
                    description: 'The destination screen. today=Home, academy=Courses, community=Communities & Find a Healer, store=Shop & Membership, profile=Account, wellness=Wellness scans & chakras.',
                    enum: ['today', 'academy', 'community', 'store', 'profile', 'wellness'],
                  },
                  tab: {
                    type: 'string',
                    description: 'Optional tab within the screen. store: "shop" or "membership". wellness: "biowell" or "chakras". community: "discussion", "members", or "events". Omit if unsure.',
                  },
                },
                required: ['screen'],
              },
            }],
          }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };
    }

    // Voice-driven navigation: the navigate tool lets Gaia actually move the
    // member to a screen instead of only describing where to go. Gemini Live
    // calls it as a functionCall; handleGeminiMessage routes it to
    // window.GaiaAppShell.go(), then sends a toolResponse back so the model
    // can confirm the move aloud.
    const NAVIGATE_SCREENS = ['today', 'academy', 'community', 'store', 'profile', 'wellness'];

    function handleNavigateToolCall(args = {}) {
      const screen = String(args.screen || '').trim().toLowerCase();
      const tab = String(args.tab || '').trim().toLowerCase();
      if (!screen || !NAVIGATE_SCREENS.includes(screen)) {
        return { ok: false, message: 'That screen is not available. Tell the member where to tap instead.' };
      }
      const shell = window.GaiaAppShell;
      if (!shell || typeof shell.go !== 'function') {
        return { ok: false, message: 'The app navigation is still loading. Tell the member where to tap for now.' };
      }
      try {
        shell.go(screen, tab ? { tab } : {});
        return { ok: true, message: `Opening ${screen}${tab ? ' / ' + tab : ''} now.` };
      } catch (e) {
        return { ok: false, message: 'Could not open that screen. Tell the member where to tap instead.' };
      }
    }

    function sendWs(payload) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(payload));
      return true;
    }

    function sendSetupMessage() {
      if (!sessionMeta) return false;
      return sendWs(buildSetupMessage(sessionMeta));
    }

    function cleanupSession() {
      if (timeoutRef.current != null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      stopAudioMeter();
      streamMessage = null;
      startPromise = null;
      sessionMeta = null;
      setupDone = false;
      setupWaiters = [];
      holding = false;
      maySendAudio = false;

      try { wsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;

      captureNodeRef.current?.disconnect();
      captureNodeRef.current = null;
      if (captureCtxRef.current && captureCtxRef.current.state !== 'closed') {
        void captureCtxRef.current.close().catch(() => undefined);
      }
      captureCtxRef.current = null;

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;

      workletUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
    }

    async function startMicStreaming() {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      startAudioMeter(stream);

      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContextCtor({ sampleRate: 16000 });
      const url = workletUrl(CAPTURE_WORKLET);
      workletUrls.push(url);
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'gaia-audio-capture');
      node.port.onmessage = (event) => {
        if (!event.data || event.data.type !== 'audio' || muted || !maySendAudio) return;
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        const pcm = floatToPcm16(event.data.data);
        sendWs({
          realtimeInput: {
            audio: {
              mimeType: 'audio/pcm;rate=16000',
              data: arrayBufferToBase64(pcm.buffer),
            },
          },
        });
      };
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      captureCtxRef.current = ctx;
      captureNodeRef.current = node;
    }

    function handleGeminiMessage(raw) {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const events = parseGeminiMessages(data);
      for (const event of events) {
        switch (event.kind) {
          case 'setup':
            resolveSetup();
            setStatus('listening');
            break;
          case 'interrupted':
            interruptPlayback();
            streamMessage = null;
            setStatus('listening');
            break;
          case 'audio':
            setStatus('speaking');
            void playPcmChunk(event.data).catch(() => undefined);
            break;
          case 'text':
            upsertStreamingMessage('assistant', event.text, true);
            break;
          case 'inputTranscription':
            upsertStreamingMessage('user', event.text, event.finished);
            if (!event.finished) setStatus('listening');
            else setStatus('thinking');
            break;
          case 'outputTranscription':
            upsertStreamingMessage('assistant', event.text, event.finished);
            if (!event.finished) setStatus('speaking');
            break;
          case 'turnComplete':
            streamMessage = null;
            setStatus('listening');
            break;
          case 'toolCall': {
            // Run the requested tool locally, then send the result back so the
            // model can confirm the action aloud and finish its turn.
            const result = event.name === 'navigate'
              ? handleNavigateToolCall(event.args || {})
              : { ok: false, message: 'That action is not available yet.' };
            // toolResponse lets the Live session continue after a function call.
            sendWs({
              toolResponse: {
                functionResponses: [{
                  id: event.id || '',
                  name: event.name || '',
                  response: { result: result.message || (result.ok ? 'Done.' : 'Unavailable.') },
                }],
              },
            });
            break;
          }
          case 'error':
            setErrorMessage(event.message);
            setStatus('error');
            break;
          default:
            break;
        }
      }
    }

    let cachedToken = null;
    let cachedTokenExpireAt = 0;

    async function fetchLiveToken({ force = false } = {}) {
      // Reuse a still-valid token (valid for 30 min from the proxy) to skip
      // the round-trip on reconnects within a session.
      if (!force && cachedToken && Date.now() < cachedTokenExpireAt) {
        return cachedToken;
      }
      const view = encodeURIComponent(currentView());
      const response = await fetch(`${proxyBase()}/api/assist/voice/token?view=${view}`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok || !payload.token) {
        throw new Error(tokenErrorMessage(payload, response.status));
      }
      cachedToken = payload;
      // Expire 2 minutes early as a safety margin.
      const expireMs = payload.expireTime ? new Date(payload.expireTime).getTime() : 0;
      cachedTokenExpireAt = expireMs ? expireMs - 120000 : Date.now() + 25 * 60 * 1000;
      return payload;
    }

    /** Pre-warm: fetch token + prepare audio in the background (before first tap). */
    function prewarm() {
      fetchLiveToken().catch(() => null);
      ensurePlayback().catch(() => null);
    }

    async function ensureSession() {
      if (setupDone && wsRef.current?.readyState === WebSocket.OPEN) return;
      if (startPromise) {
        await startPromise;
        return;
      }
      await start();
    }

    async function start(startOptions = {}) {
      if (startPromise) return startPromise;
      if (setupDone && wsRef.current?.readyState === WebSocket.OPEN) {
        maySendAudio = true;
        setStatus('listening');
        return;
      }
      setErrorMessage(null);
      messages = [];
      streamMessage = null;
      muted = startOptions.startMuted === true;
      setStatus('connecting');

      const startTask = (async () => {
        try {
          setupDone = false;
          setupWaiters = [];
          // Token is cached from prewarm if available — near-instant on repeat.
          sessionMeta = await fetchLiveToken();

          // Run three independent setup legs IN PARALLEL instead of serially.
          // This is the main speedup: previously WS+setup → audio → mic was
          // sequential (~2-4s); now the slowest leg wins (~0.5-1.5s).
          const [wsReady, , micOk] = await Promise.all([
            // Leg 1: WebSocket connect + Gemini setup
            (async () => {
              const wsUrl = `${WS_BASE}?access_token=${encodeURIComponent(sessionMeta.token)}`;
              const ws = new WebSocket(wsUrl);
              wsRef.current = ws;
              ws.onmessage = async (event) => {
                let raw = event.data;
                if (raw instanceof Blob) raw = await raw.text();
                else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
                handleGeminiMessage(raw);
              };
              await new Promise((resolve, reject) => {
                const timer = window.setTimeout(() => reject(new Error('Voice connection timed out.')), 15_000);
                ws.onopen = () => {
                  window.clearTimeout(timer);
                  if (!sendSetupMessage()) {
                    reject(new Error('Could not start Gaia voice.'));
                    return;
                  }
                  resolve();
                };
                ws.onerror = () => {
                  window.clearTimeout(timer);
                  reject(new Error('Voice connection failed.'));
                };
              });
              await waitForSetup();
              ws.onclose = (event) => {
                if (status !== 'error' && status !== 'idle') {
                  setErrorMessage(event.reason || 'Voice connection closed.');
                  setStatus('error');
                }
              };
              ws.onerror = () => {
                setErrorMessage('Voice connection failed.');
                setStatus('error');
              };
            })(),
            // Leg 2: audio playback worklet (independent of WS)
            ensurePlayback(),
            // Leg 3: microphone (independent of WS and audio worklet)
            (async () => {
              if (!navigator.mediaDevices?.getUserMedia) {
                maySendAudio = false;
                setErrorMessage('This browser does not expose microphone capture. Gaia can still answer typed prompts here.');
                return false;
              }
              try {
                await startMicStreaming();
                maySendAudio = true;
                setErrorMessage(null);
                return true;
              } catch (micError) {
                maySendAudio = false;
                const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
                const isInApp = /(instagram|facebook|twitter|linkedin|tiktok|snapchat|whatsapp|wechat)/i.test(navigator.userAgent);
                const message = isInApp
                  ? 'Open this page in Safari, then allow Microphone when asked. In-app browsers block microphone access.'
                  : isSafari
                    ? 'Microphone access is blocked. iPhone Settings → Safari → Microphone → Allow gaiahealers.app.'
                    : 'Microphone permission is needed for live listening. Check your browser site settings and allow microphone.';
                setErrorMessage(message);
                return false;
              }
            })(),
          ]);

          setStatus('listening');

          const maxSeconds = Number(sessionMeta.maxSessionSeconds) || 300;
          timeoutRef.current = window.setTimeout(() => {
            cleanupSession();
            setErrorMessage('Voice session ended.');
            setStatus('error');
          }, maxSeconds * 1000);
        } catch (err) {
          cleanupSession();
          setErrorMessage(err instanceof Error ? err.message : 'Could not start live voice.');
          setStatus('error');
        } finally {
          startPromise = null;
        }
      })();

      startPromise = startTask;
      return startTask;
    }

    async function holdStart() {
      await start();
    }

    function holdEnd() {
      /* continuous VAD — no hold-to-talk */
    }

    function stop() {
      holding = false;
      maySendAudio = false;
      cleanupSession();
      interruptPlayback();
      setStatus('idle');
      muted = false;
    }

    function cancel() {
      interruptPlayback();
      streamMessage = null;
      setStatus('listening');
    }

    function toggleMute() {
      muted = !muted;
      streamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      if (muted) interruptPlayback();
      return muted;
    }

    function sendText(raw, options = {}) {
      const text = raw.trim();
      if (!text) return false;
      streamMessage = null;
      if (!options.silent) {
        messages = trimMessages([...messages, {
          id: `user-${Date.now()}`,
          role: 'user',
          text,
        }]);
        emit('message', { messages: [...messages], role: 'user', text, finalize: true });
      }
      setStatus('thinking');
      return sendWs({ realtimeInput: { text } });
    }

    function isActive() {
      return status !== 'idle' && status !== 'error';
    }

    function isHolding() {
      return holding;
    }

    function on(event, fn) {
      if (listeners[event]) listeners[event].add(fn);
      return () => listeners[event].delete(fn);
    }

    return {
      get status() { return status; },
      get error() { return error; },
      get messages() { return [...messages]; },
      get muted() { return muted; },
      get isHolding() { return holding; },
      isActive,
      start,
      holdStart,
      holdEnd,
      stop,
      cancel,
      toggleMute,
      sendText,
      resumePlayback,
      prewarm,
      on,
    };
  }

  window.GaiaRealtimeVoice = { create: createGaiaRealtimeVoice };
})();
