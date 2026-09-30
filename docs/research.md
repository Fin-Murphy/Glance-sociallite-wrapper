# Research: SocialLite-style Instagram wrapper

What this covers: how the reference repo is built, which Instagram URLs to block, and how to hide
ads and suggested posts. It ends with Swift + JS you can drop straight into the project (§4).

## 0. Read this first

### What was checked and what is a best guess

| Area | Status |
|---|---|
| Reference repo (§1): every file read at commit `d14b1fa` (2026-09-20) | **Checked.** The quoted code is the real code. |
| Drop-in code (§4): `URLPolicy.swift`, `PageScript.swift`, `WebModel.swift` | **Checked offline.** It type-checks against the iOS 17 simulator SDK (`swiftc -typecheck`). There are 25/25 URL-policy unit cases. The JS was run in jsdom against a mock feed: sponsored and suggested posts hidden, the people carousel hidden, posts after "all caught up" hidden, normal posts and stories kept, and a recycled node un-hidden. The pushState and click guards were also tested. |
| Instagram URL paths (§2) | **Best guess** from knowledge of instagram.com. I could not reach instagram.com from this sandbox (curl failed), and we can't log in anyway. |
| Instagram DOM: `<article>` per post, "Sponsored" / "Suggested for you" text, `href="/reels/"` tab link (§3) | **Best guess.** These have held up for years, but check them on a device with Safari Web Inspector before trusting them (§5). |

### ⚠️ Blocker in the current Xcode project

`Socialite-Wrapper.xcodeproj` is a **macOS** app at the moment: `SDKROOT = macosx`,
`MACOSX_DEPLOYMENT_TARGET = 26.2`. It is also the SwiftData template (`Item.swift`, `ModelContainer`).
iOS-only APIs (`UIRefreshControl`, `webView.scrollView`, `allowsInlineMediaPlayback`,
`UIApplication`) will not compile there.

**Recommended fix:** recreate the project as **iOS → App** (SwiftUI, Storage: None). The other option is
to change the target's platform to iOS: `SDKROOT = iphoneos`, `TARGETED_DEVICE_FAMILY = 1`,
`IPHONEOS_DEPLOYMENT_TARGET = 17.0`. In both cases, delete `Item.swift` and the SwiftData code in
`Socialite_WrapperApp.swift`. The reference repo targets iOS 17, which the two-parameter
`onChange(of:) { _, new in }` needs.

---

## 1. Reference repo: `twohertz/instagram-dm-only-for-ios-anti-doom-scrolling`

It is about 900 lines of Swift in 7 files and has no dependencies. It is a DM-only allowlist, the inverse of what we want.

| File | Role | Keep for us? |
|---|---|---|
| `URLPolicy.swift` | One list of rules shared by native code and JS. Returns `.allow / .block / .openExternally(URL)` | **Keep the shape, invert the rules** |
| `GuardScript.swift` | JS injected at document start: click guard, pushState/replaceState guard, 400 ms watchdog | **Keep, and add the feed cleaner** |
| `WebView.swift` | `WebModel`: WKWebView setup, navigation delegate, UI delegate, script message handler, rate-limited bounce | **Keep, simplified** |
| `ContentView.swift` | Edge-to-edge web view, error capsule, `scenePhase` → `appBecameActive()` | Keep |
| `Profile.swift`, `AccountSheet.swift`, `IGDMApp.swift` (SceneDelegate) | Multi-account support: one `WKWebsiteDataStore(forIdentifier:)` per account, Home Screen quick actions | **Drop** (out of scope) |

### 1.1 WKWebView configuration

```swift
let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = profile.dataStore   // .default() for single account → persistent cookies
configuration.applicationNameForUserAgent = Self.safariApplicationName
configuration.allowsInlineMediaPlayback = true
configuration.mediaTypesRequiringUserActionForPlayback = []
configuration.defaultWebpagePreferences.preferredContentMode = .mobile
...
webView.allowsBackForwardNavigationGestures = true
webView.allowsLinkPreview = false          // no long-press previews of blocked pages
#if DEBUG
webView.isInspectable = true               // Safari on the Mac -> Develop menu -> this app
#endif

/// Makes the user agent identical to Mobile Safari on this iOS version, so Instagram
/// does not treat the app as an "in-app browser".
private static var safariApplicationName: String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "Version/\(v.majorVersion).\(v.minorVersion) Mobile/15E148 Safari/604.1"
}
```

- **User agent:** it does not replace the UA (`customUserAgent`). It only appends Safari's suffix with
  `applicationNameForUserAgent`. The default WKWebView UA has no `Version/… Safari/…` part, and Instagram
  treats that as an in-app browser.
