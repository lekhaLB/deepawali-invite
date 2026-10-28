/* Deepawali House Party invitation: page glue.
   Config, countdown, intro, engines, interactions, RSVP / calendar / share. Classic script, ES2017, no storage, no network. */
(function () {
  'use strict';

  var doc = document, root = doc.documentElement;
  var $ = function (s, c) { return (c || doc).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || doc).querySelectorAll(s)); };
  var on = function (el, ev, fn, opt) { if (el) { el.addEventListener(ev, fn, opt); } };

  /* ------------------------------------------------------------------ config */
  var cfg = Object.assign({
    rsvpUrl: '', rsvpBy: '', title: 'Deepawali House Party', start: '', end: '',
    venueName: 'Our home', venueAddress: '', hosts: '', locale: 'en-US', calendarNote: ''
  }, window.INVITE_CONFIG || {});

  function toDate(s) { if (!s) { return null; } var d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  var start = toDate(cfg.start), end = toDate(cfg.end);
  var pinned = /(Z|[+-]\d{2}:?\d{2})$/i.test(String(cfg.start || ''));
  if (start && (!end || end <= start)) { end = null; }

  function fmt(d, o) {
    try { return new Intl.DateTimeFormat(cfg.locale, o).format(d); } catch (e) { return new Intl.DateTimeFormat('en-US', o).format(d); }
  }
  function setText(key, text) {
    $$('[data-invite="' + key + '"]').forEach(function (el) { el.textContent = text; el.hidden = !text; });
  }
  if (start) {
    setText('dateLong', fmt(start, { weekday: 'long', month: 'long', day: 'numeric' }));
    setText('year', fmt(start, { year: 'numeric' }));
    var s1 = fmt(start, { hour: 'numeric', minute: '2-digit' });
    if (end) {
      var e1 = fmt(end, { hour: 'numeric', minute: '2-digit' });
      if (/[AP]M$/i.test(s1) && s1.slice(-2).toUpperCase() === e1.slice(-2).toUpperCase()) { s1 = s1.replace(/\s*[AP]M$/i, ''); }
      setText('timeRange', s1 + ' to ' + e1);
    } else { setText('timeRange', s1 + ' onwards'); }
  }
  setText('venueName', cfg.venueName || '');
  setText('venueAddress', cfg.venueAddress || '');
  setText('hosts', cfg.hosts || '');
  if (cfg.rsvpBy) { setText('rsvpBy', cfg.rsvpBy); }
  else { var intro = $('#rsvp-intro'); if (intro) { intro.textContent = 'Kindly let us know you are coming so we can set the table for everyone.'; } }

  try {
    var to = (new URLSearchParams(location.search).get('to') || '').trim().slice(0, 48);
    if (to) { setText('guest', to); var gl = $('#guest-line'); if (gl) { gl.hidden = false; } }
  } catch (e) { /* old browser: no personalisation */ }

  /* ------------------------------------------------------------------ environment */
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var reduced = !!mq.matches;
  var conn = navigator.connection || {};
  var lite = !!conn.saveData || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);
  var finePointer = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
  var hero = $('#invitation'), content = $('#hero-content'), rowEl = $('#diya-row');
  var fxCanvas = $('#fx-canvas');
  var timers = [];
  var later = function (fn, ms) { timers.push(setTimeout(fn, ms)); };

  var hint = $('#hint');
  if (hint && finePointer) { hint.textContent = 'Click the sky for fireworks. Click a diya to light or douse it.'; }
  function dismissHint() { if (hint) { hint.classList.add('is-gone'); } }

  /* ------------------------------------------------------------------ countdown */
  var cdBox = $('#countdown'), cdGrid = $('.countdown__grid', cdBox || doc), cdMsg = $('#countdown-msg'), cdSr = $('#countdown-sr');
  var lastMinute = -1;
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function tick() {
    if (!start || !cdBox) { return; }
    cdBox.hidden = false;
    var now = Date.now(), t0 = start.getTime(), t1 = end ? end.getTime() : t0 + 6 * 3600e3;
    if (now < t0) {
      var s = Math.floor((t0 - now) / 1000);
      var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
      var vals = { days: pad(d), hours: pad(h), minutes: pad(m), seconds: pad(sec) };
      Object.keys(vals).forEach(function (k) { var el = $('[data-cd="' + k + '"]', cdBox); if (el && el.textContent !== vals[k]) { el.textContent = vals[k]; } });
      cdGrid.hidden = false; cdMsg.hidden = true;
      var minuteKey = Math.floor(s / 60);
      if (minuteKey !== lastMinute && cdSr) {
        lastMinute = minuteKey;
        cdSr.textContent = d > 0 ? d + (d === 1 ? ' day' : ' days') + ' and ' + h + (h === 1 ? ' hour' : ' hours') + ' until the party' : h + (h === 1 ? ' hour' : ' hours') + ' and ' + m + (m === 1 ? ' minute' : ' minutes') + ' until the party';
      }
    } else {
      cdGrid.hidden = true; cdMsg.hidden = false;
      cdMsg.textContent = now < t1 ? 'The celebration has begun' : 'Thank you for celebrating with us';
      if (cdSr) { cdSr.textContent = cdMsg.textContent; }
    }
  }
  tick();
  var cdTimer = setInterval(tick, 1000);

  /* ------------------------------------------------------------------ diyas */
  var DIYAS = 11, MID = 5, diyas = [];
  if (rowEl) {
    for (var i = 0; i < DIYAS; i++) {
      var ring = Math.abs(i - MID), d = doc.createElement('span');
      d.className = 'diya'; d.setAttribute('data-ring', ring); d.style.setProperty('--d', (ring * 0.11).toFixed(2) + 's');
      d.innerHTML = '<img class="diya__base" src="assets/art/diya-base.svg" alt="" width="400" height="200" draggable="false">' +
        '<span class="diya__fl"><img class="diya__flame" src="assets/art/flame.svg" alt="" width="80" height="140" draggable="false"></span><i class="diya__glow"></i>';
      rowEl.appendChild(d); diyas.push(d);
    }
  }
  function lightDiyas() { diyas.forEach(function (d) { d.classList.add('is-lit'); }); }

  /* ------------------------------------------------------------------ engines */
  var fx = null, lights = null, embers = null, petals = null;
  function groundY() {
    if (!rowEl || !fxCanvas) { return undefined; }
    return rowEl.getBoundingClientRect().top - fxCanvas.getBoundingClientRect().top + 6;
  }
  try { if (window.DeepawaliFireworks && fxCanvas) { fx = window.DeepawaliFireworks.create(fxCanvas, { reducedMotion: reduced, getGroundY: groundY, maxParticles: lite ? 450 : undefined }); } } catch (e) { fx = null; }
  try { if (window.DeepawaliLights && $('#lights-mount')) { lights = window.DeepawaliLights.mount($('#lights-mount'), {}); } } catch (e) { lights = null; }
  try { if (window.DeepawaliAmbient && $('#ambient-canvas')) { embers = window.DeepawaliAmbient.embers($('#ambient-canvas'), { density: lite ? .6 : 1 }); } } catch (e) { embers = null; }
  try { if (window.DeepawaliAmbient && $('#petals-canvas')) { petals = window.DeepawaliAmbient.petals($('#petals-canvas'), { density: lite ? .6 : 1 }); } } catch (e) { petals = null; }
  var call = function (o, m, a) { try { if (o && o[m]) { return o[m](a); } } catch (e) { /* engine hiccup must never break the page */ } };

  if (lights) {
    on($('#lights-mount'), 'deepawali:lights-layout', function (e) {
      var h = e && e.detail && e.detail.height; if (h) { hero.style.setProperty('--lights-fallback', Math.round(h) + 'px'); layout(); }
    });
  }

  /* halo is centred on the title; keep the fireworks quiet zone over the text */
  function layout() {
    if (!hero) { return; }
    var title = $('#title'), hr = hero.getBoundingClientRect(), tr = title.getBoundingClientRect();
    hero.style.setProperty('--halo-y', Math.round(tr.top + tr.height / 2 - hr.top) + 'px');
    if (fx && fx.setQuietZone && content) {
      var cr = content.getBoundingClientRect();
      call(fx, 'setQuietZone', null);
      try { fx.setQuietZone({ x: cr.left - hr.left + cr.width * .15, y: cr.top - hr.top + 20, w: cr.width * .7, h: cr.height * .82 }, .55); } catch (e) { /* optional */ }
    }
  }
  layout();
  if (window.ResizeObserver && content) { new ResizeObserver(function () { layout(); }).observe(content); }
  on(window, 'resize', layout);

  /* ------------------------------------------------------------------ intro */
  var introRan = false;
  function intro() {
    if (introRan) { return; } introRan = true;
    layout();
    hero.classList.add('is-on');
    if (reduced) {
      lightDiyas(); call(lights, 'turnOn', { duration: 1 }); call(fx, 'start'); call(embers, 'start'); return;
    }
    call(fx, 'start'); call(embers, 'start');
    later(lightDiyas, 350);
    later(function () { call(lights, 'turnOn', { duration: 1500, from: 'center' }); }, 800);
    later(function () {
      var r = fxCanvas.getBoundingClientRect();
      call(fx, 'launch', { x: r.width * .5, y: Math.max(90, r.height * .2), type: 'kamal' });
    }, 2500);
    later(function () { try { if (fx && !reduced) { fx.auto(true, { minDelay: 2200, maxDelay: 4800, area: { x0: .06, x1: .94, y0: .05, y1: .42 } }); } } catch (e) { /* optional */ } }, 3600);
    later(function () { diyas.forEach(function (d) { d.style.setProperty('--d', '0s'); }); }, 4200);
  }
  function ready() {
    var go = function () { requestAnimationFrame(function () { requestAnimationFrame(intro); }); };
    if (doc.fonts && doc.fonts.ready) {
      var done = false, fin = function () { if (!done) { done = true; go(); } };
      doc.fonts.ready.then(fin, fin); setTimeout(fin, 1200);
    } else { go(); }
  }
  ready();

  /* ------------------------------------------------------------------ hero interactions */
  function launchAt(x, y) {
    if (!fx) { return; }
    fx.launch({ x: x, y: y });
    dismissHint();
  }
  on(hero, 'click', function (e) {
    if (e.target.closest('a, button, .diya, input')) { return; }
    var r = fxCanvas.getBoundingClientRect();
    launchAt(e.clientX - r.left, e.clientY - r.top);
  });
  on(rowEl, 'click', function (e) {
    var d = e.target.closest('.diya'); if (!d) { return; }
    d.style.setProperty('--d', '0s');
    d.classList.toggle('is-lit');
    dismissHint();
    if (d.classList.contains('is-lit') && fx) {
      var fr = $('.diya__fl', d).getBoundingClientRect(), cr = fxCanvas.getBoundingClientRect();
      fx.sparkle({ x: fr.left + fr.width / 2 - cr.left, y: fr.top + fr.height - cr.top, count: 14 });
    }
  });
  on($('#btn-fireworks'), 'click', function () { if (fx) { fx.finale({ duration: 7000 }); } dismissHint(); });

  var soundBtn = $('#sound-btn');
  on(soundBtn, 'click', function () {
    var next = soundBtn.getAttribute('aria-pressed') !== 'true';
    soundBtn.setAttribute('aria-pressed', String(next));
    call(fx, 'setSound', next);
    if (next && fx) { fx.burst({ x: fxCanvas.getBoundingClientRect().width / 2, y: 140, type: 'peony' }); }
  });

  /* pointer parallax + sparkler trail (mouse only) */
  if (finePointer && !reduced) {
    var tx = 0, ty = 0, cx = 0, cy = 0, raf = 0, lastSpark = 0;
    var loop = function () {
      cx += (tx - cx) * .08; cy += (ty - cy) * .08;
      hero.style.setProperty('--px', cx.toFixed(3)); hero.style.setProperty('--py', cy.toFixed(3));
      raf = (Math.abs(tx - cx) > .002 || Math.abs(ty - cy) > .002) ? requestAnimationFrame(loop) : 0;
    };
    on(hero, 'pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') { return; }
      var r = hero.getBoundingClientRect();
      tx = ((e.clientX - r.left) / r.width - .5) * 2; ty = ((e.clientY - r.top) / r.height - .5) * 2;
      if (!raf) { raf = requestAnimationFrame(loop); }
      var now = performance.now();
      if (fx && now - lastSpark > 45 && introRan && !e.target.closest('a, button')) {
        lastSpark = now; var cr = fxCanvas.getBoundingClientRect(); fx.sparkle({ x: e.clientX - cr.left, y: e.clientY - cr.top, count: 2 });
      }
    });
  }

  /* ------------------------------------------------------------------ pause when off screen, react to live setting changes */
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      var vis = es[0].isIntersecting;
      call(fx, 'setVisible', vis); call(lights, 'setVisible', vis); call(embers, 'setVisible', vis);
    }, { threshold: 0 }).observe(hero);
    var rs = $('#rsvp');
    if (rs && petals) {
      new IntersectionObserver(function (es) { call(petals, 'setVisible', es[0].isIntersecting); }, { threshold: 0 }).observe(rs);
      call(petals, 'start');
    }
    // one "lit" reveal per section + section dots
    var secs = $$('.section');
    var reveal = new IntersectionObserver(function (es) { es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); reveal.unobserve(en.target); } }); }, { threshold: .22 });
    secs.forEach(function (s) { reveal.observe(s); });
    var dots = $$('.dots__a');
    var ids = ['invitation', 'dress-code', 'rsvp'];
    var cur = new IntersectionObserver(function (es) {
      es.forEach(function (en) { if (en.isIntersecting) { var i = ids.indexOf(en.target.id); dots.forEach(function (a, j) { a.classList.toggle('is-current', i === j); }); } });
    }, { rootMargin: '-45% 0px -45% 0px' });
    ids.forEach(function (id) { var el = doc.getElementById(id); if (el) { cur.observe(el); } });
  } else {
    $$('.section').forEach(function (s) { s.classList.add('is-in'); });
    call(petals, 'start');
  }
  function onMotion() {
    reduced = !!mq.matches;
    call(fx, 'setReducedMotion', reduced);
    if (reduced) { call(fx, 'auto', false); }
  }
  if (mq.addEventListener) { mq.addEventListener('change', onMotion); } else if (mq.addListener) { mq.addListener(onMotion); }

  /* ------------------------------------------------------------------ toast */
  var toastEl = $('#toast'), toastTimer = 0;
  function toast(msg) {
    if (!toastEl) { return; }
    toastEl.textContent = msg; toastEl.classList.add('is-on');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 2600);
  }

  /* ------------------------------------------------------------------ RSVP seal */
  var seal = $('#rsvp-link'), statusEl = $('#rsvp-status');
  var url = String(cfg.rsvpUrl || '').trim();
  var urlOk = /^https?:\/\/\S+$/i.test(url) && !/paste|your-form|example\./i.test(url);
  if (seal) {
    if (urlOk) {
      seal.href = url; seal.target = '_blank'; seal.rel = 'noopener noreferrer'; seal.setAttribute('data-state', 'ready');
      $('#rsvp-sr').textContent = 'Open the RSVP form (opens in a new tab)';
      if (statusEl) { statusEl.textContent = ''; }
      on(seal, 'pointerdown', function () {
        var r = seal.getBoundingClientRect();
        if (petals) { /* petals keep drifting; a little extra shimmer is enough */ }
        void r;
      });
    } else {
      on(seal, 'click', function (e) {
        e.preventDefault();
        if (statusEl) { statusEl.textContent = ''; setTimeout(function () { statusEl.textContent = 'The RSVP form will be live soon. Please check back.'; }, 60); }
      });
    }
  }

  /* ------------------------------------------------------------------ calendar, directions, share */
  var calBtn = $('#cal-btn'), calMenu = $('#cal-menu');
  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  function stamp(d, utc) {
    return utc
      ? d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + 'T' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + 'Z'
      : d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + 'T' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
  function fold(line) { var out = [], i = 0; while (line.length - i > 73) { out.push(line.substr(i, 73)); i += 73; } out.push(line.substr(i)); return out.join('\r\n '); }
  function where() { return [cfg.venueName, cfg.venueAddress].filter(Boolean).join(', '); }
  function calEnd() { return end || new Date(start.getTime() + 3 * 3600e3); }
  function buildIcs() {
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Deepawali House Party//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
      'UID:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '@deepawali-invite',
      'DTSTAMP:' + stamp(new Date(), true), 'DTSTART:' + stamp(start, pinned), 'DTEND:' + stamp(calEnd(), pinned),
      'SUMMARY:' + esc(cfg.title), 'DESCRIPTION:' + esc(cfg.calendarNote || ''), 'LOCATION:' + esc(where()), 'END:VEVENT', 'END:VCALENDAR'];
    return lines.map(fold).join('\r\n') + '\r\n';
  }
  if (start && calBtn) {
    var g = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(cfg.title) +
      '&dates=' + stamp(start, pinned) + '/' + stamp(calEnd(), pinned) +
      '&details=' + encodeURIComponent(cfg.calendarNote || '') + '&location=' + encodeURIComponent(where());
    $('#cal-google').href = g;
    on($('#cal-ics'), 'click', function (e) {
      var a = e.currentTarget;
      try { a.href = URL.createObjectURL(new Blob([buildIcs()], { type: 'text/calendar;charset=utf-8' })); }
      catch (err) { a.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(buildIcs()); }
      setTimeout(closeMenu, 200);
    });
    on(calBtn, 'click', function (e) {
      e.stopPropagation();
      var open = calBtn.getAttribute('aria-expanded') === 'true';
      open ? closeMenu() : openMenu();
    });
    on(doc, 'click', function (e) { if (calMenu && !calMenu.hidden && !e.target.closest('.actions__cal')) { closeMenu(); } });
    on(doc, 'keydown', function (e) { if (e.key === 'Escape' && calMenu && !calMenu.hidden) { closeMenu(); calBtn.focus(); } });
  } else if (calBtn) { calBtn.hidden = true; }
  function openMenu() { calMenu.hidden = false; calBtn.setAttribute('aria-expanded', 'true'); }
  function closeMenu() { calMenu.hidden = true; calBtn.setAttribute('aria-expanded', 'false'); }

  var dir = $('#directions-link');
  if (dir && cfg.venueAddress) { dir.href = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(cfg.venueAddress); dir.hidden = false; }

  on($('#share-btn'), 'click', function () {
    var data = { title: cfg.title, text: 'You are invited to our ' + cfg.title + '.', url: location.href };
    if (navigator.share) { navigator.share(data).catch(function () { /* cancelled */ }); return; }
    var done = function () { toast('Link copied'); };
    var fallback = function () {
      var t = doc.createElement('textarea'); t.value = location.href; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;opacity:0;top:0';
      doc.body.appendChild(t); t.select();
      try { doc.execCommand('copy'); done(); } catch (e) { toast('Copy the address from your browser bar'); }
      doc.body.removeChild(t);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(location.href).then(done, fallback); } else { fallback(); }
  });

  /* ------------------------------------------------------------------ debug handle (also handy for screenshots) */
  window.__invite = {
    fx: fx, lights: lights, ambient: { embers: embers, petals: petals }, config: cfg,
    celebrate: function () { if (fx) { fx.finale({ duration: 7000 }); } },
    replayIntro: function () {
      timers.forEach(clearTimeout); timers = []; introRan = false;
      hero.classList.remove('is-on'); diyas.forEach(function (d) { d.classList.remove('is-lit'); });
      call(fx, 'auto', false); call(lights, 'turnOff'); void hero.offsetWidth; intro();
    }
  };
})();
