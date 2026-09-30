# Research: Following-only home feed

This covers how to stop posts from accounts the user doesn't follow reaching the home feed.
Option A forces the Following feed. Option B hides every post from a non-followed account.
Researched 2026-09-30.

**TL;DR: ship B now, and keep A as the start page only.** Stop full page loads of bare `/` too.
- The Following feed (`/?variant=following`) reportedly has **no stories tray**. So A on its own
  can't meet "Following only, but keep the stories tray".
- The stories tray lives on `/`, so `/` has to stay usable, and only B makes it clean.
- The signal for B is a **Follow button inside the post `<article>`**. Suggested posts past the
  top of the feed carry no "Suggested" label, which explains what the user is seeing.
- The mobile build labels ads **"Ad"**, not "Sponsored". Our `AD_LABELS = ['sponsored']` misses them.

## 0. What was checked and what is a best guess

| Claim | Status | Source |
|---|---|---|
| SocialLite changelog wording (§1) | **Verified.** Read from the App Store page today | App Store listing |
| SocialLite's mechanism (§1) | **Best guess** from its changelog. We have no binary or source | — |
| `https://www.instagram.com/?variant=following` serves a chronological, following-only feed with no ads or suggestions | **Reported by several independent sources.** Not tried on our device | How-To Geek, Substack note, two userscripts updated Sept 2026 |
| Instagram's logo dropdown links to exactly `/?variant=following` | **Reported** (one source) | instagram-noslop |
| The Following feed has **no stories tray** | **Reported** (one source). Verify on device first | instagram-noslop |
| Suggested posts are marked by a Follow button, not a label. The "Suggested posts" divider is unmounted once you scroll past it | **Reported, with measurements** (12/12 suggested posts had one, 0/3 followed posts did, ads never do; en-GB, Sept 2026 mobile build) | instagram-noslop. Greasy Fork scripts 510716 and 522719 use the same Follow signal |
| Mobile ads say "Ad" and carry `facebook.com/ads/ig_redirect` / `a_mpk=` links | **Reported** (one source) | instagram-noslop |
| Instagram rewrites `/?variant=following` back to `/` | **Unknown.** Both userscripts guard against it, and neither says it happens | — |
| Proposed JS patch (§4) | **Verified offline only.** jsdom against a mock feed built from the reported DOM (below) | this repo |
| Collab posts, other languages, the post-login navigation type | **Best guess.** Listed as device checks in §6 | — |

jsdom result: the current `PageScript` fails 6 of 11 checks. It lets through unlabelled suggested
posts, "Follow back" posts, "Ad"-labelled ads and ad-link ads. The patched version passes 11/11.
It keeps a followed post whose caption and comment say "follow", a just-followed post (button
reads "Following") and the stories tray. It hides the rest. It un-hides a recycled `<article>`
once its Follow button disappears.

## 1. How SocialLite does it

Relevant App Store changelog lines, quoted verbatim:

- 1.2.1 (2026-03-04): *"Instagram blocking now works with devices set to other languages by forcing english within Sociallite"*
- 1.3.1 (2026-04-22): *"Home Feed (insta) filtering, no suggested or ads!"* and *"Block your feed while keeping stories visible (fixed)"*
- 2.1.0 (2026-06-07): *"Handling for A/B variant testing"*
- Listing: *"Algorithmic recommendations and suggested content"* is under "What gets blocked". Reviews confirm it is a web wrapper ("uses the social media's website").

**Best guess: SocialLite stays on `/` and filters the DOM by English text.** It does not redirect
to `?variant=following`. The evidence:
1. "Home Feed **filtering**" describes hiding posts, not swapping to another feed.
2. "Block your feed while keeping stories visible" only makes sense on a page that has both. That
   is `/`, if the Following feed has no tray.
3. Forcing English so that blocking works means the rules match UI text. "Follow", "Sponsored" and
   "Suggested for you" are all text.
4. "A/B variant testing" most likely means Instagram's own UI experiments. It is too vague to read
   as `?variant=`.

I found no Reddit or HN thread that describes the mechanism.

## 2. Option A: force the Following feed

- **URL:** `https://www.instagram.com/?variant=following`. `?variant=favorites` is the
  Favourites feed. No `/following/` path route is known. This is what `NavigationPolicy.home`
  already uses.
- **Stories tray:** reportedly **absent** on this variant. instagram-noslop leaves in-app Home
  alone for exactly this reason: *"Home stays the tray surface"*. If that holds on our device,
  A alone loses the stories tray.
