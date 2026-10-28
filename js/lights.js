/*!
 * DeepawaliLights: SVG fairy lights for the hero.
 *
 *   var lights = DeepawaliLights.mount(containerEl, { strands, palette });
 *   lights.turnOn({ duration: 1400, from: 'center' });   // 'center' | 'left' | 'right' | 'edges' | 'random'
 *   lights.turnOff(); lights.setVisible(bool); lights.destroy();
 *
 * Extras for the page glue (all optional):
 *   lights.pointAt(fx, strand)  -> { x, y, angle }  point on a wire, fx 0..1 across the width, container px
 *   lights.layout()             -> { width, height, scale, span, strands:[{ y, sag, anchors:[x…] }] }
 *   lights.isOn()               -> boolean
 *   lights.resize()             -> force a rebuild now (normally automatic via ResizeObserver)
 *   The container gets the CSS variable --lights-h (px) = height the artwork needs, and fires a
 *   "deepawali:lights-layout" CustomEvent (detail: { width, height }) after each build.
 *
 * Classic script, ES2017, no dependencies, no console output, no storage, no network.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc || (global.DeepawaliLights && global.DeepawaliLights.__v)) return;

  var NS = 'http://www.w3.org/2000/svg';
  var STYLE_ID = 'dwl-lights-css';
  var RM_QUERY = '(prefers-reduced-motion: reduce)';

  var DEFAULT_STRANDS = [
    { y: 0, sag: 46, spacing: 46, scale: 1, opacity: 1 },
    { y: 14, sag: 30, spacing: 38, scale: 0.8, opacity: 0.75 }
  ];
  var DEFAULT_PALETTE = ['#FFD27A', '#FFB347', '#FFF1C9'];

  // Bulb geometry in local units (attach point = 0,0; y grows downward; 1 unit = 1px at scale 1).
  var CY = 15; // glass centre (halo / core / twinkle origin)
  var GLASS_PTS = [[-2.4, 6.6], [-2.7, 9.2], [-5.8, 10.6], [-5.8, 15], [-5.8, 19.2], [-3.2, 22.2], [0, 22.2],
                   [3.2, 22.2], [5.8, 19.2], [5.8, 15], [5.8, 10.6], [2.7, 9.2], [2.4, 6.6]];
  var HALO_R = 30;
  var BULB_MUL = 1.12; // overall bulb size vs. the nominal 1px/unit

  var uidCounter = 0;
  var styleRefs = 0;
  var registry = typeof WeakMap === 'function' ? new WeakMap() : null;

  /* ------------------------------------------------------------------ CSS */

  var CSS = [
    '.dwl-svg{display:block;position:relative;width:100%;overflow:hidden;pointer-events:none;-webkit-user-select:none;user-select:none}',
    '.dwl-svg *{pointer-events:none}',
    /* ignition: opacity + transform only, per-bulb delay arrives through --dwl-delay */
    '.dwl-lit{opacity:0;transition:opacity .55s ease-out var(--dwl-delay,0s)}',
    '.dwl-halo{transform:scale(.35);transition:transform 1s cubic-bezier(.2,1.55,.35,1) var(--dwl-delay,0s)}',
    '.dwl-hi{opacity:0;transition:opacity 1.4s ease-out .25s}',
    '.dwl-on .dwl-lit{opacity:1}',
    '.dwl-on .dwl-halo{transform:scale(1)}',
    '.dwl-on .dwl-hi{opacity:1}',
    '.dwl-now .dwl-lit,.dwl-now .dwl-halo,.dwl-now .dwl-hi{transition:none}',
    /* twinkle: each bulb carries its own duration / offset / depth as custom properties */
    '.dwl-tw{opacity:var(--dwl-lvl,1)}',
    '.dwl-tw{animation-duration:var(--dwl-dur,4s);animation-delay:var(--dwl-ofs,0s);animation-iteration-count:infinite;animation-timing-function:ease-in-out}',
    '.dwl-t1{animation-name:dwl-b1}.dwl-t2{animation-name:dwl-b2}.dwl-t3{animation-name:dwl-b3;animation-timing-function:linear}',
    '@keyframes dwl-b1{0%,100%{opacity:1;transform:scale(1)}50%{opacity:var(--dwl-min,.6);transform:scale(var(--dwl-hs,.88))}}',
    '@keyframes dwl-b2{0%,100%{opacity:1;transform:scale(1)}18%{opacity:.9;transform:scale(.96)}34%{opacity:1;transform:scale(1)}56%{opacity:var(--dwl-min,.55);transform:scale(var(--dwl-hs,.86))}72%{opacity:.95;transform:scale(.97)}86%{opacity:.72;transform:scale(.9)}}',
    '@keyframes dwl-b3{0%,60%,100%{opacity:1;transform:scale(1)}66%{opacity:var(--dwl-min,.3);transform:scale(var(--dwl-hs,.8))}72%{opacity:.96;transform:scale(.98)}80%{opacity:.5;transform:scale(.84)}90%{opacity:1;transform:scale(1)}}',
    /* nothing animates before ignition, while off-screen / hidden, or under reduced motion */
    '.dwl-svg:not(.dwl-on) .dwl-tw,.dwl-paused .dwl-tw{animation-play-state:paused}',
    '.dwl-rm .dwl-tw{animation:none}',
    '.dwl-rm .dwl-lit,.dwl-rm .dwl-halo,.dwl-rm .dwl-hi{transition:none}'
  ].join('\n');

  function acquireStyle() {
    styleRefs++;
    if (doc.getElementById(STYLE_ID)) return;
    var s = doc.createElement('style');
    s.id = STYLE_ID;
    s.appendChild(doc.createTextNode(CSS));
    (doc.head || doc.documentElement).appendChild(s);
  }
  function releaseStyle() {
    styleRefs = Math.max(0, styleRefs - 1);
    if (styleRefs > 0) return;
    var s = doc.getElementById(STYLE_ID);
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }

  /* -------------------------------------------------------------- helpers */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function oddNearest(v, min) {
    var n = Math.round(v);
    if (n % 2 === 0) n += (v > n ? 1 : -1);
    return Math.max(min || 1, n);
  }

  function svgEl(name, attrs, parent) {
    var n = doc.createElementNS(NS, name);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
      }
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  /* Colours: accept any CSS colour, resolve to [r,g,b]. */
  function parseColor(c, probeHost) {
    var m;
    if (typeof c !== 'string') return null;
    c = c.trim();
    if ((m = /^#([0-9a-f]{3})$/i.exec(c))) {
      return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
    }
    if ((m = /^#([0-9a-f]{6})/i.exec(c))) {
      return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    }
    if ((m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(c))) {
      return [+m[1], +m[2], +m[3]];
    }
    try {
      var p = doc.createElement('span');
      p.style.color = c;
      p.style.display = 'none';
      (probeHost || doc.body || doc.documentElement).appendChild(p);
      var cs = global.getComputedStyle(p).color;
      p.parentNode.removeChild(p);
      if ((m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(cs))) return [+m[1], +m[2], +m[3]];
    } catch (e) { /* fall through */ }
    return null;
  }
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function rgb(c) { return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')'; }

  /* Catenary: a*(cosh(L/2a)-1) = sag, solved for a by bisection in log space.
     Depth below the anchor line: d(u) = 2a sinh(u/2a) sinh((L-u)/2a)  (numerically stable form). */
  function solveCatenary(L, sag) {
    if (sag < 0.05) return 1e9;
    var lo = L / 2000, hi = 1e9, mid, i, f;
    for (i = 0; i < 70; i++) {
      mid = Math.sqrt(lo * hi);
      var sh = Math.sinh(L / (4 * mid));
      f = 2 * mid * sh * sh; // = a (cosh(L/2a) - 1)
      if (f > sag) lo = mid; else hi = mid;
    }
    return Math.sqrt(lo * hi);
  }
  function catDepth(u, L, a) {
    if (a >= 1e8) return 0;
    return 2 * a * Math.sinh(u / (2 * a)) * Math.sinh((L - u) / (2 * a));
  }

  /* ---------------------------------------------------------------- layout */

  function normalizeStrands(input) {
    var src = (input && input.length) ? input : DEFAULT_STRANDS;
    var out = [], i, d, s;
    for (i = 0; i < src.length && i < 4; i++) {
      s = src[i] || {};
      d = DEFAULT_STRANDS[i] || { y: i * 14, sag: Math.max(18, 46 - i * 14), spacing: 38, scale: Math.max(0.6, 1 - i * 0.2), opacity: Math.max(0.5, 1 - i * 0.25) };
      out.push({
        y: num(s.y, d.y),
        sag: num(s.sag, d.sag),
        spacing: Math.max(12, num(s.spacing, d.spacing)),
        scale: clamp(num(s.scale, d.scale), 0.3, 3),
        opacity: clamp(num(s.opacity, d.opacity), 0, 1)
      });
    }
    return out;
  }

  /* Pure geometry for a given width. Strand 0 hangs from anchors at the edges (odd swag count, so a
     swag and a bulb sit on the centre axis); strand 1 is offset by half a swag so the two interleave. */
  function computeLayout(W, strandsIn, scaleOverride) {
    var k = scaleOverride > 0 ? scaleOverride : clamp(Math.pow(W / 1440, 0.45), 0.6, 1.65);
    var n = oddNearest(W / (270 * k), 3);
    var span = W / n;
    var pad = 5 * k;
    var N = 40; // samples per swag
    var result = { k: k, n: n, span: span, strands: [], height: 0, width: W };
    var maxBottom = 0, maxGlow = 0;

    for (var si = 0; si < strandsIn.length; si++) {
      var s = strandsIn[si];
      var offset = (si % 2 === 1);
      var nSpans = offset ? n + 1 : n;
      var xStart = offset ? -span / 2 : 0;
      var ay = pad + s.y * k;
      var sag = Math.min(s.sag * k, span * 0.27);
      var a = solveCatenary(span, sag);
      var bs = k * s.scale * BULB_MUL;

      // one swag, sampled; every swag of a strand is identical
      var xs = [], ds = [], cum = [0], i;
      for (i = 0; i <= N; i++) {
        var u = span * i / N;
        xs.push(u);
        ds.push(catDepth(u, span, a));
        if (i > 0) cum.push(cum[i - 1] + Math.sqrt(Math.pow(xs[i] - xs[i - 1], 2) + Math.pow(ds[i] - ds[i - 1], 2)));
      }
      var arc = cum[N];
      var m = oddNearest(arc / (s.spacing * k), 3);

      // bulb slots inside one swag, evenly spaced along the wire, none on the anchors
      var slots = [], seg = 0;
      for (i = 0; i < m; i++) {
        var target = (i + 0.5) / m * arc;
        while (seg < N - 1 && cum[seg + 1] < target) seg++;
        var t = (target - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]);
        var dx = xs[seg + 1] - xs[seg], dy = ds[seg + 1] - ds[seg];
        slots.push({
          u: xs[seg] + dx * t,
          d: ds[seg] + dy * t,
          ang: Math.atan2(dy, dx) * 180 / Math.PI
        });
      }

      var strand = {
        i: si, y: ay, sag: sag, a: a, span: span, xStart: xStart, nSpans: nSpans, arc: arc,
        scale: bs, opacity: s.opacity, spacing: s.spacing * k, xs: xs, ds: ds,
        anchors: [], bulbs: []
      };
      var margin = 16 * bs;
      for (var j = 0; j <= nSpans; j++) {
        var ax = xStart + j * span;
        if (ax >= -margin && ax <= W + margin) strand.anchors.push(ax);
      }
      for (j = 0; j < nSpans; j++) {
        for (i = 0; i < slots.length; i++) {
          var x = xStart + j * span + slots[i].u;
          if (x < -margin || x > W + margin) continue;
          var y = ay + slots[i].d;
          strand.bulbs.push({ x: x, y: y, ang: slots[i].ang });
          var bottom = y + 23 * bs;
          if (bottom > maxBottom) maxBottom = bottom;
          var glow = y + (CY + HALO_R * 1.12) * bs;
          if (glow > maxGlow) maxGlow = glow;
        }
      }
      result.strands.push(strand);
    }
    result.height = Math.ceil(maxBottom + 3);
    result.svgHeight = Math.ceil(Math.max(maxGlow, maxBottom) + 1);
    return result;
  }

  /* ---------------------------------------------------------------- build */

  function glassPath(dy) {
    var P = GLASS_PTS, f = function (p) { return r2(p[0]) + ' ' + r2(p[1] - dy); };
    return 'M' + f(P[0]) + 'C' + f(P[1]) + ',' + f(P[2]) + ',' + f(P[3]) +
      'C' + f(P[4]) + ',' + f(P[5]) + ',' + f(P[6]) +
      'C' + f(P[7]) + ',' + f(P[8]) + ',' + f(P[9]) +
      'C' + f(P[10]) + ',' + f(P[11]) + ',' + f(P[12]) + 'Z';
  }
  var GLASS_ABS = glassPath(0);
  var GLASS_REL = glassPath(CY);
  var SOCKET_D = 'M-2.7 0.9H2.7L3.4 2.3V6.5Q3.4 7.7 2.2 7.7H-2.2Q-3.4 7.7 -3.4 6.5V2.3Z';
  var GROOVE_D = 'M-3.4 3.5H3.4M-3.4 5H3.4';

  function stopsInto(g, stops) {
    for (var i = 0; i < stops.length; i++) {
      var s = stops[i];
      var a = { offset: s[0], 'stop-color': s[1] };
      if (s[2] !== undefined) a['stop-opacity'] = s[2];
      svgEl('stop', a, g);
    }
  }
  function gradient(defs, kind, id, attrs, stops) {
    attrs = attrs || {};
    attrs.id = id;
    var g = svgEl(kind === 'radial' ? 'radialGradient' : 'linearGradient', attrs, defs);
    stopsInto(g, stops);
    return g;
  }

  function build(st) {
    var W = st.width;
    var L = computeLayout(W, st.strands, st.scaleOverride);
    var uid = 'dwl' + st.uid + '-';
    var H = Math.max(1, L.svgHeight);   // includes room for the halos below the bulbs
    var rng = mulberry32(0x5eed1a7 + (L.strands.length * 977));
    var now = (global.performance && global.performance.now ? global.performance.now() : Date.now());
    var elapsed = (now - st.t0) / 1000;

    var svg = svgEl('svg', {
      'class': 'dwl-svg',
      width: W, height: H,
      'aria-hidden': 'true', focusable: 'false', role: 'presentation'
    });
    svg.style.height = H + 'px';
    svg.style.marginBottom = -(H - L.height) + 'px'; // the container only counts the bulbs, halos spill over
    svg.style.pointerEvents = 'none';
    var defs = svgEl('defs', null, svg);

    /* shared gradients */
    gradient(defs, 'linear', uid + 'sk', { x1: 0, y1: 0, x2: 1, y2: 0 },
      [[0, '#3E260A'], [0.2, '#E9BE62'], [0.48, '#A8771F'], [1, '#3A2308']]);
    gradient(defs, 'radial', uid + 'of', { cx: 0.4, cy: 0.38, r: 0.72 },
      [[0, '#B07A3C', 0.8], [0.55, '#6A3A1E', 0.9], [1, '#2C120C', 0.95]]);
    gradient(defs, 'radial', uid + 'co', { cx: 0.5, cy: 0.5, r: 0.5 },
      [[0, '#FFFFFF', 1], [0.34, '#FFF7E0', 0.9], [1, '#FFE9B0', 0]]);
    gradient(defs, 'radial', uid + 'an', { cx: 0.35, cy: 0.3, r: 0.8 },
      [[0, '#FFF1B8'], [0.45, '#D9A441'], [1, '#6E4A14']]);

    /* per-strand, per-palette gradients (farther strands shift toward amber so they stay warm, not pale) */
    var pal = st.palette, p, gi;
    for (gi = 0; gi < L.strands.length; gi++) {
      for (p = 0; p < pal.length; p++) {
        var c = mix(mix(pal[p], [255, 160, 30], 0.12), [255, 150, 40], gi > 0 ? 0.3 : 0);
        var hot = mix(c, [255, 255, 255], 0.55);
        var edge = mix(c, [205, 98, 6], 0.62);
        var halo = mix(c, [255, 138, 18], 0.5);
        gradient(defs, 'radial', uid + 'g' + gi + '_' + p, { cx: 0.5, cy: 0.6, r: 0.66 },
          [[0, rgb(hot)], [0.38, rgb(c)], [0.78, rgb(mix(c, edge, 0.55))], [1, rgb(edge)]]);
        gradient(defs, 'radial', uid + 'h' + gi + '_' + p, { cx: 0.5, cy: 0.5, r: 0.5 },
          [[0, rgb(halo), 0.85], [0.12, rgb(halo), 0.62], [0.3, rgb(halo), 0.32], [0.58, rgb(halo), 0.1], [1, rgb(halo), 0]]);
      }
    }

    /* strands: back to front */
    var bulbRecords = [];
    for (var si = L.strands.length - 1; si >= 0; si--) {
      var S = L.strands[si];
      var sg = svgEl('g', S.opacity < 1 ? { opacity: r2(S.opacity) } : null, svg);
      var bs = S.scale;

      // wire path through every swag of the strand
      var d = '', j, i;
      for (j = 0; j < S.nSpans; j++) {
        var x0 = S.xStart + j * S.span;
        if (x0 + S.span < -20 || x0 > W + 20) continue;
        for (i = (d ? 1 : 0); i < S.xs.length; i++) {
          d += (d ? 'L' : 'M') + r2(x0 + S.xs[i]) + ' ' + r2(S.y + S.ds[i]);
        }
      }
      var ww = Math.max(0.9, 1.15 * bs);
      svgEl('path', { 'class': 'dwl-hi', d: d, fill: 'none', stroke: '#FFB95C', 'stroke-opacity': 0.2, 'stroke-width': r2(ww * 3.4), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sg);
      svgEl('path', { d: d, fill: 'none', stroke: '#6B4814', 'stroke-width': r2(ww), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sg);
      svgEl('path', { d: d, fill: 'none', stroke: '#C99A3E', 'stroke-opacity': 0.55, 'stroke-width': r2(ww * 0.38), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', transform: 'translate(0 ' + r2(-ww * 0.28) + ')' }, sg);

      // anchor pins
      for (i = 0; i < S.anchors.length; i++) {
        var ax = S.anchors[i], rr = 2.9 * bs;
        svgEl('circle', { cx: r2(ax), cy: r2(S.y), r: r2(rr), fill: 'url(#' + uid + 'an)' }, sg);
        svgEl('circle', { cx: r2(ax), cy: r2(S.y), r: r2(rr * 0.42), fill: '#2A1706', 'fill-opacity': 0.8 }, sg);
        svgEl('circle', { cx: r2(ax - rr * 0.36), cy: r2(S.y - rr * 0.38), r: r2(rr * 0.2), fill: '#FFF8DC', 'fill-opacity': 0.8 }, sg);
      }

      // bulbs
      var lastColor = -1;
      for (i = 0; i < S.bulbs.length; i++) {
        var B = S.bulbs[i];
        var sc = bs * (0.95 + rng() * 0.1);
        var tilt = clamp(B.ang * 0.45, -16, 16) + (rng() - 0.5) * 5;
        // colour: weighted random, never the same twice in a row
        var ci = 0, rc = rng();
        if (pal.length > 1) {
          ci = rc < 0.4 ? 0 : (rc < 0.78 ? 1 : (pal.length > 2 ? 2 : 1));
          if (ci === lastColor) ci = (ci + 1 + (rng() < 0.5 ? 0 : 1)) % pal.length;
        }
        lastColor = ci;

        // twinkle personality
        var rf = rng(), flavor, dur, mn, hs, lvl = 1;
        if (rf < 0.36) { flavor = 1; dur = 2.8 + rng() * 2.8; mn = 0.5 + rng() * 0.3; }
        else if (rf < 0.62) { flavor = 2; dur = 3.2 + rng() * 2; mn = 0.45 + rng() * 0.3; }
        else if (rf < 0.78) { flavor = 3; dur = 4.5 + rng() * 4; mn = 0.25 + rng() * 0.25; }
        else { flavor = 0; dur = 4; mn = 1; lvl = 0.84 + rng() * 0.16; }
        hs = 0.78 + mn * 0.2;
        var phase = rng() * dur;
        var ofs = -(((elapsed % dur) + phase) % dur);

        var bg = svgEl('g', {
          'class': 'dwl-bulb',
          transform: 'translate(' + r2(B.x) + ' ' + r2(B.y) + ') rotate(' + r2(tilt) + ') scale(' + r2(sc) + ')'
        }, sg);

        // unlit glass (always there, dim)
        svgEl('path', { d: GLASS_ABS, fill: 'url(#' + uid + 'of)', stroke: '#FFCD8C', 'stroke-opacity': 0.22, 'stroke-width': 0.5 }, bg);

        // lit stack, origin at glass centre
        var origin = svgEl('g', { transform: 'translate(0 ' + CY + ')' }, bg);
        var lit = svgEl('g', { 'class': 'dwl-lit' }, origin);
        svgEl('path', { d: GLASS_REL, fill: 'url(#' + uid + 'g' + si + '_' + ci + ')' }, lit);
        var tw = svgEl('g', { 'class': 'dwl-tw' + (flavor ? ' dwl-t' + flavor : '') }, lit);
        if (flavor) {
          tw.style.setProperty('--dwl-dur', r2(dur) + 's');
          tw.style.setProperty('--dwl-ofs', r2(ofs) + 's');
          tw.style.setProperty('--dwl-min', r2(mn));
          tw.style.setProperty('--dwl-hs', r2(hs));
        } else if (lvl < 1) {
          tw.style.setProperty('--dwl-lvl', r2(lvl));
        }
        svgEl('circle', { 'class': 'dwl-halo', r: HALO_R, fill: 'url(#' + uid + 'h' + si + '_' + ci + ')' }, tw);
        svgEl('ellipse', { cx: 0, cy: 1.2, rx: 3.4, ry: 5, fill: 'url(#' + uid + 'co)' }, tw);

        // metal socket, grooves, highlight, knot
        svgEl('path', { d: SOCKET_D, fill: 'url(#' + uid + 'sk)' }, bg);
        svgEl('path', { d: GROOVE_D, fill: 'none', stroke: '#2A1706', 'stroke-opacity': 0.5, 'stroke-width': 0.55 }, bg);
        svgEl('path', { d: 'M-2 2.6V6.5', fill: 'none', stroke: '#FFF0C4', 'stroke-opacity': 0.5, 'stroke-width': 0.7, 'stroke-linecap': 'round' }, bg);
        svgEl('circle', { cx: 0, cy: 0.3, r: 1.25, fill: '#8A6420' }, bg);

        // specular glint + faint rim light
        svgEl('ellipse', { cx: -2.6, cy: 11.8, rx: 0.85, ry: 2.2, transform: 'rotate(-20 -2.6 11.8)', fill: '#FFFFFF', 'fill-opacity': 0.55 }, bg);
        svgEl('circle', { cx: 2.3, cy: 19.2, r: 0.55, fill: '#FFFFFF', 'fill-opacity': 0.32 }, bg);

        bulbRecords.push({ g: bg, x: B.x, strand: si });
      }
    }

    return { svg: svg, bulbs: bulbRecords, layout: L, height: L.height };
  }

  /* ----------------------------------------------------------------- mount */

  function noop() {}
  function inertApi() {
    return {
      turnOn: noop, turnOff: noop, setVisible: noop, destroy: noop, resize: noop,
      isOn: function () { return false; },
      pointAt: function () { return { x: 0, y: 0, angle: 0 }; },
      layout: function () { return { width: 0, height: 0, scale: 1, span: 0, strands: [] }; }
    };
  }

  function mount(container, options) {
    if (!container || container.nodeType !== 1) return inertApi();
    if (registry && registry.has(container)) registry.get(container).destroy();
    options = options || {};

    var st = {
      uid: ++uidCounter,
      container: container,
      strands: normalizeStrands(options.strands),
      scaleOverride: num(options.scale, 0),
      palette: [],
      width: 0,
      height: 0,
      built: null,
      on: false,
      visible: true,
      inView: true,
      destroyed: false,
      rm: false,
      rmFixed: typeof options.reducedMotion === 'boolean',
      t0: (global.performance && global.performance.now ? global.performance.now() : Date.now()),
      timers: { rebuild: 0, settle1: 0, settle2: 0 }
    };

    // palette
    var pIn = (options.palette && options.palette.length) ? options.palette : DEFAULT_PALETTE, i, col;
    for (i = 0; i < pIn.length && st.palette.length < 6; i++) {
      col = parseColor(pIn[i], container);
      if (col) st.palette.push(col);
    }
    if (!st.palette.length) {
      for (i = 0; i < DEFAULT_PALETTE.length; i++) st.palette.push(parseColor(DEFAULT_PALETTE[i]));
    }

    acquireStyle();

    // the lights are decoration: never let the container swallow taps meant for the hero beneath
    var prevPE = container.style.pointerEvents;
    container.style.pointerEvents = 'none';

    // reduced motion
    var mql = null;
    if (st.rmFixed) st.rm = !!options.reducedMotion;
    else if (typeof global.matchMedia === 'function') {
      try { mql = global.matchMedia(RM_QUERY); st.rm = !!mql.matches; } catch (e) { mql = null; }
    }

    function measure() {
      var w = container.clientWidth;
      if (!w) w = Math.round(container.getBoundingClientRect().width);
      if (!w && container.parentNode && container.parentNode.clientWidth) w = container.parentNode.clientWidth;
      if (!w) w = global.innerWidth || 0;
      return Math.max(0, w);
    }

    function isPaused() { return !st.visible || !st.inView || doc.hidden; }
    function applyFlags(svg) {
      var cl = svg.classList;
      if (st.on) cl.add('dwl-on'); else cl.remove('dwl-on');
      if (st.rm) cl.add('dwl-rm', 'dwl-now'); else cl.remove('dwl-rm');
      if (isPaused()) cl.add('dwl-paused'); else cl.remove('dwl-paused');
    }

    function rebuild() {
      if (st.destroyed) return;
      st.timers.rebuild = 0;
      var w = measure();
      if (w < 1) return;
      st.width = w;
      var b = build(st);
      var old = st.built;
      st.built = b;
      st.height = b.height;
      // a lit strand is rebuilt already lit (no transition), so a resize never flickers
      applyFlags(b.svg);
      if (st.on && !st.rm) b.svg.classList.add('dwl-now');
      if (old && old.svg.parentNode === container) container.replaceChild(b.svg, old.svg);
      else container.appendChild(b.svg);
      container.style.setProperty('--lights-h', b.height + 'px');
      if (st.on && !st.rm) settleSoon();
      try {
        container.dispatchEvent(new global.CustomEvent('deepawali:lights-layout', { detail: { width: w, height: b.height } }));
      } catch (e) { /* CustomEvent unavailable: ignore */ }
    }

    /* lift the no-transition guard once the new frame has been committed */
    function settleSoon() {
      cancelSettle();
      st.timers.settle1 = global.requestAnimationFrame(function () {
        st.timers.settle1 = 0;
        st.timers.settle2 = global.requestAnimationFrame(function () {
          st.timers.settle2 = 0;
          if (st.built && !st.rm) st.built.svg.classList.remove('dwl-now');
        });
      });
    }
    function cancelSettle() {
      if (st.timers.settle1) { global.cancelAnimationFrame(st.timers.settle1); st.timers.settle1 = 0; }
      if (st.timers.settle2) { global.cancelAnimationFrame(st.timers.settle2); st.timers.settle2 = 0; }
    }

    function scheduleRebuild() {
      if (st.destroyed || st.timers.rebuild) return;
      st.timers.rebuild = global.setTimeout(rebuild, 90);
    }

    /* ignition delays (seconds) written as a custom property on each bulb */
    function applyDelays(totalMs, from) {
      if (!st.built) return;
      var bulbs = st.built.bulbs, W = st.width || 1;
      var span = Math.max(0, totalMs / 1000 - 0.55 - 0.13); // fade .55s, back strand lag .07s, jitter <= .06s
      for (var i = 0; i < bulbs.length; i++) {
        var b = bulbs[i], f;
        var fx = clamp(b.x / W, 0, 1);
        switch (from) {
          case 'left': f = fx; break;
          case 'right': f = 1 - fx; break;
          case 'edges': f = 1 - Math.abs(fx - 0.5) * 2; break;
          case 'random': f = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1; break;
          default: f = Math.abs(fx - 0.5) * 2; // centre-out
        }
        var hash = Math.abs(Math.sin(i * 78.233 + 1.7) * 43758.5453) % 1;
        var delay = totalMs ? f * span + (b.strand > 0 ? 0.07 : 0) + hash * 0.06 : 0;
        b.g.style.setProperty('--dwl-delay', r2(delay) + 's');
      }
    }

    function refreshPaused() {
      if (!st.built) return;
      if (isPaused()) st.built.svg.classList.add('dwl-paused');
      else st.built.svg.classList.remove('dwl-paused');
    }

    function setRM(v) {
      if (st.rm === v) return;
      st.rm = v;
      if (!st.built) return;
      var cl = st.built.svg.classList;
      if (v) cl.add('dwl-rm', 'dwl-now');
      else { cl.remove('dwl-rm'); cl.remove('dwl-now'); }
    }

    /* -------- listeners / observers (all released in destroy) -------- */
    var ro = null;
    function onResizeObs() {
      var w = measure();
      if (Math.abs(w - st.width) < 1 && st.built) return; // height-only changes are ours; ignore
      scheduleRebuild();
    }
    function onWinResize() { onResizeObs(); }
    if (typeof global.ResizeObserver === 'function') {
      ro = new global.ResizeObserver(onResizeObs);
      ro.observe(container);
    } else {
      global.addEventListener('resize', onWinResize);
    }
    function onVis() { refreshPaused(); }
    doc.addEventListener('visibilitychange', onVis);
    var io = null;
    if (typeof global.IntersectionObserver === 'function') {
      io = new global.IntersectionObserver(function (entries) {
        var e = entries[entries.length - 1];
        if (!e || st.destroyed) return;
        st.inView = e.isIntersecting;
        refreshPaused();
      }, { threshold: 0 });
      io.observe(container);
    }
    function onRM(e) { if (!st.rmFixed) setRM(!!(e && e.matches)); }
    if (mql) {
      if (mql.addEventListener) mql.addEventListener('change', onRM);
      else if (mql.addListener) mql.addListener(onRM);
    }

    /* ----------------------------- API ----------------------------- */
    var api = {
      turnOn: function (o) {
        if (st.destroyed) return;
        o = o || {};
        if (!st.built) rebuild();
        if (!st.built) { st.on = true; return; }
        var dur = Math.max(0, num(o.duration, 1400));
        var instant = st.rm || dur === 0;
        st.on = true;
        var svg = st.built.svg;
        if (instant) {
          applyDelays(0);
          svg.classList.add('dwl-now');
          svg.classList.add('dwl-on');
          if (!st.rm) settleSoon();
          return;
        }
        applyDelays(dur, o.from || 'center');
        svg.classList.remove('dwl-now');
        svg.getBoundingClientRect(); // commit the unlit state so the transitions have a start
        svg.classList.add('dwl-on');
      },
      turnOff: function () {
        if (st.destroyed || !st.built) { st.on = false; return; }
        st.on = false;
        var bulbs = st.built.bulbs;
        for (var i = 0; i < bulbs.length; i++) {
          bulbs[i].g.style.setProperty('--dwl-delay', r2(st.rm ? 0 : ((i * 37) % 11) * 0.02) + 's');
        }
        st.built.svg.classList.remove('dwl-on');
      },
      setVisible: function (v) {
        if (st.destroyed) return;
        st.visible = !!v;
        refreshPaused();
      },
      resize: function () {
        if (st.destroyed) return;
        if (st.timers.rebuild) { global.clearTimeout(st.timers.rebuild); st.timers.rebuild = 0; }
        rebuild();
      },
      isOn: function () { return st.on; },
      pointAt: function (fx, strand) {
        var L = st.built && st.built.layout;
        if (!L) return { x: 0, y: 0, angle: 0 };
        var S = L.strands[strand | 0] || L.strands[0];
        var x = clamp(fx, 0, 1) * st.width;
        var rel = x - S.xStart;
        var j = clamp(Math.floor(rel / S.span), 0, S.nSpans - 1);
        var u = clamp(rel - j * S.span, 0, S.span);
        var y = S.y + catDepth(u, S.span, S.a);
        var du = Math.max(0.5, S.span / 200);
        var y2 = S.y + catDepth(clamp(u + du, 0, S.span), S.span, S.a);
        var y1 = S.y + catDepth(clamp(u - du, 0, S.span), S.span, S.a);
        return { x: x, y: y, angle: Math.atan2(y2 - y1, 2 * du) * 180 / Math.PI };
      },
      layout: function () {
        var L = st.built && st.built.layout;
        if (!L) return { width: st.width, height: st.height, scale: 1, span: 0, strands: [] };
        return {
          width: st.width, height: st.height, scale: L.k, span: L.span,
          strands: L.strands.map(function (S) {
            return { y: S.y, sag: S.sag, anchors: S.anchors.slice(), bulbs: S.bulbs.length };
          })
        };
      },
      destroy: function () {
        if (st.destroyed) return;
        st.destroyed = true;
        if (st.timers.rebuild) global.clearTimeout(st.timers.rebuild);
        cancelSettle();
        if (ro) { ro.disconnect(); ro = null; } else global.removeEventListener('resize', onWinResize);
        if (io) { io.disconnect(); io = null; }
        doc.removeEventListener('visibilitychange', onVis);
        if (mql) {
          if (mql.removeEventListener) mql.removeEventListener('change', onRM);
          else if (mql.removeListener) mql.removeListener(onRM);
          mql = null;
        }
        if (st.built && st.built.svg.parentNode) st.built.svg.parentNode.removeChild(st.built.svg);
        st.built = null;
        container.style.removeProperty('--lights-h');
        container.style.pointerEvents = prevPE;
        if (registry && registry.get(container) === api) registry.delete(container);
        releaseStyle();
      }
    };

    if (registry) registry.set(container, api);
    rebuild();
    if (options.on) api.turnOn({ duration: 0 });
    return api;
  }

  global.DeepawaliLights = { mount: mount, __v: 1 };
})(typeof window !== 'undefined' ? window : this);
