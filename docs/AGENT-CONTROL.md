# How the agents are controlled

Four accounts, fully autonomous, and still safe to leave running. That combination
comes from one idea: **the agent chooses what to say, but not what shape to say it
in, and not whether it gets published.**

Three layers, in the order they run.

```
  instructions/*.md        ── the brief the model reads (persuadable)
        ↓
  templates/<platform>/    ── 5 approved shapes per platform (a hard whitelist)
        ↓
  src/content/gate.ts      ── code that inspects the finished text (not persuadable)
        ↓
  publish
```

A draft that fails the gate is stored as `blocked` and never reaches a browser. The
gate runs again immediately before publishing, so a body edited after drafting
cannot slip through either.

---

## 1. `instructions/` — the brief

Plain markdown, read fresh on every generation. Edit and the next post uses the new
version; no restart, no redeploy.

| File | What it holds |
|---|---|
| `GLOBAL.md` | Who you are, the voice rules, the seven absolute Nevers, the engagement bar |
| `linkedin.md` | Six-line shape, the approved reference post, no-sell-after, one hashtag |
| `x.md` | 280 default, thread rules, likes only, DM gating |
| `quora.md` | A "post" is an ANSWER, answer in the first sentence, no generic advice |
| `indiehackers.md` | `Title\n\nBody`, every post needs a real number or a real failure |

`GLOBAL.md` loads first, the platform file loads on top and wins on conflicts.

**This layer is advisory.** A model can be talked out of an instruction — that is
precisely why the next two layers exist.

## 2. `templates/` — the approved shapes

Five per platform, in `templates/<platform>/bank.json`. Each one is:

```json
{
  "id": "linkedin.uncomfortable-number",
  "name": "The uncomfortable number",
  "when": "You have a real number about your own position that could look bad.",
  "skeleton": "{{opening_action_with_number}}\n{{the_math_spelled_out}}\n…",
  "slots": { "opening_action_with_number": "A concrete thing you DID, with a real number…" },
  "constraints": { "maxLines": 6, "maxChars": 900, "requiresNumber": true }
}
```

The agent picks a template by **least-recently-used rotation**, per account. It
cannot post the same shape twice while an unused one exists, and across five posts
you get all five shapes. It fills the slots; it never edits the skeleton.

**A post whose `template_id` is not in this bank is rejected by code.** This is the
line between "an AI writing posts for you" and "an AI that can say anything on your
accounts."

To change what your accounts are allowed to say, edit these files. To add a sixth
shape, add a sixth object. No code change.

## 3. `src/content/gate.ts` — the part that cannot be argued with

Ported from crew-hq's `checkContent`, and it exists for the reason recorded there:
prompting alone did not hold. A test post correctly declared its own account type
and then broke that exact rule in the body, and the chief model passed it. So every
rule that *can* be checked by code is checked by code, on every path, every time.

There is deliberately **no bypass parameter**. Not a flag, not an override, not a
"force" argument. What it checks:

| | |
|---|---|
| Template binding | `template_id` must be in the approved bank, and must belong to this platform |
| Placeholders | `{{slot}}`, `[your company]`, `<PLACEHOLDER>` left in the copy |
| Banned words | The full read-aloud-test list from `BRAND_VOICE.md` |
| Em-dashes, emoji, hashtag runs | Rejected outright |
| Engagement bait | "thoughts?", "let me know in the comments", "who else" |
| Raw KPI column names | `mrr_usd`, `total_users` etc. in prose |
| AI tells | "as an AI", "language model" |
| **Outreach mechanics** | DM scripts, lead lists, prospect CRMs, automation tooling — the audience overlaps with the targets |
| Platform shape | Char caps, line caps, links-allowed, per-tweet caps inside a thread |
| Template constraints | `requiresNumber`, `requiresTitle`, `minChars`, `isThread` |
| Repetition | >70% word overlap with anything this account already published |

Generation runs **generate → gate → repair → gate**, up to three rounds. The repair
prompt is handed every violation verbatim and told the checks are code and cannot be
overridden. If it never passes, the result is `ok: false` and nothing publishes.

**Failing closed is the design.** A missed post costs nothing. A bad post is public.

---

## What the agent can and cannot do

| Can | Cannot |
|---|---|
| Choose which of five shapes fits the material | Invent a sixth shape |
| Write every word inside the shape | Publish text that fails any coded rule |
| Decide what to upvote, like, comment on, or skip | Exceed a rate cap, or raise its own caps |
| Schedule its own jobs and change their cadence | Act outside working hours |
| Draft, queue, and publish without asking you | Bypass the pre-publish re-check |
| Send DMs on LinkedIn and X | DM on Quora or Indie Hackers (no such surface) |
| Read its own audit trail | Delete or edit the audit trail |
| Decide to publish nothing | Log in, or touch a credential |

## The job kinds

Scheduled work, per account, with `"90m"`/`"6h"`/`"1d"` recurrence (re-armed with up
to 20% jitter so nothing fires at the same minute two days running).

| Kind | Does |
|---|---|
| `generate_post` | Picks a template, writes, gates, queues. No browser. |
| `publish_due` | Publishes **one** queued item, after re-gating it. |
| `engage_feed` | Reads the feed, one model call decides the whole batch, then likes/upvotes/comments within caps. |
| `send_dm` | Drafts (or takes a body), gates, sends. |

Generation and publication are separate jobs on purpose: a blocked draft is a row
you can read and fix, and the expensive model call never sits inside the publish
path.

## Rate limits, per platform

Adapter defaults, overridable in settings (settings always win):

| | post/day | dm/day | like or upvote/day | comment/day |
|---|---|---|---|---|
| LinkedIn | 1 | 20 | 30 | 8 |
| X | 4 | 12 | 40 | — |
| Quora | 2 | — | 25 | 6 |
| Indie Hackers | 1 | — | 15 | 4 |

Indie Hackers is the tightest deliberately: it is small enough that volume reads as
spam, and the reputational damage there does not decay.

Windows are **rolling** 24h and 1h, not calendar days.

## The audit trail

Nothing is ephemeral. `content` holds every draft including the blocked ones and why
they were blocked. `feed_seen` holds every post considered, the action taken, and the
one-sentence reason — including deliberate skips. `action_log` holds every attempt,
successful or not, and is what the rate limiter counts.

`npm run accounts` and the dashboard read all of it. So does the `list_content`,
`feed_activity` and `get_activity` MCP tools.
