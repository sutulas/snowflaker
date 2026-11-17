/*
 * Snowflakings app — wires the editor, the unfold preview and all the extras.
 */
(function () {
  'use strict';
  const E = window.Engine;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const STORAGE_KEY = 'snowflaker.v1';
  const N = 1024;                          // preview resolution (px)
  const LUT = E.buildLUT(N);

  const DEFAULT_WORD = { text: '', scale: 1, frame: true, slant: 1, style: 'curved', edge: false, fill: false };
  const PAPER_RGB = [252, 252, 249];
  const STAGE_TOP = '#2b3442', STAGE_BOTTOM = '#1a202a';

  // --------------------------------------------------------------- state/store
  const store = {
    state: {
      strokes: [],
      guides: [],
      word: { text: '', scale: 1, frame: true, slant: 1, style: 'curved', edge: false, fill: false },
      trim: { shape: 'flat', size: 0.92 },
    },
    view: { creases: true, ghosts: false, sketch: true },
    undo: [],
    redo: [],
    keepSeeds: [],
    draftExtra: null,
    sketchDraft: null,

    snapshot() { return JSON.stringify({ strokes: this.state.strokes, guides: this.state.guides, trim: this.state.trim, word: this.state.word }); },
    restore(json) {
      const o = JSON.parse(json);
      this.state.strokes = o.strokes;
      this.state.trim = o.trim;
      this.state.guides = o.guides || [];
      this.state.word = { ...DEFAULT_WORD, ...(o.word || {}) };
    },
    pushHistory() {
      this.undo.push(this.snapshot());
      if (this.undo.length > 150) this.undo.shift();
      this.redo.length = 0;
    },
    commit(strokes, trim, guides) {
      this.pushHistory();
      this.state.strokes = strokes;
      if (trim) this.state.trim = trim;
      if (guides) this.state.guides = guides;
      this.draftExtra = null;
      this.sketchDraft = null;
      changed();
    },
    // Sketch lines never cut, so a sketch draft only needs the overlay redrawn.
    previewSketch(draft) {
      this.sketchDraft = draft && draft.pts && draft.pts.length >= 2 ? draft : null;
      if (!animating) drawFinal();
    },
    preview(extra) {
      this.draftExtra = extra && extra.pts && extra.pts.length >= 2 ? extra : null;
      schedulePreview();
    },
  };

  function changed() {
    editor.render();
    schedulePreview();
    save();
    syncControls();
  }

  function undo() {
    if (!store.undo.length) return;
    store.redo.push(store.snapshot());
    store.restore(store.undo.pop());
    editor.selected.clear();
    changed();
  }
  function redo() {
    if (!store.redo.length) return;
    store.undo.push(store.snapshot());
    store.restore(store.redo.pop());
    changed();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...JSON.parse(store.snapshot()), view: store.view }));
    } catch (_) { /* storage unavailable — fine */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const o = JSON.parse(raw);
      if (!Array.isArray(o.strokes) || !o.trim) return false;
      store.state.strokes = o.strokes;
      store.state.trim = o.trim;
      store.state.guides = Array.isArray(o.guides) ? o.guides : [];
      store.state.word = { ...DEFAULT_WORD, ...(o.word || {}) };
      if (o.view) for (const k of Object.keys(store.view)) if (k in o.view) store.view[k] = o.view[k];
      return true;
    } catch (_) { return false; }
  }

  // ------------------------------------------------------------------ preview
  const canvas = $('#flake');
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d');
  const keptCanvas = Object.assign(document.createElement('canvas'), { width: N, height: N });
  const ghostCanvas = Object.assign(document.createElement('canvas'), { width: N, height: N });
  const kctx = keptCanvas.getContext('2d');
  const gctx = ghostCanvas.getContext('2d');
  let sim = null;
  let kept = new Set();
  let animating = false;
  let rafPending = false;

  function schedulePreview() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; recompute(); });
  }

  function recompute() {
    const strokes = store.draftExtra ? [...store.state.strokes, store.draftExtra] : store.state.strokes;
    const mask = E.renderMask(strokes, store.state.trim);
    sim = E.simulate(mask, LUT);
    resolveKept();
    paint();
  }

  function resolveKept() {
    kept = new Set();
    store.keepSeeds = store.keepSeeds.filter(([u, v]) => {
      const i = Math.min(N - 1, Math.max(0, Math.round(u * N)));
      const j = Math.min(N - 1, Math.max(0, Math.round(v * N)));
      const l = sim.labels[j * N + i];
      if (l) kept.add(l);
      return !!l;
    });
    if (!kept.size && sim.largest) kept.add(sim.largest);
  }

  function paint() {
    const { labels } = sim;
    const [r, g, b] = PAPER_RGB;
    const kImg = kctx.createImageData(N, N);
    const gImg = gctx.createImageData(N, N);
    const kd = kImg.data, gd = gImg.data;
    for (let k = 0, o = 0; k < labels.length; k++, o += 4) {
      const l = labels[k];
      if (!l) continue;
      if (kept.has(l)) { kd[o] = r; kd[o + 1] = g; kd[o + 2] = b; kd[o + 3] = 255; }
      else { gd[o] = 255; gd[o + 1] = 110; gd[o + 2] = 120; gd[o + 3] = 120; }
    }
    kctx.putImageData(kImg, 0, 0);
    gctx.putImageData(gImg, 0, 0);

    // Soft paper shading + crease lines, only where paper is.
    kctx.save();
    kctx.globalCompositeOperation = 'source-atop';
    const grad = kctx.createRadialGradient(N * 0.42, N * 0.38, N * 0.05, N / 2, N / 2, N * 0.55);
    grad.addColorStop(0, 'rgba(255,255,255,0.18)');
    grad.addColorStop(1, 'rgba(20,30,60,0.10)');
    kctx.fillStyle = grad;
    kctx.fillRect(0, 0, N, N);
    if (store.view.creases) {
      kctx.translate(N / 2, N / 2);
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 6;
        const dx = Math.sin(a) * N, dy = -Math.cos(a) * N;
        kctx.strokeStyle = i % 2 ? 'rgba(30,40,80,0.10)' : 'rgba(30,40,80,0.06)';
        kctx.lineWidth = 1.6;
        kctx.beginPath(); kctx.moveTo(-dx, -dy); kctx.lineTo(dx, dy); kctx.stroke();
        kctx.strokeStyle = 'rgba(255,255,255,0.35)';
        kctx.lineWidth = 1;
        kctx.beginPath(); kctx.moveTo(-dx + 1.2, -dy + 1.2); kctx.lineTo(dx + 1.2, dy + 1.2); kctx.stroke();
      }
    }
    kctx.restore();

    if (!animating) drawFinal();
    updateStats();
  }

  function drawFinal() {
    ctx.clearRect(0, 0, N, N);
    if (store.view.ghosts) ctx.drawImage(ghostCanvas, 0, 0);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 12;
    ctx.drawImage(keptCanvas, 0, 0);
    ctx.restore();
    drawSketchOverlay(ctx);
  }

  /** Pencil guides, mirrored into all 12 sectors exactly like the cuts will be. */
  function drawSketchOverlay(c) {
    if (!store.view.sketch) return;
    const lines = store.sketchDraft ? [...store.state.guides, store.sketchDraft] : store.state.guides;
    if (!lines.length) return;
    const R = LUT.R;
    c.save();
    c.translate(N / 2, N / 2);
    c.lineWidth = 2.4;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.setLineDash([9, 7]);
    c.strokeStyle = 'rgba(96,145,235,0.95)';
    for (let k = 0; k < 12; k++) {
      c.save();
      if (k % 2 === 0) c.rotate(k * E.WEDGE);
      else { c.rotate((k + 1) * E.WEDGE); c.scale(-1, 1); }
      c.beginPath();
      for (const st of lines) {
        st.pts.forEach(([x, y], i) => (i ? c.lineTo(x * R, -y * R) : c.moveTo(x * R, -y * R)));
        if (st.closed) c.closePath();
      }
      c.stroke();
      c.restore();
    }
    c.restore();
  }

  function updateStats() {
    const fallen = sim.count - kept.size + (sim.removed || 0);
    $('#stat-cuts').textContent = store.state.strokes.length;
    $('#stat-fallen').textContent = Math.max(0, fallen);
    $('#stat-layers').textContent = 12;
  }

  // Click a piece in the preview to choose whether you keep it
  canvas.addEventListener('click', e => {
    if (!sim || animating) return;
    const rect = canvas.getBoundingClientRect();
    const u = (e.clientX - rect.left) / rect.width, v = (e.clientY - rect.top) / rect.height;
    const i = Math.floor(u * N), j = Math.floor(v * N);
    const l = sim.labels[j * N + i];
    if (!l) return;
    if (kept.has(l)) {
      if (kept.size === 1) return toast('That’s your snowflake — click a fallen piece to keep it too');
      store.keepSeeds = store.keepSeeds.filter(([su, sv]) => sim.labels[Math.round(sv * N) * N + Math.round(su * N)] !== l);
    } else {
      if (!store.keepSeeds.length) {
        for (const kl of kept) {
          const fp = sim.firstPixel[kl];
          store.keepSeeds.push([(fp % N) / N, Math.floor(fp / N) / N]);
        }
      }
      store.keepSeeds.push([u, v]);
      if (!store.view.ghosts) toast('Kept that piece');
    }
    resolveKept();
    paint();
  });

  // ---------------------------------------------------------------- unfold anim
  function unfold() {
    if (!sim || animating) return;
    animating = true;
    const sprite = Object.assign(document.createElement('canvas'), { width: N, height: N });
    const sc = sprite.getContext('2d');
    sc.drawImage(keptCanvas, 0, 0);
    sc.globalCompositeOperation = 'destination-in';
    sc.beginPath();
    sc.moveTo(N / 2, N / 2);
    const a0 = -0.004, a1 = E.WEDGE + 0.004;
    for (let i = 0; i <= 24; i++) {
      const a = a0 + ((a1 - a0) * i) / 24;
      sc.lineTo(N / 2 + Math.sin(a) * N, N / 2 - Math.cos(a) * N);
    }
    sc.closePath();
    sc.fill();

    const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const dur = 2200;
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / dur);
      ctx.clearRect(0, 0, N, N);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 10;
      ctx.translate(N / 2, N / 2);
      for (let k = 11; k >= 0; k--) {
        const local = Math.max(0, Math.min(1, (t * 1.45 - (k / 11) * 0.45)));
        const e = ease(local);
        ctx.save();
        if (k % 2 === 0) {
          ctx.rotate(k * E.WEDGE * e);
        } else {
          ctx.rotate((k + 1) * E.WEDGE * e);
          ctx.scale(Math.cos(Math.PI * e) || 0.0001, 1);
        }
        ctx.drawImage(sprite, -N / 2, -N / 2);
        ctx.restore();
      }
      ctx.restore();
      if (t < 1) requestAnimationFrame(step);
      else { animating = false; drawFinal(); }
    };
    requestAnimationFrame(step);
  }

  // -------------------------------------------------------------- SVG import
  function importSVG(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('That file isn’t a valid SVG.');
    const root = doc.documentElement;
    if (root.nodeName.toLowerCase() !== 'svg') throw new Error('No <svg> element found.');
    // Strip anything active
    root.querySelectorAll('script, foreignObject, iframe, image, use[href^="http"]').forEach(n => n.remove());
    root.querySelectorAll('*').forEach(n => {
      for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
    });

    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-10000px;top:0;width:800px;height:800px;overflow:hidden;';
    const svg = document.importNode(root, true);
    if (!svg.getAttribute('width')) svg.setAttribute('width', '800');
    if (!svg.getAttribute('height')) svg.setAttribute('height', '800');
    host.appendChild(svg);
    document.body.appendChild(host);

    try {
      const shapes = [...svg.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse')];
      if (!shapes.length) throw new Error('No shapes or paths found in that SVG.');
      const rootInv = svg.getScreenCTM().inverse();
      const lines = [];
      let totalLen = 0;
      const lens = shapes.map(s => { try { const l = s.getTotalLength(); totalLen += l; return l; } catch { return 0; } });
      const step = Math.max(totalLen / 6000, 1e-3);
      shapes.forEach((shape, idx) => {
        const len = lens[idx];
        if (!len) return;
        const m = rootInv.multiply(shape.getScreenCTM());
        const n = Math.max(8, Math.min(1500, Math.ceil(len / step)));
        let cur = [], prevLocal = null;
        for (let i = 0; i <= n; i++) {
          const lp = shape.getPointAtLength((i / n) * len);
          if (prevLocal && Math.hypot(lp.x - prevLocal.x, lp.y - prevLocal.y) > (len / n) * 3) {
            if (cur.length > 1) lines.push(cur);
            cur = [];
          }
          prevLocal = lp;
          const p = lp.matrixTransform(m);
          cur.push([p.x, p.y]);
        }
        if (cur.length > 1) lines.push(cur);
      });
      if (!lines.length) throw new Error('Couldn’t find any drawable lines in that SVG.');

      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of lines) for (const [x, y] of l) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      const w = Math.max(x1 - x0, 1e-6), h = Math.max(y1 - y0, 1e-6);
      const s = Math.min(0.19 / w, 0.3 / h);
      const cx = 0.58 * Math.sin(E.WEDGE / 2), cy = 0.58 * Math.cos(E.WEDGE / 2), bx = (x0 + x1) / 2, by = (y0 + y1) / 2;
      const g = 'g' + Editor.newId();
      const tol = 0.0008;
      const strokes = lines.map(l => {
        let pts = l.map(([x, y]) => [cx + (x - bx) * s, cy - (y - by) * s]);
        const a = pts[0], b = pts[pts.length - 1];
        const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.004;
        pts = E.simplify(pts, tol);
        if (closed && pts.length > 2) pts.pop();
        return { id: Editor.newId(), g, pts, closed: closed && pts.length > 2 };
      }).filter(st => st.pts.length >= 2);

      editor.commitList([...editor.list, ...strokes]);
      editor.setTool('select');
      setToolUI('select');
      editor.selected = new Set(strokes.map(st => st.id));
      editor.emitSelection();
      editor.render();
      const noun = editor.layer === 'sketch' ? 'sketch line' : 'cut';
      toast(`Imported ${strokes.length} ${noun}${strokes.length === 1 ? '' : 's'}. Drag to place, or use the arrange tools`);
    } finally {
      host.remove();
    }
  }

  // ------------------------------------------------------------------ exports
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function exportPNG() {
    const out = Object.assign(document.createElement('canvas'), { width: N, height: N });
    const o = out.getContext('2d');
    if ($('#png-bg').checked) {
      const g = o.createLinearGradient(0, 0, 0, N);
      g.addColorStop(0, STAGE_TOP); g.addColorStop(1, STAGE_BOTTOM);
      o.fillStyle = g;
      o.fillRect(0, 0, N, N);
      o.shadowColor = 'rgba(0,0,0,0.35)'; o.shadowBlur = 28; o.shadowOffsetY = 12;
    }
    o.drawImage(keptCanvas, 0, 0);
    out.toBlob(b => download(b, 'snowflake.png'), 'image/png');
  }

  // Paper size from the dropdown: values in inches, or "15cm"-style options.
  function paperSize() {
    const sel = $('#paper-size');
    const opt = sel.options[sel.selectedIndex];
    const v = parseFloat(sel.value) || 8.5;
    const cm = /cm/.test(opt.textContent);
    return { inches: cm ? v / 2.54 : v, label: cm ? `${v} cm` : `${v}″` };
  }

  /** Real-size vector template of the folded wedge. `bare` drops the title text (used on the print page). */
  function templateSVG(sideInches, label, bare = false) {
    const R = sideInches / 2;   // model unit → inches
    const vx0 = -0.08, vx1 = 0.62, vy0 = -0.07, vy1 = bare ? 1.03 : 1.12;
    const W = vx1 - vx0, H = vy1 - vy0;
    const P = pts => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(5)} ${(-y).toFixed(5)}`).join(' ');
    const outline = E.paperOutline(store.state.trim);
    const sector = E.sectorOutline(1);
    const cuts = store.state.strokes.map(s => `<path d="${P(s.pts)}${s.closed ? ' Z' : ''}"/>`).join('\n    ');
    const fills = store.state.strokes.filter(s => s.fill && s.closed).map(s => `<path d="${P(s.pts)} Z"/>`).join('\n    ');
    const fs = 0.022;
    const lw = u => (u / R).toFixed(5);            // line width in inches → model units
    const header = bare ? '' : `
    <text x="${vx0 + 0.01}" y="${-vy1 + 0.035}" font-weight="700" fill="#111">Snowflakings template · ${label} square paper</text>
    <text x="${vx0 + 0.01}" y="${-vy1 + 0.035 + fs * 1.4}">Black = trim across the top · Red = cuts · print at 100%</text>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${(W * R).toFixed(3)}in" height="${(H * R).toFixed(3)}in" viewBox="${vx0} ${-vy1} ${W} ${H}">
  <title>Snowflakings cutting template — ${label} square paper</title>
  <defs><clipPath id="paper"><path d="${P(outline)} Z"/></clipPath></defs>
  <path d="${P(sector)} Z" fill="none" stroke="#9aa6b8" stroke-width="${lw(0.008)}" stroke-dasharray="${lw(0.06)} ${lw(0.04)}"/>
  <path d="${P(outline)} Z" fill="#fff" stroke="#111" stroke-width="${lw(0.014)}"/>
  <g fill="none" stroke="#e5484d" stroke-width="${lw(0.018)}" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#paper)">
    ${cuts}
  </g>
  <g fill="#fbe3e4" stroke="none" clip-path="url(#paper)">
    ${fills}
  </g>
  <circle cx="0" cy="0" r="${lw(0.04)}" fill="#111"/>
  <g font-family="Helvetica, Arial, sans-serif" font-size="${fs}" fill="#4a5568">
    <text x="-0.02" y="-0.45" transform="rotate(-90 -0.02 -0.45)" text-anchor="middle" letter-spacing="0.004">FOLD EDGE</text>
    <text x="0.27" y="-0.43" transform="rotate(-60 0.27 -0.43)" text-anchor="middle" letter-spacing="0.004">FOLD EDGE</text>
    <text x="0.025" y="0.035">◀ point = centre of the square</text>${header}
  </g>
