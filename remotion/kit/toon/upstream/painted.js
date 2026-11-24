// painted.js: the soft, hand-painted storybook style (big cumulus clouds, layered green hills,
// warm window light, round friendly characters, glossy food). Original drawings only.
// Exposes window.Painted: SVG helpers, the landscape, the kitchen set, the cook rig and the food props.
// yt-toon patch: module wrapper (window and document are passed in), was an IIFE
export default (window, document) => {
  const NS = 'http://www.w3.org/2000/svg';
  const E = (tag, a = {}, p) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  let uid = 0;
  const nid = p => `${p}${++uid}`;
  const INK = '#4a2e20';
  const st = (w = 6, c = INK) => ({ stroke: c, 'stroke-width': w <= 10 ? +(w * .5).toFixed(2) : w, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const eout = x => 1 - Math.pow(1 - clamp(x), 3);
  const eio = x => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const tr = (el, x, y, s = 1, r = 0) => el.setAttribute('transform', `translate(${(+x).toFixed(1)},${(+y).toFixed(1)}) rotate(${(+r).toFixed(2)}) scale(${(+s).toFixed(4)})`);

  function scene(world, id, trn = 'zoom') {
    const div = document.createElement('div');
    div.className = 'scene'; div.dataset.scene = id; div.dataset.tr = trn;
    world.appendChild(div);
    const svg = E('svg', { viewBox: '0 0 1080 1920', width: 1080, height: 1920 }, div);
    const defs = E('defs', {}, svg);
    return { id, div, svg, defs, cam: E('g', {}, svg) };
  }
  const defsOf = el => { const s = el.ownerSVGElement || el; return s.querySelector('defs') || E('defs', {}, s); };
  function lin(el, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1) {
    const id = nid('lg'), g = E('linearGradient', { id, x1, y1, x2, y2 }, defsOf(el));
    stops.forEach(([o, c, op = 1]) => E('stop', { offset: o, 'stop-color': c, 'stop-opacity': op }, g));
    return `url(#${id})`;
  }
  function rad(el, stops, cx = .5, cy = .5, r = .5) {
    const id = nid('rg'), g = E('radialGradient', { id, cx, cy, r }, defsOf(el));
    stops.forEach(([o, c, op = 1]) => E('stop', { offset: o, 'stop-color': c, 'stop-opacity': op }, g));
    return `url(#${id})`;
  }
  const blurs = new Map();
  function blur(el, sd) {
    const key = (el.ownerSVGElement || el), k = key.__b || (key.__b = {});
    if (k[sd]) return k[sd];
    const id = nid('bl'), f = E('filter', { id, x: '-60%', y: '-60%', width: '220%', height: '220%' }, defsOf(el));
    E('feGaussianBlur', { stdDeviation: sd }, f);
    return (k[sd] = `url(#${id})`);
  }
  function clip(el, shape) {
    const id = nid('cp'), c = E('clipPath', { id }, defsOf(el));
    E(shape.tag, shape.a, c);
    return `url(#${id})`;
  }

  // ---------------------------------------------------------------- outdoors
  function cloud(p, x, y, s = 1, seed = 1) {
    const g = E('g', { transform: `translate(${x},${y}) scale(${s})` }, p), r = rng(seed);
    const bumps = [[-230, 20, 62], [-160, -5, 92], [-70, -62, 112], [40, -96, 132], [150, -44, 104], [235, 6, 74]].map(([a, b, c]) => [a + r() * 20, b + r() * 14, c * (.9 + r() * .2)]);
    const layer = (dx, dy, k, fill, op = 1) => { const l = E('g', { fill, opacity: op }, g); bumps.forEach(([a, b, c]) => E('circle', { cx: a + dx, cy: b + dy, r: c * k }, l)); E('ellipse', { cx: dx, cy: 34 + dy, rx: 270 * k, ry: 50 * k }, l); return l; };
    layer(0, 22, 1, '#b9c9e2');
    layer(0, 0, 1, '#eef3fa');
    layer(-14, -16, .78, '#ffffff');
    layer(-24, -30, .46, '#fffbef', .9);
    return g;
  }
  function sheep(p, x, y, s = 1, flip = 1) {
    const g = E('g', { transform: `translate(${x},${y}) scale(${s * flip},${s})` }, p);
    E('ellipse', { cx: 0, cy: 34, rx: 46, ry: 8, fill: '#2e5a2c', opacity: .3 }, g);
    for (const lx of [-24, -8, 12, 26]) E('line', { x1: lx, y1: 10, x2: lx, y2: 32, ...st(7, '#3a2d28') }, g);
    const wool = E('g', { fill: '#fbf8f0', ...st(4) }, g);
    E('path', { d: 'M-42,8 C-52,-12 -34,-30 -16,-26 C-10,-40 14,-40 22,-26 C40,-30 52,-12 42,6 C44,22 -40,24 -42,8Z' }, wool);
    E('ellipse', { cx: 44, cy: -10, rx: 14, ry: 17, fill: '#3a2d28', ...st(3) }, g);
    E('circle', { cx: 49, cy: -13, r: 2.5, fill: '#fff' }, g);
    return g;
  }
  function village(p, x, y, s = 1) {
    const g = E('g', { transform: `translate(${x},${y}) scale(${s})` }, p);
    const houses = [[-150, 0, 70, 52], [-86, -10, 62, 62], [-30, 2, 74, 48], [40, -6, 60, 58], [96, 4, 70, 46], [-120, 36, 80, 44], [10, 34, 90, 46]];
    houses.forEach(([hx, hy, w, h], i) => {
      E('rect', { x: hx, y: hy, width: w, height: h, fill: i % 2 ? '#efe2c8' : '#e6d4b4', ...st(3) }, g);
      E('path', { d: `M${hx - 6},${hy} L${hx + w / 2},${hy - 22} L${hx + w + 6},${hy}Z`, fill: i % 3 ? '#c4623f' : '#b2563a', ...st(3) }, g);
      E('rect', { x: hx + w * .3, y: hy + h * .35, width: 9, height: 12, fill: '#5a4335' }, g);
    });
    // the civic tower
    E('rect', { x: -14, y: -118, width: 40, height: 112, fill: '#e9dcc2', ...st(3) }, g);
    E('path', { d: 'M-20,-118 L6,-150 L32,-118Z', fill: '#b2563a', ...st(3) }, g);
    E('path', { d: 'M-2,-96 L-2,-84 Q6,-94 14,-84 L14,-96Z', fill: '#5a4335' }, g);
    return g;
  }
  // full outdoor backdrop; returns update(t) for drifting clouds and grass sway
  function landscape(p, { sheepOn = true, seed = 3 } = {}) {
    const g = E('g', {}, p);
    E('rect', { x: 0, y: 0, width: 1080, height: 1920, fill: lin(p, [[0, '#3f8fd8'], [.38, '#7cbcec'], [.56, '#cfe8f4'], [.62, '#f4f1e4']]) }, g);
    E('circle', { cx: 830, cy: 420, r: 420, fill: rad(p, [[0, '#fffbe8', .9], [.35, '#fff6d8', .35], [1, '#fff6d8', 0]]) }, g);
    const cl = E('g', {}, g);
    const clouds = [cloud(cl, 250, 560, 1.15, seed), cloud(cl, 860, 760, .9, seed + 1), cloud(cl, 620, 330, .62, seed + 2), cloud(cl, 80, 900, .55, seed + 3)];
    // far mountains (the Laga range) and hills
    E('path', { d: 'M0,1080 L90,1010 L170,1040 L290,930 L380,990 L470,950 L560,1010 L690,900 L800,980 L900,940 L1080,1010 L1080,1200 L0,1200Z', fill: '#8ea6cf' }, g);
    E('path', { d: 'M290,930 L330,965 L300,960 L270,975Z M690,900 L735,940 L700,935 L665,950Z', fill: '#e6eef8' }, g);
    E('path', { d: 'M0,1110 C160,1040 300,1090 420,1060 C560,1020 700,1080 840,1040 C940,1015 1020,1040 1080,1050 L1080,1300 L0,1300Z', fill: '#a9cf86' }, g);
    village(g, 540, 1062, .9);
    E('path', { d: 'M0,1190 C200,1120 380,1170 560,1150 C760,1128 900,1170 1080,1140 L1080,1920 L0,1920Z', fill: lin(p, [[0, '#7fb86a'], [.4, '#5f9a52'], [1, '#467d40']]) }, g);
    E('path', { d: 'M0,1190 C200,1120 380,1170 560,1150 C760,1128 900,1170 1080,1140', fill: 'none', stroke: '#c9e6a6', 'stroke-width': 6, opacity: .7 }, g);
    const r = rng(seed + 9), fl = E('g', {}, g);
    for (let i = 0; i < 90; i++) E('circle', { cx: r() * 1080, cy: 1220 + r() * 680, r: 3 + r() * 4, fill: r() < .5 ? '#fffbe9' : '#ffd96a', opacity: .9 }, fl);
    const sh = sheepOn ? [sheep(g, 200, 1300, 1.1), sheep(g, 330, 1350, .9, -1), sheep(g, 820, 1280, 1, -1), sheep(g, 930, 1390, 1.2)] : [];
    return t => {
      clouds.forEach((c, i) => { const x0 = [250, 860, 620, 80][i], y0 = [560, 760, 330, 900][i], s = [1.15, .9, .62, .55][i]; tr(c, x0 + t * (6 + i * 2), y0, s); });
      sh.forEach((s, i) => s.style.transform = `translateY(${Math.max(0, Math.sin(t * 2 + i * 1.7)) * -3}px)`);
    };
  }

  // ---------------------------------------------------------------- the kitchen set
  // hang: false hides the cured meats hanging on hooks (they suit Italian kitchens, not every country)
  function kitchen(p, { counterY = 1240, hang: showHang = true } = {}) {
    const g = E('g', {}, p);
    E('rect', { x: 0, y: 0, width: 1080, height: 1920, fill: lin(p, [[0, '#f1dfbd'], [1, '#e7cfa4']], 0, 0, 1, 0) }, g);
    const pr = rng(21), stains = E('g', { filter: blur(p, 28) }, g);
    for (let k = 0; k < 16; k++) E('ellipse', { cx: (pr() * 1080).toFixed(0), cy: (100 + pr() * 1050).toFixed(0), rx: (80 + pr() * 180).toFixed(0), ry: (60 + pr() * 140).toFixed(0), fill: ['#f8ead0', '#e2c597', '#ecd5ac', '#dcbd8c'][k % 4], opacity: .55 }, stains);
    E('rect', { x: 0, y: 0, width: 1080, height: 1200, fill: lin(p, [[0, '#7a4a26', .18], [.25, '#7a4a26', 0], [.85, '#7a4a26', 0], [1, '#7a4a26', .16]]) }, g);
    // a timber beam across the ceiling
    E('rect', { x: -10, y: 0, width: 1100, height: 70, fill: lin(p, [[0, '#7c5432'], [1, '#5c3a20']]), ...st(5) }, g);
    E('path', { d: 'M0,22 C200,18 420,28 640,20 C820,14 960,24 1080,20 M0,46 C260,52 520,40 760,48 C900,52 1000,44 1080,48', fill: 'none', stroke: '#4a2e18', 'stroke-width': 2.5, opacity: .6 }, g);
    E('rect', { x: 0, y: 70, width: 1080, height: 26, fill: '#6a4426', opacity: .28, filter: blur(p, 8) }, g);
    // window with the mountains outside
    const win = E('svg', { x: 520, y: 230, width: 460, height: 560, viewBox: '0 520 1080 1300', preserveAspectRatio: 'xMidYMid slice' }, g);
    const out = landscape(win, { sheepOn: true, seed: 11 });
    E('rect', { x: 520, y: 230, width: 460, height: 560, fill: 'none', ...st(26, '#8c5a33') }, g);
    E('path', { d: 'M750,230 L750,790 M520,510 L980,510', ...st(14, '#8c5a33') }, g);
    E('rect', { x: 500, y: 790, width: 500, height: 30, rx: 8, fill: '#a26a3d', ...st(5) }, g);
    // gingham curtains
    const gin = (x, w, side) => {
      const c = E('g', {}, g);
      E('path', { d: side < 0 ? `M${x},200 L${x + w},200 C${x + w - 30},420 ${x + w - 70},600 ${x + w - 20},820 L${x},820Z` : `M${x},200 L${x + w},200 L${x + w},820 L${x + 20},820 C${x + 70},600 ${x + 30},420 ${x},200Z`, fill: '#fbf3ea', ...st(5) }, c);
      for (let k = 0; k < 9; k++) E('line', { x1: x + 10, y1: 230 + k * 66, x2: x + w - 10, y2: 230 + k * 66, stroke: '#d65a4e', 'stroke-width': 14, opacity: .55 }, c);
      for (let k = 0; k < 4; k++) E('line', { x1: x + 18 + k * (w - 36) / 3, y1: 210, x2: x + 18 + k * (w - 36) / 3, y2: 810, stroke: '#d65a4e', 'stroke-width': 14, opacity: .4 }, c);
    };
    gin(450, 120, -1); gin(930, 120, 1);
    E('rect', { x: 430, y: 186, width: 660, height: 22, rx: 10, fill: '#8c5a33', ...st(5) }, g);
    // shelf, copper pots, jars, a cured guanciale and a salami on hooks
    E('rect', { x: 50, y: 544, width: 380, height: 30, fill: '#6a4426', opacity: .3, filter: blur(p, 7) }, g);
    E('rect', { x: 40, y: 520, width: 380, height: 22, fill: '#a26a3d', ...st(5) }, g);
    [[110, 470, 54, '#d9844f'], [230, 482, 42, '#c8733f']].forEach(([cx, cy, r, c]) => {
      E('path', { d: `M${cx - r},${cy - r * .5} L${cx + r},${cy - r * .5} L${cx + r * .9},${cy + r * .9 - 10} Q${cx},${cy + r * .9 + 6} ${cx - r * .9},${cy + r * .9 - 10}Z`, fill: c, ...st(5) }, g);
      E('path', { d: `M${cx - r * .6},${cy - r * .2} L${cx - r * .6},${cy + r * .5}`, stroke: '#ffd2a8', 'stroke-width': 8, 'stroke-linecap': 'round', opacity: .8 }, g);
    });
    [[318, 450, '#e9d9a8'], [376, 462, '#cfe0b8']].forEach(([x, y, c]) => { E('rect', { x: x - 26, y, width: 52, height: 70, rx: 10, fill: c, ...st(5) }, g); E('rect', { x: x - 30, y: y - 12, width: 60, height: 16, rx: 4, fill: '#c8473e', ...st(4) }, g); });
    const hang = E('g', showHang ? {} : { display: 'none' }, g);
    E('path', { d: 'M150,60 L150,190 M250,60 L250,170', ...st(4, '#8c6a3d'), fill: 'none' }, hang);
    F.guanciale(E('g', { transform: 'translate(150,270) rotate(84) scale(.8)' }, hang));
    E('path', { d: 'M232,170 C222,250 226,330 250,380 C262,400 282,394 278,370 C272,320 270,240 268,170Z', fill: lin(p, [[0, '#7a2e22'], [.45, '#b04a38'], [1, '#6a2418']], 0, 0, 1, 0), ...st(4) }, hang);
    E('path', { d: 'M242,200 L262,196 M240,250 L266,246 M244,300 L270,296 M250,346 L272,342', stroke: '#f3e6d0', 'stroke-width': 3, opacity: .8 }, hang);
    E('path', { d: 'M246,190 C240,250 242,310 254,360', stroke: '#fff', 'stroke-width': 5, opacity: .3, fill: 'none', 'stroke-linecap': 'round' }, hang);
    // majolica tiles above the counter
    for (let k = 0; k < 12; k++) {
      const x = k * 90, y = counterY - 150;
      E('rect', { x, y, width: 90, height: 90, fill: '#f8f4ea', stroke: '#c9bba0', 'stroke-width': 3 }, g);
      E('path', { d: `M${x + 45},${y + 14} L${x + 76},${y + 45} L${x + 45},${y + 76} L${x + 14},${y + 45}Z`, fill: k % 2 ? '#2f6fb3' : '#e2a33b', opacity: .75 }, g);
      E('circle', { cx: x + 45, cy: y + 45, r: 10, fill: '#f8f4ea' }, g);
    }
    // warm light from the window
    E('path', { d: 'M520,260 L980,240 L1080,1300 L300,1300Z', fill: '#fff6d6', opacity: .2, filter: blur(p, 18) }, g);
    E('path', { d: 'M500,830 L1000,830 L1080,1086 L440,1086Z', fill: '#fff0c0', opacity: .3, filter: blur(p, 10) }, g);
    return { g, update: out };
  }
  function counter(p, y = 1240) {
    const g = E('g', {}, p);
    E('rect', { x: -20, y, width: 1120, height: 46, rx: 10, fill: '#b98352', ...st(6) }, g);
    E('rect', { x: -20, y: y + 46, width: 1120, height: 1920 - y, fill: lin(p, [[0, '#9a663c'], [1, '#6e4426']]), ...st(6) }, g);
    for (let k = 0; k < 6; k++) E('line', { x1: k * 220 + 60, y1: y + 60, x2: k * 220 + 60, y2: 1920, stroke: '#5c3820', 'stroke-width': 4, opacity: .5 }, g);
    const gr = rng(7);
    for (let k = 0; k < 22; k++) { const x0 = gr() * 1080, y0 = y + 80 + gr() * (1840 - y), l = 60 + gr() * 160; E('path', { d: `M${x0.toFixed(0)},${y0.toFixed(0)} q${(gr() * 10 - 5).toFixed(0)},${(l / 2).toFixed(0)} 0,${l.toFixed(0)}`, fill: 'none', stroke: '#5c3820', 'stroke-width': 2, opacity: .35 }, g); }
    E('rect', { x: -20, y: y + 46, width: 1120, height: 40, fill: '#3a2210', opacity: .25, filter: blur(p, 6) }, g);
    E('path', { d: `M440,${y + 4} L1000,${y + 4} L1060,${y + 40} L380,${y + 40}Z`, fill: '#fff0c0', opacity: .35, filter: blur(p, 6) }, g);
    E('path', { d: `M0,${y + 8} L1080,${y + 8}`, stroke: '#e0b07e', 'stroke-width': 6, opacity: .7 }, g);
    return g;
  }

  // ---------------------------------------------------------------- the cook (a friendly host character)
  // set({ la:[a1,a2], ra:[a1,a2], headR:deg, talk:0..1, blink:bool, happy:bool, point:'l'|'r'|null, bob })
  // arm angles in degrees: a1 = upper arm from straight down, rotating outwards; a2 = elbow bend added to it
  function Cook(p, { x = 540, y = 900, s = 1, skin = '#f6d3b5', hair = '#e7e3dc', top = '#6f8f6a', apron = '#fbf1de', trim = '#c8473e' } = {}) {
    const root = E('g', {}, p), g = E('g', {}, root);
    const neck = E('path', { d: 'M-34,-40 L-36,40 Q0,58 36,40 L34,-40Z', fill: '#e8bc9a', ...st() }, g);
    const body = E('g', {}, g);
    E('path', { d: 'M-150,40 C-195,60 -210,170 -214,300 L-226,640 L226,640 L214,300 C210,170 195,60 150,40 Q0,12 -150,40Z', fill: top, ...st() }, body);
    E('path', { d: 'M150,40 C195,60 210,170 214,300 L226,640 L150,640 C168,470 176,300 150,40Z', fill: '#58765a' }, body);
    E('path', { d: 'M-56,32 L0,128 L56,32 L0,112Z', fill: '#58765a' }, body);
    E('path', { d: 'M-150,40 C-120,120 -110,200 -120,330', fill: 'none', stroke: '#58765a', 'stroke-width': 8, 'stroke-linecap': 'round' }, body);
    E('path', { d: 'M-62,26 L0,118 L62,26 Q0,46 -62,26Z', fill: '#fbf6ec', ...st() }, body);
    E('path', { d: 'M-108,160 Q0,140 108,160 L126,640 L-126,640Z', fill: apron, ...st() }, body);
    E('path', { d: 'M56,166 C70,300 76,470 72,640 L126,640 L108,160 Q84,162 56,166Z', fill: '#eadcbf' }, body);
    E('path', { d: 'M-40,240 C-46,380 -44,520 -50,630 M20,300 C24,420 22,540 26,630', fill: 'none', stroke: '#e2d2b2', 'stroke-width': 6, 'stroke-linecap': 'round' }, body);
    E('path', { d: 'M-98,178 Q0,160 98,178', fill: 'none', stroke: trim, 'stroke-width': 9 }, body);
    E('path', { d: 'M-100,160 L-66,40 M100,160 L66,40', ...st(10, apron) }, body);
    E('path', { d: 'M-100,160 L-66,40 M100,160 L66,40', fill: 'none', ...st(3) }, body);
    E('rect', { x: -56, y: 430, width: 112, height: 86, rx: 14, fill: '#f6e8cc', ...st(4) }, body);
    for (let k = 0; k < 5; k++) { const a = k * 72 * Math.PI / 180; E('circle', { cx: 0 + Math.cos(a) * 11, cy: 472 + Math.sin(a) * 11, r: 8, fill: trim }, body); }
    E('circle', { cx: 0, cy: 472, r: 6, fill: '#ffd36b' }, body);
    const head = E('g', {}, g);
    const hg = E('g', {}, head);
    E('path', { d: 'M-128,-130 C-150,-250 -60,-300 0,-296 C60,-300 150,-250 128,-130 C120,-90 100,-80 90,-90 L-90,-90 C-100,-80 -120,-90 -128,-130Z', fill: hair, ...st() }, hg);
    E('circle', { cx: 0, cy: -300, r: 62, fill: hair, ...st() }, hg);
    E('path', { d: 'M28,-352 C66,-330 70,-276 30,-246 C50,-280 52,-318 28,-352Z', fill: '#cbc4b8' }, hg);
    E('path', { d: 'M100,-120 C118,-140 126,-180 118,-220 C132,-180 130,-140 112,-104Z', fill: '#cbc4b8' }, hg);
    E('path', { d: 'M-30,-310 C-20,-340 30,-336 30,-300 C30,-276 -6,-272 -10,-296', fill: 'none', ...st(4, '#b8b2a8') }, hg);
    [-1, 1].forEach(sd => {
      E('ellipse', { cx: sd * 114, cy: -116, rx: 22, ry: 30, fill: skin, ...st() }, hg);
      E('circle', { cx: sd * 116, cy: -80, r: 8, fill: '#e8b93c', ...st(3) }, hg);
    });
    E('path', { d: 'M-112,-160 C-120,-50 -80,6 0,10 C80,6 120,-50 112,-160 C104,-238 -104,-238 -112,-160Z', fill: skin, ...st() }, hg);
    E('path', { d: 'M62,-196 C112,-166 112,-80 64,-14 C96,-64 98,-136 62,-196Z', fill: '#ebbb9a' }, hg);
    E('path', { d: 'M-112,-150 C-98,-186 -62,-196 -22,-192 C-10,-178 10,-178 22,-192 C62,-196 98,-186 112,-150 C104,-200 64,-214 22,-208 C12,-192 -12,-192 -22,-208 C-64,-214 -104,-200 -112,-150Z', fill: '#ebbb9a' }, hg);
    E('path', { d: 'M-24,6 Q0,14 24,6 Q0,26 -24,6Z', fill: '#d9a684' }, hg);
    E('path', { d: 'M-122,-150 C-124,-236 -44,-268 0,-256 C44,-268 124,-236 122,-150 C104,-200 64,-214 22,-208 C12,-192 -12,-192 -22,-208 C-64,-214 -104,-200 -122,-150Z', fill: hair, ...st() }, hg);
    E('path', { d: 'M40,-212 C70,-216 100,-200 118,-160 C110,-196 84,-222 50,-226Z', fill: '#cbc4b8' }, hg);
    E('path', { d: 'M-80,-226 C-60,-238 -40,-238 -24,-226 M30,-228 C50,-240 74,-236 92,-220', fill: 'none', ...st(3, '#b8b2a8') }, hg);
    E('path', { d: 'M-70,-250 C-40,-264 -10,-266 10,-262', fill: 'none', stroke: '#ffffff', 'stroke-width': 7, 'stroke-linecap': 'round', opacity: .8 }, hg);
    const eyes = [-1, 1].map(sd => {
      const e = E('g', { transform: `translate(${sd * 44},-120)` }, hg);
      const open = E('g', {}, e);
      E('ellipse', { cx: 0, cy: 0, rx: 11, ry: 14, fill: '#2b1d16' }, open);
      E('circle', { cx: 3.5, cy: -5, r: 4, fill: '#fff' }, open);
      const shut = E('path', { d: 'M-15,2 Q0,-12 15,2', fill: 'none', ...st(5, '#2b1d16') }, e);
      E('path', { d: `M${sd * 20},-2 L${sd * 30},-6 M${sd * 20},6 L${sd * 31},8`, ...st(2.5, '#c08a6a') }, e);
      E('path', { d: 'M-16,-30 Q0,-40 16,-30', fill: 'none', ...st(5, '#a9a299') }, e);
      return { e, open, shut };
    });
    E('path', { d: 'M-4,-96 Q-8,-72 2,-68 Q12,-68 12,-78', fill: 'none', ...st(4, '#b77d5c') }, hg);
    [-1, 1].forEach(sd => E('ellipse', { cx: sd * 72, cy: -66, rx: 28, ry: 17, fill: '#f0978c', opacity: .5 }, hg));
    const closed = E('path', { d: 'M-30,-40 Q0,-16 30,-40', fill: 'none', ...st(5, '#7d3a2c') }, hg);
    const open = E('g', {}, hg);
    const mo = E('path', { fill: '#7d2a26', ...st(4, '#5a2a20') }, open);
    const tongue = E('ellipse', { cx: 0, cy: -26, rx: 13, ry: 5, fill: '#e07a6c' }, open);
    const teeth = E('path', { d: 'M-22,-45 Q0,-41 22,-45 L20,-39 Q0,-36 -20,-39Z', fill: '#fffaf2' }, open);
    E('path', { d: 'M-36,-44 Q-40,-40 -38,-34 M36,-44 Q40,-40 38,-34', fill: 'none', ...st(3, '#c08a6a') }, hg);
    const arm = sd => {
      const a = E('g', {}, g);
      const o = E('path', { fill: 'none', ...st(64) }, a), f = E('path', { fill: 'none', stroke: top, 'stroke-width': 58, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, a);
      const cuff = E('circle', { r: 30, fill: '#fbf6ec', ...st(5) }, a);
      const finger = E('line', { ...st(26), }, a), finger2 = E('line', { stroke: skin, 'stroke-width': 15, 'stroke-linecap': 'round' }, a);
      const hand = E('circle', { r: 30, fill: skin, ...st(5) }, a);
      return { o, f, cuff, finger, finger2, hand, sd };
    };
    const arms = { l: arm(-1), r: arm(1) };
    const rad = d => d * Math.PI / 180;
    function placeArm(A, a1, a2, point) {
      const S = [A.sd * 142, 80], L1 = 160, L2 = 150;
      const El = [S[0] + A.sd * L1 * Math.sin(rad(a1)), S[1] + L1 * Math.cos(rad(a1))];
      const H = [El[0] + A.sd * L2 * Math.sin(rad(a1 + a2)), El[1] + L2 * Math.cos(rad(a1 + a2))];
      const d = `M${S[0]},${S[1]} L${El[0].toFixed(1)},${El[1].toFixed(1)} L${H[0].toFixed(1)},${H[1].toFixed(1)}`;
      A.o.setAttribute('d', d); A.f.setAttribute('d', d);
      const u = [(H[0] - El[0]) / L2, (H[1] - El[1]) / L2];
      A.cuff.setAttribute('cx', (H[0] - u[0] * 14).toFixed(1)); A.cuff.setAttribute('cy', (H[1] - u[1] * 14).toFixed(1));
      A.hand.setAttribute('cx', (H[0] + u[0] * 14).toFixed(1)); A.hand.setAttribute('cy', (H[1] + u[1] * 14).toFixed(1));
      const show = point ? '' : 'none';
      [A.finger, A.finger2].forEach(fg => { fg.style.display = show; fg.setAttribute('x1', H[0] + u[0] * 30); fg.setAttribute('y1', H[1] + u[1] * 30); fg.setAttribute('x2', H[0] + u[0] * 70); fg.setAttribute('y2', H[1] + u[1] * 70); });
      return H;
    }
    const api = {
      g: root,
      hands: {},
      set(o = {}) {
        const { la = [18, -60], ra = [18, -60], headR = 0, talk = 0, blink = false, happy = false, point = null, bob = 0, lean = 0 } = o;
        root.setAttribute('transform', `translate(${x},${y + bob}) rotate(${lean}) scale(${s})`);
        head.setAttribute('transform', `rotate(${headR.toFixed(2)},0,-30)`);
        eyes.forEach(ey => { const sh = blink || happy; ey.open.style.display = sh ? 'none' : ''; ey.shut.style.display = sh ? '' : 'none'; });
        const t = clamp(talk);
        closed.style.display = t > .06 ? 'none' : ''; open.style.display = t > .06 ? '' : 'none';
        const dp = 10 + 24 * t; mo.setAttribute('d', `M-32,-48 Q0,-42 32,-48 Q24,${(-48 + dp).toFixed(1)} 0,${(-44 + dp).toFixed(1)} Q-24,${(-48 + dp).toFixed(1)} -32,-48Z`); tongue.setAttribute('cy', (-48 + dp * .85).toFixed(1)); tongue.setAttribute('ry', (2 + 4 * t).toFixed(1));
        api.hands.l = placeArm(arms.l, la[0], la[1], point === 'l');
        api.hands.r = placeArm(arms.r, ra[0], ra[1], point === 'r');
      },
    };
    api.set();
    return api;
  }
  // mouth amount from the voice timeline: open while a line plays, with a syllable-like flutter
  function talkAt(t) {
    const L = window.TIMELINE.lines.find(l => t >= l.t && t < l.t + l.d - .05);
    if (!L) return 0;
    return clamp(.25 + .75 * Math.abs(Math.sin(t * 15.5)) * (.55 + .45 * Math.abs(Math.sin(t * 4.1 + 1))));
  }
  const blinkAt = t => (t % 3.4) < .13;

  // ---------------------------------------------------------------- food and tools (centred on 0,0, about 200 px wide)
  // Painted look for the food: rich warm colours, soft shading, thin warm outlines (never black), strong glossy highlights.
  const FI = '#6b3420';
  const fo = (w = 2.6, c = FI) => ({ stroke: c, 'stroke-width': w, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  const mix = (a, b, k) => { const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16)); return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join(''); };
  const F = {};
  F.spaghetti = (p) => {
    const g = E('g', { transform: 'rotate(-22)' }, p);
    for (let i = 0; i < 30; i++) { const y = -28 + i * 1.95; E('line', { x1: -110 + (i % 3) * 3, y1: y, x2: 108 - (i % 4) * 3, y2: y, stroke: i % 4 ? '#f3cd72' : '#d29a3f', 'stroke-width': 3.2, 'stroke-linecap': 'round' }, g); }
    E('line', { x1: -104, y1: -27, x2: 102, y2: -27, stroke: '#fff4cf', 'stroke-width': 2, opacity: .9 }, g);
    E('rect', { x: -46, y: -38, width: 92, height: 76, rx: 9, fill: lin(p, [[0, '#4a8ccc'], [1, '#22578f']]), ...fo(2.6, '#1d3d66') }, g);
    E('rect', { x: -46, y: -8, width: 92, height: 16, fill: '#f6edd6' }, g);
    E('path', { d: 'M-36,-30 L-36,-16', stroke: '#b4d6f4', 'stroke-width': 5, 'stroke-linecap': 'round', opacity: .7 }, g);
    return g;
  };
  // a slab of guanciale: peppered rind, creamy fat, pink meat in waves
  F.guanciale = (p, s = 1) => {
    const g = E('g', { transform: `scale(${s})` }, p);
    const shape = 'M-104,-40 C-100,-60 -70,-64 -30,-62 C20,-60 70,-66 98,-52 C112,-44 108,30 100,46 C92,60 60,62 0,60 C-60,60 -96,58 -104,44 C-110,20 -110,-20 -104,-40Z';
    E('path', { d: shape, transform: 'translate(5,10)', fill: '#3a1c10', opacity: .25, filter: blur(p, 5) }, g);
    const in_ = E('g', { 'clip-path': clip(p, { tag: 'path', a: { d: shape } }) }, g);
    E('rect', { x: -120, y: -70, width: 240, height: 140, fill: lin(p, [[0, '#fff7ec'], [1, '#efd5bd']]) }, in_);
    E('path', { d: 'M-120,-4 C-70,-26 -20,8 30,-12 C64,-24 90,-14 120,-22 L120,14 C80,24 40,2 -10,20 C-50,32 -84,14 -120,24Z', fill: lin(p, [[0, '#ee8f90'], [1, '#c4565f']]) }, in_);
    E('path', { d: 'M-120,38 C-50,26 30,48 120,32 L120,48 C40,62 -40,42 -120,56Z', fill: lin(p, [[0, '#ea9a98'], [1, '#d07476']]) }, in_);
    E('path', { d: 'M-80,4 C-50,-4 -30,8 -6,2 M30,2 C50,-6 70,-2 92,-10 M-60,46 C-30,40 0,48 24,44', fill: 'none', stroke: '#fde9e2', 'stroke-width': 2.4, 'stroke-linecap': 'round', opacity: .85 }, in_);
    E('path', { d: 'M-120,-70 L120,-70 L120,-44 C70,-36 20,-46 -30,-40 C-70,-36 -100,-42 -120,-38Z', fill: lin(p, [[0, '#6e3a1e'], [1, '#a0612f']]) }, in_);
    const r = rng(5); for (let i = 0; i < 80; i++) E('circle', { cx: -104 + r() * 208, cy: -62 + r() * 22, r: 1.1 + r() * 2.2, fill: r() < .8 ? '#1e140f' : '#5a4a3a' }, in_);
    E('path', { d: 'M-74,-22 C-40,-30 -6,-26 18,-30', stroke: '#fff', 'stroke-width': 7, opacity: .6, fill: 'none', 'stroke-linecap': 'round', filter: blur(p, 1.5) }, in_);
    E('path', { d: 'M60,40 C76,36 88,30 96,22', stroke: '#fff', 'stroke-width': 4, opacity: .45, fill: 'none', 'stroke-linecap': 'round' }, in_);
    E('path', { d: shape, fill: 'none', ...fo(3) }, g);
    return g;
  };
  // one wavy strip of guanciale; .cook(k) goes from raw (pink and white) to golden, translucent and crisp
  F.strip = (p, s = 1) => {
    const g = E('g', { transform: `scale(${s})` }, p);
    const out = 'M-42,-11 C-30,-18 -16,-6 -2,-12 C12,-18 28,-8 42,-13 C45,-6 45,6 42,12 C28,17 14,6 0,12 C-14,18 -28,7 -42,12 C-45,5 -45,-5 -42,-11Z';
    const fat = E('path', { d: out, fill: '#fbeee2', ...fo(2.4, '#b98a7a') }, g);
    const glow = E('path', { d: 'M-34,-6 C-22,-11 -10,-2 2,-7 C14,-12 26,-4 36,-8', fill: 'none', stroke: '#fff1b8', 'stroke-width': 5, 'stroke-linecap': 'round', opacity: 0 }, g);
    const meat = E('path', { d: 'M-40,-1 C-27,-6 -13,4 1,-1 C15,-6 28,2 40,-2 L40,5 C28,9 15,1 1,6 C-13,11 -27,1 -40,6Z', fill: '#e58b8b' }, g);
    const meat2 = E('path', { d: 'M-36,9 C-24,6 -12,12 0,8 C12,5 24,11 36,7', fill: 'none', stroke: '#e9a0a0', 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
    const rind = E('path', { d: 'M-42,-11 C-30,-18 -16,-6 -2,-12 C12,-18 28,-8 42,-13', fill: 'none', stroke: '#8a5a3c', 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
    const crisp = E('path', { d: 'M42,12 C28,17 14,6 0,12 C-14,18 -28,7 -42,12', fill: 'none', stroke: '#b8561e', 'stroke-width': 3.4, 'stroke-linecap': 'round', opacity: 0 }, g);
    const sh1 = E('path', { d: 'M-30,-7 C-20,-11 -10,-5 -2,-7', fill: 'none', stroke: '#fff', 'stroke-width': 2.6, 'stroke-linecap': 'round', opacity: .25 }, g);
    const sh2 = E('circle', { cx: 22, cy: -5, r: 2.3, fill: '#fff', opacity: 0 }, g);
    return { g, cook(k) {
      k = clamp(k);
      fat.setAttribute('fill', mix('#fbeee2', '#f4b357', k)); fat.setAttribute('stroke', mix('#b98a7a', '#7a3416', k));
      meat.setAttribute('fill', mix('#e58b8b', '#a83f1c', k)); meat2.setAttribute('stroke', mix('#e9a0a0', '#c4622a', k));
      rind.setAttribute('stroke', mix('#8a5a3c', '#5a2410', k));
      glow.setAttribute('opacity', (.8 * k).toFixed(2)); crisp.setAttribute('opacity', (.9 * k).toFixed(2));
      sh1.setAttribute('opacity', (.25 + .7 * k).toFixed(2)); sh2.setAttribute('opacity', (.9 * k).toFixed(2));
    } };
  };
  F.tomato = (p, r = 34) => {
    const g = E('g', {}, p);
    E('ellipse', { cx: r * .1, cy: r * .9, rx: r * .85, ry: r * .2, fill: '#3a1a10', opacity: .2 }, g);
    E('ellipse', { cx: 0, cy: 0, rx: r * 1.04, ry: r * .95, fill: rad(p, [[0, '#ff8d60'], [.38, '#ec402b'], [.85, '#b41d1c'], [1, '#8c1418']], .36, .32, .72), ...fo(Math.max(1.6, r * .055), '#7a1a14') }, g);
    E('path', { d: `M${-r * .1},${-r * .88} C${-r * .55},${-r * .4} ${-r * .55},${r * .45} ${-r * .05},${r * .9}`, fill: 'none', stroke: '#b8221e', 'stroke-width': r * .07, opacity: .4, 'stroke-linecap': 'round' }, g);
    E('path', { d: `M${r * .5},${r * .62} C${r * .78},${r * .3} ${r * .86},${-r * .05} ${r * .8},${-r * .3}`, fill: 'none', stroke: '#ffb48c', 'stroke-width': r * .09, opacity: .55, 'stroke-linecap': 'round' }, g);
    E('ellipse', { cx: -r * .42, cy: -r * .36, rx: r * .25, ry: r * .13, fill: '#fff', opacity: .92, transform: `rotate(-38,${-r * .42},${-r * .36})` }, g);
    E('circle', { cx: -r * .12, cy: -r * .6, r: r * .06, fill: '#fff', opacity: .85 }, g);
    const pts = []; for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * .1 : r * .42; pts.push(`${(Math.cos(a) * rr).toFixed(1)},${(-r * .84 + Math.sin(a) * rr * .45).toFixed(1)}`); }
    E('path', { d: 'M' + pts.join(' L') + 'Z', fill: lin(p, [[0, '#86c862'], [1, '#3b7a2c']]), ...fo(Math.max(1.3, r * .04), '#24481a') }, g);
    E('path', { d: `M0,${-r * .9} q${r * .04},${-r * .2} ${r * .14},${-r * .26}`, fill: 'none', stroke: '#3b7a2c', 'stroke-width': r * .08, 'stroke-linecap': 'round' }, g);
    return g;
  };
  F.can = (p) => {
    const g = E('g', {}, p);
    E('rect', { x: -62, y: -80, width: 124, height: 166, rx: 12, fill: lin(p, [[0, '#8f99a3'], [.35, '#f4f7f9'], [.55, '#cfd6dc'], [1, '#7f8892']], 0, 0, 1, 0), ...fo(2.6, '#4a4f56') }, g);
    E('ellipse', { cx: 0, cy: -80, rx: 62, ry: 14, fill: '#e3e8ec', ...fo(2.6, '#4a4f56') }, g);
    E('ellipse', { cx: 0, cy: -80, rx: 50, ry: 9, fill: 'none', stroke: '#a9b1b8', 'stroke-width': 2 }, g);
    E('rect', { x: -62, y: -52, width: 124, height: 112, fill: lin(p, [[0, '#a3241c'], [.35, '#ea563c'], [.6, '#d6402e'], [1, '#8f1f19']], 0, 0, 1, 0) }, g);
    F.tomato(E('g', { transform: 'translate(0,-8) scale(.8)' }, g));
    E('rect', { x: -48, y: 34, width: 96, height: 16, rx: 4, fill: '#f6edd6' }, g);
    E('path', { d: 'M-44,-72 L-44,78', stroke: '#fff', 'stroke-width': 6, opacity: .4, 'stroke-linecap': 'round' }, g);
    return g;
  };
  F.pecorino = (p) => {
    const g = E('g', {}, p);
    const shape = 'M-104,52 L104,52 L104,12 L-62,-62Z';
    E('path', { d: shape, transform: 'translate(5,8)', fill: '#3a1c10', opacity: .22, filter: blur(p, 5) }, g);
    const in_ = E('g', { 'clip-path': clip(p, { tag: 'path', a: { d: shape } }) }, g);
    E('rect', { x: -110, y: -70, width: 220, height: 130, fill: lin(p, [[0, '#fff6dc'], [1, '#e6ca8c']]) }, in_);
    [[-20, 22, 8], [30, 32, 6], [-52, 36, 5], [52, 16, 4], [2, 42, 3.5], [74, 38, 4], [-6, 2, 3]].forEach(([cx, cy, r]) => {
      E('ellipse', { cx, cy, rx: r, ry: r * .7, fill: '#cfac66' }, in_);
      E('path', { d: `M${cx - r * .8},${cy + r * .3} Q${cx},${cy + r * .9} ${cx + r * .8},${cy + r * .3}`, fill: 'none', stroke: '#fff8e4', 'stroke-width': 1.6 }, in_);
    });
    const r = rng(8); for (let i = 0; i < 40; i++) E('circle', { cx: -90 + r() * 190, cy: -20 + r() * 70, r: .8 + r() * 1.2, fill: '#d6b878', opacity: .8 }, in_);
    E('path', { d: 'M-62,-62 L104,12 L104,52', fill: 'none', stroke: '#2b231d', 'stroke-width': 20 }, in_);
    E('path', { d: 'M-56,-48 L96,20', stroke: '#6a5a4c', 'stroke-width': 2, opacity: .7 }, in_);
    E('path', { d: 'M-40,-8 L30,22', stroke: '#fffbe8', 'stroke-width': 7, opacity: .75, 'stroke-linecap': 'round', filter: blur(p, 1.5) }, in_);
    E('path', { d: shape, fill: 'none', ...fo(2.6, '#4a3a2a') }, g);
    return g;
  };
  F.bottle = (p, glass = '#4f8a4a', label = '#f4ead2', s = 1) => {
    const g = E('g', { transform: `scale(${s})` }, p);
    const d = 'M-15,-118 L15,-118 L15,-60 C15,-40 42,-34 42,0 L42,104 Q42,114 32,114 L-32,114 Q-42,114 -42,104 L-42,0 C-42,-34 -15,-40 -15,-60Z';
    E('path', { d, fill: lin(p, [[0, mix(glass, '#000000', .35)], [.3, glass], [.55, mix(glass, '#ffffff', .28)], [1, mix(glass, '#000000', .45)]], 0, 0, 1, 0), ...fo(2.6, mix(glass, '#000000', .6)) }, g);
    E('rect', { x: -17, y: -132, width: 34, height: 22, rx: 5, fill: lin(p, [[0, '#a8823e'], [.4, '#ecc77c'], [1, '#9a7434']], 0, 0, 1, 0), ...fo(2.2, '#5a4220') }, g);
    E('rect', { x: -36, y: 14, width: 72, height: 62, rx: 6, fill: label, ...fo(2, '#8a7a5a') }, g);
    E('path', { d: 'M-24,30 L24,30 M-18,46 L18,46 M-12,60 L12,60', ...fo(3, '#9c6b3e') }, g);
    E('path', { d: 'M-28,-4 L-28,96', stroke: '#fff', 'stroke-width': 7, opacity: .45, 'stroke-linecap': 'round' }, g);
    E('path', { d: 'M-8,-110 L-8,-66', stroke: '#fff', 'stroke-width': 4, opacity: .45, 'stroke-linecap': 'round' }, g);
    return g;
  };
  // a wooden pepper mill; grains are animated by the scene (they fall from about y 110)
  F.pepper = (p, s = 1) => {
    const g = E('g', { transform: `scale(${s})` }, p);
    const wood = lin(p, [[0, '#6e3c1c'], [.35, '#b8743c'], [.55, '#cf9454'], [1, '#5e3216']], 0, 0, 1, 0), ink = '#3e200e';
    E('circle', { cx: 0, cy: -142, r: 11, fill: wood, ...fo(2.4, ink) }, g);
    E('path', { d: 'M-30,-118 C-30,-138 30,-138 30,-118 L24,-104 L-24,-104Z', fill: wood, ...fo(2.6, ink) }, g);
    E('path', { d: 'M-28,-104 L28,-104 C34,-60 22,-30 26,0 C30,40 40,70 38,100 L-38,100 C-40,70 -30,40 -26,0 C-22,-30 -34,-60 -28,-104Z', fill: wood, ...fo(2.6, ink) }, g);
    E('path', { d: 'M-27,-62 L27,-62 M-30,42 L30,42', stroke: '#4a2812', 'stroke-width': 2.4, opacity: .6 }, g);
    E('rect', { x: -40, y: 96, width: 80, height: 14, rx: 5, fill: '#4a2812', ...fo(2, '#2e180a') }, g);
    E('path', { d: 'M-15,-96 C-19,-60 -11,-30 -13,0 C-15,40 -23,70 -21,90', fill: 'none', stroke: '#f6cf9c', 'stroke-width': 6, opacity: .55, 'stroke-linecap': 'round' }, g);
    return g;
  };
  F.corns = (p, n = 9, seed = 3) => {
    const g = E('g', {}, p), r = rng(seed);
    for (let i = 0; i < n; i++) { const x = (r() - .5) * 70, y = (r() - .5) * 26, rr = 5 + r() * 2; E('circle', { cx: x, cy: y, r: rr, fill: '#2a1d16', ...fo(1.2, '#120c08') }, g); E('circle', { cx: x - rr * .35, cy: y - rr * .35, r: rr * .3, fill: '#8a7a6a' }, g); }
    return g;
  };
  F.garlic = (p) => {
    const g = E('g', {}, p);
    E('path', { d: 'M0,-74 C12,-52 64,-30 64,12 C64,58 32,74 0,74 C-32,74 -64,58 -64,12 C-64,-30 -12,-52 0,-74Z', fill: rad(p, [[0, '#fffdf8'], [.7, '#f1e8da'], [1, '#d9c8b0']], .4, .4, .7), ...fo(2.6, '#7a6650') }, g);
    E('path', { d: 'M0,-60 C-20,-20 -24,40 -6,72 M0,-60 C22,-20 26,40 8,72 M-36,-10 C-46,20 -40,52 -28,66 M36,-10 C46,20 40,52 28,66', fill: 'none', stroke: '#c9b79a', 'stroke-width': 2.4 }, g);
    E('path', { d: 'M-20,20 C-24,40 -18,56 -10,64 M24,24 C26,40 22,54 16,62', fill: 'none', stroke: '#c79ab8', 'stroke-width': 4, opacity: .5, 'stroke-linecap': 'round' }, g);
    E('path', { d: 'M-14,74 L-20,90 M0,74 L0,92 M14,74 L20,90', stroke: '#b8a688', 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
    E('ellipse', { cx: -30, cy: -4, rx: 8, ry: 20, fill: '#fff', opacity: .8, transform: 'rotate(20,-30,-4)' }, g);
    return g;
  };
  F.onion = (p) => {
    const g = E('g', {}, p);
    E('path', { d: 'M0,-84 C8,-62 72,-40 72,12 C72,62 36,78 0,78 C-36,78 -72,62 -72,12 C-72,-40 -8,-62 0,-84Z', fill: rad(p, [[0, '#f0b468'], [.7, '#cf8a42'], [1, '#9a5a24']], .4, .4, .7), ...fo(2.6, '#6a3a14') }, g);
    E('path', { d: 'M0,-70 C-30,-20 -34,40 -8,76 M0,-70 C30,-20 34,40 8,76', fill: 'none', stroke: '#9a5f27', 'stroke-width': 2.4 }, g);
    E('path', { d: 'M-40,-10 C-46,10 -44,30 -36,44', stroke: '#ffe0b0', 'stroke-width': 7, fill: 'none', 'stroke-linecap': 'round', opacity: .8 }, g);
    return g;
  };
  F.bacon = (p) => {
    const g = E('g', {}, p);
    const wave = (y, h) => `M-110,${y} C-70,${y - 24} -30,${y + 24} 10,${y} C50,${y - 24} 90,${y + 24} 110,${y} L110,${y + h} C90,${y + h + 24} 50,${y + h - 24} 10,${y + h} C-30,${y + h + 24} -70,${y + h - 24} -110,${y + h}Z`;
    E('path', { d: wave(-30, 60), fill: lin(p, [[0, '#f09a90'], [1, '#d4706a']]), ...fo(2.6, '#7a2e24') }, g);
    E('path', { d: wave(-12, 12), fill: '#fbece4' }, g);
    E('path', { d: wave(12, 9), fill: '#fbece4' }, g);
    E('path', { d: 'M-90,-26 C-60,-44 -40,-20 -14,-28', fill: 'none', stroke: '#fff', 'stroke-width': 4, opacity: .6, 'stroke-linecap': 'round' }, g);
    return g;
  };
  F.salt = (p, s = 1) => {          // a pinch: fingers and falling grains are animated by the scene
    const g = E('g', { transform: `scale(${s})` }, p);
    E('path', { d: 'M-30,-120 C-34,-60 -30,-20 -10,0 C10,10 30,0 34,-20 C40,-60 36,-100 34,-130Z', fill: lin(p, [[0, '#f8dcc2'], [1, '#eebd98']], 0, 0, 1, 0), ...fo(2.6, '#8a5a40') }, g);
    E('path', { d: 'M-10,0 C-4,-20 10,-24 22,-12', fill: 'none', ...fo(2.4, '#8a5a40') }, g);
    E('path', { d: 'M-20,-110 C-22,-70 -18,-40 -6,-20', fill: 'none', stroke: '#fff', 'stroke-width': 5, opacity: .35, 'stroke-linecap': 'round' }, g);
    return g;
  };
  F.pan = (p, s = 1) => {           // iron pan seen from above at an angle; returns { g, inside } (inside is clipped)
    const g = E('g', { transform: `scale(${s})` }, p);
    E('path', { d: 'M300,-24 L640,-46 Q666,-40 664,-18 L660,4 Q640,22 620,18 L300,26Z', fill: lin(p, [[0, '#4a4850'], [1, '#1f1e22']]), ...fo(3, '#121114') }, g);
    E('circle', { cx: 630, cy: -14, r: 10, fill: '#5b5960' }, g);
    E('ellipse', { cx: 0, cy: 16, rx: 340, ry: 160, fill: '#1f1e22', ...fo(3, '#121114') }, g);
    E('ellipse', { cx: 0, cy: 0, rx: 340, ry: 152, fill: lin(p, [[0, '#5a5862'], [1, '#2c2b31']]), ...fo(3, '#121114') }, g);
    E('ellipse', { cx: 0, cy: 8, rx: 304, ry: 128, fill: rad(p, [[0, '#4a4952'], [.7, '#2c2b31'], [1, '#18171c']]) }, g);
    E('path', { d: 'M-280,-40 C-200,-110 -60,-130 40,-128', stroke: '#b4b2bc', 'stroke-width': 5, fill: 'none', opacity: .55, 'stroke-linecap': 'round' }, g);
    const inside = E('g', { 'clip-path': clip(p, { tag: 'ellipse', a: { cx: 0, cy: 8, rx: 304, ry: 128 } }) }, g);
    return { g, inside };
  };
  F.pot = (p) => {                  // stock pot, front view; returns { g, water } (water surface group, clipped)
    const g = E('g', {}, p);
    E('path', { d: 'M-268,-150 L-300,-110 L-268,-90 M268,-150 L300,-110 L268,-90', fill: 'none', ...st(20, '#3a3a40') }, g);
    E('path', { d: 'M-250,-150 L-250,170 Q-250,210 -210,210 L210,210 Q250,210 250,170 L250,-150Z', fill: lin(p, [[0, '#8d96a0'], [.32, '#eef3f6'], [.5, '#c9d1d8'], [1, '#7c858f']], 0, 0, 1, 0), ...fo(3, '#3e444c') }, g);
    E('ellipse', { cx: 0, cy: -150, rx: 250, ry: 56, fill: '#d7dee4', ...fo(3, '#3e444c') }, g);
    E('ellipse', { cx: 0, cy: -146, rx: 230, ry: 46, fill: '#7d8791' }, g);
    const water = E('g', { 'clip-path': clip(p, { tag: 'ellipse', a: { cx: 0, cy: -140, rx: 228, ry: 42 } }) }, g);
    E('ellipse', { cx: 0, cy: -136, rx: 228, ry: 42, fill: lin(p, [[0, '#cdeef9'], [1, '#86c4de']]) }, water);
    E('path', { d: 'M-190,-60 L-190,150', stroke: '#fff', 'stroke-width': 18, opacity: .45, 'stroke-linecap': 'round' }, g);
    return { g, water };
  };
  F.flames = (p) => {
    const g = E('g', {}, p), fl = [];
    for (let k = 0; k < 9; k++) {
      const f = E('g', { transform: `translate(${-200 + k * 50},0)` }, g);
      E('path', { d: 'M0,0 C-18,-10 -14,-40 0,-62 C14,-40 18,-10 0,0Z', fill: '#4b7bea' }, f);
      E('path', { d: 'M0,-4 C-8,-10 -6,-26 0,-38 C6,-26 8,-10 0,-4Z', fill: '#b9dcff' }, f);
      fl.push(f);
    }
    return { g, update: t => fl.forEach((f, k) => f.setAttribute('transform', `translate(${-200 + k * 50},0) scale(1,${(.8 + .25 * Math.sin(t * 13 + k * 1.9)).toFixed(3)})`)) };
  };
  F.bowl = (p) => {                 // white ceramic bowl with a blue band; returns { g, inside, front }
    const g = E('g', {}, p);
    E('ellipse', { cx: 0, cy: 0, rx: 310, ry: 96, fill: '#f8f5ee', ...fo(2.6, '#7a6a58') }, g);
    E('ellipse', { cx: 0, cy: 4, rx: 280, ry: 80, fill: lin(p, [[0, '#d8cfbd'], [1, '#efe9dd']]) }, g);
    const inside = E('g', {}, g);
    const front = E('g', {}, g);
    E('path', { d: 'M-310,0 C-300,200 -160,270 0,270 C160,270 300,200 310,0 C290,70 150,96 0,96 C-150,96 -290,70 -310,0Z', fill: lin(p, [[0, '#ffffff'], [.6, '#f1ece2'], [1, '#d4cbba']], 0, 0, 1, 0), ...fo(2.6, '#7a6a58') }, front);
    E('path', { d: 'M-296,70 C-220,130 -110,150 0,150 C110,150 220,130 296,70', fill: 'none', stroke: '#2f5fa8', 'stroke-width': 14 }, front);
    E('path', { d: 'M-276,110 C-200,160 -100,178 0,178 C100,178 200,160 276,110', fill: 'none', stroke: '#2f5fa8', 'stroke-width': 5 }, front);
    E('path', { d: 'M-230,70 C-200,160 -140,210 -80,232', stroke: '#fff', 'stroke-width': 14, fill: 'none', opacity: .85, 'stroke-linecap': 'round' }, front);
    return { g, inside, front };
  };
  // a white plate with a thin blue band, soft shadow and a glint on the rim
  F.plate = (p, rx = 250, ry = 100) => {
    const g = E('g', {}, p);
    E('ellipse', { cx: rx * .03, cy: ry * .28, rx: rx * 1.02, ry: ry * .8, fill: '#3a2010', opacity: .3, filter: blur(p, 9) }, g);
    E('ellipse', { cx: 0, cy: 0, rx, ry, fill: lin(p, [[0, '#ffffff'], [1, '#e6dece']]), ...fo(2.4, '#8a7a66') }, g);
    E('ellipse', { cx: 0, cy: -ry * .04, rx: rx * .88, ry: ry * .86, fill: 'none', stroke: '#2f5fa8', 'stroke-width': Math.max(3, rx * .018), opacity: .85 }, g);
    E('ellipse', { cx: 0, cy: -ry * .05, rx: rx * .76, ry: ry * .72, fill: lin(p, [[0, '#e4dccb'], [1, '#faf7f0']]) }, g);
    E('path', { d: `M${-rx * .9},${-ry * .2} C${-rx * .7},${-ry * .85} ${-rx * .2},${-ry * 1.0} ${rx * .2},${-ry * .98}`, fill: 'none', stroke: '#fff', 'stroke-width': Math.max(4, rx * .025), opacity: .9, 'stroke-linecap': 'round' }, g);
    return g;
  };
  // smooth path through points (Catmull-Rom to cubic Bezier)
  const smooth = P => { let d = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`; for (let i = 0; i < P.length - 1; i++) { const a = P[i - 1] || P[i], b = P[i], c = P[i + 1], e = P[i + 2] || c; d += ` C${(b[0] + (c[0] - a[0]) / 6).toFixed(1)},${(b[1] + (c[1] - a[1]) / 6).toFixed(1)} ${(c[0] - (e[0] - b[0]) / 6).toFixed(1)},${(c[1] - (e[1] - b[1]) / 6).toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)}`; } return d; };
  const pastaPal = sauce => sauce ? { sh: '#c4692f', base: '#eb9a50', lt: '#fbcb88', ink: '#6a2c12', gap: '#b4582a' }
                                  : { sh: '#d39d48', base: '#f2c66c', lt: '#fde4a4', ink: '#7a5222', gap: '#b07c34' };
  // a heap of spaghetti in the hand-drawn animation style: a loose tangle of thin strands with thin dark lines and flat
  // cel tones (shadow / base / light), a few glints; sauce:true = coated orange with dabs of tomato sauce among the strands
  F.nest = (p, { w = 230, h = 90, seed = 4, sauce = false } = {}) => {
    const g = E('g', {}, p), r = rng(seed), hw = w / 2, ry = hw * .36, H = h * .8, pal = pastaPal(sauce);
    const ht = (u, v) => Math.pow(Math.max(0, 1 - (u * u + v * v)), .75);
    const proj = (u, v) => [u * hw, v * ry - H * ht(u, v)];
    E('ellipse', { cx: 0, cy: ry * .45, rx: hw * 1.04, ry: ry * 1.05, fill: '#4a2410', opacity: .26, filter: blur(p, 6) }, g);
    // the heap body in the gap tone, so no plate shows between strands
    const top = [], bot = [];
    for (let k = 0; k <= 30; k++) { const u = (-1 + 2 * k / 30) * .95, vm = Math.sqrt(Math.max(0, .9025 - u * u)); let yt = 1e9; for (let j = 0; j <= 16; j++) yt = Math.min(yt, proj(u, -vm + 2 * vm * j / 16)[1]); top.push([u * hw, yt]); bot.push([u * hw, proj(u, vm)[1]]); }
    E('path', { d: smooth([...top, ...bot.reverse()]) + 'Z', fill: pal.gap }, g);
    const n = Math.round(w * .46), sw = Math.max(2.6, w * .0135), strands = [];
    for (let i = 0; i < n; i++) {
      const rr = Math.pow(r(), .35) * .94, a = r() * 6.283; let u = Math.cos(a) * rr, v = Math.sin(a) * rr, ang = r() * 6.283, curv = (r() - .5) * .5;
      const P = [], steps = 16 + Math.floor(r() * 18); let sv = 0, sh = 0;
      for (let k = 0; k < steps; k++) {
        ang += curv + (r() - .5) * .3; curv *= .96;
        u += Math.cos(ang) * .06; v += Math.sin(ang) * .06;
        const q = u * u + v * v; if (q > .97) { const m = Math.sqrt(.97 / q); u *= m; v *= m; ang += 2.2; }
        P.push(proj(u, v)); sv += v; sh += ht(u, v);
      }
      strands.push({ P, z: sv / steps + .6 * sh / steps, hgt: sh / steps, front: sv / steps, gl: r() });
    }
    strands.sort((a, b) => a.z - b.z);
    const dabAt = Math.floor(strands.length * .72);
    strands.forEach((s, i) => {
      if (sauce && i === dabAt) for (let k = 0; k < 11; k++) {      // tomato sauce caught among the strands
        const rr = Math.sqrt(r()) * .75, a = r() * 6.283, [x, y] = proj(Math.cos(a) * rr, Math.sin(a) * rr), br = w * (.022 + r() * .02);
        E('path', { d: `M${(x - br * 1.4).toFixed(1)},${y.toFixed(1)} C${(x - br).toFixed(1)},${(y - br * 1.1).toFixed(1)} ${(x + br).toFixed(1)},${(y - br * 1.2).toFixed(1)} ${(x + br * 1.4).toFixed(1)},${(y - br * .1).toFixed(1)} C${(x + br).toFixed(1)},${(y + br * .8).toFixed(1)} ${(x - br).toFixed(1)},${(y + br * .7).toFixed(1)} ${(x - br * 1.4).toFixed(1)},${y.toFixed(1)}Z`, fill: k % 3 ? '#c8361e' : '#a92a16', stroke: pal.ink, 'stroke-width': 1.3 }, g);
        E('ellipse', { cx: (x - br * .4).toFixed(1), cy: (y - br * .45).toFixed(1), rx: (br * .45).toFixed(1), ry: (br * .2).toFixed(1), fill: '#fff4ea', opacity: .9 }, g);
      }
      const tone = s.hgt > .62 ? pal.lt : s.hgt > .22 || s.front > .45 ? pal.base : pal.sh;
      const d = smooth(s.P);
      E('path', { d, fill: 'none', stroke: pal.ink, 'stroke-width': sw + 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      E('path', { d, fill: 'none', stroke: tone, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      if (s.gl > .62 && s.hgt > .3) E('path', { d, fill: 'none', stroke: '#fffaf0', 'stroke-width': sw * .4, 'stroke-linecap': 'round', 'stroke-dasharray': `${(w * .03).toFixed(0)} ${(w * .25).toFixed(0)}`, 'stroke-dashoffset': (s.gl * w * .3).toFixed(0), transform: `translate(0,${(-sw * .25).toFixed(1)})` }, g);
    });
    return g;
  };
  // a fork lifting a twirl of spaghetti out of the heap; update(lift) raises it (0 = in the heap)
  F.twirl = (p, { w = 230, h = 90, seed = 6, sauce = true } = {}) => {
    const g = E('g', {}, p), r = rng(seed), pal = pastaPal(sauce), H = h * .8, sw = Math.max(2.6, w * .0135);
    const hang = E('g', {}, g), fork = E('g', {}, g), coil = E('g', {}, g);
    // fork: four tines, neck and a long handle going up to the right
    E('path', { d: 'M-16,-6 L-16,-58 M-5.5,-6 L-5.5,-62 M5.5,-6 L5.5,-62 M16,-6 L16,-58', fill: 'none', stroke: '#5b6068', 'stroke-width': 7.5, 'stroke-linecap': 'round' }, fork);
    E('path', { d: 'M-16,-6 L-16,-58 M-5.5,-6 L-5.5,-62 M5.5,-6 L5.5,-62 M16,-6 L16,-58', fill: 'none', stroke: '#dfe4ea', 'stroke-width': 4.2, 'stroke-linecap': 'round' }, fork);
    E('path', { d: 'M-20,-58 Q0,-48 20,-58 L12,-84 Q6,-110 30,-180 L150,-380 L168,-370 L50,-168 Q20,-112 14,-84Z', fill: lin(p, [[0, '#f2f5f8'], [.5, '#c3cad2'], [1, '#8e97a2']], 0, 0, 1, 0), stroke: '#4c525a', 'stroke-width': 2.4, 'stroke-linejoin': 'round' }, fork);
    E('path', { d: 'M24,-150 L142,-356', stroke: '#ffffff', 'stroke-width': 4, opacity: .8, 'stroke-linecap': 'round' }, fork);
    // the coil wrapped around the tines: a few rounds of strands, lit from the top
    for (let k = 0; k < 7; k++) {
      const y = -34 + k * 5 - (k % 2) * 2, rx = 30 + (k % 3) * 3, rv = 11 + (k % 2) * 2;
      const d = `M${-rx},${y} C${-rx},${y + rv * 1.3} ${rx},${y + rv * 1.3} ${rx},${y} C${rx},${y - rv * .9} ${-rx * .3},${y - rv * 1.1} ${-rx * .6},${y - rv * .4}`;
      E('path', { d, fill: 'none', stroke: pal.ink, 'stroke-width': sw + 1.7, 'stroke-linecap': 'round' }, coil);
      E('path', { d, fill: 'none', stroke: k < 3 ? pal.lt : k < 6 ? pal.base : pal.sh, 'stroke-width': sw, 'stroke-linecap': 'round' }, coil);
    }
    E('path', { d: 'M-22,-36 Q-6,-44 12,-38', fill: 'none', stroke: '#fffaf0', 'stroke-width': sw * .5, 'stroke-linecap': 'round' }, coil);
    const dabs = [[-12, -24], [14, -18]].map(([x, y]) => E('ellipse', { cx: x, cy: y, rx: 6, ry: 4, fill: '#c8361e', stroke: pal.ink, 'stroke-width': 1.2 }, coil));
    const strands = [...Array(7)].map((_, i) => ({ x0: -20 + i * 6.5, x1: (r() - .5) * w * .32, wob: (r() - .5) * 22, tone: i % 3 ? pal.base : pal.lt }));
    const paths = strands.map(s => [E('path', { fill: 'none', stroke: pal.ink, 'stroke-width': sw + 1.7, 'stroke-linecap': 'round' }, hang), E('path', { fill: 'none', stroke: s.tone, 'stroke-width': sw, 'stroke-linecap': 'round' }, hang)]);
    return { g, update(lift) {
      const ty = -H * .85 - lift;
      fork.setAttribute('transform', `translate(0,${ty.toFixed(1)})`); coil.setAttribute('transform', `translate(0,${ty.toFixed(1)})`);
      strands.forEach((s, i) => { const y0 = ty + 6, y1 = -H * .7, my = (y0 + y1) / 2;
        const d = `M${s.x0},${y0.toFixed(1)} C${(s.x0 + s.wob).toFixed(1)},${my.toFixed(1)} ${(s.x1 - s.wob).toFixed(1)},${my.toFixed(1)} ${s.x1.toFixed(1)},${y1.toFixed(1)}`;
        paths[i].forEach(q => { q.setAttribute('d', d); q.style.display = lift > 4 ? '' : 'none'; }); });
    } };
  };
  // soft white wisps of steam
  F.steam = (p, x, y, n = 3, s = 1) => {
    const g = E('g', { transform: `translate(${x},${y}) scale(${s})`, filter: blur(p, 4) }, p), ps = [];
    for (let k = 0; k < n; k++) ps.push(E('path', { d: 'M0,0 C-26,-40 26,-80 0,-120 C-26,-160 20,-200 0,-240', fill: 'none', stroke: '#ffffff', 'stroke-width': 22, 'stroke-linecap': 'round', opacity: 0 }, g));
    return { g, update(t, amt = 1) { ps.forEach((q, k) => { const ph = (t * .45 + k / n) % 1; q.setAttribute('transform', `translate(${(k - (n - 1) / 2) * 70},${(-ph * 120).toFixed(1)}) scale(${(.7 + ph * .5).toFixed(3)})`); q.setAttribute('opacity', (amt * .6 * Math.sin(Math.PI * ph)).toFixed(3)); }); } };
  };

  window.Painted = { E, st, nid, rng, clamp, eout, eio, tr, scene, lin, rad, blur, clip, cloud, sheep, village, landscape, kitchen, counter, Cook, talkAt, blinkAt, F, INK, mix };
// yt-toon patch: end of module wrapper
};
