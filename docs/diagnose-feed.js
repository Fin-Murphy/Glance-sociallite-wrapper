// Glance feed diagnostic: why do non-followed posts leak on instagram.com/ ? (plan-home-stories.md, task 1)
//
// How to run: open instagram.com/ (Glance DEBUG build or Safari on the phone, logged in), scroll until a
// post from an account you don't follow is on screen, then in Mac Safari > Develop > <iPhone> > the page,
// paste this whole file into the Console and press Return. The JSON lands on the clipboard (copy()) and is
// also returned. Tell us which visible[] indexes are accounts you don't follow.
//
// Strictly read-only: no network, no clicks, no scrolling, no DOM or attribute writes. It only reads the
// DOM, computed styles and the page's embedded <script type="application/json"> text.
// The output contains usernames and post codes: fine to share with the team, but anonymise it before any
// of it goes into a repo fixture.
(function () {
  'use strict';

  // ---- Copied from PageScript.swift (keep in sync) ----
  var AD_LABELS = ['sponsored', 'ad'];
  var FOLLOW_LABELS = ['follow', 'follow back'];
  var SUGGESTED_LABELS = ['suggested for you', 'suggested posts'];
  var CAUGHT_UP_LABELS = ["you're all caught up", "you've completely caught up"];
  var MAX_TRAILING_HIDDEN = 10;
  function norm(text) {
    return text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function labelled(root, labels) {
    var found = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var text = node.nodeValue;
      if (text && text.length <= 40 && labels.indexOf(norm(text)) !== -1 && node.parentElement) {
        found.push(node.parentElement);
      }
    }
    return found;
  }
  function adLinked(article) {
    return article.querySelector('a[href*="/ads/ig_redirect"], a[href*="a_mpk="]') !== null;
  }
  function notFollowed(article) {
    return labelled(article, FOLLOW_LABELS).some(function (el) {
      var button = el.closest('button, [role="button"]');
      return button !== null && article.contains(button);
    });
  }
  function slotFor(el) {
    var own = el.matches('article') ? 1 : 0;
    var node = el;
    while (node.parentElement && node.parentElement !== document.body &&
           node.parentElement.querySelectorAll('article').length === own) {
      node = node.parentElement;
    }
    return (node.parentElement && node.parentElement !== document.body) ? node : null;
  }
  // ---- end of copy ----

  var LABEL_RE = /^(suggested|sponsored|ad$|because|based on|paid partnership|recommended|popular|similar|you might|new for you|for you|trending|related|more like|from accounts|people you may|discover|promoted)/i;
  var BUTTONISH = 'button, [role="button"]';
  var CLICKABLE = 'button, [role="button"], a[href], [tabindex]';
  var NOT_PROFILES = ['', 'p', 'reel', 'reels', 'tv', 'explore', 'stories', 'direct', 'accounts', 'about', 'legal',
    'privacy', 'terms', 'developer', 'emails', 'challenge', 'web', 'api', 'graphql', 'ads', 'session', 'oauth',
    'nametag', 'directory', 'locations', 'topics', 'audio', 'music', 'create', 'notifications', 'your_activity',
    'archive', 'saved', 'threads', 'lite', 'download', 'qr', 'invites', 'help', 'press', 'blog', 'jobs', 'ar'];
  var CODE_RE = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/;

  // ---- small read-only helpers ----
  function esc(s) {   // makes NBSP, bullets, zero-width chars etc. visible as \uXXXX
    return String(s).replace(/[^\x20-\x7e]/g, function (c) {
      return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }
  function short(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
  function depth(el) { var d = 0; for (var n = el; n.parentElement; n = n.parentElement) { d++; } return d; }
  function toURL(v) { try { return new URL(String(v), location.href); } catch (e) { return null; } }
  function isIG(u) { var h = u.hostname.toLowerCase(); return h === 'instagram.com' || /\.instagram\.com$/.test(h); }
  function profileOf(a) {   // "/user/" for a link to a profile page, else null
    var u = toURL(a.getAttribute('href'));
    if (!u || !isIG(u)) { return null; }
    var parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 1 || NOT_PROFILES.indexOf(parts[0].toLowerCase()) !== -1 ||
        !/^[A-Za-z0-9._]{1,30}$/.test(parts[0])) { return null; }
    return '/' + parts[0] + '/';
  }
  function codeOf(a) {
    var u = toURL(a.getAttribute('href'));
    var m = u && isIG(u) ? CODE_RE.exec(u.pathname) : null;
    return m ? m[1] : null;
  }
  function display(el) { try { return getComputedStyle(el).display; } catch (e) { return '?'; } }
  function isGone(el) { return display(el) === 'none'; }
  function uniq(arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); }
  function desc(el) {
    if (!el) { return null; }
    return { tag: el.tagName.toLowerCase(), depth: depth(el), role: el.getAttribute('role'),
             glanceHidden: el.hasAttribute('data-glance-hidden'), display: display(el) };
  }
  function textNodes(root, max) {
    var out = [];
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeValue && n.nodeValue.trim() && (!max || n.nodeValue.length <= max)) { out.push(n); }
    }
    return out;
  }
  function count(root, sel) { return root.querySelectorAll(sel).length + (root.matches(sel) ? 1 : 0); }
  function within(root, sel) {
    var list = Array.prototype.slice.call(root.querySelectorAll(sel));
    if (root.matches(sel)) { list.unshift(root); }
    return list;
  }
  function likeEls(root) {   // the post's Like/Unlike control (aria-label, English only)
    return within(root, '[aria-label]').filter(function (el) { return /^(like|unlike)$/i.test(el.getAttribute('aria-label')); });
  }
  function codesIn(root, stopAt) {   // distinct post codes linked inside root (stops early at stopAt)
    var out = [], links = within(root, 'a[href]');
    for (var i = 0; i < links.length && !(stopAt && out.length >= stopAt); i++) {
      var c = codeOf(links[i]);
      if (c && out.indexOf(c) === -1) { out.push(c); }
    }
    return out;
  }

  // ---- 1. find post-like units (not only <article>: H1) ----
  // Each "strong" marker climbs to the largest ancestor that still holds just one of its kind.
  var STRONG = {
    article: { list: function () { return Array.prototype.slice.call(document.querySelectorAll('article')); },
               single: function (el) { return count(el, 'article') <= 1; } },
    time: { list: function () { return Array.prototype.slice.call(document.querySelectorAll('time')); },
            single: function (el) { return count(el, 'time') <= 1; } },
    permalink: { list: function () { return Array.prototype.slice.call(document.querySelectorAll('a[href]')).filter(codeOf); },
                 single: function (el) { return codesIn(el, 2).length <= 1; } },
    likeButton: { list: function () { return likeEls(document.body); },
                  single: function (el) { return likeEls(el).length <= 1; } }
  };
  function climb(el, ok) {
    var node = el;
    while (node.parentElement && node.parentElement !== document.body && node.parentElement !== document.documentElement &&
           ok(node.parentElement)) { node = node.parentElement; }
    return node;
  }
  var candidates = [];   // { el, kinds }
  function addCandidate(el, kind) {
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].el === el) { if (candidates[i].kinds.indexOf(kind) === -1) { candidates[i].kinds.push(kind); } return; }
    }
    candidates.push({ el: el, kinds: [kind] });
  }
  Object.keys(STRONG).forEach(function (kind) {
    STRONG[kind].list().forEach(function (m) { addCandidate(climb(m, STRONG[kind].single), kind); });
  });
  // A candidate spanning two posts is a container (e.g. a lone <article> among non-article posts climbs
  // past the feed list), not a unit.
  var containers = [];
  candidates = candidates.filter(function (c) {
    var codes = codesIn(c.el, 2).length, arts = count(c.el, 'article'), times = count(c.el, 'time'), likes = likeEls(c.el).length;
    if (codes >= 2 || arts >= 2 || (times >= 2 && likes >= 2)) {
      containers.push({ slot: desc(c.el), foundBy: c.kinds, permalinks: codes, articles: arts, times: times, likeButtons: likes });
      return false;
    }
    return true;
  });
  var units = [];   // outermost candidates; nested ones merge into them
  candidates.forEach(function (c) {
    var outer = candidates.filter(function (o) { return o !== c && o.el.contains(c.el); });
    if (outer.length === 0) { units.push({ el: c.el, kinds: c.kinds.slice(), strong: true }); }
  });
  candidates.forEach(function (c) {
    units.forEach(function (u) {
      if (u.el !== c.el && u.el.contains(c.el)) {
        c.kinds.forEach(function (k) { if (u.kinds.indexOf(k) === -1) { u.kinds.push(k); } });
      }
    });
  });
  var strongEls = units.map(function (u) { return u.el; });
  function inStrong(el) { return strongEls.some(function (u) { return u.contains(el); }); }
  var feedLists = uniq(strongEls.map(function (el) { return el.parentElement; }));

  // Weak markers (author links, Follow-ish text, label text) outside every strong unit: group each by the
  // largest ancestor holding no strong unit. Kept as units only if they sit in a feed list (beside posts).
  var outsideFeed = [];
  function freeSlot(el) {
    return climb(el, function (p) { return !strongEls.some(function (u) { return p.contains(u); }); });
  }
  var weak = [];
  function addWeak(marker, kind) {
    if (inStrong(marker)) { return; }
    var slot = freeSlot(marker);
    var hit = weak.filter(function (w) { return w.el === slot; })[0];
    if (!hit) { hit = { el: slot, kinds: [] }; weak.push(hit); }
    if (hit.kinds.indexOf(kind) === -1) { hit.kinds.push(kind); }
  }
  Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
    if (profileOf(a)) { addWeak(a, 'profileLink'); }
  });
  textNodes(document.body, 40).forEach(function (n) {
    if (!n.parentElement) { return; }
    if (/follow/i.test(n.nodeValue)) { addWeak(n.parentElement, 'followText'); }
    else if (LABEL_RE.test(n.nodeValue.trim())) { addWeak(n.parentElement, 'labelText'); }
  });
  weak.forEach(function (w) {
    if (feedLists.length === 0 || feedLists.indexOf(w.el.parentElement) !== -1) {
      units.push({ el: w.el, kinds: w.kinds, strong: false });
    } else if (outsideFeed.length < 15) {
      outsideFeed.push({ slot: desc(w.el), foundBy: w.kinds,
        texts: uniq(textNodes(w.el, 40).map(function (n) { return short(n.nodeValue, 40); })).slice(0, 8) });
    }
  });
  units.sort(function (a, b) {
    return a.el === b.el ? 0 : (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  });

  // ---- 2. what the current sweep would do (PageScript logic, recomputed without writing) ----
  var path = location.pathname.toLowerCase().replace(/\/?$/, '/');
  var sweepActive = path === '/';
  var caughtUp = sweepActive ? (labelled(document.body, CAUGHT_UP_LABELS)
    .filter(function (el) { return !el.closest('article'); })[0] || null) : null;
  var articles = Array.prototype.slice.call(document.querySelectorAll('article'));
  var verdicts = new Map();   // article -> { hide, reasons }
  articles.forEach(function (article) {
    var reasons = [];
    if (sweepActive) {
      if (caughtUp && (caughtUp.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING)) { reasons.push('afterCaughtUp'); }
      if (labelled(article, AD_LABELS).length) { reasons.push('adLabel'); }
      if (labelled(article, SUGGESTED_LABELS).length) { reasons.push('suggestedLabel'); }
      if (adLinked(article)) { reasons.push('adLink'); }
      if (notFollowed(article)) { reasons.push('followButton'); }
    }
    verdicts.set(article, { hide: reasons.length > 0, reasons: reasons });
  });
  var trailing = 0;
  while (trailing < articles.length && verdicts.get(articles[articles.length - 1 - trailing]).hide) { trailing++; }
  var stop = sweepActive ? (caughtUp || (trailing >= MAX_TRAILING_HIDDEN ? articles[articles.length - trailing] : null)) : null;
  var stopSlot = stop && slotFor(stop);
  var afterStop = [];
  for (var sib = stopSlot && stopSlot.nextElementSibling; sib; sib = sib.nextElementSibling) { afterStop.push(sib); }
  var suggestedSlots = [];
  if (sweepActive) {
    labelled(document.body, SUGGESTED_LABELS).forEach(function (el) {
      if (el.closest('article')) { return; }
      var s = slotFor(el);
      if (s && suggestedSlots.indexOf(s) === -1) { suggestedSlots.push(s); }
    });
  }
  function predictedHidden(el) {
    if (el.tagName === 'ARTICLE' && verdicts.has(el) && verdicts.get(el).hide) { return 'article:' + verdicts.get(el).reasons.join('+'); }
    if (afterStop.indexOf(el) !== -1) { return 'afterStopPoint'; }
    if (suggestedSlots.indexOf(el) !== -1) { return 'suggestedBlockSlot'; }
    return null;
  }

  // Visible content left in a unit when subtrees for which gone(el) is truthy are skipped.
  function content(root, gone) {
    var out = { textChars: 0, media: 0 };
    (function walk(el) {
      if (gone(el)) { return; }
      if (/^(IMG|VIDEO|CANVAS|PICTURE)$/.test(el.tagName)) { out.media++; }
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) { out.textChars += n.nodeValue.replace(/\s+/g, '').length; }
        else if (n.nodeType === 1 && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(n.tagName)) { walk(n); }
      }
    })(root);
    return out;
  }
  function firstAncestor(el, test) {
    for (var n = el; n && n !== document.documentElement; n = n.parentElement) { var r = test(n); if (r) { return { el: n, why: r }; } }
    return null;
  }

  // ---- 3. per-unit report ----
  var json = scanJSON();
  var report = units.map(function (u, i) {
    var el = u.el;
    var arts = within(el, 'article');
    var buttons = within(el, BUTTONISH);
    var texts = textNodes(el, 0);
    var followTexts = texts.filter(function (n) { return /follow/i.test(n.nodeValue); });
    var authors = uniq(within(el, 'a[href]').map(profileOf).filter(Boolean));
    var codes = codesIn(el);
    var times = within(el, 'time').slice(0, 3).map(function (t) { return { datetime: t.getAttribute('datetime'), text: short(t.textContent, 30) }; });

    var actual = content(el, isGone);
    var ancGone = firstAncestor(el.parentElement, function (n) { return isGone(n) ? (n.hasAttribute('data-glance-hidden') ? 'data-glance-hidden' : 'display:none') : null; });
    var all = content(el, function () { return false; });
    var predictedAnc = firstAncestor(el, predictedHidden);
    var predicted = predictedAnc ? { textChars: 0, media: 0 } : content(el, predictedHidden);
    var isHidden = !!ancGone || (actual.textChars === 0 && actual.media === 0);
    var outsideArticles = arts.length ? content(el, function (n) { return n.tagName === 'ARTICLE'; }) : null;

    var flags = [];
    var prodHides = !!predictedAnc || (predicted.textChars === 0 && predicted.media === 0);
    if (!isHidden && arts.length === 0) { flags.push('H1: visible unit has no <article>; the sweep never looks at it'); }
    if (!isHidden && followTexts.length && !arts.some(notFollowed)) {
      flags.push('H2?: visible with follow-ish text, but notFollowed() matches no article (see followTexts)');
    }
    if (!isHidden && !followTexts.length && !buttons.some(function (b) { return /follow/i.test(b.getAttribute('aria-label') || ''); })) {
      flags.push('no Follow text at all (H3 if this account is not followed)');
    }
    if (arts.length && outsideArticles && (outsideArticles.textChars || outsideArticles.media)) {
      flags.push('content outside <article> stays visible when only the article is hidden');
    }
    if (sweepActive && prodHides !== isHidden) {
      flags.push(prodHides ? 'MISMATCH: sweep logic says hide, but it is visible' : 'MISMATCH: hidden, but sweep logic would not hide it now');
    }

    return {
      hidden: isHidden,
      unit: {
        foundBy: u.kinds,
        strong: u.strong,
        slot: Object.assign(desc(el), { childElements: el.children.length,
          parent: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
          siblings: el.parentElement ? el.parentElement.children.length : 0 }),
        isArticle: el.tagName === 'ARTICLE',
        articlesInside: arts.length,
        articleSlotFor: arts.map(function (a) {   // PageScript slotFor(article) vs this unit's slot (H4)
          var s = slotFor(a);
          return s === el ? 'same as unit slot' : !s ? 'null (reached <body>)' :
            s.contains(el) ? 'ANCESTOR of unit slot: ' + s.tagName.toLowerCase() + '@' + depth(s) :
            'inside unit slot: ' + s.tagName.toLowerCase() + '@' + depth(s);
        })
      },
      authors: authors,
      permalinks: codes,
      times: times,
      buttons: buttons.map(function (b) {
        var t = b.textContent.replace(/\s+/g, ' ').trim();
        return { tag: b.tagName.toLowerCase(), text: t.length <= 40 ? esc(t) : '(' + t.length + ' chars)', aria: b.getAttribute('aria-label') };
      }).filter(function (b) { return b.text || b.aria; }),
      followTexts: followTexts.slice(0, 10).map(function (n) {
        var parent = n.parentElement;
        var btn = parent && parent.closest(BUTTONISH);
        var click = parent && parent.closest(CLICKABLE);
        return {
          raw: esc(n.nodeValue),
          length: n.nodeValue.length,
          nonAscii: uniq((n.nodeValue.match(/[^\x20-\x7e]/g) || []).map(function (c) { return 'U+' + ('000' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-4); })),
          normalized: norm(n.nodeValue),
          matchesFOLLOW_LABELS: n.nodeValue.length <= 40 && FOLLOW_LABELS.indexOf(norm(n.nodeValue)) !== -1,
          parent: parent ? parent.tagName.toLowerCase() : null,
          parentDisplay: parent ? display(parent) : null,
          insideButton: !!(btn && el.contains(btn)),
          buttonText: btn ? esc(short(btn.textContent, 60)) : null,
          nearestClickable: click ? { tag: click.tagName.toLowerCase(), role: click.getAttribute('role'), tabindex: click.getAttribute('tabindex') } : null,
          insideArticle: !!(parent && parent.closest('article'))
        };
      }),
      followAria: within(el, '[aria-label],[title]').filter(function (n) {
        return /follow/i.test((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || ''));
      }).slice(0, 5).map(function (n) { return { tag: n.tagName.toLowerCase(), aria: n.getAttribute('aria-label'), title: n.getAttribute('title') }; }),
      labels: uniq(texts.filter(function (n) { return n.nodeValue.length <= 40 && LABEL_RE.test(n.nodeValue.trim()); })
        .map(function (n) { return esc(n.nodeValue.trim()); })),
      glance: {
        onSlot: el.hasAttribute('data-glance-hidden'),
        onAncestor: !!firstAncestor(el.parentElement, function (n) { return n.hasAttribute('data-glance-hidden'); }),
        inside: el.querySelectorAll('[data-glance-hidden]').length,
        slotDisplay: display(el),
        articleDisplay: arts.map(display),
        hiddenBy: ancGone ? { tag: ancGone.el.tagName.toLowerCase(), depth: depth(ancGone.el), why: ancGone.why } : null
      },
      content: { total: all, visibleNow: actual, outsideArticles: outsideArticles },
      sweepWouldDo: {
        articles: arts.map(function (a) { return verdicts.get(a); }),
        unitHiddenBy: predictedAnc ? predictedAnc.why : null,
        hidesUnit: sweepActive ? prodHides : 'sweep inactive on this path'
      },
      embeddedJson: codes.map(function (c) { return { code: c, inJson: json.codes.indexOf(c) !== -1, following: json.following[c] === undefined ? null : json.following[c] }; }),
      flags: flags
    };
  });

  // ---- 4. embedded JSON: is a positive "you follow this" signal on the page? (task 3b) ----
  function scanJSON() {
    var out = { scripts: 0, bytes: 0, friendship_status: 0, followingKey: 0, parsedOk: 0, samplePath: null, sample: null,
                codes: [], following: {}, nodesWalked: 0, truncated: false };
    var LIMIT = 2000000;
    Array.prototype.slice.call(document.querySelectorAll('script[type="application/json"]')).forEach(function (s) {
      var t = s.textContent || '';
      out.scripts++; out.bytes += t.length;
      out.friendship_status += (t.match(/friendship_status/g) || []).length;
      out.followingKey += (t.match(/"following"/g) || []).length;
      if (t.indexOf('friendship_status') === -1 && t.indexOf('"code"') === -1) { return; }
      var data; try { data = JSON.parse(t); out.parsedOk++; } catch (e) { return; }
      (function walk(node, p, code) {
        if (out.nodesWalked++ > LIMIT) { out.truncated = true; return; }
        if (!node || typeof node !== 'object') { return; }
        if (!Array.isArray(node) && typeof node.code === 'string' && /^[A-Za-z0-9_-]{5,}$/.test(node.code)) {
          code = node.code;
          if (out.codes.indexOf(code) === -1) { out.codes.push(code); }
        }
        if (!Array.isArray(node) && node.friendship_status && typeof node.friendship_status === 'object') {
          if (!out.samplePath) {
            out.samplePath = p + '.friendship_status';
            out.sample = {};
            Object.keys(node.friendship_status).slice(0, 12).forEach(function (k) {
              var v = node.friendship_status[k];
              if (v === null || typeof v !== 'object') { out.sample[k] = v; }
            });
          }
          if (code && typeof node.friendship_status.following === 'boolean' && out.following[code] === undefined) {
            out.following[code] = node.friendship_status.following;
          }
        }
        var keys = Object.keys(node);
        for (var k = 0; k < keys.length && !out.truncated; k++) {
          walk(node[keys[k]], p + (Array.isArray(node) ? '[' + keys[k] + ']' : '.' + keys[k]), code);
        }
      })(data, 'script', null);
    });
    if (out.samplePath && out.samplePath.length > 300) { out.samplePath = '…' + out.samplePath.slice(-300); }
    return out;
  }

  var hidden = [], visible = [], empty = [];
  report.forEach(function (r) {
    var isEmpty = r.content.total.textChars === 0 && r.content.total.media === 0;
    var list = isEmpty ? empty : r.hidden ? hidden : visible;
    delete r.hidden;
    list.push(Object.assign({ index: list.length + 1 }, r));
  });

  var result = {
    tool: 'glance diagnose-feed v1',
    when: new Date().toISOString(),
    href: location.href,
    lang: document.documentElement.lang || null,
    userAgent: navigator.userAgent,
    viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: window.scrollY },
    glanceInstalled: !!window.__glanceInstalled,
    glanceStylePresent: !!document.getElementById('glance-style'),
    glanceHiddenElements: document.querySelectorAll('[data-glance-hidden]').length,
    sweepActiveOnThisPath: sweepActive,
    warnings: [
      /^en\b/i.test(document.documentElement.lang || '') ? null : 'UI language is not English: label arrays and the /follow/i checks will miss',
      sweepActive ? null : 'not on the home feed (/): the sweep is inactive here',
      window.__glanceInstalled ? null : 'Glance script not installed (plain Safari?): hidden[] shows only what Instagram hides; read sweepWouldDo'
    ].filter(Boolean),
    counts: { units: units.length, visible: visible.length, hidden: hidden.length, empty: empty.length,
              articles: articles.length, articlesOutsideUnits: articles.filter(function (a) { return !units.some(function (u) { return u.el.contains(a); }); }).length,
              feedLists: feedLists.length },
    feedLists: feedLists.map(function (f) { return f ? Object.assign(desc(f), { children: f.children.length }) : null; }),
    caughtUpMarker: caughtUp ? { present: true, text: esc(short(caughtUp.textContent, 60)), slot: desc(slotFor(caughtUp)) } :
      { present: false, looseMatch: textNodes(document.body, 60).filter(function (n) { return /caught up/i.test(n.nodeValue); }).map(function (n) { return esc(n.nodeValue.trim()); }) },
    stopPoint: { by: !stop ? null : stop === caughtUp ? 'caughtUpMarker' : 'trailingHidden', trailingHiddenArticles: trailing,
                 stopSlot: desc(stopSlot), siblingsHiddenAfterStop: afterStop.length },
    suggestedBlockSlots: suggestedSlots.map(desc),
    embeddedJson: { scripts: json.scripts, bytes: json.bytes, parsedOk: json.parsedOk, friendship_status: json.friendship_status,
                    '"following"': json.followingKey, postCodesFound: json.codes.length,
                    codesWithFollowingFlag: Object.keys(json.following).length, samplePath: json.samplePath, sample: json.sample,
                    truncated: json.truncated },
    containersSkipped: containers,
    outsideFeed: outsideFeed,
    note: 'Text fields show non-ASCII as \\uXXXX (e.g. \\u00a0 NBSP, \\u2022 bullet). sweepWouldDo recomputes PageScript\'s current logic read-only.',
    visible: visible,
    hidden: hidden,
    empty: empty
  };
  try { if (typeof copy === 'function') { copy(JSON.stringify(result, null, 2)); console.log('Glance diagnostic copied to clipboard: ' + visible.length + ' visible, ' + hidden.length + ' hidden.'); } } catch (e) {}
  return result;
})();
