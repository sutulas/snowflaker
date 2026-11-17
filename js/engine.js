/*
 * Snowflakings engine — geometry of the folded wedge and the "cut & unfold" simulation.
 *
 * Model space: the folded paper is a 30° wedge with its point (the centre of the
 * original square) at the origin. Edge A runs straight up (+y), edge B sits 30°
 * clockwise from it. Radius 1 == half the side of the original square.
 *
 * Folding a square diagonally, in half, then in thirds stacks 12 layers. When you
 * unfold, every other layer is a mirror image, so the flake has 6 mirror axes.
 */
(function (global) {
  'use strict';

  const WEDGE = Math.PI / 6;           // 30°
  const COS30 = Math.cos(WEDGE);
  const SIN30 = Math.sin(WEDGE);
  const UB = [SIN30, COS30];           // unit vector along edge B

  // Outer trim shapes (the straight snip across the top in step 5).
  // `size` is the outermost radius of the finished flake (0..1).
  const TRIMS = {
    flat:  { label: 'Hexagon',      spec: s => ({ kind: 'line', ra: s * COS30, rb: s }) },
    point: { label: 'Hexagon (pointy)', spec: s => ({ kind: 'line', ra: s, rb: s * COS30 }) },
    star:  { label: 'Star',         spec: s => ({ kind: 'line', ra: s, rb: s * 0.6 }) },
    round: { label: 'Round',        spec: s => ({ kind: 'arc', r: s }) },
  };

  function trimSpec(trim) {
    return (TRIMS[trim.shape] || TRIMS.flat).spec(trim.size);
  }

  /** Polygon (model coords) of the paper left after the outer trim. */
  function paperOutline(trim, arcSteps = 64) {
    const t = trimSpec(trim);
    if (t.kind === 'line') {
      return [[0, 0], [0, t.ra], [t.rb * UB[0], t.rb * UB[1]]];
    }
    const pts = [[0, 0]];
    for (let i = 0; i <= arcSteps; i++) {
      const a = (i / arcSteps) * WEDGE;
      pts.push([t.r * Math.sin(a), t.r * Math.cos(a)]);
    }
    return pts;
  }

  /** Full radius-1 sector (the folded stack before trimming). */
  function sectorOutline(r = 1, steps = 48) {
    const pts = [[0, 0]];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * WEDGE;
      pts.push([r * Math.sin(a), r * Math.cos(a)]);
    }
    return pts;
  }

  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function closestOnSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1e-12;
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return [a[0] + t * dx, a[1] + t * dy];
  }

  function closestOnPoly(p, poly) {
    let best = null, bd = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const q = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = q; }
    }
    return { point: best, dist: bd };
  }

  // ---------------------------------------------------------------------------
  // Raster simulation
  // ---------------------------------------------------------------------------

  const MS = 1400;                       // mask pixels per model unit
  const PAD = 6;
  const MW = Math.ceil(0.5 * MS) + 2 * PAD;
  const MH = Math.ceil(1.0 * MS) + 2 * PAD;
  const KERF = 0.0055;                   // width of a scissor cut, model units

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = MW;
  maskCanvas.height = MH;
  const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  const mask = new Uint8Array(MW * MH);
  // Paper removed by filled cut-outs (so we can count those pieces too)
  const fillCanvas = document.createElement('canvas');
  fillCanvas.width = MW;
  fillCanvas.height = MH;
  const fctx = fillCanvas.getContext('2d', { willReadFrequently: true });
  const fillMask = new Uint8Array(MW * MH);
  let hasFill = false;

  const mx = x => x * MS + PAD;
  const my = y => (1 - y) * MS + PAD;

  /** Rasterise the trimmed wedge with every cut removed. Returns Uint8Array (1 = paper). */
  function renderMask(strokes, trim) {
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, MW, MH);
    mctx.fillStyle = '#fff';
    mctx.beginPath();
    paperOutline(trim, 256).forEach(([x, y], i) => (i ? mctx.lineTo(mx(x), my(y)) : mctx.moveTo(mx(x), my(y))));
    mctx.closePath();
    mctx.fill();

    mctx.globalCompositeOperation = 'destination-out';
    mctx.strokeStyle = '#000';
    mctx.lineWidth = KERF * MS;
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    for (const s of strokes) {
      if (!s.pts || s.pts.length < 2) continue;
      mctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? mctx.lineTo(mx(x), my(y)) : mctx.moveTo(mx(x), my(y))));
      if (s.closed) mctx.closePath();
      if (s.fill && s.closed) mctx.fill();   // filled cut-out: the whole region is removed
      mctx.stroke();
    }
    mctx.globalCompositeOperation = 'source-over';

    const data = mctx.getImageData(0, 0, MW, MH).data;
    for (let i = 0, j = 3; i < mask.length; i++, j += 4) mask[i] = data[j] > 127 ? 1 : 0;
    // Regions removed by filled cut-outs: paper (inside the trim) ∩ fills
    const fills = strokes.filter(s => s.fill && s.closed && s.pts.length > 2);
    hasFill = fills.length > 0;
    if (hasFill) {
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      fctx.globalCompositeOperation = 'source-over';
      fctx.clearRect(0, 0, MW, MH);
      fctx.fillStyle = '#fff';
      for (const s of fills) {
        fctx.beginPath();
        s.pts.forEach(([x, y], i) => (i ? fctx.lineTo(mx(x), my(y)) : fctx.moveTo(mx(x), my(y))));
        fctx.closePath();
        fctx.fill();
      }
      fctx.globalCompositeOperation = 'destination-in';
      fctx.beginPath();
      paperOutline(trim, 256).forEach(([x, y], i) => (i ? fctx.lineTo(mx(x), my(y)) : fctx.moveTo(mx(x), my(y))));
      fctx.closePath();
      fctx.fill();
      const fd = fctx.getImageData(0, 0, MW, MH).data;
      for (let i = 0, j = 3; i < fillMask.length; i++, j += 4) fillMask[i] = fd[j] > 127 ? 1 : 0;
    }
    return mask;
  }

  /**
   * Lookup table: for each pixel of an N×N unfolded flake, which mask pixel it
   * comes from (or -1 if outside the paper's radius). Folding the angle into
   * 0..30° with alternating mirrors is exactly what unfolding does.
   */
  function buildLUT(N) {
    const R = N / 2 - 4;
    const lut = new Int32Array(N * N);
    const W2 = 2 * WEDGE;
    for (let j = 0; j < N; j++) {
      const dy = N / 2 - (j + 0.5);
      for (let i = 0; i < N; i++) {
        const dx = i + 0.5 - N / 2;
        const r = Math.hypot(dx, dy) / R;
        const k = j * N + i;
        if (r > 1) { lut[k] = -1; continue; }
        let th = Math.atan2(dx, dy);        // clockwise from "up"
        if (th < 0) th += 2 * Math.PI;
        let m = th % W2;
        if (m > WEDGE) m = W2 - m;
        const x = r * Math.sin(m), y = r * Math.cos(m);
        lut[k] = Math.round(my(y)) * MW + Math.round(mx(x));
      }
    }
    return { N, R, lut };
  }

  /**
   * Unfold the mask and split the paper into connected pieces (4-connectivity),
   * the same way a real cut-out falls apart.
   */
  function simulate(maskArr, L) {
    const { N, lut } = L;
    const total = N * N;
    const labels = new Int32Array(total);       // 0 = no paper
    const paper = new Uint8Array(total);
    for (let k = 0; k < total; k++) {
      const m = lut[k];
      paper[k] = m >= 0 && maskArr[m] ? 1 : 0;
    }
    const sizes = [0];
    const firstPixel = [-1];
    const stack = new Int32Array(total);
    let next = 1;
    for (let k = 0; k < total; k++) {
      if (!paper[k] || labels[k]) continue;
      const id = next++;
      let sp = 0, count = 0;
      stack[sp++] = k;
      labels[k] = id;
      while (sp) {
        const p = stack[--sp];
        count++;
        const x = p % N;
        if (x > 0 && paper[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
        if (x < N - 1 && paper[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
        if (p >= N && paper[p - N] && !labels[p - N]) { labels[p - N] = id; stack[sp++] = p - N; }
        if (p < total - N && paper[p + N] && !labels[p + N]) { labels[p + N] = id; stack[sp++] = p + N; }
      }
      sizes.push(count);
      firstPixel.push(k);
    }
    let largest = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > (sizes[largest] || 0)) largest = i;
    // Count the separate regions removed by filled cut-outs (each is a piece that falls out)
    let removed = 0;
    if (hasFill) {
      const seen = new Uint8Array(total);
      for (let k = 0; k < total; k++) {
        const m = lut[k];
        seen[k] = m >= 0 && fillMask[m] && !paper[k] ? 1 : 0;
      }
      for (let k = 0; k < total; k++) {
        if (seen[k] !== 1) continue;
        removed++;
        let sp = 0, area = 0;
        stack[sp++] = k; seen[k] = 2;
        while (sp) {
          const p = stack[--sp];
          area++;
          const x = p % N;
          if (x > 0 && seen[p - 1] === 1) { seen[p - 1] = 2; stack[sp++] = p - 1; }
          if (x < N - 1 && seen[p + 1] === 1) { seen[p + 1] = 2; stack[sp++] = p + 1; }
          if (p >= N && seen[p - N] === 1) { seen[p - N] = 2; stack[sp++] = p - N; }
          if (p < total - N && seen[p + N] === 1) { seen[p + N] = 2; stack[sp++] = p + N; }
        }
        if (area < 30) removed--;          // ignore anti-aliasing specks
      }
    }
    return { labels, sizes, firstPixel, largest, count: next - 1, removed };
  }

  // ---------------------------------------------------------------------------
  // Stroke helpers
  // ---------------------------------------------------------------------------

  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const q = closestOnSegment(pts[i], pts[a], pts[b]);
        const d = Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function circlePts(cx, cy, r, n = 72) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  /**
   * If an open cut ends just short of the paper edge, extend it a hair past the
   * edge — otherwise a sliver of paper would hold the piece on.
   */
  function snapEndpoints(stroke, trim, tol = 0.022) {
    if (stroke.closed || stroke.pts.length < 2) return stroke;
    const poly = paperOutline(trim, 128);
    const fix = (p) => {
      if (!pointInPoly(p, poly)) return p;
      const { point, dist } = closestOnPoly(p, poly);
      if (dist > tol || dist < 1e-9) return p;
      const nx = (point[0] - p[0]) / dist, ny = (point[1] - p[1]) / dist;
      return [point[0] + nx * 0.008, point[1] + ny * 0.008];
    };
    const pts = stroke.pts.slice();
    pts[0] = fix(pts[0]);
    pts[pts.length - 1] = fix(pts[pts.length - 1]);
    return { ...stroke, pts };
  }

  global.Engine = {
    WEDGE, COS30, SIN30, UB, TRIMS, KERF,
    trimSpec, paperOutline, sectorOutline, pointInPoly, closestOnPoly,
    renderMask, buildLUT, simulate, simplify, circlePts, snapEndpoints,
  };
})(window);
