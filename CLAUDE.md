# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Glance" (target/scheme `Socialite-Wrapper`): a personal, sideloaded iOS 17+ SwiftUI app that shows instagram.com in a `WKWebView`. It allows the feed, DMs, stories and profiles, and blocks Reels, Explore, ads and posts from non-followed accounts. It has no backend and no dependencies. The spec is `sociallite-clone-plan.md`. Design decisions are in `docs/design.md`, and research on Instagram's URLs and DOM is in `docs/research.md` and `docs/research-following.md`. Each doc ends with an on-device checklist.

## Commands

```sh
scripts/verify.sh                        # full check: simulator build+test, device archive, archive signature/name
SIMULATOR="iPhone 16" scripts/verify.sh  # different simulator (default iPhone 17)

xcodebuild -scheme Socialite-Wrapper -destination 'platform=iOS Simulator,name=iPhone 17' build test
# one suite (Swift Testing struct) or one test:
xcodebuild test -scheme Socialite-Wrapper -destination 'platform=iOS Simulator,name=iPhone 17' \
  -only-testing:Socialite-WrapperTests/NavigationPolicyTests
```

- Signing uses team `72D3CDCYDY` (automatic, set in the pbxproj). Archiving fails without a team. Never pass `-allowProvisioningUpdates`: it changes the user's Apple account.
- The project uses file-system-synchronized groups, so new `.swift` files in `Socialite-Wrapper/` are picked up without editing the pbxproj.
- Info.plist is generated from `INFOPLIST_KEY_*` build settings. The camera, microphone and photo-library usage strings are required, because "Take Photo" in a file input crashes without them. `AppBundleTests` checks for them.

## Architecture

Blocking happens in three layers that must agree:

1. **`NavigationPolicy`** (top of `WebViewModel.swift`) is the single source of truth. It holds the URL rules as data (`blockedPrefixes` with their redirect targets, `allowedExactPaths`, `blockedProfileTabs`, `home`), and `decision(for:)` returns `.allow` / `.redirect(URL, section)` / `.openExternally` / `.deny`. It is a blocklist, because profiles are top-level `/<username>/`. `NavigationPolicyTests` covers it.
2. **`WebViewModel`** enforces the policy natively:
   - `decidePolicyFor` handles real page loads. Allowed link taps are cancelled and re-loaded by the app, so iOS doesn't hand instagram.com links to the Instagram app.
   - A KVO observer on `webView.url` catches SPA route changes, back/forward and popstate.
   - A `WKScriptMessageHandler` receives reports from the JS guard.
   - Redirects that weren't started by a tap are rate-limited (3 per 20 s) to prevent loops.
   - It publishes `blockedSection` / `hasLoaded` / `loadFailed`, which `ContentView` uses for the toast, loading and error states.
3. **`PageScript.swift`** is JS injected at document start. It is built as a Swift string, and its path lists are **generated from `NavigationPolicy`**, so change rules there, not in the JS. It has two parts:
   - A route guard: a capture-phase click guard plus pushState/replaceState wrappers that post to native.
   - A page cleaner: CSS plus a throttled MutationObserver sweep over the home feed. The sweep hides `<article>`s that carry ad labels, suggestion labels, ad-redirect links, or a **Follow / Follow back button** (the non-followed-account signal). It un-hides recycled nodes. It also hides everything after the feed's stop point, which is the "You're all caught up" marker, or else a trailing run of `MAX_TRAILING_HIDDEN` hidden posts. This stops Instagram's lazy-load sentinel from fetching hidden posts forever.

## Rules for page-script changes

- Never select on Instagram's generated class names. Use only `href` values, `<article>`, `button`/`[role=button]`, and whole short text nodes (≤ 40 chars). Label arrays are English-only; add other languages there.
- Keep CSS link rules exact, e.g. `a[href="/reels/"]` and not a `^=` prefix. A prefix match hides reels shared in DMs.
- Never add timed or background requests to Instagram. An earlier reference implementation got an account flagged for "automated activity". The observer must only read and hide DOM.
- The page script has no in-repo tests, and the sandbox can't reach instagram.com. Check JS changes with `node --check` on the extracted script and a jsdom mock feed (kept outside the repo, with feed posts wrapped in divs as Instagram does). Then confirm on a device with Safari Web Inspector (`isInspectable` is on in DEBUG). Say clearly what was verified only against mocks.
