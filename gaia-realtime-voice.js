/** Gaia Assist — Qwen-only live voice through the authenticated relay. */
(function () {
  'use strict';

  // What a member reads when voice cannot start. No provider name, no billing
  // detail, and the way forward in the same breath.
  const VOICE_UNAVAILABLE_COPY = 'Voice is unavailable right now. Tap Gaia to try again, or type your question below.';

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
        this.playing = false;
        this.levelTick = 0;
        this.port.onmessage = (event) => {
          if (event.data === 'interrupt') {
            this.audioQueue = [];
            this.currentOffset = 0;
            this.playing = false;
            this.port.postMessage({ type: 'outputLevel', level: 0 });
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
        if (this.audioQueue.length && !this.playing) { this.playing = true; this.port.postMessage({ type: 'playbackStart' }); }
        if (!this.audioQueue.length) this.playing = false;
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
        if (++this.levelTick % 12 === 0) { let power = 0; for (const value of channel) power += value * value; this.port.postMessage({ type: 'outputLevel', level: Math.min(1, Math.sqrt(power / channel.length) * 4.5) }); }
        // Mono PCM must be mirrored to EVERY output channel: on stereo hardware
        // (including the iPhone speaker route) the browser only zeros unwritten
        // channels, which made Gaia speak in one ear.
        for (let c = 1; c < output.length; c += 1) output[c].set(channel);
        return true;
      }
    }
    registerProcessor('gaia-pcm-playback', GaiaPcmProcessor);
  `;

  function proxyBase() {
    return (window.GAIA_SYNC?.proxyBase || 'https://api.gaiahealers.app').replace(/\/+$/, '');
  }

  function currentView() {
    return window.GaiaJourney?.context?.screen || window.GaiaAppShell?.currentView?.()
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
    if (data?.gaiaTiming) responses.push({ kind: 'timing', stage: data.gaiaTiming.stage });

    if (data?.error) {
      responses.push({
        kind: 'error',
        message: data.error.message || data.error.status || 'Gaia voice error',
      });
    }

    if (data?.setupComplete) {
      responses.push({ kind: 'setup' });
    }

    // Our Qwen relay asks for the conversation to move to Gemini (Qwen failed,
    // stalled, hit its session limit, or heard a language it may not speak).
    if (data?.gaiaHandover) {
      responses.push({
        kind: 'handover',
        reason: String(data.gaiaHandover.reason || ''),
        transcript: Array.isArray(data.gaiaHandover.transcript) ? data.gaiaHandover.transcript : [],
      });
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
    const greetedRef = { current: false };
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
    let playbackGraceUntil = 0;
    let localSpeechActive = false;
    let speechCandidateAt = 0;
    let localSilenceAt = 0;
    let noiseFloor = 0.004;
    let audioPrebuffer = [];

    const wsRef = { current: null };
    const streamRef = { current: null };
    const captureCtxRef = { current: null };
    const captureNodeRef = { current: null };
    const playbackCtxRef = { current: null };
    const playbackNodeRef = { current: null };
    const timeoutRef = { current: null };
    const listenResumeRef = { current: null };
    const meterContextRef = { current: null };
    const meterRafRef = { current: null };
    const workletUrls = [];

    const listeners = {
      status: new Set(),
      message: new Set(),
      error: new Set(),
      audioLevel: new Set(),
      outputLevel: new Set(),
      telemetry: new Set(),
    };

    let voiceTurn = null;
    const turnResults = [];
    function timing(stage) {
      if (stage === 'T0') { voiceTurn = { id: crypto.randomUUID(), path: sessionMeta?.provider || 'realtime', stages: {}, tools: [] }; }
      if (!voiceTurn || voiceTurn.stages[stage] != null) return;
      voiceTurn.stages[stage] = performance.now();
      if (voiceTurn.stages.T7 != null) {
        const delta = (a, b) => voiceTurn.stages[a] != null && voiceTurn.stages[b] != null ? Math.round(voiceTurn.stages[b] - voiceTurn.stages[a]) : null;
        const report = { id: voiceTurn.id, path: voiceTurn.path, speechEndToTranscriptMs: delta('T1', 'T2'), speechEndToModelMs: delta('T1', 'T4'), speechEndToAudioMs: delta('T1', 'T6'), speechEndToPlaybackMs: delta('T1', 'T7'), audioBufferMs: delta('T6', 'T7'), stages: { ...voiceTurn.stages } };
        const existing = turnResults.findIndex(turn => turn.id === report.id);
        if (existing >= 0) turnResults[existing] = report; else turnResults.push(report);
        if (turnResults.length > 30) turnResults.shift();
        emit('telemetry', report);
        if (window.GAIA_VOICE_DEBUG) console.info('[Gaia Voice Timing]', report);
      }
    }

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
      node.port.onmessage = ({ data }) => {
        if (data.type === 'playbackStart') { timing('T7'); setStatus('speaking'); }
        if (data.type === 'outputLevel') emit('outputLevel', data.level);
      };
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

    let playbackGeneration = 0;
    async function playPcmChunk(base64Audio) {
      const generation = playbackGeneration;
      await ensurePlayback();
      if (generation !== playbackGeneration) return;
      const ctx = playbackCtxRef.current;
      if (ctx?.state === 'suspended') await ctx.resume();
      const binary = window.atob(base64Audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const pcm = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i += 1) float32[i] = pcm[i] / 32768;
      const durationMs = (pcm.length / 24000) * 1000;
      playbackGraceUntil = Math.max(Date.now(), playbackGraceUntil) + durationMs;
      if (generation === playbackGeneration) playbackNodeRef.current.port.postMessage(float32);
    }

    function interruptPlayback() {
      playbackGeneration++;
      playbackGraceUntil = 0;
      if (listenResumeRef.current != null) window.clearTimeout(listenResumeRef.current);
      listenResumeRef.current = null;
      emit('outputLevel', 0);
      playbackNodeRef.current?.port.postMessage('interrupt');
    }

    function resolveSetup() {
      if (setupDone) return;
      setupDone = true;
      setupWaiters.forEach((fn) => fn());
      setupWaiters = [];
    }

    function waitForSetup(ws, timeoutMs = 15000) {
      if (setupDone) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          window.clearTimeout(timer);
          ws?.removeEventListener?.('close', handleClose);
          ws?.removeEventListener?.('error', handleError);
          setupWaiters = setupWaiters.filter((waiter) => waiter !== handleSetup);
        };
        const handleSetup = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (message) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(message));
        };
        const handleClose = (event) => fail(
          event?.reason || 'Voice setup was rejected. Tap the orb to retry.',
        );
        const handleError = () => fail('Voice connection failed during setup.');
        const timer = window.setTimeout(() => {
          fail('Voice setup timed out. Tap the orb to retry.');
        }, timeoutMs);
        ws?.addEventListener?.('close', handleClose, { once: true });
        ws?.addEventListener?.('error', handleError, { once: true });
        setupWaiters.push(handleSetup);
      });
    }

    function buildSetupMessage(meta) {
      // The server checks its configured live model against the account's own
      // catalogue before handing it over, so meta.model is one that exists.
      // fallbackModel is the pinned stable spare for the day the preview
      // model is withdrawn; the hard-coded name is the last resort only.
      const model = String(meta.model || meta.fallbackModel || 'gemini-3.8-live')
        .replace(/^models\//, '');
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
          // Balanced turn-taking: tolerate natural pauses and ordinary room
          // noise instead of treating every small sound as a new turn.
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
              endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
              prefixPaddingMs: 240,
              silenceDurationMs: 1500,
            },
            // Background activity must never cut off Gaia mid-answer. The mic
            // reopens after playback, and the user can still stop or pause it.
            activityHandling: 'NO_INTERRUPTION',
          },
          // Expose in-app actions as callable tools. When a member asks to do
          // something, the model emits a functionCall; handleGeminiMessage runs
          // it locally and sends a toolResponse back so Gaia can confirm aloud.
          tools: [{
            functionDeclarations: [
              {
                name: 'navigate',
                description: 'Navigate the member to a screen in the Gaia Healers app. Call this whenever the member asks to open, go to, show, or see a specific screen, tab, or feature — for example "take me to my courses", "open the store", "show my profile", "find a healer", "go to wellness". Do not just describe the path; call this tool to actually move them there.',
                parameters: {
                  type: 'object',
                  properties: {
                    screen: {
                      type: 'string',
                      description: 'The destination screen. today=Home, academy=Courses & Library, community=Community/Find a Healer/Events/Gaia Radio/Book a session, events=gatherings, bookings=your sessions, inbox=messages, directory=Find a Healer, store=Shop & Membership, profile=You (account & access), wellness=Energy (energy check, horoscope, chakras, numerology, colour test, Bio-Well).',
                      enum: ['today', 'academy', 'community', 'events', 'bookings', 'inbox', 'directory', 'store', 'profile', 'wellness'],
                    },
                    tab: {
                      type: 'string',
                      description: 'Optional tab within the screen. store: "shop" or "membership". wellness: "check", "horoscope", or "chakras". community: "discussion", "members", or "events". Omit if unsure.',
                    },
                    tool: {
                      type: 'string',
                      description: 'Optional single Energy tool to open on the wellness screen, instead of leaving the member to scroll for it. Each value is the card the member will see: pulse=Energy Pulse (camera heart-rate reading), breath=Coherence Breathing, numerology=Numerology, sky=Today\u2019s Sky, colour=Colour Test, chakra=Chakra Balance, match=Energy Match, cosmic=Cosmic Map, moon=Moon Rituals. Only valid with screen=wellness.',
                      enum: ['pulse', 'breath', 'numerology', 'sky', 'colour', 'chakra', 'match', 'cosmic', 'moon'],
                    },
                  },
                  required: ['screen'],
                },
              },
              {
                name: 'save_onboarding_step',
                description: 'Record ONE step of the Gaia Healers getting-to-know-you (onboarding) survey for the signed-in member, which creates their interest tags. Call this right after the member answers each step, passing the EXACT option label(s) they chose. Use complete=true only on the final step. Only for signed-in members.',
                parameters: {
                  type: 'object',
                  properties: {
                    stepKey: {
                      type: 'string',
                      description: 'The step key: primary_interests, why_join, living_beings_who, living_beings_support, environment_areas, environment_spaces, water, business_length, invest_timing, growth_needs, devices_owned, client_needs, can_offer, want_receive, or final_notes.',
                    },
                    selections: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'The exact option label(s) the member chose for this step (one or several). Empty for a skipped or free-text-only step.',
                    },
                    freeText: {
                      type: 'string',
                      description: 'Optional free-text answer (e.g. Other devices, or the final comments).',
                    },
                    complete: {
                      type: 'boolean',
                      description: 'True only on the final step, to mark the whole survey complete.',
                    },
                  },
                  required: ['stepKey'],
                },
              },
              {
                name: 'gaia_lookup',
                description: 'Look up LIVE Gaia Healers facts to answer a question accurately: store products and prices (gaiahealers.com), the practitioner directory (count and who/where), which courses exist, and the current event. Call when current verified context is missing for a price, product, membership, practitioner, course or event. Current page IDs resolve on the server; no need to repeat a lookup already answered by current context. Answer only from what it returns; never invent a price, count, or name.',
                parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look up, in the member\'s words (e.g. "Bio-Well price", "practitioner in California", "chakra sprays", "what courses").' } }, required: ['query'] },
              },
              {
                name: 'remember_member',
                description: 'Save durable facts about the signed-in member so you can continue naturally next visit. Call this when you learn something worth remembering — a real interest, a goal, a decision they made, an objection they raised, or a follow-up for next time. Do NOT save trivia, one-off logistics, or sensitive personal/financial details.',
                parameters: { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' }, description: 'Short durable facts to remember, e.g. "Wants to get Bio-Well certified", "Declined Gold - too expensive right now".' }, summary: { type: 'string', description: 'Optional one-line summary of who they are / where they are in their journey.' } }, required: ['facts'] },
              },
              {
                name: 'play_course',
                description: 'Play one of the member\'s courses in the native in-app video player. Call this when they ask to watch, play, open, or continue a specific course or its videos — e.g. "play my Bio-Well Advanced course", "watch the chakra challenge". Pass the course name.',
                parameters: { type: 'object', properties: { courseTitle: { type: 'string', description: 'The course name to play, as the member said it.' } }, required: ['courseTitle'] },
              },
              {
                name: 'express_interest',
                description: 'Record that the member is interested in a device, topic, membership, or getting certified, and open the best place for it. Call this when they express interest — e.g. "I\'m interested in BioPulsar", "tell me about getting certified", "I want structured water", "I\'m curious about Gold". Pass the topic in their words.',
                parameters: { type: 'object', properties: { topic: { type: 'string', description: 'What they are interested in, in their own words (device, topic, membership tier, certification, etc.).' } }, required: ['topic'] },
              },
              {
                name: 'register_event',
                description: 'Take the member to register for the current Gaia Healers event. Call this when they want to sign up for, register for, or attend the event — e.g. "sign me up for the event", "I want to attend the conference".',
                parameters: { type: 'object', properties: {} },
              },
              {
                name: 'find_practitioner',
                description: 'Open the in-app Find a Healer practitioner directory. Call this when they want to find, browse, or connect with a practitioner or healer — e.g. "find me a healer", "show me practitioners near me".',
                parameters: { type: 'object', properties: { specialty: { type: 'string', description: 'Optional specialty or location they mentioned.' } } },
              },
              {
                name: 'book_session',
                description: 'Open a booking or session widget so the member can book an appointment, scan, demo, call, or a 1:1 with the founder. Call this when the member asks to book, schedule, or reserve a session — for example "book a Bio-Well scan", "I want a demo", "book a discovery call", "schedule wellness coaching", or "book a call with Dr. Nima". Opens the real booking form in a new tab; the member completes the booking there.',
                parameters: {
                  type: 'object',
                  properties: {
                    session: {
                      type: 'string',
                      description: 'Which session to book. nima = book a 1:1 meeting with Dr. Nima Farshid (the founder) via Calendly.',
                      enum: ['nima', 'scan', 'demo', 'discovery', 'coaching'],
                    },
                  },
                  required: ['session'],
                },
              },
              {
                name: 'open_community',
                description: 'Open a specific Gaia Healers community in the member portal. Call this when the member asks to open, visit, or go to a community — for example "open the Bio-Well community", "take me to BioPulsar", "show me the All Gaia Healers group". Opens the community page in a new tab.',
                parameters: {
                  type: 'object',
                  properties: {
                    community: {
                      type: 'string',
                      description: 'Which community to open.',
                      enum: ['all-gaia', 'biowell', 'biopulsar', 'biotekna', 'asea', 'braintap', 'lifewave', 'golden-practitioner'],
                    },
                  },
                  required: ['community'],
                },
              },
              {
                name: 'open_portal',
                description: 'Open the Gaia Healers member portal (education.gaiahealers.com) or a specific part of it. Call this when the member wants to go to the portal itself — for example "open the portal", "take me to the member portal", "open my courses in the portal", "go to the education site". For course videos and community discussions this is where they actually live.',
                parameters: {
                  type: 'object',
                  properties: {
                    section: {
                      type: 'string',
                      description: 'Optional section of the portal. Omit for the portal home.',
                      enum: ['home', 'courses', 'login'],
                    },
                  },
                },
              },
              {
                name: 'sign_in',
                description: 'Open the in-app sign-in form so the member can sign in with their email (a one-tap magic link is sent). Call this when the member asks to sign in, log in, access their account, or says they are not signed in — for example "sign me in", "I want to log in", "help me sign in", "let me access my account". Do not call this if the member is already signed in.',
                parameters: { type: 'object', properties: {} },
              },
            ],
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
    const NAVIGATE_SCREENS = ['today', 'academy', 'community', 'events', 'bookings', 'inbox', 'directory', 'store', 'profile', 'wellness', 'practice'];
    const PRACTICE_CARDS = ['latest', 'trend', 'compare'];
    const PRACTICE_SECTIONS = ['attention', 'followups', 'clients'];

    function handleNavigateToolCall(args = {}) {
      const screen = String(args.screen || '').trim().toLowerCase();
      const tab = String(args.tab || '').trim().toLowerCase();
      const tool = String(args.tool || '').trim().toLowerCase();
      if (!screen || !NAVIGATE_SCREENS.includes(screen)) {
        return { ok: false, message: 'That screen is not available. Tell the member where to tap instead.' };
      }
      const shell = window.GaiaAppShell;
      if (!shell || typeof shell.go !== 'function') {
        return { ok: false, message: 'The app navigation is still loading. Tell the member where to tap for now.' };
      }

      // Practice is a tab inside You, not a route of its own, so it is reached
      // through the hooks that screen already listens on rather than a second
      // navigation mechanism. The client id is whatever the model was given by
      // the listing tools; if it invents one, the card's own fetch goes out with
      // this practitioner's token and their server answers "not owned by this
      // practitioner", so a guess reaches a refusal and never data.
      // My readings is a card inside You; a section asks the card to come into view.
      if (screen === 'profile' && String(args.section || '').trim().toLowerCase() === 'readings') {
        try { shell.go('profile'); window.dispatchEvent(new CustomEvent('gaia:open-readings')); } catch (e) { return { ok: false, message: 'Could not open the readings just now.' }; }
        return { ok: true, message: 'Opened You with My readings on screen. Say that it is up; do not read out any values.' };
      }
      if (screen === 'practice') {
        const client = String(args.client || '').trim();
        const open = String(args.open || '').trim().toLowerCase();
        const section = String(args.section || '').trim().toLowerCase();
        try {
          shell.go('profile', { tab: 'practice' });
          window.dispatchEvent(new CustomEvent('gaia:open-client', {
            detail: {
              client: client || null,
              open: PRACTICE_CARDS.includes(open) ? open : '',
              section: PRACTICE_SECTIONS.includes(section) ? section : '',
            },
          }));
          window.dispatchEvent(new CustomEvent('gaia:assist-minimize', {
            detail: { screen: 'practice', client, open },
          }));
        } catch (e) {
          return { ok: false, message: 'Could not open Practice. Tell them to look under You.' };
        }
        // The card is on screen and fills itself. Saying the numbers as well
        // would be reading out what they are already looking at, so the model is
        // told what is visible and asked for one short sentence -- and told to
        // expect the wait, so it does not announce readings that are not there.
        if (client && open) {
          return { ok: true, opened: true,
            message: `Their ${open === 'latest' ? 'latest reading' : open === 'trend' ? 'trend' : 'before-and-after comparison'} is opening on screen and takes about ten seconds to load. Say one short sentence — that you are pulling it up — and do not read out any numbers yet.` };
        }
        if (client) {
          return { ok: true, opened: true,
            message: 'Their client card is open on screen. Acknowledge in one short sentence; do not list details that are already visible.' };
        }
        return { ok: true, opened: true,
          message: `Practice is open${section ? ' on ' + section : ''}. Acknowledge briefly; the list is on screen.` };
      }

      try {
        shell.go(screen, tab ? { tab } : {});
        // The Energy tools are accordion panels and modals, not routes, so the
        // screen has to be there before one can be opened. A frame is enough.
        let toolOpened = false;
        if (tool && screen === 'wellness') {
          try { toolOpened = !!(window.GaiaTools && window.GaiaTools.open(tool)); } catch (_) { toolOpened = false; }
          if (!toolOpened) {
            window.requestAnimationFrame(() => {
              try { if (window.GaiaTools) window.GaiaTools.open(tool); } catch (_) {}
            });
            toolOpened = true;
          }
        }
        window.dispatchEvent(new CustomEvent('gaia:assist-minimize', {
          detail: { screen, tab: tab || '', tool: tool || '' },
        }));
        const where = toolOpened ? tool : (tab ? screen + ' / ' + tab : screen);
        return { ok: true, message: `Opening ${where} now.` };
      } catch (e) {
        return { ok: false, message: 'Could not open that screen. Tell the member where to tap instead.' };
      }
    }

    // Real booking widget URLs (verified live GHL slugs/ids, same as bookCard()
    // in gaia-member.js) + the founder Dr. Nima's Calendly (verified on
    // gaiahealers.com/pages/bio-well-demo). Opens in a new tab; the member
    // completes booking there.
    const BOOKING_URLS = {
      nima: { url: 'https://calendly.com/nimafarshid/gaia-healers-meeting', label: '1:1 with Dr. Nima' },
      scan: { url: 'https://api.leadconnectorhq.com/widget/bookings/scans', label: 'Bio-Well energy scan' },
      demo: { url: 'https://api.leadconnectorhq.com/widget/bookings/bio-welldemo', label: 'Bio-Well demo' },
      discovery: { url: 'https://api.leadconnectorhq.com/widget/form/mgf6oviyhPwrLBi03gzq', label: 'free discovery call' },
      coaching: { url: 'https://api.leadconnectorhq.com/widget/form/gVzfo7sRfbLnMzQqSnJL', label: 'wellness coaching' },
    };

    function handleBookSessionToolCall(args = {}) {
      const key = String(args.session || '').trim().toLowerCase();
      const item = BOOKING_URLS[key];
      if (!item) {
        return { ok: false, message: 'I can book a 1:1 with Dr. Nima, a Bio-Well scan, a demo, a free discovery call, or wellness coaching. Which one?' };
      }
      try {
        // Open in-app (modal iframe) so the member never leaves the app.
        // Falls back to a new tab if GaiaInApp is unavailable.
        if (window.GaiaInApp && typeof window.GaiaInApp.open === 'function') {
          window.GaiaInApp.open(item.url, 'Book ' + item.label);
          return { ok: true, message: `Opening the booking calendar for the ${item.label} right here. Pick a time that works for you.` };
        }
        window.open(item.url, '_blank', 'noopener,noreferrer');
        return { ok: true, message: `Opening the booking form for the ${item.label}. Complete your details there to confirm.` };
      } catch (e) {
        return { ok: false, message: `I could not open the booking form. The member can book a ${item.label} from the Home screen.` };
      }
    }

    // Community portal URLs. Confirmed ones open directly; pending ones fall
    // back to the portal home (matches communityOpenUrl() in the backend).
    const COMMUNITY_URLS = {
      'all-gaia': 'https://education.gaiahealers.com/gaia-healers-community',
      biopulsar: 'https://education.gaiahealers.com/biopulsar-community',
    };
    const COMMUNITY_NAMES = {
      'all-gaia': 'All Gaia Healers', biowell: 'Bio-Well Practitioners', biopulsar: 'BioPulsar Practitioners',
      biotekna: 'BioTekna Practitioners', asea: 'ASEA Community', braintap: 'BrainTap Community',
      lifewave: 'LifeWave Community', 'golden-practitioner': 'Golden Practitioner Circle',
    };
    const PORTAL_FALLBACK = 'https://education.gaiahealers.com';

    function handleOpenCommunityToolCall(args = {}) {
      const key = String(args.community || '').trim().toLowerCase();
      const name = COMMUNITY_NAMES[key];
      if (!name) {
        return { ok: false, message: 'I can open All Gaia Healers, Bio-Well, BioPulsar, BioTekna, ASEA, BrainTap, LifeWave, or the Golden Practitioner Circle. Which one?' };
      }
      const url = COMMUNITY_URLS[key] || PORTAL_FALLBACK;
      const isFallback = !COMMUNITY_URLS[key];
      try {
        if (window.GaiaInApp && typeof window.GaiaInApp.open === 'function') {
          window.GaiaInApp.open(url, name + ' community');
          return { ok: true, message: isFallback
            ? `Opening the ${name} community right here in the app.`
            : `Opening the ${name} community now.` };
        }
        window.open(url, '_blank', 'noopener,noreferrer');
        return { ok: true, message: isFallback
          ? `Opening the ${name} community in the Gaia Healers portal.`
          : `Opening the ${name} community now.` };
      } catch (e) {
        return { ok: false, message: `I could not open the ${name} community. The member can reach it from the Community screen.` };
      }
    }

    function handleOpenPortalToolCall(args = {}) {
      const section = String(args.section || 'home').trim().toLowerCase();
      const urls = {
        home: PORTAL_FALLBACK,
        courses: 'https://education.gaiahealers.com/courses/library-v2',
        login: 'https://education.gaiahealers.com/login',
      };
      const url = urls[section] || urls.home;
      try {
        if (window.GaiaInApp && typeof window.GaiaInApp.open === 'function') {
          window.GaiaInApp.open(url, 'Gaia Healers Member Portal');
          return { ok: true, message: `Opening the Gaia Healers member portal${section === 'courses' ? ' courses' : section === 'login' ? ' login' : ''} right here in the app.` };
        }
        window.open(url, '_blank', 'noopener,noreferrer');
        return { ok: true, message: `Opening the Gaia Healers member portal${section === 'courses' ? ' courses' : section === 'login' ? ' login' : ''} now.` };
      } catch (e) {
        return { ok: false, message: 'I could not open the portal. The member can visit education.gaiahealers.com directly.' };
      }
    }

    function handleSignInToolCall() {
      const auth = window.GaiaAuth;
      if (!auth || typeof auth.open !== 'function') {
        return { ok: false, message: 'Sign-in is still loading. Tell the member to tap Sign in at the top right.' };
      }
      try {
        auth.open();
        return { ok: true, message: 'Opening the sign-in form. Enter your member email and I will send you a one-tap link.' };
      } catch (e) {
        return { ok: false, message: 'I could not open sign-in. Tell the member to tap Sign in at the top right.' };
      }
    }

    async function handleGaiaLookupToolCall(args = {}) {
      const query = String(args.query || args.q || '').trim();
      if (!query) return { ok: false, message: 'Ask what they want to look up.' };
      try {
        const res = await fetch(proxyBase() + '/api/assist/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ query, appContext: window.GaiaAssistContext?.().appContext }) });
        const d = await res.json().catch(() => ({}));
        const summary = (d && d.summary) ? d.summary : '';
        if (!summary) return { ok: true, message: 'I did not find a live match for that. Say the current facts are unavailable; do not substitute remembered prices, availability or access. Offer the relevant screen if useful.' };
        return { ok: true, message: 'LIVE DATA (answer only from this, do not invent): ' + summary };
      } catch (e) { return { ok: false, message: 'I could not look that up right now.' }; }
    }
    async function handleRememberMemberToolCall(args = {}) {
      let facts = args.facts;
      if (typeof facts === 'string') facts = facts.split(/\s*;;\s*/);
      if (!Array.isArray(facts)) facts = facts ? [String(facts)] : [];
      facts = facts.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12);
      if (!facts.length) return { ok: true, message: 'Nothing new to remember yet.' };
      try {
        const res = await fetch(proxyBase() + '/api/assist/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ facts, summary: String(args.summary || '') }) });
        const d = await res.json().catch(() => ({}));
        if (!d || !d.ok) return { ok: false, message: (d && d.reason === 'not_signed_in') ? 'They need to sign in for me to remember them.' : 'I could not save that just now.' };
        return { ok: true, message: 'Saved to memory. Do not mention this; just keep the conversation going.' };
      } catch (e) { return { ok: false, message: 'I could not save that just now.' }; }
    }
    async function handlePlayCourseToolCall(args = {}) {
      const title = String(args.courseTitle || args.course || args.title || '').trim();
      if (!title) return { ok: false, message: 'Ask which course they would like to watch.' };
      try {
        const P = window.GaiaAcademyPlayer;
        if (P && typeof P.has === 'function' && P.has(title)) {
          if (typeof P.ready === 'function') { try { await P.ready(); } catch (e) {} }
          P.open(title);
          return { ok: true, message: 'Playing ' + title + ' in the app now. Tell them they can tap any lesson to jump to it.' };
        }
        window.GaiaAppShell && window.GaiaAppShell.go && window.GaiaAppShell.go('academy');
        return { ok: true, message: 'I opened Academy — their owned courses are under Your courses. That title may not be mirrored in-app yet; if so it opens in the portal.' };
      } catch (e) { return { ok: false, message: 'I could not start that course; open Academy and tap it under Your courses.' }; }
    }
    async function handleExpressInterestToolCall(args = {}) {
      const topic = String(args.topic || args.interest || '').trim();
      if (!topic) return { ok: false, message: 'Ask what they are interested in.' };
      try {
        const res = await fetch(proxyBase() + '/api/assist/interest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ topic }) });
        const d = await res.json().catch(() => ({}));
        const route = d && d.route;
        if (route) {
          if (route.kind === 'community') { handleOpenCommunityToolCall({ community: route.community }); }
          else if (route.kind === 'navigate' && window.GaiaAppShell && window.GaiaAppShell.go) { window.GaiaAppShell.go(route.screen, route.tab ? { tab: route.tab } : {}); }
          else if (route.kind === 'url' && window.GaiaInApp && window.GaiaInApp.open) { window.GaiaInApp.open(route.url, topic); }
        }
        return { ok: true, message: (d && d.saved ? 'Noted your interest in ' + topic + '. ' : '') + 'I am opening the best place for it — tell them what they are seeing and offer the next step.' };
      } catch (e) { return { ok: true, message: 'Noted. Let me point you to the right place for that.' }; }
    }
    function handleRegisterEventToolCall() {
      try { if (window.GaiaAppShell && window.GaiaAppShell.go) window.GaiaAppShell.go('events'); return { ok: true, message: 'Opening the Events screen — tell them to tap Register on the event to sign up.' }; }
      catch (e) { return { ok: false, message: 'Tell them to open the Events tab and tap Register.' }; }
    }
    function handleFindPractitionerToolCall() {
      try { if (window.GaiaAppShell && window.GaiaAppShell.go) window.GaiaAppShell.go('directory'); return { ok: true, message: 'Opening Find a Healer — they can browse and filter practitioners there.' }; }
      catch (e) { return { ok: false, message: 'Tell them to go to Community and tap Find a Healer.' }; }
    }
    async function handleSaveOnboardingToolCall(args = {}) {
      try {
        const stepKey = String(args.stepKey || args.step || '').trim();
        let selections = args.selections;
        if (typeof selections === 'string') selections = selections.split(/\s*[;,|]\s*/);
        if (!Array.isArray(selections)) selections = selections ? [String(selections)] : [];
        selections = selections.map((x) => String(x || '').trim()).filter(Boolean);
        const body = { stepKey, selections, freeText: String(args.freeText || ''), complete: Boolean(args.complete) };
        const res = await fetch(proxyBase() + '/api/assist/onboarding', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (!d || !d.ok) {
          return { ok: false, message: (d && d.reason === 'not_signed_in')
            ? 'They need to sign in before I can save their answers.'
            : 'I could not save that step. Keep the answer on this step and retry; do not advance or claim it was saved.' };
        }
        return { ok: true, message: 'Saved.' + (d.complete ? ' Their onboarding profile is now complete.' : ' Continue to the next question.') };
      } catch (e) {
        return { ok: false, message: 'I could not save that step right now.' };
      }
    }

    /**
     * Ask the server to run a tool this page does not perform itself.
     *
     * The call carries the tool name and its arguments and nothing else: the
     * session cookie says who is asking, and the server decides both what they
     * may run and whose data comes back. Nothing here can claim an identity.
     */
    // Which card a practitioner tool is really asking to see.
    //
    // "Show me his latest scan" is a request to LOOK at something, and the model
    // answered it by fetching the data and describing it -- then saying "it is on
    // screen" when nothing had opened. Telling the model to call navigate as well
    // would make that a second thing it has to remember; doing it here makes it
    // a fact. The card opens the moment the tool is called, shows its waiting
    // state, and is filled from the SAME result the model gets, so the ten
    // seconds is paid once rather than twice.
    const PRACTITIONER_CARD = {
      practitioner_client_latest_scan: 'latest',
      practitioner_client_trend: 'trend',
      practitioner_compare_sessions: 'compare',
      practitioner_get_client: '',
      practitioner_suggested_services: '',
      practitioner_client_files: '',
    };

    function openPractitionerView(name, args) {
      const card = PRACTITIONER_CARD[name];
      if (card === undefined) return false;
      const client = String((args && args.clientId) || '').trim();
      if (!client) return false;
      try {
        window.GaiaAppShell?.go?.('profile', { tab: 'practice' });
        // `awaiting` tells the panel the answer is already on its way, so it
        // shows the waiting state without starting an eleven-second call of its
        // own beside the one that is already running.
        window.dispatchEvent(new CustomEvent('gaia:open-client',
          { detail: { client, open: card, awaiting: true } }));
      } catch (e) { return false; }
      return true;
    }

    async function runServerToolCall(name, args) {
      const showing = openPractitionerView(name, args);
      const endpoint = serverToolEndpoint || '/api/assist/tool';
      try {
        const res = await fetch(`${proxyBase()}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name, args: args || {} }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          // Hand the card the result the model is about to be given, so the
          // screen and the answer come from one fetch and cannot disagree.
          if (showing) {
            window.dispatchEvent(new CustomEvent('gaia:client-data', {
              detail: { client: String(args.clientId), open: PRACTITIONER_CARD[name], data: body.result },
            }));
          }
          // The server may hand the model a narrower view than the card
          // (scan readings while no BAA covers the voice provider).
          return { ok: true, data: body.model !== undefined ? body.model : body.result, shown: showing };
        }
        if (showing) {
          window.dispatchEvent(new CustomEvent('gaia:client-data', {
            detail: { client: String(args.clientId), open: PRACTITIONER_CARD[name], error: body.error || 'failed' },
          }));
        }
        if (body.error === 'not_connected' || body.error === 'needs_reconnect') {
          return { ok: false, message: 'Their Gaia Practitioners account is not connected yet. They can connect it from their profile.' };
        }
        if (body.error === 'forbidden') return { ok: false, message: 'That is not available for this account.' };
        return { ok: false, message: 'I could not fetch that just now.' };
      } catch (e) {
        return { ok: false, message: 'I could not reach that right now.' };
      }
    }

    // Central tool dispatcher: routes a toolCall to the right handler.
    //
    // A name this page has no case for is not an error any more -- the server
    // declares tools it runs itself, and this is how they get there.
    function runToolCall(name, args = {}) {
      if (window.GaiaAppGuard && !window.GaiaAppGuard.canEnter && !['save_onboarding_step', 'sign_in'].includes(name)) return { ok: false, reason: 'onboarding_required' };
      if (serverToolNames && !serverToolNames.includes(name)) {
        if (serverSlowTools.includes(name)) {
          emit('telemetry', { event: 'tool_slow_started', tool: name });
          setStatus('thinking');
        }
        return runServerToolCall(name, args);
      }
      switch (name) {
        case 'navigate': return handleNavigateToolCall(args);
        case 'book_session': return handleBookSessionToolCall(args);
        case 'open_community': return handleOpenCommunityToolCall(args);
        case 'open_portal': return handleOpenPortalToolCall(args);
        case 'sign_in': return handleSignInToolCall();
        case 'save_onboarding_step': return handleSaveOnboardingToolCall(args);
        case 'gaia_lookup': return handleGaiaLookupToolCall(args);
        case 'remember_member': return handleRememberMemberToolCall(args);
        case 'play_course': return handlePlayCourseToolCall(args);
        case 'express_interest': return handleExpressInterestToolCall(args);
        case 'register_event': return handleRegisterEventToolCall();
        case 'find_practitioner': return handleFindPractitionerToolCall();
        default: return { ok: false, message: 'That action is not available yet.' };
      }
    }

    // Gemini: Google's socket with a single-use token. Qwen: our relay, which
    // speaks Gemini's messages to this page and holds the Qwen key itself.
    function socketUrl(meta) {
      if (meta && meta.provider === 'qwen' && meta.relayUrl) return meta.relayUrl;
      throw new Error('voice relay unavailable');   // internal; the member sees VOICE_UNAVAILABLE_COPY
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
      cachedToken = null;
      cachedTokenExpireAt = 0;
      setupDone = false;
      setupWaiters = [];
      holding = false;
      maySendAudio = false;
      playbackGraceUntil = 0;
      localSpeechActive = false;
      speechCandidateAt = 0;
      localSilenceAt = 0;
      noiseFloor = 0.004;
      audioPrebuffer = [];

      if (listenResumeRef.current != null) {
        window.clearTimeout(listenResumeRef.current);
        listenResumeRef.current = null;
      }

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
        const samples = event.data.data;
        const now = Date.now();

        // Keep the microphone logically closed while Gaia's audio is playing,
        // including a short tail for speaker echo. It reopens automatically.
        if (status === 'speaking' || now < playbackGraceUntil + 320) {
          localSpeechActive = false;
          speechCandidateAt = 0;
          localSilenceAt = 0;
          audioPrebuffer = [];
          return;
        }

        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / Math.max(1, samples.length));
        const startThreshold = Math.max(0.018, noiseFloor * 3.0);
        const continueThreshold = Math.max(0.012, noiseFloor * 2.0);

        if (!localSpeechActive) {
          noiseFloor = Math.min(0.03, Math.max(0.0025, (noiseFloor * 0.985) + (Math.min(rms, 0.03) * 0.015)));
          audioPrebuffer.push(samples.slice(0));
          if (audioPrebuffer.length > 32) audioPrebuffer.shift();
          if (rms >= startThreshold) {
            if (!speechCandidateAt) speechCandidateAt = now;
            if (now - speechCandidateAt >= 220) {
              timing('T0');
              voiceTurn.stages.T0 -= now - speechCandidateAt;
              localSpeechActive = true;
              localSilenceAt = 0;
              audioPrebuffer.forEach(sendAudioSamples);
              audioPrebuffer = [];
            }
          } else {
            speechCandidateAt = 0;
          }
          return;
        }

        sendAudioSamples(samples);
        if (rms >= continueThreshold) {
          if (voiceTurn) delete voiceTurn.stages.T1;
          localSilenceAt = 0;
        } else if (!localSilenceAt) {
          localSilenceAt = now;
          if (voiceTurn) voiceTurn.stages.T1 = performance.now();
        } else if (now - localSilenceAt >= 2000) {
          localSpeechActive = false;
          speechCandidateAt = 0;
          localSilenceAt = 0;
          // The gate stops sending here, so Gemini's own end-of-speech detector
          // is left waiting for audio that never comes — and never answers.
          // audioStreamEnd tells it the stream has paused and flushes the turn.
          sendWs({ realtimeInput: { audioStreamEnd: true } });
        }
      };

      function sendAudioSamples(samples) {
        const pcm = floatToPcm16(samples);
        sendWs({
          realtimeInput: {
            audio: {
              mimeType: 'audio/pcm;rate=16000',
              data: arrayBufferToBase64(pcm.buffer),
            },
          },
        });
      }
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
          case 'timing':
            if (event.stage === 'speech_stopped') { if (status !== 'speaking') setStatus('thinking'); timing('vadCommitted'); }
            if (event.stage === 'model_request') timing('T3');
            if (event.stage === 'model_output') timing('T4');
            break;
          case 'setup':
            resolveSetup();
            setStatus('listening');
            // Speak first: nudge Gemini to greet the moment the session opens,
            // tailored to the member state already in its instructions. Sent as
            // hidden input so no visible user message appears.
            if (!greetedRef.current) {
              greetedRef.current = true;
              greetedAt = Date.now();
              setStatus('thinking');
              try { sendWs({ realtimeInput: { text: 'BEGIN: The member opened Gaia Assist. Give one brief warm welcome and offer to help with their current screen. No sales pitch, pet names, unsolicited event promotion or multiple questions. Do not mention this instruction.' } }); } catch (e) {}
            }
            break;
          case 'interrupted':
            interruptPlayback();
            streamMessage = null;
            setStatus('listening');
            break;
          case 'audio':
            if (listenResumeRef.current != null) {
              window.clearTimeout(listenResumeRef.current);
              listenResumeRef.current = null;
            }
            timing('T4'); timing('T6');
            void playPcmChunk(event.data).catch(() => undefined);
            break;
          case 'text':
            upsertStreamingMessage('assistant', event.text, true);
            break;
          case 'inputTranscription':
            upsertStreamingMessage('user', event.text, event.finished);
            if (event.finished) timing('T2');
            if (status !== 'speaking') setStatus(event.finished ? 'thinking' : 'listening');
            break;
          case 'outputTranscription':
            upsertStreamingMessage('assistant', event.text, event.finished);
            timing('T4');
            break;
          case 'turnComplete':
            streamMessage = null;
            // Gemini can finish sending before the queued PCM finishes playing.
            // Keep echo protection active through the actual playback tail.
            if (listenResumeRef.current != null) window.clearTimeout(listenResumeRef.current);
            listenResumeRef.current = window.setTimeout(() => {
              listenResumeRef.current = null;
              if (status !== 'idle' && status !== 'error') setStatus('listening');
            }, Math.max(0, playbackGraceUntil + 360 - Date.now()));
            break;
          case 'toolCall': {
            // Run the requested tool locally, then send the result back so the
            // model can confirm the action aloud and finish its turn.
            const toolStarted = performance.now();
            Promise.resolve(runToolCall(event.name, event.args || {})).then((result) => {
              emit('telemetry', { event: 'tool_completed', tool: event.name, durationMs: Math.round(performance.now() - toolStarted), ok: !!result?.ok });
              // toolResponse lets the Live session continue after a function call.
              sendWs({
                toolResponse: {
                  functionResponses: [{
                    id: event.id || '',
                    name: event.name || '',
                    // A tool that FETCHED something has to return the something.
                    // Sending "Done." for a client list would leave the model
                    // confirming an action it was never asked to take, with
                    // nothing to answer the question from.
                    response: {
                      result: (result && result.data !== undefined)
                        ? result.data
                        : ((result && result.message) || (result && result.ok ? 'Done.' : 'Unavailable.')),
                    },
                  }],
                },
              });
            });
            break;
          }
          case 'handover':
            cleanupSession(); setErrorMessage(VOICE_UNAVAILABLE_COPY); setStatus('error');
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

    document.addEventListener('gaia:onboarding-step', e => {
      if (sessionMeta?.provider === 'qwen' && setupDone) sendWs({ gaiaContext: window.GaiaAssistGuide.context(e.detail) });
      cachedToken = null; cachedTokenExpireAt = 0;
    });
    window.addEventListener('gaia:route', e => {
      if (sessionMeta?.provider === 'qwen' && setupDone) sendWs({ gaiaContext: window.GaiaAssistGuide.context({ screen: e.detail?.view }) });
      cachedToken = null; cachedTokenExpireAt = 0;
    });
    let cachedToken = null;
    let serverToolNames = null;
    let serverToolEndpoint = '';
    let serverSlowTools = [];
    let cachedTokenExpireAt = 0;

    function consumeCachedToken(payload) {
      if (cachedToken !== payload) return;
      cachedToken = null;
      cachedTokenExpireAt = 0;
    }

    async function fetchLiveToken({ force = false, provider = '' } = {}) {
      // Cache only an unused pre-warmed token. Gemini ephemeral tokens are
      // single-use, so the token is removed from this cache as soon as a
      // WebSocket connection consumes it.
      if (!force && !provider && cachedToken && Date.now() < cachedTokenExpireAt) {
        return cachedToken;
      }
      // The server picks the engine (Qwen first, Gemini as the fallback); the
      // phone language lets a Persian speaker start on Gemini directly.
      const params = new URLSearchParams({ view: currentView(), lang: navigator.language || '' });
      const itemId = window.GaiaAssistContext?.().appContext?.itemId;
      if (itemId) params.set('itemId', itemId);
      const journeyContext = window.GaiaJourney?.context;
      if (journeyContext) { params.set('step', journeyContext.step); params.set('branch', journeyContext.branch); }
      if (provider) params.set('provider', provider);
      const response = await fetch(`${proxyBase()}/api/assist/voice/token?${params}`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      const payload = await response.json().catch(() => ({}));
      if (payload.ok && payload.provider !== 'qwen') throw new Error('Qwen voice is required.');
      if (!response.ok || !payload.ok || !(payload.token || payload.relayUrl)) {
        throw new Error(tokenErrorMessage(payload, response.status));
      }
      cachedToken = payload;
      // What the model may call is the server's decision now, and it travels
      // with the ticket. The page is told only which of those it is expected to
      // perform itself; anything else goes back to the server to run, with the
      // session deciding whose data it is. Older proxies send neither field, and
      // then the page behaves exactly as it did before.
      serverToolNames = Array.isArray(payload.clientTools) ? payload.clientTools : null;
      serverToolEndpoint = typeof payload.toolEndpoint === 'string' ? payload.toolEndpoint : '';
      // Some tools take about ten seconds, because their side fetches from
      // Bio-Well. The model is told to say so; this is what stops the orb
      // looking frozen while it does.
      serverSlowTools = Array.isArray(payload.slowTools) ? payload.slowTools : [];
      // A token lives 30 minutes, but Google only lets it OPEN a session in
      // the first minute (newSessionExpireTime on the server). A pre-warmed
      // token older than that is refused, so reuse one for 45 seconds at most.
      const expireMs = payload.expireTime ? new Date(payload.expireTime).getTime() - 120000 : Infinity;
      cachedTokenExpireAt = Math.min(expireMs, Date.now() + 45 * 1000);
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
      greetedRef.current = false;
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
          sessionMeta = await fetchLiveToken({ provider: startOptions.provider || '' });

          // Run three independent setup legs IN PARALLEL instead of serially.
          // This is the main speedup: previously WS+setup → audio → mic was
          // sequential (~2-4s); now the slowest leg wins (~0.5-1.5s).
          const [wsReady, , micOk] = await Promise.all([
            // Leg 1: WebSocket connect + Gemini setup
            (async () => {
              const wsUrl = socketUrl(sessionMeta);
              consumeCachedToken(sessionMeta);
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
              await waitForSetup(ws);
              // Auto-reconnect on an UNEXPECTED close (network blip, server
              // idle drop, tab backgrounding) — the user asked for Gaia to
              // "stay and help", so we try one silent reconnect before giving
              // up. Skip when the user explicitly stopped (status === 'idle')
              // or we're already in an error state from another failure.
              let reconnectAttempted = false;
              const attemptReconnect = () => {
                if (reconnectAttempted) return false;          // only once
                if (status === 'idle' || status === 'error') return false;
                reconnectAttempted = true;
                setStatus('connecting');
                // Ephemeral Gemini tokens are single-use. Fetch a new token
                // for the replacement socket while keeping the existing mic
                // stream alive.
                void (async () => {
                  try {
                    const nextSessionMeta = await fetchLiveToken({ force: true });
                    if (status === 'idle' || status === 'error') return;
                    sessionMeta = nextSessionMeta;
                    consumeCachedToken(nextSessionMeta);
                    setupDone = false;
                    const wsUrl = socketUrl(nextSessionMeta);
                    const ws2 = new WebSocket(wsUrl);
                    wsRef.current = ws2;
                    ws2.onmessage = async (event2) => {
                      let raw = event2.data;
                      if (raw instanceof Blob) raw = await raw.text();
                      else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
                      handleGeminiMessage(raw);
                    };
                    ws2.onopen = () => {
                      sendSetupMessage();
                    };
                    ws2.onclose = () => {
                      // Second close → give up with a friendly error.
                      if (status !== 'idle') {
                        setErrorMessage('Voice connection dropped. Tap the orb to resume.');
                        setStatus('error');
                      }
                    };
                    ws2.onerror = () => {
                      if (status !== 'idle') {
                        setErrorMessage('Voice connection failed. Tap the orb to resume.');
                        setStatus('error');
                      }
                    };
                  } catch (_) {
                    if (status !== 'idle') {
                      setErrorMessage('Voice connection failed. Tap the orb to resume.');
                      setStatus('error');
                    }
                  }
                })();
                return true;
              };
              ws.onclose = (event) => {
                if (status === 'idle') return;                 // user stopped — stay quiet
                if (switchingEngine || wsRef.current !== ws) return; // handed over
                // The relay could not start the session for a reason that will
                // not change in a second (the account is not entitled to the
                // model, the key was rejected). A silent reconnect here is a
                // second billed attempt that fails the same way, and then shows
                // "connection dropped" -- which is not what happened. Say what
                // did, calmly, and leave the keyboard.
                if (window.GaiaAssistGuide?.voiceClosePermanent?.(event?.code, event?.reason)) {
                  cleanupSession();
                  setErrorMessage(VOICE_UNAVAILABLE_COPY);
                  setStatus('error');
                  return;
                }
                // Try one silent reconnect; if that path is taken, don't surface
                // an error yet. Otherwise show the normal close message.
                if (!attemptReconnect()) {
                  if (status !== 'error') {
                    setErrorMessage(event?.reason || 'Voice connection closed. Tap the orb to resume.');
                    setStatus('error');
                  }
                }
              };
              ws.onerror = () => {
                // onclose will fire immediately after; let it decide whether to
                // reconnect or surface the error.
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
          setErrorMessage(VOICE_UNAVAILABLE_COPY);
          setStatus('error');
        } finally {
          startPromise = null;
        }
      })();

      startPromise = startTask;
      return startTask;
    }

    async function holdStart() { await start(); }
    function holdEnd() { /* Continuous Qwen VAD. */ }

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
      if (muted) {
        // Flush a partially captured turn before a long microphone pause, as
        // required by Gemini Live automatic VAD.
        sendWs({ realtimeInput: { audioStreamEnd: true } });
      }
      return muted;
    }

    // The session greets on its own the moment it opens (above), and the panel
    // then sends its welcome prompt as well. Gemini folds the two into one
    // greeting; Qwen answers both, so the member heard "Welcome…" and then
    // "Hi, I'm Gaia Assist…". A silent prompt that lands just after our own
    // greeting, before the member has said anything, is that duplicate.
    let greetedAt = 0;
    function isDuplicateGreeting(options) {
      return Boolean(options.silent && greetedAt && Date.now() - greetedAt < 10_000
        && !messages.some((m) => m.role === 'user'));
    }

    function sendText(raw, options = {}) {
      const text = raw.trim();
      if (!text) return false;
      if (isDuplicateGreeting(options)) return true;
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
      get telemetry() { return turnResults.map(turn => ({ ...turn, stages: { ...turn.stages } })); },
      get muted() { return muted; },
      get isHolding() { return holding; },
      // True once the live socket has been given up on: the orb is
      // hold-to-talk now, and the UI should say so.
      get pipelineMode() { return false; },
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
