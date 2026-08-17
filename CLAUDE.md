# linkedin-browser-agent

A local social engine for **LinkedIn and X**. One real browser per account holding a
real session, rolling rate caps, human pacing. Agents post, comment, react, repost,
reply, DM and manage invitations autonomously, bounded by an approved template bank
and a content gate enforced in code.

Quora and Indie Hackers were removed on 2026-08-16. An `accounts` row can still point
at them; `isPlatformId()` guards every read path and `npm run accounts -- forget <n>`
removes the row.

**Read [`docs/HANDOFF.md`](docs/HANDOFF.md) before changing anything.** It is the
complete mental model: the two queues, the exact tick loop, the content pipeline, the
data model, and the subtleties that will otherwise confuse you. This file is only the
short version.

## Architecture in one screen

```
src/
  platforms/   one adapter per platform. EVERY selector lives here, nowhere else.
  content/     templates (LRU rotation) → generate (gen→gate→repair) → gate (code-enforced)
  engine/      limits (rolling 24h/1h) · scheduler (the tick loop) · jobs (post/engage/dm)
               · runner (one funnel step) · workflow (campaign JSON → DB + validation)
  browser/     persistent Chromium per account, human pacing, LinkedIn Voyager reads
  actions/     outreach funnel actions (invite / filter_connected / message / …)
  db/          schema.sql + plain-function repositories. No ORM, none wanted.
instructions/  GLOBAL.md + one file per platform — the agents' brief (persuadable)
templates/     5 approved shapes per platform — the hard whitelist (not persuadable)
```

**Two queues, one scheduler.** `campaign_leads` is the outreach funnel (lead-driven);
`jobs` is scheduled content and engagement (clock-driven). Jobs win when both are due.
One tick = at most one action, then a 35–140s human gap.

## Invariants — do not relax without changing the tests

1. **Nothing publishes without passing `gate()`**, and the gate runs *again*
   immediately before the browser acts. **There is deliberately no bypass parameter.
   Do not add one.** If something needs an exception, change the template bank or the
   gate's rules.
2. A post's `template_id` must exist in `templates/`. That is the boundary on an
   **agent's** autonomy, and it is unchanged. There is exactly one other source of
   authority: `provenance: 'founder_approved'`, which an upstream approval rail sets from the
   fact that HQ queued the job — after a chief reviewed it, HQ's content law
   checked it in code, HQ's surface gate ruled on it, and the founder's door
   opened for that specific deliverable. It is set by `scripts/rail.ts`, never by
   anything that writes copy, and it lifts *only* the template requirement: length
   caps, banned words, em-dashes, placeholders and every other rule still run.
   Four smoke checks hold this line, including "an agent still cannot post
   without a template".
3. Generation **fails closed** — a missed post costs nothing, a bad post is public.
4. `leads.profile_url` normalized is the dedup key across every table, forever.
5. Stop-on-reply is structural, not a setting.
6. Suppression is permanent, global, and applied inside the queue query itself.
7. Failed actions never consume quota; `blocked` never burns a retry attempt.
8. One browser per account, one action in flight.
9. **The engine never auto-starts.** A process booting must not touch a real account.
10. Nothing in this repo ever types a credential. The owner logs in themselves, once,
    per account, via `npm run login`.

## Things that look like bugs and are not

- **In mock mode every draft is `blocked`.** `MockClient.text()` emits an em-dash,
  which the gate bans. Smoke check #11 asserts this — and forces the mock explicitly,
  so the suite keeps its no-credentials-no-network contract whatever keys exist.
  Mock is the *third* choice: `GROQ_API_KEY` (free) is the
  default lane, Anthropic is used only when `ANTHROPIC_API_KEY` **and** `AI_PAID=true`
  are both set, then mock. A key in `.env` is not consent to spend it. The startup
  banner reports which one is live — it used to guess from the Anthropic key alone and
  would say `mock` while Groq was really generating.
- **Steps execute bottom-to-top.** `pickWork()` scans the workflow from the last
  position backwards on purpose (Linked Helper's queue rule — `docs/ARCHITECTURE.md §2`).
  Do not "fix" it to scan forwards.
- **`delay` reads `ctx.lead.state`**, not a timestamp. The wait is encoded in the
  `ready → waiting → ready` transition.
- **`engage_feed` holds the browser for minutes.** It loops internally up to
  `maxActions` with a full gap between each. Every other path is one-action-per-tick.

## Known weak points

- **Every platform selector is unverified** against a live session. Treat selector
  bugs as expected. Each platform needs one supervised calibration run (headed
  browser, one job, fix what the log says it could not find). The targeted LinkedIn
  actions — reactions flyout, invitation manager, comment replies — are the newest
  and least exposed.
- **`FeedItem.index` is positional.** If a feed reflows between read and engage the
  index can point at a different post. Adapters guard with `isVisible()` and bail, but
  matching on permalink instead of index is the real fix.
- **Scheduler fairness is not enforced.** `tick()` returns on the first account with
  work; balance comes from recurring jobs re-arming into the future. A large funnel
  backlog will monopolise the loop.
- **Working hours are global**, not per account or platform.

## Running things

```bash
npm run setup      # first run on a new machine: .env, API token, AI key, database. Re-runnable.
npm run doctor     # read-only health check: node, keys, live model id, db, connected accounts
npm run smoke      # 59 checks. No credentials, no network, no browser. Run this first.
npm run typecheck
npm run accounts   # read-only: what is connected, what it can do, today's budget
npm run login:all  # walks every account that has no live session, one browser each
npm run unlock:x   # one-time: X encrypts DMs behind a passcode you type yourself
npm run rail -- --dry   # local-only integration (untracked). Claims nothing.
npm run rail       # publish it. Real posts, on real accounts.
npm run start      # dashboard + control API on :4310. Engine stays stopped until you press start.
npm run mcp        # MCP server on stdio (23 tools)
```

Never run the engine against a real account to test a code change. `npm run smoke`
covers the engine; the browser layer needs a deliberate, watched, headed run.

## The security model

- The dashboard page **contains the API token** so the browser can call the API, and
  that token can publish to a real account. `/` is therefore only unauthenticated
  because the socket is loopback-only.
- `BIND_HOST` defaults to `127.0.0.1`. Non-loopback **with an empty `API_TOKEN` is a
  refusal to start**, not a warning, and the dashboard route demands the token too.
- Bearer comparison is `timingSafeEqual` on equal-length buffers.
- `.env` is written mode `600` by setup; `npm run doctor` re-checks it.
- `data/` (database + browser profiles) is git-ignored. A profile directory IS a
  logged-in session — treat it exactly like a password.

## Where to make a change

| To add | Do |
|---|---|
| A template | An object in `templates/<platform>/bank.json`. No code change, no restart. |
| A voice or behaviour rule | `instructions/GLOBAL.md` or `instructions/<platform>.md`. Read fresh per generation. |
| A hard-enforced rule | `src/content/gate.ts` **and** `gateRulesForPrompt()` so the model is told **and** a smoke check. |
| A funnel action | An `ActionDef` in `src/actions/`, registered in `actions/index.ts`. Auto-exposed via `list_actions`. |
| A platform | `src/platforms/<id>.ts` + `templates/<id>/` + `instructions/<id>.md`. |
| A job kind | A branch in `runJob()` **and** an entry in `JOB_KINDS` — the CLI and the MCP tool both read that array, and a smoke check asserts every kind in it is handled. |
| A targeted platform action | An optional method on `PlatformAdapter`, implemented in the adapter, listed in `TARGETED` in `platforms/index.ts` so the capability matrix reports it, plus a cap in the adapter's `defaultLimits`. |
