// cartoon-shorts core: the timeline engine of every episode page. A page loads timeline.js (written by engine/audio.py),
// the style modules it uses (engine/styles/*.js), this file and its scenes.js, then calls Short.start(build, {fonts}).
// Every animation is keyed to the voice-over, so re-voicing moves the visuals.
//
// Times ("when"): 1.5 | L5 (line 5 starts) | L5e (ends) | L5%60 (60% into it) | L5+.3 | block (scene starts) | blocke (ends) | block+.4
// Markup:  data-k="slam@L5+.2 fade@L7:0.3"  presets below, optional duration after ':'
//          data-on="L5..L7e"                 visible only in that window ("a..b,c..d" for several)
//          <div class="scene" data-scene="id" data-tr="flash|zoom|whip|glitch|cut">  shown only during its scene
// Captions come from each line's "cap" in short.json: *words* in stars are highlighted, cap null = none.
// yt-toon patch: module wrapper (window and document are passed in), was an IIFE
export default (window, document) => {
  const TL = window.TIMELINE, anims = [], ups = [], shakes = [], filters = [];
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const eout = x => 1 - Math.pow(1 - x, 3);
  const eio = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  const sceneById = Object.fromEntries(TL.scenes.map(s => [s.id, s]));

  function T(expr) {
    if (typeof expr === 'number') return expr;
    const s = String(expr).trim();
    // yt-toon patch: beats are written B5 (L5 still works)
    let m = /^[LB](\d+)(e|%[\d.]+)?([+-][\d.]+)?$/.exec(s);
    if (m) {
      const l = TL.lines[+m[1]]; if (!l) throw new Error('no line ' + s);
      const frac = m[2] === 'e' ? 1 : m[2] ? parseFloat(m[2].slice(1)) / 100 : 0;
      return l.t + l.d * frac + (+m[3] || 0);
    }
    m = /^S(\d+)([+-][\d.]+)?$/.exec(s);           // S2 = third scene starts (same as audio.py)
    if (m) { const sc = TL.scenes[+m[1]]; if (!sc) throw new Error('no scene ' + s); return sc.start + (+m[2] || 0); }
    m = /^([a-z][a-z0-9_]*)([+-][\d.]+)?$/.exec(s);
    if (m) {
      const off = +m[2] || 0;
      if (sceneById[m[1]]) return sceneById[m[1]].start + off;
      if (m[1].endsWith('e') && sceneById[m[1].slice(0, -1)]) return sceneById[m[1].slice(0, -1)].end + off;
      throw new Error('bad time ' + s);
    }
    const n = parseFloat(s);
    if (Number.isNaN(n)) throw new Error('bad time ' + s);
    return n;
  }

  const P = {
    slam:  [[{opacity: 0, transform: 'scale(2.4)'}, {opacity: 1, transform: 'scale(.94)', offset: .7}, {opacity: 1, transform: 'scale(1)'}], .26, 'cubic-bezier(.2,.9,.3,1)'],
    smash: [[{opacity: 0, transform: 'scale(3.5) rotate(-12deg)'}, {opacity: 1, transform: 'scale(.9) rotate(-4deg)', offset: .65}, {opacity: 1, transform: 'scale(1) rotate(-4deg)'}], .3, 'cubic-bezier(.2,.9,.3,1)'],
    up:    [[{opacity: 0, transform: 'translateY(60px)'}, {opacity: 1, transform: 'none'}], .3, 'cubic-bezier(.2,.7,.2,1)'],
    down:  [[{opacity: 0, transform: 'translateY(-90px)'}, {opacity: 1, transform: 'translateY(8px)', offset: .7}, {opacity: 1, transform: 'none'}], .38, 'cubic-bezier(.2,.7,.2,1)'],
    left:  [[{opacity: 0, transform: 'translateX(-160px)'}, {opacity: 1, transform: 'none'}], .3, 'cubic-bezier(.2,.8,.2,1)'],
    right: [[{opacity: 0, transform: 'translateX(160px)'}, {opacity: 1, transform: 'none'}], .3, 'cubic-bezier(.2,.8,.2,1)'],
    fade:  [[{opacity: 0}, {opacity: 1}], .3, 'ease-out'],
    out:   [[{opacity: 1}, {opacity: 0}], .25, 'ease-in'],
    pop:   [[{opacity: 0, transform: 'scale(.3)'}, {opacity: 1, transform: 'scale(1)'}], .34, 'cubic-bezier(.3,1.7,.5,1)'],
    stamp: [[{opacity: 0, transform: 'scale(2.6) rotate(-16deg)'}, {opacity: 1, transform: 'scale(1) rotate(-7deg)'}], .24, 'cubic-bezier(.3,1.3,.5,1)'],
    growx: [[{transform: 'scaleX(0)'}, {transform: 'scaleX(1)'}], .45, 'cubic-bezier(.3,.8,.3,1)'],
    growy: [[{transform: 'scaleY(0)'}, {transform: 'scaleY(1)'}], .45, 'cubic-bezier(.3,.8,.3,1)'],
    nudge: [[{transform: 'scale(1)'}, {transform: 'scale(1.12)'}, {transform: 'scale(1)'}], .3, 'ease-in-out'],
    wipe:  [[{clipPath: 'inset(0 100% 0 0)'}, {clipPath: 'inset(0 0 0 0)'}], .35, 'cubic-bezier(.3,.8,.3,1)'],
  };

  function add(el, kf, start, dur, easing = 'linear', fill = 'both') {
    const a = el.animate(kf, {duration: dur * 1000, delay: start * 1000, fill, easing});
    a.pause(); anims.push(a); return a;
  }
  function wire(root) {
    root.querySelectorAll('[data-k]').forEach(el => el.dataset.k.trim().split(/\s+/).forEach((item, i) => {
      const at = item.indexOf('@');
      const name = item.slice(0, at), [when, d] = item.slice(at + 1).split(':');
      if (!P[name]) throw new Error('unknown preset ' + name);
      const [kf, dur, easing] = P[name];
      if (name === 'growx' && !el.style.transformOrigin) el.style.transformOrigin = 'left center';
      if (name === 'growy' && !el.style.transformOrigin) el.style.transformOrigin = 'center bottom';
      add(el, kf, T(when), d ? +d : dur, easing, i === 0 ? 'both' : 'forwards');
    }));
    const ons = [...root.querySelectorAll('[data-on]')].map(el => [el, el.dataset.on.split(',').map(r => r.split('..').map(T))]);
    ups.push(t => ons.forEach(([el, rs]) => { el.style.visibility = rs.some(([a, b]) => t >= a && t < b) ? '' : 'hidden'; }));
  }

  // scenes: visible in [start, end) with an entry transition; the whole frame shakes and flashes on cue
  function scenes(root) {
    const list = [...root.querySelectorAll('.scene[data-scene]')].map(el => [el, sceneById[el.dataset.scene], el.dataset.tr || 'zoom']);
    list.forEach(([el, sc]) => { if (!sc) throw new Error('scene not in timeline: ' + el.dataset.scene); });
    const flash = document.getElementById('flash'), world = document.getElementById('world');
    list.forEach(([el, sc, tr]) => { if (sc.start > 0 && tr !== 'cut' && tr !== 'glitch') add(flash, [{opacity: tr === 'flash' ? .9 : .35}, {opacity: 0}], sc.start, tr === 'flash' ? .3 : .18, 'ease-out', 'none'); });
    ups.push(t => {
      list.forEach(([el, sc, tr]) => {
        const on = t >= sc.start && t < sc.end;
        el.style.display = on ? '' : 'none';
        if (!on) return;
        const k = eout(clamp((t - sc.start) / .28));
        let tf = '';
        if (sc.start > 0) {
          if (tr === 'zoom') tf = `scale(${1 + .12 * (1 - k)})`;
          if (tr === 'whip') tf = `translateX(${(1 - k) * 700}px)`;
          if (tr === 'flash') tf = `scale(${1 + .06 * (1 - k)})`;
        }
        el.style.transform = tf;
        el.style.filter = tr === 'whip' && k < 1 ? `blur(${(1 - k) * 18}px)` : '';
      });
      let dx = 0, dy = 0, rot = 0;
      for (const [a, d, amp] of shakes) if (t >= a && t < a + d) { const p = (t - a) / d; dx += amp * (1 - p) * Math.sin(p * 61); dy += amp * (1 - p) * Math.cos(p * 47); rot += amp * .04 * (1 - p) * Math.sin(p * 33); }
      world.style.transform = dx || dy ? `translate(${dx}px,${dy}px) rotate(${rot}deg)` : '';
      const f = filters.filter(([a, d]) => t >= a && t < a + d).map(x => x[2]);
      world.style.filter = f.join(' ');
    });
  }

  // captions: a few words at a time, timed by their length inside each voiced line
  function captions() {
    const box = document.getElementById('cap'), chunks = [];
    TL.lines.forEach((ln, i) => {
      if (!ln.cap) return;
      let hi = false;
      const words = ln.cap.split(/\s+/).map(w => {
        const open = w.startsWith('*') || w.startsWith('"*'), close = /\*["'.,!?;:]*$/.test(w);
        if (open) hi = true;
        const word = {txt: w.replace(/\*/g, ''), hi};
        if (close) hi = false;
        return word;
      });
      const groups = [];
      let cur = [];
      words.forEach((w, k) => {
        cur.push(w);
        const len = cur.map(x => x.txt).join(' ').length;
        const next = words[k + 1];
        if (!next || /[.,?!:;]["']?$/.test(w.txt) || cur.length >= 3 || len + (next ? next.txt.length : 0) > 15) { groups.push(cur); cur = []; }
      });
      const weight = g => g.reduce((s, w) => s + w.txt.length + 2, 0), total = groups.reduce((s, g) => s + weight(g), 0);
      const nextT = TL.lines[i + 1] ? TL.lines[i + 1].t : ln.t + ln.d + .6;
      let acc = 0;
      groups.forEach((g, k) => {
        const a = ln.t + ln.d * acc / total;
        acc += weight(g);
        const b = k === groups.length - 1 ? Math.min(nextT, ln.t + ln.d + .45) : ln.t + ln.d * acc / total;
        chunks.push({a, b, html: g.map(w => w.hi ? `<b>${esc(w.txt)}</b>` : esc(w.txt)).join(' ')});
      });
    });
    let shown = null;
    const span = document.createElement('span');
    box.appendChild(span);
    ups.push(t => {
      const c = chunks.find(c => t >= c.a && t < c.b) || null;
      if (c !== shown) { span.innerHTML = c ? c.html : ''; shown = c; }
      if (c) {
        const k = clamp((t - c.a) / .12);
        span.style.transform = `scale(${.7 + .3 * eout(k) + .06 * Math.sin(Math.PI * k)}) rotate(${(1 - k) * -3}deg)`;
        span.style.opacity = clamp(k * 3);
      }
    });
  }

  // film grain: one noise tile made at load time, jittered every frame
  function grain() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d'), im = g.createImageData(256, 256);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < im.data.length; i += 4) { const v = rnd() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; }
    g.putImageData(im, 0, 0);
    const el = document.getElementById('grain');
    if (!el) return;
    el.style.backgroundImage = `url(${c.toDataURL()})`;
    // 10 changes a second: enough to feel like film, light on the encoder
    ups.push(t => { const f = Math.floor(t * 10); el.style.backgroundPosition = `${(f * 97) % 256}px ${(f * 61) % 256}px`; });
  }

  const counter = (fn, from, to, at, dur, ease = eio) => { const a = T(at); ups.push(t => fn(from + (to - from) * ease(clamp((t - a) / dur)), t)); };
  const typer = (el, text, at, cps = 30) => {
    const t0 = T(at);
    ups.push(t => { const n = clamp(Math.floor((t - t0) * cps), 0, text.length); el.textContent = text.slice(0, n); });
  };
  // run fn(t, k) only while t is in [a, b): k = progress 0..1
  const during = (a, b, fn) => { const A = T(a), B = T(b); ups.push(t => { if (t >= A && t < B) fn(t, (t - A) / (B - A)); }); };

  // ---- building helpers shared by every style
  const NS = 'http://www.w3.org/2000/svg';
  const E = (tag, a = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (parent) parent.appendChild(e); return e; };
  const tr = (el, x, y, s = 1, r = 0) => el.setAttribute('transform', `translate(${(+x).toFixed(1)},${(+y).toFixed(1)}) rotate(${(+r).toFixed(2)}) scale(${(+s).toFixed(4)})`);
  // a scene: <div class="scene"> with a full-frame SVG; draw into .cam (moved by camera()), put HTML text on .div with ov()
  function scene(world, id, trn = 'zoom') {
    const div = document.createElement('div');
    div.className = 'scene'; div.dataset.scene = id; div.dataset.tr = trn;
    world.appendChild(div);
    const svg = E('svg', {viewBox: '0 0 1080 1920', width: 1080, height: 1920}, div);
    const defs = E('defs', {}, svg);
    svg.defs = defs;                              // fx.js gradients look for svg.defs
    return {id, div, svg, defs, cam: E('g', {}, svg)};
  }
  // escape text for HTML: captions, and any text from research or the user that goes into ov()
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
  // plain-text overlay: same as ov() but the text is never read as HTML (use it for names, quotes, titles from research)
  const ovText = (sc, text, css, k = '', on = '', cls = '') => { const d = ov(sc, '', css, k, on, cls); d.textContent = text; return d; };
  // HTML overlay on a scene (trusted markup only; wrap outside text in esc()): ov(sc, '<b>Hi</b>', 'left:0;right:0;top:300px;text-align:center', 'slam@L0', 'L0..L2e', 'title')
  function ov(sc, html, css, k = '', on = '', cls = '') {
    const d = document.createElement('div');
    d.className = 'a' + (cls ? ' ' + cls : ''); d.innerHTML = html; d.style.cssText = css;
    if (k) d.dataset.k = k;
    if (on) d.dataset.on = on;
    sc.div.appendChild(d); return d;
  }
  // slow camera push over a whole scene (or any window): scale `from` -> `to` around (cx, cy)
  function camera(sc, a = sc.id, b = sc.id + 'e', from = 1, to = 1.06, cx = 540, cy = 900) {
    during(a, b, (t, k) => { const s = from + (to - from) * eio(k); sc.cam.setAttribute('transform', `translate(${cx},${cy}) scale(${s.toFixed(4)}) translate(${-cx},${-cy})`); });
  }
  // a layer redrawn from scratch every frame while its scene is on (a..b): for busts and props whose draw() rebuilds
  // the SVG; it also removes the clip paths and gradients the last frame added to the scene's <defs>
  function live(sc, fn, a = sc.id, b = sc.id + 'e') {
    const g = E('g', {}, sc.cam), A = T(a), B = T(b);
    let made = [];
    ups.push(t => {
      if (t < A || t >= B) return;
      while (g.firstChild) g.firstChild.remove();
      made.forEach(d => d.remove());
      const before = new Set(sc.defs.children);
      fn(g, t);
      made = [...sc.defs.children].filter(d => !before.has(d));
    });
    return g;
  }
  // progress 0..1 of t between two times
  const prog = (t, a, b) => clamp((t - T(a)) / (T(b) - T(a)));

  window.seek = async t => {
    for (const a of anims) a.currentTime = t * 1000;
    for (const f of ups) f(t);
  };
  window.Short = {
    T, add, ups, clamp, eout, eio, counter, typer, during, TL, sceneById, E, tr, scene, ov, ovText, esc, camera, prog, live,
    line: i => TL.lines[i],
    shake: (at, dur = .4, amp = 22) => shakes.push([T(at), dur, amp]),
    filter: (at, dur, css) => filters.push([T(at), dur, css]),
    impact: (at, frames = 3) => { const a = T(at); filters.push([a, frames / 30, 'invert(1) grayscale(1) contrast(3)']); filters.push([a + frames / 30, 4 / 30, 'drop-shadow(10px 0 0 rgba(255,0,60,.75)) drop-shadow(-10px 0 0 rgba(0,220,255,.75))']); },
    chroma: (at, dur = .2, px = 8) => filters.push([T(at), dur, `drop-shadow(${px}px 0 0 rgba(255,0,60,.7)) drop-shadow(-${px}px 0 0 rgba(0,220,255,.7))`]),
    flashAt: (at, op = .9, dur = .3) => add(document.getElementById('flash'), [{opacity: op}, {opacity: 0}], T(at), dur, 'ease-out', 'none'),
    // opts.fonts: CSS font shorthands the page needs, e.g. ['900 100px Fraunces']; render.mjs warns when one did not load
    start(build, opts = {}) {
      window.ready = (async () => {
        await Promise.all((opts.fonts || []).map(f => document.fonts.load(f).catch(() => null)));
        await document.fonts.ready;
        const fonts = (opts.fonts || []).map(f => document.fonts.check(f));
        const v = document.getElementById('v');
        if (build) await build();
        wire(v); scenes(v); captions(); grain();
        await seek(0);
        const overflow = [];
        for (const sc of TL.scenes) {
          await seek((sc.start + sc.end) / 2);
          document.querySelectorAll(`.scene[data-scene="${sc.id}"] [data-fit]`).forEach(el => {
            if (el.scrollWidth > el.clientWidth + 1) overflow.push(sc.id + ':' + (el.id || el.className));
          });
        }
        await seek(0);
        return {total: TL.total, fonts, overflow};
      })();
    },
  };
// yt-toon patch: end of module wrapper
};
