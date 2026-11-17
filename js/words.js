/*
 * Snowflaker words — spell a word along a fold so it appears six times.
 *
 * Only letters that are symmetric top-to-bottom work: we draw the TOP half of
 * each letter with its midline on fold edge A, and unfolding mirrors in the
 * bottom half. Letters are rotated so the word reads from the tip of the spoke
 * toward the centre, and a thin paper bar along the letters' tops holds them on.
 *
 * Letter space: u runs along the reading direction, v runs from the letter's
 * midline (v = 0, on the fold) up to its cap line (v = 1). Each glyph is a list
 * of NEGATIVE shapes (closed cuts). Overlapping cuts are fine: everything inside
 * any closed cut falls out.
 */
(function (global) {
  'use strict';
  const E = global.Engine;

  const T = 0.3;       // stroke thickness (fraction of half-height)
  const EXT = 0.18;    // how far cuts extend past the fold so they open cleanly
  const D = 0.03;      // small overlap so neighbouring cuts merge
  const GAP = 0.26;    // space between letters
  const PAD = 0.32;    // open space before the first / after the last letter
  const BAR = 0.2;     // thickness of the paper bar that holds the letters
  const WIN = 0.34;    // height of the window cut behind the bar
  const BAR_FILL = 0.13; // 'fill' mode: thin bar between the letter tops and fold B (doubles when unfolded)
  const MAX_LETTERS = 7;
  const M = 0.025;     // keep clear of the paper edge (model units)
  const RMIN = 0.085;  // radius of solid paper left at the very centre
  const HMIN = 0.018;  // smallest letter half-height we'll lay out (model units ≈ 0.15″ letters on 8.5″ paper)

  function arc(cx, cy, r, a0, a1, n = 10) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }
  const rect = (u0, v0, u1, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  const H = Math.PI / 2, P = Math.PI;

  /** Region above a rounded corner, between the curve and the cap line. */
  function cornerTL(u0, top, r) { // top-left corner of a shape whose left edge is u0
    return [[u0 - D, top - r], [u0, top - r], ...arc(u0 + r, top - r, r, P, H), [u0 + r, top + D], [u0 - D, top + D]];
  }
  function cornerTR(u1, top, r) {
    return [[u1 - r, top + D], ...arc(u1 - r, top - r, r, H, 0), [u1 + D, top - r], [u1 + D, top + D]];
  }
  /** Shape with flat top, rounded top corners and sides running down past the fold. */
  function halfRounded(u0, u1, top, rl, rr) {
    const pts = [[u0, -EXT]];
    if (rl > 0) pts.push(...arc(u0 + rl, top - rl, rl, P, H)); else pts.push([u0, top]);
    if (rr > 0) pts.push(...arc(u1 - rr, top - rr, rr, H, 0)); else pts.push([u1, top]);
    pts.push([u1, -EXT]);
    return pts;
  }

  const GLYPHS = {
    I: { w: 0.34, cuts: () => [] },
    H: { w: 1.0, cuts: w => [rect(T, T / 2, w - T, 1 + D)] },
    E: { w: 0.86, cuts: w => [rect(T, T / 2, w + D, 1 - T)] },
    O: {
      w: 1.12,
      cuts: w => {
        const R = 0.32;
        return [halfRounded(T, w - T, 1 - T, R - T * 0.6, R - T * 0.6), cornerTL(0, 1, R), cornerTR(w, 1, R)];
      },
    },
    C: {
      w: 1.04,
      cuts: w => {
        const R = 0.32;
        return [
          halfRounded(T, w - T, 1 - T, R - T * 0.6, R - T * 0.6),
          cornerTL(0, 1, R), cornerTR(w, 1, R),
          rect(w / 2, -EXT, w + D, 0.42),               // open mouth on the right
        ];
      },
    },
    D: {
      w: 1.08,
      cuts: w => {
        const R = 0.55;
        return [halfRounded(T, w - T, 1 - T, 0, R - T * 0.6), cornerTR(w, 1, R)];
      },
    },
    B: {
      w: 0.98,
      cuts: w => {
        const R = 0.4, ri = R - T * 0.6;
        // Counter: a closed hole between the mid bar and the top bar
        const counter = [[T, T / 2], ...arc(w - T - ri, T / 2 + ri, ri, -H, 0), ...arc(w - T - ri, 1 - T - ri, ri, 0, H), [T, 1 - T]];
        // Notch at the fold that becomes the waist of the B once mirrored
        const waist = [[w + D, -EXT], [w - R, -EXT], [w - R, 0], ...arc(w - R, R, R, -H, 0), [w + D, R]];
        return [counter, cornerTR(w, 1, R), waist];
      },
    },
    K: {
      w: 1.0,
      cuts: w => {
        const d = T * 1.25;
        return [
          [[T, 0.16], [T, 1 + D], [w - d, 1 + D]],
          [[T + d, -EXT], [w + D, -EXT], [w + D, 1 + D], [w, 1 + D], [T + d, 0]],
        ];
      },
    },
    X: {
      w: 1.12,
      cuts: w => {
        const d = T * 1.25, m = w / 2, v0 = d / (w - d);
        return [
          [[d, 1 + D], [w - d, 1 + D], [m, v0 + 0.02]],
          [[-D, -EXT], [m - d / 2, -EXT], [m - d / 2, 0], [0, 1], [-D, 1 + D]],
          [[w + D, -EXT], [m + d / 2, -EXT], [m + d / 2, 0], [w, 1], [w + D, 1 + D]],
        ];
      },
    },
    t: { // a cross: stem plus a crossbar on the midline
      w: 0.9,
      cuts: w => [rect(-D, T / 2, w / 2 - T / 2, 1 + D), rect(w / 2 + T / 2, T / 2, w + D, 1 + D)],
    },
  };
  GLYPHS.l = GLYPHS.I;

  /** Letters that are symmetric top-to-bottom, as typed by the user → glyph key. */
  const ALLOWED = { B: 'B', C: 'C', D: 'D', E: 'E', H: 'H', I: 'I', K: 'K', O: 'O', X: 'X', l: 'l', L: 'l', t: 't', T: 't' };
  const ALLOWED_DISPLAY = ['B', 'C', 'D', 'E', 'H', 'I', 'K', 'O', 'X', 'l', 't'];

  /** Normalise user input → { letters, rejected } */
  function normalise(text) {
    const letters = [], rejected = [];
    for (const ch of text) {
      if (ch === ' ') continue;
      const key = ALLOWED[ch] || ALLOWED[ch.toUpperCase()];
      if (key) letters.push(key);
      else rejected.push(ch);
    }
    return { letters: letters.slice(0, MAX_LETTERS), rejected: [...new Set(rejected)] };
  }

  /** Lay the word out in letter space; returns { cuts, length }. */
  function glyphRun(letters, frame, edge) {
    const cuts = [];
    const spans = [];
    let u = 0;
    letters.forEach((ch, i) => {
      const g = GLYPHS[ch];
      spans.push([u, u + g.w]);
      for (const poly of g.cuts(g.w)) cuts.push(poly.map(([a, b]) => [a + u, b]));
      u += g.w;
      if (i < letters.length - 1) {
        cuts.push(rect(u - D, -EXT, u + GAP + D, 1 + D * 0));
        u += GAP;
      }
    });
    const L = u;
    // Open space before the first letter. In edge mode it runs out past the trim,
    // so the snowflake's edge is the first letter's edge.
    if (!edge) cuts.push(rect(-PAD, -EXT, 0 + D, 1));   // edge mode adds this after layout
    // …and after the last letter
    cuts.push(rect(L - D, -EXT, L + PAD, 1));
    // Window behind the bar so the bar is a thin strip holding the word
    // (in edge mode it's added after layout, once we know where the edge falls)
    if (frame && !edge) cuts.push(rect(-PAD, 1 + BAR, L + PAD, 1 + BAR + WIN));
    return { cuts, length: L, spans };
  }

  /**
   * Which line of the word must fit inside the paper. Normally the whole frame's
   * outer end (with a margin); in edge mode just half of the first letter's outer
   * stroke — the trim crops the rest, so the first letter's edge IS the flake's edge.
   */
  function outerSpec(edge, depth, fill) {
    const am = fill ? 0.004 : 0.05;   // angular clearance from fold B (fill mode lets the bar sit on the fold)
    return edge ? { edge, am, uOut: T / 2, vOut: 1, margin: 0 } : { edge, am, uOut: -PAD, vOut: depth, margin: M };
  }

  /** Split long edges so straight letter-space lines can curve when slanted. */
  function densify(poly, step = 0.05) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    return out;
  }

  /** Distance from p to the trimmed top edge only (outline minus both fold edges). */
  function distToTrim(p, poly) {
    let best = Infinity;
    for (let i = 1; i < poly.length - 1; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1e-12;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
    }
    return best;
  }

  /**
   * Straight layout: letters in a strip of constant height along fold A.
   * Returns a map letter-space → model, plus letter sizes, or null if it can't fit.
   */
  function layoutStraight(span, depth, outline, scale, ec) {
    const tan = Math.tan(E.WEDGE);
    const okOut = p => E.pointInPoly(p, outline) && distToTrim(p, outline) >= ec.margin;
    const topFor = S => {
      const shift = (ec.uOut + PAD) * S;
      for (let y = 1.05; y > 0; y -= 0.002) {
        let good = true;
        for (let j = 1; j <= 8 && good; j++) good = okOut([(ec.vOut * j / 8) * S + (ec.edge ? 0 : M), y - shift]);
        if (good) return y;
      }
      return 0;
    };
    const fits = S => {
      const y0 = topFor(S);
      const y1 = y0 - span * S;
      return y1 > 0 && depth * S + (ec.am > 0.01 ? M : 0.004) <= y1 * tan;
    };
    let lo = 0.004, hi = 0.3;
    if (!fits(lo)) return null;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    const S = lo * scale;
    const y0 = topFor(lo);                         // keep the word out at the tip
    return { map: ([u, v]) => [v * S, y0 - (u + PAD) * S], halfHeightAt: () => S };
  }

  /**
   * Slanted layout: a conformal (log-polar) map around a vanishing point P on the
   * fold line below the centre. Letters keep their proportions but shrink toward
   * the centre, and their cap line runs along a ray from P. With P at the centre
   * (slant = 1) the letters follow the snowflake's own angle exactly.
   */
  function layoutSlanted(span, depth, outline, slant, scale, ec) {
    const d = slant >= 0.999 ? 0 : 0.6 * (1 / slant - 1);
    const at = (rho, th) => [rho * Math.sin(th), -d + rho * Math.cos(th)];
    // Inside the paper, clear of the trimmed edge, and a few degrees clear of fold B
    const angleOk = p => Math.atan2(p[0], p[1]) <= E.WEDGE - ec.am;
    const ok = p => E.pointInPoly(p, outline) && distToTrim(p, outline) >= M && angleOk(p);
    const okOut = p => E.pointInPoly(p, outline) && distToTrim(p, outline) >= ec.margin && angleOk(p);
    const rayOk = (u, p) => (ec.edge && u < 1 ? angleOk(p) : ok(p));   // edge mode: trim may crop the first letter's frame
    const N = 10;

    // Largest start radius (around P) whose outer edge still fits on the paper
    const fitRho0 = c => {
      const thOut = c * ec.vOut;
      const arcOk = rho => { for (let k = 1; k <= N; k++) if (!okOut(at(rho, (thOut * k) / N))) return false; return true; };
      // Walk inward from beyond the paper until the arc fits, then refine.
      let hi = d + 1.05, lo = 0;
      for (let r = hi; r > d + 0.02; r -= 0.01) if (arcOk(r)) { lo = r; break; }
      if (!lo) return 0;
      hi = lo + 0.01;
      for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (arcOk(mid)) lo = mid; else hi = mid; }
      return lo * Math.exp(c * (ec.uOut + PAD));   // radius found is at u = uOut; convert to u = -PAD
    };
    const check = (c, needMin) => {
      const thMax = c * depth;
      if (thMax >= E.WEDGE) return null;
      const rho0 = fitRho0(c);
      if (!rho0) return null;
      const rho1 = rho0 * Math.exp(-c * span);
      if (needMin && Math.hypot(...at(rho1, 0)) < RMIN) return null;               // keep a solid paper hub at the centre
      for (let k = 1; k <= N; k++) if (!ok(at(rho1, (thMax * k) / N))) return null;
      for (let j = 0; j <= 24; j++) if (!rayOk((span * j) / 24 - PAD, at(rho0 * Math.exp((-c * span * j) / 24), thMax))) return null;
      if (needMin && c * rho0 * Math.exp(-c * (span - PAD)) < HMIN) return null;   // last letter big enough to cut
      return { c, rho0 };
    };
    const cMax = (E.WEDGE - ec.am) / depth;
    let best = null;
    for (let i = 0; i < 240 && !best; i++) best = check(cMax * (1 - i / 240), true);
    if (!best) return null;
    let { c, rho0 } = best;
    if (scale < 1) {
      c *= scale;
      rho0 = fitRho0(c) || rho0;
    }
    return {
      map: ([u, v]) => at(rho0 * Math.exp(-c * (u + PAD)), c * v),
      halfHeightAt: u => c * rho0 * Math.exp(-c * (u + PAD)),
    };
  }

  /**
   * Tapered layout with straight lines. Letter sizes follow the same smooth
   * progression as the curved layout, but each letter (and each gap) gets its own
   * perspective taper, so every straight edge in a letter stays a straight line.
   * The cap line is a straight ray from the vanishing point P = (0, -d), and the
   * ends of each letter stay square to the fold.
   *
   * At the cell boundaries:  ρ = ρ0 · e^(−k·(u + PAD))
   * Inside a cell, 1/ρ is linear in u (a projective map):  y = ρ − d,  x = k · v · ρ
   */
  function layoutTapered(span, depth, outline, slant, scale, breaks, ec) {
    const d = slant >= 0.999 ? 0 : 0.6 * (1 / slant - 1);
    const angleOk = p => Math.atan2(p[0], p[1]) <= E.WEDGE - ec.am;
    const ok = p => E.pointInPoly(p, outline) && distToTrim(p, outline) >= M && angleOk(p);
    const okOut = p => E.pointInPoly(p, outline) && distToTrim(p, outline) >= ec.margin && angleOk(p);
    const rayOk = (u, p) => (ec.edge && u < 1 ? angleOk(p) : ok(p));
    const N = 10;
    const U0 = -PAD, U1 = span - PAD;
    const cells = [...new Set([U0, ...breaks, ...(ec.edge ? [ec.uOut] : []), U1])].sort((a, b) => a - b);
    const rhoAt = (k, rho0, u) => {
      const law = x => rho0 * Math.exp(-k * (x - U0));
      if (u < U0) return law(u);                     // beyond the paper; shape doesn't matter
      let i = 0;
      while (i < cells.length - 2 && u > cells[i + 1]) i++;
      const a = cells[i], b = cells[i + 1];
      const t = (u - a) / (b - a);
      return 1 / (1 / law(a) + t * (1 / law(b) - 1 / law(a)));
    };
    const at = (k, rho, v) => [k * v * rho, rho - d];
    const fitRho0 = k => {
      const edgeOk = r => { for (let j = 1; j <= N; j++) if (!okOut(at(k, r, (ec.vOut * j) / N))) return false; return true; };
      let hi = d + 1.05, lo = 0;
      for (let r = hi; r > d + 0.02; r -= 0.01) if (edgeOk(r)) { lo = r; break; }
      if (!lo) return 0;
      hi = lo + 0.01;
      for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (edgeOk(mid)) lo = mid; else hi = mid; }
      return lo * Math.exp(k * (ec.uOut + PAD));     // uOut is a cell break, so this is exact
    };
    const check = (k, needMin) => {
      const rho0 = fitRho0(k);
      if (!rho0) return null;
      const rho1 = rho0 * Math.exp(-k * span);
      for (let j = 1; j <= N; j++) if (!ok(at(k, rho1, (depth * j) / N))) return null;
      for (const u of cells) if (!rayOk(u, at(k, rhoAt(k, rho0, u), depth))) return null;
      if (needMin && rho1 - d < RMIN) return null;                                    // solid hub at the centre
      if (needMin && k * rho0 * Math.exp(-k * (span - PAD)) < HMIN) return null;       // last letter big enough
      return { k, rho0 };
    };
    const kMax = Math.tan(E.WEDGE - ec.am) / depth;
    let best = null;
    for (let i = 0; i < 240 && !best; i++) best = check(kMax * (1 - i / 240), true);
    if (!best) return null;
    let { k, rho0 } = best;
    if (scale < 1) {
      k *= scale;
      rho0 = fitRho0(k) || rho0;
    }
    return {
      map: ([u, v]) => at(k, rhoAt(k, rho0, u), v),
      halfHeightAt: u => k * rhoAt(k, rho0, u),
    };
  }

  /**
   * Fit the word on fold edge A as large as the paper allows (times `scale`),
   * and return cut strokes in model space.
   */
  function build(text, trim, opts = {}) {
    const { letters } = normalise(text);
    if (!letters.length) return { strokes: [], letters, fits: true };
    const fill = !!opts.fill;
    const frame = !fill && opts.frame !== false;
    const barT = fill ? BAR_FILL : BAR;
    const slant = Math.max(0, Math.min(1, opts.slant ?? 0));
    const scale = Math.max(0.3, Math.min(1, opts.scale ?? 1));
    const edge = !!opts.edge;
    const depth = 1 + (frame ? barT + WIN : barT);   // away from the fold, letter units
    const ec = outerSpec(edge, depth, fill);
    const { cuts, length, spans } = glyphRun(letters, frame, edge);
    const span = length + 2 * PAD;                 // along the spoke, letter units
    const outline = E.paperOutline(trim, 128);

    const curved = slant > 0.001 && opts.style !== 'straight';
    const lay = slant <= 0.001 ? layoutStraight(span, depth, outline, scale, ec)
      : curved ? layoutSlanted(span, depth, outline, slant, scale, ec)
      : layoutTapered(span, depth, outline, slant, scale, spans.flat(), ec);
    if (!lay) return { strokes: [], letters, fits: false };

    // Edge mode: clear everything between the first letter and the trim, reaching
    // just past the paper's edge (no further, so the editor stays tidy).
    if (edge) {
      let u = 0;
      const outside = uu => { for (let j = 0; j <= 10; j++) if (E.pointInPoly(lay.map([uu, -EXT + ((1 + EXT) * j) / 10]), outline)) return false; return true; };
      while (u > -2 && !outside(u)) u -= 0.05;
      cuts.push(rect(u - 0.1, -EXT, 0 + D, 1));
    }

    // Edge mode: start the window just inside the trim, leaving a paper bridge so
    // the bar stays attached at the outer end too.
    if (edge && frame) {
      const clear = p => E.pointInPoly(p, outline) && distToTrim(p, outline) >= M;
      for (let u = 0; u < length; u += 0.03) {
        if (clear(lay.map([u, 1 + BAR])) && clear(lay.map([u, depth])) && clear(lay.map([u, 1 + BAR + WIN / 2]))) {
          cuts.push(rect(u, 1 + BAR, length + PAD, 1 + BAR + WIN));
          break;
        }
      }
    }

    const g = 'word';
    const strokes = cuts.map(poly => ({
      id: global.Editor.newId(), g, word: true, fill: true, closed: true,
      pts: (curved ? densify(poly) : poly).map(lay.map),
    }));
    // Letter heights (full height, model units) for the first and last letters
    const mid = ([a, b]) => (a + b) / 2;
    const first = 2 * lay.halfHeightAt(mid(spans[0]));
    const last = 2 * lay.halfHeightAt(mid(spans[spans.length - 1]));
    return { strokes, letters, fits: true, letterHeight: first, firstHeight: first, lastHeight: last };
  }

  global.Words = { build, normalise, ALLOWED_DISPLAY, MAX_LETTERS };
})(window);
