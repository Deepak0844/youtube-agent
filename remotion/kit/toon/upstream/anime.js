// anime.js: anime-style characters (busts) and effects (big eyes, cel shading, emotion effects).
// A Bust is drawn in head units (head top -204, chin 158, eye line 0), then placed with draw(x, y, scale, expression).
// draw() rebuilds the SVG each call, so an animation just calls it every frame with new expression values.
// yt-toon patch: module wrapper (window and document are passed in), was an IIFE
export default (window, document) => {
  const NS = 'http://www.w3.org/2000/svg';
  const E = (tag, attrs = {}, parent) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  };
  let uid = 0;
  const nid = p => `${p}${++uid}`;
  const INK = '#2b1a14';
  const rootOf = el => el.ownerSVGElement || el;
  const defsOf = el => {
    const svg = rootOf(el);
    return svg.querySelector('defs') || E('defs', {}, svg);
  };
  const lin = (el, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1, units) => {
    const id = nid('lg');
    const g = E('linearGradient', Object.assign({ id, x1, y1, x2, y2 }, units ? { gradientUnits: units } : {}), defsOf(el));
    stops.forEach(([o, c, a = 1]) => E('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, g));
    return `url(#${id})`;
  };
  const rad = (el, stops, cx = .5, cy = .5, r = .5) => {
    const id = nid('rg');
    const g = E('radialGradient', { id, cx, cy, r }, defsOf(el));
    stops.forEach(([o, c, a = 1]) => E('stop', { offset: o, 'stop-color': c, 'stop-opacity': a }, g));
    return `url(#${id})`;
  };
  const clip = (el, d) => {
    const id = nid('cp');
    const c = E('clipPath', { id }, defsOf(el));
    E('path', { d }, c);
    return `url(#${id})`;
  };
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const P = (...a) => a.map(v => typeof v === 'number' ? +v.toFixed(1) : v).join(' ');
  const f = n => +n.toFixed(1);
  // smooth closed outline through points; pointy=true keeps sharp corners (hair tips)
  const poly = pts => 'M ' + pts.map(p => `${f(p[0])} ${f(p[1])}`).join(' L ') + ' Z';
  const curvy = (pts, closed = true) => {
    // quadratic curves through midpoints: corners become soft, points marked with a 3rd value 1 stay sharp
    const n = pts.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let d = '';
    for (let i = 0; i < n; i++) {
      const p = pts[i], prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
      const m0 = mid(prev, p), m1 = mid(p, next);
      if (i === 0) d += `M ${f(m0[0])} ${f(m0[1])} `;
      if (p[2]) d += `L ${f(p[0])} ${f(p[1])} L ${f(m1[0])} ${f(m1[1])} `;
      else d += `Q ${f(p[0])} ${f(p[1])} ${f(m1[0])} ${f(m1[1])} `;
    }
    return d + (closed ? 'Z' : '');
  };

  // ---------- character ----------
  const DEFAULTS = {
    skin: '#f6d2b4', skinS: '#dda585', blushC: '#ec7a66',
    hair: '#3a2a20', hairS: '#24180f', hairH: '#6b5444', hairStyle: 'spiky',
    iris: '#5a3d2b', irisL: '#c19470',
    eyeW: 74, eyeH: 58, eyeGap: 56, lash: .7,
    jaw: .3, age: 0, glasses: false, frame: '#2b2b33',
    outfit: 'kit', shirt: '#1f4fa8', shirtS: '#163b80', trim: '#ffffff', badge: null,
    suit: '#1c2238', suitS: '#121728', tie: '#1d2a4d', collar: '#f3f1ea',
    stubble: 0,
  };

  class Bust {
    constructor(parent, o = {}) { this.o = Object.assign({}, DEFAULTS, o); this.g = E('g', {}, parent); }
    face() {
      const o = this.o, fw = 116, jw = 78 + o.jaw * 20, jy = 88 - o.jaw * 4, chW = 20 + o.jaw * 20;
      return P('M', -fw, -70, 'L', -fw + 2, -14, 'C', -fw + 4, 28, -jw - 8, 60, -jw, jy, 'L', -chW, 144, 'Q', 0, 164, chW, 144,
        'L', jw, jy, 'C', jw + 8, 60, fw - 4, 28, fw - 2, -14, 'L', fw, -70, 'C', fw, -160, 64, -204, 0, -204, 'C', -64, -204, -fw, -160, -fw, -70, 'Z');
    }
    draw(x, y, s, ex = {}) {
      const o = this.o, g = this.g;
      ex = Object.assign({ eyes: 'open', look: [0, 0], lid: 0, brow: 0, browY: 0, mouth: 'smile', open: .6, tears: 0, blush: 0, sweat: false, turn: 0, tilt: 0, wet: 0, shine: 1 }, ex);
      while (g.firstChild) g.firstChild.remove();
      g.setAttribute('transform', `translate(${x} ${y}) rotate(${ex.tilt}) scale(${s})`);
      this.ex = ex;
      const dx = ex.turn * 20, face = this.face();
      const fw = 116, jw = 78 + o.jaw * 20, jy = 88 - o.jaw * 4, chW = 20 + o.jaw * 20;

      this.body(g, o);
      // neck and the shadow the jaw casts on it
      E('path', { d: 'M -38 96 C -38 160 -42 210 -46 252 L 46 252 C 42 210 38 160 38 96 Z', fill: o.skin, stroke: INK, 'stroke-width': 3.5 }, g);
      E('path', { d: P('M', -40, 110, 'L', -chW, 150, 'Q', 0, 172, chW, 150, 'L', 40, 110, 'L', 42, 196, 'C', 20, 212, -20, 212, -42, 196, 'Z'), fill: o.skinS }, g);
      this.hairBack(g, o);
      // ears
      for (const sd of [-1, 1]) {
        const e0 = sd * (fw - 6);
        E('path', { d: P('M', e0, -30, 'C', e0 + sd * 28, -44, e0 + sd * 32, 18, e0 + sd * 2, 36, 'Z'), fill: o.skin, stroke: INK, 'stroke-width': 3.5 }, g);
        E('path', { d: P('M', e0 + sd * 6, -16, 'C', e0 + sd * 20, -20, e0 + sd * 20, 12, e0 + sd * 8, 22), fill: 'none', stroke: o.skinS, 'stroke-width': 5, 'stroke-linecap': 'round' }, g);
      }
      // face with a crescent cel shadow on the far cheek
      E('path', { d: face, fill: o.skin }, g);
      const fc = E('g', { 'clip-path': clip(g, face) }, g);
      const t = ex.turn * 24;
      E('path', { d: P('M', fw - 40 - t, -150, 'C', fw - 18 - t, -60, jw - 6 - t, 30, jw - 22 - t, jy + 14, 'L', chW + 4, 150, 'L', 40, 190, 'L', 200, 190, 'L', 200, -150, 'Z'), fill: o.skinS }, fc);
      this.foreheadShadow(fc, o);
      if (o.stubble) E('path', { d: P('M', -jw - 8, 40, 'C', -jw, 116, -40, 168, 0, 168, 'C', 40, 168, jw, 116, jw + 8, 40, 'C', 60, 68, 30, 76, 0, 74, 'C', -30, 76, -60, 68, -jw - 8, 40, 'Z'), fill: o.hairS, opacity: .13 * o.stubble }, fc);
      if (ex.blush > 0) {
        for (const sd of [-1, 1]) {
          E('ellipse', { cx: sd * 66 + dx, cy: 54, rx: 30, ry: 14, fill: o.blushC, opacity: .38 * ex.blush }, fc);
          for (let k = 0; k < 3; k++) E('line', { x1: sd * 50 + dx + k * 11, y1: 62, x2: sd * 50 + dx + k * 11 + 8, y2: 47, stroke: o.blushC, 'stroke-width': 3, opacity: .9 * ex.blush, 'stroke-linecap': 'round' }, fc);
        }
      }
      E('path', { d: face, fill: 'none', stroke: INK, 'stroke-width': 4, 'stroke-linejoin': 'round' }, g);
      if (o.age > 0) this.ageLines(g, o, ex, dx);
      for (const sd of [-1, 1]) this.eye(g, o, ex, sd * o.eyeGap + dx, 0, sd);
      for (const sd of [-1, 1]) this.brow(g, o, ex, sd * o.eyeGap + dx, -o.eyeH * .92 - 6 - ex.browY, sd);
      // nose: one stroke and a small shadow, anime style
      E('path', { d: P('M', dx + 6, 44, 'L', dx + 12, 62, 'L', dx + 2, 64), fill: 'none', stroke: INK, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      E('path', { d: P('M', dx + 6, 30, 'L', dx + 13, 60, 'L', dx + 4, 50, 'Z'), fill: o.skinS, opacity: .8 }, g);
      this.mouth(g, o, ex, dx);
      this.hairFront(g, o);
      if (o.glasses) this.specs(g, o, ex, dx);
      if (ex.tears > 0) this.tearsFx(g, o, ex, dx);
      if (ex.sweat) {
        E('path', { d: 'M 100 -126 C 88 -100 86 -82 100 -76 C 114 -82 112 -100 100 -126 Z', fill: '#bfe6ff', stroke: INK, 'stroke-width': 3 }, g);
        E('path', { d: 'M 96 -98 Q 94 -90 98 -86', fill: 'none', stroke: '#fff', 'stroke-width': 3, 'stroke-linecap': 'round' }, g);
      }
      return this;
    }

    body(g0, o) {
      const g = E('g', { transform: 'translate(0 -22)' }, g0);
      const torso = 'M -44 222 C -130 236 -236 266 -280 336 L -320 780 L 320 780 L 280 336 C 236 266 130 236 44 222 Z';
      if (o.outfit === 'suit') {
        E('path', { d: torso, fill: o.suit, stroke: INK, 'stroke-width': 4 }, g);
        const bc = E('g', { 'clip-path': clip(g, torso) }, g);
        E('path', { d: 'M 110 210 C 180 300 200 500 180 800 L 360 800 L 360 210 Z', fill: o.suitS }, bc);
        E('path', { d: 'M -52 218 L 0 372 L 52 218 Z', fill: o.collar, stroke: INK, 'stroke-width': 3.5 }, g);
        E('path', { d: 'M -14 248 L 14 248 L 20 274 L 28 430 L 0 462 L -28 430 L -20 274 Z', fill: o.tie, stroke: INK, 'stroke-width': 3 }, g);
        E('path', { d: 'M -17 240 L 17 240 L 21 274 L -21 274 Z', fill: o.tie, stroke: INK, 'stroke-width': 3 }, g);
        for (const sd of [-1, 1]) {
          E('path', { d: P('M', sd * 52, 216, 'L', sd * 4, 384, 'L', sd * 66, 340, 'L', sd * 48, 310, 'L', sd * 104, 276, 'L', sd * 88, 234, 'Z'), fill: o.suit, stroke: INK, 'stroke-width': 3.5, 'stroke-linejoin': 'round' }, g);
          E('path', { d: P('M', sd * 4, 384, 'L', sd * 38, 580), fill: 'none', stroke: INK, 'stroke-width': 3 }, g);
        }
        E('path', { d: 'M -40 220 L -22 258 L 0 244 L 22 258 L 40 220', fill: 'none', stroke: INK, 'stroke-width': 3 }, g);
      } else {
        E('path', { d: torso, fill: o.shirt, stroke: INK, 'stroke-width': 4 }, g);
        const bc = E('g', { 'clip-path': clip(g, torso) }, g);
        E('path', { d: 'M 100 216 C 190 300 210 520 190 800 L 360 800 L 360 216 Z', fill: o.shirtS }, bc);
        E('path', { d: 'M -190 430 C -160 530 -160 630 -180 780 M 140 340 C 160 410 150 480 130 530', fill: 'none', stroke: o.shirtS, 'stroke-width': 6, 'stroke-linecap': 'round' }, bc);
        E('path', { d: 'M -52 218 C -34 266 34 266 52 218 L 42 212 C 28 250 -28 250 -42 212 Z', fill: o.trim, stroke: INK, 'stroke-width': 3 }, g);
        E('path', { d: 'M -12 246 L 0 288 L 12 246', fill: 'none', stroke: o.trim, 'stroke-width': 8, 'stroke-linejoin': 'round' }, g);
        E('path', { d: 'M -12 246 L 0 288 L 12 246', fill: 'none', stroke: INK, 'stroke-width': 2.5 }, g);
        if (o.badge) o.badge(g, 140, 340, 1);
      }
    }

    hairBack(g, o) {
      if (o.hairStyle === 'swept') {
        E('path', { d: curvy([[-124, -6], [-150, -100], [-160, -150, 1], [-130, -200], [-60, -250], [0, -258], [60, -252], [130, -204], [162, -150, 1], [150, -100], [128, -6]]), fill: o.hairS, stroke: INK, 'stroke-width': 3.5, 'stroke-linejoin': 'round' }, g);
      }
    }

    foreheadShadow(fc, o) {
      const st = o.hairStyle;
      if (st === 'swept') E('path', { d: 'M -104 -104 C -84 -106 -70 -108 -58 -118 C -40 -128 -20 -124 0 -118 C 20 -124 40 -128 58 -118 C 70 -108 84 -106 104 -104 L 120 -200 L -120 -200 Z', fill: o.skinS }, fc);
      else if (st === 'spiky') E('path', { d: 'M -120 -80 L -96 -66 L -84 -92 L -56 -70 L -40 -104 L -6 -84 L 18 -108 L 56 -88 L 80 -110 L 120 -96 L 120 -220 L -120 -220 Z', fill: o.skinS }, fc);
      else if (st === 'buzz') E('path', { d: 'M -124 -88 C -80 -106 -40 -112 0 -112 C 40 -112 80 -106 124 -88 L 124 -220 L -124 -220 Z', fill: o.skinS, opacity: .7 }, fc);
    }

    hairFront(g, o) {
      const st = o.hairStyle, ink = { stroke: INK, 'stroke-width': 3.5, 'stroke-linejoin': 'round' };
      if (st === 'swept') {
        // a full dome combed back: soft silhouette, two small flicks at the sides, M-shaped hairline
        const pts = [[-112, -4, 1], [-126, -46], [-140, -116], [-150, -150, 1], [-130, -168], [-104, -210], [-52, -240], [0, -248], [52, -242], [104, -214], [132, -170], [152, -148, 1], [140, -116], [126, -46], [114, -4, 1],
          [104, -30], [100, -84], [90, -112, 1], [60, -116], [30, -132], [0, -122, 1], [-30, -132], [-60, -116], [-90, -112, 1], [-100, -84], [-104, -30]];
        const d = curvy(pts);
        E('path', Object.assign({ d, fill: o.hair }, ink), g);
        const hc = E('g', { 'clip-path': clip(g, d) }, g);
        E('path', { d: 'M 40 -300 C 120 -250 160 -140 150 0 L 220 0 L 220 -300 Z', fill: o.hairS, opacity: .5 }, hc);
        E('path', { d: 'M -110 -96 C -70 -140 70 -140 110 -96 L 110 -70 C 70 -112 -70 -112 -110 -70 Z', fill: o.hairS, opacity: .55 }, hc);
        // locks fan out backwards from the hairline; each one gets a tapered shadow on its right edge
        [[-90, -112, -128, -150, -138, -176], [-60, -118, -86, -178, -100, -220], [-30, -130, -40, -196, -48, -244], [2, -122, 4, -196, 6, -252], [32, -130, 46, -196, 54, -246], [62, -118, 92, -176, 106, -222], [90, -112, 126, -150, 140, -176]]
          .forEach(([x0, y0, x1, y1, x2, y2]) => {
            E('path', { d: P('M', x0, y0, 'Q', x1, y1, x2, y2, 'Q', x1 + 12, y1 + 6, x0 + 10, y0 + 2, 'Z'), fill: o.hairS, opacity: .7 }, hc);
            E('path', { d: P('M', x0, y0, 'Q', x1, y1, x2, y2), fill: 'none', stroke: INK, 'stroke-width': 2.2, opacity: .7 }, hc);
          });
        E('path', { d: 'M -104 -168 Q -10 -232 98 -176 L 88 -164 L 74 -178 L 62 -160 L 46 -176 L 32 -158 L 16 -174 L 0 -158 L -16 -174 L -32 -158 L -48 -174 L -64 -160 L -78 -174 L -92 -160 Z', fill: o.hairH, opacity: .95 }, hc);
      } else if (st === 'spiky') {
        // short textured hair swept up and to the side
        const pts = [[-126, -10, 1], [-132, -80], [-130, -150], [-112, -196, 1], [-96, -192], [-82, -236, 1], [-56, -222], [-36, -262, 1], [-8, -238], [16, -270, 1], [40, -242], [70, -262, 1], [88, -232], [124, -232, 1], [126, -196], [138, -150, 1], [132, -80], [126, -10, 1],
          [114, -20], [112, -70], [104, -100, 1], [80, -110, 1], [56, -88, 1], [18, -108, 1], [-6, -84, 1], [-40, -104, 1], [-56, -70, 1], [-84, -92, 1], [-96, -66, 1], [-108, -80], [-114, -20]];
        const d = curvy(pts);
        E('path', Object.assign({ d, fill: o.hair }, ink), g);
        const hc = E('g', { 'clip-path': clip(g, d) }, g);
        E('path', { d: 'M 40 -300 C 120 -250 150 -130 140 0 L 220 0 L 220 -300 Z', fill: o.hairS, opacity: .6 }, hc);
        [[-84, -92, -84, -160, -82, -236], [-40, -104, -40, -180, -36, -262], [18, -108, 16, -190, 16, -270], [80, -110, 76, -190, 70, -262]].forEach(([x0, y0, x1, y1, x2, y2]) =>
          E('path', { d: P('M', x0, y0, 'Q', x1, y1, x2, y2), fill: 'none', stroke: INK, 'stroke-width': 2.5, opacity: .7 }, hc));
        E('path', { d: 'M -96 -180 Q -10 -226 96 -190 L 88 -176 L 74 -190 L 60 -172 L 44 -188 L 28 -170 L 12 -186 L -6 -170 L -22 -186 L -40 -170 L -56 -186 L -72 -172 L -86 -184 Z', fill: o.hairH, opacity: .9 }, hc);
      } else if (st === 'buzz') {
        const d = 'M -122 -40 C -128 -150 -74 -212 0 -214 C 74 -212 128 -150 122 -40 L 112 -44 C 108 -74 100 -90 94 -98 C 60 -110 30 -116 0 -116 C -30 -116 -60 -110 -94 -98 C -100 -90 -108 -74 -112 -44 Z';
        E('path', Object.assign({ d, fill: o.hair }, ink), g);
        const hc = E('g', { 'clip-path': clip(g, d) }, g);
        const R = rng(3);
        for (let i = 0; i < 160; i++) E('circle', { cx: f(-120 + R() * 240), cy: f(-214 + R() * 170), r: 2, fill: o.hairH, opacity: .45 }, hc);
        E('path', { d: 'M -74 -182 C -30 -200 30 -200 74 -182 L 64 -172 C 20 -186 -20 -186 -64 -172 Z', fill: o.hairH, opacity: .85 }, hc);
      }
    }

    eye(g, o, ex, cx, cy, sd) {
      const w = o.eyeW, h = o.eyeH, xi = cx - sd * w * .5, xo = cx + sd * w * .5;
      if (ex.eyes === 'happy') {
        E('path', { d: P('M', xo, cy + 8, 'Q', cx, cy - h * .6, xi, cy + 8), fill: 'none', stroke: INK, 'stroke-width': 8, 'stroke-linecap': 'round' }, g);
        return;
      }
      if (ex.eyes === 'closed') {
        E('path', { d: P('M', xo, cy - 4, 'Q', cx, cy + h * .32, xi, cy - 4), fill: 'none', stroke: INK, 'stroke-width': 7, 'stroke-linecap': 'round' }, g);
        E('path', { d: P('M', xo + sd * 2, cy - 2, 'L', xo + sd * 14, cy + 6), fill: 'none', stroke: INK, 'stroke-width': 3, 'stroke-linecap': 'round' }, g);
        return;
      }
      const wide = ex.eyes === 'wide', k = (wide ? 1.12 : 1) * (1 - ex.lid * .45);
      // upper lid: peak sits toward the inner side, outer corner flicks up
      const ti = [xi, cy - h * .1], tp = [cx - sd * w * .08, cy - h * .62 * k], to = [xo + sd * w * .04, cy - h * .26 * k];
      const top = P('M', ti[0], ti[1], 'C', xi + sd * w * .1, tp[1], tp[0], tp[1], cx + sd * w * .12, tp[1] + h * .04, 'C', xo - sd * w * .1, tp[1] + h * .1, to[0], to[1] - 2, to[0], to[1]);
      const bot = P('C', xo - sd * w * .06, cy + h * .3, cx + sd * w * .14, cy + h * .42, cx - sd * w * .12, cy + h * .38, 'C', xi + sd * w * .08, cy + h * .34, xi, cy + h * .12, ti[0], ti[1]);
      const shape = top + ' ' + bot + ' Z';
      E('path', { d: shape, fill: '#fffaf2' }, g);
      const ec = E('g', { 'clip-path': clip(g, shape) }, g);
      const ix = cx + ex.look[0] * w * .14 - sd * w * .03, iy = cy + h * .04 + ex.look[1] * h * .1;
      const irx = w * (wide ? .22 : .31), iry = h * (wide ? .36 : .52);
      E('ellipse', { cx: ix, cy: iy, rx: irx, ry: iry, fill: lin(g, [[0, INK], [.18, o.iris], [.55, o.iris], [1, o.irisL]]) }, ec);
      E('path', { d: P('M', ix - irx * .78, iy + iry * .2, 'Q', ix, iy + iry * 1.02, ix + irx * .78, iy + iry * .2, 'Q', ix, iy + iry * .62, ix - irx * .78, iy + iry * .2, 'Z'), fill: o.irisL, opacity: .65 }, ec);
      E('ellipse', { cx: ix, cy: iy, rx: irx, ry: iry, fill: 'none', stroke: INK, 'stroke-width': 2.5 }, ec);
      E('ellipse', { cx: ix, cy: iy - iry * .02, rx: irx * .42, ry: iry * .46, fill: INK, opacity: .9 }, ec);
      E('path', { d: top + ' ' + P('L', to[0], to[1] + 16, 'C', xo - sd * w * .1, tp[1] + h * .1 + 16, cx + sd * w * .12, tp[1] + h * .04 + 16, tp[0], tp[1] + 16, 'L', ti[0], ti[1] + 14, 'Z'), fill: '#4b3a66', opacity: .3 }, ec);
      if (ex.shine) {
        E('ellipse', { cx: ix - irx * .34, cy: iy - iry * .3, rx: irx * .38, ry: iry * .3, fill: '#fff', transform: `rotate(-20 ${f(ix - irx * .34)} ${f(iy - iry * .3)})` }, ec);
        E('circle', { cx: ix + irx * .42, cy: iy + iry * .36, r: irx * .16, fill: '#fff' }, ec);
      }
      if (ex.wet > 0) {
        E('path', { d: P('M', cx - w * .6, cy + h * .22, 'Q', cx - w * .3, cy + h * .1, cx, cy + h * .22, 'T', cx + w * .6, cy + h * .22, 'L', cx + w * .6, cy + h, 'L', cx - w * .6, cy + h, 'Z'), fill: '#bfe6ff', opacity: .5 * ex.wet }, ec);
        E('path', { d: P('M', ix - irx * .6, iy + iry * .5, 'Q', ix, iy + iry * .3, ix + irx * .6, iy + iry * .5), fill: 'none', stroke: '#fff', 'stroke-width': 3, opacity: ex.wet }, ec);
        E('circle', { cx: ix - irx * .1, cy: iy - iry * .55, r: irx * .1, fill: '#fff', opacity: ex.wet }, ec);
      }
      // lash mass: thick crescent on the upper lid, heavier toward the outer corner, with a small wing
      const lw = 4 + o.lash * 6;
      E('path', { d: top + ' ' + P('L', to[0] + sd * (4 + o.lash * 10), to[1] - lw * .8, 'C', xo - sd * w * .1, tp[1] + h * .1 - lw * 1.3, cx + sd * w * .12, tp[1] + h * .04 - lw * 1.1, tp[0], tp[1] - lw * .7, 'C', xi + sd * w * .1, tp[1] - lw * .4, ti[0] - sd * 2, ti[1] - 2, ti[0], ti[1], 'Z'), fill: INK, stroke: INK, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, g);
      // lower lid: a short heavy tick at the outer corner, a thin line toward the middle
      E('path', { d: P('M', to[0] - sd * 2, to[1] + h * .2, 'C', xo - sd * w * .06, cy + h * .3, cx + sd * w * .14, cy + h * .42, cx - sd * w * .02, cy + h * .4), fill: 'none', stroke: INK, 'stroke-width': 2.5, 'stroke-linecap': 'round' }, g);
      E('path', { d: P('M', to[0] - sd * 1, to[1] + h * .18, 'L', xo - sd * w * .12, cy + h * .34), fill: 'none', stroke: INK, 'stroke-width': 5, 'stroke-linecap': 'round' }, g);
    }

    brow(g, o, ex, cx, by, sd) {
      const w = o.eyeW * 1.05;
      const xi = cx - sd * w * .46, xo = cx + sd * w * .58;
      const yi = by + 8 - ex.brow * 18, yo = by + 4 + ex.brow * 8;
      const ym = Math.min(yi, yo) - 10 + ex.brow * 6;
      E('path', { d: P('M', xi, yi, 'Q', cx, ym, xo, yo, 'Q', cx, ym + 7, xi, yi + 8, 'Z'), fill: o.hairStyle === 'swept' ? o.hairS : o.hair, stroke: INK, 'stroke-width': 2, 'stroke-linejoin': 'round' }, g);
    }

    mouth(g, o, ex, dx) {
      const m = ex.mouth, k = ex.open, y = 104;
      const st = { fill: 'none', stroke: INK, 'stroke-width': 3.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
      if (m === 'smile') {
        E('path', Object.assign({ d: P('M', dx - 28, y - 4, 'Q', dx, y + 14, dx + 28, y - 6) }, st), g);
        E('path', Object.assign({ d: P('M', dx - 32, y - 9, 'L', dx - 26, y - 2, 'M', dx + 32, y - 11, 'L', dx + 26, y - 4) }, st, { 'stroke-width': 2.5 }), g);
      } else if (m === 'soft') {
        E('path', Object.assign({ d: P('M', dx - 16, y, 'Q', dx, y + 7, dx + 16, y - 1) }, st), g);
      } else if (m === 'line') {
        E('path', Object.assign({ d: P('M', dx - 18, y + 2, 'L', dx + 18, y) }, st), g);
      } else if (m === 'frown') {
        E('path', Object.assign({ d: P('M', dx - 22, y + 8, 'Q', dx, y - 4, dx + 22, y + 8) }, st), g);
      } else if (m === 'grin' || m === 'open' || m === 'shout') {
        const W = m === 'grin' ? 34 : m === 'shout' ? 30 : 20, D = (m === 'grin' ? 30 : m === 'shout' ? 56 : 36) * (.4 + k * .6);
        const top = m === 'grin' ? P('M', dx - W, y - 6, 'Q', dx, y + 4, dx + W, y - 8) : P('M', dx - W, y - 4, 'Q', dx, y - 10, dx + W, y - 4);
        const shape = top + ' ' + P('Q', dx + W * 1.05, y + D, dx, y + D + 6, 'Q', dx - W * 1.05, y + D, dx - W, y - (m === 'grin' ? 6 : 4), 'Z');
        E('path', { d: shape, fill: '#5a1d22' }, g);
        const mc = E('g', { 'clip-path': clip(g, shape) }, g);
        E('ellipse', { cx: dx, cy: y + D + 2, rx: W * .7, ry: D * .45, fill: '#d6605a' }, mc);
        if (m === 'grin') E('rect', { x: dx - W, y: y - 20, width: W * 2, height: 18, fill: '#fffaf2' }, mc);
        E('path', Object.assign({ d: shape }, st, { 'stroke-width': 3 }), g);
      }
    }

    ageLines(g, o, ex, dx) {
      const a = o.age, st = { fill: 'none', stroke: INK, 'stroke-linecap': 'round', opacity: .5 * a };
      for (const sd of [-1, 1]) {
        const xo = sd * (o.eyeGap + o.eyeW * .56) + dx;
        E('path', Object.assign({ d: P('M', xo + sd * 2, -8, 'L', xo + sd * 16, -14, 'M', xo + sd * 2, 2, 'L', xo + sd * 16, 4) }, st, { 'stroke-width': 2.2 }), g);
        E('path', Object.assign({ d: P('M', sd * 28 + dx, 62, 'Q', sd * 48 + dx, 86, sd * 40 + dx, 110) }, st, { 'stroke-width': 2.6 }), g);
        E('path', Object.assign({ d: P('M', sd * (o.eyeGap - 18) + dx, o.eyeH * .52, 'Q', sd * o.eyeGap + dx, o.eyeH * .62, sd * (o.eyeGap + 18) + dx, o.eyeH * .5) }, st, { 'stroke-width': 2 }), g);
      }
    }

    specs(g, o, ex, dx) {
      const w = o.eyeW * 1.32, h = o.eyeH * 1.2;
      for (const sd of [-1, 1]) {
        const cx = sd * o.eyeGap + dx;
        E('rect', { x: cx - w / 2, y: -h / 2 - 4, width: w, height: h, rx: 14, fill: '#cfe6ff', 'fill-opacity': .12, stroke: o.frame, 'stroke-width': 4.5 }, g);
        E('path', { d: P('M', cx - w * .3, -h * .32, 'L', cx - w * .06, -h * .32 + 28), stroke: '#fff', 'stroke-width': 5, opacity: .6, 'stroke-linecap': 'round' }, g);
        E('path', { d: P('M', cx + sd * w / 2, -8, 'L', sd * 116, -14), stroke: o.frame, 'stroke-width': 4.5 }, g);
      }
      E('path', { d: P('M', -o.eyeGap + w / 2 + dx, -8, 'Q', dx, -18, o.eyeGap - w / 2 + dx, -8), fill: 'none', stroke: o.frame, 'stroke-width': 4.5 }, g);
    }

    tearsFx(g, o, ex, dx) {
      const t = ex.tears;
      for (const sd of [-1, 1]) {
        const x = sd * (o.eyeGap - 4) + dx, y0 = o.eyeH * .3, len = 30 + 150 * t;
        E('path', { d: P('M', x - 8, y0, 'C', x - 12, y0 + len * .4, x - 4, y0 + len * .8, x + 2, y0 + len, 'C', x + 10, y0 + len * .8, x + 12, y0 + len * .4, x + 8, y0, 'Z'), fill: '#a8dcff', stroke: '#4a8fc4', 'stroke-width': 2, opacity: .92 }, g);
        E('path', { d: P('M', x - 2, y0 + 10, 'Q', x - 4, y0 + len * .5, x, y0 + len * .8), fill: 'none', stroke: '#fff', 'stroke-width': 3, 'stroke-linecap': 'round', opacity: .9 }, g);
      }
    }
  }

  // ---------- effects ----------
  const FX = {
    // focus lines: thin wedges pointing at (cx, cy), the classic anime "impact" background
    speedLines(parent, cx, cy, r0, r1, n, color = '#fff', op = .5, seed = 1) {
      const R = rng(seed), g = E('g', { opacity: op }, parent);
      for (let i = 0; i < n; i++) {
        const a = (i + R() * .8) / n * Math.PI * 2, w = .006 + R() * .014, ri = r0 + R() * (r1 - r0) * .35;
        const p = (aa, r) => `${f(cx + Math.cos(aa) * r)} ${f(cy + Math.sin(aa) * r)}`;
        E('path', { d: `M ${p(a, ri)} L ${p(a - w, r1)} L ${p(a + w, r1)} Z`, fill: color }, g);
      }
      return g;
    },
    // parallel motion streaks
    streaks(parent, x, y, w, h, n, ang, color = '#fff', op = .6, seed = 2) {
      const R = rng(seed), g = E('g', { opacity: op, transform: `rotate(${ang} ${x + w / 2} ${y + h / 2})` }, parent);
      for (let i = 0; i < n; i++) {
        const yy = y + R() * h, len = w * (.3 + R() * .7), xx = x + R() * (w - len);
        E('path', { d: P('M', xx, yy, 'L', xx + len, yy - 2, 'L', xx + len, yy + 2, 'Z'), fill: color }, g);
      }
      return g;
    },
    sparkle(parent, x, y, r, color = '#fff', op = 1) {
      const k = r * .22;
      return E('path', { d: P('M', x, y - r, 'Q', x + k, y - k, x + r, y, 'Q', x + k, y + k, x, y + r, 'Q', x - k, y + k, x - r, y, 'Q', x - k, y - k, x, y - r, 'Z'), fill: color, opacity: op }, parent);
    },
    bokeh(parent, x, y, r, color, op = .4) {
      return E('circle', { cx: x, cy: y, r, fill: rad(parent, [[0, color, 1], [.7, color, .5], [1, color, 0]]), opacity: op }, parent);
    },
    // screentone dots as a pattern fill
    tone(parent, color = '#000', size = 14, r = 2.4) {
      const id = nid('tn');
      const p = E('pattern', { id, width: size, height: size, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defsOf(parent));
      E('circle', { cx: size / 2, cy: size / 2, r, fill: color }, p);
      return `url(#${id})`;
    },
    grain(parent, op = .08) {
      const id = nid('gr');
      const flt = E('filter', { id, x: 0, y: 0, width: '100%', height: '100%' }, defsOf(parent));
      E('feTurbulence', { type: 'fractalNoise', baseFrequency: .9, numOctaves: 2, seed: 4 }, flt);
      E('feColorMatrix', { values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .9 0' }, flt);
      return E('rect', { width: 1080, height: 1920, filter: `url(#${id})`, opacity: op }, parent);
    },
    blur(parent, sd) {
      const id = nid('bl');
      const flt = E('filter', { id, x: '-20%', y: '-20%', width: '140%', height: '140%' }, defsOf(parent));
      E('feGaussianBlur', { stdDeviation: sd }, flt);
      return `url(#${id})`;
    },
    lin, rad, clip, rng, curvy, poly, P,
  };

  window.Anime = { Bust, FX, E, INK, DEFAULTS };
// yt-toon patch: end of module wrapper
};