- **Data store:** `.default()` is persistent, so the login lasts across launches and reboots. Multi-account
  uses `WKWebsiteDataStore(forIdentifier:)` (iOS 17+). We don't need that.
- **Process pool:** it is **not set**. `WKProcessPool` has had no effect since iOS 15, so skip it.
- It creates **one web view for the life of the app** (`lazy var webView`), and `UIViewRepresentable`
  returns that same instance. SwiftUI re-renders don't recreate it, so the session is never lost.
- **Pull-to-refresh:** a `UIRefreshControl` on `webView.scrollView`. It reloads when the current page is
  allowed and goes home when it isn't.
- **Login detection:** a `WKHTTPCookieStoreObserver` looks for a non-empty `sessionid` cookie on
  `*.instagram.com`. It needs this only because DM-only has to allow `/` while logged out. **We allow `/`
  always, so we can drop it.**

### 1.2 Native navigation blocking (`decidePolicyFor`)

```swift
func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }

    // Embedded frames (iframes) cannot take over the screen, and Instagram's login uses some.
    if let frame = navigationAction.targetFrame, !frame.isMainFrame {
        decisionHandler(.allow)
        return
    }

    let userTapped = navigationAction.navigationType == .linkActivated
    let wantsNewWindow = navigationAction.targetFrame == nil
    let decision = URLPolicy.decision(for: url, allowLandingPage: !isLoggedIn)

    switch decision {
    case .allow:
        if userTapped || wantsNewWindow {
            // Load tapped links ourselves: a navigation the user starts could otherwise be handed
            // to the Instagram app (universal links) or ask for a new window we do not have.
            decisionHandler(.cancel)
            webView.load(navigationAction.request)
        } else {
            decisionHandler(.allow)
        }
    case .openExternally(let external):
        decisionHandler(.cancel)
        if userTapped || wantsNewWindow { openInSafari(external) } else { bounce(reason: ...) }
    case .block:
        decisionHandler(.cancel)
        if !userTapped {
            // Redirects, scripts, form submits, back/forward: the page on screen may now be stale or blank.
            bounce(reason: "navigation to \(url.path)")
        }
    }
}
```

`URLPolicy.decision` rules:
- `about:` and `blob:` → allow.
- Any scheme other than http(s) (`instagram://`, `itms-apps://`, `fb://`, `mailto:`) → block.
- `l.instagram.com/?u=<real>` is Instagram's outbound link wrapper. It is unwrapped and opened in Safari.
- Other `*.instagram.com` hosts (`help.`, `applink.`, …) → block.
- `apps.apple.com`, `itunes.apple.com` and `play.google.com` → always blocked. These are the "Open app" buttons.
- Other external sites → Safari.

Paths are normalized to end in `/`, so `/direct` and `/direct/` are treated the same.

**`bounce()` is rate-limited.** The 1st and 3rd bounce in 20 s go home. The 2nd goes to the login page. After
that it stops and shows "Pull down to retry". A redirect loop can never reload forever. Copy this idea.

It also handles **HTTP 429** in `decidePolicyFor navigationResponse`. Instagram sometimes answers the login
page with 429 while still serving `/`, which has the same form, so it falls back to `/`. We load `/` by
default, so this matters less, but keep the 429 notice.

### 1.3 SPA navigation (Instagram uses pushState, and `decidePolicyFor` never fires for it)

This is solved in JS (`GuardScript.swift`). The script is injected
`WKUserScript(source:, injectionTime: .atDocumentStart, forMainFrameOnly: true)` and reports back through
`window.webkit.messageHandlers.igdmGuard`. The allowed-path list is **generated from `URLPolicy`** by Swift
string interpolation, so JS and native can't drift apart. There are three layers:

```js
// 1. Click guard. Registered on window in the capture phase, so it runs before Instagram's handlers.
window.addEventListener('click', function (event) {
  var anchor = (target && target.closest) ? target.closest('a[href]') : null;
  ...
  if (!url || isAllowed(url)) { return; }
  event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation();
  post({ type: 'click', url: url.href });
}, true);

// 2. Route guard. Instagram moves between pages by rewriting the address bar; refuse blocked ones.
function guarded(original, name) {
  return function (state, title, url) {
    if (url !== undefined && url !== null) {
      var parsed = toURL(url);
      if (parsed && !isAllowed(parsed)) { post({ type: name, url: parsed.href }); return undefined; }
    }
    return original.apply(this, arguments);
  };
}
history.pushState = guarded(history.pushState, 'pushState');
history.replaceState = guarded(history.replaceState, 'replaceState');

// 3. Watchdog: popstate + a 400 ms poll of location.href, de-duplicated for 10 s.
window.addEventListener('popstate', check);
setInterval(check, 400);
```

