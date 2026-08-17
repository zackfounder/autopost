# linkedin-browser-agent

**Self-hosted LinkedIn and X automation.** An AI agent that runs your **LinkedIn**
— profile and company page, posts, comments, reactions, reposts, DMs, invitations,
replies to your own comment threads — and your **X** account, from your own
logged-in browser, on your own machine.

No platform API keys, no approved developer app, no monthly SaaS, nothing leaving
your laptop. One free LLM key (Groq) and a browser you log into yourself.

Built on Linked Helper's architecture: one real browser per account holding a real
session, rolling rate limits, human pacing. The agent posts, engages and replies
autonomously, bounded by an approved template bank and a content gate enforced in
code with no bypass.

Two docs before you touch anything:

- [`docs/AGENT-CONTROL.md`](docs/AGENT-CONTROL.md) — how the agents are controlled, and
  what they can and cannot do. **Read this one.**
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the Linked Helper teardown this is built on.

> Automating these platforms violates their terms of service. The realistic downside
> is a restricted or banned account. The defaults here are a warm-up profile because
> that is what keeps accounts alive — one post a day, a handful of comments, gaps of
> 35–140 seconds between actions. Raise them slowly, over weeks, or not at all.

---

## What it does

**LinkedIn — the full surface:**

| | |
|---|---|
| **Post** | to your profile, or as a company page you administer |
| **Comment** | on any post you name, or on what the feed serves up |
| **React** | like, celebrate, support, love, insightful, funny |
| **Repost** | plain, or with your own line on top |
| **Reply** | to the comments on your own posts — the thing everyone drops |
| **DM** | 1st-degree connections |
| **Invitations** | accept the ones worth accepting, withdraw stale ones you sent |
| **Follow** | people and company pages |
| **Profile visits** | they get notified you looked. Linked Helper's warm-up step |
| **Delete** | remove a post you published, confirmed gone before it reports success |
| **Outreach funnel** | invite → filter_connected → message → check_replies |

**X:** posts and threads, DMs, feed reading, likes.

Everything a model writes — post, comment, reply, DM, repost commentary — passes the
content gate before it can reach an account, and again immediately before publishing.

## Setup — about five minutes

You need **Node 22.5+** and one **free** Groq key. That is the whole shopping list.