</svg>`;
  }

  function exportTemplate() {
    const { inches, label } = paperSize();
    download(new Blob([templateSVG(inches, label)], { type: 'image/svg+xml' }),
      `snowflake-template-${label.replace(/[^\w.]+/g, '')}.svg`);
  }

  /** A full printable page: instructions, real-size template, scale check and a preview of the result. */
  function printPageHTML() {
    const { inches, label } = paperSize();
    const thumb = Object.assign(document.createElement('canvas'), { width: 400, height: 400 });
    const tc = thumb.getContext('2d');
    tc.fillStyle = STAGE_BOTTOM;
    tc.beginPath(); tc.arc(200, 200, 200, 0, Math.PI * 2); tc.fill();
    tc.drawImage(keptCanvas, 12, 12, 376, 376);
    const svg = templateSVG(inches, label, true).replace(/^<\?xml[^>]*>\s*/, '');
    const trimName = E.TRIMS[store.state.trim.shape].label.toLowerCase();
    return `<!doctype html><html><head><meta charset="utf-8"><title>Snowflake cutting template (${label})</title>
<style>
  @page { margin: 0.45in; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10pt/1.4 Helvetica, Arial, sans-serif; color: #142038; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  header { display: flex; gap: 0.25in; align-items: flex-start; border-bottom: 1px solid #d7dde8; padding-bottom: 0.12in; margin-bottom: 0.15in; }
  header .text { flex: 1; }
  h1 { font: 700 15pt/1.2 Helvetica, Arial, sans-serif; margin: 0 0 4pt; }
  ol { margin: 4pt 0 0; padding-left: 14pt; }
  li { margin: 1pt 0; }
  .preview { width: 1.25in; height: 1.25in; }
  .legend span { display: inline-block; margin-right: 12pt; }
  .sw { display: inline-block; width: 14pt; height: 0; border-top: 2px solid; vertical-align: middle; margin-right: 4pt; }
  .tpl svg { display: block; }
  .scale { display: flex; gap: 0.3in; align-items: flex-end; margin-top: 0.12in; font-size: 8pt; color: #4b5a76; }
  .bar { border: 1px solid #142038; border-top: 0; height: 6pt; }
</style></head><body>
<header>
  <div class="text">
    <h1>Snowflake cutting template</h1>
    <div>For <b>${label}</b> square paper · ${trimName} outline · ${store.state.strokes.length} cuts through 12 layers</div>
    <ol>
      <li>Fold your square: diagonal, in half, then in thirds (see Snowflakings’s guide).</li>
      <li>Cut out the template along the <b>black</b> outline and lay it on the folded wedge. Put its point on the centre corner and line its edges up with the folds.</li>
      <li>Trace it, trim across the top along the black line, then cut every <b>red</b> line through all the layers.</li>
      <li>Unfold slowly. ❄</li>
    </ol>
    <div class="legend" style="margin-top:4pt"><span><i class="sw" style="color:#111"></i>trim</span><span><i class="sw" style="color:#e5484d"></i>cut</span><span><i class="sw" style="color:#9aa6b8;border-top-style:dashed"></i>edge of folded paper</span><span><i style="display:inline-block;width:12pt;height:8pt;background:#fbe3e4;border:1px solid #e5484d;vertical-align:middle;margin-right:4pt"></i>shaded = cut away</span></div>
  </div>
  <img class="preview" src="${thumb.toDataURL('image/png')}" alt="Unfolded preview">
</header>
<div class="tpl">${svg}</div>
<div class="scale">
  <div><div class="bar" style="width:1in"></div>1 inch</div>
  <div><div class="bar" style="width:2cm"></div>2 cm</div>
  <div>Measure these to check it printed at 100% (turn off “fit to page” if not).</div>
</div>
</body></html>`;
  }

  function printTemplate() {
    if (!store.state.strokes.length) toast('No cuts yet — printing just the outline');
    document.querySelector('#print-frame')?.remove();
    const frame = document.createElement('iframe');
    frame.id = 'print-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open(); doc.write(printPageHTML()); doc.close();
    const go = () => { frame.contentWindow.focus(); frame.contentWindow.print(); };
    const img = doc.querySelector('img');
    if (img && !img.complete) img.onload = go; else setTimeout(go, 50);
  }

  function exportProject() {
    const blob = new Blob([JSON.stringify({ app: 'snowflaker', version: 1, ...JSON.parse(store.snapshot()) }, null, 1)], { type: 'application/json' });
    download(blob, 'snowflake-design.json');
  }
  function importProject(text) {
    const o = JSON.parse(text);
    if (!Array.isArray(o.strokes) || !o.trim) throw new Error('That isn’t a Snowflakings project file.');
    store.keepSeeds = [];
    editor.selected.clear();
    store.commit(o.strokes, o.trim, Array.isArray(o.guides) ? o.guides : []);
    store.state.word = { ...DEFAULT_WORD, ...(o.word || {}) };
    syncWordUI(); save();
    toast('Design opened');
  }

  // ------------------------------------------------------------------- toast
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------------------------------------------------------------- UI wiring
  load();

  const editor = new Editor($('#editor'), store);
  window.snowflaker = { store, editor };   // handy for tinkering in devtools

  function setToolUI(t) {
    $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    const sketching = editor.layer === 'sketch';
    $('#tool-hint').textContent = (sketching ? 'Sketching (nothing is cut). ' : '') + {
      pen: 'Drag to cut freehand. End near where you started to cut out a closed shape.',
      line: sketching ? 'Click to place points, double-click or Enter to finish. Shift snaps angles.' : 'Click to place points. Double-click or Enter to finish; click the first point to close. Points snap to sketch corners; Shift snaps angles.',
      circle: 'Drag from the centre outward to punch a round hole.',
      erase: sketching ? 'Click or drag across sketch lines to remove them.' : 'Click or drag across cuts to remove them.',
      select: sketching ? 'Select sketch lines to move them, or to turn just those into cuts.' : 'Click a cut to select it, drag to move. Shift-click adds to the selection.',
    }[t];
  }
  $$('[data-tool]').forEach(b => b.addEventListener('click', () => { editor.setTool(b.dataset.tool); setToolUI(b.dataset.tool); }));

  $$('[data-trim]').forEach(b => b.addEventListener('click', () => {
    store.commit(store.state.strokes, { ...store.state.trim, shape: b.dataset.trim });
    refitWord();
  }));
  const sizeInput = $('#trim-size');
  let sizeDragStart = null;
  sizeInput.addEventListener('pointerdown', () => { sizeDragStart = store.snapshot(); });
  sizeInput.addEventListener('input', () => {
    store.state.trim = { ...store.state.trim, size: parseFloat(sizeInput.value) };
    if (store.state.word.text) store.state.strokes = withWord(store.state.word).strokes;
    editor.render();
    schedulePreview();
  });
  sizeInput.addEventListener('change', () => {
    const now = store.state.trim;
    if (sizeDragStart) { store.restore(sizeDragStart); sizeDragStart = null; }
    else store.state.trim = { ...now };
    store.commit(store.state.strokes, now);
    refitWord();
  });

  // --------------------------------------------------------------- word tool
  let lastWordEdit = 0;
  const wordInput = $('#word-input');

  /** Current cuts with the word's cuts swapped for a fresh layout. */
  function withWord(word) {
    const others = store.state.strokes.filter(s => !s.word);
    const res = Words.build(word.text, store.state.trim, word);
    return { ...res, strokes: [...others, ...res.strokes] };
  }

  function applyWord(patch, merge = false) {
    const now = Date.now();
    if (!merge && now - lastWordEdit > 1200) store.pushHistory();   // typing a word = one undo step
    lastWordEdit = now;
    store.state.word = { ...store.state.word, ...patch };
    const res = withWord(store.state.word);
    store.state.strokes = res.strokes;
    store.draftExtra = null;
    wordStatus(res);
    changed();
  }
  function refitWord() { if (store.state.word.text) applyWord({}, true); }

  function wordStatus(res, rejected = []) {
    const msg = $('#word-msg');
    msg.classList.remove('warn');
    if (rejected.length) {
      msg.classList.add('warn');
      msg.textContent = `${rejected.join(', ')} can’t be cut this way: it isn’t the same upside-down. Try ${Words.ALLOWED_DISPLAY.join(' ')}.`;
    } else if (res && res.letters.length && !res.fits) {
      msg.classList.add('warn');
      msg.textContent = 'That word doesn’t fit on this paper. Try fewer letters or a larger trim height.';
    } else if (res && res.letters.length) {
      const { inches } = paperSize();
      const fmt = h => `${(h * inches / 2).toFixed(2)}″`;
      const paper = $('#paper-size').selectedOptions[0].textContent;
      const tiny = res.lastHeight * inches / 2 < 0.25 ? ' The smallest letters are fiddly; sharp scissors help.' : '';
      msg.textContent = Math.abs(res.firstHeight - res.lastHeight) / res.firstHeight < 0.03
        ? `Letters are about ${fmt(res.firstHeight)} tall on ${paper} paper. First letter at the tip, last nearest the centre.`
        : `Letters shrink from about ${fmt(res.firstHeight)} to ${fmt(res.lastHeight)} tall on ${paper} paper.${tiny}`;
      const w = store.state.word;
      if (w.fill && w.slant > 0.001 && w.style !== 'straight') msg.textContent += ' Tip: Straight letters read better when filling the width.';
    } else {
      msg.textContent = 'Only letters that are the same upside-down work. The first letter sits at the tip, the last nearest the centre.';
    }
  }

  function syncWordUI() {
    const w = store.state.word;
    if (document.activeElement !== wordInput) wordInput.value = w.text;
    $('#word-size').value = w.scale;
    $('#word-frame').checked = w.frame;
    $('#word-edge').checked = w.edge;
    $('#word-fill').checked = w.fill;
    $('#word-frame').disabled = w.fill;
    $('#word-frame').closest('label').classList.toggle('disabled', w.fill);
    $('#word-slant').value = w.slant;
    $$('#word-style button').forEach(b => { b.classList.toggle('active', b.dataset.style === w.style); b.disabled = w.slant <= 0.001; });
    $('#word-slant-val').textContent = `${Math.round(w.slant * 100)}%`;
    $('#word-remove').disabled = !w.text;
  }

  wordInput.addEventListener('input', () => {
    const { letters, rejected } = Words.normalise(wordInput.value);
    const text = letters.join('');
    if (wordInput.value !== text) {
      const pos = Math.min(wordInput.selectionStart ?? text.length, text.length);
      wordInput.value = text;
      wordInput.setSelectionRange(pos, pos);
    }
    applyWord({ text });
    if (rejected.length) wordStatus(null, rejected);
  });
  for (const ch of Words.ALLOWED_DISPLAY) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ch;
    b.title = `Add ${ch}`;
    b.addEventListener('click', () => {
      if (store.state.word.text.length >= Words.MAX_LETTERS) return toast(`Words can be up to ${Words.MAX_LETTERS} letters`);
      applyWord({ text: store.state.word.text + ch });
      wordInput.value = store.state.word.text;
    });
    $('#word-chips').appendChild(b);
  }
  $('#word-size').addEventListener('input', e => applyWord({ scale: parseFloat(e.target.value) }));
  $$('#word-style button').forEach(b => b.addEventListener('click', () => applyWord({ style: b.dataset.style })));
  $('#word-slant').addEventListener('input', e => { applyWord({ slant: parseFloat(e.target.value) }); $('#word-slant-val').textContent = `${Math.round(e.target.value * 100)}%`; });
  $('#word-fill').addEventListener('change', e => applyWord({ fill: e.target.checked }));
  $('#word-edge').addEventListener('change', e => applyWord({ edge: e.target.checked }));
  $('#word-frame').addEventListener('change', e => applyWord({ frame: e.target.checked }, false));
  $('#word-remove').addEventListener('click', () => { lastWordEdit = 0; applyWord({ text: '' }); wordInput.value = ''; });
  $('#paper-size').addEventListener('change', () => wordStatus(Words.build(store.state.word.text, store.state.trim, store.state.word)));

  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-clear').addEventListener('click', () => {
    if (!editor.list.length) return;
    if (editor.layer === 'cut') store.keepSeeds = [];
    editor.selected.clear();
    editor.emitSelection();
    editor.commitList([]);
    if (editor.layer === 'cut') { store.state.word = { ...store.state.word, text: '' }; syncWordUI(); save(); }
    toast(editor.layer === 'sketch' ? 'Sketch cleared. Press undo to bring it back' : 'All cuts cleared. Press undo to bring them back');
  });

  // ------------------------------------------------------------ sketch layer
  function setLayerUI(layer) {
    editor.setLayer(layer);
    $$('.layer-switch [data-layer]').forEach(b => b.classList.toggle('active', b.dataset.layer === layer));
    $('#fold-panel').dataset.layer = layer;
    $('#btn-clear').textContent = layer === 'sketch' ? 'Clear sketch' : 'Clear cuts';
    setToolUI(editor.tool);
    syncControls();
  }
  $$('.layer-switch [data-layer]').forEach(b => b.addEventListener('click', () => setLayerUI(b.dataset.layer)));

  function sketchToCuts() {
    const guides = store.state.guides;
    if (!guides.length) return toast('Nothing sketched yet');
    const useSel = editor.layer === 'sketch' && editor.selected.size;
    const pick = useSel ? guides.filter(g => editor.selected.has(g.id)) : guides;
    const rest = useSel ? guides.filter(g => !editor.selected.has(g.id)) : [];
    const gmap = {};
    const cuts = pick.map(g => {
      let c = { ...g, id: Editor.newId(), g: g.g ? (gmap[g.g] ||= 'g' + Editor.newId()) : undefined };
      if (editor.snap) c = E.snapEndpoints(c, store.state.trim);
      return c;
    });
    editor.selected.clear();
    store.commit([...store.state.strokes, ...cuts], null, rest);
    setLayerUI('cut');
    toast(`Cut ${cuts.length} line${cuts.length === 1 ? '' : 's'}. Undo if you change your mind`);
  }
  $('#btn-sketch-cut').addEventListener('click', sketchToCuts);
  $('#opt-show-sketch').addEventListener('change', e => { editor.showSketch = e.target.checked; editor.render(); });
  $('#opt-sketch').addEventListener('change', e => { store.view.sketch = e.target.checked; save(); drawFinal(); });
  $('#opt-snap').addEventListener('change', e => { editor.snap = e.target.checked; });
  $('#opt-mirror').addEventListener('change', e => { editor.showGhosts = e.target.checked; editor.render(); });

  // Selection tools
  $('#sel-rotl').addEventListener('click', () => editor.rotateSel(15));
  $('#sel-rotr').addEventListener('click', () => editor.rotateSel(-15));
  $('#sel-up').addEventListener('click', () => editor.scaleSel(1.1));
  $('#sel-down').addEventListener('click', () => editor.scaleSel(1 / 1.1));
  $('#sel-flip').addEventListener('click', () => editor.flipSel());
  $('#sel-dup').addEventListener('click', () => editor.duplicateSel());
  $('#sel-del').addEventListener('click', () => editor.deleteSel());
  $('#editor').addEventListener('selectionchange', e => {
    $('#selbar').classList.toggle('show', e.detail.count > 0);
    $('#sel-count').textContent = `${e.detail.count} selected`;
    syncSketchButton();
  });

  // File input (SVG or project)
  const fileInput = $('#file-input');
  $('#btn-import').addEventListener('click', () => { fileInput.accept = '.svg,image/svg+xml'; fileInput.dataset.kind = 'svg'; fileInput.click(); });
  $('#btn-open').addEventListener('click', () => { fileInput.accept = '.json,application/json'; fileInput.dataset.kind = 'project'; fileInput.click(); });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      if (fileInput.dataset.kind === 'project' || /\.json$/i.test(f.name)) importProject(text);
      else importSVG(text);
    } catch (err) { toast(err.message || 'Couldn’t read that file'); }
  });

  // Drag & drop SVGs straight onto the paper
  const dropZone = $('#editor-wrap');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dropping'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dropping'));
  dropZone.addEventListener('drop', async e => {
    e.preventDefault();
    dropZone.classList.remove('dropping');
    const f = e.dataTransfer.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      if (/\.json$/i.test(f.name)) importProject(text); else importSVG(text);
    } catch (err) { toast(err.message || 'Couldn’t read that file'); }
  });

  // Preview controls
  $('#opt-creases').addEventListener('change', e => { store.view.creases = e.target.checked; save(); paint(); });
  $('#opt-ghosts').addEventListener('change', e => { store.view.ghosts = e.target.checked; save(); drawFinal(); });
  $('#btn-unfold').addEventListener('click', unfold);
  $('#btn-png').addEventListener('click', exportPNG);
  $('#btn-template').addEventListener('click', exportTemplate);
  $('#btn-print').addEventListener('click', printTemplate);
  $('#btn-print-top').addEventListener('click', printTemplate);
  $('#btn-save').addEventListener('click', exportProject);

  function syncSketchButton() {
    const n = store.state.guides.length;
    const sel = editor.layer === 'sketch' ? editor.selected.size : 0;
    const b = $('#btn-sketch-cut');
    b.disabled = !n;
    b.querySelector('span').textContent = sel ? `Cut ${sel} selected` : 'Cut along sketch';
    $('#sketch-count').textContent = n ? `${n} sketch line${n === 1 ? '' : 's'}` : 'No sketch yet';
  }

  function syncControls() {
    const { trim } = store.state;
    $$('[data-trim]').forEach(b => b.classList.toggle('active', b.dataset.trim === trim.shape));
    sizeInput.value = trim.size;
    $('#opt-creases').checked = store.view.creases;
    $('#opt-ghosts').checked = store.view.ghosts;
    $('#opt-sketch').checked = store.view.sketch;
    syncSketchButton();
    $('#btn-undo').disabled = !store.undo.length;
    $('#btn-redo').disabled = !store.redo.length;
    syncWordUI();
  }

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select')) return;
    // Escape/Enter while drawing belong to the drawing, not to whichever button has focus
    if ((e.key === 'Enter' || e.key === 'Escape') && editor.draft) e.preventDefault();
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); editor.duplicateSel(); return; }
    if (mod && k === 'a') { e.preventDefault(); editor.selectAll(); setToolUI('select'); return; }
    if (mod) return;
    const tools = { p: 'pen', l: 'line', o: 'circle', e: 'erase', v: 'select' };
    if (tools[k]) { editor.setTool(tools[k]); setToolUI(tools[k]); return; }
    if (k === 's') { setLayerUI(editor.layer === 'sketch' ? 'cut' : 'sketch'); return; }
    if (k === 'c' && editor.layer === 'sketch') { sketchToCuts(); return; }
    if (k === 'enter') { if (editor.draft) { e.preventDefault(); editor.finishLine(); } return; }
    if (k === 'escape') {
      if (editor.draft) editor.cancelDraft();
      else { editor.selected.clear(); editor.emitSelection(); editor.render(); }
      return;
    }
    if ((k === 'delete' || k === 'backspace') && editor.selected.size) { e.preventDefault(); editor.deleteSel(); return; }
    const nudge = e.shiftKey ? 0.02 : 0.004;
    const arrows = { arrowleft: [-nudge, 0], arrowright: [nudge, 0], arrowup: [0, nudge], arrowdown: [0, -nudge] };
    if (arrows[k] && editor.selected.size) { e.preventDefault(); editor.moveSel(...arrows[k]); }
  });

  editor.svg.dataset.tool = 'pen';
  setLayerUI('cut');
  if (store.state.word.text) wordStatus(Words.build(store.state.word.text, store.state.trim, store.state.word));
  syncControls();
  recompute();
})();
