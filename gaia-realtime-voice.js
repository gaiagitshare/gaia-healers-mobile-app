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
    return (window.GAIA_SYNC?.proxyBase || 'https://ba2ki.com/gaia-proxy').replace(/\/+$/, '');
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

    if (data?.setupComplete) {
      responses.push({ kind: 'setup' });
      return responses;
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

    if (data?.error) {
      responses.push({ kind: 'error', message: data.error.message || 'Gemini Live error' });
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
            ? { ...item, text: finalize ? text : `${item.text}${chunk}` }
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
      if (playbackNodeRef.current) return;
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

    function sendWs(payload) {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(payload));
      return true;
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
        if (!event.data || event.data.type !== 'audio' || muted) return;
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
            if (event.finished) setStatus('thinking');
            else setStatus('listening');
            break;
          case 'outputTranscription':
            upsertStreamingMessage('assistant', event.text, event.finished);
            if (!event.finished) setStatus('speaking');
            break;
          case 'turnComplete':
            streamMessage = null;
            setStatus('listening');
            break;
          case 'error':
            setErrorMessage(event.message);
            setStatus('error');
            break;
          default:
            break;
        }
      }
    }

    async function fetchLiveToken() {
      const view = encodeURIComponent(currentView());
      const response = await fetch(`${proxyBase()}/api/assist/voice/token?view=${view}`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok || !payload.token) {
        throw new Error(tokenErrorMessage(payload, response.status));
      }
      return payload;
    }

    async function start(startOptions = {}) {
      if (status !== 'idle' && status !== 'error') return;
      if (startPromise) return startPromise;
      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorMessage('Your browser does not allow microphone access here.');
        setStatus('error');
        return;
      }

      setErrorMessage(null);
      messages = [];
      streamMessage = null;
      muted = startOptions.startMuted === true;
      setStatus('connecting');

      const startTask = (async () => {
        try {
          sessionMeta = await fetchLiveToken();
          const wsUrl = `${WS_BASE}?access_token=${encodeURIComponent(sessionMeta.token)}`;
          const ws = new WebSocket(wsUrl);
          wsRef.current = ws;

          await new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error('Voice connection timed out.')), 20_000);
            ws.onopen = () => {
              window.clearTimeout(timer);
              resolve();
            };
            ws.onerror = () => {
              window.clearTimeout(timer);
              reject(new Error('Voice connection failed.'));
            };
          });

          ws.onmessage = async (event) => {
            let raw = event.data;
            if (raw instanceof Blob) raw = await raw.text();
            else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
            handleGeminiMessage(raw);
          };
          ws.onclose = () => {
            if (status !== 'error') setStatus('idle');
          };
          ws.onerror = () => {
            setErrorMessage('Voice connection failed.');
            setStatus('error');
          };

          await startMicStreaming();

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

    function stop() {
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

    function sendText(raw) {
      const text = raw.trim();
      if (!text) return false;
      streamMessage = null;
      messages = trimMessages([...messages, {
        id: `user-${Date.now()}`,
        role: 'user',
        text,
      }]);
      emit('message', { messages: [...messages], role: 'user', text, finalize: true });
      setStatus('thinking');
      return sendWs({ realtimeInput: { text } });
    }

    function isActive() {
      return status !== 'idle' && status !== 'error';
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
      isActive,
      start,
      stop,
      cancel,
      toggleMute,
      sendText,
      on,
    };
  }

  window.GaiaRealtimeVoice = { create: createGaiaRealtimeVoice };
})();
