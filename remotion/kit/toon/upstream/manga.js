// manga.js: busts in a bold adventure-manga look:
// thick ink, small round pupils, chunky brows, strong noses and jaws, huge toothy grins, fountain tears, hatching.
// Original characters only: no characters, symbols or logos from any series.
// Same API as Anime.Bust: new Manga.Bust(parent, look).draw(x, y, scale, expression). Head units: top -210, chin ~170, eye line 0.
// yt-toon patch: module wrapper (window and document are passed in), was an IIFE
export default (window, document) => {
  const { E, FX } = window.Anime;
  const { lin, clip, rng, curvy, P } = FX;
  const INK = '#151214';
  const f = n => +n.toFixed(1);

  const DEF = {
    head: 'lean', nose: 'small', skin: '#f8cfa4', skinS: '#e3a072', blushC: '#f07d6a',
    hair: '#3a2416', hairS: '#1e120b', hairH: '#8a6248', hairStyle: 'spiky',
    eyeW: 54, eyeH: 30, eyeGap: 52, pupil: 12, mouthW: 1,
    age: 0, glasses: false, frame: '#2a2a30', stubble: 0,
    outfit: 'kit', shirt: '#1f4fa8', shirtS: '#143a85', trim: '#f4b73b', badge: null,
    suit: '#1c2238', suitS: '#10142a', tie: '#24345e', collar: '#f6f3ea',
  };

  const HEADS = {
    square: j => P('M', -118, -60, 'C', -120, -150, -64, -210, 0, -210, 'C', 64, -210, 120, -150, 118, -60, 'L', 114, 36, 'C', 112, 78 + j * .3, 102, 104 + j * .6, 86, 124 + j * .8, 'L', 54, 158 + j, 'Q', 0, 176 + j, -54, 158 + j, 'L', -86, 124 + j * .8, 'C', -102, 104 + j * .6, -112, 78 + j * .3, -114, 36, 'Z'),
    lean: j => P('M', -112, -60, 'C', -114, -150, -62, -210, 0, -210, 'C', 62, -210, 114, -150, 112, -60, 'L', 108, 28, 'C', 106, 70 + j * .3, 94, 100 + j * .6, 72, 128 + j * .8, 'L', 24, 166 + j, 'Q', 0, 178 + j, -24, 166 + j, 'L', -72, 128 + j * .8, 'C', -94, 100 + j * .6, -106, 70 + j * .3, -108, 28, 'Z'),
    round: j => P('M', -120, -60, 'C', -122, -150, -64, -208, 0, -208, 'C', 64, -208, 122, -150, 120, -60, 'C', 122, 10, 114, 72 + j * .3, 94, 112 + j * .7, 'C', 72, 150 + j, 36, 168 + j, 0, 170 + j, 'C', -36, 168 + j, -72, 150 + j, -94, 112 + j * .7, 'C', -114, 72 + j * .3, -122, 10, -120, -60, 'Z'),
  };

  // parallel ink strokes inside a clip path: manga hatching for the darkest shadows
  function hatch(parent, d, x0, y0, x1, y1, gap = 9, ang = -35, w = 2.4, op = .8) {
    const g = E('g', { 'clip-path': clip(parent, d), opacity: op }, parent);
    const t = Math.tan(ang * Math.PI / 180), H = y1 - y0;
    for (let x = x0 - Math.abs(t * H); x < x1 + Math.abs(t * H); x += gap)
      E('path', { d: P('M', x, y0, 'L', x + t * H, y1), stroke: INK, 'stroke-width': w, 'stroke-linecap': 'round' }, g);
    return g;
  }

  class Bust {
    constructor(parent, o = {}) { this.o = Object.assign({}, DEF, o); this.g = E('g', {}, parent); }
    draw(x, y, s, ex = {}) {
      const o = this.o, g = this.g;
      ex = Object.assign({ eyes: 'open', look: [0, 0], lid: 0, brow: 0, mouth: 'smile', open: .7, tears: 0, fountain: false, blush: 0, sweat: false, shade: 0, glare: false, turn: 0, tilt: 0 }, ex);
      while (g.firstChild) g.firstChild.remove();
      g.setAttribute('transform', `translate(${x} ${y}) rotate(${ex.tilt}) scale(${s})`);
      const j = ex.mouth === 'grin' ? 22 * ex.open : (ex.mouth === 'shout' || ex.mouth === 'cry') ? 40 * ex.open : 0;
      const head = HEADS[o.head](j), dx = ex.turn * 18;
      this.j = j;
      this.body(g, o);
      // neck: thick, with the jaw's shadow and a few hatching strokes
      const neck = 'M -44 100 C -44 170 -48 214 -54 258 L 54 258 C 48 214 44 170 44 100 Z';
      E('path', { d: neck, fill: o.skin, stroke: INK, 'stroke-width': 5 }, g);
      const ns = 'M -46 110 C -20 186 20 186 46 110 L 48 204 C 20 220 -20 220 -48 204 Z';
      E('path', { d: ns, fill: o.skinS }, g);
      hatch(g, 'M -46 150 C -20 196 20 196 46 150 L 48 204 C 20 220 -20 220 -48 204 Z', -50, 150, 50, 220, 8, -30, 2.2, .55);
      this.hairBack(g, o);
      // ears: C shape with an inner curl
      for (const sd of [-1, 1]) {
        const e0 = sd * 110;
        E('path', { d: P('M', e0, -34, 'C', e0 + sd * 34, -50, e0 + sd * 40, 26, e0 + sd * 2, 40, 'Z'), fill: o.skin, stroke: INK, 'stroke-width': 5, 'stroke-linejoin': 'round' }, g);
        E('path', { d: P('M', e0 + sd * 8, -18, 'C', e0 + sd * 26, -24, e0 + sd * 26, 14, e0 + sd * 10, 20, 'M', e0 + sd * 12, -4, 'Q', e0 + sd * 18, 4, e0 + sd * 10, 8), fill: 'none', stroke: INK, 'stroke-width': 3, 'stroke-linecap': 'round' }, g);
      }
      // face: flat colour, one hard shadow on the far side, hatching at the jaw
      E('path', { d: head, fill: o.skin }, g);
      const fc = E('g', { 'clip-path': clip(g, head) }, g);
      const t = ex.turn * 22;
      const shadow = P('M', 58 - t, -210, 'C', 92 - t, -120, 100 - t, -10, 86 - t, 70, 'C', 76 - t, 110, 52 - t, 150, 10, 178, 'L', 200, 178, 'L', 200, -210, 'Z');
      E('path', { d: shadow, fill: o.skinS }, fc);
      hatch(fc, P('M', 96 - t, 40, 'C', 90 - t, 100, 62 - t, 140, 20, 178, 'L', 200, 178, 'L', 200, 40, 'Z'), 0, 40, 130, 180, 9, -38, 2.4, .6);
      this.foreheadShadow(fc, o);
      if (ex.shade) E('rect', { x: -130, y: -90, width: 260, height: 70 + 30 * ex.shade, fill: INK, opacity: .3 * ex.shade }, fc);
      if (o.stubble) {
        const R = rng(12);
        for (let i = 0; i < 70; i++) {
          const a = R() * Math.PI, r = 110 + R() * 50;
          const px = Math.cos(a) * 92 * (r / 150), py = 70 + Math.sin(a) * 96 * (r / 150);
          if (Math.abs(px) < 34 && py < 132 && py > 96) continue;
          E('circle', { cx: f(px), cy: f(py), r: 1.8, fill: INK, opacity: .45 * o.stubble }, fc);
        }
      }
      if (ex.blush > 0) for (const sd of [-1, 1]) for (let k = 0; k < 4; k++)
        E('line', { x1: sd * 52 + dx + k * 10, y1: 66, x2: sd * 52 + dx + k * 10 + 8, y2: 50, stroke: o.blushC, 'stroke-width': 3.5, opacity: ex.blush, 'stroke-linecap': 'round' }, fc);
      E('path', { d: head, fill: 'none', stroke: INK, 'stroke-width': 6, 'stroke-linejoin': 'round' }, g);
      if (o.age > 0) this.ageLines(g, o, ex, dx);
      for (const sd of [-1, 1]) this.eye(g, o, ex, sd * o.eyeGap + dx, 0, sd);
      for (const sd of [-1, 1]) this.brow(g, o, ex, sd * o.eyeGap + dx, -o.eyeH - 16, sd);
      this.nose(g, o, ex, dx);
      if (ex.tears > 0) this.streams(g, o, ex, dx);
      this.mouth(g, o, ex, dx);
      this.hairFront(g, o);
      if (o.glasses) this.specs(g, o, ex, dx);
      if (ex.tears > 0) this.tearsFx(g, o, ex, dx);
      if (ex.sweat) this.sweatFx(g, o);
      return this;
    }

    body(g0, o) {
      const g = E('g', { transform: 'translate(0 -18)' }, g0);
      const torso = 'M -50 226 C -150 236 -260 266 -304 340 L -340 790 L 340 790 L 304 340 C 260 266 150 236 50 226 Z';
      const ink = { stroke: INK, 'stroke-width': 6, 'stroke-linejoin': 'round' };
      if (o.outfit === 'suit') {
        E('path', Object.assign({ d: torso, fill: o.suit }, ink), g);
        E('path', { d: 'M 120 220 C 190 310 210 520 190 800 L 360 800 L 360 220 Z', fill: o.suitS, 'clip-path': clip(g, torso) }, g);
        E('path', Object.assign({ d: 'M -58 222 L 0 380 L 58 222 Z', fill: o.collar }, ink, { 'stroke-width': 5 }), g);
        E('path', Object.assign({ d: 'M -16 252 L 16 252 L 22 280 L 32 440 L 0 474 L -32 440 L -22 280 Z', fill: o.tie }, ink, { 'stroke-width': 4.5 }), g);
        E('path', Object.assign({ d: 'M -20 242 L 20 242 L 23 280 L -23 280 Z', fill: o.tie }, ink, { 'stroke-width': 4.5 }), g);
        for (const sd of [-1, 1]) {
          E('path', Object.assign({ d: P('M', sd * 58, 220, 'L', sd * 4, 392, 'L', sd * 74, 346, 'L', sd * 54, 314, 'L', sd * 116, 280, 'L', sd * 100, 236, 'Z'), fill: o.suit }, ink, { 'stroke-width': 5 }), g);
          E('path', { d: P('M', sd * 4, 392, 'L', sd * 40, 600), fill: 'none', stroke: INK, 'stroke-width': 4.5 }, g);
        }
        E('path', { d: 'M -44 224 L -24 264 L 0 248 L 24 264 L 44 224', fill: 'none', stroke: INK, 'stroke-width': 4.5 }, g);
      } else {
        E('path', Object.assign({ d: torso, fill: o.shirt }, ink), g);
        const bc = E('g', { 'clip-path': clip(g, torso) }, g);
        E('path', { d: 'M 110 222 C 200 310 220 530 200 800 L 360 800 L 360 222 Z', fill: o.shirtS }, bc);
        E('path', { d: 'M -200 440 C -170 540 -170 640 -190 790 M 150 350 C 170 420 160 490 140 540', fill: 'none', stroke: INK, 'stroke-width': 4, 'stroke-linecap': 'round', opacity: .7 }, bc);
        E('path', Object.assign({ d: 'M -58 222 L 0 300 L 58 222 L 44 218 L 0 278 L -44 218 Z', fill: o.trim }, ink, { 'stroke-width': 4.5 }), g);
        if (o.badge) o.badge(g, 150, 350, 1);
      }
    }

    hairBack(g, o) {
      if (o.hairStyle === 'swept') E('path', { d: curvy([[-120, -6], [-150, -100], [-168, -146, 1], [-136, -194], [-142, -226, 1], [-80, -238], [-40, -254, 1], [10, -244], [66, -256, 1], [108, -234], [146, -226, 1], [142, -192], [172, -146, 1], [150, -100], [122, -6]]), fill: o.hairS, stroke: INK, 'stroke-width': 5, 'stroke-linejoin': 'round' }, g);
    }

    foreheadShadow(fc, o) {
      const st = o.hairStyle;
      if (st === 'swept') E('path', { d: 'M -104 -100 C -84 -104 -70 -106 -58 -116 C -40 -128 -20 -124 0 -116 C 20 -124 40 -128 58 -116 C 70 -106 84 -104 104 -100 L 120 -220 L -120 -220 Z', fill: o.skinS }, fc);
      else if (st === 'spiky') E('path', { d: 'M -120 -74 L -98 -62 L -86 -94 L -58 -66 L -42 -108 L -8 -80 L 16 -112 L 54 -86 L 80 -114 L 120 -96 L 120 -220 L -120 -220 Z', fill: o.skinS }, fc);
      else if (st === 'buzz') E('path', { d: 'M -124 -86 C -80 -104 -40 -110 0 -110 C 40 -110 80 -104 124 -86 L 124 -220 L -124 -220 Z', fill: o.skinS }, fc);
    }

    hairFront(g, o) {
      const st = o.hairStyle, ink = { stroke: INK, 'stroke-width': 6, 'stroke-linejoin': 'round' };
      if (st === 'swept') {
        // big combed-back locks with flicks, hard grey shadow clumps, hatching, white shine strips
        const pts = [[-110, -6, 1], [-124, -60], [-138, -126], [-156, -146, 1], [-126, -168], [-126, -198], [-130, -216, 1], [-86, -222], [-56, -240, 1], [-18, -232], [12, -246, 1], [42, -234], [78, -242, 1], [98, -220], [130, -214, 1], [126, -192], [158, -148, 1], [140, -128], [124, -60], [112, -6, 1],
          [102, -34], [96, -90], [86, -114, 1], [56, -116], [28, -132], [0, -122, 1], [-28, -132], [-56, -116], [-86, -114, 1], [-98, -90], [-102, -34]];
        const d = curvy(pts);
        E('path', Object.assign({ d, fill: o.hair }, ink), g);
        const hc = E('g', { 'clip-path': clip(g, d) }, g);
        [[-86, -114, -116, -166, -130, -216], [-56, -116, -68, -184, -56, -240], [-28, -132, -10, -192, 12, -246], [28, -132, 50, -192, 78, -242], [56, -116, 104, -166, 130, -214], [86, -114, 124, -128, 158, -148]]
          .forEach(([x0, y0, x1, y1, x2, y2], i) => {
            E('path', { d: P('M', x0, y0, 'Q', x1, y1, x2, y2, 'Q', x1 + 22, y1 + 14, x0 + 18, y0 + 2, 'Z'), fill: o.hairS }, hc);
            E('path', { d: P('M', x0, y0, 'Q', x1, y1, x2, y2), fill: 'none', stroke: INK, 'stroke-width': 4, 'stroke-linecap': 'round' }, hc);
          });
        hatch(hc, 'M 60 -300 L 220 -300 L 220 0 L 110 0 C 130 -120 110 -220 60 -300 Z', 40, -300, 220, 0, 9, 30, 2.4, .5);
        for (const [a, b, c] of [[-70, -180, -40], [0, -210, 30], [60, -190, 90]])
          E('path', { d: P('M', a, b, 'L', c, b - 26, 'L', c + 8, b - 18, 'L', a + 10, b + 8, 'Z'), fill: o.hairH }, hc);
      } else if (st === 'spiky') {
        const pts = [[-124, -8, 1], [-130, -80], [-136, -132, 1], [-110, -146], [-112, -194, 1], [-82, -192], [-70, -236, 1], [-38, -214], [-6, -252, 1], [18, -222], [54, -244, 1], [70, -214], [110, -214, 1], [102, -178], [140, -144, 1], [128, -110], [126, -8, 1],
          [114, -28], [112, -76], [104, -102, 1], [80, -114, 1], [54, -86, 1], [16, -112, 1], [-8, -80, 1], [-42, -108, 1], [-58, -66, 1], [-86, -94, 1], [-98, -62, 1], [-110, -80], [-112, -28]];
        const d = curvy(pts);
        E('path', Object.assign({ d, fill: o.hair }, ink), g);
        const hc = E('g', { 'clip-path': clip(g, d) }, g);
        // solid dark clumps on the far side of each spike, the manga "spot black"
        [[-86, -94, -106, -146, -112, -194], [-42, -108, -60, -180, -70, -236], [16, -112, 4, -190, -6, -252], [80, -114, 70, -186, 54, -244], [104, -102, 116, -164, 140, -144]].forEach(([x0, y0, x1, y1, x2, y2]) =>
          E('path', { d: P('M', x0, y0, 'Q', x1, y1, x2, y2, 'Q', x1 + 24, y1 + 10, x0 + 22, y0 + 4, 'Z'), fill: o.hairS }, hc));
        for (const [a, b] of [[-90, -150], [-30, -186], [30, -190], [90, -160]])
          E('path', { d: P('M', a, b, 'L', a + 16, b - 34, 'L', a + 24, b - 30, 'L', a + 10, b + 4, 'Z'), fill: o.hairH }, hc);
      } else if (st === 'buzz') {
        const d = 'M -124 -40 C -130 -152 -76 -214 0 -216 C 76 -214 130 -152 124 -40 L 114 -44 C 110 -76 102 -92 94 -100 C 60 -112 30 -118 0 -118 C -30 -118 -60 -112 -94 -100 C -102 -92 -110 -76 -114 -44 Z';
        E('path', Object.assign({ d, fill: o.hair }, ink), g);
        const hc = E('g', { 'clip-path': clip(g, d) }, g);
        E('path', { d: 'M -78 -176 C -40 -198 20 -200 64 -184 L 58 -170 C 20 -184 -36 -182 -70 -164 Z', fill: o.hairH }, hc);
      }
    }

    eye(g, o, ex, cx, cy, sd) {
      const w = o.eyeW, xi = cx - sd * w * .5, xo = cx + sd * w * .5;
      const thick = { fill: 'none', stroke: INK, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
      if (ex.eyes === 'happy') { E('path', Object.assign({ d: P('M', xo, cy + 8, 'Q', cx, cy - 26, xi, cy + 8) }, thick, { 'stroke-width': 9 }), g); return; }
      if (ex.eyes === 'closed') {
        // squeezed shut, the crying face: a heavy curve with creases above and below
        E('path', Object.assign({ d: P('M', xo + sd * 4, cy - 10, 'Q', cx, cy + 6, xi, cy - 2) }, thick, { 'stroke-width': 9 }), g);
        E('path', Object.assign({ d: P('M', xo + sd * 2, cy - 22, 'L', xo + sd * 16, cy - 30, 'M', xo, cy + 4, 'L', xo + sd * 14, cy + 12) }, thick, { 'stroke-width': 3.5 }), g);
        return;
      }
      const wide = ex.eyes === 'wide', fierce = ex.eyes === 'fierce';
      const h = o.eyeH * (wide ? 1.5 : 1) * (1 - ex.lid * .5) * (fierce ? .75 : 1);
      const top = P('M', xi, cy + 4, 'Q', cx - sd * w * .1, cy - h * 1.05, xo + sd * 4, cy - h * .3);
      const shape = top + ' ' + P('Q', cx, cy + h * .75, xi, cy + 4, 'Z');
      E('path', { d: shape, fill: '#fffdf6' }, g);
      const ec = E('g', { 'clip-path': clip(g, shape) }, g);
      const pr = o.pupil * (wide ? .55 : fierce ? .8 : 1);
      const px = cx + ex.look[0] * w * .2 - sd * 2, py = cy - h * .12 + ex.look[1] * h * .3;
      E('circle', { cx: px, cy: py, r: pr, fill: INK }, ec);
      E('circle', { cx: px - pr * .38, cy: py - pr * .4, r: Math.max(2.5, pr * .3), fill: '#fff' }, ec);
      if (fierce || ex.shade) E('path', { d: top + ' ' + P('L', xo + sd * 4, cy - h * .3 + 12, 'Q', cx - sd * w * .1, cy - h * 1.05 + 14, xi, cy + 14, 'Z'), fill: INK, opacity: .35 }, ec);
      E('path', Object.assign({ d: top }, thick, { 'stroke-width': 7 }), g);
      E('path', Object.assign({ d: P('M', xo + sd * 2, cy - h * .3, 'L', xo + sd * 12, cy - h * .52) }, thick, { 'stroke-width': 5 }), g);
      E('path', Object.assign({ d: P('M', xo - sd * 4, cy + h * .2, 'Q', cx + sd * w * .1, cy + h * .62, cx - sd * w * .12, cy + h * .56) }, thick, { 'stroke-width': 3 }), g);
    }

    brow(g, o, ex, cx, by, sd) {
      const w = o.eyeW * 1.2, xi = cx - sd * w * .46, xo = cx + sd * w * .56;
      const fierce = ex.eyes === 'fierce' ? -.8 : 0, b = ex.brow + fierce;
      const yi = by + 10 - b * 20, yo = by - 2 + b * 6, th = 15, tho = 9;
      const col = o.hairStyle === 'swept' ? o.hairS : o.hair;
      E('path', { d: P('M', xi, yi, 'L', xo, yo, 'L', xo - sd * 4, yo + tho, 'L', xi + sd * 2, yi + th, 'Z'), fill: col, stroke: INK, 'stroke-width': 4, 'stroke-linejoin': 'round' }, g);
    }

    nose(g, o, ex, dx) {
      const st = { fill: 'none', stroke: INK, 'stroke-width': 4.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
      if (o.nose === 'long') {
        E('path', { d: P('M', dx + 2, 14, 'C', dx + 16, 40, dx + 26, 62, dx + 14, 76, 'Q', dx + 2, 82, dx - 8, 72, 'L', dx + 2, 14, 'Z'), fill: o.skinS }, g);
        E('path', Object.assign({ d: P('M', dx + 4, 12, 'C', dx + 18, 40, dx + 28, 62, dx + 14, 76, 'Q', dx + 2, 82, dx - 10, 72) }, st), g);
        E('path', Object.assign({ d: P('M', dx - 18, 70, 'Q', dx - 26, 76, dx - 16, 82) }, st, { 'stroke-width': 3 }), g);
      } else if (o.nose === 'wide') {
        E('path', Object.assign({ d: P('M', dx - 22, 62, 'Q', dx - 30, 74, dx - 14, 78, 'Q', dx, 84, dx + 14, 78, 'Q', dx + 30, 74, dx + 22, 62) }, st), g);
        E('path', { d: P('M', dx + 6, 26, 'L', dx + 20, 60, 'L', dx + 6, 58, 'Z'), fill: o.skinS }, g);
      } else {
        E('path', { d: P('M', dx + 4, 30, 'L', dx + 18, 64, 'L', dx + 2, 66, 'Z'), fill: o.skinS }, g);
        E('path', Object.assign({ d: P('M', dx + 8, 36, 'L', dx + 18, 64, 'L', dx + 2, 66) }, st, { 'stroke-width': 4 }), g);
      }
    }

    mouth(g, o, ex, dx) {
      const m = ex.mouth, k = ex.open, y = 108, W = 76 * o.mouthW, J = this.j || 0;
      const st = { fill: 'none', stroke: INK, 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
      const teeth = (mc, yTop, yBot, x0, x1, n) => {
        E('rect', { x: x0, y: yTop - 40, width: x1 - x0, height: yBot - yTop + 40, fill: '#fffdf6' }, mc);
        for (let i = 1; i < n; i++) { const xx = x0 + (x1 - x0) * i / n; E('line', { x1: xx, y1: yTop - 40, x2: xx, y2: yBot, stroke: INK, 'stroke-width': 2.5 }, mc); }
        E('line', { x1: x0, y1: yBot, x2: x1, y2: yBot, stroke: INK, 'stroke-width': 3 }, mc);
      };
      if (m === 'smile') {
        E('path', Object.assign({ d: P('M', dx - 34, y - 6, 'Q', dx, y + 16, dx + 34, y - 8) }, st), g);
        E('path', Object.assign({ d: P('M', dx - 40, y - 14, 'Q', dx - 34, y - 6, dx - 36, y + 2, 'M', dx + 40, y - 16, 'Q', dx + 34, y - 8, dx + 36, y) }, st, { 'stroke-width': 3.5 }), g);
      } else if (m === 'smirk') {
        E('path', Object.assign({ d: P('M', dx - 26, y + 2, 'Q', dx + 4, y + 8, dx + 32, y - 12) }, st), g);
      } else if (m === 'line') {
        E('path', Object.assign({ d: P('M', dx - 24, y + 2, 'L', dx + 24, y - 2) }, st), g);
      } else if (m === 'frown') {
        E('path', Object.assign({ d: P('M', dx - 28, y + 10, 'Q', dx, y - 6, dx + 28, y + 10) }, st), g);
      } else if (m === 'grin') {
        // the huge toothy grin: corners up near the cheeks, two rows of block teeth
        const D = 30 + 22 * k + J;
        const shape = P('M', dx - W, y - 22, 'Q', dx, y + 8, dx + W, y - 22, 'Q', dx + W * .9, y + D, dx, y + D + 8, 'Q', dx - W * .9, y + D, dx - W, y - 22, 'Z');
        E('path', { d: shape, fill: '#3a0e12' }, g);
        const mc = E('g', { 'clip-path': clip(g, shape) }, g);
        E('ellipse', { cx: dx, cy: y + D + 2, rx: W * .55, ry: D * .3, fill: '#d4524a' }, mc);
        teeth(mc, y - 8, y + 14, dx - W, dx + W, 10);
        const lb = E('g', { transform: `translate(0 ${D - 6})` }, mc);
        E('rect', { x: dx - W, y: y + 6, width: W * 2, height: 40, fill: '#fffdf6' }, lb);
        for (let i = 1; i < 9; i++) { const xx = dx - W + W * 2 * i / 9; E('line', { x1: xx, y1: y + 6, x2: xx, y2: y + 46, stroke: INK, 'stroke-width': 2.5 }, lb); }
        E('line', { x1: dx - W, y1: y + 6, x2: dx + W, y2: y + 6, stroke: INK, 'stroke-width': 3 }, lb);
        E('path', Object.assign({ d: shape }, st, { 'stroke-width': 5.5 }), g);
        E('path', Object.assign({ d: P('M', dx - W - 4, y - 36, 'Q', dx - W + 4, y - 22, dx - W - 4, y - 8, 'M', dx + W + 4, y - 36, 'Q', dx + W - 4, y - 22, dx + W + 4, y - 8) }, st, { 'stroke-width': 4 }), g);
      } else if (m === 'shout' || m === 'cry') {
        // wide open: shout is an oval, cry is a wobbling trapezoid with the corners pulled down
        const D = 26 + 20 * k + J, Wc = m === 'cry' ? W * 1.0 : W * .62;
        const shape = m === 'cry'
          ? P('M', dx - Wc, y - 4, 'Q', dx, y - 20, dx + Wc, y - 4, 'L', dx + Wc * .7, y + D, 'Q', dx + Wc * .3, y + D + 10, dx, y + D + 2, 'Q', dx - Wc * .3, y + D + 10, dx - Wc * .7, y + D, 'Z')
          : P('M', dx - Wc, y - 6, 'Q', dx, y - 22, dx + Wc, y - 6, 'Q', dx + Wc * 1.1, y + D, dx, y + D + 8, 'Q', dx - Wc * 1.1, y + D, dx - Wc, y - 6, 'Z');
        E('path', { d: shape, fill: '#3a0e12' }, g);
        const mc = E('g', { 'clip-path': clip(g, shape) }, g);
        E('ellipse', { cx: dx, cy: y + D, rx: Wc * .6, ry: D * .32, fill: '#d4524a' }, mc);
        teeth(mc, y - 14, y + 4, dx - Wc, dx + Wc, m === 'cry' ? 8 : 6);
        if (m === 'shout') { E('rect', { x: dx - Wc, y: y + D - 8, width: Wc * 2, height: 30, fill: '#fffdf6' }, mc); E('line', { x1: dx - Wc, y1: y + D - 8, x2: dx + Wc, y2: y + D - 8, stroke: INK, 'stroke-width': 3 }, mc); }
        E('path', Object.assign({ d: shape }, st, { 'stroke-width': 5.5 }), g);
      }
    }

    ageLines(g, o, ex, dx) {
      const a = o.age, st = { fill: 'none', stroke: INK, 'stroke-linecap': 'round', opacity: .85 * a };
      for (const sd of [-1, 1]) {
        E('path', Object.assign({ d: P('M', sd * 30 + dx, 66, 'Q', sd * 58 + dx, 92, sd * 52 + dx, 124) }, st, { 'stroke-width': 4 }), g);
        E('path', Object.assign({ d: P('M', sd * 80 + dx, 30, 'Q', sd * 90 + dx, 60, sd * 84 + dx, 86) }, st, { 'stroke-width': 3 }), g);
        const xo = sd * (o.eyeGap + o.eyeW * .56) + dx;
        E('path', Object.assign({ d: P('M', xo + sd * 4, -6, 'L', xo + sd * 18, -12, 'M', xo + sd * 4, 6, 'L', xo + sd * 18, 8) }, st, { 'stroke-width': 3 }), g);
      }
      E('path', Object.assign({ d: P('M', dx - 30, -88, 'Q', dx, -94, dx + 30, -88) }, st, { 'stroke-width': 3 }), g);
    }

    specs(g, o, ex, dx) {
      const w = o.eyeW * 1.45, h = o.eyeH * 1.9;
      for (const sd of [-1, 1]) {
        const cx = sd * o.eyeGap + dx;
        E('rect', { x: cx - w / 2, y: -h / 2 - 6, width: w, height: h, rx: 10, fill: '#dff0ff', 'fill-opacity': ex.glare ? .9 : .1, stroke: o.frame, 'stroke-width': 6 }, g);
        if (ex.glare) E('path', { d: P('M', cx - w / 2 + 6, -h / 2, 'L', cx + w / 2 - 6, -h / 2, 'L', cx + w / 2 - 6, -h / 2 + 18, 'L', cx - w / 2 + 6, h / 2 - 12, 'Z'), fill: '#fff' }, g);
        else E('path', { d: P('M', cx - w * .28, -h * .34, 'L', cx - w * .02, -h * .34 + 30), stroke: '#fff', 'stroke-width': 6, opacity: .7, 'stroke-linecap': 'round' }, g);
        E('path', { d: P('M', cx + sd * w / 2, -14, 'L', sd * 112, -20), stroke: o.frame, 'stroke-width': 6 }, g);
      }
      E('path', { d: P('M', -o.eyeGap + w / 2 + dx, -12, 'Q', dx, -24, o.eyeGap - w / 2 + dx, -12), fill: 'none', stroke: o.frame, 'stroke-width': 6 }, g);
    }

    tearsFx(g, o, ex, dx) {
      const t = ex.tears, blue = '#8fd3ff';
      for (const sd of [-1, 1]) {
        const x = sd * (o.eyeGap + o.eyeW * .3) + dx, y0 = 2;
        if (ex.fountain) {
          // two arcs of tears gushing out sideways, landing in drops
          const x2 = x + sd * (120 + 120 * t), y2 = y0 + 160 + 160 * t, cx = x + sd * (90 + 60 * t), cy = y0 - 90 * t;
          const d = P('M', x, y0, 'Q', cx, cy, x2, y2);
          E('path', { d, fill: 'none', stroke: INK, 'stroke-width': 30, 'stroke-linecap': 'round' }, g);
          E('path', { d, fill: 'none', stroke: blue, 'stroke-width': 22, 'stroke-linecap': 'round' }, g);
          E('path', { d: P('M', x + sd * 10, y0 - 8, 'Q', cx, cy - 6, x2 - sd * 10, y2 - 30), fill: 'none', stroke: '#fff', 'stroke-width': 5, 'stroke-linecap': 'round', opacity: .9 }, g);
          for (let i = 0; i < 3; i++) E('circle', { cx: x2 + sd * (14 + i * 18), cy: y2 + 24 + i * 22, r: 9 - i * 2, fill: blue, stroke: INK, 'stroke-width': 3 }, g);
        }
      }
    }

    streams(g, o, ex, dx) {
      const t = ex.tears, blue = '#8fd3ff';
      for (const sd of [-1, 1]) {
        const len = 60 + 120 * t, xs = sd * (o.eyeGap + 6) + dx;
        const d2 = P('M', xs - 9, 10, 'C', xs - 14, 10 + len * .5, xs - 6, 10 + len * .85, xs, 10 + len, 'C', xs + 8, 10 + len * .85, xs + 14, 10 + len * .5, xs + 9, 10, 'Z');
        E('path', { d: d2, fill: blue, stroke: INK, 'stroke-width': 3.5 }, g);
        E('path', { d: P('M', xs - 2, 20, 'Q', xs - 4, 10 + len * .5, xs, 10 + len * .8), fill: 'none', stroke: '#fff', 'stroke-width': 3.5, 'stroke-linecap': 'round' }, g);
      }
    }

    sweatFx(g, o) {
      E('path', { d: 'M 112 -150 C 96 -116 94 -92 112 -84 C 130 -92 128 -116 112 -150 Z', fill: '#bfe6ff', stroke: INK, 'stroke-width': 4 }, g);
      E('path', { d: 'M 106 -118 Q 104 -106 108 -100', fill: 'none', stroke: '#fff', 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
      for (const [x1, y1, x2, y2] of [[-150, -110, -176, -126], [-154, -80, -184, -84], [150, -40, 178, -48]])
        E('line', { x1, y1, x2, y2, stroke: INK, 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
    }
  }

  // sound-effect lettering: heavy, tilted, double outline
  function sfx(parent, x, y, text, size = 120, rot = -8, fill = '#ffd97a') {
    const g = E('g', { transform: `rotate(${rot} ${x} ${y})` }, parent);
    const base = { x, y, 'text-anchor': 'middle', 'font-family': 'Bangers', 'font-size': size, 'letter-spacing': 4 };
    E('text', Object.assign({ fill: '#fff', stroke: '#fff', 'stroke-width': size * .32, 'stroke-linejoin': 'round' }, base), g).textContent = text;
    E('text', Object.assign({ fill, stroke: INK, 'stroke-width': size * .16, 'stroke-linejoin': 'round', 'paint-order': 'stroke' }, base), g).textContent = text;
    return g;
  }

  window.Manga = { Bust, hatch, sfx, INK, DEF };
// yt-toon patch: end of module wrapper
};
