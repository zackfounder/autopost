# Handoff: how this system actually works

For an agent session picking this repo up cold. Read this top to bottom once; it is
the complete mental model. `README.md` is the user-facing version,
`docs/AGENT-CONTROL.md` is the safety model, `docs/ARCHITECTURE.md` is the Linked
Helper teardown the design came from.

---

## 1. What this is in one paragraph

A single Node process that drives four real browsers — one per social account
(LinkedIn, X, Quora, Indie Hackers) — to post, DM, and engage with feeds on the
owner's behalf, plus run a LinkedIn outreach funnel. It is architecturally a clone of
Linked Helper: the session lives locally in a persistent Chromium profile, work is a
queue of small steps, and safety comes from pacing and rolling rate caps rather than
from cloaking. The agents are autonomous but can only publish text derived from an
approved template bank and passed by a content gate enforced in code.

## 2. The two queues

This is the single most important thing to understand. **There are two independent
queues, and the scheduler services both.**

| | **Funnel queue** | **Job queue** |
|---|---|---|
| Table | `campaign_leads` | `jobs` |
| Unit of work | one lead at one step of a campaign | one scheduled job for one account |
| Driven by | leads becoming eligible | wall-clock (`run_at`) |
| Used for | LinkedIn outreach (invite → filter → message) | posting, feed engagement, DMs |
| Code | `src/engine/runner.ts` | `src/engine/jobs.ts` |

They share the browser, the rate limiter, the working-hours window and the audit log.
Jobs take priority when both are due, because jobs are time-anchored and the funnel
is not.

## 3. Control flow, precisely

### `Engine.tick()` — `src/engine/scheduler.ts`

One tick does **at most one action**, then returns how long to sleep.

```
1. global pause?              → sleep 60s
2. outside working hours?     → sleep min(retryIn, 15min)
3. build the account set:
     every account with a running campaign
   + every account with a due job
   none? → sleep 60s
4. for each account in that set:
     job = nextDueJob(account)
     work = job ? null : pickWork(account)       // funnel
     neither? → continue to next account
     open persistent session (cached per account id)
     checkLogin() → not ok? log, mark account, sleep 10min, RETURN
     if job:  runJob() → finishJob() → logAction() → RETURN gapMs()
     else:    runStep()                          → RETURN gapMs()
5. nobody had work → sleep 60s
```

`gapMs()` is the human pause: a random 35–140 seconds from `pacing`. This is the
single most important safety property in the engine.

**Fairness caveat, be aware of it:** step 4 returns on the *first* account that had
work. It is not enforced round-robin. In practice it self-balances because a
completed recurring job re-arms itself hours into the future, so that account stops
being due. But an account with a large funnel backlog **will monopolise the loop**
until its queue drains or hits a cap. If that becomes a problem, rotate the starting
index of the `byAccount` iteration.

### `pickWork()` — the Linked Helper rule

For each running campaign, scan steps from the **last position backwards** and take
the first step that has a due lead and passes its quota. This drains people already
deep in the funnel before pulling new people in at the top. Do not "fix" this to scan
forwards; it is deliberate and documented in `ARCHITECTURE.md §2`.

### `runStep()` — `src/engine/runner.ts`

All queue-state transitions live here. Actions stay close to pure.

```
unknown action        → exitLead('failed'), log, done
degree gate fails     → advance past this step (an `invite` cannot process a 1st-degree)
parse vars from JSON
def.run(ctx)          → ActionResult   (a throw becomes {status:'fail', waitSeconds:600})
persist ctx.vars
counted = result.counted ?? (status==='ok' && def.ratedLimited)
logAction(...)
applyResult(...)
```

`applyResult` in priority order:

| Result | Effect |
|---|---|
| `exit` set | `exitLead(state, reason)`. Terminal. |
| `status:'blocked'` | Hold. **Does not burn an attempt.** LinkedIn pushed back (checkpoint, weekly invite cap). |
| `status:'fail'` | `bumpAttempts`; at 3 → `exitLead('failed')`; else hold for `waitSeconds ?? 900`. |
| `advance:false` | Hold for `waitSeconds ?? 3600`. Stay on this step. |
| otherwise | Advance by `detail.jumped ?? 1`; past the last step → `exitLead('done')`. |

### `runJob()` — `src/engine/jobs.ts`

Four kinds:

- **`generate_post`** — picks a template by rotation, generates, gates, writes a
  `content` row as `queued` (passed) or `blocked` (failed). **No browser touched.**
- **`publish_due`** — takes the oldest due `queued` row, checks quota, **re-gates it**,
  navigates to `target_ref` if set, calls `adapter.post()`. Publishes **one** item
  per run.
