import type { ClassifierAnswer } from '@earendil-works/pi-ai';

export const QUALITY_OBSERVER_ENTRY = 'router-quality-review';
export const QUALITY_OBSERVER_TIMEOUT_MS = 3_000;
export const QUALITY_OBSERVER_MAX_INPUT_CHARS = 1_000;

export const QUALITY_BUDGET = {
  answer: 600,
  evidence: 300,
  request: 100,
} as const;

export type QualityAssessment =
  | 'no-completion-claim'
  | 'no-evidence'
  | 'supported'
  | 'contradicted'
  | 'insufficient-evidence'
  | 'unknown';

export interface QualityTruncation {
  request: boolean;
  answer: boolean;
  evidence: boolean;
}

export interface QualityReviewRecord {
  version: 1;
  status: 'reviewed' | 'failed';
  failureReason?: 'timeout' | 'review-error';
  reviewId: string;
  sessionId: string;
  branchId: string;
  turnId: string;
  assessment: QualityAssessment;
  reviewer: string;
  durationMs: number;
  snapshotTruncated: boolean;
  truncation?: QualityTruncation;
  timestamp: number;
}

export interface QualityReviewInput {
  request: string;
  answer: string;
  evidence: string[];
  truncated: boolean;
}

export interface BoundedQualityReviewInput extends QualityReviewInput {
  truncation: QualityTruncation;
}

export interface QualityObserverOptions {
  timeoutMs?: number;
  failureLimit?: number;
  cooldownMs?: number;
  now?: () => number;
}

export type QualityReview = (
  input: BoundedQualityReviewInput,
  signal: AbortSignal,
) => Promise<{
  answers: Record<string, ClassifierAnswer>;
  reviewer: string;
}>;

export type QualityObserveOutcome =
  | { status: 'recorded'; record: QualityReviewRecord }
  | { status: 'skipped'; reason: 'busy' | 'circuit-open' }
  | { status: 'cancelled' };

export const boundQualityReviewInput = (
  input: QualityReviewInput,
  maxChars = QUALITY_OBSERVER_MAX_INPUT_CHARS,
): BoundedQualityReviewInput => {
  const totalBudget = Math.max(0, maxChars);
  const scale = totalBudget / QUALITY_OBSERVER_MAX_INPUT_CHARS;
  const budgets = {
    answer: Math.floor(QUALITY_BUDGET.answer * scale),
    evidence: Math.floor(QUALITY_BUDGET.evidence * scale),
    request: Math.floor(QUALITY_BUDGET.request * scale),
  };
  let remaining =
    totalBudget - budgets.answer - budgets.evidence - budgets.request;
  for (const field of ['answer', 'evidence', 'request'] as const) {
    if (remaining <= 0) break;
    budgets[field] += 1;
    remaining -= 1;
  }

  const answer = input.answer.slice(0, budgets.answer);
  let evidenceRemaining = budgets.evidence;
  const evidence = input.evidence.map((item) => {
    const boundedItem = item.slice(0, evidenceRemaining);
    evidenceRemaining -= boundedItem.length;
    return boundedItem;
  });
  const request = input.request.slice(0, budgets.request);
  const truncation: QualityTruncation = {
    request: request.length !== input.request.length,
    answer: answer.length !== input.answer.length,
    evidence: evidence.some(
      (item, index) => item.length !== input.evidence[index]?.length,
    ),
  };
  return {
    request,
    answer,
    evidence,
    truncated:
      input.truncated ||
      truncation.request ||
      truncation.answer ||
      truncation.evidence,
    truncation,
  };
};

export const parseQualityAssessment = (
  claim: ClassifierAnswer | undefined,
  evidence: ClassifierAnswer | undefined,
  hasEvidence: boolean,
): QualityAssessment => {
  if (claim?.type !== 'bool') return 'unknown';
  if (claim.probability < 0.5) return 'no-completion-claim';
  if (!hasEvidence) return 'no-evidence';
  if (evidence?.type !== 'choice') return 'unknown';
  switch (evidence.choice) {
    case 'supported':
      return 'supported';
    case 'contradicted':
      return 'contradicted';
    case 'insufficient-evidence':
      return 'insufficient-evidence';
    default:
      return 'unknown';
  }
};

