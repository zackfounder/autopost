import {
  getAccount,
  listAccounts,
  listRunningCampaigns,
  listSteps,
  nextDueLead,
  logAction,
  setCampaignStatus,
} from '../db/index.ts';
import { getAction } from '../actions/index.ts';
import { isPlatformId } from '../platforms/index.ts';
import { checkQuota, insideWorkingHours, isGloballyPaused, loadPacing } from './limits.ts';
import { runStep } from './runner.ts';
import { runJob, type JobOutcome } from './jobs.ts';
import { nextDueJob, finishJob, setJobState } from '../db/content.ts';
import { openSession, checkLogin, closeAllSessions, type Session } from '../browser/session.ts';
import { gapMs, sleep } from '../browser/human.ts';
import { buildAiClient } from '../ai/client.ts';
import { env } from '../config/env.ts';
import type { Account, Campaign, LeadWithState, Step } from '../db/types.ts';

const IDLE_SLEEP_MS = 60_000;

export class Engine {
  private running = false;
  private stopping = false;
  private readonly logLines: string[] = [];
  private lastStatus = 'stopped';

  log(line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`;
    this.logLines.push(stamped);
    if (this.logLines.length > 500) this.logLines.shift();
    console.log(stamped);
  }

  tail(n = 80): string[] {
    return this.logLines.slice(-n);
  }

  status() {
    return { running: this.running, state: this.lastStatus, paused: isGloballyPaused() || env.paused };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.log('engine started');
    void this.loop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.log('engine stopping — will finish the current action first');
    while (this.running) await sleep(200);
    await closeAllSessions();
    this.log('engine stopped');
  }

  private setState(s: string): void {
    if (this.lastStatus !== s) {
      this.lastStatus = s;
      this.log(`state: ${s}`);
    }
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopping) {
        const slept = await this.tick();
        if (this.stopping) break;
        await sleep(slept);
      }
    } catch (err) {
      this.log(`engine crashed: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }

  /** One unit of work. Returns how long to sleep afterwards, in ms. */
  private async tick(): Promise<number> {
    if (env.paused || isGloballyPaused()) {
      this.setState('paused');
      return IDLE_SLEEP_MS;
    }

    const window = insideWorkingHours();
    if (!window.open) {
      this.setState(window.reason ?? 'outside_window');
      return Math.min(window.retryInSeconds * 1000, 15 * 60_000);
    }

    const campaigns = listRunningCampaigns();

    // Every account that has either a running campaign or a due job. One browser
    // per account, one action at a time, accounts serviced round-robin.
    const byAccount = new Map<number, Campaign[]>();
    for (const c of campaigns) {
      const arr = byAccount.get(c.account_id) ?? [];
      arr.push(c);
      byAccount.set(c.account_id, arr);
    }
    for (const a of listAccounts()) {
      if (!byAccount.has(a.id) && nextDueJob(a.id)) byAccount.set(a.id, []);
    }

    if (byAccount.size === 0) {
      this.setState('no running campaigns or due jobs');
      return IDLE_SLEEP_MS;
    }

    for (const [accountId, accountCampaigns] of byAccount) {
      if (this.stopping) return 0;

      const account = getAccount(accountId);
      if (!account) continue;
      // A row can point at a platform this build no longer has an adapter for.
      // Skipping is right: the alternative is throwing inside the tick and
      // taking every other account's work down with it.
      if (!isPlatformId(account.platform)) {
        this.log(`skipping ${account.name}: platform "${account.platform}" is no longer supported`);
        continue;
      }

      const job = nextDueJob(accountId);
      const work = job ? null : this.pickWork(account, accountCampaigns);
      if (!job && !work) continue;

      let session: Session;
      try {
        session = await openSession(account);
      } catch (err) {
        this.log(`could not open browser for ${account.name}: ${String(err)}`);
        return IDLE_SLEEP_MS;
      }

      const login = await checkLogin(session);
      if (login !== 'ok') {
        this.setState(`account ${account.name}: ${login}`);
        this.log(
          login === 'checkpoint'
            ? `${account.name} (${account.platform}) hit a challenge page — everything for this account is on hold. ` +
              'Open the browser window, clear it by hand, then resume.'
            : `${account.name} is logged out — run "npm run login -- ${account.name}".`,
        );
        logAction({
          accountId: account.id,
          action: 'session_check',
          status: 'blocked',
          counted: false,
          detail: { login },
        });
        return 10 * 60_000;
      }

      this.setState(`working ${account.name} (${account.platform ?? 'linkedin'})`);
      const pacing = loadPacing();
      const ai = buildAiClient();

      // Jobs (posting, feed engagement, DMs) take priority over the funnel: they
      // are time-anchored, the funnel is not.
      if (job) {
        setJobState(job.id, 'running');
        let outcome: JobOutcome;
        try {
          outcome = await runJob(
            { page: session.page, account, ai, pacing, log: (l) => this.log(l) },
            job,
          );
        } catch (err) {
          outcome = { ok: false, detail: {}, error: String(err) };
        }
        finishJob(job, outcome.ok ? 'done' : 'failed', outcome.error);
        logAction({
          accountId: account.id,
          action: `job:${job.kind}`,
          status: outcome.ok ? 'ok' : 'fail',
          counted: false,
          detail: { ...outcome.detail, error: outcome.error ?? null },
        });
        if (!outcome.ok) this.log(`job ${job.kind} failed: ${outcome.error}`);
        return gapMs(pacing);
      }

      await runStep(
        { page: session.page, account, ai, pacing, onLog: (l) => this.log(l) },
        work!.campaign,
        work!.step,
        work!.lead,
      );

      // The human gap between two actions. This is the single most important
      // safety property in the whole engine.
      return gapMs(pacing);
    }

    this.setState('nothing due');
    return IDLE_SLEEP_MS;
  }

  /**
   * Linked Helper's queue rule, implemented: scan the workflow from the LAST step
   * backwards and service the first step that has someone due and has quota left.
   * That drains people who are already deep in the funnel before pulling new
   * people in at the top.
   */
  private pickWork(
    account: Account,
    campaigns: Campaign[],
  ): { campaign: Campaign; step: Step; lead: LeadWithState } | null {
    for (const campaign of campaigns) {
      const steps = listSteps(campaign.id).filter((s) => s.enabled === 1);
      if (steps.length === 0) {
        setCampaignStatus(campaign.id, 'paused');
        this.log(`campaign "${campaign.name}" has no enabled steps — paused`);
        continue;
      }

      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i]!;
        const lead = nextDueLead(campaign.id, step.position);
        if (!lead) continue;

        const def = getAction(step.action);
        if (def?.ratedLimited) {
          const quota = checkQuota(account.id, step.action);
          if (!quota.allowed) {
            this.setState(`quota: ${quota.reason} (${quota.used}/${quota.cap})`);
            continue; // try an earlier step / another campaign instead of stalling
          }
        }
        return { campaign, step, lead };
      }
    }
    return null;
  }
}

export const engine = new Engine();
