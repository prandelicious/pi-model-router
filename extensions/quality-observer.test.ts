import { describe, expect, it, vi } from 'vitest';
import {
  boundQualityReviewInput,
  createQualityObserver,
  parseQualityAssessment,
  type QualityReviewInput,
  type QualityReviewRecord,
} from './quality-observer';

const sampleInput: QualityReviewInput = {
  request: 'Add a test.',
  answer: 'The test is added.',
  evidence: ['PASS: test suite'],
  truncated: false,
};

const source = {
  reviewId: 'session:turn',
  sessionId: 'session',
  branchId: 'branch',
  turnId: 'turn',
};

describe('quality observer', () => {
  it('bounds review text and marks the snapshot as truncated', () => {
    const bounded = boundQualityReviewInput(
      {
        ...sampleInput,
        request: 'request',
        answer: 'answer',
        evidence: ['evidence'],
      },
      10,
    );

    expect(bounded).toEqual({
      request: 'r',
      answer: 'answer',
      evidence: ['evi'],
      truncated: true,
      truncation: { request: true, answer: false, evidence: true },
    });
  });

  it('classifies missing evidence separately from insufficient evidence', () => {
    const claim = { type: 'bool' as const, probability: 0.9 };
    const insufficient = {
      type: 'choice' as const,
      choice: 'insufficient-evidence',
      probabilities: {},
      confidence: 0.8,
    };
    expect(parseQualityAssessment(claim, insufficient, false)).toBe(
      'no-evidence',
    );
    expect(parseQualityAssessment(claim, insufficient, true)).toBe(
      'insufficient-evidence',
    );
    expect(
      parseQualityAssessment(
        { ...claim, probability: 0.4 },
        insufficient,
        true,
      ),
    ).toBe('no-completion-claim');
    expect(
      parseQualityAssessment(
        claim,
        {
          type: 'choice',
          choice: 'contradicted',
          probabilities: {},
          confidence: 0.8,
        },
        true,
      ),
    ).toBe('contradicted');
  });

  it('allocates the budget to answer before evidence before request', () => {
    const bounded = boundQualityReviewInput({
      request: 'r'.repeat(200),
      answer: 'a'.repeat(700),
      evidence: ['e'.repeat(400)],
      truncated: false,
    });

    expect(bounded.answer).toHaveLength(600);
    expect(bounded.evidence).toEqual(['e'.repeat(300)]);
    expect(bounded.request).toHaveLength(100);
    expect(bounded.truncation).toEqual({
      answer: true,
      evidence: true,
      request: true,
    });
  });

  it('persists a structured review record after a successful review', async () => {
    const persist = vi.fn<(record: QualityReviewRecord) => void>();
    const observer = createQualityObserver(
      async () => ({
        reviewer: 'typesafe/jev-latest',
        answers: {
          completionClaim: { type: 'bool', probability: 0.9 },
          evidenceAssessment: {
            type: 'choice',
            choice: 'supported',
            probabilities: { supported: 0.9 },
            confidence: 0.9,
          },
        },
      }),
      persist,
    );

    const outcome = await observer.observe(sampleInput, source);

    expect(outcome.status).toBe('recorded');
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        ...source,
        status: 'reviewed',
        assessment: 'supported',
        reviewer: 'typesafe/jev-latest',
        snapshotTruncated: false,
        truncation: { request: false, answer: false, evidence: false },
      }),
    );
    expect(JSON.stringify(persist.mock.calls[0]?.[0])).not.toContain(
      sampleInput.request,
    );
  });

  it('reuses a prior result for identical evidence', async () => {
    const review = vi.fn(async () => ({
      reviewer: 'typesafe/jev-latest',
      answers: {
        completionClaim: { type: 'bool' as const, probability: 0.9 },
        evidenceAssessment: {
          type: 'choice' as const,
          choice: 'supported',
          probabilities: { supported: 1 },
          confidence: 1,
        },
      },
    }));
    const persist = vi.fn<(record: QualityReviewRecord) => void>();
    const observer = createQualityObserver(review, persist);

    await observer.observe(sampleInput, source);
    await observer.observe(sampleInput, {
      ...source,
      turnId: 'turn-2',
      reviewId: 'session:turn-2',
    });

    expect(review).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      durationMs: 0,
      assessment: 'supported',
    });
  });

  it('records truncation when the answer exceeds its budget', async () => {
    const persist = vi.fn<(record: QualityReviewRecord) => void>();
    const observer = createQualityObserver(
      async () => ({
        reviewer: 'reviewer',
        answers: {
          completionClaim: { type: 'bool', probability: 0.9 },
          evidenceAssessment: {
            type: 'choice',
            choice: 'supported',
            probabilities: {},
            confidence: 1,
          },
        },
      }),
      persist,
    );

    await observer.observe({ ...sampleInput, answer: 'a'.repeat(601) }, source);

    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      snapshotTruncated: true,
      truncation: { request: false, answer: true, evidence: false },
    });
  });

  it('keeps the incoming truncation flag in the aggregate', () => {
    const bounded = boundQualityReviewInput({
      ...sampleInput,
      truncated: true,
    });

    expect(bounded.truncated).toBe(true);
    expect(bounded.truncation).toEqual({
      request: false,
      answer: false,
      evidence: false,
    });
  });

  it('records truncation on the failure path', async () => {
    const persist = vi.fn<(record: QualityReviewRecord) => void>();
    const observer = createQualityObserver(
      async () => {
        throw new Error('review failed');
      },
      persist,
      { failureLimit: 10 },
    );

    await observer.observe({ ...sampleInput, answer: 'a'.repeat(900) }, source);

    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      status: 'failed',
      snapshotTruncated: true,
      truncation: { request: false, answer: true, evidence: false },
    });
  });

  it('reports cancelled when the review is cancelled in flight', async () => {
    const persist = vi.fn<(record: QualityReviewRecord) => void>();
    const observer = createQualityObserver(
      (_input, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      persist,
    );

    const pending = observer.observe(sampleInput, source);
    await Promise.resolve();
    observer.cancel();

    expect(await pending).toEqual({ status: 'cancelled' });
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports busy while a review is active', async () => {
    let resolveReview: (() => void) | undefined;
    const observer = createQualityObserver(
      () =>
        new Promise((resolve) => {
          resolveReview = () =>
            resolve({
              reviewer: 'reviewer',
              answers: { completionClaim: { type: 'bool', probability: 0.9 } },
            });
        }),
      vi.fn(),
    );

    const activeReview = observer.observe(sampleInput, source);
    await Promise.resolve();
    expect(await observer.observe(sampleInput, source)).toEqual({
      status: 'skipped',
      reason: 'busy',
    });
    resolveReview?.();
    await activeReview;
  });

  it('reports circuit-open after three consecutive failures', async () => {
    const observer = createQualityObserver(
      async () => {
        throw new Error('review failed');
      },
      vi.fn(),
      { cooldownMs: 10_000 },
    );

    await observer.observe(sampleInput, source);
    await observer.observe({ ...sampleInput, request: 'second' }, source);
    await observer.observe({ ...sampleInput, request: 'third' }, source);

    expect(
      await observer.observe({ ...sampleInput, request: 'fourth' }, source),
    ).toEqual({
      status: 'skipped',
      reason: 'circuit-open',
    });
  });

  it('records unknown when a review times out', async () => {
    const persist = vi.fn<(record: QualityReviewRecord) => void>();
    const observer = createQualityObserver(
      (_input, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      persist,
      { timeoutMs: 5 },
    );

    await observer.observe(sampleInput, source);

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        failureReason: 'timeout',
        assessment: 'unknown',
      }),
    );
  });
});
