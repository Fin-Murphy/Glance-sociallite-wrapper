# Glance (Socialite-Wrapper)

An iOS app that shows Instagram's mobile website (`https://www.instagram.com/`) in a `WKWebView` and filters it, both natively and with injected JavaScript. It keeps the home feed, DMs, stories, profiles, single posts and search. It blocks Reels, Explore, ads, and posts from accounts you don't follow.

- **Stack:** Swift 5 · SwiftUI · WebKit. No third-party dependencies, no backend, no API keys.
- **Target:** iPhone, iOS 17.0+, portrait. Built with Xcode 26.
- **Distribution:** installed from Xcode onto a personal device. Not intended for the App Store.
- **Auth:** the user logs in on Instagram's own web login page. The session lives in WebKit's persistent cookie store on the device (`WKWebsiteDataStore.default()`), as it does in Safari.

---

## Contents

- [Repository layout](#repository-layout)
- [Building, running and installing](#building-running-and-installing)
- [Architecture](#architecture)
  - [Enforcement layers](#enforcement-layers)
  - [NavigationPolicy](#navigationpolicy)
  - [WebViewModel](#webviewmodel)
  - [PageScript](#pagescript)
  - [ContentView](#contentview)
- [URL rules](#url-rules)
- [Feed filtering](#feed-filtering)
- [Testing](#testing)
- [Build configuration](#build-configuration)
- [Maintenance](#maintenance)
- [Known limitations](#known-limitations)

---

## Repository layout

```
Socialite-Wrapper/
├── Socialite-Wrapper/               App target (display name "Glance")
│   ├── Socialite_WrapperApp.swift   @main App: a single WindowGroup { ContentView() }
│   ├── ContentView.swift            SwiftUI shell, loading/error/toast states, WKWebView representable
│   ├── WebViewModel.swift           NavigationPolicy (URL rules) + WebViewModel (WKWebView owner and delegates)
│   ├── PageScript.swift             JavaScript injected at document start (route guard + feed cleaner)
│   └── Assets.xcassets              AppIcon (single 1024 universal), AccentColor (#2F7A66 / dark #7CC7B0)
├── Socialite-WrapperTests/          Swift Testing unit tests (URL policy, Info.plist)
├── Socialite-WrapperUITests/        Launch/screenshot UI test
├── scripts/verify.sh                Build + test + archive + signature check
├── docs/
│   ├── design.md                    UI spec (colors, states, copy, icon)
│   ├── research.md                  Reference-repo analysis, Instagram URL patterns, hiding strategy
│   ├── research-following.md       Following-only feed research (Follow-button signal, ad labels)
│   └── AppIcon-1024.png             Source icon
├── sociallite-clone-plan.md         Original project spec
└── CLAUDE.md                        Guidance for AI coding agents
```

The Xcode project uses **file-system-synchronized groups** (`PBXFileSystemSynchronizedRootGroup`). Any file added under `Socialite-Wrapper/` joins the target automatically, so there's no need to edit `project.pbxproj`.

---

## Building, running and installing

### Simulator

```sh
xcodebuild -scheme Socialite-Wrapper \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

Or open `Socialite-Wrapper.xcodeproj` and run the `Socialite-Wrapper` scheme.

### Device (sideloading)

1. Open the project in Xcode. Signing is **Automatic** with `DEVELOPMENT_TEAM = 72D3CDCYDY`. To use another team, change it under *Signing & Capabilities* on all three targets.
2. Enable Developer Mode on the iPhone, connect it, select it as the run destination, and press Run.
3. How long the install lasts depends on the team type:

   | Team type | Profile lifetime |
   |---|---|
   | Free Apple ID (Personal Team) | 7 days; re-run from Xcode to re-sign |
   | Paid Apple Developer Program | 1 year |

### Archive

```sh
xcodebuild -scheme Socialite-Wrapper -destination 'generic/platform=iOS' \
  -archivePath build/Glance.xcarchive archive
```

The archive is signed with the team's *Apple Development* identity. With automatic signing, the team's wildcard development profile (`<TEAM>.*`) covers it, because the app has no special entitlements. Archiving fails with *"Signing for 'Socialite-Wrapper' requires a development team"* if `DEVELOPMENT_TEAM` is missing.

Never pass `-allowProvisioningUpdates` from scripts: it registers App IDs and devices on the Apple account.

---

## Architecture

### Enforcement layers

Instagram's website is a single-page app (SPA). Tab switches and most in-app navigation use `history.pushState` and never reach `WKNavigationDelegate`. So blocking is enforced in several places, and all of them get their rules from **one** Swift type:

```
                    ┌──────────────────────────────┐
                    │ NavigationPolicy (Swift)     │  single source of truth
                    │   blockedPrefixes            │
                    │   allowedExactPaths          │
                    │   blockedProfileTabs, home   │
                    └───────┬──────────────┬───────┘
          decision(for:)    │              │  string-interpolated into JS
                            ▼              ▼
┌───────────────────────────────────┐  ┌──────────────────────────────────────┐
│ WebViewModel (native)             │  │ PageScript (JS, document start)      │
│ • decidePolicyFor: real loads     │◀─│ • click guard (capture phase)        │
│ • KVO on webView.url: SPA changes,│  │ • pushState/replaceState wrappers    │
│   back/forward, popstate          │  │   → postMessage("glanceGuard")       │
│ • createWebViewWith: _blank links │  │ • CSS + MutationObserver cleaner     │
│ • scenePhase .active re-check     │  └──────────────────────────────────────┘
│ • rate-limited redirect()         │
└───────────────┬───────────────────┘
                │ @Observable: blockedSection, hasLoaded, loadFailed
                ▼
┌───────────────────────────────────┐
│ ContentView (SwiftUI)             │
│ spinner · error view · toast      │
└───────────────────────────────────┘
```

### NavigationPolicy

`enum NavigationPolicy` (at the top of `WebViewModel.swift`) is a pure, unit-tested function from a URL to a decision:

```swift
enum Decision: Equatable {
    case allow
    case redirect(URL, BlockedSection)  // blocked section: load this instead, show a toast
    case openExternally(URL)            // hand to the system (Safari, Mail, Phone)
    case deny                           // silently ignore
}
```

How it evaluates a URL:

1. `about:`, `blob:` and `data:` → `.allow`. `mailto:` and `tel:` → `.openExternally`. Any other non-HTTP(S) scheme, such as `instagram://`, → `.deny`.
2. **Link shim:** `l.instagram.com/?u=<target>` is unwrapped, and the policy is applied again to the real target.
3. Hosts other than `instagram.com` and `*.instagram.com`:
   - `.deny` for app-store hosts (`apps.apple.com`, `itunes.apple.com`, `play.google.com`), so "Open in app" banners do nothing.
   - `.openExternally` for everything else.
4. The path is lowercased and a trailing `/` is added. Then:
   - `allowedExactPaths` (e.g. `/explore/search/`) → `.allow`.
   - The first matching `blockedPrefixes` entry → `.redirect(target, section)`.
   - A two-segment path whose second segment is in `blockedProfileTabs` (`/<user>/reels/`) → redirect to `/<user>/`.
   - Anything else → `.allow`.

It is a **blocklist**. Profiles live at top-level `/<username>/`, so an allowlist can't list them. Everything that isn't a known discovery surface is allowed, including login, 2FA (`/accounts/`, `/challenge/`, `/auth_platform/`) and `accountscenter.instagram.com`.

### WebViewModel

`@Observable final class WebViewModel: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler` owns a single `WKWebView` for the life of the app.

**WebView configuration:**

| Setting | Value | Reason |
|---|---|---|
| `websiteDataStore` | `.default()` | Persistent cookies: login survives relaunches |
| `applicationNameForUserAgent` | `Version/<iOS> Mobile/15E148 Safari/604.1` | Looks like Mobile Safari, so Instagram doesn't treat it as an in-app browser |
| `WKUserScript` | `PageScript.source`, `.atDocumentStart`, main frame only | Guard and cleaner run before Instagram's JS |
| `allowsInlineMediaPlayback` | `true` | Videos play in the feed, not fullscreen. Autoplay stays at the WebKit default (a tap is needed) |
| `allowsBackForwardNavigationGestures` | `true` | Edge swipe for back and forward |
| `allowsLinkPreview` | `false` | Long-press previews would render blocked pages |
| `isInspectable` | `true` in `DEBUG` only | Safari Web Inspector: *Develop → device → Glance* |
| `isOpaque = false`, background colors = `.systemBackground` | | No white flash before first paint in dark mode |

**Navigation handling:**

- **`decidePolicyFor`** only checks main-frame navigations. Subframes such as login iframes and subresources always load.
  - `.allow` for a **user tap**: the app cancels the navigation and calls `webView.load(request)` itself. If a tapped `instagram.com` link were simply allowed, iOS could hand it to the Instagram app as a universal link.
  - `.openExternally` only opens a URL when the user tapped it or it came from a new-window request. Navigations to other sites started by a script or redirect are cancelled.
- **KVO on `webView.url`** catches route changes the JS guard can't see (back/forward, popstate, Instagram-internal changes) and redirects if the new URL is blocked.
- **`WKScriptMessageHandler`** (`"glanceGuard"`) receives `{type, url}` from the JS guard, where `type` is `click`, `pushState` or `replaceState`.
- **`createWebViewWith`** handles `target=_blank` and `window.open`. The app has only one view, so allowed URLs load in place and `nil` is returned.
- **`appBecameActive()`**, called on `scenePhase == .active`, re-checks the current URL, so the app never resumes on a blocked page.
- **`webViewWebContentProcessDidTerminate`** reloads `home`. Otherwise a crashed WebContent process leaves a blank view.

**Redirect rate limit:** `redirect(to:showing:limited:)` sets `blockedSection` for the toast and loads the target. Redirects the user didn't start by tapping (from KVO, pushState/replaceState, script navigations or scene activation) are limited to **3 per 20 s**. That stops a redirect loop if Instagram fights a redirect. Tap redirects are never limited. Every redirect target is itself an allowed URL, so the policy can't loop on its own.

**Error handling:** `didFail` and `didFailProvisionalNavigation` set `loadFailed`, except for `NSURLErrorCancelled` (-999) and `WebKitErrorDomain` 102 (frame load interrupted by a policy change), which the app's own cancellations produce. `didStartProvisionalNavigation` clears the flag.

**JS dialogs:** `alert()` and `confirm()` are shown as `UIAlertController` on the topmost presented view controller. WKWebView drops them silently otherwise, and Instagram uses `confirm()`.

### PageScript

`enum PageScript` builds the injected JavaScript as a Swift raw string. The `BLOCKED_PREFIXES`, `ALLOWED_EXACT` and `PROFILE_TABS` arrays and the message-handler name are **interpolated from `NavigationPolicy`**, so the native and JS rules can't drift apart. The script has an idempotence guard (`window.__glanceInstalled`) and two parts.

**1. Route guard**

- A `click` listener on `window` in the **capture phase** runs before Instagram's React handlers. If the nearest `a[href]` resolves to a blocked URL, it calls `preventDefault()` and `stopImmediatePropagation()`, then posts `{type: "click"}`.
- `history.pushState` and `history.replaceState` are wrapped. A call whose URL is blocked is dropped (the original is never called) and reported to native.
- `isBlocked()` mirrors `NavigationPolicy`'s rules: host check, exact allowlist, prefix blocklist, and the two-segment profile tab. Non-Instagram URLs are left alone for native code to handle.

**2. Page cleaner**

- **CSS**, re-inserted if Instagram's hydration removes it:
  - `a[href="/reels/"]` and its wrapper, via `:has(> a[href="/reels/"]:only-child)`, which hides the Reels tab. The match is exact on purpose: a `^=` prefix would also hide `/reels/<id>/` links shared in DMs.
  - `a[href^="/explore/people"]`, the suggested-people links.
  - `[data-glance-hidden] { display: none !important; }`. Everything the sweep hides is hidden through this attribute.
- **Sweep**: a `MutationObserver` on `document.documentElement` (`childList`, `subtree`, `characterData`), throttled to one run per 150 ms. It only reads and changes the DOM; it never makes network requests. Details are in [Feed filtering](#feed-filtering).

**Selector rules.** The script never uses Instagram's generated class names (`x1lliihq…`), which change often. It only uses:

- route `href`s
- the `<article>` element, which wraps each feed post
- `button` / `[role=button]`
- **whole short text nodes** (≤ 40 characters, normalised for whitespace and curly quotes, case-insensitive). Captions are longer text nodes and don't match.

### ContentView

A `ZStack` with these layers:

1. `Color(.systemBackground)`, extended under the safe areas.
2. `WebView`, a thin `UIViewRepresentable` returning the model's `WKWebView`. It stays inside the safe area.
3. A `ProgressView` with the accent tint until the first `didFinish`, then a 0.25 s fade.
4. On `loadFailed`, a `ContentUnavailableView` ("Can't reach Instagram", `wifi.slash`) with a *Try Again* button that calls `model.retry()`.

A top overlay shows the **blocked-section toast**: a `.ultraThinMaterial` capsule with the `leaf` symbol. It ignores hit testing and clears itself after 2 s via `.task(id: blockedSection)`.

| Section | Copy |
|---|---|
| `.reels` | "Reels are switched off. Back to your feed." |
| `.profileReels` | "Reels are switched off." |
| `.explore` | "Explore is switched off. Search is still here." |

Pull-to-refresh is deliberately not implemented.

---

## URL rules

Paths are compared lowercased with a trailing `/`.

| URL / path | Decision |
|---|---|
| `/`, `/?variant=following` | allow (home feed) |
| `/direct/…`, `/stories/…`, `/<user>/`, `/<user>/tagged/`, `/p/<id>/` | allow |
| `/reel/<id>/` (single reel, e.g. shared in a DM) | allow |
| `/reels/`, `/reels/<id>/`, `/reels/audio/…` | redirect → `/` (`.reels`) |
| `/<user>/reels/` | redirect → `/<user>/` (`.profileReels`) |
| `/explore/search/` (exact) | allow |
| `/explore/`, `/explore/tags/…`, `/explore/locations/…`, `/explore/people/…`, `/explore/search/keyword/…` | redirect → `/explore/search/` (`.explore`) |
| `/accounts/…`, `/challenge/…`, `/auth_platform/…`, `*.instagram.com` | allow |
| `l.instagram.com/?u=<x>` | policy re-applied to `<x>` |
| other `http(s)` hosts | open externally (user tap / new window only) |
| `mailto:`, `tel:` | open externally |
| `instagram://…`, app-store hosts | deny |

To change a rule, edit the arrays at the top of `NavigationPolicy` and update `NavigationPolicyTests`. The JS picks up the change automatically.

**Home URL:** `NavigationPolicy.home` is `https://www.instagram.com/`. The Following feed (`/?variant=following`) is left as a commented alternative, because it reportedly has no stories row. Following-only filtering is done by the feed cleaner instead.

---

## Feed filtering

Feed filtering only runs when `location.pathname` normalises to `/`.

**Per-post rules.** Each `<article>` is re-checked on every sweep, so React-recycled nodes get un-hidden when their content changes. A post is hidden if any of these is true:

| Condition | Signal |
|---|---|
| Ad label | Short text node `sponsored` or `ad` |
| Suggestion label | `suggested for you`, `suggested posts` |
| Ad link | `a[href*="/ads/ig_redirect"]` or `a[href*="a_mpk="]` |
| **Not followed** | Text `follow` / `follow back` **inside a `button` or `[role=button]`** within the article. Instagram only shows this button on posts from accounts you don't follow. A caption or comment saying "Follow" doesn't match. |
| After caught-up | The post comes after the "You're all caught up" marker in document order |

**Non-post blocks.** Blocks such as the "Suggested for you" people carousel are hidden at their **feed slot**. `slotFor(el)` finds the largest ancestor that contains no `<article>` other than `el` itself. Hidden slots are tracked in `hiddenSlots` and re-checked on every sweep. A slot is un-hidden if it now contains an `<article>`, has lost its label, or has left the DOM.

**Stop point.** This part exists for account safety. Hidden posts have zero height, so Instagram's infinite-scroll sentinel would stay on screen and keep fetching pages of suggestions without the user scrolling. Traffic like that could look automated. The sweep therefore picks a stop point:

- the "You're all caught up" marker, ignoring matches inside an `<article>`, **or**
- if there's no marker, the first post of a trailing run of at least `MAX_TRAILING_HIDDEN` (10) hidden posts.

Every `nextElementSibling` of the stop point's slot is then hidden, including the sentinel and spinner. The hidden siblings are tracked in `hiddenAfterStop` and released if the stop point moves or disappears. For example, if a followed post appears after the run, the run is no longer trailing.

**Profile Reels tab.** CSS can't match "any username", so the sweep hides `a` elements whose `href` ends in `/reels` or `/reels/` and which `isBlocked()` rejects.

---

## Testing

### Unit tests

The unit tests use Swift Testing. They're in `Socialite-WrapperTests/`, run inside the host app, and use `@testable import Socialite_Wrapper`.

| Suite | Covers |
|---|---|
| `NavigationPolicyTests.allowed` | Feed, DMs, stories, profiles, posts, single reels, lookalike usernames (`/reelsfan/`), `/stories/<u>/reels/`, search, login, `accountscenter`, link shim to Instagram |
| `NavigationPolicyTests.redirected` | Reels (including uppercase and no trailing slash), Explore and sub-routes → search, profile Reels tab → profile |
| `NavigationPolicyTests.external` | Other hosts, lookalike host `notinstagram.com`, link shim to an outside site, `mailto:`, `tel:` |
| `NavigationPolicyTests.denied` | `instagram://`, App Store, link shim to App Store |
| `AppBundleTests` | `CFBundleDisplayName == "Glance"`, and the camera, microphone and photo-library usage strings are present. Without them, "Take Photo" in a file input crashes. |

`Socialite-WrapperUITests` contains the launch screenshot test.

```sh
# all tests
xcodebuild test -scheme Socialite-Wrapper -destination 'platform=iOS Simulator,name=iPhone 17'

# one suite or test
xcodebuild test -scheme Socialite-Wrapper -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:Socialite-WrapperTests/NavigationPolicyTests
```

### `scripts/verify.sh`

The full pipeline, run from the repo root (`SIMULATOR=<name>` overrides the default `iPhone 17`):

```
PASS build-and-test (iPhone 17)
PASS archive (generic/platform=iOS)
PASS archive-signature-and-name
```

1. `build test` on the simulator.
2. `archive` for `generic/platform=iOS`, without `-allowProvisioningUpdates`.
3. `codesign --verify --strict` on the archived `.app`. It also asserts that `TeamIdentifier` is set and `CFBundleDisplayName == Glance`.

DerivedData and the archive go in a `mktemp` directory, which is removed on exit. If a step fails, the script prints the last 30 log lines and exits 1.

### Page script

The page script can't be tested in CI: the build environment can't reach instagram.com, and the feed requires a login. The current workflow is:

1. Extract the JS from `PageScript.swift` and run `node --check` on it.
2. Run it in **jsdom** against a mock feed. Wrap each post in `<div>`s, as Instagram does; bare `<article>` fixtures hide `slotFor` bugs. This harness is kept outside the repo so the project stays dependency-free.
3. Confirm on a device with Safari Web Inspector. The checklists are `docs/research.md` §5 and `docs/research-following.md` §6.

---

## Build configuration

These are the key settings in `project.pbxproj`. Info.plist is generated (`GENERATE_INFOPLIST_FILE = YES`).

| Setting | Value |
|---|---|
| `SDKROOT` / `SUPPORTED_PLATFORMS` | `iphoneos` / `iphoneos iphonesimulator` |
| `IPHONEOS_DEPLOYMENT_TARGET` | `17.0` |
| `TARGETED_DEVICE_FAMILY` | `1` (iPhone) |
| `SWIFT_VERSION` | `5.0`, with `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` and approachable concurrency |
| `PRODUCT_BUNDLE_IDENTIFIER` | `Finn.Murphy.Socialite-Wrapper` |
| `CODE_SIGN_STYLE` / `DEVELOPMENT_TEAM` | `Automatic` / `72D3CDCYDY` (all targets) |
| `INFOPLIST_KEY_CFBundleDisplayName` | `Glance` |
| `INFOPLIST_KEY_NSCameraUsageDescription`, `…Microphone…`, `…PhotoLibrary…` | Required for `<input type=file>` capture |
| `INFOPLIST_KEY_UISupportedInterfaceOrientations` | Portrait only |

The project was generated from Xcode's macOS SwiftData template and then retargeted to iOS. SwiftData has been removed.

---

## Maintenance

Instagram changes its mobile web DOM without notice. When something that was blocked starts showing again:

1. Run a Debug build on a device and inspect it from Mac Safari (*Develop → iPhone → Glance*).
2. Find the new stable signal, such as an `href`, a label text or a button's text. Don't use class names.
3. Update the matching array in `PageScript.swift`: `AD_LABELS`, `FOLLOW_LABELS`, `SUGGESTED_LABELS`, `CAUGHT_UP_LABELS` or `CSS`. If a route changed, update `NavigationPolicy` instead.
4. For a non-English Instagram UI, add that language's wording to the label arrays.

**Hard constraint:** never add timed or background requests to Instagram, such as polling for notifications. An earlier reference implementation had an account flagged for automated activity because of this. The page script must only read and hide DOM elements.

---

## Known limitations

- All text-based rules (ads, suggestions, Follow button, caught-up) only match **English**.
- Collab posts co-authored by a followed and a non-followed account may show a Follow button and be hidden. This is unverified.
- `MAX_TRAILING_HIDDEN` can end the feed early if Instagram inserts 10 or more consecutive suggested posts before more followed posts.
- When the rate limit (3 redirects per 20 s) trips, the app stays on the current page without telling the user.
- "Continue with Facebook" login doesn't work: `facebook.com` opens in Safari, whose cookies don't reach the web view. Use Instagram credentials.
- Ads inside Stories aren't filtered.
- `mailto:` and `tel:` links work; other custom schemes are denied.
- The Instagram DOM and route details in `docs/` are best-effort and were verified against mocks. Confirm them on a device.
