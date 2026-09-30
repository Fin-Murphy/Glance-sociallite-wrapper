# Project: SocialLite Clone for iOS

## Goal
Build a personal iOS app that replicates SocialLite's functionality:
- Allow: Instagram feed, DMs, profiles, stories
- Block: Reels, Explore, ads, suggested posts
- Sideload to personal iPhone via Xcode (no App Store)

## Technical Approach

### Architecture
WKWebView wrapper — the same pattern SocialLite itself uses.
- Load Instagram's real mobile website (instagram.com) inside a native WKWebView
- Intercept navigation events by URL pattern to block unwanted sections
- Inject CSS/JS at page load to hide unwanted DOM elements

No backend. No API keys. No proxy. Instagram login lives in WKWebView's
standard cookie store on-device, same as Safari.

### Reference Implementation
GitHub: https://github.com/twohertz/instagram-dm-only-for-ios-anti-doom-scrolling
- SwiftUI + WKWebView, zero third-party dependencies
- Xcode-installable (not on App Store)
- Blocks everything except DMs — we want the inverse: allow feed/DMs/profiles/stories, block reels/explore/ads/suggested
- Use this as the scaffolding

### What Needs Changing from the Reference Repo
1. Invert the URL blocking rules — allow feed/profiles/stories/DMs, block `/reels` and `/explore` navigation
2. Add CSS injection (WKUserScript) to hide ad containers, sponsored posts, and suggested post UI elements
3. Scope the app UI/branding to taste

### Ongoing Maintenance
Instagram periodically rotates CSS class names on their mobile web.
When blocked elements reappear, update the CSS selectors — typically a
5-minute fix a few times a year.

## Sideloading Model (Apple)

| Method               | Cost      | App lifespan before re-sign        |
|----------------------|-----------|------------------------------------|
| Free Apple ID        | $0        | 7 days (plug in, Run in Xcode)     |
| Apple Developer acct | $99/year  | 1 year                             |

Free Apple ID is fine for personal use. 7-day re-sign = plug in phone,
press Run in Xcode, ~2 minutes.

## Stack
- Language: Swift
- UI: SwiftUI
- Web container: WKWebView (WebKit)
- Dependencies: None
- Build tool: Xcode

## Estimated Scope
~200 lines of Swift total. Small, self-contained project.

## Key Files to Implement
1. `ContentView.swift` — SwiftUI shell wrapping the web view
2. `WebViewModel.swift` — WKWebView setup, navigation delegate, URL interception logic
3. `inject.css` (or inline WKUserScript) — CSS rules to hide reels tab, ad units, suggested posts

## Out of Scope
- No backend
- No App Store submission
- No third-party auth or API integration
