// FX: cartoon set pieces and effects for comic-style scenes (SVG). Builders draw once; animated pieces register a
// per-frame update with Short.ups (they only do work inside their own time window).
// yt-toon patch: module wrapper (window and document are passed in), was an IIFE
export default (window, document) => {
  const NS = 'http://www.w3.org/2000/svg', OL = '#17111b';
  const E = (tag, a = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (parent) parent.appendChild(e); return e; };
  const n1 = x => Math.round(x * 10) / 10;
  const rnd = seed => { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
  const S = () => window.Short;
  const win = (a, b, fn) => { const A = S().T(a), B = S().T(b); S().ups.push(t => { if (t >= A && t < B) fn(t, (t - A) / (B - A)); }); };
  let uid = 0;

  const FX = {
    E, OL, rnd, n1,
    svg(scene) { const s = E('svg', {viewBox: '0 0 1080 1920', width: 1080, height: 1920}); scene.prepend(s); s.defs = E('defs', {}, s); return s; },
    g(parent, a = {}) { return E('g', a, parent); },
    lin(svg, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1) {
      const id = 'g' + (++uid), g = E('linearGradient', {id, x1, y1, x2, y2}, svg.defs);
      stops.forEach(([o, c, op = 1]) => E('stop', {offset: o, 'stop-color': c, 'stop-opacity': op}, g));
      return `url(#${id})`;
    },
    rad(svg, stops, cx = .5, cy = .5, r = .5) {
      const id = 'g' + (++uid), g = E('radialGradient', {id, cx, cy, r}, svg.defs);
      stops.forEach(([o, c, op = 1]) => E('stop', {offset: o, 'stop-color': c, 'stop-opacity': op}, g));
      return `url(#${id})`;
    },
    dots(svg, color = '#000', size = 18, r = 4, op = 1) {
      const id = 'p' + (++uid), p = E('pattern', {id, width: size, height: size, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)'}, svg.defs);
      E('circle', {cx: size / 2, cy: size / 2, r, fill: color, 'fill-opacity': op}, p);
      return `url(#${id})`;
    },
    rect(g, x, y, w, h, fill, a = {}) { return E('rect', Object.assign({x, y, width: w, height: h, fill}, a), g); },
    // camera: keys [[when, cx, cy, zoom, rot, ease]] -> the group looks at (cx, cy) placed at the frame's (540, 860)
    cam(g, keys, fx = 540, fy = 860) {
      const tr = window.Toon.track(keys.map(([w, cx, cy, z = 1, r = 0, e]) => [S().T(w), [cx, cy, z, r], e]));
      S().ups.push(t => { const [cx, cy, z, r] = tr(t); g.setAttribute('transform', `translate(${fx},${fy}) rotate(${n1(r)}) scale(${z}) translate(${n1(-cx)},${n1(-cy)})`); });
    },
    // sunburst wedges spinning slowly
    rays(g, cx, cy, n, color, op = .25, speed = 6, r = 2400) {
      const gg = E('g', {opacity: op}, g);
      let d = '';
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = a0 + Math.PI / n;
        d += `M0,0 L${n1(Math.cos(a0) * r)},${n1(Math.sin(a0) * r)} L${n1(Math.cos(a1) * r)},${n1(Math.sin(a1) * r)} Z `;
      }
      E('path', {d, fill: color}, gg);
      S().ups.push(t => gg.setAttribute('transform', `translate(${cx},${cy}) rotate(${n1(t * speed)})`));
      return gg;
    },
    // comic explosion star
    burst(g, cx, cy, r1, r2, n, fill, stroke = OL, sw = 8, seed = 3) {
      const R = rnd(seed); let d = '';
      for (let i = 0; i < n * 2; i++) {
        const a = (i / (n * 2)) * Math.PI * 2, r = i % 2 ? r1 * (.85 + R() * .3) : r2 * (.8 + R() * .35);
        d += (i ? 'L' : 'M') + n1(cx + Math.cos(a) * r) + ',' + n1(cy + Math.sin(a) * r);
      }
      return E('path', {d: d + 'Z', fill, stroke, 'stroke-width': sw, 'stroke-linejoin': 'round'}, g);
    },
    // radial speed lines that re-draw on every frame
    speed(g, cx, cy, rIn, rOut, n, color, a, b, w = 10) {
      const p = E('path', {fill: color}, g);
      win(a, b, t => {
        const R = rnd(Math.floor(t * 24) * 31 + 7); let d = '';
        for (let i = 0; i < n; i++) {
          const ang = R() * Math.PI * 2, r0 = rIn + R() * 160, r1 = rOut, ww = (w * (.4 + R())) / r1;
          d += `M${n1(cx + Math.cos(ang) * r0)},${n1(cy + Math.sin(ang) * r0)} L${n1(cx + Math.cos(ang - ww) * r1)},${n1(cy + Math.sin(ang - ww) * r1)} L${n1(cx + Math.cos(ang + ww) * r1)},${n1(cy + Math.sin(ang + ww) * r1)} Z `;
        }
        p.setAttribute('d', d);
      });
      S().ups.push(t => { p.style.display = t >= S().T(a) && t < S().T(b) ? '' : 'none'; });
      return p;
    },
    // horizontal motion streaks
    streaks(g, x0, x1, y0, y1, n, color, a, b, speed = 2400) {
      const p = E('path', {fill: color}, g);
      const R = rnd(11), L = [...Array(n)].map(() => [R(), y0 + R() * (y1 - y0), 80 + R() * 260, 3 + R() * 7]);
      win(a, b, t => {
        let d = '';
        for (const [o, y, len, w] of L) { const x = x1 - ((o * (x1 - x0) + t * speed) % (x1 - x0 + len)); d += `M${n1(x)},${n1(y)} h${n1(len)} v${n1(w)} h${n1(-len)} Z `; }
        p.setAttribute('d', d);
      });
      S().ups.push(t => { p.style.display = t >= S().T(a) && t < S().T(b) ? '' : 'none'; });
      return p;
    },
    confetti(g, a, b, colors, n = 140, x0 = 0, x1 = 1080, y0 = -200, fall = 520, seed = 5) {
      const R = rnd(seed), bits = [...Array(n)].map(() => ({x: x0 + R() * (x1 - x0), y: y0 - R() * 900, v: fall * (.6 + R() * .7), sw: 20 + R() * 50, ph: R() * 6, w: 10 + R() * 12, h: 18 + R() * 16,
        c: colors[Math.floor(R() * colors.length)], spin: 200 + R() * 500}));
      const els = bits.map(q => E('rect', {x: -q.w / 2, y: -q.h / 2, width: q.w, height: q.h, fill: q.c, rx: 2}, g));
      const A = S().T(a);
      win(a, b, t => {
        const dt = t - A;
        bits.forEach((q, i) => {
          const y = q.y + q.v * dt, x = q.x + Math.sin(dt * 2.2 + q.ph) * q.sw;
          els[i].setAttribute('transform', `translate(${n1(x)},${n1(y)}) rotate(${n1(dt * q.spin + q.ph * 50)}) scale(${n1(Math.cos(dt * 5 + q.ph) * 100) / 100},1)`);
        });
      });
      S().ups.push(t => { g.style.display = t >= A && t < S().T(b) ? '' : 'none'; });
    },
    // cartoon flames: layered tongues that flicker
    flames(g, cx, base, w, h, a, b) {
      const layers = [['#ff4d1f', 1], ['#ff9a1f', .78], ['#ffe14a', .52]].map(([c, k]) => [E('path', {fill: c, stroke: k === 1 ? OL : 'none', 'stroke-width': 7, 'stroke-linejoin': 'round'}, g), k]);
      win(a, b, (t, kk) => {
        const grow = Math.min(1, (t - S().T(a)) / .5);
        layers.forEach(([p, k], li) => {
          const n = 7, W = w * k, H = h * k * grow; let d = `M${n1(cx - W / 2)},${base}`;
          for (let i = 0; i <= n; i++) {
            const x = cx - W / 2 + (W * i) / n, fl = Math.sin(t * 9 + i * 1.7 + li) * .18 + Math.sin(t * 15 + i * 2.9) * .1;
            const peak = H * (.55 + .45 * Math.sin((i / n) * Math.PI)) * (1 + fl);
            d += ` Q${n1(x - W / n / 2)},${n1(base - peak * .6)} ${n1(x)},${n1(base - peak)}`;
            if (i < n) d += ` Q${n1(x + W / n / 4)},${n1(base - peak * .5)} ${n1(x + W / n / 2)},${n1(base - peak * .35)}`;
          }
          p.setAttribute('d', d + ` L${n1(cx + W / 2)},${base} Z`);
        });
      });
    },
    rain(g, a, b, n = 90, color = 'rgba(190,215,255,.45)', seed = 9) {
      const R = rnd(seed), drops = [...Array(n)].map(() => [R() * 1300 - 100, R() * 2000, 900 + R() * 700, 40 + R() * 60]);
      const p = E('path', {stroke: color, 'stroke-width': 4, 'stroke-linecap': 'round', fill: 'none'}, g);
      win(a, b, t => {
        let d = '';
        for (const [x, y, v, len] of drops) { const yy = ((y + t * v) % 2100) - 100, xx = x - yy * .18; d += `M${n1(xx)},${n1(yy)} l${n1(-len * .18)},${n1(len)} `; }
        p.setAttribute('d', d);
      });
    },
    // arena crowd: rows of heads and shoulders, bobbing; camera flashes pop at random
    crowd(g, x0, x1, y0, rows, a, b, excite = .3, seed = 4, dark = .55, palette = null) {
      const R = rnd(seed), pal = palette || ['#7a1f3d', '#ffb81c', '#1d428a', '#f5f2ea', '#2b2533', '#c43c4f', '#ffc72c', '#3b3448'];
      const skins = ['#8a5a3c', '#c58c62', '#5e3a26', '#e0b089', '#3f2618'];
      const people = [];
      for (let r = 0; r < rows; r++) {
        const y = y0 + r * 58, sp = 46 + r * 2;
        for (let x = x0 - (r % 2) * 23; x < x1; x += sp) {
          const p = E('g', {}, g);
          E('path', {d: `M-24,40 Q-24,6 0,6 Q24,6 24,40 Z`, fill: pal[Math.floor(R() * pal.length)]}, p);
          E('circle', {cx: 0, cy: -8, r: 15, fill: skins[Math.floor(R() * skins.length)]}, p);
          const arm = R() < .35 ? E('path', {d: 'M14,18 L26,-26', stroke: skins[0], 'stroke-width': 9, 'stroke-linecap': 'round'}, p) : null;
          people.push({p, x: x + R() * 10, y, ph: R() * 6, arm});
        }
      }
      E('rect', {x: x0 - 60, y: y0 - 40, width: x1 - x0 + 120, height: rows * 58 + 60, fill: '#0b0912', opacity: dark}, g);
      const flashes = E('g', {}, g), FR = [...Array(10)].map(() => E('path', {fill: '#fff'}, flashes));
      const ex = typeof excite === 'function' ? excite : () => excite;
      win(a, b, t => {
        const e = ex(t);
        people.forEach(q => {
          const bob = Math.max(0, Math.sin(t * (4 + e * 6) + q.ph)) * (4 + e * 22);
          q.p.setAttribute('transform', `translate(${n1(q.x)},${n1(q.y - bob)})`);
          if (q.arm) q.arm.style.display = e > .5 ? '' : 'none';
        });
        const RR = rnd(Math.floor(t * 12) * 7 + 1);
        FR.forEach(f => {
          if (RR() < .25 + e * .5) { const x = x0 + RR() * (x1 - x0), y = y0 + RR() * rows * 58, s = 8 + RR() * 14;
            f.setAttribute('d', `M${n1(x)},${n1(y - s)} L${n1(x + s * .25)},${n1(y - s * .25)} L${n1(x + s)},${n1(y)} L${n1(x + s * .25)},${n1(y + s * .25)} L${n1(x)},${n1(y + s)} L${n1(x - s * .25)},${n1(y + s * .25)} L${n1(x - s)},${n1(y)} L${n1(x - s * .25)},${n1(y - s * .25)} Z`); f.style.display = ''; }
          else f.style.display = 'none';
        });
      });
    },
    // side view of the court: wood band, lines and a glossy reflection
    court(svg, g, x0, x1, y, h = 760) {
      const wood = FX.lin(svg, [[0, '#d99a55'], [.5, '#c27f3f'], [1, '#9c5f2c']]);
      E('rect', {x: x0, y, width: x1 - x0, height: h, fill: wood}, g);
      const planks = E('path', {stroke: 'rgba(90,45,15,.35)', 'stroke-width': 3, fill: 'none'}, g);
      let d = ''; for (let yy = y + 30; yy < y + h; yy += 34 + (yy - y) * .08) d += `M${x0},${n1(yy)} H${x1} `;
      planks.setAttribute('d', d);
      E('rect', {x: x0, y: y + 8, width: x1 - x0, height: 10, fill: '#f5f2ea', opacity: .9}, g);
      E('rect', {x: x0, y, width: x1 - x0, height: 120, fill: FX.lin(svg, [[0, '#fff', .28], [1, '#fff', 0]])}, g);
    },
    // hoop seen from the side, facing left (the rim sticks out to the left of the backboard); returns the net for swishes
    hoop(g, x, y, s = 1, flip = false) {
      const h = E('g', {transform: `translate(${x},${y}) scale(${flip ? -s : s},${s})`}, g);
      E('path', {d: 'M70,-150 L70,420 M70,420 L170,420 L170,1200', fill: 'none', stroke: OL, 'stroke-width': 30, 'stroke-linejoin': 'round'}, h);
      E('path', {d: 'M70,-150 L70,420 M70,420 L170,420 L170,1200', fill: 'none', stroke: '#3b3a45', 'stroke-width': 18, 'stroke-linejoin': 'round'}, h);
      E('rect', {x: 20, y: -170, width: 34, height: 230, rx: 6, fill: '#e8f4ff', stroke: OL, 'stroke-width': 7}, h);
      E('rect', {x: 26, y: -90, width: 22, height: 70, fill: 'none', stroke: '#e8343d', 'stroke-width': 5}, h);
      const net = E('path', {fill: 'none', stroke: '#fbf3e4', 'stroke-width': 4, 'stroke-linejoin': 'round'}, h);
      const rim = E('path', {d: 'M-90,0 L20,0', stroke: '#ff5a1f', 'stroke-width': 12, 'stroke-linecap': 'round'}, h);
      E('path', {d: 'M-90,0 L20,0', stroke: OL, 'stroke-width': 20, 'stroke-linecap': 'round'}, h).before(rim);
      h.insertBefore(net, rim);
      const setNet = (k = 0) => {
        // k: 0 rest, 1 = ball through (net stretched and swinging)
        const sw = Math.sin(k * Math.PI) * 18, len = 100 + Math.sin(k * Math.PI) * 30;
        let d = '';
        for (let i = 0; i <= 5; i++) { const xt = -88 + i * 21.6, xb = -70 + i * 14 + sw; d += `M${n1(xt)},4 L${n1(xb)},${n1(len)} `; }
        for (let j = 1; j <= 3; j++) { const yy = (len * j) / 3.4, xa = -88 + 18 * (j / 3) + sw * j / 3, xb2 = 20 - 18 * (j / 3) + sw * j / 3; d += `M${n1(xa)},${n1(yy)} L${n1(xb2)},${n1(yy)} `; }
        net.setAttribute('d', d);
      };
      setNet(0);
      return {g: h, setNet, rim: [x + (flip ? 35 : -35) * s, y]};
    },
    stars(g, n, w, h, seed = 2, op = .8) {
      const R = rnd(seed); let d = '';
      for (let i = 0; i < n; i++) { const x = R() * w, y = R() * h, s = 1.5 + R() * 3; d += `M${n1(x)},${n1(y - s)} L${n1(x + s * .3)},${n1(y)} L${n1(x)},${n1(y + s)} L${n1(x - s * .3)},${n1(y)} Z `; }
      return E('path', {d, fill: '#fff', opacity: op}, g);
    },
    skyline(g, x0, x1, base, color, seed = 6, hmin = 120, hmax = 420, lit = '#ffd27a') {
      const R = rnd(seed), gg = E('g', {}, g);
      let x = x0;
      while (x < x1) {
        const w = 70 + R() * 110, h = hmin + R() * (hmax - hmin);
        E('rect', {x: n1(x), y: n1(base - h), width: n1(w), height: n1(h + 4), fill: color, stroke: OL, 'stroke-width': 5}, gg);
        for (let wy = base - h + 24; wy < base - 20; wy += 34) for (let wx = x + 14; wx < x + w - 18; wx += 26)
          if (R() < .32) E('rect', {x: n1(wx), y: n1(wy), width: 12, height: 16, fill: lit, opacity: .85}, gg);
        x += w + 6 + R() * 20;
      }
      return gg;
    },
    house(g, x, y, w, h, wall, roof, lit = true) {
      const gg = E('g', {}, g);
      E('rect', {x, y: y - h, width: w, height: h, fill: wall, stroke: OL, 'stroke-width': 7}, gg);
      E('path', {d: `M${x - 26},${y - h + 6} L${x + w / 2},${y - h - w * .42} L${x + w + 26},${y - h + 6} Z`, fill: roof, stroke: OL, 'stroke-width': 7, 'stroke-linejoin': 'round'}, gg);
      const win = E('rect', {x: x + w * .16, y: y - h * .72, width: w * .3, height: h * .3, fill: lit ? '#ffcf5a' : '#2c3550', stroke: OL, 'stroke-width': 6}, gg);
      E('path', {d: `M${x + w * .31},${y - h * .72} V${y - h * .42} M${x + w * .16},${y - h * .57} H${x + w * .46}`, stroke: OL, 'stroke-width': 4}, gg);
      E('rect', {x: x + w * .6, y: y - h * .55, width: w * .24, height: h * .55, fill: '#5a3b2a', stroke: OL, 'stroke-width': 6}, gg);
      gg.win = win;
      return gg;
    },
    streetlight(g, x, y, h = 620, glowColor = '#ffd27a', svg) {
      const gg = E('g', {}, g);
      if (svg) E('path', {d: `M${x + 40},${y - h + 30} L${x - 160},${y} L${x + 260},${y} Z`, fill: FX.lin(svg, [[0, glowColor, .4], [1, glowColor, 0]]), opacity: .8}, gg);
      E('path', {d: `M${x},${y} V${y - h} Q${x},${y - h - 40} ${x + 50},${y - h - 30}`, fill: 'none', stroke: OL, 'stroke-width': 18, 'stroke-linecap': 'round'}, gg);
      E('path', {d: `M${x},${y} V${y - h} Q${x},${y - h - 40} ${x + 50},${y - h - 30}`, fill: 'none', stroke: '#3c4152', 'stroke-width': 8, 'stroke-linecap': 'round'}, gg);
      E('path', {d: `M${x + 22},${y - h - 26} h56 l-10,26 h-36 Z`, fill: '#ffe9a8', stroke: OL, 'stroke-width': 6, 'stroke-linejoin': 'round'}, gg);
      return gg;
    },
    palm(g, x, y, s = 1, color = '#1a0f2a') {
      const gg = E('g', {transform: `translate(${x},${y}) scale(${s})`}, g);
      E('path', {d: 'M0,0 Q20,-200 -10,-420', fill: 'none', stroke: color, 'stroke-width': 26, 'stroke-linecap': 'round'}, gg);
      for (const [a, l] of [[-160, 200], [-120, 230], [-60, 230], [-20, 200], [-95, 170], [20, 150], [-200, 150]]) {
        const r = a * Math.PI / 180, ex = -10 + Math.cos(r) * l, ey = -420 + Math.sin(r) * l * .6 + 60;
        E('path', {d: `M-10,-420 Q${n1(-10 + Math.cos(r) * l * .5)},${n1(-470 + Math.sin(r) * l * .3)} ${n1(ex)},${n1(ey)} Q${n1(-10 + Math.cos(r) * l * .45)},${n1(-430 + Math.sin(r) * l * .2)} -10,-420 Z`, fill: color}, gg);
      }
      return gg;
    },
    trophy(g, x, y, s = 1) {
      const gg = E('g', {transform: `translate(${x},${y}) scale(${s})`}, g), gold = '#ffc83a', goldD = '#d9951a';
      E('path', {d: 'M-60,0 h120 l-12,-40 h-96 Z', fill: '#3a2d4a', stroke: OL, 'stroke-width': 7, 'stroke-linejoin': 'round'}, gg);
      E('path', {d: 'M-16,-40 L-12,-110 h24 L16,-40 Z', fill: goldD, stroke: OL, 'stroke-width': 7}, gg);
      E('path', {d: 'M-70,-260 Q-70,-120 0,-110 Q70,-120 70,-260 Z', fill: gold, stroke: OL, 'stroke-width': 8, 'stroke-linejoin': 'round'}, gg);
      E('path', {d: 'M-40,-250 Q-38,-150 -6,-128', fill: 'none', stroke: '#fff3c4', 'stroke-width': 9, 'stroke-linecap': 'round', opacity: .8}, gg);
      E('circle', {cx: 0, cy: -300, r: 40, fill: gold, stroke: OL, 'stroke-width': 8}, gg);
      E('path', {d: 'M-40,-300 h80 M0,-340 v80 M-28,-328 q16,28 0,56 M28,-328 q-16,28 0,56', fill: 'none', stroke: goldD, 'stroke-width': 5}, gg);
      return gg;
    },
    ring(g, x, y, s = 1, label = '') {
      const gg = E('g', {transform: `translate(${x},${y}) scale(${s})`}, g), gold = '#ffc83a';
      E('ellipse', {cx: 0, cy: 50, rx: 120, ry: 110, fill: 'none', stroke: OL, 'stroke-width': 54}, gg);
      E('ellipse', {cx: 0, cy: 50, rx: 120, ry: 110, fill: 'none', stroke: gold, 'stroke-width': 38}, gg);
      E('path', {d: 'M-90,-40 h180 l-20,-90 h-140 Z', fill: gold, stroke: OL, 'stroke-width': 9, 'stroke-linejoin': 'round'}, gg);
      E('path', {d: 'M-60,-100 h120 l12,46 h-144 Z', fill: '#e8f6ff', stroke: OL, 'stroke-width': 6, 'stroke-linejoin': 'round'}, gg);
      E('path', {d: 'M-40,-90 l14,30 M0,-92 l0,32 M40,-90 l-14,30', stroke: '#9fd8ff', 'stroke-width': 6}, gg);
      if (label) { const tx = E('text', {x: 0, y: 70, 'text-anchor': 'middle', 'font-family': 'Anton', 'font-size': 64, fill: '#fff', stroke: OL, 'stroke-width': 8, 'paint-order': 'stroke fill'}, gg); tx.textContent = label; }
      return gg;
    },
    jersey(g, x, y, s, color, trim, num, numFill = trim, sleeves = false) {
      const gg = E('g', {transform: `translate(${x},${y}) scale(${s})`}, g);
      const d = sleeves ? 'M-150,-210 L-60,-250 Q0,-200 60,-250 L150,-210 L200,-90 L130,-60 L120,-130 L120,230 L-120,230 L-120,-130 L-130,-60 L-200,-90 Z'
        : 'M-120,-250 L-60,-250 Q0,-170 60,-250 L120,-250 Q110,-130 150,-90 L150,230 L-150,230 L-150,-90 Q-110,-130 -120,-250 Z';
      E('path', {d, fill: color, stroke: OL, 'stroke-width': 10, 'stroke-linejoin': 'round'}, gg);
      E('path', {d: 'M-60,-250 Q0,-170 60,-250', fill: 'none', stroke: trim, 'stroke-width': 12}, gg);
      const tx = E('text', {x: 0, y: 120, 'text-anchor': 'middle', 'font-family': 'Anton', 'font-size': 230, fill: numFill, stroke: OL, 'stroke-width': 12, 'paint-order': 'stroke fill'}, gg);
      tx.textContent = num;
      return gg;
    },
    box(g, x, y, w, h, label = '') {
      const gg = E('g', {transform: `translate(${x},${y})`}, g);
      E('rect', {x: -w / 2, y: -h, width: w, height: h, fill: '#c8955a', stroke: OL, 'stroke-width': 6}, gg);
      E('path', {d: `M${-w / 2},${-h} l${w * .18},${-h * .18} h${w * .64} l${w * .18},${h * .18}`, fill: '#ddb07a', stroke: OL, 'stroke-width': 6, 'stroke-linejoin': 'round'}, gg);
      E('rect', {x: -w * .08, y: -h, width: w * .16, height: h * .5, fill: '#e9d6a8', opacity: .8}, gg);
      if (label) { const tx = E('text', {x: 0, y: -h * .25, 'text-anchor': 'middle', 'font-family': 'Bangers', 'font-size': h * .26, fill: OL}, gg); tx.textContent = label; }
      return gg;
    },
    desk(g, x, y, s = 1, color = '#c9a173') {
      const gg = E('g', {transform: `translate(${x},${y}) scale(${s})`}, g);
      E('path', {d: 'M-80,0 V-120 M80,0 V-120 M-120,0 V-70 M-40,0 V-70', stroke: OL, 'stroke-width': 12, 'stroke-linecap': 'round'}, gg);
      E('rect', {x: -110, y: -140, width: 220, height: 26, rx: 6, fill: color, stroke: OL, 'stroke-width': 7}, gg);
      E('rect', {x: -150, y: -84, width: 130, height: 20, rx: 6, fill: color, stroke: OL, 'stroke-width': 6}, gg);
      E('rect', {x: -152, y: -190, width: 20, height: 110, rx: 6, fill: color, stroke: OL, 'stroke-width': 6}, gg);
      return gg;
    },
    football(g, x, y, s = 1, rot = -20) {
      const gg = E('g', {transform: `translate(${x},${y}) rotate(${rot}) scale(${s})`}, g);
      E('ellipse', {rx: 46, ry: 28, fill: '#8a4a26', stroke: OL, 'stroke-width': 6}, gg);
      E('path', {d: 'M-18,0 H18 M-12,-6 V6 M-4,-6 V6 M4,-6 V6 M12,-6 V6', stroke: '#fff', 'stroke-width': 3.5}, gg);
      return gg;
    },
    school(g, x, y, s = 1) {
      const gg = E('g', {transform: `translate(${x},${y}) scale(${s})`}, g);
      E('rect', {x: -360, y: -420, width: 720, height: 420, fill: '#c9573a', stroke: OL, 'stroke-width': 9}, gg);
      for (let r = 0; r < 9; r++) E('path', {d: `M-360,${-40 - r * 44} H360`, stroke: 'rgba(0,0,0,.12)', 'stroke-width': 4}, gg);
      E('path', {d: 'M-400,-420 L0,-560 L400,-420 Z', fill: '#4a3a5a', stroke: OL, 'stroke-width': 9, 'stroke-linejoin': 'round'}, gg);
      for (const wx of [-300, -190, 110, 220]) for (const wy of [-360, -220]) {
        E('rect', {x: wx, y: wy, width: 80, height: 90, fill: '#ffe08a', stroke: OL, 'stroke-width': 6}, gg);
        E('path', {d: `M${wx + 40},${wy} v90 M${wx},${wy + 45} h80`, stroke: OL, 'stroke-width': 4}, gg);
      }
      E('rect', {x: -70, y: -200, width: 140, height: 200, fill: '#5a3b2a', stroke: OL, 'stroke-width': 8}, gg);
      E('path', {d: 'M0,-200 V0', stroke: OL, 'stroke-width': 5}, gg);
      gg.sign = E('g', {}, gg);
      E('rect', {x: -330, y: -520, width: 660, height: 110, rx: 14, fill: '#fbf3e4', stroke: OL, 'stroke-width': 9}, gg.sign);
      return gg;
    },
    // pop a group in with a springy scale at `when`
    popIn(el, when, dur = .35, cx = 0, cy = 0, from = 0) {
      const A = S().T(when);
      S().ups.push(t => {
        const k = Math.max(0, Math.min(1, (t - A) / dur));
        const e = k === 0 ? from : 1 + Math.sin(k * Math.PI * 1.3) * (1 - k) * .45;
        el.setAttribute('transform', (el.dataset.base || '') + ` translate(${cx},${cy}) scale(${n1(Math.max(0, k === 0 ? from : e) * 1000) / 1000}) translate(${-cx},${-cy})`);
        el.style.display = t < A && from === 0 ? 'none' : '';
      });
    },
  };
  window.FX = FX;
// yt-toon patch: end of module wrapper
};