On the native side, a `'click'` report needs nothing, because the tap was already swallowed. A
`pushState`/`replaceState`/`watch` report triggers `bounce()`. For pushState/replaceState it reloads the
current allowed page, because Instagram's router may already have drawn the blocked screen even though
the URL change was refused.

The message handler is wrapped in a `WeakMessageHandler`. `WKUserContentController` retains its handlers,
so without the wrapper you get a retain cycle.

### 1.4 Other points from the reference repo

- **Universal links:** if you `.allow` a tapped `instagram.com` link, iOS may open the **Instagram app**
  instead. The fix is to cancel and `webView.load(request)` it yourself (see §1.2).
- **`target=_blank` / `window.open`:** there's only one view. `createWebViewWith` loads allowed URLs in the
  same web view and `return nil`.
- **JS `alert`/`confirm`:** WKWebView drops these silently unless `WKUIDelegate` implements
  `runJavaScriptAlertPanelWithMessage` / `runJavaScriptConfirmPanelWithMessage`. The reference repo
  presents a `UIAlertController`. Keep this, because Instagram uses `confirm` in places.
- **File uploads and camera:** `<input type=file>` works in WKWebView with no code. It shows the system
  Photo Library / Take Photo / Choose File menu. **The app crashes on "Take Photo" unless Info.plist has the
  usage strings.** The reference repo sets them as build settings:
  ```
  INFOPLIST_KEY_NSCameraUsageDescription = "Used when you choose Take Photo or Video to send in a message.";
  INFOPLIST_KEY_NSMicrophoneUsageDescription = "Used when you record a video with sound to send in a message.";
  INFOPLIST_KEY_NSPhotoLibraryUsageDescription = "Used when you pick photos or videos to send in a message.";
  ```
  It does not implement `requestMediaCapturePermissionFor` (getUserMedia). Only add that if something like
  voice notes turns out to need it.
- **Login and 2FA:** these need `/accounts/login/`, `/accounts/onetap/`, `/accounts/password/`,
  `/challenge/` and `/auth_platform/`, plus iframes. We allow all of these for free because we use a
  blocklist.
- **Web content process crash:** `webViewWebContentProcessDidTerminate` → reload home. Without it you get a
  blank white screen.
- **Foregrounding:** on `scenePhase == .active`, if the current URL is blocked, go home.
- **Account safety.** This is the most important lesson in the reference repo. An earlier version polled
  Instagram's inbox API in the background for notifications, and **Instagram flagged the account for
  "automated activity"**. That feature was removed. **Never make Instagram requests on a timer or outside
  the user's taps.** Our MutationObserver only reads the DOM and makes no network calls, so it's safe.
- **Screen Time blockers:** blocker apps that add an `instagram.com` *website* rule also block WKWebViews
  inside other apps, including ours. Users must block the Instagram *app* only.
- **Debugging:** every decision is logged via `os.Logger` as `ALLOW/BLOCK/EXTERNAL/GUARD/BOUNCE`. Worth
  copying.

---

## 2. Instagram URL patterns

**Use a blocklist, not an allowlist.** Profiles live at top-level `/<username>/`, so they can't be
enumerated. Block the small set of reserved discovery prefixes and allow everything else on
`www.instagram.com`.

Everything in this section is best guess (see §0). Paths are compared **lowercased with a trailing `/`**.

### BLOCK

| Path | What it is | Notes |
|---|---|---|
| `/reels/` | Reels tab: the infinite vertical feed | The bottom-nav link is expected to be `href="/reels/"` |
| `/reels/<id>/`, `/reels/audio/<id>/` | Reels viewer. The URL is rewritten to the current reel as you swipe | Covered by the `/reels/` prefix |
| `/explore/` | Explore grid, which is also the "search" tab | **Redirect to `/explore/search/` instead of blocking** (see below) |
| `/explore/tags/<tag>/`, `/explore/locations/…` | Hashtag and location grids, which are discovery | `/explore/` prefix |
| `/explore/people/` (`/explore/people/suggested/`) | "Suggested for you" people list | `/explore/` prefix |
| `/explore/search/keyword/?q=…` | Keyword results grid, which is a mini-Explore | `/explore/` prefix. Only the exact `/explore/search/` is exempt |
| Non-http(s) schemes, `apps.apple.com` etc. | "Open in app" buttons | Same as the reference repo |

### ALLOW (everything not blocked)

