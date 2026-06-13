/* Gaia Healers V2 — prototype interactions */
(function () {
  if (new URLSearchParams(window.location.search).has('store')) {
    sessionStorage.setItem('gaia-coach-v2', '1');
    sessionStorage.setItem('gaia-entered', '1');
    sessionStorage.setItem('gaia-onboarded', '1');
  }

  const COACH_KEY = 'gaia-coach-v2';

  function initCoachMark() {
    if (window.location.pathname.split('/').pop() !== 'home.html') return;
    if (sessionStorage.getItem(COACH_KEY)) return;
    const anchor = document.getElementById('gaia-coach-anchor');
    if (!anchor) return;

    const tip = document.createElement('div');
    tip.className = 'gaia-coach';
    tip.innerHTML = `
      <p class="gaia-eyebrow !text-gaia-light">Client Portal</p>
      <p class="mt-2 text-body !text-white/90">Your <strong class="text-white">Today</strong> view unifies Bio-Well, certification, and community.</p>
      <button type="button" class="mt-4 text-caption font-semibold text-gaia-light">Dismiss</button>`;
    tip.querySelector('button').addEventListener('click', () => {
      sessionStorage.setItem(COACH_KEY, '1');
      tip.remove();
    });
    anchor.before(tip);
  }

  function initSplashSteps() {
    const root = document.getElementById('splash-flow');
    if (!root) return;
    const steps = root.querySelectorAll('.splash-step');
    const dots = root.querySelectorAll('[data-splash-dot]');
    const nextBtn = root.querySelector('[data-splash-next]');
    const enterLink = root.querySelector('[data-splash-enter]');
    let i = 0;

    function show(n) {
      steps.forEach((s, idx) => s.classList.toggle('active', idx === n));
      dots.forEach((d, idx) => {
        d.classList.toggle('bg-gaia', idx === n);
        d.classList.toggle('bg-neutral-200', idx !== n);
        d.classList.toggle('w-6', idx === n);
        d.classList.toggle('w-1.5', idx !== n);
      });
      if (nextBtn) nextBtn.textContent = n === steps.length - 1 ? 'Enter portal' : 'Continue';
      if (enterLink) enterLink.classList.toggle('hidden', n !== steps.length - 1);
      if (nextBtn) nextBtn.classList.toggle('hidden', n === steps.length - 1);
    }

    nextBtn?.addEventListener('click', () => {
      if (i < steps.length - 1) { i += 1; show(i); }
    });
    enterLink?.addEventListener('click', () => {
      sessionStorage.setItem('gaia-entered', '1');
      sessionStorage.setItem('gaia-onboarded', '1');
    });
    show(0);
  }

  function initCommunityTabs() {
    const bar = document.getElementById('community-tabs');
    if (!bar) return;
    const panels = { feed: 'panel-feed', groups: 'panel-groups', events: 'panel-events', directory: 'panel-directory' };
    const buttons = bar.querySelectorAll('[data-tab]');
    function activate(btn) {
        const tab = btn.getAttribute('data-tab');
        buttons.forEach((b) => {
          const on = b === btn;
          b.classList.toggle('bg-gaia', on);
          b.classList.toggle('text-white', on);
          b.classList.toggle('bg-surface-muted', !on);
          b.classList.toggle('text-ink-secondary', !on);
        });
        Object.entries(panels).forEach(([k, id]) => {
          const el = document.getElementById(id);
          if (el) el.classList.toggle('hidden', k !== tab);
        });
    }
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        activate(btn);
      });
    });
    const requestedTab = new URLSearchParams(window.location.search).get('tab');
    const requestedButton = requestedTab && bar.querySelector(`[data-tab="${requestedTab}"]`);
    if (requestedButton) activate(requestedButton);
  }

  function initGaiaAssist() {
    if (!document.body.classList.contains('gaia-page')) return;
    if (document.getElementById('gaia-assist')) return;

    const data = window.GAIA || {};
    const assistant = data.assistant || {};
    const root = document.createElement('section');
    root.id = 'gaia-assist';
    root.className = 'gaia-assist';
    root.innerHTML = `
      <button type="button" class="gaia-assist__orb" aria-label="Open Gaia Assist" aria-expanded="false">
        <span class="gaia-assist__pulse"></span>
        <span class="gaia-assist__mark">G</span>
      </button>
      <div class="gaia-assist__panel" role="dialog" aria-label="${assistant.name || 'Gaia Assist'}" hidden>
        <div class="gaia-assist__handle"></div>
        <div class="gaia-assist__top">
          <div>
            <p class="gaia-eyebrow">${assistant.mode || 'Push-to-talk'}</p>
            <h2>${assistant.name || 'Gaia Assist'}</h2>
          </div>
          <button type="button" class="gaia-assist__close" aria-label="Close Gaia Assist">Close</button>
        </div>
        <div class="gaia-assist__voice" data-assist-state="idle">
          <button type="button" class="gaia-assist__mic" aria-label="Start voice prompt">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-12 0v1.5a6 6 0 006 6m0 0v3m-3 0h6M12 15a2.25 2.25 0 002.25-2.25v-6a2.25 2.25 0 00-4.5 0v6A2.25 2.25 0 0012 15z"/></svg>
          </button>
          <div class="gaia-assist__wave" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <p class="gaia-assist__status">Tap to speak</p>
        </div>
        <div class="gaia-assist__transcript">
          <p class="gaia-assist__bubble gaia-assist__bubble--user">What should I focus on today?</p>
          <p class="gaia-assist__bubble gaia-assist__bubble--bot">Your portal is ready. I can help with Bio-Well scans, Academy progress, Elevate event check-in, and GHL follow-up workflows.</p>
        </div>
        <form class="gaia-assist__form">
          <label class="gaia-assist__label" for="gaia-assist-prompt">Type a prompt</label>
          <div class="gaia-assist__input-row">
            <input id="gaia-assist-prompt" name="prompt" type="text" autocomplete="off" placeholder="Ask about my Elevate badge" />
            <button type="submit">Send</button>
          </div>
        </form>
        <p class="gaia-assist__error" role="alert" hidden></p>
        <div class="gaia-assist__chips"></div>
        <p class="gaia-assist__promise">${assistant.promise || 'Review before anything is saved.'}</p>
      </div>`;

    document.body.appendChild(root);

    const orb = root.querySelector('.gaia-assist__orb');
    const panel = root.querySelector('.gaia-assist__panel');
    const close = root.querySelector('.gaia-assist__close');
    const mic = root.querySelector('.gaia-assist__mic');
    const status = root.querySelector('.gaia-assist__status');
    const transcript = root.querySelector('.gaia-assist__transcript');
    const chips = root.querySelector('.gaia-assist__chips');
    const form = root.querySelector('.gaia-assist__form');
    const promptInput = root.querySelector('#gaia-assist-prompt');
    const error = root.querySelector('.gaia-assist__error');
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let recognizing = false;

    const suggestionMap = [
      { label: assistant.suggestions?.[0] || 'Prepare my badge', reply: assistant.responses?.event, intent: 'event' },
      { label: assistant.suggestions?.[1] || 'Explain my scan', reply: assistant.responses?.scan, intent: 'scan' },
      { label: assistant.suggestions?.[2] || 'Next course step', reply: assistant.responses?.academy, intent: 'academy' },
      { label: assistant.suggestions?.[3] || 'GHL follow-up', reply: assistant.responses?.ghl, intent: 'ghl' },
    ];
    chips.innerHTML = suggestionMap.map((item) => `<button type="button" data-intent="${item.intent}">${item.label}</button>`).join('');

    function assistLog(event, detail = {}) {
      console.info(`[Gaia Assist] ${event}`, detail);
    }

    function assistError(event, err) {
      console.error(`[Gaia Assist] ${event}`, err);
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function proxyBase() {
      return (window.GAIA_SYNC?.proxyBase || '').replace(/\/+$/, '');
    }

    function setOpen(open) {
      panel.hidden = !open;
      orb.setAttribute('aria-expanded', String(open));
      root.classList.toggle('gaia-assist--open', open);
    }

    function setError(message) {
      error.hidden = !message;
      error.textContent = message || '';
    }

    function setBusy(busy, label = 'Working...') {
      mic.disabled = busy;
      form.querySelector('button').disabled = busy;
      chips.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
      status.textContent = busy ? label : 'Ready for next prompt';
      root.classList.toggle('gaia-assist--thinking', busy);
    }

    function appendMessage(kind, text) {
      const bubble = document.createElement('p');
      bubble.className = `gaia-assist__bubble gaia-assist__bubble--${kind}`;
      bubble.innerHTML = escapeHtml(text);
      transcript.appendChild(bubble);
      transcript.scrollTop = transcript.scrollHeight;
    }

    async function sendPrompt(prompt, intent = 'general', source = 'text') {
      const cleanPrompt = String(prompt || '').trim();
      if (!cleanPrompt) {
        setError('Type or speak a prompt first.');
        return;
      }
      const base = proxyBase();
      if (!base) {
        setError('Gaia Assist needs the staging proxy URL. Open the app with the proxy= query parameter.');
        assistError('proxy missing', { prompt: cleanPrompt, intent, source });
        return;
      }

      setError('');
      appendMessage('user', cleanPrompt);
      setBusy(true, 'Sending to Gaia proxy...');
      assistLog('request sent to proxy', { endpoint: `${base}/api/assist/chat`, intent, source });

      try {
        const response = await fetch(`${base}/api/assist/chat`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
          body: JSON.stringify({
            prompt: cleanPrompt,
            intent,
            source,
            page: window.location.pathname.split('/').pop() || 'home.html',
          }),
        });
        assistLog('proxy response received', { status: response.status });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || `Proxy returned ${response.status}`);
        }
        if (payload.warning) {
          setError(payload.warning);
          assistLog('OpenAI/voice warning', { warning: payload.warning, provider: payload.provider });
        }
        appendMessage('bot', payload.reply || 'Gaia Assist received the prompt but did not return a message.');
      } catch (err) {
        assistError('OpenAI/voice error', err);
        setError(err.message || 'Gaia Assist could not reach the proxy.');
        appendMessage('bot', 'I could not complete that request. The proxy or voice backend returned an error, and no data was changed.');
      } finally {
        setBusy(false);
      }
    }

    function stopRecognition() {
      if (recognition && recognizing) {
        assistLog('recording stopped', { reason: 'manual-stop' });
        recognition.stop();
      }
    }

    async function ensureMicPermission() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser does not expose microphone permissions. Use the text box to test Gaia Assist.');
      }
      assistLog('mic permission requested');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      assistLog('mic permission granted');
    }

    async function startVoicePrompt() {
      if (recognizing) {
        stopRecognition();
        return;
      }

      setError('');
      try {
        await ensureMicPermission();
      } catch (err) {
        assistError('mic permission error', err);
        setError('Microphone permission was blocked. Allow microphone access in the browser, or use the text box to test Gaia Assist.');
        return;
      }

      if (!SpeechRecognition) {
        setError('Speech recognition is not available in this browser. Use the text box to test the same proxy path.');
        assistError('speech recognition unavailable', { userAgent: navigator.userAgent });
        return;
      }

      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;

      let finalTranscript = '';
      recognition.onstart = () => {
        recognizing = true;
        root.classList.add('gaia-assist--listening');
        status.textContent = 'Listening...';
        assistLog('recording started');
      };
      recognition.onresult = (event) => {
        const spoken = Array.from(event.results)
          .map((result) => result[0]?.transcript || '')
          .join(' ')
          .trim();
        if (spoken) {
          status.textContent = event.results[event.results.length - 1].isFinal ? 'Voice captured' : `Hearing: ${spoken}`;
          finalTranscript = spoken;
        }
      };
      recognition.onerror = (event) => {
        assistError('OpenAI/voice error', { type: 'speech-recognition', error: event.error });
        setError(`Voice capture failed: ${event.error}. You can type the same prompt below.`);
      };
      recognition.onend = () => {
        recognizing = false;
        root.classList.remove('gaia-assist--listening');
        assistLog('recording stopped', { hasTranscript: Boolean(finalTranscript) });
        if (finalTranscript) {
          sendPrompt(finalTranscript, 'voice', 'voice');
        } else {
          status.textContent = 'No speech captured';
        }
      };

      recognition.start();
    }

    orb.addEventListener('click', () => setOpen(panel.hidden));
    close.addEventListener('click', () => setOpen(false));
    mic.addEventListener('click', startVoicePrompt);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const prompt = promptInput.value;
      promptInput.value = '';
      sendPrompt(prompt, 'typed', 'text');
    });
    chips.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        const item = suggestionMap.find((entry) => entry.intent === button.dataset.intent) || suggestionMap[0];
        sendPrompt(item.label, item.intent, 'quick-action');
      });
    });

    document.querySelectorAll('[data-gaia-open-assist]').forEach((button) => {
      button.addEventListener('click', () => setOpen(true));
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initCoachMark();
    initSplashSteps();
    initCommunityTabs();
    initGaiaAssist();
  });
})();
