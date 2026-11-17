/*
 * Snowflaker editor — draw cuts on the folded wedge.
 * Renders into an <svg>; all geometry lives in model space (see engine.js).
 */
(function (global) {
  'use strict';
  const E = global.Engine;
  const NS = 'http://www.w3.org/2000/svg';

  const VIEW = { x0: -0.27, x1: 0.79, y0: -0.07, y1: 1.07 };

  function el(name, attrs = {}, parent) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  const d = (pts, closed) =>
    pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(5)} ${y.toFixed(5)}`).join('') + (closed ? 'Z' : '');

  const reflect = (p, u) => {
    const k = 2 * (p[0] * u[0] + p[1] * u[1]);
    return [k * u[0] - p[0], k * u[1] - p[1]];
  };

  function distToStroke(p, s) {
    let best = Infinity;
    const n = s.pts.length;
    const segs = s.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = s.pts[i], b = s.pts[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy || 1e-12;
      let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]));
    }
    return best;
  }

  let uid = 1;
  const newId = () => 's' + Date.now().toString(36) + (uid++).toString(36);

  class Editor {
    constructor(svg, store) {
      this.svg = svg;
      this.store = store;           // { state, commit(strokes), preview(extra) }
      this.tool = 'pen';
      this.layer = 'cut';
      this.showSketch = true;
      this.selected = new Set();
      this.draft = null;            // in-progress stroke
      this.drag = null;
      this.snap = true;
      this.showGhosts = true;
      this.build();
      this.bind();
      this.render();
    }

    build() {
      const s = this.svg;
      s.setAttribute('viewBox', `${VIEW.x0} ${-VIEW.y1} ${VIEW.x1 - VIEW.x0} ${VIEW.y1 - VIEW.y0}`);
      s.innerHTML = '';
      const defs = el('defs', {}, s);
      const pat = el('pattern', { id: 'hatch', width: 0.018, height: 0.018, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      el('rect', { width: 0.018, height: 0.018, fill: 'var(--excess-bg)' }, pat);
      el('line', { x1: 0, y1: 0, x2: 0, y2: 0.018, stroke: 'var(--excess-line)', 'stroke-width': 0.006 }, pat);
      const flt = el('filter', { id: 'paperShadow', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
      el('feDropShadow', { dx: 0.004, dy: 0.008, stdDeviation: 0.01, 'flood-color': '#1b2a4a', 'flood-opacity': 0.18 }, flt);

      this.world = el('g', { transform: 'scale(1,-1)' }, s);
      this.gGhostPaper = el('g', { class: 'ghost-paper' }, this.world);
      this.gExcess = el('path', { class: 'excess', fill: 'url(#hatch)' }, this.world);
      this.gLayers = el('g', { class: 'layers' }, this.world);
      this.gPaper = el('path', { class: 'paper', filter: 'url(#paperShadow)' }, this.world);
      this.gFolds = el('g', { class: 'folds' }, this.world);
      this.gGhosts = el('g', { class: 'ghost-cuts' }, this.world);
      this.gGuides = el('g', { class: 'guides' }, this.world);
      this.gStrokes = el('g', { class: 'cuts' }, this.world);
      this.gDraft = el('g', { class: 'draft' }, this.world);
      this.gSel = el('g', { class: 'selection' }, this.world);
      el('circle', { class: 'center-dot', cx: 0, cy: 0, r: 0.009 }, this.world);

      // Labels (unflipped space)
      this.gLabels = el('g', { class: 'labels' }, s);
      const a = 'rotate(-90)';
      const lA = el('text', { x: 0.55, y: -0.022, transform: a, 'text-anchor': 'middle' }, this.gLabels);
      lA.textContent = 'FOLD';
      const bx = 0.5 * 0.58 + 0.03, by = -0.866 * 0.58 + 0.01;
      const lB = el('text', { x: bx, y: by, transform: `rotate(-60 ${bx} ${by})`, 'text-anchor': 'middle' }, this.gLabels);
      lB.textContent = 'FOLD';
      const lC = el('text', { x: 0.03, y: 0.045, class: 'center-label' }, this.gLabels);
      lC.textContent = 'centre of the snowflake';
    }

    // -------------------------------------------------------------------- render
    render() {
      const { strokes, trim } = this.store.state;
      const guides = this.store.state.guides || [];
      const outline = E.paperOutline(trim);
      const sector = E.sectorOutline(1);

      this.gExcess.setAttribute('d', d(sector, true));
      this.gPaper.setAttribute('d', d(outline, true));

      // A few offset outlines to hint at 12 stacked layers
      this.gLayers.innerHTML = '';
      for (let i = 3; i >= 1; i--) {
        el('path', { d: d(outline, true), transform: `translate(${0.004 * i} ${-0.004 * i})` }, this.gLayers);
      }

      this.gFolds.innerHTML = '';
      const top = Math.max(...outline.map(p => Math.hypot(p[0], p[1])));
      el('line', { x1: 0, y1: 0, x2: 0, y2: top, 'vector-effect': 'non-scaling-stroke' }, this.gFolds);
      const rb = E.trimSpec(trim).kind === 'arc' ? trim.size : Math.hypot(...outline[2]);
      el('line', { x1: 0, y1: 0, x2: E.UB[0] * rb, y2: E.UB[1] * rb, 'vector-effect': 'non-scaling-stroke' }, this.gFolds);

      // Neighbouring (mirrored) layers, faded
      this.gGhostPaper.innerHTML = '';
      this.gGhosts.innerHTML = '';
      if (this.showGhosts) {
        const UA = [0, 1], UB = E.UB;
        const mirrors = [p => reflect(p, UA), p => reflect(p, UB)];
        for (const m of mirrors) {
          el('path', { d: d(outline.map(m), true) }, this.gGhostPaper);
          for (const st of strokes) {
            el('path', { d: d(st.pts.map(m), st.closed), 'vector-effect': 'non-scaling-stroke' }, this.gGhosts);
          }
        }
      }

      this.gGuides.innerHTML = '';
      if (this.showSketch || this.layer === 'sketch') {
        for (const st of guides) {
          el('path', {
            d: d(st.pts, st.closed),
            class: 'guide' + (this.layer === 'sketch' && this.selected.has(st.id) ? ' selected' : ''),
            'vector-effect': 'non-scaling-stroke',
          }, this.gGuides);
        }
      }

      this.gStrokes.innerHTML = '';
      // Filled cut-outs (e.g. lettering): outlines first, then fills on top, so
      // overlapping regions read as one shape with a single outer outline.
      const filled = strokes.filter(st => st.fill && st.closed);
      if (filled.length) {
        const g = el('g', { class: 'filled-cuts' }, this.gStrokes);
        for (const st of filled) {
          el('path', { d: d(st.pts, true), class: 'cut' + (this.layer === 'cut' && this.selected.has(st.id) ? ' selected' : ''), 'vector-effect': 'non-scaling-stroke' }, g);
        }
        for (const st of filled) el('path', { d: d(st.pts, true), class: 'cut-fill' }, g);
      }
      for (const st of strokes) {
        if (st.fill && st.closed) continue;
        el('path', {
          d: d(st.pts, st.closed),
          class: 'cut' + (this.layer === 'cut' && this.selected.has(st.id) ? ' selected' : ''),
          'vector-effect': 'non-scaling-stroke',
        }, this.gStrokes);
      }
      this.renderSelection();
      this.renderDraft();
    }

    renderDraft() {
      this.gDraft.innerHTML = '';
      if (!this.draft) return;
      const pts = this.draft.hover ? [...this.draft.pts, this.draft.hover] : this.draft.pts;
      if (pts.length >= 1) {
        el('path', { d: d(pts, this.draft.closed), class: this.layer === 'sketch' ? 'guide drafting' : 'cut drafting', 'vector-effect': 'non-scaling-stroke' }, this.gDraft);
      }
      if (this.tool === 'line') {
        for (const p of this.draft.pts) el('circle', { cx: p[0], cy: p[1], r: 0.006, class: 'vertex' }, this.gDraft);
      }
    }

    renderSelection() {
      this.gSel.innerHTML = '';
      const b = this.selectionBounds();
      if (!b) return;
      const pad = 0.012;
      el('rect', {
        x: b.x0 - pad, y: b.y0 - pad, width: b.x1 - b.x0 + 2 * pad, height: b.y1 - b.y0 + 2 * pad,
        class: 'sel-box', 'vector-effect': 'non-scaling-stroke',
      }, this.gSel);
    }

    // ------------------------------------------------------------------- layers
    // Two layers: 'cut' (real scissor cuts) and 'sketch' (pencil guides that don't cut).
    get list() { return this.layer === 'sketch' ? this.store.state.guides : this.store.state.strokes; }
    set list(v) { if (this.layer === 'sketch') this.store.state.guides = v; else this.store.state.strokes = v; }
    commitList(arr) {
      if (this.layer === 'sketch') this.store.commit(this.store.state.strokes, null, arr);
      else this.store.commit(arr);
    }
    previewDraft(draft) {
      if (this.layer === 'sketch') this.store.previewSketch(draft);
      else this.store.preview(draft);
    }
    setLayer(layer) {
      this.cancelDraft();
      this.layer = layer;
      this.selected.clear();
      this.emitSelection();
      this.svg.dataset.layer = layer;
      this.render();
    }

    // ------------------------------------------------------------------- helpers
    toModel(evt) {
      const pt = this.svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const p = pt.matrixTransform(this.world.getScreenCTM().inverse());
      return [p.x, p.y];
    }
    pxToModel(px) {
      const m = this.world.getScreenCTM();
      return px / Math.abs(m.a || 1);
    }
    hit(p) {
      const tol = this.pxToModel(9);
      const strokes = this.list;
      let best = null, bd = tol;
      for (let i = strokes.length - 1; i >= 0; i--) {
        const dd = distToStroke(p, strokes[i]);
        if (dd < bd) { bd = dd; best = strokes[i]; }
      }
      return best;
    }
    selectionBounds() {
      if (!this.selected.size) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of this.list) {
        if (!this.selected.has(s.id)) continue;
        for (const [x, y] of s.pts) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return x0 === Infinity ? null : { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    }
    selectWithGroup(stroke, additive) {
      if (!additive) this.selected.clear();
      const ids = stroke.g
        ? this.list.filter(s => s.g === stroke.g).map(s => s.id)
        : [stroke.id];
      ids.forEach(id => this.selected.add(id));
      this.emitSelection();
    }
    emitSelection() {
      this.svg.dispatchEvent(new CustomEvent('selectionchange', { detail: { count: this.selected.size } }));
    }
    finishStroke(stroke) {
      let s = { id: newId(), ...stroke };
      if (this.snap && this.layer === 'cut') s = E.snapEndpoints(s, this.store.state.trim);
      this.commitList([...this.list, s]);
    }

    setTool(t) {
      this.cancelDraft();
      this.tool = t;
      if (t !== 'select') { this.selected.clear(); this.emitSelection(); }
      this.svg.dataset.tool = t;
      this.render();
    }
    cancelDraft() {
      this.draft = null;
      this.previewDraft(null);
      this.renderDraft();
    }

    // --------------------------------------------------------------- transforms
    transformSelected(fn) {
      if (!this.selected.size) return;
      const strokes = this.list.map(s =>
        this.selected.has(s.id) ? { ...s, pts: s.pts.map(fn) } : s);
      this.commitList(strokes);
    }
    rotateSel(deg) {
      const b = this.selectionBounds(); if (!b) return;
      const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      this.transformSelected(([x, y]) => [b.cx + (x - b.cx) * c - (y - b.cy) * s, b.cy + (x - b.cx) * s + (y - b.cy) * c]);
    }
    scaleSel(f) {
      const b = this.selectionBounds(); if (!b) return;
      this.transformSelected(([x, y]) => [b.cx + (x - b.cx) * f, b.cy + (y - b.cy) * f]);
    }
    flipSel() {
      const b = this.selectionBounds(); if (!b) return;
      this.transformSelected(([x, y]) => [2 * b.cx - x, y]);
    }
    moveSel(dx, dy) { this.transformSelected(([x, y]) => [x + dx, y + dy]); }
    deleteSel() {
      if (!this.selected.size) return;
      const strokes = this.list.filter(s => !this.selected.has(s.id));
      this.selected.clear();
      this.emitSelection();
      this.commitList(strokes);
    }
    duplicateSel() {
      if (!this.selected.size) return;
      const gmap = {};
      const copies = this.list
        .filter(s => this.selected.has(s.id))
        .map(s => {
          const g = s.g ? (gmap[s.g] ||= 'g' + newId()) : undefined;
          return { ...s, id: newId(), g, pts: s.pts.map(([x, y]) => [x + 0.03, y - 0.03]) };
        });
      this.selected = new Set(copies.map(c => c.id));
      this.emitSelection();
      this.commitList([...this.list, ...copies]);
    }
    selectAll() {
      this.setTool('select');
      this.selected = new Set(this.list.map(s => s.id));
      this.emitSelection();
      this.render();
    }

    // ------------------------------------------------------------------- events
    bind() {
      const s = this.svg;
      s.addEventListener('pointerdown', e => this.onDown(e));
      s.addEventListener('pointermove', e => this.onMove(e));
      s.addEventListener('pointerup', e => this.onUp(e));
      s.addEventListener('pointercancel', () => { this.drag = null; this.cancelDraft(); });
      s.addEventListener('dblclick', e => { if (this.tool === 'line') { e.preventDefault(); this.finishLine(); } });
      s.addEventListener('pointerleave', () => {
        if (this.tool === 'line' && this.draft) { this.draft.hover = null; this.renderDraft(); }
      });
    }

    onDown(e) {
      if (e.button !== 0) return;
      const p = this.toModel(e);
      this.svg.setPointerCapture(e.pointerId);
      switch (this.tool) {
        case 'pen':
          this.draft = { pts: [p], closed: false };
          this.drag = { kind: 'pen' };
          break;
        case 'circle':
          this.draft = { pts: [], closed: true, c: p };
          this.drag = { kind: 'circle' };
          break;
        case 'line': {
          const lp = this.lineSnap(p, e.shiftKey);
          if (!this.draft) this.draft = { pts: [lp], closed: false };
          else {
            const first = this.draft.pts[0];
            const last = this.draft.pts[this.draft.pts.length - 1];
            if (this.draft.pts.length >= 3 && Math.hypot(lp[0] - first[0], lp[1] - first[1]) < this.pxToModel(10)) {
              this.draft.closed = true;
              this.finishLine();
              return;
            }
            if (Math.hypot(lp[0] - last[0], lp[1] - last[1]) > 1e-4) this.draft.pts.push(lp);
          }
          this.renderDraft();
          this.previewDraft(this.draft);
          break;
        }
        case 'erase':
          this.drag = { kind: 'erase', removed: new Set() };
          this.eraseAt(p);
          break;
        case 'select': {
          const h = this.hit(p);
          if (h) {
            if (!this.selected.has(h.id)) this.selectWithGroup(h, e.shiftKey);
            this.drag = { kind: 'move', start: p, base: this.list, moved: false };
          } else {
            this.selected.clear();
            this.emitSelection();
          }
          this.render();
          break;
        }
      }
    }

    onMove(e) {
      const p = this.toModel(e);
      if (this.tool === 'line' && this.draft) {
        this.draft.hover = this.lineSnap(p, e.shiftKey);
        this.renderDraft();
        return;
      }
      if (!this.drag) return;
      switch (this.drag.kind) {
        case 'pen': {
          const last = this.draft.pts[this.draft.pts.length - 1];
          if (Math.hypot(p[0] - last[0], p[1] - last[1]) > this.pxToModel(1.5)) {
            this.draft.pts.push(p);
            this.renderDraft();
            this.previewDraft(this.draft);
          }
          break;
        }
        case 'circle': {
          const r = Math.hypot(p[0] - this.draft.c[0], p[1] - this.draft.c[1]);
          this.draft.pts = r > 1e-4 ? E.circlePts(this.draft.c[0], this.draft.c[1], r) : [];
          this.renderDraft();
          this.previewDraft(this.draft);
          break;
        }
        case 'erase':
          this.eraseAt(p);
          break;
        case 'move': {
          const dx = p[0] - this.drag.start[0], dy = p[1] - this.drag.start[1];
          this.drag.moved = true;
          this.list = this.drag.base.map(s =>
            this.selected.has(s.id) ? { ...s, pts: s.pts.map(([x, y]) => [x + dx, y + dy]) } : s);
          this.render();
          this.previewDraft(null, true);
          break;
        }
      }
    }

    onUp() {
      const drag = this.drag;
      this.drag = null;
      if (!drag) return;
      switch (drag.kind) {
        case 'pen': {
          const pts = E.simplify(this.draft.pts, this.pxToModel(0.6));
          this.draft = null;
          this.renderDraft();
          if (pts.length >= 2) {
            // Closed loop if the pen came back to where it started
            const a = pts[0], b = pts[pts.length - 1];
            const closed = pts.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < this.pxToModel(12);
            this.finishStroke({ pts: closed ? pts.slice(0, -1) : pts, closed });
          } else this.previewDraft(null);
          break;
        }
        case 'circle': {
          const pts = this.draft.pts;
          this.draft = null;
          this.renderDraft();
          if (pts.length) this.finishStroke({ pts, closed: true });
          else this.previewDraft(null);
          break;
        }
        case 'erase':
          if (drag.removed.size) {
            const strokes = this.list;
            this.list = drag.before;
            this.commitList(strokes);
          }
          break;
        case 'move':
          if (drag.moved) {
            const after = this.list;
            this.list = drag.base;
            this.commitList(after);
          }
          break;
      }
    }

    eraseAt(p) {
      const h = this.hit(p);
      if (!h) return;
      if (!this.drag.removed.size) this.drag.before = this.list;
      this.drag.removed.add(h.id);
      this.list = this.list.filter(s => s.id !== h.id);
      this.render();
      this.previewDraft(null, true);
    }

    lineSnap(p, shift) {
      // When cutting, click points snap onto sketch corners so tracing is precise
      if (!shift && this.layer === 'cut' && this.showSketch) {
        const tol = this.pxToModel(8);
        let best = null, bd = tol;
        for (const g of this.store.state.guides || []) for (const q of g.pts) {
          const dd = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (dd < bd) { bd = dd; best = q; }
        }
        if (best) return [best[0], best[1]];
      }
      if (!shift || !this.draft || !this.draft.pts.length) return p;
      const last = this.draft.pts[this.draft.pts.length - 1];
      const dx = p[0] - last[0], dy = p[1] - last[1];
      const r = Math.hypot(dx, dy);
      const step = Math.PI / 12;
      const a = Math.round(Math.atan2(dy, dx) / step) * step;
      return [last[0] + r * Math.cos(a), last[1] + r * Math.sin(a)];
    }

    finishLine() {
      if (!this.draft) return;
      const { pts, closed } = this.draft;
      this.draft = null;
      this.renderDraft();
      if (pts.length >= 2) this.finishStroke({ pts, closed: closed && pts.length >= 3 });
      else this.previewDraft(null);
    }
  }

  Editor.newId = newId;
  global.Editor = Editor;
})(window);
