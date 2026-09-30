//
//  PageScript.swift
//  Socialite-Wrapper
//

import Foundation

/// JavaScript injected at document start into every Instagram page (main frame only).
///   1. Route guard: swallows taps on links to blocked pages and refuses pushState/replaceState to them,
///      reporting each to the app, which redirects (see WebViewModel's message handler).
///   2. Page cleaner: CSS hiding the Reels tab, plus a MutationObserver hiding sponsored/suggested posts
///      in the home feed. Keyed on hrefs, <article> and short label text, never Instagram's class names.
/// Path rules come from NavigationPolicy, so native and JS can't disagree.
enum PageScript {
    static let messageName = "glanceGuard"

    static var source: String {
        func list(_ items: [String]) -> String { "[" + items.map { "'\($0)'" }.joined(separator: ", ") + "]" }
        return #"""
        (function () {
          if (window.__glanceInstalled) { return; }
          window.__glanceInstalled = true;

          var BLOCKED_PREFIXES = \#(list(NavigationPolicy.blockedPrefixes.map(\.prefix)));
          var ALLOWED_EXACT = \#(list(NavigationPolicy.allowedExactPaths));
          var PROFILE_TABS = \#(list(NavigationPolicy.blockedProfileTabs));

          // Matched case-insensitively against whole short text nodes. Add your Instagram UI language's wording.
          var AD_LABELS = ['sponsored'];
          var SUGGESTED_LABELS = ['suggested for you', 'suggested posts'];
          var CAUGHT_UP_LABELS = ["you're all caught up", "you've completely caught up"];

          var CSS = [
            // Reels tab only (and its wrapper when the link is its only child), not /reels/<id>/ links
            // shared in DMs. Never drop the ">" in :has().
            'a[href="/reels/"], a[href$="instagram.com/reels/"], :has(> a[href="/reels/"]:only-child) { display: none !important; }',
            // "See all" suggested people. The Explore tab itself stays: it's redirected to search.
            'a[href^="/explore/people"] { display: none !important; }',
            '[data-glance-hidden] { display: none !important; }'
          ].join('\n');

          function post(payload) {
            try { window.webkit.messageHandlers.\#(messageName).postMessage(payload); } catch (e) {}
          }

          // ---- 1. Route guard ----

          function toURL(value) {
            try { return new URL(String(value), location.href); } catch (e) { return null; }
          }
          function normPath(path) {
            path = (path || '/').toLowerCase();
            return path.slice(-1) === '/' ? path : path + '/';
          }
          // Mirrors NavigationPolicy. Non-Instagram URLs cause a real page load, which the app decides.
          function isBlocked(url) {
            var host = url.hostname.toLowerCase();
            if (host !== 'instagram.com' && !/\.instagram\.com$/.test(host)) { return false; }
            var path = normPath(url.pathname);
            if (ALLOWED_EXACT.indexOf(path) !== -1) { return false; }
            for (var i = 0; i < BLOCKED_PREFIXES.length; i++) {
              if (path.indexOf(BLOCKED_PREFIXES[i]) === 0) { return true; }
            }
            var parts = path.split('/');   // "/user/reels/" -> ["", "user", "reels", ""]
            return parts.length === 4 && PROFILE_TABS.indexOf(parts[2]) !== -1;
          }

          // Capture phase on window runs before Instagram's own click handlers.
          window.addEventListener('click', function (event) {
            var anchor = (event.target && event.target.closest) ? event.target.closest('a[href]') : null;
            var url = anchor ? toURL(anchor.getAttribute('href')) : null;
            if (!url || !isBlocked(url)) { return; }
            event.preventDefault();
            event.stopImmediatePropagation();
            post({ type: 'click', url: url.href });
          }, true);

          // Back/forward and other address changes are caught natively (WebViewModel observes webView.url).
          function guarded(original, name) {
            return function (state, title, url) {
              var parsed = (url === undefined || url === null) ? null : toURL(url);
              if (parsed && isBlocked(parsed)) {
                post({ type: name, url: parsed.href });
                return undefined;
              }
              return original.apply(this, arguments);
            };
          }
          history.pushState = guarded(history.pushState, 'pushState');
          history.replaceState = guarded(history.replaceState, 'replaceState');

          // ---- 2. Page cleaner ----

          function ensureStyle() {   // re-added if Instagram's hydration removes it
            if (document.getElementById('glance-style')) { return; }
            var style = document.createElement('style');
            style.id = 'glance-style';
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
          }
          function norm(text) {
            return text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
          }
          // Elements holding a short text node equal to one of the labels (captions are too long to match).
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
          function setHidden(el, hide) {
            if (hide !== el.hasAttribute('data-glance-hidden')) { el.toggleAttribute('data-glance-hidden', hide); }
          }
          // Largest ancestor of el holding no <article>: the feed slot of a non-post block
          // (e.g. the "Suggested for you" people carousel). null if that would reach <body>.
          function slotFor(el) {
            var node = el;
            while (node.parentElement && node.parentElement !== document.body &&
                   !node.parentElement.querySelector('article')) {
              node = node.parentElement;
            }
            return (node.parentElement && node.parentElement !== document.body) ? node : null;
          }

          var hiddenSlots = [];   // suggested-block slots we hid; re-checked every sweep
          function sweep() {
            ensureStyle();
            // Profile Reels tab (/<user>/reels/): CSS can't match every username.
            var reelLinks = document.querySelectorAll('a[href$="/reels/"], a[href$="/reels"]');
            for (var k = 0; k < reelLinks.length; k++) {
              var linkURL = toURL(reelLinks[k].getAttribute('href'));
              setHidden(reelLinks[k], !!linkURL && isBlocked(linkURL));
            }
            if (!document.body || normPath(location.pathname) !== '/') { return; }   // feed cleaning: home only
            var caughtUp = labelled(document.body, CAUGHT_UP_LABELS)
              .filter(function (el) { return !el.closest('article'); })[0] || null;
            var articles = document.querySelectorAll('article');
            for (var i = 0; i < articles.length; i++) {
              var article = articles[i];
              var afterCaughtUp = caughtUp !== null &&
                (caughtUp.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
              // Re-evaluated every sweep, so a recycled <article> node is un-hidden when its content changes.
              setHidden(article, afterCaughtUp ||
                labelled(article, AD_LABELS).length > 0 ||
                labelled(article, SUGGESTED_LABELS).length > 0);
            }
            hiddenSlots = hiddenSlots.filter(function (slot) {
              var stillSuggested = slot.isConnected && !slot.querySelector('article') &&
                labelled(slot, SUGGESTED_LABELS).length > 0;
              if (!stillSuggested) { setHidden(slot, false); }
              return stillSuggested;
            });
            var blocks = labelled(document.body, SUGGESTED_LABELS);
            for (var j = 0; j < blocks.length; j++) {
              if (blocks[j].closest('article')) { continue; }
              var slot = slotFor(blocks[j]);
              if (slot && hiddenSlots.indexOf(slot) === -1) {
                setHidden(slot, true);
                hiddenSlots.push(slot);
              }
            }
          }

          var pending = false;
          function schedule() {   // at most one sweep per 150 ms; DOM reads only, no network
            if (pending) { return; }
            pending = true;
            setTimeout(function () { pending = false; sweep(); }, 150);
          }
          new MutationObserver(schedule).observe(document.documentElement,
            { childList: true, subtree: true, characterData: true });
          ensureStyle();
          schedule();
        })();
        """#
    }
}