export const createQualityObserver = (
  review: QualityReview,
  persist: (record: QualityReviewRecord) => void,
  options: QualityObserverOptions = {},
) => {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? QUALITY_OBSERVER_TIMEOUT_MS;
  const failureLimit = options.failureLimit ?? 3;
  const cooldownMs = options.cooldownMs ?? 10 * 60_000;
  let active = false;
  let failures = 0;
  const cache = new Map<
    string,
    { assessment: QualityAssessment; reviewer: string }
  >();
  let disabledUntil = 0;
  let generation = 0;

  const cancel = () => {
    generation += 1;
    controller?.abort();
  };
  let controller: AbortController | undefined;

  const observe = async (
    input: QualityReviewInput,
    source: Omit<
      QualityReviewRecord,
      | 'version'
      | 'status'
      | 'failureReason'
      | 'assessment'
      | 'reviewer'
      | 'durationMs'
      | 'snapshotTruncated'
      | 'truncation'
      | 'timestamp'
    >,
  ): Promise<QualityObserveOutcome> => {
    if (active) return { status: 'skipped', reason: 'busy' };
    if (now() < disabledUntil) {
      return { status: 'skipped', reason: 'circuit-open' };
    }
    const boundedInput = boundQualityReviewInput(input);
    const cacheKey = JSON.stringify(boundedInput);
    const cached = cache.get(cacheKey);
    if (cached) {
      const record: QualityReviewRecord = {
        version: 1,
        status: 'reviewed',
        ...source,
        assessment: cached.assessment,
        reviewer: cached.reviewer,
        durationMs: 0,
        snapshotTruncated: boundedInput.truncated,
        truncation: boundedInput.truncation,
        timestamp: now(),
      };
      persist(record);
      return { status: 'recorded', record };
    }
    active = true;
    const taskGeneration = generation;
    const taskController = new AbortController();
    controller = taskController;
    const startedAt = now();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        taskController.abort();
        reject(new Error('quality-review-timeout'));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        review(boundedInput, taskController.signal),
        timeout,
      ]);
      if (taskGeneration !== generation) return { status: 'cancelled' };
      failures = 0;
      const assessment = parseQualityAssessment(
        result.answers.completionClaim,
        result.answers.evidenceAssessment,
        boundedInput.evidence.length > 0,
      );
      cache.set(cacheKey, { assessment, reviewer: result.reviewer });
      if (cache.size > 256) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      const record: QualityReviewRecord = {
        version: 1,
        status: 'reviewed',
        ...source,
        assessment,
        reviewer: result.reviewer,
        durationMs: Math.max(0, now() - startedAt),
        snapshotTruncated: boundedInput.truncated,
        truncation: boundedInput.truncation,
        timestamp: now(),
      };
      persist(record);
      return { status: 'recorded', record };
    } catch {
      if (taskGeneration !== generation) return { status: 'cancelled' };
      failures += 1;
      const record: QualityReviewRecord = {
        version: 1,
        status: 'failed',
        failureReason: taskController.signal.aborted
          ? 'timeout'
          : 'review-error',
        ...source,
        assessment: 'unknown',
        reviewer: 'unknown',
        durationMs: Math.max(0, now() - startedAt),
        snapshotTruncated: boundedInput.truncated,
        truncation: boundedInput.truncation,
        timestamp: now(),
      };
      persist(record);
      if (failures >= failureLimit) {
        disabledUntil = now() + cooldownMs;
        failures = 0;
      }
      return { status: 'recorded', record };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (controller === taskController) controller = undefined;
      active = false;
    }
  };

  return { observe, cancel };
};