- **`engage_feed`** — reads the feed, one structured model call decides the whole
  batch, then acts within caps. Comments go through `generate()` → gate like any
  other outbound text.
- **`send_dm`** — takes `body` (gated) or `brief` (generated + gated), then
  `adapter.dm()`.

**Asymmetry worth knowing:** `engage_feed` loops internally up to `maxActions`, with a
full human gap between each. One job run can therefore hold the browser for several
minutes, unlike every other path which is strictly one-action-per-tick. That is
deliberate — a feed session that likes three things over four minutes looks like a
person reading a feed — but it means the account is busy for that whole window.

`finishJob()`: a recurring job re-arms at `now + interval + up to 20% jitter`; a
one-shot is marked `done`; a one-shot that failed three times is `disabled` rather
than looping.

## 4. The content pipeline

```
brief + facts
   ↓
pickTemplate()      LRU rotation per account, from templates/<platform>/bank.json
   ↓
system prompt  =  instructions/GLOBAL.md
                + instructions/<platform>.md
                + templateBrief(template)      ← the shape and every slot's rules
                + gateRulesForPrompt()         ← the coded rules, as prose
   ↓
ai.text()
   ↓
gate()  ──fail──→  repair prompt (every violation verbatim) ──→ retry, max 3
   ↓ pass
content row (state='queued')
   ↓
publish_due job → gate() AGAIN → adapter.post()
```

**Generation and publication are separate jobs on purpose.** A blocked draft becomes a
row you can read and fix, and the expensive model call never sits inside the publish
path.

### The gate — `src/content/gate.ts`

Ported from crew-hq's `checkContent`. The reason it exists is recorded there: a test
post correctly declared its own account type and then broke that exact rule in the
body, and the reviewing model passed it. **Prompting alone did not hold.** So every
rule that can be checked by code is checked by code, on every path, every time.

**There is deliberately no bypass parameter.** Do not add one. If a caller needs an
exception, the correct change is to the template bank or to the gate's rules, not to
add a flag.

Seven sections, in order: template binding → unfilled placeholders → voice rules
(banned words, em-dashes, emoji, engagement bait, hashtag runs, AI tells, raw KPI
column names) → outreach-mechanics ban → platform shape (char/line caps, links,
per-tweet caps inside a thread) → template constraints (`requiresNumber`,
`requiresTitle`, `minChars`, `isThread`) → repetition (>70% Jaccard word overlap
against recent published bodies on that account).

### ⚠️ In mock mode, all content generation blocks

`MockClient.text()` returns a string containing an em-dash, which the gate bans. So
**without `ANTHROPIC_API_KEY` set, every `draft_content` / `generate_post` returns
`blocked`.** That is correct behaviour, not a bug — smoke check #11 asserts exactly
this ("generation fails CLOSED"). Do not "fix" the mock to pass the gate; the funnel
and every non-content path still work fine in mock mode.

## 5. Data model

`src/db/schema.sql`, SQLite, one file. `initSchema()` runs on every boot and is
idempotent; `migrate()` adds columns additively (that is how `accounts.platform`
arrived).

| Table | Holds | Notes |
|---|---|---|
| `accounts` | one login = one browser profile = one platform | `profile_dir` is a credential |
| `campaigns` / `steps` | the outreach funnel definition | steps authored top-down, executed bottom-up |
| `leads` | people | `profile_url` normalized is the dedup key **forever** |
| `campaign_leads` | a lead's position in one funnel | the funnel queue |
| `action_log` | every attempt, ok or not | **this table IS the rate limiter** |
| `content` | every draft → publish, incl. blocked ones + why | the public record |
| `template_usage` | LRU rotation state per account | |
| `jobs` | scheduled work | the job queue |
| `feed_seen` | every post considered, action taken, reason | includes deliberate skips |
| `messages`, `suppression`, `settings` | | suppression is permanent and global |

Repositories: `src/db/index.ts` (accounts, campaigns, leads, funnel, log) and
`src/db/content.ts` (content, jobs, templates, feed). Both are plain functions over
`db()`; there is no ORM and none is wanted.

## 6. Rate limiting

`src/engine/limits.ts`. **Rolling windows, not calendar days** — 24h and 1h, computed
by counting `action_log` rows where `counted = 1`. You cannot spend a day's quota at
23:59 and another at 00:01.

Resolution order (later wins): `DEFAULT_LIMITS` → the platform adapter's
`defaultLimits` → `settings.limits` → `settings.limits.<platform>`. Settings always
win, so the dashboard and `set_limits` remain the single control.

`_total` is a ceiling across every rate-limited action for that account (100/day,
20/hour). Working hours are **global**, not per account — a known limitation.

