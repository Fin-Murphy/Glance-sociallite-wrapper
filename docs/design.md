# Design — look & branding

A calm, minimal shell around instagram.com. The native UI should get out of the way: no chrome, no custom tab bar, no badges. The only native UI is a loading state, a short toast when a blocked section is tapped, and an offline/error screen.

## 1. Name

**Pick: `Glance`**: you look at the app briefly, then put it down. It's short (6 chars) and never truncates under the icon.

Alternates: `Horizon` (matches the icon), `Stillwater`.

Set `CFBundleDisplayName` = `Glance`. Don't use "Insta", "gram" or Instagram's gradient, camera glyph or logotype anywhere.

## 2. Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `AccentColor` | `#2F7A66` | `#7CC7B0` | Retry button, toast icon, progress tint |
| Background | `Color(.systemBackground)` (#FFFFFF) | `Color(.systemBackground)` (#000000) | Behind the web view and every native state |

- Contrast: `#2F7A66` on white is 5.1:1, and `#7CC7B0` on black is 10.7:1. Both pass WCAG AA.
- Put the accent in `Assets.xcassets/AccentColor.colorset` with Any/Dark appearances, so `.tint` picks it up automatically.
- **No white flash:** Instagram's mobile web uses pure white in light mode and pure black in dark mode (it follows `prefers-color-scheme`), so `systemBackground` matches it in both. The WKWebView also has to be non-opaque, otherwise it paints white before the first frame:
  ```swift
  webView.isOpaque = false
  webView.backgroundColor = .systemBackground
  webView.scrollView.backgroundColor = .systemBackground
  webView.underPageBackgroundColor = .systemBackground   // iOS 15+
  ```

## 3. Native UI states

Root layout: a `ZStack` with `Color(.systemBackground).ignoresSafeArea()` at the bottom, the web view above it, and the overlays below on top.

### (a) Initial loading
- Show it only until the **first** `webView(_:didFinish:)`. Don't show it again on later in-page navigations, because Instagram is a single-page app and a spinner there would flicker.
- `ProgressView()` with `.controlSize(.regular)`, tinted with the accent, centered, and no text.
- On first finish, fade it out with `.transition(.opacity)` and `.animation(.easeOut(duration: 0.25))`.

### (b) Blocked-section toast
Show it when navigation to `/reels` or `/explore` is cancelled and the app routes back to `/`.

- Placement: top-center, just below the top safe area (padding 8pt), overlaying the web view. It must not block taps: `.allowsHitTesting(false)`.
- Style: `HStack(spacing: 8)` containing `Image(systemName: "leaf")` (accent color) and `Text(...)` with `.font(.footnote.weight(.medium))`. Padding is 14pt horizontal and 10pt vertical, with `.background(.ultraThinMaterial, in: Capsule())`.
- Motion: `.transition(.move(edge: .top).combined(with: .opacity))`. It auto-dismisses after **2.0s**, and there is no close button.
- Copy:
  - Reels: **"Reels are switched off. Back to your feed."**
  - Explore: **"Explore is switched off. Back to your feed."**
  - If you'd rather keep one string: **"That's switched off. Back to your feed."**
- Tone: say it plainly and without judgment. Never write something like "Stay focused!" or "Nice try."

### (c) Offline / load error
- Trigger it from `didFailProvisionalNavigation` or `didFail`. Ignore `NSURLErrorCancelled` (-999), because our own blocking and Instagram's SPA navigation cause it.
- Use the iOS 17 `ContentUnavailableView` on `systemBackground`, replacing the web view:
  ```swift
  ContentUnavailableView {
      Label("Can't reach Instagram", systemImage: "wifi.slash")
  } description: {
      Text("Check your connection and try again.")
  } actions: {
      Button("Try Again") { reload() }
          .buttonStyle(.borderedProminent)
  }
  ```
- Retry calls `webView.reload()`, or loads `https://www.instagram.com/` if nothing has loaded yet. Clear the error state as soon as a navigation starts.

### Pull-to-refresh: **no**
This is a deliberate call. Pull-to-refresh is the slot-machine gesture that an anti-doomscroll app exists to remove, and leaving it out also saves lines of code. You can still refresh by tapping Instagram's own Home tab, and a stuck page is handled by the error screen's retry. If the programmer or PM wants it anyway, a `UIRefreshControl` on `webView.scrollView` is about 6 lines.

### Safe areas
- **Respect** the top and bottom safe areas for the web view. Don't use `.ignoresSafeArea()` on it. The status bar then never overlaps Instagram's header, and Instagram's bottom nav clears the home indicator whether or not the page uses `viewport-fit=cover`.
- Only the background `Color` ignores safe areas. It fills the status-bar and home-indicator gutters in white or black, so they blend with the page and there's no visible seam.
- Leave the status bar style automatic, with no custom nav bar and no hidden status bar.

## 4. App icon

File: `docs/AppIcon-1024.png` (1024×1024, RGB, no alpha, full-bleed square; iOS applies the corner mask).

**Concept:** a sunrise on still water. A warm off-white half-sun (`#F4ECDD`) sits on a flat horizon. Above it is a soft sage-green sky gradient (`#4A8A77` → `#2F5D50`), and below it is deep green water (`#1F4038`) with two short, muted reflection strokes. The mood is quiet and unhurried, a moment to glance at and then leave. It deliberately has no camera glyph, no pink/orange/purple gradient and no rounded-square outline, so nothing points at Instagram's marks.

A single 1024 icon works in dark mode as it is, because the palette is already dark.

The source is a short Python/Pillow script (flat shapes, 4× supersampled). Ask the designer session if it needs to be re-rendered.

## Heads-up for the programmer

The Xcode project is currently a **macOS** app (`SDKROOT = macosx`, `MACOSX_DEPLOYMENT_TARGET = 26.2`), and `AppIcon.appiconset` only has mac slots. It needs an iOS target / `SDKROOT = iphoneos` before any of this applies. For the icon, add a single iOS "universal" 1024×1024 entry to the appiconset `Contents.json`.
