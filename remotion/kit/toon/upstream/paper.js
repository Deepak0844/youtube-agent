// paper.js: the "paper and light" style. Every scene is a diorama of cut paper (torn edges, soft shadows
// between layers, paper grain) lit like a film (glows, light rays, dust), with characters as backlit silhouettes.
// Needs toon.js (the puppet rig) for full-body silhouettes. All helpers draw into an SVG group.
// yt-toon patch: module wrapper (window and document are passed in), was an IIFE
export default (window, document) => {
  const NS = 'http://www.w3.org/2000/svg';
  const E = (tag, a = {}, p) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const f = n => +(+n).toFixed(1);
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const svgOf = el => el.ownerSVGElement || el;
  const defsOf = el => { const s = svgOf(el); return s.querySelector('defs') || E('defs', {}, s); };
  let uid = 0;
  const nid = p => `${p}${++uid}`;

  // ---------- shared, made once per svg (never per frame) ----------
  const cache = new WeakMap();
  function kit(el) {
    const svg = svgOf(el);
    if (cache.has(svg)) return cache.get(svg);
    const d = defsOf(svg), k = { sil: {} };
    // paper layer: a soft shadow under the cut edge
    k.cut = nid('cut');
    let fl = E('filter', { id: k.cut, x: '-10%', y: '-10%', width: '120%', height: '130%' }, d);
    E('feDropShadow', { dx: 0, dy: 7, stdDeviation: 7, 'flood-color': '#05070f', 'flood-opacity': .55 }, fl);
    k.cutS = nid('cuts');
    fl = E('filter', { id: k.cutS, x: '-20%', y: '-20%', width: '140%', height: '150%' }, d);
    E('feDropShadow', { dx: 0, dy: 3, stdDeviation: 3, 'flood-color': '#05070f', 'flood-opacity': .5 }, fl);
    k.blur = {};
    cache.set(svg, k);
    return k;
  }
  // backlit silhouette: the shape filled with one dark colour, plus a rim of light on the side facing the light
  function silFilter(el, dark = '#0b1020', rim = '#ffd97a', dx = -4, dy = -3, glow = 1.5) {
    const k = kit(el), key = [dark, rim, dx, dy, glow].join('|');
    if (k.sil[key]) return k.sil[key];
    const id = nid('sil'), fl = E('filter', { id, x: '-20%', y: '-20%', width: '140%', height: '140%' }, defsOf(el));
    E('feFlood', { 'flood-color': rim, result: 'r' }, fl);
    E('feComposite', { in: 'r', in2: 'SourceAlpha', operator: 'in', result: 'rs' }, fl);
    E('feOffset', { in: 'rs', dx, dy, result: 'ro' }, fl);
    E('feGaussianBlur', { in: 'ro', stdDeviation: glow, result: 'rb' }, fl);
    E('feFlood', { 'flood-color': dark, result: 'd' }, fl);
    E('feComposite', { in: 'd', in2: 'SourceAlpha', operator: 'in', result: 'ds' }, fl);
    const m = E('feMerge', {}, fl);
    E('feMergeNode', { in: 'rb' }, m); E('feMergeNode', { in: 'ds' }, m);
    k.sil[key] = `url(#${id})`;
    return k.sil[key];
  }
  function blurFilter(el, sd) {
    const k = kit(el);
    if (k.blur[sd]) return k.blur[sd];
    const id = nid('bl'), fl = E('filter', { id, x: '-30%', y: '-30%', width: '160%', height: '160%' }, defsOf(el));
    E('feGaussianBlur', { stdDeviation: sd }, fl);
    return (k.blur[sd] = `url(#${id})`);
  }
  // gradients made once and reused by key (safe to call every frame)
  const gcache = new WeakMap();
  function grad(el, kind, stops, a = {}) {
    const svg = svgOf(el);
    if (!gcache.has(svg)) gcache.set(svg, {});
    const c = gcache.get(svg), key = kind + JSON.stringify(stops) + JSON.stringify(a);
    if (c[key]) return c[key];
    const id = nid('g'), g = E(kind === 'lin' ? 'linearGradient' : 'radialGradient', Object.assign({ id }, kind === 'lin' ? { x1: 0, y1: 0, x2: 0, y2: 1 } : {}, a), defsOf(el));
    stops.forEach(([o, col, op = 1]) => E('stop', { offset: o, 'stop-color': col, 'stop-opacity': op }, g));
    return (c[key] = `url(#${id})`);
  }

  // ---------- paper shapes ----------
  // jitter a polygon into a hand-cut edge: small random bumps, slightly smoothed
  function torn(pts, amp = 4, seed = 1, step = 18) {
    const R = rng(seed), out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(L / step));
      for (let j = 0; j < n; j++) {
        const k = j / n, nx = -(b[1] - a[1]) / (L || 1), ny = (b[0] - a[0]) / (L || 1), w = (R() - .5) * 2 * amp;
        out.push([a[0] + (b[0] - a[0]) * k + nx * w, a[1] + (b[1] - a[1]) * k + ny * w]);
      }
    }
    let d = '';
    for (let i = 0; i < out.length; i++) {
      const p = out[i], q = out[(i + 1) % out.length], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      d += i === 0 ? `M ${f(m[0])} ${f(m[1])} ` : '';
      d += `Q ${f(q[0])} ${f(q[1])} ${f((q[0] + out[(i + 2) % out.length][0]) / 2)} ${f((q[1] + out[(i + 2) % out.length][1]) / 2)} `;
    }
    return d + 'Z';
  }
  // a skyline / hill line from x0 to x1 closed down to yb: hFn(x) gives the top y
  function ridge(x0, x1, yb, hFn, step = 30) {
    const pts = [[x0, yb]];
    for (let x = x0; x <= x1; x += step) pts.push([x, hFn(x)]);
    pts.push([x1, yb]);
    return pts;
  }
  // one paper layer: flat colour, a lighter cut edge on top, a shadow beneath
  function layer(g, pts, fill, o = {}) {
    const d = typeof pts === 'string' ? pts : torn(pts, o.amp ?? 3.5, o.seed ?? 1, o.step ?? 16);
    const k = kit(g);
    const grp = E('g', { filter: o.shadow === false ? 'none' : `url(#${o.small ? k.cutS : k.cut})` }, g);
    E('path', { d, fill: o.grad ? grad(g, 'lin', o.grad) : fill }, grp);
    if (o.edge !== false) E('path', { d, fill: 'none', stroke: o.edge || 'rgba(255,248,230,.28)', 'stroke-width': o.ew || 2.5 }, grp);
    return grp;
  }

  // ---------- light ----------
  function glow(g, x, y, r, col, op = .8) {
    return E('circle', { cx: f(x), cy: f(y), r: f(r), fill: grad(g, 'rad', [[0, col, 1], [.35, col, .45], [1, col, 0]]), opacity: op, style: 'mix-blend-mode:screen' }, g);
  }
  // fan of light rays from (x, y) toward angle ang (deg, 90 = down), flickering with t
  function rays(g, x, y, ang, spread, len, n, col, op = .35, t = 0, seed = 3) {
    const R = rng(seed), grp = E('g', { style: 'mix-blend-mode:screen' }, g);
    const fill = grad(g, 'rad', [[0, col, 1], [1, col, 0]], { cx: x, cy: y, r: len, gradientUnits: 'userSpaceOnUse', fx: x, fy: y });
    for (let i = 0; i < n; i++) {
      const a = (ang + (i / (n - 1 || 1) - .5) * spread + (R() - .5) * 4) * Math.PI / 180, w = (1.5 + R() * 3) * Math.PI / 180;
      const fl = .6 + .4 * Math.sin(t * (1 + R() * 2) + i * 1.7);
      E('path', { d: `M ${x} ${y} L ${f(x + Math.cos(a - w) * len)} ${f(y + Math.sin(a - w) * len)} L ${f(x + Math.cos(a + w) * len)} ${f(y + Math.sin(a + w) * len)} Z`, fill, opacity: f(op * fl * 100) / 100 }, grp);
    }
    return grp;
  }
  // dust or embers drifting in a box
  function dust(g, t, n, box, col = '#fff6d6', seed = 5, o = {}) {
    const R = rng(seed), [x0, y0, w, h] = box, grp = E('g', { style: 'mix-blend-mode:screen' }, g);
    const up = o.up ?? 18, sz = o.size ?? 3;
    for (let i = 0; i < n; i++) {
      const px = x0 + ((R() * w + Math.sin(t * .6 + i) * 30 + t * (o.drift ?? 6)) % w + w) % w;
      const py = y0 + ((R() * h - t * up * (.5 + R())) % h + h) % h;
      const r = sz * (.4 + R()), tw = .4 + .6 * Math.abs(Math.sin(t * (1 + R() * 2) + i));
      E('circle', { cx: f(px), cy: f(py), r: f(r), fill: col, opacity: f(tw * (o.op ?? .7) * 100) / 100 }, grp);
    }
    return grp;
  }
  // paper confetti falling, each piece with a small shadow
  function confetti(g, t, n, seed = 7, cols = ['#1f4fa8', '#f4b73b', '#f7eedb', '#1f4fa8', '#ffd97a'], o = {}) {
    const R = rng(seed), grp = E('g', { filter: `url(#${kit(g).cutS})` }, g), sp = o.speed ?? 1;
    for (let i = 0; i < n; i++) {
      const x0 = R() * 1080, v = (140 + R() * 200) * sp, ph = R() * 2100, w = 16 + R() * 18, h = 9 + R() * 8, spin = R() * 360, flip = Math.abs(Math.cos(t * (2 + R() * 3) + i));
      const y = (ph + t * v) % 2100 - 120, x = x0 + Math.sin(t * 1.4 + i) * 40;
      E('rect', { x: f(-w / 2), y: f(-h * flip / 2), width: f(w), height: f(Math.max(1, h * flip)), fill: cols[i % cols.length], transform: `translate(${f(x)} ${f(y)}) rotate(${f(spin + t * 160)})` }, grp);
    }
    return grp;
  }

  // ---------- characters as silhouettes ----------
  const DARK = { skin: '#000', skinD: '#000', shirt: '#000', shirtD: '#000', trim: '#000', num: null, numFill: '#000', shorts: '#000', shortsD: '#000', pants: '#000', shoe: '#000', shoeD: '#000', sole: '#000', sock: '#000', hair: '#000' };
  // full body from the toon.js rig; filter = silFilter(...) gives the colour and the rim light
  function figure(g, pose, x, y, o = {}) {
    const grp = E('g', { filter: o.filter || silFilter(g) }, g);
    const t = new window.Toon(grp, Object.assign({}, DARK, o.look || {}));
    t.set(pose, x, y, o.dir ?? 1, o.s ?? 1, 0);
    return { grp, toon: t };
  }
  // a man in profile, facing right: swept-back hair, glasses, suit. Origin near the ear, head ~300 units tall.
  const PROFILE = {
    head: 'M -78 92 C -90 60 -100 30 -104 4 C -114 -14 -126 -40 -132 -78 C -150 -96 -140 -118 -128 -126 C -118 -156 -82 -176 -40 -178 C 8 -180 52 -164 64 -126 C 68 -114 70 -104 72 -94 C 76 -84 80 -72 80 -60 C 79 -54 75 -50 77 -44 L 105 -2 C 108 4 102 12 91 12 L 93 22 C 97 26 95 31 88 33 C 92 37 92 43 86 45 C 81 49 80 54 84 63 C 86 77 74 87 58 89 L 18 93 C 24 105 30 118 36 136 L -76 136 Z',
    suit: 'M 30 120 C 40 142 74 152 124 168 C 178 186 198 236 204 330 L -224 330 C -218 236 -196 192 -150 172 C -112 156 -88 142 -80 118 Z',
    lens: 'M 74 -68 L 88 -66 C 92 -60 92 -48 88 -42 L 74 -42 Z',
    arm: 'M 74 -60 L -20 -52 L -20 -46 L 74 -52 Z',
    collar: 'M 36 132 L 64 150 L 54 176 L 30 146 Z',
  };
  function profile(g, x, y, s = 1, o = {}) {
    const grp = E('g', { transform: `translate(${f(x)} ${f(y)}) scale(${(o.dir ?? 1) * s} ${s})` }, g);
    const body = E('g', { filter: o.filter || silFilter(g, '#0b1020', '#ffd97a', 4, -3, 1.5) }, grp);
    E('path', { d: PROFILE.suit }, body);
    E('path', { d: PROFILE.head }, body);
    E('path', { d: PROFILE.lens }, body);
    E('path', { d: PROFILE.arm }, body);
    if (o.glint) E('path', { d: 'M 82 -64 L 86 -48', stroke: o.glint, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: .9 }, grp);
    return grp;
  }

  // ---------- type ----------
  // big paper numbers or words: cut out of card, with a shadow; font Fraunces 900 by default
  function word(g, x, y, str, size, fill = '#f7eedb', o = {}) {
    const grp = E('g', { filter: o.shadow === false ? 'none' : `url(#${kit(g).cut})` }, g);
    const t = E('text', { x: f(x), y: f(y), 'text-anchor': o.anchor || 'middle', 'font-family': o.font || 'Fraunces', 'font-weight': o.weight || 900, 'font-style': o.italic ? 'italic' : 'normal', 'font-size': f(size), fill, 'letter-spacing': o.ls || 0 }, grp);
    t.textContent = str;
    return grp;
  }

  // ---------- camera: slow push with parallax ----------
  // layers: [[group, depth]], depth 1 = foreground (moves most), larger = farther. push 0..1 over the shot.
  function camera(layers, push, cx = 540, cy = 860, amount = .12, pan = [0, 0]) {
    for (const [grp, z] of layers) {
      const s = 1 + amount * push / z, dx = pan[0] * push / z, dy = pan[1] * push / z;
      grp.setAttribute('transform', `translate(${f(cx + dx)} ${f(cy + dy)}) scale(${s.toFixed(4)}) translate(${-cx} ${-cy})`);
    }
  }

  // ---------- paper grain for the whole frame (one tile, made once) ----------
  function paperTile() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const x = c.getContext('2d'), R = rng(11);
    x.fillStyle = '#808080'; x.fillRect(0, 0, 512, 512);
    const im = x.getImageData(0, 0, 512, 512);
    for (let i = 0; i < im.data.length; i += 4) { const v = 128 + (R() - .5) * 46; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; }
    x.putImageData(im, 0, 0);
    for (let i = 0; i < 900; i++) {
      x.strokeStyle = R() < .5 ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.10)';
      x.lineWidth = .6 + R() * 1.2;
      const px = R() * 512, py = R() * 512, a = R() * Math.PI, l = 6 + R() * 26;
      x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + Math.cos(a) * l * .5 + (R() - .5) * 6, py + Math.sin(a) * l * .5 + (R() - .5) * 6, px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
    }
    return c.toDataURL();
  }

  window.Paper = { E, f, rng, clamp, kit, silFilter, blurFilter, grad, torn, ridge, layer, glow, rays, dust, confetti, figure, profile, PROFILE, word, camera, paperTile, DARK };
// yt-toon patch: end of module wrapper
};