Only `status:'ok'` on a `ratedLimited` action consumes quota. Failures are free,
which is what stops a broken selector from eating the day's budget.

## 7. Platform adapters

`src/platforms/<id>.ts`, one file each, all implementing `PlatformAdapter`
(`types.ts`). Each declares `can` (post/dm/feed/engage), `rules` (char caps, links,
threads, line caps), `defaultLimits`, `sel` (every selector), and the methods
`post` / `dm` / `readFeed` / `engage`.

Selector conventions, and they matter:

- **Never** match on generated class names. All four platforms obfuscate and rotate them.
- X uses `data-testid` consistently — prefer it there.
- Elsewhere use `aria-label`, roles, and visible text.
- **Every target is a list of candidates**, tried in order by `firstVisible()`, because
  these platforms A/B-test two or three variants of the same control simultaneously.

**`FeedItem.index` is positional.** `readFeed` records the item's index in the
rendered list, and `engage` re-locates it by that index. If the feed reflows between
read and engage, the index can point at a different post. The adapters guard with an
`isVisible()` check and bail rather than click blind, but this is the most fragile
part of the engagement path. If you harden one thing, harden this — matching on the
permalink instead of the index would be the fix.

## 8. Invariants — do not relax these without changing the tests

1. `leads.profile_url` normalized is the dedup key across every table, forever.
2. Nothing publishes without passing `gate()`, and the gate runs **again** immediately
   before the browser acts. No bypass parameter exists.
3. A post's `template_id` must be in `templates/`. That is the boundary on autonomy.
4. Generation **fails closed**. A missed post costs nothing; a bad post is public.
5. Stop-on-reply is structural, not a setting — nobody gets a follow-up after they
   answer (`src/actions/messaging.ts`).
6. The suppression list is permanent, global, and applied inside the queue query
   itself, not by callers remembering to check.
7. Failed actions never consume quota.
8. `blocked` never burns a retry attempt.
9. One browser per account, one action in flight.
10. The engine never auto-starts. A process booting must not touch a real account.

## 9. Subtleties that will confuse you

- **`delay` reads `ctx.lead.state`.** First run: state is `ready` → returns
  `advance:false` + `waitSeconds`, which sets state to `waiting`. Second run: state is
  `waiting` → returns `ok` → advances. The wait is encoded in the state transition,
  not in a timestamp column.
- **`condition` with `onFalse:'skip_next'`** returns `detail.jumped = 2`, which
  `advanceStepOrFinish` reads. That is the only path that advances by more than one.
- **`filter_connected` anchors its give-up clock in `vars`**, not on a table column,
  because nothing records when a lead first *reached a given step*.
- **Quora's `post()` refuses unless the page looks like a question page.** A Quora
  "post" is an *answer*; `target_ref` must be the question URL. The URL check is a
  crude regex heuristic and is a fair thing to improve.
- **Indie Hackers `post()` expects `Title\n\nBody`** — first line becomes the title.
- **X `splitThread()`** turns a body whose lines start `1/`, `2/` into separate
  tweets. The gate then caps each tweet at 280 individually.

## 10. Verified vs. unverified

`npm run smoke` — 45 checks, no credentials, no network, no browser. Covers URL
normalization, the three workflow-validation traps, the funnel queue end-to-end, the
rolling limiter (including failures not consuming quota), 13 gate checks, template
rotation fairness, X thread splitting, instruction loading, generation failing
closed, and job recurrence. Typecheck is clean; 23 MCP tools enumerate.

**Every platform selector is unverified.** No file in `src/platforms/` has run against
a live logged-in session on any of the four. Each platform needs one supervised
calibration run: log in, schedule one job, watch the browser headed, and fix whatever
the engine log says it could not find. Quora will need the most work — it has no
stable test-id convention.

Treat any selector-related bug report as expected, not surprising.

## 11. Extending it

| To add | Do |
|---|---|
| A funnel action | New `ActionDef` in `src/actions/`, register in `actions/index.ts`. It is automatically exposed to the agent via `list_actions`. |
| A platform | New `src/platforms/<id>.ts` implementing `PlatformAdapter`, add to `PLATFORMS`, add `templates/<id>/bank.json` and `instructions/<id>.md`. |
| A job kind | New branch in `runJob()`, plus the enum in `scripts/schedule.ts` and the `schedule_job` MCP tool. |
| A content rule | `src/content/gate.ts` **and** a line in `gateRulesForPrompt()` so the model is told, **and** a smoke check. |
| A template | An object in the relevant `bank.json`. No code change. |

Do not add a way to skip the gate. Do not make the engine auto-start. Do not have
anything in this repo type a credential.
