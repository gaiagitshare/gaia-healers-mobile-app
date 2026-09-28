/**
 * GAIA ASSIST — safety before selling.
 *
 * Gaia Assist is a wellness concierge with instructions to greet with offers,
 * push paid memberships and handle hesitation. Nothing told it what to do when
 * someone says they want to die, or that their chest hurts right now; the only
 * safety line was "do not diagnose". In testing, one model answered chest pain
 * by offering a breathing session.
 *
 * Two layers:
 *   1. SAFETY_FIRST goes at the top of every system prompt (text chat, Gemini
 *      Live, the Qwen relay) and says it overrides everything below it. This is
 *      the only layer live voice has: the server does not see those replies.
 *   2. detectCrisis() runs on every typed or transcribed question before any
 *      model is asked. A match gets a fixed, reviewed reply — never a model's
 *      improvisation, never a product.
 *
 * The patterns lean towards catching too much: a false positive costs one
 * careful reply; a miss can cost far more.
 */

export const SAFETY_FIRST = [
  'SAFETY FIRST — this overrides every sales, membership, event, onboarding, greeting and navigation instruction in these instructions.',
  '(1) If the person mentions suicide, wanting to die, self-harm, harming someone, abuse, or being in danger: stop all selling and app guidance. Respond warmly and without judgement, tell them they deserve support right now, and give help: in the US or Canada call or text 988 (Suicide & Crisis Lifeline); in Iran call 1480 (counselling) or 123 (social emergency); anywhere else their local emergency number or a crisis line. If they may be in immediate danger, tell them to call 911 or their local emergency number now. Encourage them to reach someone they trust, and keep listening kindly. Do not offer tools, products, sessions, events or memberships in that conversation.',
  '(2) A possible medical emergency — chest pain or pressure, trouble breathing, fainting, stroke signs (face drooping, arm weakness, slurred speech), a seizure, severe bleeding, an overdose or poisoning, a severe allergic reaction: tell them to call 911 or their local emergency number right now (115 in Iran). Nothing else first — no wellness tools.',
  '(3) Health questions: Gaia\'s tools, readings, chakras, horoscope and numerology, and devices such as Bio-Well, BioPulsar and BioTekna, are for wellness and education; they are not medical devices and do not diagnose or treat. Never diagnose, and never suggest replacing or delaying medical care, medication or a doctor. For symptoms, anything persistent or worsening, pregnancy, children, or medication questions, recommend a licensed healthcare professional.',
  '(4) Never sell to someone who is distressed, grieving, frightened or unwell. Support comes first; offer app features only if they ask.',
].join(' ');

const SELF_HARM = [
  /\b(kill(ing)? my ?self|suicid(e|al)|end(ing)? (it all|my life)|take my (own )?life|want(ed)? to die|wish (i|i'?d) (was|were|had) (dead|never been born)|don'?t want to (live|be alive|exist|wake up)|hurt(ing)? my ?self|self[- ]?harm|cut(ting)? my ?self|no reason to live|better off dead)\b/i,
  /(خودکشی|خودم ?(را|رو|و) ?بکشم|خودمو بکشم|می[‌ ]?(خواهم|خوام) بمیرم|آرزوی مرگ|به خودم آسیب|نمی[‌ ]?(خواهم|خوام) زنده (باشم|بمانم|بمونم))/,
];
const EMERGENCY = [
  /\b(chest (pain|pressure|tightness)|my chest (hurts|is tight|feels tight)|heart attack|can'?t breathe|cannot breathe|(trouble|difficulty|hard time|struggling) breathing|short(ness)? of breath|(having|had|think i'?m having) a stroke|signs? of (a )?stroke|face (is )?droop|slurred speech|passed out|fainted|unconscious|overdos(e|ed|ing)|poison(ed|ing)|(having|had) a seizure|seizing|severe bleeding|bleeding (a lot|heavily|won'?t stop)|anaphyla)/i,
  /(درد (قفسه[‌ ]?)?سینه|سینه[‌ ]?ام درد|سکته|نمی[‌ ]?(توانم|تونم) نفس بکشم|تنگی نفس|بیهوش|مسموم|اوردوز|تشنج|خونریزی شدید)/,
];

/** 'self_harm' | 'emergency' | null for one question. */
export function detectCrisis(text) {
  const t = String(text || '');
  if (SELF_HARM.some((re) => re.test(t))) return 'self_harm';
  if (EMERGENCY.some((re) => re.test(t))) return 'emergency';
  return null;
}

const PERSIAN = /[؀-ۿ]/;

/** The fixed reply for a detected crisis, in Persian when they wrote in it. */
export function crisisReply(kind, text = '') {
  const fa = PERSIAN.test(String(text));
  if (kind === 'self_harm') {
    return fa
      ? 'خیلی ممنونم که این را با من در میان گذاشتی، و واقعاً متأسفم که این‌قدر سختی می‌کشی. تو همین حالا سزاوار حمایت هستی. در ایران می‌توانی با صدای مشاور ۱۴۸۰ یا اورژانس اجتماعی ۱۲۳ تماس بگیری؛ در آمریکا و کانادا با ۹۸۸ تماس بگیر یا پیامک بزن. اگر ممکن است به خودت آسیب بزنی یا در خطر هستی، همین حالا با اورژانس (۱۱۵ در ایران، ۹۱۱ در آمریکا) تماس بگیر. اگر می‌توانی، به کسی که به او اعتماد داری خبر بده. من اینجا هستم و می‌توانیم با هم حرف بزنیم.'
      : "I'm really glad you told me, and I'm so sorry you're going through this. You deserve support right now. In the US or Canada you can call or text 988 to reach the Suicide & Crisis Lifeline at any time; anywhere else, please call your local emergency number or a crisis line. If you might act on these thoughts or you're in danger, call 911 (or your local emergency number) now. If you can, reach out to someone you trust and let them know how you're feeling. I'm here, and we can keep talking.";
  }
  return fa
    ? 'اگر این همین حالا برایت اتفاق می‌افتد، ممکن است یک وضعیت اورژانسی باشد: لطفاً فوراً با اورژانس تماس بگیر (۱۱۵ در ایران، ۹۱۱ در آمریکا، یا شماره اورژانس محل خودت) یا از کسی که نزدیکت است بخواه تماس بگیرد. ابزارهای سلامتی گایا جایگزین کمک پزشکی فوری نیستند. اگر سؤالت کلی بود، برای علائم جسمی بهترین کار مشورت با یک پزشک است.'
    : "If this is happening to you right now, it could be a medical emergency: please call 911 (or your local emergency number) immediately, or ask someone near you to call. Gaia's wellness tools are not a substitute for urgent medical care. If you were asking in general, a licensed healthcare professional is the right person for questions about symptoms.";
}