- **How Instagram gets there:** from the logo dropdown, as a client-side (pushState) transition,
  inferred from noslop's notes. The Home tab and logo link to `href="/"`, which is a pushState to
  the For You feed. Native code never sees pushState; only our JS guard does.
- **Making it sticky.** There are two levels.
  1. **Full page loads of bare `/` go to `home` (recommended).** This covers relaunch, the
     web-content-process crash reload, and any server-side redirect to `/`. It does it in
     `decidePolicyFor` only. It is not added to `NavigationPolicy.decision`, because the `url`
     KVO observer and `appBecameActive` also call that. Otherwise every in-app Home tap would bounce.
  2. **Home tab / logo taps go to `home` too (optional; loses the tray).** The click capture
     handler swallows `a[href="/"]` and asks native code to load `home`. That is a full reload of
     about 1–2 s per tap. Don't rewrite the anchor's `href`: Instagram's router navigates from its
     own props, not the DOM attribute, and React re-renders it anyway. Don't block `pushState('/')`
     either. The guard would then catch non-tap transitions such as modal closes and the login flow.
- **Loops.** If Instagram ever `replaceState`s `?variant=following` away, the page just sits on
  `/`. Level 1 ignores it because it isn't a navigation, and B still cleans the feed. If the server
  starts 302-ing `?variant=following` to `/`, level 1 would bounce. The existing 3-per-20 s limit in
  `redirect(…, limited: true)` stops that after three tries and leaves B as the fallback. insta-filter
  uses the same design: 3 redirects per 10 s, then *"lean on the scrubber"*.

Level 1 in Swift, as a sketch. `redirect` currently requires a `BlockedSection`, and this case
shouldn't show a toast:

```swift
// NavigationPolicy
/// A full load of the bare For you feed ("/" with no ?variant=). Sent to `home`.
/// Only checked in decidePolicyFor: in-app Home taps (pushState) stay on "/", where the stories tray is.
static func isForYouLoad(_ url: URL) -> Bool {
    guard let host = url.host()?.lowercased(), host == "instagram.com" || host.hasSuffix(".instagram.com"),
          url.path().isEmpty || url.path() == "/" else { return false }
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    return !items.contains { $0.name == "variant" }
}

// WebViewModel.decidePolicyFor, first line of `case .allow:`
if NavigationPolicy.isForYouLoad(url) {
    redirect(to: NavigationPolicy.home, showing: nil, limited: true)   // make `showing` optional
    return .cancel
}
```

## 3. Option B: hide posts from non-followed accounts

Signals, strongest first:

| Signal | Catches | Notes |
|---|---|---|
| **Button whose text is "Follow" / "Follow back"** inside the `<article>` | Every suggested post, labelled or not | Instagram shows it only when you don't follow the author. "Following" (just tapped) must not match. Only button text counts, never caption or comment text. |
| "Suggested for you" / "Suggested posts" text | The first suggestion block and the divider | Already in `SUGGESTED_LABELS`. Reportedly unmounted after scrolling, so it's not enough on its own. |
| "You're all caught up" | Everything after it | Already handled. |
| "Ad" / "Sponsored" label | Ads | **Add `'ad'`**: the mobile build says "Ad". Ads have no Follow button. |
| `a[href*="/ads/ig_redirect"]`, `a[href*="a_mpk="]` | Ads with any label or language | Language-independent backup. |
| "Because you liked…" / "Based on your activity" | Nothing we can confirm | I found no source for these strings on mobile web; they're app-side reasons. A suggested post that shows one also has a Follow button, so rule 1 covers it. Don't add them untested. |

**Language.** Every text rule depends on the UI language. SocialLite forces English (verified,
§1). For us, either add the user's wording to `FOLLOW_LABELS` and `AD_LABELS`, the same way
`AD_LABELS` already invites, or force English. Two guessed ways to force it: append `hl=en` to
`home`, or rely on WKWebView's Accept-Language (it follows the app's localizations). The ad-link
rule works in any language.

**Collabs and paid partnerships.**
- *Paid partnership* posts from an account you follow have no Follow button, so they stay. That
  seems right: the user follows the creator. noslop hides them as ads, which we'd only do on request.
- *Collab posts* ("A and B") where you follow only one author are **unverified**. If Instagram shows
  a Follow button for the other author, rule 1 would hide a post from someone you follow. Check this
  on the device (§6) before worrying about it.

