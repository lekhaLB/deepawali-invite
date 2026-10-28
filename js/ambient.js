/*!
 * DeepawaliAmbient: two small, independent canvas effects.
 *
 *   var embers = DeepawaliAmbient.embers(canvasEl, { density: 1 });   // gold sparks rising over the night sky
 *   var petals = DeepawaliAmbient.petals(canvasEl, { density: 1 });   // marigold petals drifting down
 *   // both: { start(), stop(), setVisible(bool), resize(), destroy(), stats() }
 *
 * The canvas must be sized by CSS (for example position:absolute; inset:0; width:100%; height:100%).
 * The backing store is set from its CSS box x DPR (DPR capped at 2, total capped near 3.5 megapixels),
 * never the other way round. stop() leaves the canvas fully transparent. Everything pauses while the tab
 * is hidden or after setVisible(false). Reduced motion: petals draw nothing; embers draw a few still,
 * faint dots (nothing moves) and no animation frame is ever requested.
 *
 * Options: density (default 1), seed (number, for reproducible tests), reducedMotion (boolean; default: follow the OS live).
 * Classic script, ES2017, no dependencies, no console output, no storage, no network.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  if (!doc || (global.DeepawaliAmbient && global.DeepawaliAmbient.__v)) return;

  var TAU = Math.PI * 2;
  var MAX_PX = 3500000;          // hard ceiling for any backing store (spec: about 3.5 megapixels)
  var SOFT_PX = 2000000;         // embers are soft glows: a smaller store looks identical and costs far less at 4K
  var RM_QUERY = '(prefers-reduced-motion: reduce)';
  var nav = global.navigator || {};
  var LITE = !!((nav.connection && nav.connection.saveData) || (nav.hardwareConcurrency && nav.hardwareConcurrency <= 2));

  /* -------------------------------------------------------------- helpers */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function now() { return (global.performance && global.performance.now) ? global.performance.now() : Date.now(); }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function mixHex(a, b, t) {
    var A = hexRgb(a), B = hexRgb(b);
    return 'rgb(' + Math.round(A[0] + (B[0] - A[0]) * t) + ',' + Math.round(A[1] + (B[1] - A[1]) * t) + ',' + Math.round(A[2] + (B[2] - A[2]) * t) + ')';
  }
  function makeCanvas(w, h) {
    var c = doc.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function inertApi() {
    var f = function () {};
    return { start: f, stop: f, setVisible: f, resize: f, destroy: f, stats: function () { return { count: 0, quality: 1, running: false }; } };
  }

  /* ----------------------------------------------------------- shared core */
  /* Handles sizing, DPR, observers, visibility, reduced motion, the rAF loop and cleanup.
     An "impl" supplies init / resize / step / draw / drawStatic / setQuality / count / dispose. */

  function createEffect(canvas, opts, makeImpl) {
    opts = opts || {};
    var ctx = null;
    try { ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null; } catch (e) { ctx = null; }
    if (!ctx) return inertApi();

    var seed = num(opts.seed, (Math.random() * 4294967296) >>> 0);
    var st = {
      running: false, visible: true, inView: true, destroyed: false, rm: false,
      raf: 0, roRaf: 0, last: 0, time: 0,
      w: 0, h: 0, bw: 0, bh: 0, sx: 1, sy: 1, dpr: 1, dprCap: LITE ? 1.5 : 2,
      inited: false, quality: 1, ema: 16.7, work: 0, slowFor: 0, fastFor: 0, dprTick: 0
    };
    if (opts.dprCap > 0) st.dprCap = Math.min(st.dprCap, opts.dprCap);
    var rmFixed = typeof opts.reducedMotion === 'boolean';
    var mql = null;
    if (rmFixed) st.rm = opts.reducedMotion;
    else if (typeof global.matchMedia === 'function') {
      try { mql = global.matchMedia(RM_QUERY); st.rm = !!mql.matches; } catch (e) { mql = null; }
    }
    var impl = makeImpl(ctx, mulberry32(seed), st, opts, seed);

    function baseTransform() { ctx.setTransform(st.sx, 0, 0, st.sy, 0, 0); }

    function clear() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      baseTransform();
    }

    /* CSS box -> backing store. Returns true when the CSS box has an area. */
    function measure() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) {
        var r = canvas.getBoundingClientRect();
        w = Math.round(r.width); h = Math.round(r.height);
      }
      if (!w || !h) return false;
      var dpr = Math.min(global.devicePixelRatio || 1, st.dprCap);
      var cap = Math.min(MAX_PX, opts.maxPixels > 0 ? opts.maxPixels : (impl && impl.maxPixels) || MAX_PX);
      var bs = dpr, px = w * h * bs * bs;
      if (px > cap) bs *= Math.sqrt(cap / px);
      var bw = Math.max(1, Math.round(w * bs)), bh = Math.max(1, Math.round(h * bs));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      st.w = w; st.h = h; st.bw = bw; st.bh = bh; st.dpr = dpr;
      st.sx = bw / w; st.sy = bh / h;
      baseTransform();
      return true;
    }

    function shouldRun() { return st.running && st.visible && st.inView && !doc.hidden && !st.rm && !st.destroyed && st.inited; }

    function sync() {
      if (st.destroyed) return;
      if (shouldRun()) {
        if (!st.raf) { st.last = 0; st.raf = global.requestAnimationFrame(frame); }
      } else if (st.raf) {
        global.cancelAnimationFrame(st.raf);
        st.raf = 0;
      }
    }

    function paint() {
      if (!st.inited) return;
      clear();
      if (st.rm) impl.drawStatic(); else impl.draw();
    }

    function govern(dtMs, dt) {
      st.ema += (dtMs - st.ema) * 0.05;
      if (st.ema > 34 || st.work > 7) { st.slowFor += dt; st.fastFor = 0; } else { st.fastFor += dt; st.slowFor = 0; }
      if (st.slowFor > 1.5 && st.quality > 0.36) {
        st.quality = Math.max(0.35, st.quality * 0.78); st.slowFor = 0;
        impl.setQuality(st.quality);
      } else if (st.fastFor > 8 && st.quality < 1) {
        st.quality = Math.min(1, st.quality + 0.12); st.fastFor = 0;
        impl.setQuality(st.quality);
      }
    }

    function frame(ts) {
      st.raf = 0;
      if (!shouldRun()) return;
      var dtMs = st.last ? Math.max(0, ts - st.last) : 16.7;
      st.last = ts;
      var dt = Math.min(0.05, dtMs / 1000);
      var t0 = now();
      st.time += dt;
      impl.step(dt);
      clear();
      impl.draw();
      st.work += (now() - t0 - st.work) * 0.05;
      if (st.last) govern(dtMs, dt);
      if (++st.dprTick >= 90) {
        st.dprTick = 0;
        if (Math.min(global.devicePixelRatio || 1, st.dprCap) !== st.dpr) api.resize();
      }
      if (shouldRun()) st.raf = global.requestAnimationFrame(frame);
    }

    function initNow() {
      if (!measure()) return false;
      impl.init();
      st.inited = true;
      st.time = 0;
      return true;
    }

    var api = {
      start: function () {
        if (st.destroyed) return;
        st.running = true;
        if (!st.inited) initNow();
        paint();
        sync();
      },
      stop: function () {
        if (st.destroyed) return;
        st.running = false;
        if (st.raf) { global.cancelAnimationFrame(st.raf); st.raf = 0; }
        st.inited = false;
        if (canvas.width && canvas.height) clear();
      },
      setVisible: function (v) {
        if (st.destroyed) return;
        st.visible = !!v;
        sync();
      },
      resize: function () {
        if (st.destroyed) return;
        var ow = st.w, oh = st.h;
        if (!measure()) return;
        if (!st.inited) {
          if (st.running) { impl.init(); st.inited = true; paint(); sync(); }
          return;
        }
        impl.resize(ow, oh);
        paint(); // a resized backing store is blank until painted
      },
      destroy: function () {
        if (st.destroyed) return;
        api.stop();
        st.destroyed = true;
        if (st.roRaf) { global.cancelAnimationFrame(st.roRaf); st.roRaf = 0; }
        if (ro) { ro.disconnect(); ro = null; } else global.removeEventListener('resize', onWinResize);
        if (io) { io.disconnect(); io = null; }
        doc.removeEventListener('visibilitychange', sync);
        if (mql) {
          if (mql.removeEventListener) mql.removeEventListener('change', onRM);
          else if (mql.removeListener) mql.removeListener(onRM);
          mql = null;
        }
        if (impl.dispose) impl.dispose();
        impl = null;
      },
      stats: function () {
        return { count: st.inited ? impl.count() : 0, quality: st.quality, running: !!st.raf, rm: st.rm, w: st.w, h: st.h, bw: st.bw, bh: st.bh, work: st.work };
      }
    };

    /* observers and listeners: all released in destroy() */
    var ro = null, io = null;
    function onSizeChange() {
      if (st.destroyed || st.roRaf) return;
      st.roRaf = global.requestAnimationFrame(function () {
        st.roRaf = 0;
        if (st.destroyed) return;
        if (canvas.clientWidth !== st.w || canvas.clientHeight !== st.h) api.resize();
      });
    }
    function onWinResize() { onSizeChange(); }
    if (typeof global.ResizeObserver === 'function') {
      ro = new global.ResizeObserver(onSizeChange);
      ro.observe(canvas);
    } else {
      global.addEventListener('resize', onWinResize);
    }
    doc.addEventListener('visibilitychange', sync);
    /* self-sufficient pause: no frames while the canvas is scrolled out of view (the page can also call setVisible) */
    if (typeof global.IntersectionObserver === 'function') {
      io = new global.IntersectionObserver(function (entries) {
        var e = entries[entries.length - 1];
        if (!e || st.destroyed) return;
        st.inView = e.isIntersecting;
        sync();
      }, { threshold: 0 });
      io.observe(canvas);
    }
    function onRM(e) {
      if (rmFixed || st.destroyed) return;
      var v = !!(e && e.matches);
      if (v === st.rm) return;
      st.rm = v;
      if (st.raf) { global.cancelAnimationFrame(st.raf); st.raf = 0; }
      if (st.running) {
        if (st.inited) impl.init(); // fresh population for the new mode
        paint();
        sync();
      }
    }
    if (mql) {
      if (mql.addEventListener) mql.addEventListener('change', onRM);
      else if (mql.addListener) mql.addListener(onRM);
    }

    return api;
  }

  /* ---------------------------------------------------------------- embers */

  function embersImpl(ctx, rng, st, opts, seed) {
    var density = clamp(num(opts.density, 1), 0.05, 4);
    var CAP = 140;
    var X0 = new Float32Array(CAP), Y0 = new Float32Array(CAP), VY = new Float32Array(CAP), AMP = new Float32Array(CAP),
        FRQ = new Float32Array(CAP), PH = new Float32Array(CAP), DR = new Float32Array(CAP), SZ = new Float32Array(CAP),
        LIFE = new Float32Array(CAP), AGE = new Float32Array(CAP), FL = new Float32Array(CAP), FP = new Float32Array(CAP),
        BR = new Float32Array(CAP);
    var n = 0, target = 0, u = 1, uh = 1, sprites = null;

    function buildSprites() {
      var defs = [
        [['#FFFFFF', 1, 0], ['#FFF7D0', 1, 0.06], ['#FFE08A', 0.85, 0.16], ['#FFB23A', 0.38, 0.34], ['#F08A14', 0.12, 0.6]],
        [['#FFF6DA', 1, 0], ['#FFDC8A', 1, 0.07], ['#FFB63A', 0.8, 0.17], ['#F0861A', 0.34, 0.36], ['#D4600C', 0.1, 0.62]],
        [['#FFE2B0', 1, 0], ['#FFB454', 0.95, 0.08], ['#F5821E', 0.7, 0.2], ['#D2480E', 0.28, 0.42], ['#A8300A', 0.08, 0.66]]
      ];
      sprites = [];
      for (var i = 0; i < defs.length; i++) {
        var c = makeCanvas(64, 64), g = c.getContext('2d');
        var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        var d = defs[i], rgb;
        for (var j = 0; j < d.length; j++) {
          rgb = hexRgb(d[j][0]);
          gr.addColorStop(d[j][2], 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + d[j][1] + ')');
        }
        gr.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, 64, 64);
        sprites.push(c);
      }
    }

    function computeTarget() {
      u = clamp(Math.sqrt(st.w * st.h) / 900, 0.85, 2);   // size unit
      uh = clamp(st.h / 900, 0.75, 2.4);                  // rise speed scales with the sky height
      target = clamp(Math.round(st.w * st.h / 26000 * density * (LITE ? 0.5 : 1)), 18, 120);
    }
    function activeCount() { return Math.max(4, Math.round(target * st.quality)); }

    function spawn(i, initial) {
      var L = 10 + rng() * 12;
      LIFE[i] = L;
      AGE[i] = initial ? rng() * L : 0;
      X0[i] = (0.5 + (rng() + rng() - 1) * 0.5) * st.w;       // triangular: more near the middle
      Y0[i] = st.h * (0.97 + rng() * 0.05);
      var s = 0.7 + 1.8 * Math.pow(rng(), 2.6);
      SZ[i] = s;
      VY[i] = (18 + 30 * rng()) * uh * (0.8 + 0.25 * s);
      AMP[i] = (6 + 20 * rng()) * u;
      FRQ[i] = TAU * (0.35 + 0.6 * rng());
      PH[i] = rng() * TAU;
      DR[i] = (rng() - 0.35) * 8 * u;
      FL[i] = TAU * (1.2 + 3 * rng());
      FP[i] = rng() * TAU;
      BR[i] = 0.65 + 0.35 * rng();
    }

    function drawOne(x, y, dia, a, temp) {
      if (a < 0.012) return;
      if (x < -dia || x > st.w + dia || y < -dia || y > st.h + dia) return;
      ctx.globalAlpha = a > 1 ? 1 : a;
      ctx.drawImage(sprites[temp], x - dia * 0.5, y - dia * 0.5, dia, dia);
    }

    return {
      maxPixels: SOFT_PX,
      init: function () {
        if (!sprites) buildSprites();
        computeTarget();
        n = activeCount();
        if (st.rm) { n = 0; return; }
        for (var i = 0; i < n; i++) spawn(i, true);
      },
      resize: function (ow, oh) {
        var fx = ow ? st.w / ow : 1, fy = oh ? st.h / oh : 1, i;
        for (i = 0; i < n; i++) { X0[i] *= fx; Y0[i] *= fy; }
        computeTarget();
        var m = activeCount();
        for (i = n; i < m; i++) spawn(i, true);
        n = m;
      },
      setQuality: function () {
        var m = activeCount();
        for (var i = n; i < m; i++) spawn(i, true);
        n = m;
      },
      step: function (dt) {
        for (var i = 0; i < n; i++) {
          AGE[i] += dt;
          if (AGE[i] >= LIFE[i]) spawn(i, false);
        }
      },
      draw: function () {
        ctx.globalCompositeOperation = 'lighter';
        for (var i = 0; i < n; i++) {
          var t = AGE[i], L = LIFE[i], p = t / L;
          var y = Y0[i] - VY[i] * (t - 0.175 * t * t / L);
          var x = X0[i] + DR[i] * t + AMP[i] * Math.sin(FRQ[i] * t + PH[i]) * (0.3 + 0.7 * p);
          var env = Math.min(1, t / 1.1) * Math.min(1, (1 - p) / 0.5);
          env = env * env * (3 - 2 * env);
          var a = env * (0.72 + 0.28 * Math.sin(FL[i] * t + FP[i])) * BR[i];
          var dia = SZ[i] * 11 * u * (1 - 0.3 * p);
          drawOne(x, y, dia, a, p < 0.3 ? 0 : (p < 0.65 ? 1 : 2));
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
      /* reduced motion: a few still, faint dots, drawn once */
      drawStatic: function () {
        if (!sprites) buildSprites();
        computeTarget();
        var r = mulberry32(seed ^ 0x9e3779b9), m = Math.round(target * 0.3);
        ctx.globalCompositeOperation = 'lighter';
        for (var i = 0; i < m; i++) {
          var x = r() * st.w, y = st.h * (0.3 + 0.68 * r());
          var s = 0.7 + 1.4 * Math.pow(r(), 2.4), a = 0.2 + 0.35 * r(), tp = Math.floor(r() * 3);
          drawOne(x, y, s * 10 * u, a, tp);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
      count: function () { return n; },
      dispose: function () { sprites = null; }
    };
  }

  /* ---------------------------------------------------------------- petals */

  var PETAL_COLORS = [
    ['#C8420A', '#F28C28', '#FFC247'],   // marigold orange
    ['#D9780B', '#F2B01E', '#FFE27A'],   // golden
    ['#A8300A', '#E8590C', '#FF9F1C'],   // deep saffron
    ['#D98A12', '#F7C948', '#FFEBA6']    // pale gold
  ];
  var PETAL_WEIGHTS = [0.36, 0.64, 0.84, 1];

  function petalPath(g, w, h) {
    // unit petal: base point at (0,.5), widest near y=-.14, notched ruffled tip at y=-.5
    function X(v) { return w / 2 + v * w; }
    function Y(v) { return h / 2 + v * h; }
    g.beginPath();
    g.moveTo(X(0), Y(0.5));
    g.bezierCurveTo(X(0.2), Y(0.42), X(0.5), Y(0.18), X(0.5), Y(-0.14));
    g.bezierCurveTo(X(0.5), Y(-0.34), X(0.32), Y(-0.5), X(0.13), Y(-0.49));
    g.quadraticCurveTo(X(0.05), Y(-0.48), X(0), Y(-0.4));
    g.quadraticCurveTo(X(-0.05), Y(-0.48), X(-0.13), Y(-0.49));
    g.bezierCurveTo(X(-0.32), Y(-0.5), X(-0.5), Y(-0.34), X(-0.5), Y(-0.14));
    g.bezierCurveTo(X(-0.5), Y(0.18), X(-0.2), Y(0.42), X(0), Y(0.5));
    g.closePath();
  }

  function buildPetalSprite(cols, back, SW, SH) {
    var c = makeCanvas(SW, SH), g = c.getContext('2d');
    var pad = 2, w = SW - pad * 2, h = SH - pad * 2;
    g.translate(pad, pad);
    var b = cols[0], m = cols[1], t = cols[2];
    if (back) { b = mixHex('#5A1A0A', cols[0], 0.62); m = mixHex('#5A1A0A', cols[1], 0.72); t = mixHex('#5A1A0A', cols[2], 0.78); }
    var gr = g.createLinearGradient(0, h, 0, 0);
    gr.addColorStop(0, b); gr.addColorStop(0.5, m); gr.addColorStop(1, t);
    petalPath(g, w, h);
    g.fillStyle = gr;
    g.fill();
    // soft inner light toward the tip
    var rg = g.createRadialGradient(w / 2, h * 0.3, 0, w / 2, h * 0.3, w * 0.55);
    rg.addColorStop(0, back ? 'rgba(255,214,150,.10)' : 'rgba(255,240,190,.34)');
    rg.addColorStop(1, 'rgba(255,240,190,0)');
    g.save(); petalPath(g, w, h); g.clip(); g.fillStyle = rg; g.fillRect(0, 0, w, h); g.restore();
    // veins
    g.strokeStyle = back ? 'rgba(60,10,0,.22)' : 'rgba(255,250,220,.30)';
    g.lineWidth = Math.max(1, w * 0.02);
    g.lineCap = 'round';
    g.beginPath();
    var vs = [[0, -0.33], [0.17, -0.38], [-0.17, -0.38], [0.3, -0.2], [-0.3, -0.2]];
    for (var i = 0; i < vs.length; i++) {
      g.moveTo(w / 2, h * 0.93);
      g.quadraticCurveTo(w / 2 + vs[i][0] * w * 0.45, h * 0.55, w / 2 + vs[i][0] * w, h / 2 + vs[i][1] * h);
    }
    g.stroke();
    // edge
    petalPath(g, w, h);
    g.strokeStyle = back ? 'rgba(50,8,0,.35)' : 'rgba(110,30,0,.3)';
    g.lineWidth = Math.max(1, w * 0.028);
    g.stroke();
    return c;
  }

  function petalsImpl(ctx, rng, st, opts) {
    var density = clamp(num(opts.density, 1), 0.05, 4);
    var CAP = 64;
    var X0 = new Float32Array(CAP), Y0 = new Float32Array(CAP), VY = new Float32Array(CAP), VX = new Float32Array(CAP),
        AMP = new Float32Array(CAP), WF = new Float32Array(CAP), PH = new Float32Array(CAP), ROT = new Float32Array(CAP),
        TILT = new Float32Array(CAP), SPIN = new Float32Array(CAP), FL = new Float32Array(CAP), FS = new Float32Array(CAP),
        FP2 = new Float32Array(CAP), LEN = new Float32Array(CAP), DEPTH = new Float32Array(CAP), AGE = new Float32Array(CAP),
        BORN = new Float32Array(CAP);
    var COL = new Uint8Array(CAP);
    var n = 0, target = 0, u = 1, sprites = null, SW = 0, SH = 0, wind = 0, T = 0;

    function computeTarget() {
      u = clamp(Math.sqrt(st.w * st.h) / 1000, 0.75, 1.7);
      target = clamp(Math.round(st.w * st.h / 60000 * density * (LITE ? 0.6 : 1)), 7, 44);
      var need = Math.round(clamp(31 * u * 1.1 * st.sy, 48, 150));
      if (!sprites || Math.abs(need - SH) / SH > 0.22) {
        SH = need; SW = Math.round(SH * 0.66);
        sprites = [];
        for (var i = 0; i < PETAL_COLORS.length; i++) {
          sprites.push([buildPetalSprite(PETAL_COLORS[i], false, SW, SH), buildPetalSprite(PETAL_COLORS[i], true, SW, SH)]);
        }
      }
    }
    function activeCount() { return Math.max(4, Math.round(target * st.quality)); }

    function spawn(i, initial) {
      var d = rng();
      DEPTH[i] = d;
      var len = (17 + 14 * rng()) * u * (0.75 + 0.25 * d);
      LEN[i] = len;
      VY[i] = (30 + 34 * rng()) * u * (0.7 + 0.3 * d);
      VX[i] = (rng() * 11 - 3) * u;
      AMP[i] = (12 + 22 * rng()) * u;
      WF[i] = 0.8 + 1.3 * rng();
      PH[i] = rng() * TAU;
      ROT[i] = rng() * TAU;
      TILT[i] = 0.5 + 0.7 * rng();
      SPIN[i] = (rng() - 0.5) * 0.8;
      FL[i] = rng() * TAU;
      FS[i] = 1.6 + 2.4 * rng();
      FP2[i] = rng() * TAU;
      var r = rng(), c = 0;
      while (c < PETAL_WEIGHTS.length - 1 && r > PETAL_WEIGHTS[c]) c++;
      COL[i] = c;
      var fall = (st.h + len * 2.4) / VY[i];
      X0[i] = rng() * st.w * 1.1 - st.w * 0.05 - VX[i] * fall * 0.5;
      Y0[i] = -len * 1.2;
      AGE[i] = initial ? rng() * fall : 0;
      BORN[i] = T;
    }

    return {
      init: function () {
        T = 0; wind = 0;
        computeTarget();
        n = st.rm ? 0 : activeCount();
        for (var i = 0; i < n; i++) spawn(i, true);
      },
      resize: function (ow, oh) {
        var fx = ow ? st.w / ow : 1, i;
        for (i = 0; i < n; i++) X0[i] *= fx;
        computeTarget();
        var m = activeCount();
        for (i = n; i < m; i++) spawn(i, true);
        n = m;
      },
      setQuality: function () {
        var m = activeCount();
        for (var i = n; i < m; i++) spawn(i, true);
        n = m;
      },
      step: function (dt) {
        T += dt;
        wind = Math.sin(T * 0.21) * 13 * u;
        for (var i = 0; i < n; i++) {
          AGE[i] += dt;
          if (Y0[i] + VY[i] * AGE[i] > st.h + LEN[i] * 1.2) spawn(i, false);
        }
      },
      draw: function () {
        var k = st.sx;
        for (var i = 0; i < n; i++) {
          var t = AGE[i];
          var y = Y0[i] + VY[i] * t;
          var sw = Math.sin(WF[i] * t + PH[i]);
          var x = X0[i] + VX[i] * t + AMP[i] * sw + wind;
          var th = ROT[i] + SPIN[i] * t + TILT[i] * Math.cos(WF[i] * t + PH[i]);
          var f = Math.tanh(1.9 * Math.cos(FL[i] + FS[i] * t)) * 1.0075;
          var ls = 0.82 + 0.18 * Math.cos(FL[i] * 0.7 + FS[i] * 0.63 * t + FP2[i]);
          var af = f < 0 ? -f : f;
          if (af < 0.06) { af = 0.06; f = f < 0 ? -0.06 : 0.06; }
          var a = (0.55 + 0.4 * DEPTH[i]) * (0.72 + 0.28 * af) * Math.min(1, (T - BORN[i]) / 1.3);
          if (a < 0.01) continue;
          if (x < -LEN[i] || x > st.w + LEN[i] || y < -LEN[i] || y > st.h + LEN[i]) continue;
          var U = LEN[i] / SH * k, c = Math.cos(th), s = Math.sin(th);
          ctx.setTransform(c * f * U, s * f * U, -s * ls * U, c * ls * U, x * k, y * st.sy);
          ctx.globalAlpha = a;
          ctx.drawImage(sprites[COL[i]][f >= 0 ? 0 : 1], -SW / 2, -SH / 2);
        }
        ctx.globalAlpha = 1;
        ctx.setTransform(st.sx, 0, 0, st.sy, 0, 0);
      },
      drawStatic: function () { /* reduced motion: nothing */ },
      count: function () { return n; },
      dispose: function () { sprites = null; }
    };
  }

  /* ------------------------------------------------------------------ API */

  global.DeepawaliAmbient = {
    embers: function (canvas, opts) { return createEffect(canvas, opts, embersImpl); },
    petals: function (canvas, opts) { return createEffect(canvas, opts, petalsImpl); },
    __v: 1
  };
})(typeof window !== 'undefined' ? window : this);
