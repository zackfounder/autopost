# How Linked Helper works, and how this clone mirrors it

Written from the vendor's own docs and marketing pages, third-party teardowns, and
their published detection study. Sources at the bottom. Anything I could not verify
is marked **[inferred]**.

---

## 1. What Linked Helper actually is

It is **not** a Chrome extension and **not** a cloud scraper. It is a **desktop
application** (Windows / macOS / Ubuntu) that ships its own embedded Chromium.
You log into LinkedIn once *inside that embedded browser*, and the app then drives
that browser window: clicking, typing, scrolling, opening profiles.

Three consequences fall out of that choice, and they are the whole design:

1. **The session is real and local.** There is no `li_at` cookie shipped to a
   vendor server. The requests LinkedIn sees come from a real browser with a real
   TLS fingerprint, real headers, and a coherent request map (a profile view is
   accompanied by all the asset and telemetry calls a human's browser would make).
   Pure-API tools that hit LinkedIn's internal `/voyager/` endpoints with a stolen
   cookie skip those side-requests, and that gap is itself a detectable anomaly.
2. **It only runs while your machine is on.** No cloud queue. Close the laptop,
   the campaign stops.
3. **Work is expressed as a queue of small steps**, because a browser can only do
   one thing at a time.

Their own security write-up is explicit that LinkedIn's page code carries an
extension scanner with thousands of targets, a DOM "spectroscope", and a device
fingerprint that travels with session requests — which is the stated reason they
are a desktop app driving a browser rather than an extension injecting into one.

## 2. The object model

```
Account (one LinkedIn login = one browser profile = one proxy)
  └── Campaign
        ├── Workflow  = ordered list of Actions (the funnel)
        ├── Queue     = the leads, each parked at some step
        └── Settings  = daily limits, working hours, delays
```

**A campaign is a funnel.** You build the workflow top to bottom; every lead
enters at the top and walks down. Each action is a plug-in that knows how to do
one thing on LinkedIn and knows which leads it *can* process (e.g. "invite" only
accepts 2nd/3rd-degree, "message" only accepts 1st-degree).

The published action set, grouped:

| Group | Actions |
|---|---|
| Network | Invite 2nd/3rd to connect (with or without note), Filter to 1st-degree only, Withdraw pending invites, Accept invites, Remove connections |
| Messaging | Message 1st connections, InMail 2nd/3rd, Check for replies, Message group members / event attendees |
| Engagement | Visit profile, Follow / unfollow, Endorse skills (3 modes), Like post, Comment on post |
| Growth | Invite to group / event / company page |
| Plumbing | Delay between actions, IF-THEN-ELSE condition, Send to webhook, Tag, Export |

**Two ordering rules matter and are easy to get wrong:**

- You **build** top-to-bottom, but the engine **executes bottom-to-top**. On each
  tick it scans the workflow from the *last* step backwards and services the first
  step that has someone waiting. That deliberately pushes people who are already
  deep in the funnel out the far end before pulling new people in at the top.
- **Delay vs. Check-for-replies are not interchangeable.** Between two
  *non-messaging* actions you use `Delay`. Between two *messages* you must use
  `Check for replies`, because that action both waits *and* detects an incoming
  reply so the sequence stops instead of nagging someone who already answered.
  Linked Helper auto-inserts `Check for replies` when you add a message action.

## 3. Lead sources

Leads are collected by *browsing*, not by an API: the app opens a LinkedIn search
results page (regular search, Sales Navigator, Recruiter, a group's member list, an
event's attendee list, an alumni page, "who viewed your profile", your pending
invites, or your full connections list), paginates it, and harvests profile URLs
into the campaign queue. CSV import is the manual escape hatch.

## 4. Safety model — pacing, not cloaking

This is the part people misread. The safety features are about **not exceeding what
a human plausibly does**, and they are what actually keeps an account alive:

- **Rolling 24-hour caps per action type** (not calendar-day caps — a rolling
  window, so you cannot dump a day's quota at 23:59 and another at 00:01).
- **Working hours** with a randomized start time, so the account isn't active at
  03:00 and doesn't begin at exactly 09:00:00 every day.
- **Randomized delay between every micro-step**, including keystroke-level typing
  simulation for message bodies rather than a single `value =` assignment.
- **Warm-up**: new or dormant accounts start at ~10–25 invites/day and ramp. The
  vendor's own guidance is to stay under ~100–150 total actions/day even on a
  mature account. LinkedIn separately enforces a weekly invitation cap.
- **One proxy per account**, with health checks, so a given LinkedIn session always
  egresses from one IP.

## 5. Data extraction: DOM vs. Voyager

LinkedIn's public DOM is deliberately hostile — obfuscated class names, no stable
semantic hooks. So for *reading* profile data, the reliable path is LinkedIn's own
internal `/voyager/` API, called **from inside the logged-in page context** so it
carries the session and CSRF token naturally.

For *acting* (Connect, Message, Follow), the DOM path is more stable than Voyager
because the buttons carry `aria-label`s that change far less often than
LinkedIn's GraphQL query IDs — and clicking a button produces exactly the request
sequence a human produces.

**So: DOM-first for actions, page-context Voyager for reads.** That is the split
this clone implements.

## 6. Integrations

13 direct CRM connectors, plus inbound and outbound webhooks. The outbound webhook
is a workflow action ("Send person to webhook") that POSTs a flat ~180-key profile
object. Two traps, both learned the hard way:
it fires for **every** person the step processes, not only ones matching the step's
name; and `last_received_message_text` is *not* a reply signal — the real signal is
`is_last_message_incoming`.

---

## 7. What this repo does differently

| | Linked Helper | linkedin-browser-agent |
|---|---|---|
| Browser | embedded Chromium, closed | Playwright Chromium, persistent profile dir you own |
| Workflow | GUI builder | JSON file (an LLM can author it) |
| Storage | opaque local DB | SQLite you can query |
| AI | fixed "AI message" / "AI ICP" features | any step can call an LLM; the model also gets a tool API to drive the whole engine |
| Control | desktop GUI only | HTTP API + dashboard + MCP server |

Same architecture, open internals, and an agent-shaped control surface instead of a
GUI. The engine is deliberately conservative in the same places Linked Helper is:
one browser, one action at a time, rolling caps, working hours, human pacing.

**What this repo will not do:** solve CAPTCHAs, spoof device fingerprints, evade
the extension scanner, or run a LinkedIn session from a machine that isn't yours.
Pacing keeps an account healthy; cloaking is a different thing and isn't here.

## 8. The honest risk statement

Automating LinkedIn violates the LinkedIn User Agreement regardless of how careful
the pacing is. The realistic failure mode is a temporary restriction or a permanent
ban on the account, and the ceiling on volume is set by LinkedIn's weekly invite cap,
not by this software. Every commercial tool in this category — Linked Helper,
Waalaxy, Dripify, Expandi — carries the same exposure. Run it on an account you can
afford to lose, warm it up, and keep the caps low.

---

### Sources

- [Linked Helper — product site](https://www.linkedhelper.com/) (action list, lead sources, integrations, credits)
- [Linked Helper — LinkedIn automation limits](https://www.linkedhelper.com/blog/linkedin-automation-limits/)
- [Linked Helper — how LinkedIn catches automation](https://www.linkedhelper.com/blog/linkedin-automation-security-study/)
- [Linked Helper support — Workflow](https://support.linkedhelper.com/hc/en-us/articles/360016470720-Workflow) (queue ordering, delay vs. check-for-replies)
- [Linked Helper support — Working hours and limits](https://support.linkedhelper.com/hc/en-us/articles/360016435499-Working-Hours-and-Limits)
- [Skrapp — Linked Helper review](https://skrapp.io/blog/linked-helper/) (desktop app, plug-in architecture)
- [Overloop — pricing, limits, ban risk](https://overloop.com/blog/linkedin-helper-review)
- [Iron Mind — Voyager API scraper writeup](https://iron-mind.ai/blog/linkedin-profile-scraper-python-voyager-api) (DOM vs. Voyager, obfuscated classes)