## 4. Proposed PageScript patch (Option B)

These are three additions in the existing style. `labelled()`, `setHidden()` and the sweep stay as
they are.

```js
// replaces: var AD_LABELS = ['sponsored'];
var AD_LABELS = ['sponsored', 'ad'];   // the mobile build labels ads "Ad"
// Text of the Follow button Instagram puts in the header of a post from an account you don't follow.
// Not "following" (you do follow them).
var FOLLOW_LABELS = ['follow', 'follow back'];
```

```js
// next to setHidden()
// Ad plumbing in a post's links: catches ads whose label we don't match.
function adLinked(article) {
  return article.querySelector('a[href*="/ads/ig_redirect"], a[href*="a_mpk="]') !== null;
}
// A post from an account you don't follow carries a Follow button; followed accounts' posts and ads don't.
// Only button text counts, so a caption or comment reading "Follow" doesn't.
function notFollowed(article) {
  return labelled(article, FOLLOW_LABELS).some(function (el) {
    var button = el.closest('button, [role="button"]');
    return button !== null && article.contains(button);
  });
}
```

```js
// in sweep(), the article condition gains two terms
setHidden(article, afterCaughtUp ||
  labelled(article, AD_LABELS).length > 0 ||
  labelled(article, SUGGESTED_LABELS).length > 0 ||
  adLinked(article) || notFollowed(article));
```

The feed check `normPath(location.pathname) === '/'` already covers `/?variant=following`, so the
rule runs on both feeds. It is harmless on the Following feed. The test harness is in the
session scratchpad, not the repo: `build.mjs` extracts the JS from `PageScript.swift` and patches
it, and `test.mjs` holds the mock feed. Ask if you want it committed under `scripts/`.

## 5. Recommendation

**Combine them: A is the start page, B does the cleaning everywhere.**
1. Ship the §4 patch. It fixes what the user reported, whatever route they end up on, and keeps
   the stories tray on `/`.
2. Add §2 level 1, so relaunches, crash reloads and server redirects land on the Following feed.
3. Leave the Home tab alone. It becomes "the filtered For You feed plus the stories tray", the
   design noslop chose. Add level 2 only if the user would rather lose the tray than see `/`.

**Risks**
- *Language:* the Follow and "Ad" text rules break in a non-English UI (see §3).
- *Markup churn:* if Instagram renames the button or moves it out of the `<article>`, suggested
  posts reappear. Nothing breaks; it just stops filtering.
- *False positives:* the collab case above.
- *An empty `/` feed:* the For You feed past the followed posts is all suggestions. With them hidden,
  Instagram's infinite-scroll sentinel stays in view. It may keep fetching posts we hide (wasted
  data) or stall. The existing "caught up" rule limits this. Watch for it on the device.
- *`?variant=following` is undocumented* and could disappear. The redirect limiter plus B degrade
  gracefully.

## 6. Device checks (Safari Web Inspector, `isInspectable` is already on in DEBUG)

1. Open `/?variant=following`. Is there a stories tray? Does the URL keep the query after load?
2. Tap Home, then the logo. Check the URL, and whether the logo shows a Following / Favourites menu.
3. On `/`, scroll past the caught-up marker, then paste this into the console:
   ```js
   [...document.querySelectorAll('article')].map(a => [...a.querySelectorAll('button,[role="button"]')]
     .map(b => b.innerText.trim()).filter(t => t && t.length < 20).join('|'))
   ```
   Suggested posts should show `Follow`. Followed posts shouldn't.
4. Find a collab post where you follow one author. Does it show a Follow button?
5. Log out and in. Does the post-login landing on `/` arrive as a full load (level 1 catches it)
   or as pushState (only B cleans it)?

## Sources

- SocialLite on the App Store: https://apps.apple.com/us/app/sociallite-block-reels-shorts/id6757661674 (description, version history, reviews)
- instagram-noslop v2.2.0, 2026-09-09: https://github.com/SHADOWDANCH/instagram-noslop
- insta-filter, 2026-09-23: https://github.com/blobspire/insta-filter
- Greasy Fork 510716 and 522719 ("Follow" / "Suggested" article filters): https://greasyfork.org/en/scripts/510716 , https://greasyfork.org/en/scripts/522719
- How-To Geek, chronological feed on web: https://www.howtogeek.com/instagram-for-web-still-has-a-chronological-feedif-you-know-how-to-find-it/
- Substack note on `?variant=following`: https://substack.com/@justinhanagan/note/c-20922033
