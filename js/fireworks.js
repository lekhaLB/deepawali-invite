/*!
 * Deepawali Fireworks: a dependency-free canvas fireworks engine for the invitation hero.
 *
 *   var fx = DeepawaliFireworks.create(canvas, { palette, maxParticles, dprCap, reducedMotion, getGroundY });
 *   fx.start(); fx.launch({ x, y, type }); fx.auto(true); fx.finale({ duration: 7000 });
 *
 * Bursts: peony, chrysanthemum, willow, ring, kamal (lotus), palm, crackle. Ground pieces: anar, chakri.
 *
 * Beyond the contract: fx.setReducedMotion(bool) for live prefers-reduced-motion changes (the engine also follows the
 * media query itself when the option is left undefined), fx.setQuietZone({x,y,w,h}, strength) to knock the fireworks
 * back behind the title text (null clears it), DeepawaliFireworks.types / .version. Spawning calls (launch, burst,
 * finale, anar, chakri, sparkle) start the loop if it is idle; they are ignored while hidden or paused.
 * Rendering: additive blending, the canvas is cleared completely every frame and trails are drawn from a
 * per-particle position history (no ghosting). Typed-array pools, cached glow sprites, no allocation in the
 * frame loop. Classic script (ES2017), no modules, no storage, no network.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc) { return; }

  /* ------------------------------------------------------------------------------------------ constants */

  var VERSION = '1.0.0';
  var TYPES = ['peony', 'chrysanthemum', 'willow', 'ring', 'kamal', 'palm', 'crackle'];
  var TYPE_INDEX = { peony: 0, chrysanthemum: 1, willow: 2, ring: 3, kamal: 4, palm: 5, crackle: 6 };
  var TYPE_WEIGHTS = [20, 16, 14, 9, 16, 10, 15];

  var STEP = 1 / 60;            // fixed simulation step (s)
  var HLEN = 28;                // trail history ring length per particle
  var NST = 16;                 // quantised fade stages (colour + alpha)
  var NRAMP = 20;               // max colour ramps
  var NSLOT = NRAMP * 2;        // ramp x depth (near / far)
  var NB = 2 * NSLOT * NST;     // draw buckets (width class x slot x stage)
  var SPR = 32;                 // head sprite size (px)
  var GSPR = 64;                // light glow sprite size (px)
  var HALO = 4.3;               // sprite radius as multiple of particle radius
  var MAX_PIXELS = 3.5e6;       // backing store cap
  var MAX_ROCKETS = 28;
  var MAX_LIGHTS = 40;
  var MAX_EVENTS = 320;
  var MAX_EMITTERS = 14;
  var RH = 14;                  // rocket trail history length

  var F_GLINT = 1;              // twinkles in the second half of life
  var F_POP = 2;                // crackle: pops into tiny flashes when it dies
  var F_EMIT = 4;               // sheds glitter sparks while alive
  var F_BOLD = 8;               // thicker trail

  var EV_LAUNCH = 1, EV_BURST = 2, EV_ANAR = 3, EV_CHAKRI = 4;
  var PALM_OFFS = [0, -0.085, 0.085, -0.17, 0.17];

  var TWO_PI = Math.PI * 2;
  var GOLDEN_ANGLE = 2.399963229728653;

  var HOT = [255, 246, 214];
  var CRIMSON_TAIL = [150, 24, 40];

  // trail tiers: wide hot core near the head, long faint tail. Additive blending stacks them into a gradient.
  // tier 0 is a wide faint aura, 1 the long cool tail, 2 the middle, 3 the hot core.
  var NTIER = 4;
  var TIER_SHIFT = [0.2, 0.28, 0.05, -0.18];
  var TIER_ALPHA = [0.07, 0.34, 0.5, 0.85];
  var TIER_WIDTH = [4.6, 1.15, 1.9, 2.7, 6.6, 1.8, 2.9, 4.0];   // [normal x4, bold x4] in CSS px

  var DEFAULT_PALETTE = {
    gold: '#FFBE3D', pale: '#FFE08A', amber: '#FF9A1A', saffron: '#FF7A2E',
    ivory: '#FFEBC4', rose: '#F4799A', crimson: '#FF3F58', teal: '#35D6C8'
  };
  // [main, second, accent] role names with a weight. Mostly gold, with rose / crimson / saffron accents.
  var SCHEMES = [
    ['gold', 'pale', 'ivory', 24],        // 0
    ['amber', 'gold', 'pale', 14],        // 1
    ['ivory', 'gold', 'amber', 6],        // 2
    ['rose', 'gold', 'ivory', 12],        // 3
    ['crimson', 'gold', 'pale', 11],      // 4
    ['saffron', 'gold', 'ivory', 10],     // 5
    ['pale', 'rose', 'ivory', 8],         // 6
    ['teal', 'ivory', 'gold', 3],         // 7 rare peacock
    ['gold', 'rose', 'ivory', 8],         // 8
    ['pale', 'gold', 'ivory', 12]         // 9
  ];
  var TYPE_SCHEMES = [
    null,                                   // peony: any
    null,                                   // chrysanthemum: any
    [0, 1, 9, 5],                           // willow: liquid gold only
    [0, 2, 3, 4, 5, 8],                     // ring
    [3, 4, 8, 6, 0, 2],                     // kamal: rose / crimson lotus
    [0, 1, 5, 4, 9],                        // palm
    [2, 0, 9, 1]                            // crackle
  ];

  /* ------------------------------------------------------------------------------------------ small helpers */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d, lo, hi) {
    if (typeof v === 'string' && v.replace(/\s/g, '') !== '') { v = parseFloat(v); }
    if (typeof v !== 'number' || v !== v || v === Infinity || v === -Infinity) { return d; }
    return clamp(v, lo, hi);
  }
  function rr(a, b) { return a + Math.random() * (b - a); }
  function nowMs() {
    var p = global.performance;
    return (p && typeof p.now === 'function') ? p.now() : Date.now();
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mixRgb(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }

  var scratchCtx = null;
  function parseColor(s, depth) {
    if (typeof s !== 'string') { return null; }
    s = s.replace(/^\s+|\s+$/g, '');
    if (!s || s.length > 80) { return null; }
    var m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) {
        return [parseInt(h.charAt(0) + h.charAt(0), 16), parseInt(h.charAt(1) + h.charAt(1), 16), parseInt(h.charAt(2) + h.charAt(2), 16)];
      }
      if (h.length === 6 || h.length === 8) {
        return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
      }
      return null;
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
    if (m) {
      return [clamp(Math.round(+m[1]), 0, 255), clamp(Math.round(+m[2]), 0, 255), clamp(Math.round(+m[3]), 0, 255)];
    }
    if (depth) { return null; }
    // let the browser resolve named colours, hsl(), etc.
    try {
      if (!scratchCtx) {
        var c = doc.createElement('canvas');
        c.width = c.height = 1;
        scratchCtx = c.getContext('2d');
      }
      if (!scratchCtx) { return null; }
      scratchCtx.fillStyle = '#010203';
      scratchCtx.fillStyle = s;
      var out = String(scratchCtx.fillStyle);
      if (out === '#010203' && s.toLowerCase().replace(/\s/g, '') !== '#010203') { return null; }
      return parseColor(out, 1);
    } catch (e) { return null; }
  }

  function makeNoop() {
    var noop = function () { return false; };
    return {
      start: noop, stop: noop, resize: noop, setVisible: noop, launch: noop, burst: noop, auto: noop,
      finale: noop, sparkle: noop, anar: noop, chakri: noop, setSound: noop, setReducedMotion: noop,
      destroy: noop,
      stats: function () { return { particles: 0, fps: 0 }; }
    };
  }

  /* ------------------------------------------------------------------------------------------ the engine */

  function create(canvas, options) {
    options = (options && typeof options === 'object') ? options : {};
    if (!canvas || typeof canvas.getContext !== 'function') { return makeNoop(); }
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e0) { ctx = null; }
    if (!ctx) { return makeNoop(); }
    if (canvas.__deepawaliFx && typeof canvas.__deepawaliFx.destroy === 'function') {
      try { canvas.__deepawaliFx.destroy(); } catch (e1) { /* ignore */ }
    }

    /* ---- device profile ---- */
    var nav = global.navigator || {};
    var lite = false;
    try {
      var conn = nav.connection || nav.mozConnection || nav.webkitConnection;
      if (conn && conn.saveData) { lite = true; }
      if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 2) { lite = true; }
    } catch (e2) { /* ignore */ }
    var screenArea = (global.innerWidth || 800) * (global.innerHeight || 600);
    var MAXP = Math.round(num(options.maxParticles, lite ? 700 : (screenArea < 700000 ? 1100 : 1800), 120, 5000));
    var dprCap = num(options.dprCap, 2, 1, 4);
    if (lite) { dprCap = Math.min(dprCap, 1.5); }
    var getGroundYFn = (typeof options.getGroundY === 'function') ? options.getGroundY : null;

    /* ---- reduced motion ---- */
    var rmFollow = (typeof options.reducedMotion !== 'boolean');
    var reduced = !rmFollow && options.reducedMotion;
    var mql = null;
    function onMq(e) { if (rmFollow) { reduced = !!(e && typeof e.matches === 'boolean' ? e.matches : (mql && mql.matches)); onReducedChanged(); } }
    if (rmFollow && typeof global.matchMedia === 'function') {
      try {
        mql = global.matchMedia('(prefers-reduced-motion: reduce)');
        reduced = !!mql.matches;
        if (mql.addEventListener) { mql.addEventListener('change', onMq); } else if (mql.addListener) { mql.addListener(onMq); }
      } catch (e3) { mql = null; }
    }

    /* ---- state ---- */
    var destroyed = false, started = false, pageVisible = true, docHidden = (doc.visibilityState === 'hidden');
    var rafId = 0, needResize = true, dirty = true, cleanCanvas = false;
    var W = 0, H = 0, sx = 1, sy = 1, rawDpr = 1, unit = 400, szu = 1, lwS = 1;
    var T = 0, stepNo = 0, frameNo = 0, acc = 0, lastTs = 0;
    var qLevel = 0, slowT = 0, goodT = 0, backoff = 1, lastDegradeAt = -99, lastRestoreAt = -99, frameEma = 16.7, workEma = 1, fpsMs = 16.7;
    var qMul = 1, qTrail = 1, qEmit = 1;
    var windStep = 0;
    var autoOn = false, autoMin = 1800, autoMax = 4200, autoNext = 0;
    var autoArea = { x0: 0.08, x1: 0.92, y0: 0.06, y1: 0.5 };
    var lastAutoX = -1, lastAutoType = -1;
    var finaleEnd = 0, lastFlash = -10;
    var ro = null;
    var glowCv = null, glowCtx = null, glw = 0, glh = 0, GLS = 0.25;
    var qzOn = false, qzx = 0, qzy = 0, qzw = 0, qzh = 0, qzS = 0.6, quietSprite = null;

    /* ---- particle pool (struct of arrays) ---- */
    var px = new Float32Array(MAXP), py = new Float32Array(MAXP);
    var vx = new Float32Array(MAXP), vy = new Float32Array(MAXP);
    var life = new Float32Array(MAXP), mlife = new Float32Array(MAXP);
    var dm = new Float32Array(MAXP), gs = new Float32Array(MAXP), sz = new Float32Array(MAXP), dl = new Float32Array(MAXP);
    var rm = new Uint8Array(MAXP), cl = new Uint8Array(MAXP), fl = new Uint8Array(MAXP);
    var tl = new Uint8Array(MAXP), hk = new Uint8Array(MAXP), hc = new Uint8Array(MAXP);
    var hi = new Uint8Array(MAXP), hn = new Uint8Array(MAXP), em = new Uint8Array(MAXP);
    var hist = new Float32Array(MAXP * HLEN * 2);
    var act = new Uint16Array(MAXP), freeStk = new Uint16Array(MAXP);
    var nAct = 0, nFree = MAXP, i0;
    for (i0 = 0; i0 < MAXP; i0++) { freeStk[i0] = MAXP - 1 - i0; }
    var reserve = Math.round(MAXP * 0.14);

    var order = new Uint16Array(MAXP), bkey = new Uint16Array(MAXP), tv = new Uint8Array(MAXP);
    var bcount = new Uint16Array(NB), bstart = new Uint16Array(NB), bpos = new Uint16Array(NB);

    /* ---- rockets ---- */
    var rOn = new Uint8Array(MAX_ROCKETS);
    var rx0 = new Float32Array(MAX_ROCKETS), ry0 = new Float32Array(MAX_ROCKETS);
    var rx1 = new Float32Array(MAX_ROCKETS), ry1 = new Float32Array(MAX_ROCKETS);
    var rt = new Float32Array(MAX_ROCKETS), rT = new Float32Array(MAX_ROCKETS);
    var rwob = new Float32Array(MAX_ROCKETS), rph = new Float32Array(MAX_ROCKETS), rsc = new Float32Array(MAX_ROCKETS);
    var rcx = new Float32Array(MAX_ROCKETS), rcy = new Float32Array(MAX_ROCKETS);
    var rtype = new Uint8Array(MAX_ROCKETS), rcm = new Uint8Array(MAX_ROCKETS);
    var rcs = new Uint8Array(MAX_ROCKETS), rca = new Uint8Array(MAX_ROCKETS);
    var rhi = new Uint8Array(MAX_ROCKETS), rhn = new Uint8Array(MAX_ROCKETS);
    var rhist = new Float32Array(MAX_ROCKETS * RH * 2);
    var nRock = 0;

    /* ---- lights (flash, haze) ---- */
    var lx = new Float32Array(MAX_LIGHTS), ly = new Float32Array(MAX_LIGHTS);
    var lr0 = new Float32Array(MAX_LIGHTS), lr1 = new Float32Array(MAX_LIGHTS), la = new Float32Array(MAX_LIGHTS);
    var lt = new Float32Array(MAX_LIGHTS), ld = new Float32Array(MAX_LIGHTS), lrise = new Float32Array(MAX_LIGHTS);
    var lramp = new Uint8Array(MAX_LIGHTS);
    var nLight = 0;

    /* ---- scheduled events ---- */
    var evT = new Float64Array(MAX_EVENTS), evK = new Uint8Array(MAX_EVENTS);
    var evA = new Float32Array(MAX_EVENTS), evB = new Float32Array(MAX_EVENTS), evC = new Float32Array(MAX_EVENTS);
    var evD = new Float32Array(MAX_EVENTS), evE = new Float32Array(MAX_EVENTS), evF = new Float32Array(MAX_EVENTS);
    var nEv = 0;

    /* ---- ground emitters (anar / chakri) ---- */
    var ekind = new Uint8Array(MAX_EMITTERS);
    var ex = new Float32Array(MAX_EMITTERS), ey = new Float32Array(MAX_EMITTERS);
    var et = new Float32Array(MAX_EMITTERS), ed = new Float32Array(MAX_EMITTERS);
    var eacc = new Float32Array(MAX_EMITTERS), eang = new Float32Array(MAX_EMITTERS), eenv = new Float32Array(MAX_EMITTERS);
    var nEmit = 0;

    /* ---- colour ramps, sprites and cached style strings ---- */
    var rampMap = {}, nRamp = 0;
    var strokes = [], sprites = [], glows = [];
    var headA = new Float32Array(NSLOT * NST);
    var lut = new Uint8Array(4 * 64);
    var RG = 0, RI = 1;           // gold and ivory ramps (rockets, embers, pops)
    var palRamps = [];            // ramps used for random schemes with a custom palette
    var defRamp = {};             // role name -> ramp index (default palette)
    var customPalette = false;
    var sm = 0, ss = 0, sa = 0;   // picked scheme: main, second, accent ramp

    function alphaAt(u) {
      if (u < 0.5) { return 1; }
      var v = 1 - (u - 0.5) / 0.5;
      return v <= 0 ? 0 : Math.pow(v, 1.2);
    }
    function rampColor(rgb, tail, u) {
      var hot = 0.62 * Math.pow(Math.max(0, 1 - u / 0.17), 2);
      var cool = Math.pow(clamp((u - 0.26) / 0.74, 0, 1), 1.1) * 0.85;
      var r = rgb[0] + (HOT[0] - rgb[0]) * hot, g = rgb[1] + (HOT[1] - rgb[1]) * hot, b = rgb[2] + (HOT[2] - rgb[2]) * hot;
      r = r + (tail[0] - r) * cool; g = g + (tail[1] - g) * cool; b = b + (tail[2] - b) * cool;
      return [Math.round(r), Math.round(g), Math.round(b)];
    }
    function tailFor(rgb) {
      var mx = Math.max(rgb[0], rgb[1], rgb[2]), mn = Math.min(rgb[0], rgb[1], rgb[2]);
      var sat = mx ? (mx - mn) / mx : 0;
      if (sat < 0.3) { return [236, 150, 62]; }                                  // ivory cools to amber
      if (rgb[0] < rgb[1] || rgb[0] < rgb[2]) { return [Math.round(rgb[0] * 0.4), Math.round(rgb[1] * 0.45), Math.round(rgb[2] * 0.45)]; }
      return mixRgb(rgb, CRIMSON_TAIL, 0.5);
    }
    function makeSprite(c) {
      var cv = doc.createElement('canvas');
      cv.width = cv.height = SPR;
      var x = cv.getContext('2d');
      if (!x) { return cv; }
      var h = SPR / 2;
      var gr = x.createRadialGradient(h, h, 0, h, h, h);
      var w = mixRgb(c, HOT, 0.55), cc = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',';
      gr.addColorStop(0, 'rgba(255,250,236,1)');
      gr.addColorStop(0.07, 'rgba(255,248,230,0.98)');
      gr.addColorStop(0.15, 'rgba(' + w[0] + ',' + w[1] + ',' + w[2] + ',0.92)');
      gr.addColorStop(0.28, cc + '0.62)');
      gr.addColorStop(0.5, cc + '0.16)');
      gr.addColorStop(0.75, cc + '0.04)');
      gr.addColorStop(1, cc + '0)');
      x.fillStyle = gr;
      x.fillRect(0, 0, SPR, SPR);
      return cv;
    }
    function makeGlow(c) {
      var cv = doc.createElement('canvas');
      cv.width = cv.height = GSPR;
      var x = cv.getContext('2d');
      if (!x) { return cv; }
      var h = GSPR / 2;
      var gr = x.createRadialGradient(h, h, 0, h, h, h);
      var s = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',';
      gr.addColorStop(0, s + '1)');
      gr.addColorStop(0.22, s + '0.62)');
      gr.addColorStop(0.5, s + '0.2)');
      gr.addColorStop(0.78, s + '0.045)');
      gr.addColorStop(1, s + '0)');
      x.fillStyle = gr;
      x.fillRect(0, 0, GSPR, GSPR);
      return cv;
    }
    function addRamp(rgb) {
      var key = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
      if (rampMap[key] !== undefined) { return rampMap[key]; }
      if (nRamp >= NRAMP) {
        // registry full: reuse the closest existing ramp
        var best = 0, bd = 1e9, k, d;
        for (k = 0; k < nRamp; k++) { /* closest by rgb distance */
          var rc = rampMap['_' + k];
          d = Math.pow(rc[0] - rgb[0], 2) + Math.pow(rc[1] - rgb[1], 2) + Math.pow(rc[2] - rgb[2], 2);
          if (d < bd) { bd = d; best = k; }
        }
        return best;
      }
      var r = nRamp++;
      rampMap[key] = r;
      rampMap['_' + r] = rgb;
      var tail = tailFor(rgb);
      var st, f, t, slot, u, af, cc, a;
      for (st = 0; st < NST; st++) {
        u = (st + 0.5) / NST;
        sprites[r * NST + st] = makeSprite(rampColor(rgb, tail, u));
        for (f = 0; f < 2; f++) {
          slot = r * 2 + f;
          af = f ? 0.55 : 1;
          headA[slot * NST + st] = alphaAt(u) * af;
          for (t = 0; t < NTIER; t++) {
            cc = rampColor(rgb, tail, clamp(u + TIER_SHIFT[t], 0, 1));
            a = alphaAt(u) * TIER_ALPHA[t] * af;
            strokes[(t * NSLOT + slot) * NST + st] = 'rgba(' + cc[0] + ',' + cc[1] + ',' + cc[2] + ',' + (Math.round(a * 1000) / 1000) + ')';
          }
        }
      }
      glows[r] = makeGlow(mixRgb(rgb, HOT, 0.18));
      return r;
    }
    function buildLut() {
      var cls, k, u, v;
      for (cls = 0; cls < 4; cls++) {
        for (k = 0; k < 64; k++) {
          u = (k + 0.5) / 64;
          if (cls === 0) { v = u; }
          else if (cls === 1) { v = Math.pow(u, 1.55); }     // willow: stays hot and bright longer
          else if (cls === 2) { v = Math.pow(u, 0.85); }     // sparks and pops: cool fast
          else { v = 0.1 + 0.9 * Math.pow(u, 2.1); }         // kamal: keep the colour saturated, then fall away
          lut[cls * 64 + k] = Math.min(NST - 1, Math.floor(v * NST));
        }
      }
    }
    function initPalette() {
      var rgb, k, role;
      RG = addRamp(parseColor(DEFAULT_PALETTE.gold));
      RI = addRamp(parseColor(DEFAULT_PALETTE.ivory));
      var custom = null;
      if (options.palette && typeof options.palette.length === 'number') {
        custom = [];
        for (k = 0; k < options.palette.length && custom.length < 12; k++) {
          rgb = parseColor(options.palette[k]);
          if (rgb) { custom.push(rgb); }
        }
        if (!custom.length) { custom = null; }
      }
      if (custom) {
        customPalette = true;
        for (k = 0; k < custom.length; k++) { palRamps.push(addRamp(custom[k])); }
      } else {
        for (role in DEFAULT_PALETTE) {
          if (Object.prototype.hasOwnProperty.call(DEFAULT_PALETTE, role)) { defRamp[role] = addRamp(parseColor(DEFAULT_PALETTE[role])); }
        }
      }
    }
    buildLut();
    initPalette();

    function slotOf(ramp, z) { return (ramp << 1) | (z < -0.12 ? 1 : 0); }

    /* ---- scheme picking ---- */
    var schemeWeightSum = 0;
    (function () { var k; for (k = 0; k < SCHEMES.length; k++) { schemeWeightSum += SCHEMES[k][3]; } })();
    function pickScheme(type, color) {
      var c = (typeof color === 'string') ? parseColor(color) : null;
      if (c) {
        sm = addRamp(c);
        ss = addRamp(mixRgb(c, parseColor(DEFAULT_PALETTE.pale), 0.45));
        sa = RI;
        return;
      }
      if (customPalette) {
        var n = palRamps.length;
        sm = palRamps[(Math.random() * n) | 0];
        ss = palRamps[(Math.random() * n) | 0];
        sa = RI;
        return;
      }
      var list = TYPE_SCHEMES[type], idx, k, sum, r, sch;
      if (list) { idx = list[(Math.random() * list.length) | 0]; }
      else {
        r = Math.random() * schemeWeightSum;
        idx = 0;
        for (k = 0; k < SCHEMES.length; k++) { r -= SCHEMES[k][3]; if (r <= 0) { idx = k; break; } }
      }
      sch = SCHEMES[idx];
      sm = defRamp[sch[0]]; ss = defRamp[sch[1]]; sa = defRamp[sch[2]];
    }
    function pickType() {
      var sum = 0, k, r, t;
      for (k = 0; k < TYPE_WEIGHTS.length; k++) { sum += TYPE_WEIGHTS[k]; }
      do {
        r = Math.random() * sum;
        t = 0;
        for (k = 0; k < TYPE_WEIGHTS.length; k++) { r -= TYPE_WEIGHTS[k]; if (r <= 0) { t = k; break; } }
      } while (t === lastAutoType && Math.random() < 0.8);
      return t;
    }

    /* ---- sizing ---- */
    function doResize() {
      needResize = false;
      var cw = canvas.clientWidth, ch = canvas.clientHeight;
      if (!cw || !ch) {
        var rect = canvas.getBoundingClientRect();
        cw = rect.width; ch = rect.height;
      }
      if (!(cw > 1 && ch > 1)) { W = 0; H = 0; return; }
      rawDpr = num(global.devicePixelRatio, 1, 0.25, 8);
      var d = clamp(rawDpr, 1, dprCap);
      if (cw * ch * d * d > MAX_PIXELS) { d = Math.sqrt(MAX_PIXELS / (cw * ch)); }
      d = Math.max(d, 0.5);
      var bw = Math.max(1, Math.round(cw * d)), bh = Math.max(1, Math.round(ch * d));
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      // guard against a stylesheet that lets the backing store drive the layout size (feedback loop)
      if (Math.abs(canvas.clientWidth - cw) > 1.5 || Math.abs(canvas.clientHeight - ch) > 1.5) {
        canvas.style.width = cw + 'px';
        canvas.style.height = ch + 'px';
      }
      W = cw; H = ch;
      sx = bw / cw; sy = bh / ch;
      // low-resolution layer for the big soft lights (cheap to fill, smooth when scaled up)
      try {
        if (!glowCv) { glowCv = doc.createElement('canvas'); glowCtx = glowCv.getContext('2d'); }
        if (glowCtx) {
          var gw = Math.max(2, Math.ceil(cw * GLS)), gh = Math.max(2, Math.ceil(ch * GLS));
          if (glowCv.width !== gw || glowCv.height !== gh) { glowCv.width = gw; glowCv.height = gh; }
          glw = gw; glh = gh;
        }
      } catch (eg) { glowCtx = null; }
      unit = clamp(Math.min(W * 0.95, H * 0.88), 300, 1500);
      szu = clamp(unit / 700, 0.85, 1.9);
      lwS = clamp(szu, 0.9, 1.6);
      dirty = true; cleanCanvas = false;
    }
    function onResizeSignal() {
      if (destroyed) { return; }
      needResize = true;
      if (!rafId) { doResize(); if (!rafId) { renderIdle(); } }
    }
    function ground() {
      var g = H - 8;
      if (getGroundYFn) {
        try {
          var v = getGroundYFn();
          if (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) { g = v; }
        } catch (e) { /* keep default */ }
      }
      return clamp(g, H * 0.35, H + 10);
    }

    /* ---- sound (optional, synthesized, off by default) ---- */
    var ac = null, master = null, noiseBuf = null, soundOn = false, voices = 0, lastPopSnd = 0;
    function sndEnsure() {
      if (ac) { return true; }
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { return false; }
      try {
        ac = new AC();
        master = ac.createGain();
        master.gain.value = reduced ? 0.32 : 0.5;
        if (typeof ac.createDynamicsCompressor === 'function') {
          var comp = ac.createDynamicsCompressor();
          master.connect(comp); comp.connect(ac.destination);
        } else { master.connect(ac.destination); }
        var len = Math.max(2048, Math.round(ac.sampleRate * 1.2));
        noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
        var data = noiseBuf.getChannelData(0), k;
        for (k = 0; k < len; k++) { data[k] = Math.random() * 2 - 1; }
        return true;
      } catch (e) { ac = null; master = null; noiseBuf = null; return false; }
    }
    function sndOut(x) {
      if (typeof ac.createStereoPanner === 'function' && W > 0) {
        var p = ac.createStereoPanner();
        p.pan.value = clamp((x / W - 0.5) * 1.5, -1, 1);
        p.connect(master);
        return p;
      }
      return master;
    }
    function sndNoise(delay, dur, filterType, f0, f1, q, gain, x) {
      if (voices > 14) { return; }
      var t0 = ac.currentTime + delay;
      var src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = dur > 1.0;
      var f = ac.createBiquadFilter();
      f.type = filterType; f.Q.value = q;
      f.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) { f.frequency.exponentialRampToValueAtTime(f1, t0 + dur); }
      var g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.04, dur * 0.3));
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(sndOut(x));
      voices++;
      src.onended = function () { voices = Math.max(0, voices - 1); };
      src.start(t0, Math.random() * 0.2);
      src.stop(t0 + dur + 0.05);
    }
    function sndThump(delay, f0, f1, dur, gain, x) {
      if (voices > 14) { return; }
      var t0 = ac.currentTime + delay;
      var o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      var g = ac.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(sndOut(x));
      voices++;
      o.onended = function () { voices = Math.max(0, voices - 1); };
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }
    function sfx(kind, x, strength) {
      if (!soundOn || !ac || ac.state !== 'running') { return; }
      try {
        var s = strength || 1;
        if (kind === 0) { sndNoise(0, 0.75, 'bandpass', 380, 2100, 1.2, 0.07, x); }                       // rocket whoosh
        else if (kind === 1) {                                                                            // burst boom + crack
          var dly = 0.02 + Math.random() * 0.06;
          sndThump(dly, 150, 42, 0.38, 0.55 * s, x);
          sndNoise(dly, 0.45, 'lowpass', 2600, 500, 0.7, 0.22 * s, x);
          sndNoise(dly, 0.09, 'highpass', 3000, 3000, 0.7, 0.14 * s, x);
        } else if (kind === 2) {                                                                          // crackle pop
          var tn = ac.currentTime;
          if (tn - lastPopSnd < 0.035) { return; }
          lastPopSnd = tn;
          sndNoise(0, 0.03, 'highpass', 2800 + Math.random() * 2400, 2800, 0.8, 0.1, x);
        } else if (kind === 3) { sndNoise(0, Math.min(8, s), 'bandpass', 2600, 1900, 0.9, 0.05, x); }      // anar hiss
        else if (kind === 4) { sndNoise(0, Math.min(8, s), 'bandpass', 700, 1700, 1.6, 0.05, x); }        // chakri whirr
      } catch (e) { /* audio is optional */ }
    }

    /* ---- pool operations ---- */
    function emit(x, y, vxx, vyy, lf, drag, grav, size, slot, cls, flags, trail, hkk, emp, dly) {
      if (nFree <= 0) { return -1; }
      var i = freeStk[--nFree];
      px[i] = x; py[i] = y; vx[i] = vxx; vy[i] = vyy;
      life[i] = lf; mlife[i] = lf; dm[i] = drag; gs[i] = grav * STEP; sz[i] = size;
      rm[i] = slot; cl[i] = cls; fl[i] = flags; tl[i] = trail; hk[i] = hkk; hc[i] = 0; hi[i] = 0; hn[i] = 0;
      em[i] = emp; dl[i] = dly;
      act[nAct++] = i;
      return i;
    }
    function addLight(x, y, r0, r1, a, dur, rise, ramp) {
      if (nLight >= MAX_LIGHTS) { return; }
      var k = nLight++;
      lx[k] = x; ly[k] = y; lr0[k] = r0; lr1[k] = r1; la[k] = a; lt[k] = 0; ld[k] = dur; lrise[k] = rise; lramp[k] = ramp;
    }
    function sched(delay, kind, a, b, c, d, e, f) {
      if (nEv >= MAX_EVENTS) { return; }
      var k = nEv++;
      evT[k] = T + delay; evK[k] = kind;
      evA[k] = a; evB[k] = b; evC[k] = c; evD[k] = d; evE[k] = e; evF[k] = f;
    }

    /* ---- burst construction ---- */
    var dX = 0, dY = 0, dZ = 0;
    function sphere(i, n, rot) {
      var zz = 1 - 2 * (i + 0.5 + (Math.random() - 0.5) * 0.35) / n;
      zz = clamp(zz, -1, 1);
      var rad = Math.sqrt(Math.max(0, 1 - zz * zz));
      var ph = i * GOLDEN_ANGLE + rot + (Math.random() - 0.5) * 0.08;
      dX = rad * Math.cos(ph); dY = rad * Math.sin(ph); dZ = zz;
    }
    function cnt(base, cs) { return Math.max(4, Math.round(base * cs)); }
    function tlen(t) { return Math.max(1, Math.min(HLEN - 1, Math.round(t * qTrail))); }
    var glintP = 0.4;

    function bPeony(x, y, R, cs) {
      var n = cnt(150, cs), k = 2.35, d = Math.exp(-k * STEP), rot = Math.random() * TWO_PI, g = R * 0.27;
      var i, sp, n2, n3, a;
      for (i = 0; i < n; i++) {
        sphere(i, n, rot);
        sp = R * k * rr(0.94, 1.02);
        emit(x, y, dX * sp, dY * sp, rr(2.1, 2.7), d, g, 2.3 * szu * (1 + 0.2 * dZ), slotOf(sm, dZ), 0,
          Math.random() < glintP ? F_GLINT : 0, tlen(11), 1, 0, 0);
      }
      n2 = cnt(56, cs);
      rot = Math.random() * TWO_PI;
      for (i = 0; i < n2; i++) {
        sphere(i, n2, rot);
        sp = R * 0.54 * k;
        emit(x, y, dX * sp, dY * sp, rr(1.9, 2.4), d, g * 0.9, 2.1 * szu * (1 + 0.2 * dZ), slotOf(ss, dZ), 0, Math.random() < glintP ? F_GLINT : 0, tlen(9), 1, 0, 0);
      }
      n3 = cnt(16, cs);
      rot = Math.random() * TWO_PI;
      for (i = 0; i < n3; i++) {
        a = rot + i / n3 * TWO_PI;
        sp = R * 0.24 * k;
        emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rr(1.5, 1.9), d, g * 0.6, 1.8 * szu, slotOf(sa, 0), 0, glintP > 0 ? F_GLINT : 0, tlen(6), 1, 0, 0);
      }
    }

    function bChrysanthemum(x, y, R, cs) {
      var n = cnt(188, cs), k = 2.05, d = Math.exp(-k * STEP), rot = Math.random() * TWO_PI, g = R * 0.23;
      var i, sp, n2, n3, a, emp = reduced ? 0 : Math.round(7 * qEmit);
      for (i = 0; i < n; i++) {
        sphere(i, n, rot);
        sp = R * k * rr(0.94, 1.02);
        emit(x, y, dX * sp, dY * sp, rr(2.7, 3.4), d, g, 2.2 * szu * (1 + 0.2 * dZ), slotOf(sm, dZ), 0,
          (emp ? F_EMIT : 0) | (Math.random() < glintP ? F_GLINT : 0), tlen(18), 2, emp, 0);
      }
      n2 = cnt(66, cs);
      rot = Math.random() * TWO_PI;
      for (i = 0; i < n2; i++) {
        sphere(i, n2, rot);
        sp = R * 0.56 * k;
        emit(x, y, dX * sp, dY * sp, rr(2.3, 2.9), d, g, 2.0 * szu * (1 + 0.2 * dZ), slotOf(ss, dZ), 0, (emp ? F_EMIT : 0), tlen(13), 2, Math.round(emp * 0.6), 0);
      }
      n3 = cnt(18, cs);
      rot = Math.random() * TWO_PI;
      for (i = 0; i < n3; i++) {
        a = rot + i / n3 * TWO_PI;
        sp = R * 0.24 * k;
        emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rr(1.6, 2.1), d, g * 0.6, 1.7 * szu, slotOf(sa, 0), 0, glintP > 0 ? F_GLINT : 0, tlen(8), 1, 0, 0);
      }
    }

    function bWillow(x, y, R, cs) {
      var n = cnt(132, cs), k = 1.5, d = Math.exp(-k * STEP), rot = Math.random() * TWO_PI, g = R * 0.62;
      var i, sp, ramp, emp = reduced ? 0 : Math.round(5 * qEmit);
      for (i = 0; i < n; i++) {
        sphere(i, n, rot);
        sp = R * k * rr(0.55, 1.0);
        ramp = (i % 4 === 3) ? ss : sm;
        emit(x, y, dX * sp, dY * sp - R * 0.15, rr(3.4, 4.6), d, g, 2.3 * szu * (1 + 0.15 * dZ), slotOf(ramp, dZ), 1,
          F_BOLD | (emp ? F_EMIT : 0) | (Math.random() < 0.25 && glintP > 0 ? F_GLINT : 0), tlen(27), 3, emp, 0);
      }
      // bright pistil that hangs in the air
      var n3 = cnt(14, cs), a;
      for (i = 0; i < n3; i++) {
        a = rot + i / n3 * TWO_PI;
        sp = R * 0.2 * k;
        emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rr(1.8, 2.4), d, g * 0.5, 1.9 * szu, slotOf(sa, 0), 1, glintP > 0 ? F_GLINT : 0, tlen(10), 2, 0, 0);
      }
    }

    function bRing(x, y, R, cs) {
      var n = cnt(66, cs), k = 2.65, d = Math.exp(-k * STEP), g = R * 0.13;
      var tilt = rr(0.34, 0.92), rot = rr(-0.55, 0.55), cr = Math.cos(rot), sr = Math.sin(rot);
      var depth = Math.sqrt(1 - tilt * tilt);
      var i, a, ux, uy, sp, ramp, z, off, n2;
      for (i = 0; i < n; i++) {
        a = i / n * TWO_PI;
        ux = Math.cos(a); uy = Math.sin(a) * tilt;
        z = Math.sin(a) * depth;
        sp = R * k;
        ramp = (i & 1) ? ss : sm;
        emit(x, y, (ux * cr - uy * sr) * sp, (ux * sr + uy * cr) * sp, rr(1.95, 2.3), d, g, 2.6 * szu * (1 + 0.2 * z), slotOf(ramp, z), 0,
          (i % 3 === 0 && glintP > 0) ? F_GLINT : 0, tlen(12), 1, 0, 0);
      }
      n2 = cnt(34, cs);
      off = Math.PI / n2;
      for (i = 0; i < n2; i++) {
        a = i / n2 * TWO_PI + off;
        ux = Math.cos(a); uy = Math.sin(a) * tilt;
        z = Math.sin(a) * depth;
        sp = R * 0.56 * k;
        emit(x, y, (ux * cr - uy * sr) * sp, (ux * sr + uy * cr) * sp, rr(1.8, 2.1), d, g, 2.2 * szu * (1 + 0.2 * z), slotOf(sm, z), 0, 0, tlen(9), 1, 0, 0);
      }
      n2 = cnt(12, cs);
      for (i = 0; i < n2; i++) {
        a = Math.random() * TWO_PI; sp = R * rr(0.04, 0.14) * k;
        emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp * tilt, rr(1.4, 1.9), d, g, 1.8 * szu, slotOf(sa, 0), 0, glintP > 0 ? F_GLINT : 0, tlen(6), 1, 0, 0);
      }
    }

    function petalW(u) {
      // padma petal: pinched at the base, full belly just past the middle, drawn-out ogee tip
      return Math.pow(Math.sin(Math.PI * Math.pow(u, 1.1)), 0.8) * (1 - 0.06 * u);
    }
    function bKamal(x, y, R, cs) {
      var P = unit < 480 ? 8 : (Math.random() < 0.5 ? 10 : 12);
      var k = 3.0, d = Math.exp(-k * STEP), g = R * 0.05;
      var layer, p, j, sgn, alpha, ax, ay, nx, ny, u, s, w, tx, ty, L, Wm, s0, ramp, delay, off, size, nSide, nVein, flags;
      for (layer = 0; layer < 2; layer++) {
        L = layer === 0 ? R : R * 0.5;
        s0 = layer === 0 ? 0.2 : 0.1;
        Wm = (layer === 0 ? 0.58 : 0.3) * R * Math.sin(Math.PI / P);
        ramp = layer === 0 ? sm : ss;
        delay = layer === 0 ? 0 : 0.42;
        off = layer === 0 ? 0 : Math.PI / P;
        size = layer === 0 ? 2.0 : 1.6;
        nSide = Math.max(layer === 0 ? 7 : 4, Math.round((layer === 0 ? 10 : 5) * cs));
        nVein = layer === 0 ? Math.max(2, Math.round(3 * cs)) : 0;
        flags = glintP > 0 ? F_GLINT : 0;
        for (p = 0; p < P; p++) {
          alpha = -Math.PI / 2 + off + p * TWO_PI / P;
          ax = Math.cos(alpha); ay = Math.sin(alpha); nx = -ay; ny = ax;
          for (j = 0; j < nSide; j++) {
            u = (j + 1) / (nSide + 1);
            s = (s0 + (1 - s0) * u) * L;
            w = petalW(u) * Wm;
            for (sgn = -1; sgn <= 1; sgn += 2) {
              tx = ax * s + sgn * nx * w; ty = ay * s + sgn * ny * w;
              emit(x, y, tx * k, ty * k, rr(2.55, 2.85), d, g, size * szu, slotOf(ramp, 0), 3, flags, tlen(8), 1, 0, delay + Math.random() * 0.22 + u * 0.2);
            }
          }
          for (j = 0; j < nVein; j++) {
            u = 0.3 + 0.45 * (j + 0.5) / nVein;
            s = (s0 + (1 - s0) * u) * L;
            emit(x, y, ax * s * k, ay * s * k, rr(2.5, 2.8), d, g, size * 0.8 * szu, slotOf(ramp, 0), 3, 0, tlen(6), 1, 0, delay + u * 0.2);
          }
          // bead at the tip
          emit(x, y, ax * L * k, ay * L * k, rr(2.7, 3.0), d, g, size * 1.35 * szu, slotOf(layer === 0 ? sa : sm, 0), 3, flags, tlen(9), 1, 0, delay + 0.3);
        }
      }
      // heart of the flower: two rings of dots
      var nc = P * 2, a, rad;
      for (j = 0; j < nc; j++) {
        a = -Math.PI / 2 + j / nc * TWO_PI;
        rad = R * 0.13;
        emit(x, y, Math.cos(a) * rad * k, Math.sin(a) * rad * k, rr(2.6, 2.9), d, g, 1.6 * szu, slotOf(sa, 0), 3, 0, tlen(5), 1, 0, 0.55 + Math.random() * 0.1);
      }
      nc = P;
      for (j = 0; j < nc; j++) {
        a = -Math.PI / 2 + j / nc * TWO_PI + Math.PI / nc;
        rad = R * 0.065;
        emit(x, y, Math.cos(a) * rad * k, Math.sin(a) * rad * k, rr(2.5, 2.8), d, g, 1.5 * szu, slotOf(RG, 0), 3, 0, tlen(4), 1, 0, 0.65 + Math.random() * 0.1);
      }
    }

    function bPalm(x, y, R, cs) {
      // fronds fan out over the upper two-thirds of the circle, arch over and droop like palm leaves
      var F = 9, k = 1.05, d = Math.exp(-k * STEP), g = R * 0.5;
      var f, q, ang, sp, main, i, emp = reduced ? 0 : Math.round(10 * qEmit);
      var offs = PALM_OFFS;
      var nq = cs < 0.8 ? 3 : 5;
      for (f = 0; f < F; f++) {
        ang = -Math.PI / 2 + (f - (F - 1) / 2) * (3.665 / (F - 1));
        for (q = 0; q < nq; q++) {
          main = (q === 0);
          sp = R * k * (main ? 1.02 : 0.84 + 0.035 * q);
          emit(x, y, Math.cos(ang + offs[q]) * sp, Math.sin(ang + offs[q]) * sp, rr(3.2, 3.9) * (main ? 1 : 0.9), d, g, (main ? 3.1 : 2.4) * szu,
            slotOf(main ? sm : ss, 0), 1, F_BOLD | (emp ? F_EMIT : 0) | (glintP > 0 && !main ? F_GLINT : 0), tlen(main ? 27 : 21), 2, main ? emp : Math.round(emp * 0.5), 0);
        }
      }
      var n3 = cnt(16, cs), a;
      for (i = 0; i < n3; i++) {
        a = i / n3 * TWO_PI;
        sp = R * 0.2 * k;
        emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rr(1.7, 2.3), d, g * 0.4, 1.9 * szu, slotOf(sa, 0), 1, glintP > 0 ? F_GLINT : 0, tlen(10), 2, 0, 0);
      }
    }

    function bCrackle(x, y, R, cs) {
      var n = cnt(104, cs), k = 2.2, d = Math.exp(-k * STEP), rot = Math.random() * TWO_PI, g = R * 0.2;
      var i, sp, lf;
      var pop = reduced ? 0 : F_POP;
      for (i = 0; i < n; i++) {
        sphere(i, n, rot);
        sp = R * k * rr(0.5, 1.0);
        lf = 0.9 + 1.8 * Math.pow(Math.random(), 0.9);
        emit(x, y, dX * sp, dY * sp, lf, d, g, 2.2 * szu * (1 + 0.2 * dZ), slotOf((i & 3) === 3 ? ss : sm, dZ), 0, pop | (glintP > 0 ? F_GLINT : 0), tlen(9), 1, 0, 0);
      }
      var n3 = cnt(16, cs), a;
      for (i = 0; i < n3; i++) {
        a = i / n3 * TWO_PI + rot;
        sp = R * 0.22 * k;
        emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rr(1.3, 1.8), d, g * 0.6, 1.8 * szu, slotOf(sa, 0), 0, glintP > 0 ? F_GLINT : 0, tlen(6), 1, 0, 0);
      }
    }

    function popAt(x, y) {
      var n = qLevel >= 2 ? 3 : 5, j, a, sp, ps = unit / 700;
      for (j = 0; j < n; j++) {
        a = Math.random() * TWO_PI; sp = rr(50, 150) * ps;
        emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rr(0.16, 0.34), 0.93, 40 * ps, rr(1.4, 2.2) * szu, slotOf(RI, 0), 2, 0, 2, 1, 0, 0);
      }
      emit(x, y, 0, 0, 0.1, 1, 0, 3.0 * szu, slotOf(RI, 0), 2, 0, 0, 1, 0, 0);
      if (soundOn) { sfx(2, x, 1); }
    }

    function doBurst(type, x, y, scale, m, s, a) {
      if (W < 2 || H < 2) { return; }
      sm = m; ss = s; sa = a;
      var R = unit * 0.36 * scale * rr(0.93, 1.07);
      var room = Math.min(x, W - x);
      if (room < R * 0.8) { R *= clamp(room / (R * 0.8), 0.72, 1); }       // near a side edge: a little smaller, the rest may spill off
      if (y < R * 0.6) { R *= clamp(y / (R * 0.6), 0.72, 1); }            // near the top: same
      var cs = clamp(R / 230, 0.7, 1.25) * qMul * (reduced ? 0.5 : 1);
      glintP = reduced ? 0 : 0.4;
      switch (type) {
        case 0: bPeony(x, y, R, cs); break;
        case 1: bChrysanthemum(x, y, R, cs); break;
        case 2: bWillow(x, y, R, cs); break;
        case 3: bRing(x, y, R, cs); break;
        case 4: bKamal(x, y, R, cs); break;
        case 5: bPalm(x, y, R, cs); break;
        default: bCrackle(x, y, R, cs); break;
      }
      if (!reduced) {
        if (T - lastFlash >= 0.5 && qLevel === 0) {          // at most 2 flash pulses per second, never a strobe
          lastFlash = T;
          addLight(x, y, R * 0.3, R * 1.6, 0.15, 0.9, 0.1, RG);
        }
      }
      if (qLevel === 0) { addLight(x, y, R * 0.6, R * 1.45, reduced ? 0.045 : 0.1, 2.8, 0.14, m); }
      if (soundOn) { sfx(1, x, type === 6 ? 0.5 : clamp(scale, 0.6, 1.3)); }
    }

    /* ---- rockets ---- */
    function launchRocket(type, x, y, fromX, scale, m, s, a) {
      if (W < 2 || H < 2) { return false; }
      var k = -1, j;
      for (j = 0; j < MAX_ROCKETS; j++) { if (!rOn[j]) { k = j; break; } }
      if (k < 0) { return false; }
      var gy = ground();
      y = Math.min(y, gy - 40);
      var dist = gy - y;
      rOn[k] = 1; nRock++;
      rx0[k] = fromX; ry0[k] = gy; rx1[k] = x; ry1[k] = y;
      rt[k] = 0; rT[k] = clamp(0.6 + dist / 1150, 0.7, 1.5);
      rwob[k] = rr(-1, 1) * Math.min(18, W * 0.025); rph[k] = rnd2PI();
      rsc[k] = scale; rtype[k] = type; rcm[k] = m; rcs[k] = s; rca[k] = a;
      rhi[k] = 0; rhn[k] = 0; rcx[k] = fromX; rcy[k] = gy;
      if (!reduced) { addLight(fromX, gy, 14, 90, 0.07, 0.4, 0.15, RG); }
      if (soundOn) { sfx(0, fromX, 1); }
      return true;
    }
    function rnd2PI() { return Math.random() * TWO_PI; }

    function stepRockets() {
      var k, s, p, nx, ny, ox, oy, e, j, hh, ps = unit / 700;
      for (k = 0; k < MAX_ROCKETS; k++) {
        if (!rOn[k]) { continue; }
        rt[k] += STEP;
        s = rt[k] / rT[k];
        if (s >= 1) {
          rOn[k] = 0; nRock--;
          doBurst(rtype[k], rx1[k], ry1[k], rsc[k], rcm[k], rcs[k], rca[k]);
          continue;
        }
        p = 1 - Math.pow(1 - s, 2.2);
        ox = rcx[k]; oy = rcy[k];
        nx = rx0[k] + (rx1[k] - rx0[k]) * p + rwob[k] * Math.sin(s * 7.5 + rph[k]) * (1 - s) * 0.6;
        ny = ry0[k] + (ry1[k] - ry0[k]) * p;
        // history ring
        hh = rhi[k] + 1; if (hh >= RH) { hh = 0; }
        rhi[k] = hh; rhist[(k * RH + hh) * 2] = ox; rhist[(k * RH + hh) * 2 + 1] = oy;
        if (rhn[k] < RH) { rhn[k]++; }
        rcx[k] = nx; rcy[k] = ny;
        if (nFree > reserve) {
          for (j = 0; j < 2; j++) {
            e = (j + 1) * 0.5;
            emit(lerp(ox, nx, e), lerp(oy, ny, e), rr(-16, 16) * ps + (nx - ox) * 0.5, rr(14, 52) * ps, rr(0.35, 0.75), 0.955, 150 * ps, rr(1.1, 1.7) * szu,
              slotOf(RG, 0), 2, reduced ? 0 : F_GLINT, 2, 1, 0, 0);
          }
        }
      }
    }

    /* ---- ground emitters ---- */
    function addEmitter(kind, x, y, dur) {
      if (nEmit >= MAX_EMITTERS) { return false; }
      var k = nEmit++;
      ekind[k] = kind; ex[k] = x; ey[k] = y; et[k] = 0; ed[k] = dur; eacc[k] = 0; eang[k] = Math.random() * TWO_PI; eenv[k] = 0;
      if (soundOn) { sfx(kind === 1 ? 3 : 4, x, dur); }
      return true;
    }
    function stepEmitters() {
      var k = 0, t, dur, env, rate, n, a, sp, i, ps = unit / 700, h, g, vmax, om, nz, tang, flick;
      while (k < nEmit) {
        et[k] += STEP;
        t = et[k]; dur = ed[k];
        if (t >= dur) {                                    // swap-remove
          nEmit--;
          ekind[k] = ekind[nEmit]; ex[k] = ex[nEmit]; ey[k] = ey[nEmit]; et[k] = et[nEmit]; ed[k] = ed[nEmit];
          eacc[k] = eacc[nEmit]; eang[k] = eang[nEmit]; eenv[k] = eenv[nEmit];
          continue;
        }
        env = Math.min(1, t / 0.35, (dur - t) / 0.7);
        env = Math.max(0, env);
        flick = reduced ? 1 : (0.9 + 0.1 * Math.sin(t * 17 + k * 2.1) * Math.sin(t * 6.3 + 1.7));
        eenv[k] = env * flick;
        if (ekind[k] === 1) {
          // anar: a fountain of gold sparks
          h = clamp(H * 0.36, 130, 720);
          g = 2.5 * h;
          vmax = Math.sqrt(2 * g * h) * 1.42;
          rate = 95 * env * qMul * (reduced ? 0.5 : 1);
          eacc[k] += rate * STEP;
          while (eacc[k] >= 1) {
            eacc[k] -= 1;
            if (nFree <= reserve) { eacc[k] = 0; break; }                // never starve the bursts
            a = -Math.PI / 2 + (Math.random() - 0.5) * (0.16 + 0.3 * Math.random());
            sp = vmax * (0.5 + 0.5 * Math.random()) * (0.75 + 0.25 * env);
            if (emit(ex[k] + rr(-3, 3), ey[k], Math.cos(a) * sp, Math.sin(a) * sp, rr(1.1, 1.9), 0.988, g, rr(1.2, 1.8) * szu, slotOf(RG, 0), 2,
              (reduced ? 0 : F_GLINT) | (Math.random() < 0.1 ? F_BOLD : 0), tlen(5), 1, 0, 0) < 0) { break; }
          }
        } else {
          // chakri: three nozzles on a spinning wheel throwing a spiral of sparks
          om = 8 + 14 * Math.min(1, t / (dur * 0.35));
          if (t > dur * 0.8) { om *= Math.max(0.35, (dur - t) / (dur * 0.2)); }
          rate = 190 * env * qMul * (reduced ? 0.5 : 1);
          eacc[k] += rate * STEP;
          n = Math.floor(eacc[k]);
          eacc[k] -= n;
          if (nFree <= reserve) { n = 0; }
          // spread sparks over the last bit of rotation so each nozzle draws a smooth arm
          for (i = 0; i < n; i++) {
            nz = i % 3;
            a = eang[k] + nz * TWO_PI / 3 + (i / Math.max(1, n)) * om * STEP;
            tang = a + Math.PI / 2 + (Math.random() - 0.5) * 0.25;
            sp = rr(240, 380) * ps * (0.8 + 0.2 * env);
            if (emit(ex[k] + Math.cos(a) * 9 * ps, ey[k] + Math.sin(a) * 9 * ps, Math.cos(tang) * sp, Math.sin(tang) * sp - 40 * ps, rr(0.5, 0.95), 0.975, 240 * ps,
              rr(1.2, 1.8) * szu, slotOf(Math.random() < 0.3 ? RI : RG, 0), 2, reduced ? 0 : F_GLINT, tlen(7), 1, 0, 0) < 0) { break; }
          }
          eang[k] += om * STEP;
        }
        k++;
      }
    }

    /* ---- events, auto ---- */
    function runEvent(k) {
      var kind = evK[k], type, m, s, a, x, y;
      if (kind === EV_LAUNCH || kind === EV_BURST) {
        type = evC[k] | 0;
        pickScheme(type, null); m = sm; s = ss; a = sa;
        if (kind === EV_LAUNCH) { launchRocket(type, evA[k], evB[k], evE[k], evF[k], m, s, a); }
        else { doBurst(type, evA[k], evB[k], evF[k], m, s, a); }
      } else if (kind === EV_ANAR) {
        addEmitter(1, evA[k], ground(), evB[k]);
      } else if (kind === EV_CHAKRI) {
        y = evB[k] >= 0 ? evB[k] : ground() - 6;
        addEmitter(2, evA[k], y, evC[k]);
      }
    }
    function stepEvents() {
      var k = 0, last;
      while (k < nEv) {
        if (evT[k] <= T) {
          if (evK[k] === EV_LAUNCH && evD[k] < 4 && (nFree < MAXP * 0.2 || nRock >= MAX_ROCKETS - 2)) { evT[k] = T + 0.25; evD[k] += 1; k++; continue; }   // crowded sky: wait a beat (at most a second)
          runEvent(k);
          last = --nEv;
          if (k !== last) {
            evT[k] = evT[last]; evK[k] = evK[last];
            evA[k] = evA[last]; evB[k] = evB[last]; evC[k] = evC[last]; evD[k] = evD[last]; evE[k] = evE[last]; evF[k] = evF[last];
          }
        } else { k++; }
      }
    }
    function fireRandom() {
      var a = autoArea, tries = 0, x, y, type;
      do { x = (a.x0 + Math.random() * (a.x1 - a.x0)) * W; tries++; } while (lastAutoX >= 0 && Math.abs(x - lastAutoX) < W * 0.2 && tries < 4);
      y = (a.y0 + Math.random() * (a.y1 - a.y0)) * H;
      type = pickType();
      lastAutoX = x; lastAutoType = type;
      pickScheme(type, null);
      var m = sm, s = ss, ac2 = sa;
      launchRocket(type, x, y, clamp(x + rr(-0.14, 0.14) * W, W * 0.04, W * 0.96), 1, m, s, ac2);
      if (Math.random() < 0.14 && qLevel === 0) {
        var t2 = pickType(), x2 = clamp(x + (Math.random() < 0.5 ? -1 : 1) * rr(0.25, 0.4) * W, W * 0.06, W * 0.94);
        sched(rr(0.18, 0.38), EV_LAUNCH, x2, y + rr(-0.05, 0.08) * H, t2, 0, clamp(x2 + rr(-0.1, 0.1) * W, 0, W), 0.9);
      }
    }

    /* ---- the simulation step ---- */
    function stepParticles() {
      var k = 0, i, l, d, nvx, nvy, c, hh, u;
      while (k < nAct) {
        i = act[k];
        if (dl[i] > 0) { dl[i] -= STEP; k++; continue; }
        l = life[i] - STEP;
        if (l <= 0) {
          if (fl[i] & F_POP) { popAt(px[i], py[i]); }
          freeStk[nFree++] = i;
          act[k] = act[--nAct];
          continue;
        }
        life[i] = l;
        d = dm[i];
        nvx = vx[i] * d + windStep;
        nvy = vy[i] * d + gs[i];
        vx[i] = nvx; vy[i] = nvy;
        if (tl[i] !== 0) {
          c = hc[i] + 1;
          if (c >= hk[i]) {
            c = 0;
            hh = hi[i] + 1; if (hh >= HLEN) { hh = 0; }
            hi[i] = hh;
            hist[(i * HLEN + hh) * 2] = px[i];
            hist[(i * HLEN + hh) * 2 + 1] = py[i];
            if (hn[i] < HLEN) { hn[i]++; }
          }
          hc[i] = c;
        }
        px[i] += nvx * STEP;
        py[i] += nvy * STEP;
        if (em[i] !== 0 && nFree > reserve) {
          u = 1 - l / mlife[i];
          if (u < 0.72 && Math.random() * 255 < em[i]) {
            var ps = unit / 700;
            emit(px[i], py[i], nvx * 0.08 + rr(-16, 16) * ps, nvy * 0.08 + rr(-8, 26) * ps, rr(0.4, 0.9), 0.945, 250 * ps, 1.05 * szu, rm[i], 2,
              reduced ? 0 : F_GLINT, 0, 1, 0, 0);
          }
        }
        k++;
      }
    }
    function stepLights() {
      var k = 0, last;
      while (k < nLight) {
        lt[k] += STEP;
        if (lt[k] >= ld[k]) {
          last = --nLight;
          if (k !== last) {
            lx[k] = lx[last]; ly[k] = ly[last]; lr0[k] = lr0[last]; lr1[k] = lr1[last]; la[k] = la[last];
            lt[k] = lt[last]; ld[k] = ld[last]; lrise[k] = lrise[last]; lramp[k] = lramp[last];
          }
        } else { k++; }
      }
    }
    function simStep() {
      T += STEP; stepNo++;
      windStep = Math.sin(T * 0.37 + 1.3) * 11 * (unit / 700) * STEP;
      if (nEv) { stepEvents(); }
      if (autoOn && !reduced && T >= autoNext && T >= finaleEnd + 1.5) {
        if (nRock < 4 && nAct < MAXP * 0.65) { fireRandom(); }
        autoNext = T + (autoMin + Math.random() * (autoMax - autoMin)) / 1000;
      }
      if (nEmit) { stepEmitters(); }
      if (nRock) { stepRockets(); }
      if (nAct) { stepParticles(); }
      if (nLight) { stepLights(); }
    }

    /* ---- drawing ---- */
    var lbx0 = 0, lby0 = 0, lbx1 = 0, lby1 = 0;
    function drawLightsInto(c) {
      var k, t, env, r, a, rise, u = unit / 700, gx, gy;
      for (k = 0; k < nLight; k++) {
        t = lt[k] / ld[k];
        rise = lrise[k];
        env = t < rise ? t / rise : Math.pow(1 - (t - rise) / (1 - rise), 2);
        a = la[k] * env;
        if (a < 0.002) { continue; }
        r = lr0[k] + (lr1[k] - lr0[k]) * (1 - (1 - t) * (1 - t));
        c.globalAlpha = a;
        c.drawImage(glows[lramp[k]], lx[k] - r, ly[k] - r, r * 2, r * 2);
        if (lx[k] - r < lbx0) { lbx0 = lx[k] - r; } if (lx[k] + r > lbx1) { lbx1 = lx[k] + r; }
        if (ly[k] - r < lby0) { lby0 = ly[k] - r; } if (ly[k] + r > lby1) { lby1 = ly[k] + r; }
      }
      for (k = 0; k < nEmit; k++) {
        env = eenv[k];
        if (env < 0.01) { continue; }
        gx = ex[k]; gy = ey[k];
        if (ekind[k] === 1) {
          r = 150 * u;
          c.globalAlpha = 0.32 * env;
          c.drawImage(glows[RG], gx - r, gy - r * 1.1, r * 2, r * 1.5);
          r = 34 * u;
          c.globalAlpha = 0.9 * env;
          c.drawImage(glows[RI], gx - r, gy - r * 1.1, r * 2, r * 1.4);
          r = 150 * u;
        } else {
          r = 80 * u;
          c.globalAlpha = 0.34 * env;
          c.drawImage(glows[RG], gx - r, gy - r, r * 2, r * 2);
          r = 24 * u;
          c.globalAlpha = 0.9 * env;
          c.drawImage(glows[RI], gx - r, gy - r, r * 2, r * 2);
          r = 80 * u;
        }
        if (gx - r < lbx0) { lbx0 = gx - r; } if (gx + r > lbx1) { lbx1 = gx + r; }
        if (gy - r * 1.2 < lby0) { lby0 = gy - r * 1.2; } if (gy + r > lby1) { lby1 = gy + r; }
      }
      c.globalAlpha = 1;
    }
    function drawLights() {
      var c = ctx, g = glowCtx, x0, y0, x1, y1, ws, hs;
      if (!nLight && !nEmit) { return; }
      lbx0 = 1e9; lby0 = 1e9; lbx1 = -1e9; lby1 = -1e9;
      if (!g) { drawLightsInto(c); return; }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, glw, glh);
      g.setTransform(glw / W, 0, 0, glh / H, 0, 0);
      g.globalCompositeOperation = 'lighter';
      drawLightsInto(g);
      if (lbx1 <= lbx0 || lby1 <= lby0) { return; }
      x0 = Math.max(0, Math.floor(lbx0 * GLS) - 1); y0 = Math.max(0, Math.floor(lby0 * GLS) - 1);
      x1 = Math.min(glw, Math.ceil(lbx1 * GLS) + 1); y1 = Math.min(glh, Math.ceil(lby1 * GLS) + 1);
      ws = x1 - x0; hs = y1 - y0;
      if (ws <= 0 || hs <= 0) { return; }
      c.globalAlpha = 1;
      c.drawImage(glowCv, x0, y0, ws, hs, x0 * W / glw, y0 * H / glh, ws * W / glw, hs * H / glh);
    }

    function drawParticles() {
      var c = ctx, k, i, u, stage, key, b, j, n = 0, pos, cnt0, s0, s1, slot, wc, rest, tier, t, vmax, v, hh, ri, base, st, drawn, tierFrom, s, ramp, sprite;
      var fr = frameNo;
      bcount.fill(0);
      for (k = 0; k < nAct; k++) {
        i = act[k];
        if (dl[i] > 0) { continue; }
        u = 1 - life[i] / mlife[i];
        stage = lut[cl[i] * 64 + ((u * 63) | 0)];
        key = (((fl[i] & F_BOLD) ? NSLOT : 0) + rm[i]) * NST + stage;
        bkey[i] = key;
        bcount[key]++;
        // a trail shorter than ~2px is invisible: skip stroking it (settled kamal dots, hanging willow stars)
        v = tl[i] * hk[i] * STEP;
        tv[i] = ((vx[i] * vx[i] + vy[i] * vy[i]) * v * v > 4 && hn[i] > 0) ? 1 : 0;
        n++;
      }
      if (!n) { return; }
      pos = 0;
      for (b = 0; b < NB; b++) { bstart[b] = pos; bpos[b] = pos; pos += bcount[b]; }
      for (k = 0; k < nAct; k++) {
        i = act[k];
        if (dl[i] > 0) { continue; }
        order[bpos[bkey[i]]++] = i;
      }
      tierFrom = qLevel === 0 ? 0 : 1;
      var skipOdd = qLevel > 1;
      for (b = 0; b < NB; b++) {
        cnt0 = bcount[b];
        if (!cnt0) { continue; }
        s0 = bstart[b]; s1 = s0 + cnt0;
        stage = b % NST;
        rest = (b / NST) | 0;
        wc = rest >= NSLOT ? 1 : 0;
        slot = rest - wc * NSLOT;
        for (tier = tierFrom; tier < NTIER; tier++) {
          if (tier === 0 && !wc) { continue; }          // the soft aura is only for the long bold trails
          if (tier === 2 && qLevel > 0) { continue; }   // lighter tiers when the device struggles
          drawn = 0;
          c.beginPath();
          st = tier === 0 ? 4 : (tier === 1 ? 3 : (tier === 2 ? 2 : 1));
          for (j = s0; j < s1; j++) {
            i = order[j];
            if (!tv[i]) { continue; }
            if (skipOdd && tier === 1 && (i & 1)) { continue; }
            vmax = hn[i];
            if (vmax > tl[i]) { vmax = tl[i]; }
            if (tier === 2) { vmax = Math.ceil(vmax * 0.58); }
            else if (tier === 3) { vmax = Math.ceil(vmax * 0.28); }
            c.moveTo(px[i], py[i]);
            hh = hi[i]; base = i * HLEN;
            v = st > vmax ? vmax : st;
            while (v <= vmax) {
              ri = hh - (v - 1); if (ri < 0) { ri += HLEN; }
              c.lineTo(hist[(base + ri) * 2], hist[(base + ri) * 2 + 1]);
              v += st;
            }
            drawn++;
          }
          if (drawn) {
            c.strokeStyle = strokes[(tier * NSLOT + slot) * NST + stage];
            c.lineWidth = TIER_WIDTH[wc * NTIER + tier] * lwS;
            c.stroke();
          }
        }
      }
      // glowing heads: second pass in device pixels with integer coordinates (soft sprites need no sub-pixel placement,
      // and integer arguments keep the canvas call boundary from boxing a double per argument)
      c.setTransform(1, 0, 0, 1, 0, 0);
      var scx = sx, scy = sy, g3 = (fr / 3) | 0;
      for (b = 0; b < NB; b++) {
        cnt0 = bcount[b];
        if (!cnt0) { continue; }
        s0 = bstart[b]; s1 = s0 + cnt0;
        stage = b % NST;
        rest = (b / NST) | 0;
        slot = rest >= NSLOT ? rest - NSLOT : rest;
        sprite = sprites[(slot >> 1) * NST + stage];
        c.globalAlpha = headA[slot * NST + stage];
        for (j = s0; j < s1; j++) {
          i = order[j];
          if ((fl[i] & F_GLINT) && stage > 4 && ((Math.imul(g3 + i * 7, 2654435761) >>> 30) < 2)) { continue; }   // glitter: random on/off every 3 frames
          s = sz[i] * HALO * ((slot & 1) ? 0.8 : 1) * scx;
          v = (s * 2) | 0;
          if (v < 2) { continue; }
          c.drawImage(sprite, (px[i] * scx - s) | 0, (py[i] * scy - s) | 0, v, v);
        }
      }
      c.globalAlpha = 1;
      c.setTransform(sx, 0, 0, sy, 0, 0);
    }

    function drawRockets() {
      var c = ctx, k, tier, base, v, ri, hh, n, s, vm, head;
      if (!nRock) { return; }
      for (k = 0; k < MAX_ROCKETS; k++) {
        if (!rOn[k]) { continue; }
        n = rhn[k];
        if (n > 0) {
          for (tier = 1; tier < NTIER; tier++) {
            vm = tier === 1 ? n : (tier === 2 ? Math.ceil(n * 0.6) : Math.ceil(n * 0.3));
            c.strokeStyle = strokes[(tier * NSLOT + RG * 2) * NST + 1];
            c.lineWidth = (0.9 + tier * 0.9) * lwS;
            c.beginPath();
            c.moveTo(rcx[k], rcy[k]);
            hh = rhi[k]; base = k * RH;
            for (v = 1; v <= vm; v++) {
              ri = hh - (v - 1); if (ri < 0) { ri += RH; }
              c.lineTo(rhist[(base + ri) * 2], rhist[(base + ri) * 2 + 1]);
            }
            c.stroke();
          }
        }
        head = sprites[RI * NST];
        s = 4.6 * szu * HALO * 0.85;
        c.drawImage(head, rcx[k] - s, rcy[k] - s, s * 2, s * 2);
      }
    }

    function makeQuietSprite() {
      var cv = doc.createElement('canvas');
      cv.width = cv.height = 64;
      var x = cv.getContext('2d');
      if (!x) { return null; }
      var gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(0,0,0,1)');
      gr.addColorStop(0.5, 'rgba(0,0,0,0.92)');
      gr.addColorStop(0.78, 'rgba(0,0,0,0.38)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = gr;
      x.fillRect(0, 0, 64, 64);
      return cv;
    }
    function render() {
      var c = ctx;
      dirty = false;
      if (!nAct && !nRock && !nLight && !nEmit) {
        if (!cleanCanvas) {                                  // nothing to draw: make sure the last frame is wiped, then stay idle
          c.setTransform(1, 0, 0, 1, 0, 0);
          c.clearRect(0, 0, canvas.width, canvas.height);
          cleanCanvas = true;
        }
        return;
      }
      cleanCanvas = false;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.setTransform(sx, 0, 0, sy, 0, 0);
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = 1;
      c.lineCap = 'butt';
      c.lineJoin = 'bevel';
      frameNo++;
      drawLights();
      drawParticles();
      drawRockets();
      if (qzOn && quietSprite) {
        // quiet zone: softly knock the fireworks back where the page keeps its text
        c.globalCompositeOperation = 'destination-out';
        c.globalAlpha = qzS;
        c.drawImage(quietSprite, qzx - qzw * 0.62, qzy - qzh * 0.62, qzw * 1.24, qzh * 1.24);
      }
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
    }
    function renderIdle() { if (W > 0) { render(); } }

    /* ---- the loop ---- */
    function isRunning() { return started && pageVisible && !docHidden && !destroyed; }
    function wantsFrames() { return nAct || nRock || nLight || nEmit || nEv || (autoOn && !reduced && W > 0) || needResize || dirty; }
    function schedule() {
      if (rafId || destroyed || !isRunning()) { return; }
      lastTs = 0; acc = 0;
      if (typeof global.requestAnimationFrame === 'function') { rafId = global.requestAnimationFrame(frame); }
      else { rafId = global.setTimeout(function () { frame(nowMs()); }, 16); }
    }
    function cancelLoop() {
      if (!rafId) { return; }
      if (typeof global.cancelAnimationFrame === 'function') { global.cancelAnimationFrame(rafId); }
      else { global.clearTimeout(rafId); }
      rafId = 0;
    }
    function frame(ts) {
      rafId = 0;
      if (destroyed || !isRunning()) { return; }
      var t0 = nowMs();
      if (typeof ts !== 'number') { ts = t0; }
      var dt = lastTs ? (ts - lastTs) / 1000 : 0;
      lastTs = ts;
      if (dt < 0) { dt = 0; }
      var heavy = nAct > 60;
      if (dt > 0 && dt < 0.25) { fpsMs += (dt * 1000 - fpsMs) * 0.1; }
      if (dt > 0 && dt < 0.25 && heavy) { frameEma += (dt * 1000 - frameEma) * 0.08; }
      if (dt > 0.25) { dt = 0.0167; }
      if (needResize || num(global.devicePixelRatio, 1, 0.25, 8) !== rawDpr) { doResize(); }
      acc += Math.min(dt, 0.1);
      var steps = 0;
      if (W > 0) {
        while (acc >= STEP && steps < 4) { simStep(); acc -= STEP; steps++; }
        if (acc > STEP * 2) { acc = 0; }
        if (steps > 0 || dirty) { render(); }
      } else { acc = 0; }
      // adaptive quality from rolling frame time and our own work time
      var work = nowMs() - t0;
      if (steps > 0 && heavy) { workEma += (work - workEma) * 0.1; }
      if (dt > 0) {
        // degrade when frames are late (> 24 ms) or our own work is heavy; restore only after sustained health under load
        if (heavy && (frameEma > 24 || workEma > 9)) {
          slowT += dt; goodT = 0;
          if (slowT > 0.35 && qLevel < 2 && T - lastDegradeAt > 1) {
            setQuality(qLevel + 1); slowT = 0; lastDegradeAt = T;
            if (T - lastRestoreAt < 20) { backoff = Math.min(8, backoff * 2); }
          }
        } else {
          slowT = Math.max(0, slowT - dt);
          if (qLevel > 0 && nAct > 150 && frameEma < 19 && workEma < 6.5) {
            goodT += dt;
            if (goodT > 5 * backoff) { setQuality(qLevel - 1); goodT = 0; lastRestoreAt = T; }
          } else if (nAct > 150) { goodT = Math.max(0, goodT - dt); }
        }
      }
      if (wantsFrames() || nAct) { schedule2(); }
    }
    function schedule2() {
      if (rafId || destroyed || !isRunning()) { return; }
      if (typeof global.requestAnimationFrame === 'function') { rafId = global.requestAnimationFrame(frame); }
      else { rafId = global.setTimeout(function () { frame(nowMs()); }, 16); }
    }
    function setQuality(q) {
      qLevel = q;
      qMul = q === 0 ? 1 : (q === 1 ? 0.72 : 0.5);
      qTrail = q === 0 ? 1 : (q === 1 ? 0.8 : 0.62);
      qEmit = q === 0 ? 1 : (q === 1 ? 0.6 : 0.3);
    }
    function ensureLoop() { if (!rafId) { schedule(); } }
    function clearAll() {
      var k;
      nAct = 0; nFree = MAXP;
      for (k = 0; k < MAXP; k++) { freeStk[k] = MAXP - 1 - k; }
      for (k = 0; k < MAX_ROCKETS; k++) { rOn[k] = 0; }
      nRock = 0; nLight = 0; nEv = 0; nEmit = 0;
      finaleEnd = 0;
    }
    function wipeCanvas() {
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } catch (e) { /* ignore */ }
    }
    function onReducedChanged() {
      if (master) { master.gain.value = reduced ? 0.32 : 0.5; }
      if (reduced) {
        // drop anything flashy that is already in flight
        nLight = 0; nEmit = 0; nEv = 0;
        var k, j;
        for (k = 0; k < nAct; k++) { j = act[k]; fl[j] &= ~(F_GLINT | F_POP | F_EMIT); em[j] = 0; }
      }
    }
    function onVis() {
      docHidden = (doc.visibilityState === 'hidden');
      if (docHidden) { cancelLoop(); } else { lastTs = 0; ensureLoop(); }
    }
    doc.addEventListener('visibilitychange', onVis);

    /* ---- sizing observers ---- */
    if (typeof global.ResizeObserver === 'function') {
      try { ro = new global.ResizeObserver(function () { onResizeSignal(); }); ro.observe(canvas); } catch (e4) { ro = null; }
    }
    if (!ro) {
      global.addEventListener('resize', onResizeSignal);
      global.addEventListener('orientationchange', onResizeSignal);
    }
    doResize();

    /* ---- public API ---- */
    function ready() {
      if (destroyed || !pageVisible || docHidden) { return false; }
      if (needResize || W < 2) { doResize(); }
      return W >= 2 && H >= 2;
    }
    function kick() { started = true; ensureLoop(); }

    function resolveType(v) {
      if (typeof v === 'string' && TYPE_INDEX.hasOwnProperty(v.toLowerCase())) { return TYPE_INDEX[v.toLowerCase()]; }
      if (typeof v === 'number' && v >= 0 && v < TYPES.length) { return v | 0; }
      return pickType();
    }
    function optObj(o) { return (o && typeof o === 'object') ? o : {}; }

    var api = {
      start: function () {
        if (destroyed) { return; }
        started = true; needResize = true;
        ensureLoop();
      },
      stop: function () {
        if (destroyed) { return; }
        started = false;
        cancelLoop();
        clearAll();
        wipeCanvas();
        dirty = false; cleanCanvas = true;
      },
      resize: function () {
        if (destroyed) { return; }
        needResize = true;
        if (!rafId) { doResize(); renderIdle(); }
      },
      setVisible: function (v) {
        if (destroyed) { return; }
        pageVisible = !!v;
        if (!pageVisible) { cancelLoop(); } else { lastTs = 0; if (started) { ensureLoop(); } }
      },
      launch: function (o) {
        if (destroyed) { return false; }
        o = optObj(o);
        if (!ready()) { return false; }
        var type = resolveType(o.type);
        var x = num(o.x, W * rr(0.3, 0.7), -W * 0.2, W * 1.2);
        var y = num(o.y, H * rr(0.16, 0.4), -H * 0.2, H * 1.1);
        var fromX = num(o.fromX, clamp(x + rr(-0.12, 0.12) * W, W * 0.04, W * 0.96), -W * 0.2, W * 1.2);
        var scale = num(o.scale, 1, 0.3, 2.5);
        pickScheme(type, o.color);
        var ok = launchRocket(type, x, y, fromX, scale, sm, ss, sa);
        if (ok) { kick(); }
        return ok;
      },
      burst: function (o) {
        if (destroyed) { return false; }
        o = optObj(o);
        if (!ready()) { return false; }
        var type = resolveType(o.type);
        var x = num(o.x, W * 0.5, -W * 0.2, W * 1.2);
        var y = num(o.y, H * 0.3, -H * 0.2, H * 1.1);
        var scale = num(o.scale, 1, 0.3, 2.5);
        pickScheme(type, o.color);
        doBurst(type, x, y, scale, sm, ss, sa);
        kick();
        return true;
      },
      auto: function (on, o) {
        if (destroyed) { return false; }
        o = optObj(o);
        autoOn = !!on;
        var mn = num(o.minDelay, autoMin, 150, 60000), mx = num(o.maxDelay, autoMax, 150, 60000);
        autoMin = Math.min(mn, mx); autoMax = Math.max(mn, mx);
        var ar = optObj(o.area);
        var x0 = num(ar.x0, autoArea.x0, 0, 1), x1 = num(ar.x1, autoArea.x1, 0, 1);
        var y0 = num(ar.y0, autoArea.y0, 0, 1), y1 = num(ar.y1, autoArea.y1, 0, 1);
        autoArea = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
        if (autoOn) {
          autoNext = T + Math.min(autoMin, 700) / 1000;
          if (started) { ensureLoop(); }
        }
        return autoOn;
      },
      finale: function (o) {
        if (destroyed) { return false; }
        o = optObj(o);
        if (!ready()) { return false; }
        var D = num(o.duration, 7000, 1500, 30000) / 1000;
        if (T < finaleEnd - D * 0.3) { return false; }            // already in the middle of one
        finaleEnd = T + D + 0.5;
        schedFinale(D);
        kick();
        return true;
      },
      sparkle: function (o) {
        if (destroyed) { return false; }
        o = optObj(o);
        if (!ready()) { return false; }
        var x = num(o.x, W * 0.5, -50, W + 50), y = num(o.y, H * 0.5, -50, H + 50);
        var n = Math.round(num(o.count, 6, 1, 40));
        if (reduced) { n = Math.max(1, Math.round(n * 0.4)); }
        var j, a, sp, ps = unit / 700;
        if (nFree <= reserve) { return false; }
        for (j = 0; j < n; j++) {
          a = Math.random() * TWO_PI; sp = rr(30, 120) * ps;
          emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 20 * ps, rr(0.35, 0.85), 0.93, 170 * ps, rr(1.0, 1.7) * szu, slotOf(Math.random() < 0.35 ? RI : RG, 0), 2,
            reduced ? 0 : F_GLINT, tlen(3), 1, 0, 0);
        }
        kick();
        return true;
      },
      anar: function (o) {
        if (destroyed) { return false; }
        o = optObj(o);
        if (!ready()) { return false; }
        var ok = addEmitter(1, num(o.x, W * 0.5, -20, W + 20), ground(), num(o.duration, 3500, 300, 20000) / 1000);
        if (ok) { kick(); }
        return ok;
      },
      chakri: function (o) {
        if (destroyed) { return false; }
        o = optObj(o);
        if (!ready()) { return false; }
        var y = (typeof o.y === 'number' && o.y === o.y && isFinite(o.y)) ? clamp(o.y, -20, H + 20) : ground() - 6;
        var ok = addEmitter(2, num(o.x, W * 0.5, -20, W + 20), y, num(o.duration, 3500, 300, 20000) / 1000);
        if (ok) { kick(); }
        return ok;
      },
      setSound: function (on) {
        if (destroyed) { return false; }
        if (!on) { soundOn = false; return false; }
        if (!sndEnsure()) { soundOn = false; return false; }
        try {
          var p = ac.resume && ac.resume();
          if (p && typeof p.catch === 'function') { p.catch(function () { /* needs a gesture */ }); }
          // iOS unlock: a silent one-sample buffer inside the gesture
          var b = ac.createBuffer(1, 1, 22050), s = ac.createBufferSource();
          s.buffer = b; s.connect(ac.destination); s.start(0);
        } catch (e) { /* ignore */ }
        soundOn = true;
        return true;
      },
      setQuietZone: function (z, strength) {
        if (destroyed) { return false; }
        if (!z || typeof z !== 'object') { qzOn = false; dirty = true; return false; }
        var zx = num(z.x, NaN, -1e5, 1e5), zy = num(z.y, NaN, -1e5, 1e5), zw = num(z.w, NaN, 0, 1e5), zh = num(z.h, NaN, 0, 1e5);
        if (zx !== zx || zy !== zy || zw !== zw || zh !== zh || zw < 4 || zh < 4) { qzOn = false; dirty = true; return false; }
        if (!quietSprite) { quietSprite = makeQuietSprite(); }
        qzx = zx + zw / 2; qzy = zy + zh / 2; qzw = zw; qzh = zh;
        qzS = num(strength, 0.6, 0, 0.92);
        qzOn = !!quietSprite && qzS > 0;
        dirty = true;
        if (started) { ensureLoop(); }
        return qzOn;
      },
      setReducedMotion: function (v) {
        if (destroyed) { return; }
        rmFollow = false;
        reduced = !!v;
        onReducedChanged();
      },
      stats: function () {
        if (destroyed) { return { particles: 0, fps: 0 }; }
        return {
          particles: nAct,
          fps: (rafId && fpsMs > 0) ? Math.round(10000 / fpsMs) / 10 : 0,
          quality: qLevel, cap: MAXP, rockets: nRock, workMs: Math.round(workEma * 100) / 100,
          dpr: W ? Math.round(canvas.width / W * 100) / 100 : 0
        };
      },
      destroy: function () {
        if (destroyed) { return; }
        destroyed = true; started = false;
        cancelLoop();
        doc.removeEventListener('visibilitychange', onVis);
        if (ro) { try { ro.disconnect(); } catch (e5) { /* ignore */ } ro = null; }
        else {
          global.removeEventListener('resize', onResizeSignal);
          global.removeEventListener('orientationchange', onResizeSignal);
        }
        if (mql) {
          try { if (mql.removeEventListener) { mql.removeEventListener('change', onMq); } else if (mql.removeListener) { mql.removeListener(onMq); } } catch (e6) { /* ignore */ }
          mql = null;
        }
        clearAll();
        wipeCanvas();
        soundOn = false;
        if (ac) { try { if (ac.close) { var cp = ac.close(); if (cp && cp.catch) { cp.catch(function () { /* ignore */ }); } } } catch (e7) { /* ignore */ } ac = null; master = null; }
        if (canvas.__deepawaliFx === api) { try { delete canvas.__deepawaliFx; } catch (e8) { canvas.__deepawaliFx = null; } }
      }
    };

    /* ---- the finale ---- */
    function schedFinale(D) {
      var narrow = W < 560, wide = W >= 1100;
      var gx = Math.random(), lastX = -1;
      function nextX() {
        var x, tries = 0;
        do { gx = (gx + 0.618034) % 1; x = (0.09 + 0.82 * gx) * W; tries++; } while (lastX >= 0 && Math.abs(x - lastX) < W * 0.16 && tries < 4);
        lastX = x;
        return x;
      }
      function launchAt(delay, type, x, y, scale) {
        sched(delay, EV_LAUNCH, x, y, type, 0, clamp(x + rr(-0.12, 0.12) * W, W * 0.04, W * 0.96), scale);
      }
      var t, ph, gap, nr, q, x, y, ty, pool;

      if (reduced) {
        // gentle: three soft bursts, nothing on the ground
        launchAt(0, 0, W * 0.5, H * 0.3, 0.9);
        launchAt(Math.min(1.1, D * 0.2), 4, W * (narrow ? 0.34 : 0.3), H * 0.3, 0.85);
        launchAt(Math.min(2.2, D * 0.4), 2, W * (narrow ? 0.66 : 0.7), H * 0.26, 0.85);
        return;
      }

      // ground pieces: anar flowerpots and chakri wheels at the base, never more than a few at once
      sched(0, EV_ANAR, W * 0.5, D * 0.34, 0, 0, 0, 0);
      sched(D * 0.1, EV_ANAR, W * 0.22, D * 0.3, 0, 0, 0, 0);
      sched(D * 0.1, EV_ANAR, W * 0.78, D * 0.3, 0, 0, 0, 0);
      sched(D * 0.2, EV_CHAKRI, W * 0.34, -1, Math.min(3.6, D * 0.38), 0, 0, 0);
      sched(D * 0.4, EV_CHAKRI, W * 0.66, -1, Math.min(3.6, D * 0.38), 0, 0, 0);
      if (!narrow) {
        sched(D * 0.46, EV_ANAR, W * 0.36, D * 0.2, 0, 0, 0, 0);
        sched(D * 0.46, EV_ANAR, W * 0.64, D * 0.2, 0, 0, 0, 0);
      }
      sched(D * 0.7, EV_ANAR, W * 0.5, D * 0.2, 0, 0, 0, 0);
      if (!narrow) { sched(D * 0.72, EV_ANAR, W * 0.16, D * 0.16, 0, 0, 0, 0); sched(D * 0.72, EV_ANAR, W * 0.84, D * 0.16, 0, 0, 0, 0); }

      // escalating rockets, then the grand salvo, then a quiet farewell
      t = D * 0.04;
      while (t < D * 0.7) {
        ph = t / D;
        gap = lerp(0.95, 0.44, Math.pow(clamp(ph / 0.7, 0, 1), 1.1));
        nr = ph < 0.26 ? ((ph < 0.1 && !narrow) ? 2 : 1) : (ph < 0.56 ? (narrow ? 1 : 2) : (narrow ? 2 : (ph > 0.66 && wide ? 3 : 2)));
        pool = ph < 0.26 ? [0, 3, 1, 0] : (ph < 0.56 ? [0, 1, 4, 3, 6, 1] : [0, 1, 4, 5, 6, 1, 2, 4, 3]);
        for (q = 0; q < nr; q++) {
          ty = pool[(Math.random() * pool.length) | 0];
          x = nextX();
          y = H * rr(autoArea.y0 + 0.04, autoArea.y1);
          launchAt(t + q * 0.13, ty, x, y, lerp(0.92, 1.1, ph / 0.7));
        }
        t += gap;
      }
      // grand salvo: the lotus at the centre, willows either side, then palms and crackle on the wings
      var gt = D * 0.72, cxx = W * 0.5;
      launchAt(gt, 4, cxx, H * 0.3, 1.3);
      launchAt(gt + 0.16, 2, W * (narrow ? 0.2 : 0.24), H * 0.24, 1.05);
      launchAt(gt + 0.22, 2, W * (narrow ? 0.8 : 0.76), H * 0.24, 1.05);
      launchAt(gt + 0.4, 5, W * (narrow ? 0.3 : 0.38), H * 0.4, 1.0);
      launchAt(gt + 0.46, 5, W * (narrow ? 0.7 : 0.62), H * 0.4, 1.0);
      if (!narrow) {
        launchAt(gt + 0.64, 6, W * 0.1, H * 0.3, 0.95);
        launchAt(gt + 0.7, 6, W * 0.9, H * 0.3, 0.95);
      }
      // farewell: two slow golden willows
      launchAt(D * 0.88, 2, W * 0.36, H * 0.2, 1.0);
      launchAt(D * 0.9, 2, W * 0.64, H * 0.2, 1.0);
    }

    canvas.__deepawaliFx = api;
    return api;
  }

  global.DeepawaliFireworks = {
    version: VERSION,
    types: TYPES.slice(),
    create: create
  };
}(typeof window !== 'undefined' ? window : this));
