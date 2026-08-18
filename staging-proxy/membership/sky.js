/**
 * Today's sky — the one thing in Gaia that needs nothing from you.
 *
 * Every other tool in the app asks for a birth date before it will say anything.
 * That is the right trade for a personal reading, and it is also a wall: a first
 * visitor gets nothing until they hand something over.
 *
 * The moon asks for nothing. It is the same for everyone, it is genuinely
 * different every day, and it is verifiable — anyone can look up and check. So
 * it can be given away freely, it earns a return visit on its own merits, and
 * the personal version is a real step up rather than a paywall on the same
 * thing.
 *
 * Computed from an ephemeris, never invented. If Gaia says the moon is 35.7%
 * lit in Scorpio, that is because it is.
 */

import { Body, Ecliptic, GeoVector, Illumination, MoonPhase, SearchMoonPhase } from 'astronomy-engine';

/**
 * The eight phases, by the moon's angle from the sun.
 *
 * The four exact moments — new, first quarter, full, last quarter — are single
 * instants, so each gets a narrow window around it and the crescents and gibbous
 * phases take the spans between. Reading "full moon" for three days either side
 * would be the comfortable lie; this is the honest division.
 */
const PHASES = [
  { key: 'new', label: 'New moon', from: 0, to: 6 },
  { key: 'waxing-crescent', label: 'Waxing crescent', from: 6, to: 84 },
  { key: 'first-quarter', label: 'First quarter', from: 84, to: 96 },
  { key: 'waxing-gibbous', label: 'Waxing gibbous', from: 96, to: 174 },
  { key: 'full', label: 'Full moon', from: 174, to: 186 },
  { key: 'waning-gibbous', label: 'Waning gibbous', from: 186, to: 264 },
  { key: 'last-quarter', label: 'Last quarter', from: 264, to: 276 },
  { key: 'waning-crescent', label: 'Waning crescent', from: 276, to: 354 },
  { key: 'new', label: 'New moon', from: 354, to: 360 },
];

/**
 * What each phase invites.
 *
 * Reflective rather than predictive — the same standard the rest of Gaia's
 * wellness copy holds itself to. Nothing here forecasts events or promises
 * outcomes; it offers something to do with the day.
 */
const PHASE_GUIDANCE = {
  'new': {
    theme: 'Beginning',
    invitation: 'A dark sky is a blank one. Name a single intention and keep it small enough to actually start.',
    practice: 'Write down one thing you are ready to begin. Do not plan it yet — just name it.',
  },
  'waxing-crescent': {
    theme: 'First effort',
    invitation: 'The first sliver of light. Whatever you named is asking for one concrete action, not a strategy.',
    practice: 'Take the smallest possible step toward the thing you named. Five minutes counts.',
  },
  'first-quarter': {
    theme: 'Resistance',
    invitation: 'Half lit, half dark — the point where beginnings meet friction. This is normal, not a sign to stop.',
    practice: 'Name the obstacle out loud or on paper. Decide one thing you will do about it today.',
  },
  'waxing-gibbous': {
    theme: 'Refining',
    invitation: 'Nearly full. Less about starting now and more about adjusting what is already moving.',
    practice: 'Look at something in progress and change one detail that has been quietly bothering you.',
  },
  'full': {
    theme: 'Clarity',
    invitation: 'Everything is lit, including what you have been avoiding. A good night to see clearly rather than to act.',
    practice: 'Sit with what has become obvious this month. Write it down without deciding anything yet.',
  },
  'waning-gibbous': {
    theme: 'Sharing',
    invitation: 'The light begins to withdraw. What did this cycle teach that is worth passing on?',
    practice: 'Tell one person something you learned recently. Teaching is how it settles.',
  },
  'last-quarter': {
    theme: 'Releasing',
    invitation: 'Half dark again. The question turns from what to add to what to put down.',
    practice: 'Choose one commitment, habit or open loop to end. Close it today if you can.',
  },
  'waning-crescent': {
    theme: 'Rest',
    invitation: 'Almost dark. Nothing needs to be produced from these days — this is the fallow part of the cycle.',
    practice: 'Do noticeably less than you think you should. Let the quiet be the point.',
  },
};

const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

/**
 * No sign→chakra map lives here.
 *
 * Gaia already has one, in wellness-router.js, and it is the one the birth
 * chart and the daily body point are read against. A second copy in this file
 * would be a second vocabulary for the same idea — and the moment they drifted,
 * the daily sky would quietly contradict a member's own chart.
 *
 * So this module stays purely astronomical: it reports where the moon is and
 * what phase it is in. The symbolic reading is the router's to attach.
 */

function phaseFor(angle) {
  const found = PHASES.find((p) => angle >= p.from && angle < p.to);
  return found || PHASES[0];
}

const dayKey = (date) => date.toISOString().slice(0, 10);

/**
 * Today's sky.
 *
 * `at` is injectable so this is testable against known dates rather than only
 * against whenever the suite happens to run.
 */
function todaySky({ at = new Date() } = {}) {
  const angle = MoonPhase(at);                       // 0 new, 90 first quarter, 180 full
  const phase = phaseFor(angle);
  const illumination = Illumination(Body.Moon, at).phase_fraction;
  const longitude = Ecliptic(GeoVector(Body.Moon, at, true)).elon;
  const sign = SIGNS[Math.floor(((longitude % 360) + 360) % 360 / 30)];
  const guidance = PHASE_GUIDANCE[phase.key];

  // Waxing while the moon is running from new toward full.
  const waxing = angle < 180;

  const nextFull = SearchMoonPhase(180, at, 40);
  const nextNew = SearchMoonPhase(0, at, 40);
  const daysUntil = (moment) => (moment
    ? Math.max(0, Math.round((moment.date.getTime() - at.getTime()) / 86400000))
    : null);

  return {
    ok: true,
    date: dayKey(at),
    moon: {
      phase: phase.key,
      phaseLabel: phase.label,
      // Rounded to a tenth: precise enough to visibly change day to day,
      // without implying we know it to the millimetre.
      illumination: Math.round(illumination * 1000) / 10,
      waxing,
      angle: Math.round(angle * 10) / 10,
      sign,
    },
    guidance: {
      theme: guidance.theme,
      invitation: guidance.invitation,
      practice: guidance.practice,
    },
    upcoming: {
      nextFullMoon: nextFull ? dayKey(nextFull.date) : null,
      daysToFullMoon: daysUntil(nextFull),
      nextNewMoon: nextNew ? dayKey(nextNew.date) : null,
      daysToNewMoon: daysUntil(nextNew),
    },
    // Said plainly, because the whole point is that this is checkable.
    source: 'astronomy-engine · geocentric ephemeris',
  };
}

export { todaySky, PHASES, PHASE_GUIDANCE, SIGNS, phaseFor };
