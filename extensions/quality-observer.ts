import type { ClassifierAnswer } from '@earendil-works/pi-ai';

export const QUALITY_OBSERVER_ENTRY = 'router-quality-review';
export const QUALITY_OBSERVER_TIMEOUT_MS = 3_000;
export const QUALITY_OBSERVER_MAX_INPUT_CHARS = 1_000;

export type QualityAssessment =
  | 'no-completion-claim'
  | 'supported'
  | 'contradicted'
  | 'insufficient-evidence'
  | 'unknown';

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
  timestamp: number;
}

export interface QualityReviewInput {
  request: string;
  answer: string;
  evidence: string[];
  truncated: boolean;
}

export interface QualityObserverOptions {
  timeoutMs?: number;
  failureLimit?: number;
  cooldownMs?: number;
  now?: () => number;
}

export type QualityReview = (
  input: QualityReviewInput,
  signal: AbortSignal,
) => Promise<{
  answers: Record<string, ClassifierAnswer>;
  reviewer: string;
}>;

export const boundQualityReviewInput = (
  input: QualityReviewInput,
  maxChars = QUALITY_OBSERVER_MAX_INPUT_CHARS,
): QualityReviewInput => {
  const normalized = {
    request: input.request,
    answer: input.answer,
    evidence: input.evidence,
    truncated: input.truncated,
  };
  let remaining = maxChars;
  const take = (value: string): string => {
    const result = value.slice(0, remaining);
    remaining -= result.length;
    return result;
  };
  const request = take(normalized.request);
  const answer = take(normalized.answer);
  const evidence: string[] = [];
  for (const item of normalized.evidence) {
    if (remaining <= 0) break;
    evidence.push(take(item));
  }
  return {
    request,
    answer,
    evidence,
    truncated:
      normalized.truncated ||
      request.length !== normalized.request.length ||
      answer.length !== normalized.answer.length ||
      evidence.join('').length !== normalized.evidence.join('').length,
  };
};

export const parseQualityAssessment = (
  claim: ClassifierAnswer | undefined,
  evidence: ClassifierAnswer | undefined,
): QualityAssessment => {
  if (claim?.type !== 'bool' || evidence?.type !== 'choice') return 'unknown';
  if (claim.probability < 0.5) return 'no-completion-claim';
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
      | 'timestamp'
    >,
  ): Promise<void> => {
    if (active || now() < disabledUntil) return;
    const boundedInput = boundQualityReviewInput(input);
    const cacheKey = JSON.stringify(boundedInput);
    const cached = cache.get(cacheKey);
    if (cached) {
      persist({
        version: 1,
        status: 'reviewed',
        ...source,
        assessment: cached.assessment,
        reviewer: cached.reviewer,
        durationMs: 0,
        snapshotTruncated: boundedInput.truncated,
        timestamp: now(),
      });
      return;
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
      if (taskGeneration !== generation) return;
      failures = 0;
      const assessment = parseQualityAssessment(
        result.answers.completionClaim,
        result.answers.evidenceAssessment,
      );
      cache.set(cacheKey, { assessment, reviewer: result.reviewer });
      if (cache.size > 256) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      persist({
        version: 1,
        status: 'reviewed',
        ...source,
        assessment,
        reviewer: result.reviewer,
        durationMs: Math.max(0, now() - startedAt),
        snapshotTruncated: input.truncated,
        timestamp: now(),
      });
    } catch {
      if (taskGeneration !== generation) return;
      failures += 1;
      persist({
        version: 1,
        status: 'failed',
        failureReason: taskController.signal.aborted
          ? 'timeout'
          : 'review-error',
        ...source,
        assessment: 'unknown',
        reviewer: 'unknown',
        durationMs: Math.max(0, now() - startedAt),
        snapshotTruncated: input.truncated,
        timestamp: now(),
      });
      if (failures >= failureLimit) {
        disabledUntil = now() + cooldownMs;
        failures = 0;
      }
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (controller === taskController) controller = undefined;
      active = false;
    }
  };

  return { observe, cancel };
};
