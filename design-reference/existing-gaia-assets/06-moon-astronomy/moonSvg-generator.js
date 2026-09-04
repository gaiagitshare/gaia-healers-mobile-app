/* EXTRACTED COPY (reference only) — the live original is gaia-sky.js.
   Draws the moon to its ACTUAL phase: two circles, the lit disc plus a
   shadow ellipse whose horizontal radius is the terminator. Real astronomy,
   not stock art — this is a Gaia Healers original worth preserving. */

function moonSvg(illumination, waxing, tint) {
    const R = 42;
    // Clamped through a NaN check, not just a range: Math.min/max propagate NaN
    // rather than clipping it, so a malformed payload would reach the SVG as
    // rx="NaN" and the moon would silently fail to draw at all.
    const raw = Number(illumination) / 100;
    const f = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    // Terminator offset: 0 at half moon, ±R at new and full.
    const rx = Math.max(0.01, Math.abs(1 - 2 * f) * R);
    // Past half the ellipse is painted light rather than dark, so it spills the
    // lit side over the terminator instead of biting into it.
    const gibbous = f > 0.5;

    return '<svg class="g-sky__moon" viewBox="0 0 100 100" role="img"'
      + ' aria-label="' + esc(Math.round(f * 100) + '% illuminated') + '">'
      + '<defs>'
      + '<radialGradient id="gSkyGlow" cx="50%" cy="50%" r="50%">'
      + '<stop offset="60%" stop-color="' + esc(tint) + '" stop-opacity="0.35"/>'
      + '<stop offset="100%" stop-color="' + esc(tint) + '" stop-opacity="0"/>'
      + '</radialGradient>'
      + '<clipPath id="gSkyDisc"><circle cx="50" cy="50" r="' + R + '"/></clipPath>'
      + '</defs>'
      + '<circle cx="50" cy="50" r="49" fill="url(#gSkyGlow)"/>'
      + '<circle cx="50" cy="50" r="' + R + '" class="g-sky__moon-dark"/>'
      + '<g clip-path="url(#gSkyDisc)">'
      // The lit half, then the shadow ellipse carving the terminator across it.
      + '<path class="g-sky__moon-lit" d="M50 8 A ' + R + ' ' + R + ' 0 0 '
      + (waxing ? '1' : '0') + ' 50 92 Z"/>'
      + '<ellipse class="' + (gibbous ? 'g-sky__moon-lit' : 'g-sky__moon-dark') + '"'
      + ' cx="50" cy="50" rx="' + rx.toFixed(2) + '" ry="' + R + '"/>'
      + '</g>'
      + '<circle cx="50" cy="50" r="' + R + '" class="g-sky__moon-rim"/>'
      + '</svg>';
  }