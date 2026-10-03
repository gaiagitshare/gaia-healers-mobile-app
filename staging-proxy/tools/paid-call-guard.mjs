/**
 * PAID-CALL GUARD — a hard, programmatic cap for any script that can reach a
 * paid API or model. Required by the project rule in AGENTS.md.
 *
 * Why it exists: on 2-3 Oct 2026 a consistency harness sent ~5,400 requests and
 * ~90 million tokens to a pay-as-you-go model account, about 99% of that
 * month's bill. Nothing stopped it because nothing counted.
 *
 * PROVIDER-INDEPENDENT BY CONSTRUCTION. It does not keep a list of paid hosts
 * that someone must remember to update. It counts EVERY outbound request to a
 * non-local host. Over-counting a free call is the safe failure; missing a new
 * paid provider is the one this rule exists to prevent.
 *
 * Two layers:
 *   1. Before anything is sent: the caller states how many paid calls it plans.
 *      Above the cap the script REFUSES and exits -- it never trims the run and
 *      carries on, and it never raises its own cap.
 *   2. While it runs: every outbound fetch is counted, and the call that would
 *      exceed the cap throws. So a wrong plan, a retry loop or a bug cannot
 *      spend past it either.
 *
 * Flags every guarded script accepts:
 *   --dry-run            print the plan and the estimate; send nothing
 *   --max-requests N     raise the cap for this run. Only after the account
 *                        owner has approved N in advance (see AGENTS.md).
 *
 * WebSocket sessions are not fetches, so a script that opens one must call
 * guard.count(url) immediately before connecting.
 */

export const DEFAULT_MAX_PAID_REQUESTS = 5;

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;

function hostOf(input) {
  try { return new URL(typeof input === 'string' ? input : input?.url ?? String(input)).hostname; }
  catch { return ''; }
}

/**
 * @param {object} opts
 * @param {string} opts.label            script name, for messages
 * @param {number} opts.planned          paid calls this run intends to make
 * @param {number} [opts.tokensPerCall]  rough input+output tokens per call, if known
 * @param {number} [opts.usdPerMillion]  rough blended price, if known
 * @param {string} [opts.why]            one line: what the run is for
 * @param {string[]} [opts.argv]
 */
export function installPaidCallGuard({
  label, planned, tokensPerCall = null, usdPerMillion = null, why = '', argv = process.argv,
}) {
  const flag = (name) => argv.includes(name);
  const value = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };

  const requested = value('--max-requests');
  const max = requested == null ? DEFAULT_MAX_PAID_REQUESTS : Number(requested);
  if (!Number.isInteger(max) || max < 1) {
    console.error(`[${label}] --max-requests must be a positive whole number`);
    process.exit(2);
  }

  const tokens = tokensPerCall ? planned * tokensPerCall : null;
  const cost = tokens && usdPerMillion ? (tokens / 1e6) * usdPerMillion : null;
  console.error(`[${label}] planned paid calls: ${planned}`
    + (tokens ? `, ~${(tokens / 1e6).toFixed(2)}M tokens` : ', tokens: unknown')
    + (cost != null ? `, ~$${cost.toFixed(2)} MINIMUM` : ', cost: unknown')
    + ` | cap: ${max}`);
  if (cost == null) {
    console.error(`[${label}] cost cannot be estimated reliably. Under the project rule that means: stop and ask before running anything above a tiny sample.`);
  }
  console.error(`[${label}] estimates are a floor: failed requests, retries and audio output can still bill.`);

  if (planned > max) {
    console.error(`\n[${label}] REFUSED: ${planned} planned paid calls exceeds the cap of ${max}.`);
    console.error(`Runs above ${DEFAULT_MAX_PAID_REQUESTS} need the account owner's explicit approval FIRST,`
      + ' with the request count, estimated tokens, minimum cost and the reason (AGENTS.md).');
    if (why) console.error(`Reason given by the script: ${why}`);
    console.error(`If approved, re-run with --max-requests ${planned}. Prefer narrowing the run instead.`);
    process.exit(2);
  }
  if (flag('--dry-run')) {
    console.error(`[${label}] dry run: nothing sent.`);
    process.exit(0);
  }

  let used = 0;
  const count = (input) => {
    const host = hostOf(input);
    if (!host || LOCAL.test(host)) return;
    used += 1;
    if (used > max) {
      throw new Error(`[${label}] paid-call cap reached (${max}); refusing call #${used} to ${host}`);
    }
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { count(input); return realFetch(input, init); };

  process.on('exit', () => {
    console.error(`[${label}] outbound non-local calls made: ${used} of cap ${max}`);
  });

  return { max, count, used: () => used };
}
