// Glance reel diagnostic: how does a reel opened from a DM move on to the next reel when you swipe?
// (docs/research.md, edge case 1 a/b). It classifies the mechanism:
//   A  the URL changes /reel/X/ -> /reel/Y/ with no tap (pushState / replaceState / unseen)
//   B  a pushState/replaceState to the next reel is refused (Glance's guard), but the next reel shows anyway
//   C  the URL never changes; more reels load and scroll inside the same page
//
// How to run (Glance DEBUG build on the phone, logged in; Mac Safari > Settings > Advanced > "Show features
// for web developers" on):
//   1. On the phone, open a DM thread that has a reel a friend sent. On the Mac: Safari > Develop > <iPhone> >
//      the instagram.com page, then open the Console tab.
//   2. Paste this whole file into the Console, press Return, then run:  glanceReel.dm()
//   3. On the phone, tap the shared reel to open it. In the Console run:  glanceReel.start()
//      If it says "glanceReel is not defined" (the page reloaded), paste the file again first.
//   4. On the phone, swipe to the next reel 3 times, waiting about 3 s after each swipe.
//      If the console clears (Glance reloaded the page), paste the file again: recording resumes.
//   5. In the Console run:  glanceReel.stop()   then:  copy(JSON.stringify(glanceReel.last, null, 2))
//      (the copy inside stop() can silently fail in remote Web Inspector) and send us the clipboard.
//
// Read-only on the page: no network, no clicks, no scrolling, no DOM or attribute writes. It adds passive
// listeners and a 100 ms timer, and wraps history.pushState/replaceState to observe them (it calls through to the
// current function, i.e. Glance's guard, and stop() restores it). Its only write is its own state in
// sessionStorage key "glanceReelDiag" (so it survives a page reload; removed by stop()).
// Video src URLs are not logged, only an 8-character hash. The output has usernames and reel shortcodes:
// fine to share with the team, but anonymise it before any of it goes into a repo fixture.
(function () {
  'use strict';
  if (window.glanceReel && window.glanceReel.isRecording && window.glanceReel.isRecording()) {
    console.log('glanceReel is already recording on this page. Run glanceReel.stop() when done.');
    return;
  }

  // ---- Copied from PageScript.swift / NavigationPolicy (keep in sync) ----
  var BLOCKED_PREFIXES = ['/reels/', '/explore/'];
  var ALLOWED_EXACT = ['/explore/search/'];
  var PROFILE_TABS = ['reels'];
  var FEED_HOSTS = ['instagram.com', 'www.instagram.com'];
  var FEED_VARIANTS = ['following', 'favorites'];
  function toURL(value) {
    try { return new URL(String(value), location.href); } catch (e) { return null; }
  }
  function normPath(path) {
    path = (path || '/').toLowerCase();
    return path.slice(-1) === '/' ? path : path + '/';
  }
  function isBlocked(url) {
    var host = url.hostname.toLowerCase();
    if (host !== 'instagram.com' && !/\.instagram\.com$/.test(host)) { return false; }
    var path = normPath(url.pathname);
    if (path === '/' && FEED_HOSTS.indexOf(host) !== -1) {
      return FEED_VARIANTS.indexOf(url.searchParams.get('variant') || '') === -1;
    }
    if (ALLOWED_EXACT.indexOf(path) !== -1) { return false; }
    for (var i = 0; i < BLOCKED_PREFIXES.length; i++) {
      if (path.indexOf(BLOCKED_PREFIXES[i]) === 0) { return true; }
    }
    var parts = path.split('/');
    return parts.length === 4 && PROFILE_TABS.indexOf(parts[2]) !== -1;
  }
  // ---- end of copy ----

  var KEY = 'glanceReelDiag';
  var MEDIA_RE = /^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/i;   // kind, shortcode
  var TAP_WINDOW_MS = 1500;   // a URL change this soon after a tap counts as tapped
  var QUIET_MS = 400;         // a scroll burst ends after this long without scroll events
  var MAX_SNAPSHOTS = 40, MAX_EVENTS = 400, MAX_VIDEOS = 12;

  // ---- small read-only helpers ----
  function arr(list) { return Array.prototype.slice.call(list); }
  function now() { return Date.now(); }
  function here() { return location.pathname + location.search; }
  function pathOf(u) { return u ? u.pathname + u.search : null; }
  function media(path) {
    var m = MEDIA_RE.exec(String(path || '').split('?')[0]);
    return m ? { kind: m[1].toLowerCase(), code: m[2] } : null;
  }
  function codeOf(path) { var m = media(path); return m ? m.code : null; }
  function depth(el) { var d = 0; for (var n = el; n.parentElement; n = n.parentElement) { d++; } return d; }
  function hash(s) {   // FNV-1a, so a src can be compared without logging the CDN URL
    if (!s) { return null; }
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function style(el) { try { return getComputedStyle(el); } catch (e) { return null; } }
  function prop(cs, name) { return cs ? (cs.getPropertyValue(name) || '').trim() || null : null; }
  var ids = new WeakMap(), nextId = 1;   // stable per-element ids without touching the DOM
  function idOf(el) { if (!ids.has(el)) { ids.set(el, nextId++); } return ids.get(el); }

  // ---- state (survives a page reload through sessionStorage) ----
  var state = load() || { dm: null, recording: false, startedAt: null, pages: 0, events: [], snapshots: [],
                          counts: { touchstart: 0, scrollEvents: 0, sameUrlHistoryCalls: 0, popstateNoChange: 0,
                                    droppedEvents: 0, droppedSnapshots: 0 } };
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function clear() { try { sessionStorage.removeItem(KEY); } catch (e) {} }
  function rel(t) { return state.startedAt ? t - state.startedAt : 0; }
  function log(ev) {
    ev.t = rel(now());
    ev.page = state.pages;
    if (state.events.length >= MAX_EVENTS) { state.counts.droppedEvents++; return ev; }
    state.events.push(ev);
    return ev;
  }

  // ---- snapshot: videos, their scroller and snap styles, link counts ----
  function scrollerOf(el) {   // nearest ancestor with overflow-y auto/scroll, else null (the document scrolls)
    for (var n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      if (/(auto|scroll|overlay)/.test(prop(style(n), 'overflow-y') || '')) { return n; }
    }
    return null;
  }
  function slotOf(video, scroller) {   // largest ancestor below the scroller holding only this video
    var node = video;
    while (node.parentElement && node.parentElement !== scroller && node.parentElement !== document.body &&
           node.parentElement.querySelectorAll('video').length === 1) { node = node.parentElement; }
    return node;
  }
  function snapOf(video, scroller) {   // first ancestor (up to the scroller) with scroll-snap-align set
    for (var n = video, up = 0; n && n !== scroller && n !== document.documentElement; n = n.parentElement, up++) {
      var align = prop(style(n), 'scroll-snap-align');
      if (align && align !== 'none') { return { levelsUp: up, align: align, stop: prop(style(n), 'scroll-snap-stop') }; }
    }
    return null;
  }
  function snapshot(reason) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var vids = arr(document.querySelectorAll('video'));
    var scrollers = [];
    var videos = vids.map(function (v, i) {
      var r = v.getBoundingClientRect();
      var visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      var visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      var sc = scrollerOf(v), slot = slotOf(v, sc);
      var scId = sc ? idOf(sc) : 'document';
      var group = scrollers.filter(function (s) { return s.id === scId; })[0];
      if (!group) {
        var cs = sc ? style(sc) : null;
        group = { id: scId, tag: sc ? sc.tagName.toLowerCase() : null, depth: sc ? depth(sc) : 0,
                  role: sc ? sc.getAttribute('role') : null,
                  overflowY: sc ? prop(cs, 'overflow-y') : null, scrollSnapType: sc ? prop(cs, 'scroll-snap-type') : null,
                  scrollTop: Math.round(sc ? sc.scrollTop : window.scrollY),
                  scrollHeight: sc ? sc.scrollHeight : document.documentElement.scrollHeight,
                  clientHeight: sc ? sc.clientHeight : vh,
                  inDialog: !!(sc && sc.closest('[role="dialog"]')), videos: 0 };
        scrollers.push(group);
      }
      if (hooks && !hooks.lastTop.has(scId)) { hooks.lastTop.set(scId, group.scrollTop); }
      group.videos++;
      var src = v.currentSrc || v.src || (v.querySelector('source') || { src: '' }).src;
      var slotCodes = arr(slot.querySelectorAll('a[href]')).map(function (a) { return codeOf(pathOf(toURL(a.getAttribute('href')))); })
        .filter(function (c, k, all) { return c && all.indexOf(c) === k; }).slice(0, 3);
      return {
        index: i, id: idOf(v), scroller: scId,
        rect: { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) },
        viewportShare: vw * vh ? Math.round(100 * visW * visH / (vw * vh)) / 100 : 0,
        paused: v.paused, time: Math.round((v.currentTime || 0) * 10) / 10, readyState: v.readyState,
        src: { scheme: src ? src.split(':')[0] : null, hash: hash(src) }, posterHash: hash(v.getAttribute('poster')),
        slot: { id: idOf(slot), tag: slot.tagName.toLowerCase(), levelsUp: depth(v) - depth(slot),
                indexInParent: slot.parentElement ? arr(slot.parentElement.children).indexOf(slot) : -1,
                siblings: slot.parentElement ? slot.parentElement.children.length : 0, codes: slotCodes },
        snap: snapOf(v, sc),
        inDialog: !!v.closest('[role="dialog"]')
      };
    });
    var inView = videos.slice().sort(function (a, b) { return b.viewportShare - a.viewportShare; })[0];
    var reelHrefs = arr(document.querySelectorAll('a[href^="/reel/"]'));
    var snap = {
      n: state.snapshots.length, t: rel(now()), page: state.pages, reason: reason, path: here(),
      videoCount: vids.length,
      inView: inView && inView.viewportShare > 0 ?
        { index: inView.index, id: inView.id, key: inView.id + '|' + inView.src.hash + '|' + inView.posterHash,
          viewportShare: inView.viewportShare, codes: inView.slot.codes } : null,
      scrollers: scrollers,
      videos: videos.slice(0, MAX_VIDEOS),
      counts: { articles: document.querySelectorAll('article').length,
                reelLinks: reelHrefs.length,   // a[href^="/reel/"]
                reelsLinks: document.querySelectorAll('a[href^="/reels/"]').length,
                dialogs: document.querySelectorAll('[role="dialog"]').length,
                distinctReelCodes: reelHrefs.map(function (a) { return codeOf(a.getAttribute('href')); })
                  .filter(function (c, k, all) { return c && all.indexOf(c) === k; }).slice(0, 20) }
    };
    if (state.snapshots.length >= MAX_SNAPSHOTS) { state.counts.droppedSnapshots++; return null; }
    state.snapshots.push(snap);
    return snap.n;
  }

  // ---- recording hooks ----
  var hooks = null;   // { push, replace, ourPush, ourReplace, timer, listeners, lastHref, lastTap, lastNavigate, bursts }
  function urlChanged(cause, extra) {
    var from = hooks.lastHref, to = location.href;
    hooks.lastHref = to;
    var ev = { type: 'urlChange', from: pathOf(toURL(from)), to: here(), cause: cause,
               msSinceTap: hooks.lastTap ? now() - hooks.lastTap : null };
    for (var k in extra) { ev[k] = extra[k]; }
    ev.snapshot = snapshot('urlChange');
    log(ev);
  }
  function wrap(method) {
    var original = history[method];
    var ours = function (data, title, url) {
      if (!hooks || hooks.wrappers.indexOf(ours) === -1) { return original.apply(this, arguments); }   // stopped
      var before = location.href;
      var target = (url === undefined || url === null) ? null : toURL(url);
      var result;
      try { result = original.apply(this, arguments); } catch (e) {
        log({ type: 'historyCall', method: method, requested: pathOf(target), from: pathOf(toURL(before)), result: 'threw: ' + e.name });
        throw e;
      }
      if (!target || target.href === before) {
        state.counts.sameUrlHistoryCalls++;
      } else if (location.href === target.href) {
        urlChanged(method);
      } else {   // what Glance's guard refusing a call looks like from the page
        log({ type: 'historyCall', method: method, requested: pathOf(target), from: pathOf(toURL(before)),
              result: location.href === before ? 'refused (URL unchanged)' : 'URL became something else: ' + here(),
              glanceGuardBlocks: isBlocked(target), msSinceTap: hooks.lastTap ? now() - hooks.lastTap : null,
              snapshot: snapshot('refusedHistoryCall') });
        if (location.href !== hooks.lastHref) { urlChanged(method + ' (to a different URL than requested)'); }
      }
      return result;
    };
    return { original: original, ours: ours };
  }
  function listen(target, type, fn) {
    target.addEventListener(type, fn, { capture: true, passive: true });
    hooks.listeners.push([target, type, fn]);
  }
  function install() {
    var push = wrap('pushState'), replace = wrap('replaceState');
    hooks = { push: push, replace: replace, wrappers: [push.ours, replace.ours], listeners: [], lastHref: location.href, lastTap: 0, lastNavigate: null, bursts: new Map(), lastTop: new Map() };
    history.pushState = push.ours;
    history.replaceState = replace.ours;
    listen(window, 'popstate', function () {
      if (location.href !== hooks.lastHref) { urlChanged('popstate'); } else { state.counts.popstateNoChange++; }
    });
    listen(window, 'hashchange', function () { if (location.href !== hooks.lastHref) { urlChanged('hashchange'); } });
    listen(window, 'click', function (e) {
      hooks.lastTap = now();
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      var b = e.target && e.target.closest ? e.target.closest('button, [role="button"]') : null;
      log({ type: 'tap', href: a ? pathOf(toURL(a.getAttribute('href'))) : null, onButton: !!b });
    });
    listen(window, 'touchstart', function () { state.counts.touchstart++; });
    listen(document, 'scroll', function (e) {
      state.counts.scrollEvents++;
      var el = e.target === document ? null : e.target;
      var key = el ? idOf(el) : 'document';
      var top = function () { return Math.round(el ? el.scrollTop : window.scrollY); };
      var burst = hooks.bursts.get(key);
      if (!burst) {
        burst = { from: hooks.lastTop.has(key) ? hooks.lastTop.get(key) : top() };   // the event fires after the move
        hooks.bursts.set(key, burst);
        log({ type: 'scrollStart', scroller: key, tag: el ? el.tagName.toLowerCase() : null, scrollTop: burst.from });
      }
      clearTimeout(burst.timer);
      burst.timer = setTimeout(function () {
        hooks.bursts.delete(key);
        hooks.lastTop.set(key, top());
        log({ type: 'scrollEnd', scroller: key, scrollTop: top(), moved: top() - burst.from,
              viewportHeight: window.innerHeight, snapshot: snapshot('scrollEnd') });
      }, QUIET_MS);
    });
    if (window.navigation && window.navigation.addEventListener) {   // Navigation API, where Safari has it
      listen(window.navigation, 'navigate', function (e) {
        hooks.lastNavigate = now();
        log({ type: 'navigateEvent', navigationType: e.navigationType, to: pathOf(toURL(e.destination && e.destination.url)),
              userInitiated: !!e.userInitiated });
      });
    }
    listen(window, 'pagehide', function () { log({ type: 'pagehide' }); save(); });
    hooks.timer = setInterval(function () {   // URL changes nothing above saw (e.g. a saved pushState reference)
      if (location.href === hooks.lastHref) { return; }
      var nav = hooks.lastNavigate && now() - hooks.lastNavigate < 1000;
      urlChanged(nav ? 'no history call seen (a navigate event fired)' : 'no history call seen');
    }, 100);
  }
  function uninstall() {
    var notes = [];
    [['pushState', hooks.push], ['replaceState', hooks.replace]].forEach(function (p) {
      if (history[p[0]] === p[1].ours) { history[p[0]] = p[1].original; }
      else { notes.push('history.' + p[0] + ' was re-wrapped by someone else after start(); left in place (it now just passes through)'); }
    });
    hooks.listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2], { capture: true }); });
    clearInterval(hooks.timer);
    hooks.bursts.forEach(function (b) { clearTimeout(b.timer); });
    hooks = null;
    return notes;
  }

  // ---- classification ----
  function classify() {
    var ev = state.events, snaps = state.snapshots;
    var start = snaps[0], startCode = start ? codeOf(start.path) : null;
    var reelMoves = ev.filter(function (e) {
      return e.type === 'urlChange' && codeOf(e.to) && codeOf(e.to) !== codeOf(e.from);
    });
    var untapped = reelMoves.filter(function (e) { return e.msSinceTap === null || e.msSinceTap > TAP_WINDOW_MS; });
    var refused = ev.filter(function (e) {
      return e.type === 'historyCall' && /^refused/.test(e.result) && codeOf(e.requested) && codeOf(e.requested) !== codeOf(e.from);
    });
    var keys = snaps.map(function (s) { return s.inView ? s.inView.key + '@' + s.page : null; })
      .filter(function (k, i, all) { return k && all.indexOf(k) === i; });
    var codesSeen = [];
    snaps.forEach(function (s) { (s.inView ? s.inView.codes : []).forEach(function (c) { if (codesSeen.indexOf(c) === -1) { codesSeen.push(c); } }); });
    var moved = ev.filter(function (e) { return e.type === 'scrollEnd' && Math.abs(e.moved) >= 0.5 * e.viewportHeight; });
    var last = snaps[snaps.length - 1];
    var grew = start && last && last.page === start.page && last.videoCount > start.videoCount;
    var viewChanged = keys.length > 1 || codesSeen.length > 1;
    var evidence = { startReel: startCode, urlMovesToAnotherReel: reelMoves.length, ofWhichWithoutTap: untapped.length,
                     refusedCallsToAnotherReel: refused.length, distinctVideosInView: keys.length, reelCodesInView: codesSeen,
                     bigScrolls: moved.length, videoCount: start && last ? [start.videoCount, last.videoCount] : null,
                     pageLoads: state.pages, touches: state.counts.touchstart, scrollEvents: state.counts.scrollEvents };
    var out = { guess: 'unclear', reason: '', evidence: evidence };
    function causes(list, field) { return list.map(function (e) { return e[field]; }).filter(function (c, i, all) { return all.indexOf(c) === i; }).join(', '); }
    if (!start) {
      out.reason = 'start() was never run, so there is nothing to compare.';
    } else if (untapped.length) {
      out.guess = 'A';
      out.reason = 'URL moved to another reel ' + untapped.length + 'x with no tap (' + causes(untapped, 'cause') + '): ' +
        untapped.slice(0, 4).map(function (e) { return e.from + ' -> ' + e.to; }).join('; ');
    } else if (refused.length && (viewChanged || moved.length || grew)) {
      out.guess = 'B';
      out.reason = refused.length + ' refused ' + causes(refused, 'method') + ' to another reel (' +
        refused.slice(0, 3).map(function (e) { return e.requested; }).join(', ') + '), yet the reel in view changed' +
        (state.pages > 0 ? ' (and the page reloaded ' + state.pages + 'x: Glance redirected)' : '') + '.';
    } else if (refused.length) {
      out.reason = 'Calls to another reel were refused, but the in-view video did not change' +
        (state.pages > 0 ? ' (Glance reloaded the page ' + state.pages + 'x; this may be the redirect working)' : '') + '.';
    } else if (reelMoves.length) {
      out.reason = 'URL moved to another reel only right after taps (' + reelMoves.length + 'x): did you tap rather than swipe?';
    } else if (viewChanged || moved.length || grew) {
      var sc = last.scrollers.filter(function (s) { return s.videos > 1; })[0];
      out.guess = 'C';
      out.reason = 'URL stayed ' + (last.path === start.path ? start.path : start.path + ' -> ' + last.path) +
        ' but the reel in view changed (' + keys.length + ' distinct videos in view, ' + moved.length + ' scrolls of >= half a screen' +
        (grew ? ', videos ' + start.videoCount + ' -> ' + last.videoCount : '') + ')' +
        (sc ? '; ' + sc.videos + ' videos share scroller #' + sc.id + ' (' + sc.tag + ', overflow-y ' + sc.overflowY +
              ', snap ' + sc.scrollSnapType + ')' : state.counts.scrollEvents === 0 ? '; no element scrolled, so likely a JS/transform pager' : '') + '.';
    } else {
      out.reason = 'Nothing moved: no URL change, no refused call, the same video stayed in view (' +
        state.counts.touchstart + ' touches, ' + state.counts.scrollEvents + ' scroll events). Did the swipes happen?';
    }
    return out;
  }

  // ---- public API ----
  function linkKind(path) {
    var m = media(path);
    if (m) { return m.kind; }
    var seg = path.split('/')[1] || '';
    return ['direct', 'stories', 'explore', 'accounts', ''].indexOf(seg) !== -1 ? (seg || 'root') : 'profileOrOther';
  }
  var api = {
    dm: function () {
      var links = arr(document.querySelectorAll('a[href]')).map(function (a) { return { a: a, u: toURL(a.getAttribute('href')) }; })
        .filter(function (l) { return l.u && /(^|\.)instagram\.com$/i.test(l.u.hostname); });
      var kinds = {};
      links.forEach(function (l) { var k = linkKind(l.u.pathname); kinds[k] = (kinds[k] || 0) + 1; });
      var mediaLinks = links.filter(function (l) { return media(l.u.pathname); }).slice(0, 20).map(function (l) {
        var r = l.a.getBoundingClientRect();
        return { kind: media(l.u.pathname).kind, path: l.u.pathname, code: media(l.u.pathname).code,
                 hrefAbsolute: /^https?:/i.test(l.a.getAttribute('href')), queryKeys: Array.from(l.u.searchParams.keys()),
                 onScreen: r.bottom > 0 && r.top < window.innerHeight && r.height > 0,
                 hasVideo: !!l.a.querySelector('video'), hasImg: !!l.a.querySelector('img'),
                 target: l.a.getAttribute('target'), glanceGuardBlocks: isBlocked(l.u) };
      });
      state.dm = { when: new Date().toISOString(), path: here(), linkKinds: kinds, mediaLinks: mediaLinks,
                   videosOnPage: document.querySelectorAll('video').length, documentId: performance.timeOrigin,
                   warning: mediaLinks.length ? null : 'No a[href] to /reel/ /reels/ /p/ /tv/ here: the shared reel may open via a ' +
                     'tap handler on a non-link (Glance\'s click guard cannot see those either). Scroll the reel into view and retry.' };
      save();
      console.log('glanceReel.dm(): ' + mediaLinks.length + ' media link(s): ' +
        mediaLinks.map(function (m) { return m.path; }).join(', ') + '. Now open the reel and run glanceReel.start().');
      return state.dm;
    },
    start: function () {
      if (hooks) { console.log('Already recording.'); return; }
      state.recording = true;
      state.startedAt = now();
      state.startDocumentId = performance.timeOrigin;
      state.events = [];
      state.snapshots = [];
      state.pages = 0;
      for (var c in state.counts) { state.counts[c] = 0; }
      install();
      snapshot('start');
      save();
      console.log('Recording on ' + here() + '. Swipe to the next reel 3 times, then run glanceReel.stop().');
    },
    stop: function () {
      var notes = [];
      if (hooks) { snapshot('stop'); notes = uninstall(); }
      state.recording = false;
      var result = {
        tool: 'glance diagnose-reel v1',
        when: new Date().toISOString(),
        href: here(),
        userAgent: navigator.userAgent,
        lang: document.documentElement.lang || null,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        glanceInstalled: !!window.__glanceInstalled,
        pushStateIsGlanceGuard: /isBlocked/.test(String(history.pushState)),
        classification: classify(),
        dm: state.dm,
        reloadedBetweenDmAndStart: state.dm && state.startDocumentId ? state.dm.documentId !== state.startDocumentId : null,
        counts: state.counts,
        notes: notes.concat([
          window.__glanceInstalled ? null : 'Glance script not detected (plain Safari?): nothing refuses calls here.',
          'snapshot ids (video/scroller/slot) are per page load; "page" says which load an entry is from.'
        ]).filter(Boolean),
        timeline: state.events,
        snapshots: state.snapshots
      };
      clear();
      api.last = result;
      // copy() called from inside an earlier paste can fail silently in remote Web Inspector, and the page
      // can't tell, so never claim success. A copy() typed at the console prompt works.
      var copied = false;
      try { if (typeof copy === 'function') { copy(JSON.stringify(result, null, 2)); copied = true; } } catch (e) {}
      console.log('glanceReel: ' + result.classification.guess + ' (' + result.classification.reason + ')\n' +
        (copied ? 'Tried to copy the JSON to the clipboard; it may silently not work here. ' : 'copy() is unavailable. ') +
        'To be sure, type this at the console prompt:  copy(JSON.stringify(glanceReel.last, null, 2))');
      return result;
    },
    isRecording: function () { return !!hooks; }
  };
  window.glanceReel = api;

  if (state.recording) {   // pasted again after a page reload: keep recording
    state.pages++;
    install();
    log({ type: 'pageLoaded', path: here(), glanceInstalled: !!window.__glanceInstalled });
    snapshot('pageLoaded');
    save();
    console.log('glanceReel: page reloaded (load #' + state.pages + '); recording resumed. Keep swiping, then glanceReel.stop().');
  } else {
    console.log('glanceReel ready. In the DM thread run glanceReel.dm(); after opening the reel, glanceReel.start().');
  }
})();
