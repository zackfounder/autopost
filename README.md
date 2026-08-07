# pilot

A local social engine for **four accounts** — LinkedIn, X, Quora, Indie Hackers —
built on Linked Helper's architecture: one real browser per account holding a real
session, rolling rate limits, human pacing. Agents post, DM, and engage with feeds
autonomously, bounded by an approved template bank and a content gate enforced in
code.

Two docs before you touch anything:

- [`docs/AGENT-CONTROL.md`](docs/AGENT-CONTROL.md) — how the agents are controlled, and
  what they can and cannot do. **Read this one.**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the Linked Helper teardown this is built on.

> Automating these platforms violates their terms of service. The realistic downside
> is a restricted or banned account. The defaults here are a warm-up profile because
> that is what keeps accounts alive. Indie Hackers is the one where damage is
> permanent — its caps are the tightest for that reason.

---

## What each account can do

| | post | DM | feed | engage |
|---|---|---|---|---|
| **LinkedIn** | yes | yes | yes | like, comment |
| **X** | yes, incl. threads | yes | yes | like |
| **Quora** | yes (an *answer* to a question) | — | yes | upvote, comment |
| **Indie Hackers** | yes (`Title\n\nBody`) | — | yes | upvote, comment |

Plus the original LinkedIn outreach funnel (invite → filter → message → check
replies), which shares the same browser and the same limits.

## Setup

```bash
cd ~/linkedin-pilot
npm install
cp .env.example .env          # set API_TOKEN; ANTHROPIC_API_KEY optional
npm run smoke                 # 45 checks, no credentials, no network, no browser
npm run db:init
```

Then connect each account. **You log in yourself** — a real browser window opens and
waits. Nothing types a password, reads a credential, or touches 2FA.

```bash
npm run login -- main-li    --platform linkedin
npm run login -- main-x     --platform x
npm run login -- main-quora --platform quora
npm run login -- main-ih    --platform indiehackers
```

One account = one browser profile = one platform. The session lives in
`data/profiles/<name>/` on this machine. Treat that directory as a credential.

```bash
npm run accounts              # what's connected, what it can do, today's budget
npm run start                 # dashboard at http://localhost:4310
```

The engine does not auto-start. You press the button.

## Scheduling the agents

```bash
# write a LinkedIn post every day, publish whatever is queued every 2 hours
npm run schedule -- add main-li generate_post --every 1d \
  --brief "This week's real number or decision. Nothing invented." \
  --facts "MRR 180. 12 trials. Shipped the Telegram loop Tuesday."
npm run schedule -- add main-li publish_due --every 2h

# engage with the X timeline three times a day, at most 3 actions each
npm run schedule -- add main-x engage_feed --every 8h --max 3 \
  --criteria "builders posting real numbers or real technical detail"

# Indie Hackers: comments only, tight
npm run schedule -- add main-ih engage_feed --every 12h --max 2 --actions upvote,comment

npm run schedule -- list
npm run schedule -- pause 3
```

Recurrence is `90m` / `6h` / `1d`, re-armed with up to 20% jitter. Everything still
obeys working hours and rate caps.

## Commands

| Command | Does |
|---|---|
| `npm run smoke` | 45 checks: URL handling, workflow traps, queue machine, rate limiter, **the gate**, template rotation, thread splitting, job queue. No credentials, no network. |
| `npm run db:init` | Create the database, seed warm-up limits |
| `npm run login -- <name> --platform <p>` | Connect one account (interactive). `--proxy socks5://…` to pin an IP. |
| `npm run accounts` | Read-only status of every account |
| `npm run schedule -- …` | `list` / `add` / `pause` / `resume` / `rm` jobs |
| `npm run campaign -- <file.json>` | Load a LinkedIn outreach funnel |
| `npm run leads -- csv <f> --campaign 1` | Import leads |
| `npm run start` | Dashboard + control API |
| `npm run mcp` | MCP server on stdio, for Claude Code |

## Connecting your agents

```bash
claude mcp add pilot -- npx tsx ~/linkedin-pilot/src/mcp/server.ts
```

**Content and engagement:** `list_platforms`, `list_templates`, `read_instructions`,
`check_content`, `draft_content`, `queue_content`, `list_content`, `schedule_job`,
`list_jobs`, `control_job`, `feed_activity`.

**Outreach funnel:** `list_actions`, `validate_workflow`, `load_workflow`,
`list_campaigns`, `set_campaign_status`, `add_leads`, `harvest_search`.

**Control:** `engine_control`, `get_limits`, `set_limits`, `get_activity`,
`suppress_lead`.

The agents can draft, queue, publish, DM and engage with no human step. They
**cannot** invent a template, publish text that fails the gate, exceed a cap, raise
their own caps, act outside working hours, or bypass the pre-publish re-check. Those
live in the engine, not in the tool descriptions.

Everything is also plain HTTP with `Authorization: Bearer $API_TOKEN`.

## Changing what they're allowed to say

| To change | Edit | Effect |
|---|---|---|
| Voice, rules, engagement bar | `instructions/GLOBAL.md`, `instructions/<platform>.md` | Next generation |
| The approved shapes | `templates/<platform>/bank.json` | Next generation |
| The hard-enforced rules | `src/content/gate.ts` | Restart |
| Rate caps, working hours | Dashboard, `POST /api/limits`, or `set_limits` | Immediate |

No redeploy for the first two. That is the point — the template bank is the control
surface, not the code.

## Layout

```
instructions/         GLOBAL.md + one file per platform — the agents' brief
templates/            5 approved shapes per platform — the hard whitelist
src/
  platforms/          one adapter per platform: selectors, post, dm, feed, engage
  content/            templates (rotation), gate (code-enforced rules), generate (gen→gate→repair)
  engine/             limits, jobs (post/engage/dm), runner (funnel step), scheduler, workflow
  browser/            persistent Chromium session, human pacing, LinkedIn Voyager reads
  actions/            outreach funnel actions
  sources/            lead collection
  ai/                 AiClient interface + Claude and mock
  server/             HTTP API + dashboard
  mcp/                MCP server
  db/                 schema.sql + typed repositories
docs/                 AGENT-CONTROL.md, ARCHITECTURE.md
```

## What is verified and what is not

**Verified** (`npm run smoke`, no credentials): URL normalization; the three
workflow-validation traps; the funnel queue end-to-end; the rolling rate limiter
including that failed attempts don't consume quota; **13 separate content-gate
checks** including template binding, banned words, placeholders, outreach mechanics
and near-duplicates; template rotation fairness over 6 picks; X thread splitting and
per-tweet caps; instructions loading for all four platforms; generation failing
closed; the job queue and recurrence parsing. Typecheck is clean and the MCP server
enumerates its tools.

**Not verified: every platform selector.** `src/platforms/*.ts` has never run against
a live logged-in session on any of the four. They are written defensively —
`data-testid` on X, `aria-label` and roles elsewhere, several candidates per target,
never obfuscated class names — but each platform needs one supervised calibration
run: log in, schedule one job, watch the browser, and fix whatever the engine log
says it could not find. Quora will need the most work; it has no stable test-id
convention. Every selector for a platform lives in that platform's single file.