| Path | What it is |
|---|---|
| `/` | Home feed. **Also try `/?variant=following`** (see below) |
| `/direct/inbox/`, `/direct/t/<thread>/`, `/direct/new/`, `/direct/requests/` | DMs |
| `/stories/<username>/<id>/`, `/stories/highlights/<id>/` | Stories |
| `/<username>/`, `/<username>/tagged/`, `/<username>/reels/` | Profiles |
| `/p/<shortcode>/` | Single post |
| `/reel/<shortcode>/`, `/tv/<shortcode>/` | Single reel or video (see edge case) |
| `/accounts/…` (`login/`, `onetap/`, `password/`, `edit/`, `activity/` = notifications) | Account, login and notifications |
| `/challenge/…`, `/auth_platform/…` | Security checks and 2FA |
| `/explore/search/` (exact) | Search box with recent searches and typeahead. No grid |
| `/create/…` | Posting flow on mobile web |

### Edge cases and recommendations

1. **`/reel/<id>/` opened from a DM or a feed post. Recommendation: ALLOW** (`allowSingleReels = true`).
   Friends send reels in DMs, and blocking those makes the app feel broken. The doom-scroll surface is the
   `/reels/` swipe feed, and that stays blocked. If swiping from a single reel leads into the feed, the
   URL becomes `/reels/<id>/` and the guard bounces it. Two things to check on the device:
   - (a) Does a DM-shared reel link point to `/reel/<id>/` (singular) or `/reels/<id>/`? If it's the plural
     form, shared reels will be blocked. In that case, allow `/reels/<id>/` only for `type == "click"` and
     keep blocking it for pushState/replaceState.
   - (b) Does `/reel/A/` → `/reel/B/` happen through replaceState with no tap, meaning chained autoplay? If
     so, block `/reel/` → `/reel/` replaceState in the JS guard.
2. **Search. Recommendation: KEEP it** by allowing exactly `/explore/search/` and redirecting `/explore/`
   → `/explore/search/`. The Explore tab icon then opens the search box instead of the grid. Keyword
   results (`/explore/search/keyword/`) and tag/location pages stay blocked. Tapping a *user* result goes to
   `/<username>/`, which is allowed. Risks to check:
   - `/explore/search/` might not render when loaded directly.
   - Instagram might replaceState it back to `/explore/`. The rate-limited bounce stops any loop, but
     search would then be unusable.
   If either happens, fall back to blocking `/explore/` completely and hiding the tab.
