# Gaia Assist guidance and onboarding polish review

PR #180 remains draft. All changes are in an isolated server Git worktree at `/root/gaia-onboarding-pr180`; production services, checkout and customer contacts were not changed. This pass prioritizes behavior and guidance, as requested.

## Behavior audit and changes

`staging-proxy/server.js` builds different text and voice prompts. Both included conversion-oriented greetings, upgrade suggestions for free members, and an obligatory question or next step. There was no explicit professional boundary against romantic language. This is evidence of conflicting guidance, not proof of the cause of every reported conversation.

The shared public `staging-proxy/assist-guide.js` now supplies a help-first policy and actual app vocabulary to the server and browser. Gaia answers the request first, asks follow-ups only when needed, avoids pet names/flirtation/excessive praise, limits membership discussion to relevant requests or access limitations, and does not equate interests with purchase intent. The profile review discovered a real hallucination: the existing screen has no general contact editor. Its capability definition explicitly says that name/email corrections require support and birth date belongs in Energy Check. Shop has Shop/Membership tabs, not a separate Devices tab.

Frontend routing uses the shared screen keys. Chat carries bounded navigation hints and eight recent turns, at most 6,000 characters, held only in memory. History excludes privileged roles, clears on account changes/logout, and in-flight chat is aborted. Member identity, onboarding answers and access grants still come from authenticated server context. Navigation hints cannot establish access. Qwen receives sanitized screen updates without generating another reply or replacing server policy. New voice sessions receive the active onboarding step/branch. Gemini's ongoing fallback session is not dynamically refreshed after every navigation; its next session gets fresh context.

Visual onboarding is already on screen, so Gaia gives one short contextual sentence rather than listing choices. Clicks still save deterministically; voice tools and conversational text markers remain compatible. The event context no longer interprets a missing/unavailable event response as proof that no events exist. Generic explanations can use known context instead of unnecessary live lookups; current prices, access and schedules still need verified data.

Text uses Gemini `gemini-3.6-flash` first, then Groq `qwen/qwen3.8-27b` on this server. Voice uses Qwen `qwen3.8-omni-flash-realtime` with Gemini Live fallback (`gemini-3.8-live` configured). Recorded fallback runs STT → text model → TTS; ElevenLabs `eleven_turbo_v2_5` is the preferred separate TTS model. The Gemini text output ceiling increased from 640 to 2,048 tokens (recorded voice 220 to 1,024) because live QA exposed incomplete answers; brevity remains an instruction and stream cancellation remains active. This can increase generation cost for long answers.

Eight synthetic live guidance questions were reviewed: events, Bio-Well, profile changes, next step, Water interest, courses, casual greeting and an explicit request to flirt. The final samples answered without intimate address or unsolicited membership upgrade. Profile guidance correctly identified support instead of an imaginary edit icon; next-step guidance selected one action. This is a small sampled behavioral check, not a guarantee across conversations. Before/after raw provider samples are in the gallery; markers in raw samples are hidden/executed by the existing app layer. The final onboarding sample uses an incomplete-member fixture, while the baseline fixture was complete, so those two answers are not a controlled personality comparison.

## GHL persistence and personalization verification

The authenticated contact is resolved before onboarding. Each structured answer writes the existing custom field and server-defined workflow tags, then reads the contact back to confirm both. A successful HTTP status without persisted tags is a save failure; the selected answer remains available for retry. Product ownership tags retain their existing semantics. Browser requests cannot supply arbitrary tags or field IDs.

The new `gaia_app_onboarding_started` marker is written before the first app field mutation. A started journey cannot accidentally become historically complete merely because its fields saved before a failed tag request. Resume checks required tags as well as answers for started journeys; explicit GHL form completion and valid historical completed profiles still bypass without repeating questions. Existing historical partial answers are preserved and their mapped tags are reconciled when the app journey starts.

Read-only checks against location `WkKl1K5RuZNQ60xR48k6` confirmed all 16 fields already exist. The published survey `cxEHVXROFQI0tMKQofPr` uses Client Needs field `lZimCwbcpPF330TfxdXx`, key `contact.what_are_your_clients_most_often_asking_for_right_now_select_all_that_apply`. The supplied correction pointed to another question (`wJJUthQQvLq0RZ6v16wB`); the implementation now targets the published question. That active field's metadata option list differs from the published checkbox values. Published values are preserved and this disagreement is recorded in the public verification JSON rather than modifying live field definitions. Step-specific straight/curly apostrophes are mapped exactly; conversational legacy aliases remain supported.

Assist now receives the member's saved structured choices even after completion and prefers current choices over retained historical tags when guiding Store, Energy, Academy and Community. Interest does not establish ownership, access, medical conclusions or intent to purchase. No speculative recommendation engine was added.

Contract tests compare every structured choice to its persisted field value and tags, verify tag-readback failures, started-journey resume/completion, historical partial resume, and the published survey field IDs/options. The later gate verification used two owned QA contacts to verify actual option acceptance, keyed Other Devices storage and persisted tags. See [mandatory gate proof](onboarding-gate-proof.md); downstream workflow delivery is not claimed.

## Visual implementation

