import { RUNNABLE, type OriState } from "./states";

export type OriAction =
  | "stop"
  | "resume"
  | "fork"
  | "prompt"
  | "command"
  | "files"
  | "sshkey"
  | "desktop"
  | "interrupt";

export const ORI_ACTIONS: readonly OriAction[] = [
  "stop",
  "resume",
  "fork",
  "prompt",
  "command",
  "files",
  "sshkey",
  "desktop",
  "interrupt",
];

export type ActionOutcome =
  | { ok: true; to: OriState }
  | { ok: false; code: string };

interface TransitionRule {
  /** source states the action is legal from */
  allowed: readonly OriState[];
  /** target state on success (None = no transition) */
  to: OriState | null;
  /** error code when the action is illegal for the current state */
  error: string;
}

const RUN = [...RUNNABLE, "running"] as const;

export const TRANSITION_TABLE: Record<OriAction, TransitionRule> = {
  // stop: any live, billable ori -> archiving
  stop: {
    allowed: [...RUNNABLE, "running", "provisioning", "provisioned", "cloning"],
    to: "archiving",
    error: "machine_not_running",
  },
  // resume: only archived oris can come back up
  resume: { allowed: ["archived"], to: "provisioning", error: "resume_failed" },
  // fork: snapshot the source and spin a new ori (source unchanged)
  fork: {
    allowed: [...RUNNABLE, "running", "provisioning", "provisioned", "cloning", "archived"],
    to: "cloning",
    error: "not_found",
  },
  // prompt: needs a live, idle-ish ori; running/ready/idle all promptable
  prompt: { allowed: RUN, to: "running", error: "ori_not_promptable" },
  // interactive commands/files/ssh/desktop: only in the runnable window (§4)
  command: { allowed: RUNNABLE, to: null, error: "machine_not_running" },
  files: { allowed: RUNNABLE, to: null, error: "machine_not_running" },
  sshkey: { allowed: RUNNABLE, to: null, error: "machine_not_running" },
  desktop: { allowed: RUNNABLE, to: null, error: "machine_not_running" },
  // interrupt: only while the agent is actively working
  interrupt: { allowed: ["running"], to: "idle", error: "ori_not_promptable" },
};

export function applyAction(action: OriAction, from: OriState): ActionOutcome {
  const rule = TRANSITION_TABLE[action];
  if ((rule.allowed as readonly OriState[]).includes(from)) {
    return { ok: true, to: rule.to ?? from };
  }
  return { ok: false, code: rule.error };
}