3. **`/<username>/reels/`** (a profile's reels tab). **Allow.** It's a finite, user-chosen grid. Tapping one
   opens `/reel/<id>/`.
4. **`/?variant=following`. Worth trying as the home URL.** Instagram web has a Following feed that is
   chronological and made only of followed accounts, reachable through the logo dropdown or this query
   param. If it works on mobile web, it removes most suggested posts at the source, and the DOM cleaner
   becomes a backup. *Unverified on mobile web.* If it works, make it `URLPolicy.homeURL`.
5. **Other `*.instagram.com` hosts** (`help.`, `about.`) are blocked in the main frame, as in the reference
   repo. You could change these to `.openExternally` if that's preferred.
6. **Case:** match lowercased. `URL.path` drops the trailing slash, so normalize (done in §4).

---

## 3. Hiding strategy (resilient to rotating class names)

**Never use Instagram's class names** (`x1lliihq …`). They are generated and change often. Only use:
- **`href` values:** `a[href="/reels/"]`, `a[href="/explore/"]`, `a[href^="/explore/people"]`. These are
  route-based and very stable.
- **Semantic tags:** each feed post has been an `<article>` for years.
- **Short visible text:** "Sponsored", "Suggested for you", "Suggested posts", "You're all caught up".
  Match whole short text nodes of 40 characters or fewer, never substrings, so captions that mention
  "sponsored" don't match. **This depends on the UI language.** Add the user's language to the label arrays.
- **`aria-label`:** use as a fallback if a tab has no text. Also language-dependent.

**CSS (injected by the script).** WebKit on iOS has supported `:has()` since 15.4.

```css
/* Reels tab, plus its wrapper when the link is the wrapper's only child (avoids an empty gap). */
a[href^="/reels/"], a[href*="instagram.com/reels/"], :has(> a[href^="/reels/"]:only-child) { display: none !important; }
/* "See all" suggested people */
a[href^="/explore/people"] { display: none !important; }
/* Anything the MutationObserver flags */
[data-sl-hidden] { display: none !important; }
```

The Explore/search tab (`a[href="/explore/"]`) is **not hidden**, because it's our route to search and
edge case 2 in §2 redirects it. If you drop search, add `a[href="/explore/"]` and its `:has(> …:only-child)` wrapper
to the CSS.

**Warning: never write `div:has(a[href="/reels/"])` without the `>`.** It matches every ancestor up to
`<body>` and hides the whole page.

**JS feed cleaner** (full code in §4, `PageScript.swift`, section 2):
- A `MutationObserver` on `document.documentElement` with `childList, subtree, characterData`. It's
  throttled to one sweep per 150 ms, and it only acts on the home feed (`/`).
- On each sweep, every `<article>` is **re-evaluated** and hidden (`data-sl-hidden`) when it contains a
  "Sponsored" or "Suggested for you" label, or comes after the "You're all caught up" marker in the
  document. After that marker, the feed is all "Suggested posts". Re-evaluating instead of doing it once
  matters because React can reuse an `<article>` node for a different post.
- Non-post blocks, such as the "Suggested for you" people carousel, are hidden at their **feed slot**. The
  slot is the largest ancestor of the label that contains no `<article>`, which makes it a sibling of the
  post slots. We never climb to `<body>`.
- The style tag is re-added if Instagram's hydration removes it.

**SPA route interception:** same three layers as the reference repo (§1.3), with the inverted rules. It
reports to native, and native decides:
- `.redirect(target)` → load target. This is the Explore tab → search.
- `.block` + `pushState`/`replaceState`/`watch` → rate-limited bounce to `/`.
- `.block` + `click` → nothing, because the tap was swallowed.

Bouncing to `/` is a full page load. That's heavier than an in-page route change, but it's reliable. The
click guard catches almost everything before a route change starts, so bounces should be rare.

**Known limits:**
- **Story ads** ("Sponsored" inside the stories viewer) are not handled. Auto-skipping would mean clicking
  Instagram's UI from script, which is fragile and borders on automation. Leave it.
- **Reels posted by followed accounts** still appear in the feed as normal posts. That's intended: the
  spec blocks the Reels *section*.
- **Virtualized feed:** if Instagram virtualizes the list and measures heights, `display:none` items could
  make scrolling jumpy. If that happens, switch to `height:1px; overflow:hidden; visibility:hidden`.
- **"Sponsored" split across several text nodes** (a Facebook anti-adblock trick) would defeat text
  matching. Instagram web wasn't known to do this, but check. Another tell for ads is a "Follow" button in
  the header of an account you don't follow.
- **Optional:** `WKContentRuleList` with `css-display-none` can apply the href-based CSS natively, before
  first paint. It can't do text matching, so the JS is still needed. It's not worth it for v1.

---
## 4. Drop-in code (checked: compiles for iOS 17; URL rules and JS tested offline)

Three files. They replace the reference repo's `URLPolicy`, `GuardScript` and `WebView.swift`, with
multi-account support, login-state tracking and logging removed. **Worth adding back from the reference
repo:**
- `os.Logger` lines
- the JS alert/confirm `WKUIDelegate` methods (§1.4)
- the 429 notice
- the `ProblemNotice` capsule in `ContentView`

`ContentView` needs `@StateObject var model = WebModel()`, then `WebView(model: model)` with
`.ignoresSafeArea(.container, edges: .bottom)`, and `.onChange(of: scenePhase) { _, p in if p == .active
{ model.appBecameActive() } }`.

### `URLPolicy.swift`

```swift
import Foundation

/// What the app may show. Blocklist: Instagram usernames are top-level paths ("/natgeo/"),
/// so profiles cannot be allow-listed; instead the few feed-of-strangers sections are blocked.
enum URLPolicy {

    enum Decision: Equatable {
        case allow
        case block                  // do nothing, or bounce home
        case redirect(URL)          // show this instead (Explore tab -> search)
        case openExternally(URL)    // hand to Safari
    }

    static let allowedHosts: [String] = ["www.instagram.com", "instagram.com"]

    /// Set false to also block single reels/videos opened from a DM, profile or feed post.
    static let allowSingleReels = true

    /// Matched against the lowercased path with a trailing "/".
    static var blockedPathPrefixes: [String] {
        ["/reels/",          // Reels tab and swipe viewer (/reels/, /reels/<id>/, /reels/audio/<id>/)
         "/explore/"]        // Explore grid, /explore/tags/, /explore/locations/, /explore/people/, keyword results
        + (allowSingleReels ? [] : ["/reel/", "/tv/"])
    }

    /// Exact paths allowed even though a blocked prefix matches.
    static let allowedExactPaths: [String] = ["/explore/search/"]

    /// Exact paths that are swapped for another page instead of blocked.
    static let redirects: [String: String] = ["/explore/": "/explore/search/"]

    static let openExternalLinksInSafari = true
    static let blockedExternalHosts: [String] = ["apps.apple.com", "itunes.apple.com", "play.google.com"]

    static let homeURL = URL(string: "https://www.instagram.com/")!

    static func decision(for url: URL) -> Decision {
        guard let scheme = url.scheme?.lowercased() else { return .block }
        if scheme == "about" || scheme == "blob" { return .allow }
        guard scheme == "https" || scheme == "http", let host = url.host?.lowercased() else { return .block }

        if host == "instagram.com" || host.hasSuffix(".instagram.com") {
            if host == "l.instagram.com" {
                // Outgoing links are wrapped as https://l.instagram.com/?u=<real link>
                guard let target = outboundTarget(of: url),
                      !blockedExternalHosts.contains(target.host?.lowercased() ?? "") else { return .block }
                return openExternalLinksInSafari ? .openExternally(target) : .block
            }
            guard allowedHosts.contains(host) else { return .block }
            let path = normalized(path: url.path)
            if let target = redirects[path] { return .redirect(URL(string: target, relativeTo: homeURL)!.absoluteURL) }
            return isBlocked(path: path) ? .block : .allow
        }

        if blockedExternalHosts.contains(host) { return .block }
        return openExternalLinksInSafari ? .openExternally(url) : .block
    }

    static func isBlocked(path: String) -> Bool {
        if allowedExactPaths.contains(path) { return false }
        return blockedPathPrefixes.contains(where: { path.hasPrefix($0) })
    }

    /// Lowercased, with a trailing "/" ("/Explore" -> "/explore/"). URL.path drops the trailing slash.
    static func normalized(path: String) -> String {
        var result = path.isEmpty ? "/" : path.lowercased()
        if !result.hasSuffix("/") { result += "/" }
        return result
    }

    private static func outboundTarget(of url: URL) -> URL? {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let raw = items.first(where: { $0.name == "u" })?.value,
              let target = URL(string: raw),
              let scheme = target.scheme?.lowercased(),
              scheme == "https" || scheme == "http"
        else { return nil }
        return target
    }
}
```

### `PageScript.swift`

```swift
import Foundation

/// JavaScript injected at document start into every Instagram page (main frame only).
///   1. Route guard: swallows taps on links to blocked pages and refuses pushState/replaceState to them,
///      reporting each to the app, which redirects or bounces home (see WebModel's message handler).
///   2. Page cleaner: CSS that hides the Reels tab, plus a MutationObserver that hides sponsored and
///      suggested posts in the home feed.
/// Path rules come from URLPolicy, so native and JS can never disagree.
enum PageScript {
    static let messageName = "slGuard"

    static var source: String {
        func list(_ items: [String]) -> String { "[" + items.map { "\"\($0)\"" }.joined(separator: ", ") + "]" }
        return """
        (function () {
          if (window.__slInstalled) { return; }
          window.__slInstalled = true;

          var HOSTS = \(list(URLPolicy.allowedHosts));
          var BLOCKED_PREFIXES = \(list(URLPolicy.blockedPathPrefixes));
          var ALLOWED_EXACT = \(list(URLPolicy.allowedExactPaths));

          // Matched case-insensitively against short text nodes. Add your Instagram UI language's wording.
          var AD_LABELS = ['sponsored'];
          var SUGGESTED_LABELS = ['suggested for you', 'suggested posts'];
          var CAUGHT_UP_LABELS = ["you're all caught up", "you've completely caught up"];

          var CSS = [
            // Reels tab (and its wrapper when the link is the wrapper's only child).
            'a[href^="/reels/"], a[href*="instagram.com/reels/"], :has(> a[href^="/reels/"]:only-child) { display: none !important; }',
            // "See all" suggested people.
            'a[href^="/explore/people"] { display: none !important; }',
            '[data-sl-hidden] { display: none !important; }'
          ].join('\\n');

          function post(payload) {
            try { window.webkit.messageHandlers.\(messageName).postMessage(payload); } catch (e) {}
          }

          // ---- 1. Route guard ----

          function toURL(value) {
            try { return new URL(String(value), location.href); } catch (e) { return null; }
          }
          function normPath(path) {
            path = (path || '/').toLowerCase();
            return path.slice(-1) === '/' ? path : path + '/';
          }
          // Non-Instagram URLs count as allowed here: they cause a real page load, which the app decides.
          function isAllowed(url) {
            if (url.protocol !== 'https:' && url.protocol !== 'http:') { return true; }
            if (HOSTS.indexOf(url.hostname.toLowerCase()) === -1) { return true; }
            var path = normPath(url.pathname);
            if (ALLOWED_EXACT.indexOf(path) !== -1) { return true; }
            for (var i = 0; i < BLOCKED_PREFIXES.length; i++) {
              if (path.indexOf(BLOCKED_PREFIXES[i]) === 0) { return false; }
            }
            return true;
          }

          // Capture phase on window runs before Instagram's own click handlers.
          window.addEventListener('click', function (event) {
            var anchor = (event.target && event.target.closest) ? event.target.closest('a[href]') : null;
            if (!anchor) { return; }
            var url = toURL(anchor.getAttribute('href'));
            if (!url || isAllowed(url)) { return; }
            event.preventDefault();
            event.stopImmediatePropagation();
            post({ type: 'click', url: url.href });
          }, true);

          function guarded(original, name) {
            return function (state, title, url) {
              if (url !== undefined && url !== null) {
                var parsed = toURL(url);
                if (parsed && !isAllowed(parsed)) {
                  post({ type: name, url: parsed.href });
                  return undefined;
                }
              }
              return original.apply(this, arguments);
            };
          }
          history.pushState = guarded(history.pushState, 'pushState');
          history.replaceState = guarded(history.replaceState, 'replaceState');

          var lastReport = { url: null, time: 0 };
          function watch() {
            var url = toURL(location.href);
            if (!url || isAllowed(url)) { return; }
            var now = Date.now();
            if (lastReport.url === url.href && now - lastReport.time < 10000) { return; }
            lastReport = { url: url.href, time: now };
            post({ type: 'watch', url: url.href });
          }
          window.addEventListener('popstate', watch);
          setInterval(watch, 400);

          // ---- 2. Page cleaner ----

          function ensureStyle() {
            if (document.getElementById('sl-style')) { return; }
            var style = document.createElement('style');
            style.id = 'sl-style';
            style.textContent = CSS;
            (document.head || document.documentElement).appendChild(style);
          }
          function norm(text) {
            return text.replace(/[\\u2018\\u2019]/g, "'").replace(/\\s+/g, ' ').trim().toLowerCase();
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
            if (hide && !el.hasAttribute('data-sl-hidden')) { el.setAttribute('data-sl-hidden', ''); }
            if (!hide && el.hasAttribute('data-sl-hidden')) { el.removeAttribute('data-sl-hidden'); }
          }
          // Largest ancestor of el that holds no <article>: the feed slot of a non-post block
          // (e.g. the "Suggested for you" people carousel). null if that would reach <body>.
          function slotFor(el) {
            var node = el;
            while (node.parentElement && node.parentElement !== document.body &&
                   !node.parentElement.querySelector('article')) {
              node = node.parentElement;
            }
            return (node.parentElement && node.parentElement !== document.body) ? node : null;
          }

          function sweep() {
            ensureStyle();
            if (!document.body || normPath(location.pathname) !== '/') { return; }   // home feed only
            var caughtUp = labelled(document.body, CAUGHT_UP_LABELS)[0] || null;
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
            var blocks = labelled(document.body, SUGGESTED_LABELS);
            for (var j = 0; j < blocks.length; j++) {
              if (blocks[j].closest('article')) { continue; }
              var slot = slotFor(blocks[j]);
              if (slot) { setHidden(slot, true); }
            }
          }

          var pending = false;
          function schedule() {
            if (pending) { return; }
            pending = true;
            setTimeout(function () { pending = false; sweep(); }, 150);
          }
          new MutationObserver(schedule).observe(document.documentElement,
            { childList: true, subtree: true, characterData: true });
          ensureStyle();
          schedule();
        })();
        """
    }
}
```

### `WebModel.swift`

```swift
import SwiftUI
import WebKit

/// Owns the app's single WKWebView, decides which page loads are allowed, and acts on reports
/// from the injected PageScript.
final class WebModel: NSObject, ObservableObject {

    /// Created once and kept for the life of the app, so the login session is never thrown away.
    private(set) lazy var webView: WKWebView = makeWebView()

    private var recentBounces: [Date] = []

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()          // persistent cookies: login survives relaunch
        configuration.applicationNameForUserAgent = Self.safariApplicationName
        configuration.allowsInlineMediaPlayback = true       // otherwise videos jump to fullscreen
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile

        let userContent = configuration.userContentController
        userContent.add(WeakMessageHandler(self), name: PageScript.messageName)
        userContent.addUserScript(WKUserScript(source: PageScript.source,
                                               injectionTime: .atDocumentStart,
                                               forMainFrameOnly: true))

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false                    // no long-press previews of blocked pages
        #if DEBUG
        webView.isInspectable = true                         // Mac Safari -> Develop -> <iPhone> -> this app
        #endif

        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pulledToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        webView.load(URLRequest(url: URLPolicy.homeURL))
        return webView
    }

    /// Mobile Safari's user-agent suffix, so Instagram does not treat the app as an in-app browser.
    private static var safariApplicationName: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "Version/\(v.majorVersion).\(v.minorVersion) Mobile/15E148 Safari/604.1"
    }

    func goHome() {
        webView.load(URLRequest(url: URLPolicy.homeURL))
    }

    /// Call from ContentView when scenePhase becomes .active.
    func appBecameActive() {
        if let url = webView.url, URLPolicy.decision(for: url) != .allow { goHome() }
    }

    @objc private func pulledToRefresh(_ control: UIRefreshControl) {
        control.endRefreshing()
        if let url = webView.url, URLPolicy.decision(for: url) == .allow { webView.reload() } else { goHome() }
    }

    /// Back to the feed after something reached a blocked page. At most 3 per 20 s, so a redirect
    /// loop can never reload forever.
    private func bounce() {
        let now = Date()
        recentBounces = recentBounces.filter { now.timeIntervalSince($0) < 20 } + [now]
        if recentBounces.count <= 3 { goHome() }
    }
}

extension WebModel: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }

        // Iframes cannot take over the screen, and Instagram's login uses some.
        if let frame = navigationAction.targetFrame, !frame.isMainFrame {
            decisionHandler(.allow)
            return
        }

        let userTapped = navigationAction.navigationType == .linkActivated
        let wantsNewWindow = navigationAction.targetFrame == nil

        switch URLPolicy.decision(for: url) {
        case .allow:
            if userTapped || wantsNewWindow {
                // Load it ourselves: allowing a tapped instagram.com link lets iOS hand it to the
                // Instagram app (universal link), and target=_blank has no window to open in.
                decisionHandler(.cancel)
                webView.load(navigationAction.request)
            } else {
                decisionHandler(.allow)
            }
        case .redirect(let target):
            decisionHandler(.cancel)
            webView.load(URLRequest(url: target))
        case .openExternally(let external):
            decisionHandler(.cancel)
            if userTapped || wantsNewWindow { UIApplication.shared.open(external) } else { bounce() }
        case .block:
            decisionHandler(.cancel)
            if !userTapped { bounce() }   // redirect/script/back-forward: the page may now be blank or stale
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        goHome()
    }
}

extension WebModel: WKUIDelegate {
    /// target=_blank / window.open: there is only one view, so allowed pages open in it.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            switch URLPolicy.decision(for: url) {
            case .allow: webView.load(navigationAction.request)
            case .redirect(let target): webView.load(URLRequest(url: target))
            case .openExternally(let external): UIApplication.shared.open(external)
            case .block: break
            }
        }
        return nil
    }
}

extension WebModel: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String,
              let urlString = body["url"] as? String,
              let url = URL(string: urlString) else { return }

        switch URLPolicy.decision(for: url) {
        case .allow, .openExternally:
            return
        case .redirect(let target):
            webView.load(URLRequest(url: target))
        case .block:
            // A swallowed tap needs nothing. A refused pushState/replaceState or a blocked address seen by the
            // watchdog means Instagram may already be drawing the blocked screen.
            if type != "click" { bounce() }
        }
    }
}

/// WKUserContentController retains its handlers; this avoids a retain cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

struct WebView: UIViewRepresentable {
    let model: WebModel
    func makeUIView(context: Context) -> WKWebView { model.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
```

Also: add the three `INFOPLIST_KEY_NS…UsageDescription` build settings from §1.4, and set portrait-only if
you like (`INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = UIInterfaceOrientationPortrait`).

---

## 5. Checks to do on a device (about 15 minutes, the first time you run it)

1. Run a Debug build on the iPhone. On the Mac, open Safari → Develop → *iPhone* → the app's page
   (`isInspectable` is on in DEBUG). Log in.
2. **Nav links.** In the console, run:
   ```js
   [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href') + ' | ' + (a.getAttribute('aria-label') || a.textContent.trim()).slice(0, 30)).filter(s => !/^\/[^/]+\/ \|/.test(s))
   ```
   Confirm the Reels tab is `/reels/` and the Explore/search tab is `/explore/`. Confirm the Reels tab is
   hidden and nothing else disappeared. If the tab bar has a gap, adjust the `:has(> …:only-child)` rule.
3. **Feed labels.** Scroll until an ad appears, then run
   `[...document.querySelectorAll('article')].map(a => a.hasAttribute('data-sl-hidden'))`. Find "Sponsored"
   in the Elements panel and check that it is a single text node in an `<article>`. Do the same for
   "Suggested for you" and "You're all caught up". Copy the exact wording (including the apostrophe) into
   the label arrays.
4. **Routes:**
   - Tap Explore/search. It should land on `/explore/search/` and searching a user should open the profile.
   - Try `location.href = '/reels/'` in the console. It should bounce to `/`.
   - Open a reel someone sent in a DM and check whether its URL is `/reel/` or `/reels/` (edge case 1).
   - Swipe back from a profile to the feed.
5. **Try `/?variant=following`** as the home URL (edge case 4).
6. **Uploads:** DM → photo → Take Photo. It should ask for the camera, not crash.
7. **Login:** log out, log in with 2FA, relaunch the app, and check you're still logged in.
8. **External link in a DM:** it should open in Safari. An "Open app" button should do nothing.