CSS, lightweight inline SVG and the browser animation API provide a soft ambient field, brief intro ripples, responsive life/field/water selection pulses, tactile checks, question crossfades, branch completion acknowledgement, a moving progress point, and selected-symbol/chip completion reveal. No new animation library, video background, canvas loop or bitmap download was added. Entrance animations run on scene changes; selection updates reuse the existing DOM. Resume uses a shorter entrance. Outgoing content is inert, hidden from assistive technology and loses live control selectors. Reduced-motion disables CSS and interaction animations; buttons remain immediately usable.

48 screenshots cover 360/390/430/1280 widths. Browser QA exercises the entire branched path, save failure/retry, completion, reload bypass, resume, historical completion, visitor bypass, and embedded structured saves. It also verifies reduced motion leaves no running journey animation. The roughly 30-second recording shows intro, all three selections, branch transitions/completion, profile reveal and the three Assist orb states. Orb states in that synthetic recording are illustrations, not live microphone evidence.

## Voice measurements and practical limits

Six matched synthetic PCM turns per revision: twice each “Water”, a normal event question, and a longer explanation with pauses. Qwen was called directly from the server using the corresponding Gaia instructions and the same 900ms server-VAD configuration. The table shows median / p90 in milliseconds from the last speech sample sent. p90 is the nearest-rank maximum for this small six-turn sample.

| Boundary | Before median / p90 | After median / p90 |
|---|---:|---:|
| VAD commitment | 1194 / 1223 | 1175 / 1186 |
| Final transcript | 1340 / 1484 | 1315.5 / 1440 |
| First model content event | 1520 / 1656 | 1555.5 / 1755 |
| First received audio | 1838.5 / 2057 | 1865.5 / 2075 |

The largest measured component is VAD commitment. There is no demonstrated speed improvement. The paused explanation produced one early VAD boundary in each repeat in both revisions; it is retained in the raw results and requires acoustic turn-taking validation. No random VAD timeout change was made.

Realtime browser telemetry records observable T0 speech activation, T1 last local speech, T2 final transcript, T3 provider response-created, T4 first model content, T6 audio receipt, T7 worklet playback and tool duration without transcript logging. Enable `window.GAIA_VOICE_DEBUG = true` to print timing reports, or subscribe to the voice controller's `telemetry` event. TTS T5 is not a separate observable stage in a unified realtime model. Provider response-created is an event boundary, not an internal model execution timestamp. Late transcript arrival updates the same report. First received audio in this benchmark excludes the browser relay, microphone gate, worklet scheduling and physical speaker latency; full browser playback before/after was not measured.

The orb now uses actual microphone/output amplitude. “Speaking” begins when PCM playback starts instead of when a transcript or pending TTS request appears. Interrupt/cancel clears PCM, offsets, pending listening timers and queued duration; asynchronous PCM cannot repopulate a cancelled queue. Continuous speech barge-in remains disabled by the existing echo-protection microphone gate; safe full-duplex acoustic validation is still pending. Native realtime audio continues to stream; the recorded fallback still buffers the complete STT/model/TTS response. Phrase-streamed fallback TTS was not introduced in this guidance pass.

## Validation and reproduction

Local backend: 558 passed, 15 live integration checks skipped. Frontend: 90 passed. Added checks cover common guide policy, bounded history/context, exact capability limits, Qwen navigation refresh without a reply, and clearing interrupted stereo PCM. Existing onboarding, voice relay, text streaming, tools, safety and prompt-budget checks pass.

Run backend `npm test` in `staging-proxy`, frontend `node --test tests/*.test.cjs` in the repository root. Use `node scripts/onboarding-preview.mjs` for synthetic UI. Playwright CLI `run-code` takes the function in `scripts/onboarding-browser-qa.js`; `scripts/onboarding-motion-record.js` records the companion demonstration. The recording needs Playwright's ffmpeg binary. Export to MP4 with normal ffmpeg if desired.

Opt-in model QA: `node scripts/assist-guidance-probe.mjs --env /private/provider.env --label review --out /tmp/guidance.json`. Only provider credentials are loaded; no authenticated member/CRM reads or writes occur. Voice QA: `node staging-proxy/scripts/voice-latency-probe.mjs --env /private/provider.env --instructions /tmp/guidance.json.voice-instructions.txt --audio-dir /private/synthetic-pcm --label review --out /tmp/voice.json`. PCM files must be signed 16-bit little-endian, 16kHz mono, named `water.pcm`, `normal.pcm`, `pauses.pcm`. Inputs used here were synthesized with macOS Samantha; the long input included two 550ms pauses. Credentials are never saved in artifacts or provider error output.

Main implementation files: `staging-proxy/assist-guide.js`, `staging-proxy/server.js`, `staging-proxy/qwen-voice-relay.js`, `gaia-ui.js`, `gaia-realtime-voice.js`, `gaia-assist-v3.css`, `gaia-journey.js`, `gaia-journey.css`, `home.html`, `index.html`, `sw.js`. Tests, QA scripts, screenshots, JSON samples and this review accompany them.

See [screenshot and motion gallery](../output/playwright/onboarding/index.html) and [original onboarding/GHL review](onboarding-review.md). Visual/behavior approval, downstream workflow review, and full acoustic voice QA remain release checks. Do not merge, deploy or restart production from this draft.
