export interface Account {
  id: number;
  name: string;
  /** linkedin | x | quora | indiehackers. Added by migrate(); old rows default to linkedin. */
  platform: string;
  profile_dir: string;
  proxy: string | null;
  public_id: string | null;
  handle: string | null;
  status: 'unknown' | 'ok' | 'logged_out' | 'checkpoint';
  last_seen_at: string | null;
  created_at: string;
}

export interface Campaign {
  id: number;
  account_id: number;
  name: string;
  status: 'draft' | 'running' | 'paused' | 'done';
  config: string;
  created_at: string;
  updated_at: string;
}

export interface Step {
  id: number;
  campaign_id: number;
  position: number;
  action: string;
  params: string;
  enabled: number;
}

export interface Lead {
  id: number;
  profile_url: string;
  public_id: string | null;
  member_urn: string | null;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  company: string | null;
  location: string | null;
  degree: string | null;
  connected_at: string | null;
  profile_json: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignLead {
  id: number;
  campaign_id: number;
  lead_id: number;
  step_position: number;
  state: 'ready' | 'waiting' | 'done' | 'excluded' | 'failed' | 'replied';
  eligible_at: string;
  entered_at: string;
  last_action_at: string | null;
  attempts: number;
  vars: string;
  exit_reason: string | null;
}

/** Join row returned by nextDueLead: the lead's columns plus its campaign state. */
export interface LeadWithState extends Lead {
  cl_id: number;
  campaign_id: number;
  lead_id: number;
  step_position: number;
  state: CampaignLead['state'];
  eligible_at: string;
  entered_at: string;
  last_action_at: string | null;
  attempts: number;
  vars: string;
}

/** Per-action caps. A missing entry means "no cap", which you rarely want. */
export interface Limits {
  [action: string]: { perDay?: number; perHour?: number };
}

export interface WorkingHours {
  /** Local-time 24h "HH:MM". */
  start: string;
  end: string;
  /** 0 = Sunday .. 6 = Saturday. */
  days: number[];
  /** Random minutes added to `start` each day so the account never begins at exactly 09:00. */
  startJitterMinutes: number;
}

export interface Pacing {
  minGapSeconds: number;
  maxGapSeconds: number;
  /** Per-character typing delay range, milliseconds. */
  typeDelayMs: [number, number];
}