| | | |
|---|---|---|
| 1 | Get a free key at [console.groq.com/keys](https://console.groq.com/keys) | ~1 min, no card |
| 2 | `npm install` | ~2 min, downloads Chromium |
| 3 | `npm run setup`, paste the key when asked | ~30 sec |
| 4 | Log into LinkedIn in the window it opens | ~1 min |

```bash
git clone https://github.com/zackfounder/linkedin-browser-agent.git
cd linkedin-browser-agent
npm install
npm run setup
```

`npm run setup` opens **a page in your browser**, not a wall of prompts. Paste the
key and watch it get verified against Groq, click one button to open the LinkedIn
login window, and schedule your first post — with a live checklist going green as
each piece lands.

It writes `.env` (mode `600`), generates the control-API token, creates the
database, and copies the example brief and template bank into files that are yours
to edit. Safe to re-run; nothing already set is overwritten. The page is served from
127.0.0.1 for the two minutes it exists, with no CDN, no fonts and no analytics.

No browser on that machine? `npm run setup:cli` is the same flow in the terminal.

<details>
<summary>Why a free key is the default, and how to use a paid one</summary>

These are two-hundred-word posts written against a template that already dictates
their shape, so a frontier model buys nothing. Groq's free tier runs the whole
engine. Anthropic is available but strictly opt-in: it is used **only** when
`ANTHROPIC_API_KEY` *and* `AI_PAID=true` are both set — a key sitting in `.env` is
not consent to spend it. With no key at all you get a deterministic mock: every
step works, but generated posts are always blocked by the gate, on purpose, so stub
text can never reach a real account.

</details>

Then connect each account. **You log in yourself** — a real browser window opens and
waits. Nothing types a password, reads a credential, or touches 2FA.

```bash
npm run login -- main-li  --platform linkedin
npm run login -- main-x   --platform x
```

One account = one browser profile = one platform. The session lives in
`data/profiles/<name>/` on this machine. Treat that directory as a credential.

### What is secret, and what protects it

Nothing here phones home. Everything — the database, the sessions, the keys — is a
file on your machine.

| | Where | Protected by |
|---|---|---|
| AI key + control token | `.env` | git-ignored, and `setup` sets it to mode `600` |
| Logged-in sessions | `data/profiles/<name>/` | git-ignored. **This is the real crown jewel** — anyone with the directory is logged in as you |
| Dashboard + control API | `localhost:4310` | bound to `127.0.0.1`, so nothing on your network can reach it |

The dashboard hands the API token to whoever loads the page, and that token can
publish to your real account — which is exactly why the socket is loopback-only. If
you set `BIND_HOST` to anything reachable, the server **refuses to start** without an
`API_TOKEN`, and the dashboard route starts demanding it too. `npm run doctor` checks
all of this and tells you what is wrong.

The one thing to keep in mind: `data/` is not in git, so it is also not in any
backup that only covers your repo.

```bash
npm run doctor                # is anything wrong? read-only, opens no browser
npm run accounts              # what's connected, what it can do, today's budget
npm run start                 # dashboard at http://localhost:4310
```

The engine does not auto-start. You press the button.

### Posting as a LinkedIn company page

A page post needs the page's own composer URL, passed when the job is created. There
is deliberately **no fallback** to the personal profile: if the page composer cannot
be opened, the post fails rather than landing on your own feed under your own name.

## Scheduling the agents

```bash
# write a LinkedIn post every day, publish whatever is queued every 2 hours
npm run schedule -- add main-li generate_post --every 1d \
  --brief "This week's real number or decision. Nothing invented." \
  --facts "MRR 180. 12 trials. Shipped the Telegram loop Tuesday."
npm run schedule -- add main-li publish_due --every 2h

# answer the comments on your own posts, twice a day, at most 3 replies
npm run schedule -- add main-li reply_comments --every 12h --max 3

# accept the invitations worth accepting, and withdraw ones nobody answered
npm run schedule -- add main-li grow_network --every 1d \
  --criteria "founders, engineers and people who actually build things" \
  --accept-max 10 --withdraw-after 21

# engage with the X timeline three times a day, at most 3 actions each
npm run schedule -- add main-x engage_feed --every 8h --max 3 \
  --criteria "builders posting real numbers or real technical detail"

# one specific post: react, comment, and share it
npm run schedule -- add main-li engage_post --at now \
  --url "https://www.linkedin.com/feed/update/urn:li:activity:123" \
  --reaction insightful \
  --brief "agree with the retention point, add what we measured"

npm run schedule -- list
npm run schedule -- pause 3
```

**Job kinds:** `generate_post`, `publish_due`, `engage_feed`, `send_dm`,
`engage_post`, `reply_comments`, `grow_network`, `visit_profiles`, `follow_targets`.

Recurrence is `90m` / `6h` / `1d`, re-armed with up to 20% jitter. Everything still
obeys working hours and rate caps.

## Commands

| Command | Does |
|---|---|
| `npm run setup` | The visual wizard: key, login, first post. Re-runnable. |
| `npm run setup:cli` | The same, in the terminal |
| `npm run doctor` | Read-only health check: node, keys, model, bind address, `.env` permissions, accounts |
| `npm run selftest` | 46 checks driving the real adapter through a real browser against a fake LinkedIn. No account, no network |
| `npm run smoke` | 74 checks: URL handling, workflow traps, queue machine, rate limiter, **the gate**, template rotation, thread splitting, job queue. No credentials, no network. |
| `npm run db:init` | Create the database |
| `npm run login -- <name> --platform <p>` | Connect one account (interactive). `--proxy socks5://…` to pin an IP. |
| `npm run accounts` | Read-only status of every account. `-- forget <name>` removes one |
| `npm run schedule -- …` | `list` / `add` / `pause` / `resume` / `rm` jobs |
| `npm run campaign -- <file.json>` | Load a LinkedIn outreach funnel |
| `npm run leads -- csv <f> --campaign 1` | Import leads |
| `npm run start` | Dashboard + control API |
| `npm run mcp` | MCP server on stdio, for Claude Code |

## Connecting your agents

```bash
claude mcp add linkedin -- npx tsx /path/to/linkedin-browser-agent/src/mcp/server.ts
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

## Changing what it's allowed to say

Setup copies `instructions/*.example.md` and `templates/*/bank.example.json` into
files of your own. **Yours are git-ignored** — pulling will never overwrite your
voice, and your voice is never in a commit.

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
  ai/                 AiClient interface + Groq (free), Claude (opt-in), and mock
  server/             HTTP API + dashboard
  mcp/                MCP server
  db/                 schema.sql + typed repositories
docs/                 AGENT-CONTROL.md, ARCHITECTURE.md
```

## What is verified and what is not

### `npm run selftest` — the browser layer, proven

A real headless Chromium, the real adapter, and every linkedin.com request answered
from local fixtures. It drives posting, the six reactions through the hover flyout,
comments, replies, both repost paths, follows, profile visits, the invitation
manager and deletion — asserting the outcome the page recorded, never just that a
call returned ok.

It found four real bugs the first time it ran, including one that reported ten
successful invitation withdrawals while the list sat untouched.

**What it cannot prove:** that the fixtures match what LinkedIn serves today. They
are a reconstruction. Passing is what makes one supervised live run worth doing —
it is not a substitute for it.

**Verified** (`npm run smoke` — 74 checks, no credentials): URL normalization; the three
workflow-validation traps; the funnel queue end-to-end; the rolling rate limiter
including that failed attempts don't consume quota; **13 separate content-gate
checks** including template binding, banned words, placeholders, outreach mechanics
and near-duplicates; template rotation fairness over 6 picks; X thread splitting and
per-tweet caps; instructions loading for both platforms; every scheduleable job kind
being handled; invitation-age parsing; platform caps outranking the seeded defaults;
generation failing
closed; the job queue and recurrence parsing. Typecheck is clean and the MCP server
enumerates its tools.

**Not verified against the real site: every platform selector.** `src/platforms/*.ts`
has never run against a live logged-in session — only against the fixtures above.
They are written defensively —
`data-testid` on X, `aria-label` and roles elsewhere, several candidates per target,
never obfuscated class names — but each platform needs one supervised calibration
run: log in, schedule one job, watch the browser, and fix whatever the engine log
says it could not find. Every selector for a platform lives in that platform's
single file, and the newer LinkedIn actions (reactions flyout, invitation manager,
comment replies) have had the least exposure of all.
