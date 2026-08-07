import { countRecentActions, getSetting, setSetting } from '../db/index.ts';
import { getPlatform } from '../platforms/index.ts';
import { DEFAULT_PACING } from '../browser/human.ts';
import type { Limits, Pacing, WorkingHours } from '../db/types.ts';

/**
 * Conservative by default, and deliberately so. Linked Helper's own guidance is
 * ~10-25 invites/day for a new account and under ~100-150 total actions/day for a
 * mature one; LinkedIn separately enforces a weekly invitation cap that no tool
 * can raise. These numbers are a warm-up profile — raise them slowly, over weeks,
 * or don't raise them at all.
 *
 * Windows are ROLLING, not calendar-day. You cannot spend a day's quota at 23:59
 * and another at 00:01.
 */
export const DEFAULT_LIMITS: Limits = {
  invite: { perDay: 15, perHour: 4 },
  message: { perDay: 25, perHour: 6 },
  visit_profile: { perDay: 60, perHour: 12 },
  follow: { perDay: 20, perHour: 5 },
  unfollow: { perDay: 20, perHour: 5 },
  withdraw_stale_invites: { perDay: 2, perHour: 1 },
  /** Ceiling across every rate-limited action combined. */
  _total: { perDay: 100, perHour: 20 },
};

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  start: '09:15',
  end: '17:45',
  days: [1, 2, 3, 4, 5],
  startJitterMinutes: 55,
};

export const loadLimits = () => ({ ...DEFAULT_LIMITS, ...getSetting<Limits>('limits', {}) });
export const loadWorkingHours = () =>
  ({ ...DEFAULT_WORKING_HOURS, ...getSetting<Partial<WorkingHours>>('workingHours', {}) });
export const loadPacing = () =>
  ({ ...DEFAULT_PACING, ...getSetting<Partial<Pacing>>('pacing', {}) });

export const saveLimits = (l: Limits) => setSetting('limits', l);
export const saveWorkingHours = (w: WorkingHours) => setSetting('workingHours', w);
export const savePacing = (p: Pacing) => setSetting('pacing', p);

export const isGloballyPaused = () => getSetting<boolean>('paused', false);
export const setGloballyPaused = (v: boolean) => setSetting('paused', v);

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Stable per-day jitter. Same value all day, different value tomorrow — so the
 * account never starts at exactly the same clock time two days running, but also
 * doesn't flap minute to minute.
 */
function dailyJitter(date: Date, maxMinutes: number): number {
  if (maxMinutes <= 0) return 0;
  const key = date.toISOString().slice(0, 10);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % (maxMinutes + 1);
}

export interface WindowCheck {
  open: boolean;
  reason?: string;
  /** Seconds until the window is expected to open. */
  retryInSeconds: number;
}

export function insideWorkingHours(now = new Date()): WindowCheck {
  const wh = loadWorkingHours();
  if (!wh.days.includes(now.getDay())) {
    return { open: false, reason: 'outside_working_days', retryInSeconds: 30 * 60 };
  }
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = hhmmToMinutes(wh.start) + dailyJitter(now, wh.startJitterMinutes);
  const end = hhmmToMinutes(wh.end);

  if (minutes < start) {
    return {
      open: false,
      reason: 'before_working_hours',
      retryInSeconds: Math.max(60, (start - minutes) * 60),
    };
  }
  if (minutes >= end) {
    return { open: false, reason: 'after_working_hours', retryInSeconds: 30 * 60 };
  }
  return { open: true, retryInSeconds: 0 };
}

export interface QuotaCheck {
  allowed: boolean;
  reason?: string;
  used?: number;
  cap?: number;
}

/**
 * Per-platform caps. The platform adapter supplies the base (X tolerates more posts
 * than Indie Hackers does), and anything you set in settings overrides it. Settings
 * always win, so the dashboard and the `set_limits` tool remain the single control.
 */
export function loadLimitsFor(platform?: string): Limits {
  const base: Limits = { ...DEFAULT_LIMITS };
  if (platform) {
    try {
      Object.assign(base, getPlatform(platform).defaultLimits);
    } catch {
      /* unknown platform: fall back to the generic defaults */
    }
  }
  const overrides = getSetting<Limits>('limits', {});
  const platformOverrides = getSetting<Limits>(`limits.${platform}`, {});
  return { ...base, ...overrides, ...platformOverrides };
}

export const savePlatformLimits = (platform: string, l: Limits) =>
  setSetting(`limits.${platform}`, l);

/** Rolling-window quota check for one action on one account. */
export function checkQuota(accountId: number, action: string, platform?: string): QuotaCheck {
  const limits = platform ? loadLimitsFor(platform) : loadLimits();

  const totalCap = limits._total;
  if (totalCap) {
    if (totalCap.perHour !== undefined) {
      const usedH = countTotal(accountId, 1);
      if (usedH >= totalCap.perHour) {
        return { allowed: false, reason: 'total_hourly_cap', used: usedH, cap: totalCap.perHour };
      }
    }
    if (totalCap.perDay !== undefined) {
      const usedD = countTotal(accountId, 24);
      if (usedD >= totalCap.perDay) {
        return { allowed: false, reason: 'total_daily_cap', used: usedD, cap: totalCap.perDay };
      }
    }
  }

  const cap = limits[action];
  if (!cap) return { allowed: true };

  if (cap.perHour !== undefined) {
    const used = countRecentActions(accountId, action, 1);
    if (used >= cap.perHour) {
      return { allowed: false, reason: `${action}_hourly_cap`, used, cap: cap.perHour };
    }
  }
  if (cap.perDay !== undefined) {
    const used = countRecentActions(accountId, action, 24);
    if (used >= cap.perDay) {
      return { allowed: false, reason: `${action}_daily_cap`, used, cap: cap.perDay };
    }
  }
  return { allowed: true };
}

function countTotal(accountId: number, hours: number, platform?: string): number {
  const limits = platform ? loadLimitsFor(platform) : loadLimits();
  return Object.keys(limits)
    .filter((k) => !k.startsWith('_'))
    .reduce((sum, action) => sum + countRecentActions(accountId, action, hours), 0);
}

/** Everything the dashboard needs to show today's budget. */
export function quotaSnapshot(accountId: number, platform?: string) {
  const limits = platform ? loadLimitsFor(platform) : loadLimits();
  return Object.entries(limits).map(([action, cap]) => ({
    action,
    usedToday: action.startsWith('_')
      ? countTotal(accountId, 24)
      : countRecentActions(accountId, action, 24),
    usedThisHour: action.startsWith('_')
      ? countTotal(accountId, 1)
      : countRecentActions(accountId, action, 1),
    perDay: cap.perDay ?? null,
    perHour: cap.perHour ?? null,
  }));
}
