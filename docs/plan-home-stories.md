# Plan: stories tray back on Home, non-followed posts still hidden

Owner: pm. Written 2026-10-06. Status: waiting on task 1.

## Goal

Home is `instagram.com/` again, so the stories tray shows. Every post from an account the user
doesn't follow is hidden. The user picked this over a two-web-view layout or a separate Stories
screen, and accepts that `/` is in algorithmic order, not chronological.

## Why this is not just a revert

We shipped exactly this on 2026-09-30 (commit `641f171`: home `/` plus the Follow-button filter from
`docs/research-following.md` §4). **On the device, non-followed posts got through.** Commit `a99713b`
then moved home to `?variant=following`, and that move lost the tray. The filter was only ever
checked against a jsdom mock built from secondhand DOM reports, and we don't know *why* it leaked.
So step 1 is a diagnosis on the real page. Shipping a revert before we know the cause would put the
leak straight back.

Leading hypotheses, none confirmed:
- H1: feed posts on the current mobile build aren't `<article>`s, so the sweep never sees them.
- H2: the Follow button exists, but `labelled()` misses it. Its text node might carry a `•` or extra
  words, the label might be outside the button, the UI might be in another language, or it might
  render after the article is classified.
- H3: some leaked posts have no Follow button at all (for example suggested reels in the feed,
  "Because you liked…" units, or collabs).
- H4: the stop point or `slotFor` hides the wrong things, or un-hides recycled nodes too eagerly.

## Tasks (in order)

**1. researcher: write the on-device diagnostic.** No production code.
A single paste for the Safari Web Inspector console, *read-only* (no network, no clicks). For each
post-like unit currently in the feed, it reports:
- the tag of its feed slot (is it an `<article>`?)
- the author's profile `href`
- every button / `[role=button]` text ≤ 40 chars, plus the raw text node behind "Follow" if one exists
- whether `data-glance-hidden` is set
- any short text that looks like a label ("Suggested…", "Ad", "Sponsored", "Because…")
- `document.documentElement.lang`

It also reports whether the page's embedded JSON (`script[type="application/json"]`) mentions
`friendship_status` / `following` per post. That tells us whether a positive "you follow this"
signal is available without new requests (see task 3b).

Output: a JSON blob the user can copy. Personal usernames are fine locally, but the copy that goes
into a repo fixture must be anonymised.
Done when the snippet runs in a jsdom mock with no errors and clearly separates hidden from
visible posts.

**2. user: run it on the device.** DEBUG build, so `isInspectable` is on. Temporarily load
`instagram.com/` with Safari on the same phone (logged in) *or* with the task-4 build. Scroll until
at least one non-followed post shows, run the snippet, and send the output along with which visible
posts are from accounts you don't follow. *Nobody else on the team can reach instagram.com, so
this step is the critical path.*

**3. researcher + pm: pick the fix from the output.**
- 3a. If the cause is H1, H2 or H4, fix the matcher in `PageScript` and stay within the existing
  rules in `CLAUDE.md`.
- 3b. If it's H3 (leaked posts carry no DOM signal), switch to a **positive** signal: read-only
  inspection of feed data the page *already receives* (`friendship_status.following` per post),
  and fail closed, so posts stay hidden until confirmed followed. This is a new technique. It
  needs a short write-up first (exact fields seen on the device, how responses are read without being
  modified, what happens when the shape changes) and a `CLAUDE.md` rule update, which pm approves
  before any code is written. It must never issue a request.

**4. programmer: revert home to `/` (ship together with task 5, not before).**
- `NavigationPolicy.home` = `https://www.instagram.com/`. Remove the For you redirect
  (`feedHosts`, `allowedFeedVariants`, `.forYou`, the JS `FEED_*` mirror, and the `ContentView` case).
  `/?variant=following` and `?variant=favorites` stay allowed and filtered.
- Reels redirects now land on `/`. Update `NavigationPolicyTests`: `/` and `/?variant=foo` are
  allowed, and redirect targets are `/`.
- Update the README "Home URL" paragraph and the routes table.

**5. programmer: implement the fix chosen in 3.** Add the anonymised device DOM of the leaked posts
to the jsdom mock as a regression case. It must fail before the fix and pass after.

**designer:** nothing needed. No UI changes.

## Acceptance criteria (checked on the device by the user, with the steps written by pm)

1. A cold launch lands on `instagram.com/` with the stories tray visible. Tapping a story plays it.
   Home tab and logo taps keep the tray.
2. Scroll the home feed to its stop point three times across two days. **Zero** visible posts
   from accounts the user doesn't follow, zero ads and zero "Suggested" blocks. The diagnostic
   snippet, run at the end, reports 0 visible non-followed posts.
3. Posts from followed accounts that Instagram puts on `/` still show, including the user's own.
4. After the stop point, with the feed left idle for 60 s, the Network tab shows no further feed
   fetches (account-safety rule).
5. DMs, profiles, single posts, search and Reels/Explore blocking behave as before.
6. `scripts/verify.sh` passes. Any JS change passes `node --check` and the jsdom suite. The
   handoff says which checks ran only against mocks.

## Out of scope

- Chronological order on Home. `/` is algorithmic, and the user accepted that.
- A stories tray on the Following feed, two web views, or a separate Stories screen (the user rejected these).
- Non-English labels, unless task 2 shows that language is the cause.
- Ads inside Stories.

## Risks and open questions

- **Few posts on Home.** `/` mixes in many suggestions. Hiding them plus the 10-hidden-in-a-row stop
  point may cut the feed short, before later followed posts appear. After acceptance check 3, ask
  the user whether the feed feels too short. Raising `MAX_TRAILING_HIDDEN` trades that against
  extra hidden fetches.
- **3b fails closed.** If Instagram changes its data shape, Home shows the tray and no posts. That
  is visible and safe, but annoying. pm decides whether to accept this when 3b is chosen.
- **Collab posts** where the user follows only one author may be hidden. Accept unless the user objects.
