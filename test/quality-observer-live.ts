import type { ClassifierContext } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createQualityObserver,
  type QualityAssessment,
  type QualityReviewRecord,
} from '../extensions/quality-observer';

interface LiveCase {
  id: string;
  expected: Exclude<QualityAssessment, 'unknown'>;
  request: string;
  answer: string;
  evidence: string[];
}

const liveCases: LiveCase[] = [
  {
    id: 'supported-test-pass',
    expected: 'supported',
    request: 'Add a test for invalid parser input.',
    answer: 'I added the test, and it passes.',
    evidence: ['Test run: PASS. Invalid input was rejected.'],
  },
  {
    id: 'supported-build-pass',
    expected: 'supported',
    request: 'Build the application.',
    answer: 'The application built successfully.',
    evidence: ['Build command exited with code 0.'],
  },
  {
    id: 'supported-file-created',
    expected: 'supported',
    request: 'Create the requested configuration file.',
    answer: 'I created the configuration file.',
    evidence: ['File check: the requested configuration file exists.'],
  },
  {
    id: 'contradicted-test-fail',
    expected: 'contradicted',
    request: 'Fix the login test.',
    answer: 'The login test is fixed.',
    evidence: ['Test run: FAIL. Expected HTTP 200, received HTTP 401.'],
  },
  {
    id: 'contradicted-build-fail',
    expected: 'contradicted',
    request: 'Build the application.',
    answer: 'The application built successfully.',
    evidence: ['Build command exited with code 1. Compilation failed.'],
  },
  {
    id: 'contradicted-file-missing',
    expected: 'contradicted',
    request: 'Create the requested configuration file.',
    answer: 'I created the configuration file.',
    evidence: ['File check: the requested configuration file does not exist.'],
  },
  {
    id: 'no-evidence-no-test',
    expected: 'no-evidence',
    request: 'Fix the login test.',
    answer: 'The login test is fixed.',
    evidence: [],
  },
  {
    id: 'insufficient-no-build',
    expected: 'insufficient-evidence',
    request: 'Build the application.',
    answer: 'The application built successfully.',
    evidence: ['No build command was run.'],
  },
  {
    id: 'insufficient-unrelated-result',
    expected: 'insufficient-evidence',
    request: 'Create the requested configuration file.',
    answer: 'I created the configuration file.',
    evidence: ['Test run: PASS. Parser tests passed.'],
  },
  {
    id: 'no-claim-plan',
    expected: 'no-completion-claim',
    request: 'Add a test for invalid parser input.',
    answer: 'I will add the test after I inspect the parser.',
    evidence: [],
  },
  {
    id: 'no-claim-work-started',
    expected: 'no-completion-claim',
    request: 'Fix the login test.',
    answer: 'I found the failing assertion and started a fix.',
    evidence: ['Test run: FAIL. The login assertion still fails.'],
  },
  {
    id: 'no-claim-question',
    expected: 'no-completion-claim',
    request: 'Build the application.',
    answer: 'Should I run the production build now?',
    evidence: [],
  },
];

const liveObserverTest = (pi: ExtensionAPI) => {
  pi.registerCommand('quality-observer-live-test', {
    description: 'Run 12 synthetic reviews with the live Jev classifier',
    handler: async (_args, ctx) => {
      const classifier = ctx.modelRegistry.findOfType(
        'classifier',
        'typesafe',
        'jev-latest',
      );
      const sessionId = ctx.sessionManager.getSessionId();
      const branchId = ctx.sessionManager.getLeafId();
      if (!classifier || !sessionId || !branchId) {
        ctx.ui.notify(
          'Live observer test needs Jev and an active session branch.',
          'error',
        );
        return;
      }

      const records: QualityReviewRecord[] = [];
      const observer = createQualityObserver(
        async (snapshot, signal) => {
          const context: ClassifierContext = {
            state: {
              request: snapshot.request,
              answer: snapshot.answer,
              evidence: snapshot.evidence,
              truncated: snapshot.truncated,
            },
            questions: {
              completionClaim: {
                type: 'bool',
                instructions:
                  'Does the answer claim that the requested work is complete?',
                criteria: {
                  true: 'The answer states or clearly implies that the work is complete.',
                  false: 'The answer does not claim that the work is complete.',
                },
              },
              evidenceAssessment: {
                type: 'choice',
                instructions:
                  'Does the evidence support, contradict, or fail to verify the completion claim?',
                criteria: {
                  supported: 'The evidence supports the completion claim.',
                  contradicted:
                    'The evidence conflicts with the completion claim.',
                  'insufficient-evidence':
                    'The evidence verifies neither support nor contradiction.',
                },
              },
            },
          };
          const result = await ctx.modelRegistry.classify(classifier, context, {
            signal,
          });
          if (result.stopReason !== 'stop') {
            throw new Error(result.errorMessage ?? result.stopReason);
          }
          return {
            answers: result.answers,
            reviewer: `${result.provider}/${result.model}`,
          };
        },
        (record) => {
          records.push(record);
          pi.appendEntry('router-quality-review', record);
        },
      );

      for (const testCase of liveCases) {
        const reviewId = `live-test:${testCase.id}:${Date.now()}`;
        await observer.observe(
          {
            request: testCase.request,
            answer: testCase.answer,
            evidence: testCase.evidence,
            truncated: false,
          },
          { reviewId, sessionId, branchId, turnId: reviewId },
        );
        const record = records.find((item) => item.reviewId === reviewId);
        const matchesExpected = record?.assessment === testCase.expected;
        pi.appendEntry('router-quality-review-live-test', {
          version: 1,
          caseId: testCase.id,
          expectedAssessment: testCase.expected,
          actualAssessment: record?.assessment ?? 'no-record',
          status: record?.status ?? 'skipped',
          matchesExpected,
          reviewId,
        });
      }

      const reviewed = records.filter((record) => record.status === 'reviewed');
      const matchesExpected = liveCases.filter((testCase) =>
        records.some(
          (record) =>
            record.reviewId.includes(`:${testCase.id}:`) &&
            record.assessment === testCase.expected,
        ),
      ).length;
      const testEntriesStored = ctx.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === 'custom' &&
            entry.customType === 'router-quality-review-live-test',
        ).length;
      const summary = {
        cases: liveCases.length,
        reviewed: reviewed.length,
        matchesExpected,
        testEntriesStored,
        assessments: records.map((record) => ({
          reviewId: record.reviewId,
          status: record.status,
          assessment: record.assessment,
          durationMs: record.durationMs,
        })),
      };
      console.error(`[quality-observer-live-test] ${JSON.stringify(summary)}`);
      ctx.ui.notify(
        `Observer test: ${reviewed.length}/${liveCases.length} reviewed; ${matchesExpected}/${liveCases.length} matched expected labels.`,
        reviewed.length === liveCases.length ? 'info' : 'warning',
      );
    },
  });
};

export default liveObserverTest;
