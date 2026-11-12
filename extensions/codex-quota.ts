import {
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const MARKER = /^(\d+)-[a-f0-9-]+\.json$/;
const UNKNOWN_RESET_PROBE_MS = 5 * 60_000;

/** Distinguish account usage exhaustion from ordinary request throttling. */
export function codexQuotaDeadline(
  message: string,
  now = Date.now(),
): number | undefined {
  if (
    !/subscription_sharing_usage_limit_exceeded|usage_limit_reached|usage_not_included|hit your chatgpt usage limit|(?:five|5)[- ]hour.{0,30}(?:limit|quota)|(?:usage|quota) limit (?:reached|exceeded)/i.test(
      message,
    )
  ) {
    return undefined;
  }
  const epoch = /["']?resets?_at["']?\s*[:=]\s*["']?(\d{10,13})\b/i.exec(
    message,
  );
  if (epoch) {
    const value = Number(epoch[1]);
    const until = value < 1e12 ? value * 1000 : value;
    if (Number.isFinite(until) && until > now && until < now + 32 * 86400_000)
      return until;
    return undefined;
  }
  const duration =
    /try again in\s*(~)?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(
      message,
    );
  if (duration) {
    const factor = /^[hs]/i.test(duration[3])
      ? /^h/i.test(duration[3])
        ? 3600_000
        : 1000
      : 60_000;
    const delay = Number(duration[2]) * factor;
    if (Number.isFinite(delay) && delay >= 0 && delay < 32 * 86400_000) {
      // Codex's friendly message rounds reset minutes. Do not probe before that window ends.
      return now + delay + (duration[1] ? 60_000 : 1000);
    }
  }
  // An unknown reset does not justify another five-hour wait. Probe after five minutes.
  return now + UNKNOWN_RESET_PROBE_MS;
}

/** Deadline markers share quota state across profiles, sessions, and Pi processes. */
export class CodexQuotaGuard {
  constructor(readonly directory: string) {}

  deadline(now = Date.now()): number | undefined {
    let files: string[];
    try {
      files = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let latest: number | undefined;
    for (const file of files) {
      const match = MARKER.exec(file);
      if (!match) continue;
      const until = Number(match[1]);
      if (!Number.isSafeInteger(until)) continue;
      if (until <= now) {
        try {
          unlinkSync(join(this.directory, file));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } else {
        latest = Math.max(latest ?? 0, until);
      }
    }
    return latest;
  }

  observe(
    provider: string | undefined,
    message: string | undefined,
    now = Date.now(),
  ): number | undefined {
    if (provider !== 'openai-codex' || !message) return undefined;
    const until = codexQuotaDeadline(message, now);
    if (until === undefined) return undefined;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const name = `${until}-${randomUUID()}.json`;
    const temporary = join(this.directory, `.${name}.tmp`);
    // Separate immutable markers prevent concurrent processes from shortening a cooldown.
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, provider, until, observedAt: now }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    renameSync(temporary, join(this.directory, name));
    return this.deadline(now);
  }

  observeMessage(value: unknown, now = Date.now()): number | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const message = value as {
      role?: string;
      stopReason?: string;
      provider?: string;
      errorMessage?: string;
    };
    if (message.role !== 'assistant' || message.stopReason !== 'error')
      return undefined;
    return this.observe(message.provider, message.errorMessage, now);
  }

  clear(): void {
    let files: string[];
    try {
      files = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const file of files) {
      if (!MARKER.test(file)) continue;
      try {
        unlinkSync(join(this.directory, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

export const codexQuotaGuard = new CodexQuotaGuard(
  join(getAgentDir(), 'model-router-codex-quota'),
);
