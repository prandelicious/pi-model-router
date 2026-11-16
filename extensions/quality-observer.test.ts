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
      request: 'request',
      answer: 'ans',
      evidence: [],
      truncated: true,
    });
  });

  it('keeps missing evidence distinct from contradicted evidence', () => {
    const claim = { type: 'bool' as const, probability: 0.9 };
    expect(
      parseQualityAssessment(claim, {
        type: 'choice',
        choice: 'insufficient-evidence',
        probabilities: {},
        confidence: 0.8,
      }),
    ).toBe('insufficient-evidence');
    expect(
      parseQualityAssessment(claim, {
        type: 'choice',
        choice: 'contradicted',
        probabilities: {},
        confidence: 0.8,
      }),
    ).toBe('contradicted');
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

    await observer.observe(sampleInput, source);

    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        ...source,
        status: 'reviewed',
        assessment: 'supported',
        reviewer: 'typesafe/jev-latest',
        snapshotTruncated: false,
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
