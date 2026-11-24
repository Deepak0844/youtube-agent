// Toon: cartoon characters as 2D puppets in SVG (the "comic" style).
// A pose is a set of joint angles in degrees. Limbs: 0 = pointing down, +90 = pointing forward (the way the
// character faces), 180 = up. Upper arms are relative to the torso; forearms and shins relative to the segment
// above (elbow +: bends forward, knee -: bends back). tor = forward lean, hd = head tilt (chin down +).
// n* = near limbs (drawn over the body), f* = far limbs (behind it). turn: 0 side view .. 1 front view.
// The rig stands on its lowest point (feet or knees) at the root's y, unless lift raises it.
// yt-toon patch: module wrapper (window and document are passed in), was an IIFE
export default (window, document) => {
  const NS = 'http://www.w3.org/2000/svg', R = Math.PI / 180;
  const E = (tag, a = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (parent) parent.appendChild(e); return e; };
  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const n1 = x => Math.round(x * 10) / 10;
  const pt = p => n1(p[0]) + ',' + n1(p[1]);
  const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
  const OL = '#17111b', OW = 6;

  const BASE = {tor: 3, hd: 0, nua: 8, nfa: 12, fua: -8, ffa: 16, nth: 3, nsh: -3, fth: -3, fsh: -5, nft: 0, fft: 0,
    turn: .35, lift: 0, look: 0, blink: 0, tears: 0, sq: 1, open: 0};
  const NUMS = Object.keys(BASE);
  const FACE = {face: 'neutral', hand: 'fist', fhand: 'fist'};

  // brows [inner, outer] offsets (px, + = lower), eye shape, mouth shape
  const FACES = {
    neutral: {b: [0, 0], eye: 'open', m: 'flat'},
    focus: {b: [7, -3], eye: 'open', m: 'flat'},
    grit: {b: [9, -4], eye: 'squint', m: 'grit'},
    shout: {b: [10, -5], eye: 'squint', m: 'shout'},
    roar: {b: [10, -6], eye: 'closed', m: 'shout'},
    sad: {b: [-7, 3], eye: 'down', m: 'frown'},
    cry: {b: [-10, 4], eye: 'closed', m: 'cry'},
    smile: {b: [-3, -2], eye: 'open', m: 'smile'},
    grin: {b: [-4, -3], eye: 'happy', m: 'grin'},
    wow: {b: [-9, -7], eye: 'wide', m: 'o'},
    worry: {b: [-8, 2], eye: 'open', m: 'frown'},
  };

  class Toon {
    constructor(parent, o = {}) {
      this.o = o = Object.assign({skin: '#8a5a3c', skinD: '#6a3f28', shirt: '#7a1f3d', shirtD: '#5a142c', trim: '#ffb81c',
        num: '23', numFill: '#ffb81c', shorts: null, shortsD: null, pants: null, shoe: '#f5f2ea', shoeD: '#d8d1c2', sole: '#2a2230',
        sock: '#f5f2ea', band: null, hair: '#1c1412', beard: false, headband: null, top: 'tank', legs: 'shorts', kid: false,
        build: 1, hairStyle: 'short', cap: null, whistle: false, scale: 1, glasses: null, sleeve: null, sleeveColor: '#f5f2ea', back: false}, o);
      o.shorts = o.shorts || o.shirt; o.shortsD = o.shortsD || o.shirtD;
      const k = o.kid ? .6 : 1, kw = o.kid ? .74 : 1;
      this.L = {th: 114 * k, sh: 116 * k, ua: 92 * k, fa: 84 * k, tor: 180 * (o.kid ? .62 : 1), neck: 10 * k,
        hr: 56 * (o.kid ? .88 : 1), hand: 21 * kw, foot: 58 * kw};
      this.W = {th: 50 * kw, sh: 37 * kw, ua: 38 * kw * o.build, fa: 32 * kw * o.build, neck: 34 * kw * o.build};
      this.root = E('g', {class: 'toon'}, parent);
      this.body = E('g', {}, this.root);
      const b = this.body;
      this.fArm = this.mkArm(b, false);
      this.fLeg = this.mkLeg(b, false);
      this.tor = this.mkTorso(b);
      this.seat = E('path', {fill: o.legs === 'pants' ? o.pants : o.shorts, stroke: OL, 'stroke-width': OW, 'stroke-linejoin': 'round'}, b);
      this.seatTrim = E('path', {fill: 'none', stroke: o.trim, 'stroke-width': 6, 'stroke-linecap': 'round'}, b);
      if (o.legs === 'pants') this.seatTrim.style.display = 'none';
      this.nLeg = this.mkLeg(b, true);
      this.head = this.mkHead(b);
      this.nArm = this.mkArm(b, true);
      this.props = E('g', {}, b);      // things held (drawn over the near arm)
      this.p = Object.assign({}, BASE, FACE);
      this.pts = {};
    }

    line(g, color, w, cap = 'round') {
      return E('path', {fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': cap, 'stroke-linejoin': 'round'}, g);
    }

    mkArm(parent, near) {
      const o = this.o, W = this.W, g = E('g', {}, parent), a = {g, near};
      const sleeveLong = o.top === 'polo' || o.top === 'shirt' || o.top === 'suit';
      const armCol = sleeveLong ? o.shirt : o.skin;
      a.olU = this.line(g, OL, W.ua + 2 * OW);
      a.olF = this.line(g, OL, W.fa + 2 * OW);
      a.olH = E('ellipse', {fill: OL}, g);
      a.olT = E('ellipse', {fill: OL}, g);
      a.fU = this.line(g, armCol, W.ua);
      a.fF = this.line(g, armCol, W.fa);
      a.sh = this.line(g, sleeveLong ? o.shirtD : o.skinD, W.fa * .34);
      if (o.top === 'tee') { a.slO = this.line(g, OL, W.ua + 10 + 2 * OW); a.sl = this.line(g, o.shirt, W.ua + 10); }
      if (sleeveLong) { a.cuff = this.line(g, o.top === 'suit' ? '#f4f1ea' : o.shirtD, W.fa + 1, 'butt'); }
      if (o.band) a.band = this.line(g, o.band, W.fa + 2, 'butt');
      if (o.sleeve === (near ? 'near' : 'far')) a.slv = this.line(g, o.sleeveColor, W.fa + 1);
      a.hT = E('ellipse', {fill: o.skin}, g);
      a.h = E('ellipse', {fill: o.skin}, g);
      a.hl = this.line(g, o.skinD, 3);
      return a;
    }

    mkLeg(parent, near) {
      const o = this.o, W = this.W, g = E('g', {}, parent), l = {g, near};
      const pants = o.legs === 'pants';
      const col = pants ? o.pants : o.skin;
      l.olT = this.line(g, OL, W.th + 2 * OW + (pants ? 8 : 0));
      l.olS = this.line(g, OL, W.sh + 2 * OW + (pants ? 8 : 0));
      l.fT = this.line(g, col, W.th + (pants ? 8 : 0));
      l.fS = this.line(g, col, W.sh + (pants ? 8 : 0));
      l.sh = this.line(g, pants ? 'rgba(0,0,0,.18)' : o.skinD, W.sh * .3);
      if (!pants && o.sock) l.sock = this.line(g, o.sock, W.sh + 1, 'butt');
      l.shoe = E('path', {fill: o.shoe, stroke: OL, 'stroke-width': OW, 'stroke-linejoin': 'round'}, g);
      l.shoeD = E('path', {fill: o.shoeD}, g);
      l.sole = this.line(g, o.sole, 7, 'butt');
      if (!pants) {
        l.sh2 = E('path', {fill: o.shorts, stroke: OL, 'stroke-width': OW, 'stroke-linejoin': 'round'}, g);
        l.st = this.line(g, o.trim, 6, 'butt');
      }
      return l;
    }

    mkTorso(parent) {
      const o = this.o, g = E('g', {}, parent), t = {g};
      t.olN = this.line(g, OL, this.W.neck + 2 * OW);
      t.neck = this.line(g, o.skin, this.W.neck);
      if (o.top === 'tank') t.skin = E('path', {fill: o.skin, stroke: OL, 'stroke-width': OW, 'stroke-linejoin': 'round'}, g);
      t.shirt = E('path', {fill: o.shirt, stroke: OL, 'stroke-width': OW, 'stroke-linejoin': 'round'}, g);
      t.shade = E('path', {fill: o.shirtD}, g);
      t.trim = this.line(g, o.trim, 6);
      if (o.top === 'polo' || o.top === 'shirt' || o.top === 'suit') t.collar = E('path', {fill: o.top === 'suit' ? '#f4f1ea' : o.shirt, stroke: OL, 'stroke-width': 4.5, 'stroke-linejoin': 'round'}, g);
      if (o.top === 'suit') t.tie = E('path', {fill: o.tie || '#2a1830', stroke: OL, 'stroke-width': 4}, g);
      if (o.num) {
        t.num = E('text', {'text-anchor': 'middle', fill: o.numFill, stroke: OL, 'stroke-width': 5, 'paint-order': 'stroke fill',
          'font-family': 'Anton, Impact, sans-serif', 'font-size': 64 * (o.kid ? .7 : 1) * o.build}, g);
        t.num.textContent = o.num;
      }
      if (o.whistle) { t.cord = this.line(g, '#e9e2d0', 3); t.whistle = E('circle', {r: 8, fill: '#c9ccd2', stroke: OL, 'stroke-width': 3.5}, g); }
      return t;
    }

    mkHead(parent) {
      const o = this.o, g = E('g', {}, parent), h = {g};
      if (o.hairStyle === 'puff') h.puff = E('path', {fill: o.hair, stroke: OL, 'stroke-width': OW}, g);
      h.ear2 = E('ellipse', {fill: o.skin, stroke: OL, 'stroke-width': 4.5}, g);
      h.ear = E('ellipse', {fill: o.skin, stroke: OL, 'stroke-width': 4.5}, g);
      h.earIn = this.line(g, o.skinD, 3.5);
      h.base = E('path', {fill: o.skin, stroke: OL, 'stroke-width': OW, 'stroke-linejoin': 'round'}, g);
      h.cheek = E('path', {fill: o.skinD, opacity: .55}, g);
      if (o.beard) { h.beard = E('path', {fill: o.hair}, g); h.stache = E('path', {fill: o.hair}, g); }
      if (o.hairStyle !== 'bald') h.hair = E('path', {fill: o.hair, stroke: OL, 'stroke-width': 4.5, 'stroke-linejoin': 'round'}, g);
      if (o.hairStyle === 'cornrows') { h.rows = this.line(g, '#4a372f', 3.2); h.braids = this.line(g, o.hair, 7); }
      if (o.headband) h.band = E('path', {fill: o.headband, stroke: OL, 'stroke-width': 4.5, 'stroke-linejoin': 'round'}, g);
      if (o.cap) { h.cap = E('path', {fill: o.cap, stroke: OL, 'stroke-width': OW, 'stroke-linejoin': 'round'}, g); h.brim = E('path', {fill: o.capD || o.cap, stroke: OL, 'stroke-width': OW, 'stroke-linejoin': 'round'}, g); }
      h.eyes = [0, 1].map(() => ({w: E('ellipse', {fill: '#fbf8f1', stroke: OL, 'stroke-width': 3.5}, g), p: E('ellipse', {fill: OL}, g),
        s: E('circle', {r: 1.8, fill: '#fff'}, g), lid: this.line(g, OL, 4.5)}));
      h.brows = [0, 1].map(() => this.line(g, OL, 7));
      if (o.glasses) h.glasses = E('path', {fill: 'rgba(220,240,255,.18)', stroke: o.glasses, 'stroke-width': 5, 'stroke-linejoin': 'round'}, g);
      h.nose = this.line(g, o.skinD, 4.5);
      h.mouth = E('path', {stroke: OL, 'stroke-width': 4.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'}, g);
      h.teeth = E('path', {fill: '#fbf8f1'}, g);
      h.tongue = E('path', {fill: '#d4545e'}, g);
      h.tears = [0, 1].map(() => this.line(g, '#8fd3ff', 6));
      h.drops = [0, 1, 2, 3].map(() => E('path', {fill: '#bfe7ff', stroke: '#3a7fb8', 'stroke-width': 2}, g));
      h.shine = E('ellipse', {fill: '#fff', opacity: .16}, g);
      return h;
    }

    // world position of a named joint (after the last set): 'hand', 'fhand', 'head', 'neck', 'hip', 'foot', 'ffoot'
    at(name) {
      const q = this.pts[name]; if (!q) return [this.x, this.y];
      return [this.x + this.dir * this.s * q[0], this.y + this.s * (q[1] + this.yo)];
    }

    set(pose, x, y, dir = 1, s = 1, time = 0) {
      const p = Object.assign({}, BASE, FACE, pose), o = this.o, L = this.L, W = this.W;
      this.x = x; this.y = y; this.dir = dir; this.s = s * o.scale;
      const turn = clamp(p.turn), kidK = o.kid ? .72 : 1, bd = o.build * kidK;
      const mN = clamp(1 - 4 * (turn - .5), -1, 1);           // near limbs swing sideways (mirrored) in front view
      const tor = p.tor * R, up = [Math.sin(tor), -Math.cos(tor)], rt = [Math.cos(tor), Math.sin(tor)];
      const loc = (lx, ly) => [rt[0] * lx - up[0] * ly, rt[1] * lx - up[1] * ly];   // torso-local (y up negative) to body coords
      const neck = loc(0, -L.tor);
      const sx = 64 * bd, shY = -L.tor + 22 * kidK;
      const shN = loc(lerp(4, -sx, turn), shY), shF = loc(lerp(6, sx, turn), shY);
      const hipN = [lerp(0, -24 * bd, turn), 0], hipF = [lerp(3, 24 * bd, turn), 0];
      const dir2 = (a, m = 1) => [Math.sin(a * R) * m, Math.cos(a * R)];

      const arm = (sh, ua, fa, m) => {
        const a1 = ua - p.tor, e = add(sh, dir2(a1, m), L.ua), a2 = a1 + fa, w = add(e, dir2(a2, m), L.fa);
        return {sh, e, w, a2, m};
      };
      const leg = (hip, th, shn, ft, m) => {
        const k = add(hip, dir2(th, m), L.th), a2 = th + shn, an = add(k, dir2(a2, m), L.sh);
        return {hip, k, an, a2, af: a2 + 90 + ft, m};
      };
      const A = {n: arm(shN, p.nua, p.nfa, mN), f: arm(shF, p.fua, p.ffa, 1)};
      const G = {n: leg(hipN, p.nth, p.nsh, p.nft, mN), f: leg(hipF, p.fth, p.fsh, p.fft, 1)};

      // shoe outline in foot coordinates (x forward from the ankle, y down)
      const SHOE = [[-17, -14], [6, -17], [24, -9], [L.foot - 6, -2], [L.foot + 2, 8], [L.foot - 2, 19], [-16, 19], [-21, 6]].map(([a, b]) => [a * kidK, b * kidK]);
      const footPts = g => {
        const f = [Math.sin(g.af * R), Math.cos(g.af * R)], d = [-Math.cos(g.af * R), Math.sin(g.af * R)];
        return SHOE.map(([a, b]) => [g.an[0] + (f[0] * a + d[0] * b) * g.m, g.an[1] + f[1] * a + d[1] * b]);
      };
      const FP = {n: footPts(G.n), f: footPts(G.f)};

      // stand on the lowest point (feet, or knees when kneeling)
      let low = -1e9;
      for (const k of ['n', 'f']) { for (const q of FP[k]) low = Math.max(low, q[1] + 3); low = Math.max(low, G[k].k[1] + W.th * .5 + OW); }
      this.yo = -low - p.lift;
      this.root.setAttribute('transform', `translate(${n1(x)},${n1(y)}) scale(${n1(dir * this.s * 1000) / 1000},${n1(this.s * 1000) / 1000})`);
      const sq = p.sq;
      this.body.setAttribute('transform', `translate(0,${n1(this.yo)})` + (sq !== 1 ? ` translate(0,${n1(-this.yo)}) scale(${1 / Math.sqrt(sq)},${sq}) translate(0,${n1(this.yo)})` : ''));
      // order the arms: a near arm that swings behind the body in side views is still drawn in front (cartoon rule)
      this.drawArm(this.nArm, A.n, p.hand);
      this.drawArm(this.fArm, A.f, p.fhand);
      this.drawLeg(this.nLeg, G.n, FP.n);
      this.drawLeg(this.fLeg, G.f, FP.f);
      this.drawTorso(p, turn, bd, loc, neck);
      // seat of the shorts around both hips
      const xs = [hipN[0], hipF[0]], x0 = Math.min(...xs) - 30 * bd, x1 = Math.max(...xs) + 30 * bd;
      const top = loc(0, 4)[1] - 12;
      this.seat.setAttribute('d', `M${pt([x0 + 2, top])} L${pt([x1 - 2, top])} L${pt([x1 + 2, 26 * kidK])} Q${pt([(x0 + x1) / 2, 40 * kidK])} ${pt([x0 - 2, 26 * kidK])} Z`);
      this.seatTrim.setAttribute('d', `M${pt([x0 + 6, top + 6])} L${pt([x1 - 6, top + 6])}`);
      const hc = add(neck, up, L.neck + L.hr * .95);
      this.drawHead(p, turn, hc, p.tor + p.hd, time);
      Object.assign(this.pts, {hand: add(A.n.w, dir2(A.n.a2, A.n.m), L.hand * .7), fhand: add(A.f.w, dir2(A.f.a2, A.f.m), L.hand * .7),
        head: hc, neck, hip: [0, 0], foot: G.n.an, ffoot: G.f.an, knee: G.n.k, elbow: A.n.e, shoulder: shN, fshoulder: shF});
      this.p = p;
      return this;
    }

    drawArm(a, q, hand) {
      const W = this.W, L = this.L, o = this.o;
      const d = (el, p1, p2) => el.setAttribute('d', `M${pt(p1)} L${pt(p2)}`);
      d(a.olU, q.sh, q.e); d(a.olF, q.e, q.w); d(a.fU, q.sh, q.e); d(a.fF, q.e, q.w);
      // shade on the lower side of the forearm
      const dx = q.w[0] - q.e[0], dy = q.w[1] - q.e[1], len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len; if (ny < 0) { nx = -nx; ny = -ny; }
      const off = W.fa * .26;
      d(a.sh, [q.e[0] + nx * off + dx * .12, q.e[1] + ny * off + dy * .12], [q.w[0] + nx * off - dx * .1, q.w[1] + ny * off - dy * .1]);
      if (a.sl) { const m = add(q.sh, [q.e[0] - q.sh[0], q.e[1] - q.sh[1]], .48); d(a.slO, q.sh, m); d(a.sl, q.sh, m); }
      if (a.cuff) d(a.cuff, add(q.e, [dx, dy], .82), q.w);
      if (a.band) d(a.band, add(q.e, [dx, dy], .72), add(q.e, [dx, dy], .92));
      if (a.slv) a.slv.setAttribute('d', `M${pt(add(q.sh, [q.e[0] - q.sh[0], q.e[1] - q.sh[1]], .3))} L${pt(q.e)} L${pt(add(q.e, [dx, dy], .9))}`);
      // hand: fist (round) or open palm (long), with a thumb
      const ang = Math.atan2(dy, dx) / R, open = hand === 'open', c = add(q.w, [dx / len, dy / len], L.hand * (open ? 1.05 : .7));
      const rx = L.hand * (open ? 1.3 : 1.02), ry = L.hand * (open ? .88 : .95);
      for (const [el, w] of [[a.olH, OW], [a.h, 0]]) {
        el.setAttribute('cx', n1(c[0])); el.setAttribute('cy', n1(c[1])); el.setAttribute('rx', n1(rx + w)); el.setAttribute('ry', n1(ry + w));
        el.setAttribute('transform', `rotate(${n1(ang)} ${n1(c[0])} ${n1(c[1])})`);
      }
      const tc = add(c, [nx * (open ? -1 : 1), ny * (open ? -1 : 1)], ry * .55), tcc = add(tc, [dx / len, dy / len], -L.hand * .2);
      for (const [el, w] of [[a.olT, OW], [a.hT, 0]]) {
        el.setAttribute('cx', n1(tcc[0])); el.setAttribute('cy', n1(tcc[1])); el.setAttribute('rx', n1(L.hand * .55 + w)); el.setAttribute('ry', n1(L.hand * .34 + w));
        el.setAttribute('transform', `rotate(${n1(ang)} ${n1(tcc[0])} ${n1(tcc[1])})`);
      }
      // knuckle line on a fist
      a.hl.setAttribute('d', open ? '' : `M${pt(add(c, [dx / len, dy / len], rx * .25))} l${n1(nx * 7)},${n1(ny * 7)}`);
    }

    drawLeg(l, q, foot) {
      const W = this.W, o = this.o;
      const d = (el, p1, p2) => el.setAttribute('d', `M${pt(p1)} L${pt(p2)}`);
      d(l.olT, q.hip, q.k); d(l.olS, q.k, q.an); d(l.fT, q.hip, q.k); d(l.fS, q.k, q.an);
      const dx = q.an[0] - q.k[0], dy = q.an[1] - q.k[1], len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len; if (nx > 0) { nx = -nx; ny = -ny; }
      d(l.sh, [q.k[0] + nx * W.sh * .28 + dx * .1, q.k[1] + ny * W.sh * .28 + dy * .1], [q.an[0] + nx * W.sh * .28 - dx * .35, q.an[1] + ny * W.sh * .28 - dy * .35]);
      if (l.sock) d(l.sock, add(q.an, [dx, dy], -.3), q.an);
      l.shoe.setAttribute('d', 'M' + foot.map(pt).join(' L') + ' Z');
      // darker heel and toe cap, then the sole line
      l.shoeD.setAttribute('d', `M${pt(foot[6])} L${pt(foot[7])} L${pt(foot[0])} L${pt(add(foot[0], [foot[6][0] - foot[0][0], foot[6][1] - foot[0][1]], .9))} Z`);
      d(l.sole, add(foot[6], [foot[7][0] - foot[6][0], foot[7][1] - foot[6][1]], .25), add(foot[5], [foot[4][0] - foot[5][0], foot[4][1] - foot[5][1]], .25));
      if (l.sh2) {
        // baggy shorts leg: from the hip to 70% of the thigh, flaring out
        const tx = q.k[0] - q.hip[0], ty = q.k[1] - q.hip[1], tl = Math.hypot(tx, ty) || 1, ux = tx / tl, uy = ty / tl, vx = -uy, vy = ux;
        const kk = this.o.kid ? .88 : .8, e = [q.hip[0] + tx * kk, q.hip[1] + ty * kk], w0 = W.th * .8, w1 = W.th * .94;
        const P4 = [[q.hip[0] - vx * w0 - ux * 16, q.hip[1] - vy * w0 - uy * 16], [q.hip[0] + vx * w0 - ux * 16, q.hip[1] + vy * w0 - uy * 16], [e[0] + vx * w1, e[1] + vy * w1], [e[0] - vx * w1, e[1] - vy * w1]];
        l.sh2.setAttribute('d', `M${pt(P4[0])} L${pt(P4[1])} L${pt(P4[2])} Q${pt([e[0] + ux * 6, e[1] + uy * 6])} ${pt(P4[3])} Z`);
        l.st.setAttribute('d', `M${pt([q.hip[0] + vx * (w0 - 9) - ux * 10, q.hip[1] + vy * (w0 - 9) - uy * 10])} L${pt([e[0] + vx * (w1 - 9), e[1] + vy * (w1 - 9)])}`);
        l.st.style.display = this.o.stripe === false ? 'none' : '';
      }
    }

    drawTorso(p, turn, bd, loc, neck) {
      const t = this.tor, L = this.L, o = this.o, Lt = L.tor;
      const hs = lerp(42, 80, turn) * bd, hc = lerp(46, 72, turn) * bd, hw = lerp(38, 56, turn) * bd * (o.kid ? 1.1 : 1), fw = lerp(12, 0, turn);
      const P = (x, y) => pt(loc(x, y));
      t.olN.setAttribute('d', `M${P(fw * .4, -Lt * .9)} L${pt(add(neck, [Math.sin(p.tor * R), -Math.cos(p.tor * R)], L.neck + 16))}`);
      t.neck.setAttribute('d', t.olN.getAttribute('d'));
      const waist = 8;
      let d;
      if (o.top === 'tank') {
        t.skin.setAttribute('d', `M${P(-hs * .98, -Lt * .86)} Q${P(-hs * .9, -Lt * 1.02)} ${P(-hs * .5, -Lt * 1.03)} L${P(hs * .55 + fw * .5, -Lt * 1.03)} Q${P(hs * .95 + fw * .5, -Lt * 1.02)} ${P(hs + fw * .5, -Lt * .86)} L${P(hc * .9 + fw, -Lt * .6)} L${P(-hc * .9, -Lt * .6)} Z`);
        d = `M${P(-hw, waist)} L${P(hw + fw * .3, waist)} C${P(hc + fw, -Lt * .3)} ${P(hc + fw, -Lt * .52)} ${P(hc * .9 + fw, -Lt * .66)} Q${P(hc * .62 + fw, -Lt * .76)} ${P(hs * .56 + fw * .5, -Lt * .99)} L${P(hs * .3 + fw * .5, -Lt * .99)} Q${P(fw * .7, -Lt * .76)} ${P(-hs * .3 + fw * .5, -Lt * .99)} L${P(-hs * .56 + fw * .3, -Lt * .99)} Q${P(-hc * .62, -Lt * .76)} ${P(-hc * .9, -Lt * .66)} C${P(-hc, -Lt * .52)} ${P(-hc, -Lt * .3)} ${P(-hw, waist)} Z`;
        t.trim.setAttribute('d', `M${P(hc * .9 + fw, -Lt * .66)} Q${P(hc * .62 + fw, -Lt * .76)} ${P(hs * .56 + fw * .5, -Lt * .99)} M${P(hs * .3 + fw * .5, -Lt * .99)} Q${P(fw * .7, -Lt * .76)} ${P(-hs * .3 + fw * .5, -Lt * .99)} M${P(-hs * .56 + fw * .3, -Lt * .99)} Q${P(-hc * .62, -Lt * .76)} ${P(-hc * .9, -Lt * .66)}`);
      } else {
        // tee, polo, shirt, suit: shoulders covered, round or collared neck
        d = `M${P(-hw, waist)} L${P(hw + fw * .3, waist)} C${P(hc + fw, -Lt * .3)} ${P(hc + fw, -Lt * .6)} ${P(hs + fw * .5, -Lt * .9)} Q${P(hs * .9 + fw * .5, -Lt * 1.02)} ${P(hs * .34 + fw * .5, -Lt * 1.03)} Q${P(fw * .6, -Lt * .9)} ${P(-hs * .34 + fw * .5, -Lt * 1.03)} Q${P(-hs * .9, -Lt * 1.02)} ${P(-hs, -Lt * .9)} C${P(-hc, -Lt * .6)} ${P(-hc, -Lt * .3)} ${P(-hw, waist)} Z`;
        t.trim.setAttribute('d', o.top === 'tee' ? `M${P(hs * .34 + fw * .5, -Lt * 1.03)} Q${P(fw * .6, -Lt * .9)} ${P(-hs * .34 + fw * .5, -Lt * 1.03)}` : '');
        if (t.collar) t.collar.setAttribute('d', `M${P(hs * .36 + fw * .5, -Lt * 1.04)} L${P(fw * .6 + 4, -Lt * .86)} L${P(hs * .5 + fw * .5, -Lt * .9)} Z M${P(-hs * .36 + fw * .5, -Lt * 1.04)} L${P(fw * .6 - 4, -Lt * .86)} L${P(-hs * .5 + fw * .3, -Lt * .9)} Z`);
        if (t.tie) t.tie.setAttribute('d', `M${P(fw * .6 - 7, -Lt * .9)} L${P(fw * .6 + 7, -Lt * .9)} L${P(fw * .6 + 9, -Lt * .45)} L${P(fw * .6, -Lt * .38)} L${P(fw * .6 - 9, -Lt * .45)} Z`);
      }
      t.shirt.setAttribute('d', d);
      t.shade.setAttribute('d', `M${P(-hw + 3, waist - 3)} L${P(-hw + 20, waist - 3)} C${P(-hc + 22, -Lt * .3)} ${P(-hc + 20, -Lt * .5)} ${P(-hc * .9 + 16, -Lt * .64)} L${P(-hc * .9 + 2, -Lt * .64)} C${P(-hc + 3, -Lt * .5)} ${P(-hc + 3, -Lt * .3)} ${P(-hw + 3, waist - 3)} Z`);
      if (t.num) {
        const c = loc(fw * .8 + lerp(8, 0, turn), -Lt * .36);
        t.num.setAttribute('transform', `translate(${pt(c)}) rotate(${n1(p.tor)}) scale(${n1(lerp(.62, 1, turn) * 100) / 100},1)`);
        t.num.style.opacity = turn < .12 ? 0 : 1;
      }
      if (t.whistle) {
        const w = loc(fw * .8 + 6, -Lt * .58);
        t.cord.setAttribute('d', `M${P(-hs * .3 + fw * .5, -Lt * 1)} Q${P(fw * .5, -Lt * .62)} ${pt(w)} Q${P(hs * .25 + fw, -Lt * .7)} ${P(hs * .3 + fw * .5, -Lt * 1)}`);
        t.whistle.setAttribute('cx', n1(w[0])); t.whistle.setAttribute('cy', n1(w[1]));
      }
    }

    drawHead(p, turn, c, rot, time) {
      const h = this.head, o = this.o, r = this.L.hr, rx = r * .92, ry = r * 1.05, kid = o.kid;
      h.g.setAttribute('transform', `translate(${pt(c)}) rotate(${n1(rot)})`);
      const fs = lerp(14, 0, turn);              // features shift toward the facing side
      // head: rounded with a jaw that sits forward in 3/4 view
      const jaw = kid ? 0 : 6;
      h.base.setAttribute('d', `M${-rx},${n1(-ry * .1)} C${-rx},${n1(-ry * 1.05)} ${rx},${n1(-ry * 1.05)} ${rx},${n1(-ry * .1)} C${rx + 2},${n1(ry * .45)} ${n1(fs + rx * .55)},${n1(ry * .98 + jaw)} ${n1(fs * .6)},${n1(ry * .98 + jaw)} C${n1(-rx * .55)},${n1(ry * .98)} ${-rx},${n1(ry * .5)} ${-rx},${n1(-ry * .1)} Z`);
      h.cheek.setAttribute('d', `M${n1(-rx + 4)},${n1(ry * .05)} C${n1(-rx + 2)},${n1(ry * .5)} ${n1(-rx * .4)},${n1(ry * .95)} ${n1(fs * .4)},${n1(ry * .98)} C${n1(-rx * .5)},${n1(ry * .7)} ${n1(-rx * .75)},${n1(ry * .4)} ${n1(-rx + 4)},${n1(ry * .05)} Z`);
      const earX = lerp(-rx * .62, -rx * .98, turn);
      for (const [el, x, show] of [[h.ear, earX, 1], [h.ear2, rx * .98, turn > .7 ? 1 : 0]]) {
        el.setAttribute('cx', n1(x)); el.setAttribute('cy', n1(ry * .08)); el.setAttribute('rx', n1(r * .17)); el.setAttribute('ry', n1(r * .26)); el.style.display = show ? '' : 'none';
      }
      h.earIn.setAttribute('d', `M${n1(earX + 2)},${n1(ry * -.06)} q-6,8 0,16`);
      if (h.puff) h.puff.setAttribute('d', `M${n1(-rx * 1.3)},${n1(-ry * .2)} a${n1(rx * .95)},${n1(ry * .82)} 0 1,1 ${n1(rx * 1.9)},0 a${n1(rx * .95)},${n1(ry * .82)} 0 1,1 ${n1(-rx * 1.9)},0 Z M${n1(-rx * .9)},${n1(-ry * 1.05)} a${n1(rx * .42)},${n1(ry * .38)} 0 1,1 ${n1(rx * .84)},0 a${n1(rx * .42)},${n1(ry * .38)} 0 1,1 ${n1(-rx * .84)},0 Z`);
      if (h.hair) {
        const hl = o.hairStyle === 'puff' ? -ry * .55 : -ry * .48;
        h.hair.setAttribute('d', `M${n1(-rx * 1.02)},${n1(ry * .02)} C${n1(-rx * 1.1)},${n1(-ry * 1.15)} ${n1(rx * 1.05)},${n1(-ry * 1.2)} ${n1(rx * 1.0)},${n1(-ry * .38)} Q${n1(rx * .55)},${n1(hl - 6)} ${n1(fs * .5)},${n1(hl)} Q${n1(-rx * .45)},${n1(hl + 2)} ${n1(-rx * .62)},${n1(-ry * .02)} Z`);
      }
      if (h.beard) {
        const bx = fs * .6;
        h.beard.setAttribute('d', `M${n1(earX + 8)},${n1(ry * .2)} C${n1(-rx * .9)},${n1(ry * .8)} ${n1(-rx * .3)},${n1(ry * 1.1 + jaw)} ${n1(bx)},${n1(ry * 1.06 + jaw)} C${n1(fs + rx * .6)},${n1(ry * 1.02 + jaw)} ${n1(rx + 3)},${n1(ry * .5)} ${n1(rx * .98)},${n1(ry * .15)} L${n1(fs + rx * .52)},${n1(ry * .48)} C${n1(fs + rx * .3)},${n1(ry * .8)} ${n1(fs - rx * .3)},${n1(ry * .8)} ${n1(fs - rx * .5)},${n1(ry * .5)} C${n1(-rx * .62)},${n1(ry * .62)} ${n1(-rx * .62)},${n1(ry * .3)} ${n1(earX + 8)},${n1(ry * .2)} Z`);
        h.stache.setAttribute('d', `M${n1(fs - 16)},${n1(ry * .5)} Q${n1(fs + 6)},${n1(ry * .36)} ${n1(fs + 26)},${n1(ry * .48)} Q${n1(fs + 6)},${n1(ry * .48)} ${n1(fs - 16)},${n1(ry * .5)} Z`);
      }
      if (h.band) h.band.setAttribute('d', `M${n1(-rx * 1.03)},${n1(-ry * .5)} Q${n1(fs * .5)},${n1(-ry * .66)} ${n1(rx * 1.03)},${n1(-ry * .52)} L${n1(rx * 1.02)},${n1(-ry * .3)} Q${n1(fs * .5)},${n1(-ry * .44)} ${n1(-rx * 1.02)},${n1(-ry * .27)} Z`);
      if (h.cap) {
        h.cap.setAttribute('d', `M${n1(-rx * 1.02)},${n1(-ry * .25)} C${n1(-rx * 1.05)},${n1(-ry * 1.3)} ${n1(rx * 1.05)},${n1(-ry * 1.3)} ${n1(rx * 1.02)},${n1(-ry * .3)} Z`);
        h.brim.setAttribute('d', `M${n1(rx * .2)},${n1(-ry * .32)} L${n1(rx * 1.02)},${n1(-ry * .36)} Q${n1(rx * 1.7)},${n1(-ry * .3)} ${n1(rx * 1.75)},${n1(-ry * .14)} Q${n1(rx * 1.1)},${n1(-ry * .12)} ${n1(rx * .2)},${n1(-ry * .2)} Z`);
      }
      // eyes
      const F = FACES[p.face] || FACES.neutral, ek = kid ? 1.22 : 1;
      const ex = [fs - lerp(12, 20, turn), fs + lerp(17, 20, turn)], ey = -ry * .06, esx = [1, lerp(.72, 1, turn)];
      const blink = clamp(p.blink), eyeT = F.eye;
      h.eyes.forEach((e, i) => {
        let erx = 8.6 * ek * esx[i], ery = 10.8 * ek;
        if (eyeT === 'wide') { erx *= 1.12; ery *= 1.2; }
        if (eyeT === 'squint') ery *= .55;
        const closed = eyeT === 'closed' || eyeT === 'happy' || blink > .85;
        const shut = closed ? 0 : ery * (1 - blink);
        for (const el of [e.w, e.p, e.s]) el.style.display = closed ? 'none' : '';
        e.w.setAttribute('cx', n1(ex[i])); e.w.setAttribute('cy', n1(ey)); e.w.setAttribute('rx', n1(erx)); e.w.setAttribute('ry', n1(Math.max(1, shut)));
        const px = ex[i] + 2.5 + p.look * 3.5, py = ey + (eyeT === 'down' ? 4 : 1);
        e.p.setAttribute('cx', n1(px)); e.p.setAttribute('cy', n1(py)); e.p.setAttribute('rx', n1(4.6 * ek * esx[i] * (eyeT === 'wide' ? .8 : 1))); e.p.setAttribute('ry', n1(Math.min(5.4 * ek, Math.max(.5, shut * .9))));
        e.s.setAttribute('cx', n1(px + 1.6)); e.s.setAttribute('cy', n1(py - 2));
        let lid = '';
        if (closed) lid = eyeT === 'happy' ? `M${n1(ex[i] - erx)},${n1(ey + 3)} Q${n1(ex[i])},${n1(ey - 9)} ${n1(ex[i] + erx)},${n1(ey + 3)}`
          : p.face === 'cry' || p.face === 'roar' ? `M${n1(ex[i] - erx)},${n1(ey - 2 + (i ? 2 : -2))} L${n1(ex[i] + erx * .3)},${n1(ey + 2)} L${n1(ex[i] + erx)},${n1(ey - 2 + (i ? -2 : 2))}`
          : `M${n1(ex[i] - erx)},${n1(ey)} Q${n1(ex[i])},${n1(ey + 6)} ${n1(ex[i] + erx)},${n1(ey)}`;
        else if (eyeT === 'squint' || eyeT === 'down') lid = `M${n1(ex[i] - erx - 2)},${n1(ey - shut * .6)} L${n1(ex[i] + erx + 2)},${n1(ey - shut * .6)}`;
        e.lid.setAttribute('d', lid);
      });
      // brows: inner end toward the nose
      h.brows.forEach((b, i) => {
        const x = ex[i], y = ey - 18 * ek, w = 10 * esx[i] * ek, inner = i === 0 ? 1 : -1;
        const yi = y + F.b[0], yo = y + F.b[1];
        b.setAttribute('d', `M${n1(x - w * inner)},${n1(yo)} L${n1(x + w * inner)},${n1(yi)}`);
      });
      const nx = fs + lerp(18, 0, turn), ny = ry * .22;
      h.nose.setAttribute('d', turn < .6 ? `M${n1(nx - 2)},${n1(ny - 14)} Q${n1(nx + 12)},${n1(ny + 2)} ${n1(nx - 4)},${n1(ny + 4)}` : `M${n1(nx - 8)},${n1(ny + 2)} Q${n1(nx)},${n1(ny + 8)} ${n1(nx + 8)},${n1(ny + 2)}`);
      // mouth
      const mx = fs + lerp(6, 0, turn), my = ry * .55, op = p.open;
      let md = '', fill = 'none', teeth = '', tongue = '';
      switch (F.m) {
        case 'flat': md = `M${n1(mx - 11)},${n1(my)} Q${n1(mx)},${n1(my + 1.5)} ${n1(mx + 11)},${n1(my - 1)}`; break;
        case 'smile': md = `M${n1(mx - 13)},${n1(my - 3)} Q${n1(mx)},${n1(my + 10)} ${n1(mx + 13)},${n1(my - 4)}`; break;
        case 'frown': md = `M${n1(mx - 11)},${n1(my + 4)} Q${n1(mx)},${n1(my - 5)} ${n1(mx + 11)},${n1(my + 4)}`; break;
        case 'o': md = `M${n1(mx - 6)},${n1(my)} a6,8 0 1,0 12,0 a6,8 0 1,0 -12,0 Z`; fill = '#3a0d14'; break;
        case 'grin': md = `M${n1(mx - 16)},${n1(my - 4)} Q${n1(mx)},${n1(my + 18)} ${n1(mx + 16)},${n1(my - 5)} Z`; fill = '#3a0d14';
          teeth = `M${n1(mx - 14)},${n1(my - 3)} L${n1(mx + 14)},${n1(my - 4)} L${n1(mx + 11)},${n1(my + 3)} L${n1(mx - 11)},${n1(my + 3)} Z`; break;
        case 'grit': md = `M${n1(mx - 15)},${n1(my - 4)} L${n1(mx + 15)},${n1(my - 5)} L${n1(mx + 13)},${n1(my + 6)} L${n1(mx - 13)},${n1(my + 6)} Z`; fill = '#fbf8f1';
          teeth = ''; tongue = ''; break;
        case 'shout': { const hgt = 22 + op * 12;
          md = `M${n1(mx - 17)},${n1(my - 7)} Q${n1(mx)},${n1(my - 11)} ${n1(mx + 17)},${n1(my - 7)} Q${n1(mx + 14)},${n1(my + hgt)} ${n1(mx)},${n1(my + hgt + 3)} Q${n1(mx - 14)},${n1(my + hgt)} ${n1(mx - 17)},${n1(my - 7)} Z`; fill = '#3a0d14';
          teeth = `M${n1(mx - 15)},${n1(my - 7)} Q${n1(mx)},${n1(my - 10)} ${n1(mx + 15)},${n1(my - 7)} L${n1(mx + 13)},${n1(my - 1)} Q${n1(mx)},${n1(my - 3)} ${n1(mx - 13)},${n1(my - 1)} Z`;
          tongue = `M${n1(mx - 9)},${n1(my + hgt - 2)} Q${n1(mx)},${n1(my + hgt - 12)} ${n1(mx + 9)},${n1(my + hgt - 2)} Q${n1(mx)},${n1(my + hgt + 3)} ${n1(mx - 9)},${n1(my + hgt - 2)} Z`; break; }
        case 'cry': md = `M${n1(mx - 15)},${n1(my + 6)} Q${n1(mx)},${n1(my - 6)} ${n1(mx + 15)},${n1(my + 6)} Q${n1(mx + 8)},${n1(my + 16)} ${n1(mx)},${n1(my + 15)} Q${n1(mx - 8)},${n1(my + 16)} ${n1(mx - 15)},${n1(my + 6)} Z`; fill = '#3a0d14';
          tongue = `M${n1(mx - 7)},${n1(my + 12)} Q${n1(mx)},${n1(my + 6)} ${n1(mx + 7)},${n1(my + 12)} Z`; break;
      }
      h.mouth.setAttribute('d', md); h.mouth.setAttribute('fill', fill);
      h.teeth.setAttribute('d', teeth); h.tongue.setAttribute('d', tongue);
      if (F.m === 'grit') h.teeth.setAttribute('d', `M${n1(mx - 5)},${n1(my - 4)} L${n1(mx - 5)},${n1(my + 6)} M${n1(mx + 5)},${n1(my - 5)} L${n1(mx + 5)},${n1(my + 6)}`), h.teeth.setAttribute('stroke', OL), h.teeth.setAttribute('stroke-width', 2.5);
      // tears: streams down the cheeks and falling drops
      const tr = clamp(p.tears);
      h.tears.forEach((s, i) => {
        s.setAttribute('d', `M${n1(ex[i] - 2)},${n1(ey + 8)} q${i ? 4 : -4},${n1(ry * .35)} ${i ? 2 : -3},${n1(ry * .7)}`); s.style.opacity = tr;
      });
      h.drops.forEach((dEl, k) => {
        const ph = ((time * 1.6 + k * .5) % 1), i = k % 2, x = ex[i] + (i ? 4 : -6), y = ey + 12 + ph * ry * 1.4;
        dEl.setAttribute('d', `M${n1(x)},${n1(y - 7)} Q${n1(x + 5)},${n1(y + 1)} ${n1(x)},${n1(y + 4)} Q${n1(x - 5)},${n1(y + 1)} ${n1(x)},${n1(y - 7)} Z`);
        dEl.style.opacity = tr * (1 - ph * .7);
      });
      if (h.rows) {
        // braided rows running from the hairline over the crown to the nape
        let d = '';
        for (let i = -3; i <= 3; i++) {
          const x0 = fs * .5 + i * rx * .2, y0 = -ry * .5 + Math.abs(i) * 3;
          d += `M${n1(x0)},${n1(y0)} Q${n1(x0 * .7 - rx * .25)},${n1(-ry * 1.08)} ${n1(-rx * .8 + i * 3)},${n1(-ry * .1 + i * 6)} `;
        }
        h.rows.setAttribute('d', d);
        h.braids.setAttribute('d', `M${n1(-rx * .78)},${n1(ry * .05)} q-6,20 -2,40 M${n1(-rx * .66)},${n1(ry * .12)} q-4,18 0,36`);
      }
      if (h.glasses) {
        const ex2 = [fs - lerp(12, 20, turn), fs + lerp(17, 20, turn)], ey2 = -ry * .06, w2 = [13, 13 * lerp(.72, 1, turn)];
        h.glasses.setAttribute('d', ex2.map((x, i) => `M${n1(x - w2[i])},${n1(ey2 - 10)} h${n1(w2[i] * 2)} v18 q0,4 -4,4 h${n1(-w2[i] * 2 + 8)} q-4,0 -4,-4 Z`).join(' ') +
          ` M${n1(ex2[0] + w2[0])},${n1(ey2 - 4)} L${n1(ex2[1] - w2[1])},${n1(ey2 - 4)} M${n1(ex2[0] - w2[0])},${n1(ey2 - 4)} L${n1(lerp(-rx * .62, -rx * .98, turn) + 6)},${n1(ey2)}`);
      }
      if (o.back) for (const el of [h.cheek, h.beard, h.stache, h.nose, h.mouth, h.teeth, h.tongue, h.glasses, ...h.eyes.flatMap(e => [e.w, e.p, e.s, e.lid]), ...h.brows, ...h.tears, ...h.drops]) if (el) el.style.display = 'none';
      h.shine.setAttribute('cx', n1(fs * .5 + rx * .3)); h.shine.setAttribute('cy', n1(-ry * .62)); h.shine.setAttribute('rx', n1(rx * .32)); h.shine.setAttribute('ry', n1(ry * .12));
    }
  }

  // basketball
  class Ball {
    constructor(parent, r = 24) {
      this.r = r; this.g = E('g', {}, parent);
      E('circle', {r: r + OW / 2, fill: OL}, this.g);
      E('circle', {r, fill: '#e2702a'}, this.g);
      E('path', {d: `M${-r * .2},${r * .98} A${r},${r} 0 0,0 ${r * .98},${-r * .2} A${r},${r} 0 0,1 ${-r * .2},${r * .98} Z`, fill: '#b9531b', opacity: .0}, this.g);
      E('path', {d: `M${r * .15},${r * .99} A${r},${r} 0 0,0 ${r * .99},${r * .15} L${r * .7},${r * .7} Z`, fill: '#b9531b', opacity: .0}, this.g);
      this.rot = E('g', {}, this.g);
      const s = {fill: 'none', stroke: OL, 'stroke-width': 3.2};
      E('path', Object.assign({d: `M${-r},0 L${r},0 M0,${-r} L0,${r}`}, s), this.rot);
      E('path', Object.assign({d: `M${-r * .7},${-r * .7} Q${-r * .1},0 ${-r * .7},${r * .7} M${r * .7},${-r * .7} Q${r * .1},0 ${r * .7},${r * .7}`}, s), this.rot);
      E('path', {d: `M${-r * .55},${-r * .35} A${r * .55},${r * .45} 0 0,1 ${-r * .05},${-r * .78}`, fill: 'none', stroke: '#fff', 'stroke-width': 4, opacity: .45, 'stroke-linecap': 'round'}, this.g);
    }
    set(x, y, rot = 0, s = 1, vis = true) {
      this.g.setAttribute('transform', `translate(${n1(x)},${n1(y)}) scale(${s})`);
      this.rot.setAttribute('transform', `rotate(${n1(rot)})`);
      this.g.style.display = vis ? '' : 'none';
      return this;
    }
  }

  // ---- poses -----------------------------------------------------------------------------------
  const P = {
    stand: {tor: 2, nua: 6, nfa: 14, fua: -6, ffa: 18, nth: 3, nsh: -3, fth: -3, fsh: -4},
    ready: {tor: 14, hd: -6, nua: 30, nfa: 60, fua: 10, ffa: 70, nth: 34, nsh: -52, fth: 4, fsh: -40, nft: 6},
    shoot: {tor: -3, hd: -12, nua: 160, nfa: 34, fua: 150, ffa: 62, nth: 6, nsh: -8, fth: -4, fsh: -6, nft: -26, fft: -26, lift: 40, hand: 'open'},
    release: {tor: -6, hd: -16, nua: 172, nfa: 8, fua: 140, ffa: 40, nth: 4, nsh: -6, fth: -8, fsh: -10, nft: -30, fft: -30, lift: 70, hand: 'open', fhand: 'open'},
    block: {tor: -6, hd: -18, nua: 178, nfa: 4, fua: -50, ffa: 40, nth: 74, nsh: -84, fth: -36, fsh: -54, nft: -10, fft: -20, lift: 170, hand: 'open', face: 'shout'},
    leap: {tor: 8, hd: -10, nua: 150, nfa: 10, fua: -40, ffa: 50, nth: 60, nsh: -90, fth: -20, fsh: -60, nft: -10, fft: -20, lift: 90, face: 'focus'},
    layup: {tor: 6, hd: -14, nua: 158, nfa: 8, fua: 60, ffa: 70, nth: 82, nsh: -96, fth: -18, fsh: -30, nft: 0, fft: -20, lift: 100, hand: 'open', face: 'focus'},
    dunk: {tor: 10, hd: -14, nua: 170, nfa: 4, fua: 60, ffa: 90, nth: 70, nsh: -100, fth: -10, fsh: -70, lift: 220, face: 'shout'},
    kneel: {tor: 18, hd: 18, nua: 6, nfa: 40, fua: 4, ffa: 44, nth: 2, nsh: -92, fth: -2, fsh: -94, nft: 40, fft: 40, face: 'cry'},
    kneelFace: {tor: 26, hd: 22, nua: 124, nfa: 132, fua: 116, ffa: 138, nth: 6, nsh: -96, fth: 2, fsh: -96, nft: 40, fft: 40, face: 'cry', hand: 'open', fhand: 'open'},
    kneelRoar: {tor: -14, hd: -28, nua: 150, nfa: 34, fua: 140, ffa: 40, nth: 6, nsh: -96, fth: -4, fsh: -96, nft: 40, fft: 40, face: 'roar'},
    roar: {turn: .9, tor: -4, hd: -12, nua: 130, nfa: 60, fua: 130, ffa: 60, nth: 10, nsh: -12, fth: 10, fsh: -12, face: 'shout', open: 1},
    flex: {turn: .9, tor: 2, hd: -6, nua: 90, nfa: 110, fua: 90, ffa: 110, nth: 8, nsh: -8, fth: 8, fsh: -8, face: 'shout'},
    celebrate: {turn: .95, tor: -2, hd: -14, nua: 160, nfa: 8, fua: 160, ffa: 8, nth: 8, nsh: -6, fth: 8, fsh: -6, face: 'grin', hand: 'fist'},
    sit: {tor: 4, nua: 40, nfa: 60, fua: 30, ffa: 66, nth: 90, nsh: -90, fth: 86, fsh: -88, nft: 0, fft: 0},
    sitSad: {tor: 22, hd: 16, nua: 52, nfa: 70, fua: 44, ffa: 74, nth: 88, nsh: -86, fth: 84, fsh: -86, face: 'sad'},
    carry: {tor: -5, hd: -2, nua: 64, nfa: 52, fua: 58, ffa: 56},
    cradle: {tor: 4, hd: 16, nua: 40, nfa: 96, fua: 34, ffa: 100, face: 'smile'},
    reach: {tor: 4, nua: 76, nfa: 8, fua: -8, ffa: 18, hand: 'open', face: 'smile'},
    point: {tor: 0, nua: 100, nfa: 0, fua: -6, ffa: 18, face: 'focus'},
    hold: {tor: 0, nua: 66, nfa: 36, fua: 60, ffa: 40, face: 'smile'},
    write: {tor: 16, hd: 18, nua: 50, nfa: 52, fua: 40, ffa: 60, nth: 88, nsh: -88, fth: 84, fsh: -88, face: 'focus'},
    trophy: {turn: .7, tor: -2, hd: -10, nua: 150, nfa: 30, fua: 150, ffa: 30, face: 'cry', hand: 'open', fhand: 'open'},
  };
  const cycle = (ph, amp = 1, kind = 'run') => {
    const s = Math.sin(ph), c = Math.cos(ph), sF = Math.sin(ph + Math.PI), cF = Math.cos(ph + Math.PI);
    if (kind === 'walk') return {tor: 4 * amp, nth: 4 + 24 * s * amp, nsh: -6 - 40 * Math.max(0, c) * amp, fth: 4 + 24 * sF * amp, fsh: -6 - 40 * Math.max(0, cF) * amp,
      nua: -22 * s * amp, nfa: 20, fua: 22 * s * amp, ffa: 24, nft: 4, fft: 4, lift: 4 * Math.abs(Math.cos(ph)) * amp};
    const k = kind === 'sprint' ? 1.25 : 1;
    return {tor: 16 * k * amp, hd: -8, nth: 12 + 46 * k * s * amp, nsh: -14 - 88 * Math.max(0, c) * amp, fth: 12 + 46 * k * sF * amp, fsh: -14 - 88 * Math.max(0, cF) * amp,
      nua: -52 * k * s * amp, nfa: 88, fua: 52 * k * s * amp, ffa: 88, nft: 10, fft: 10, lift: 16 * Math.max(0, Math.sin(2 * ph)) * amp, face: 'focus'};
  };

  const mix = (a, b, k) => {
    const o = {};
    for (const key of NUMS) { const va = a[key] ?? BASE[key], vb = b[key] ?? BASE[key]; o[key] = va + (vb - va) * k; }
    for (const key of Object.keys(FACE)) o[key] = (k < .5 ? a[key] : b[key]) ?? FACE[key];
    return o;
  };
  const EASE = {
    lin: x => x, out: x => 1 - Math.pow(1 - x, 3), in: x => x * x * x,
    io: x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2,
    back: x => 1 + 2.4 * Math.pow(x - 1, 3) + 1.4 * Math.pow(x - 1, 2),
    snap: x => 1 - Math.pow(1 - x, 5),
  };
  // keys: [[time, value, ease], ...]; value: number, array of numbers or pose object. Ease applies on the way INTO a key.
  const track = keys => t => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const [t1, v1, e] = keys[i];
      if (t < t1) {
        const [t0, v0] = keys[i - 1], k = (EASE[e || 'io'])((t - t0) / Math.max(1e-6, t1 - t0));
        if (typeof v0 === 'number') return v0 + (v1 - v0) * k;
        if (Array.isArray(v0)) return v0.map((x, j) => x + (v1[j] - x) * k);
        return mix(v0, v1, k);
      }
    }
    return keys[keys.length - 1][1];
  };

  window.Toon = Object.assign(Toon, {Ball, P, cycle, mix, track, EASE, E, OL, FACES});
// yt-toon patch: end of module wrapper
};
