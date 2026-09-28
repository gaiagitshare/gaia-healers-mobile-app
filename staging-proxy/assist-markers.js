/**
 * GAIA ASSIST — hidden save codes in a streamed answer.
 *
 * The text prompt asks the model to end a reply with <<REMEMBER: …>> (a fact
 * about the member worth keeping) or <<ONBOARD step=… | SELECTIONS: … |
 * complete=…>> (a survey answer). The non-streamed route strips and runs them.
 * The streamed route — the one the chat panel uses first — did neither: the
 * codes were shown in the bubble and read aloud, and nothing was ever saved
 * (data/assist-memory.json held no member at all).
 *
 * A streamed reply arrives in pieces, and a code can be split anywhere:
 * "…first. <<REMEM" + "BER: likes breathing ;; wants Silver>>". So text is
 * released only up to where a code might begin, and a code is dropped whole
 * once its closing ">>" arrives. The full raw reply is kept for the server to
 * run the codes once the stream ends.
 */
export function createMarkerFilter() {
  let pending = '';
  return {
    /** Feed a streamed piece; returns the text that is safe to show now. */
    push(piece) {
      pending += String(piece || '');
      let out = '';
      for (;;) {
        const start = pending.indexOf('<<');
        if (start < 0) {
          // A lone "<" at the very end may be the first half of "<<".
          if (pending.endsWith('<')) { out += pending.slice(0, -1); pending = '<'; } else { out += pending; pending = ''; }
          return out;
        }
        out += pending.slice(0, start);
        const end = pending.indexOf('>>', start + 2);
        if (end < 0) { pending = pending.slice(start); return out; } // wait for the rest of the code
        pending = pending.slice(end + 2);                             // drop the whole code
      }
    },
    /** End of stream: release what is left, minus an unfinished code. */
    flush() {
      const rest = pending.startsWith('<<') ? '' : pending;
      pending = '';
      return rest;
    },
  };
}
