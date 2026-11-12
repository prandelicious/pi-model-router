import { afterEach, expect, test, vi } from 'vitest';
const { spyOn } = vi;
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexQuotaGuard, codexQuotaDeadline } from './codex-quota';
import { loadRouterConfig, normalizeConfig } from './config';
import { routeVirtualModelRequest } from './provider';
import { containsAny, runClassifier } from './routing';
import routerExtension from './index';
import { codexQuotaGuard } from './codex-quota';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/compat';
import { mkdirSync } from 'node:fs';

const scratch: string[] = [];
const temporary = () => {
  const d = mkdtempSync(join(tmpdir(), 'pi-quota-test-'));
  scratch.push(d);
  return d;
};
afterEach(() => {
  for (const d of scratch.splice(0))
    rmSync(d, { recursive: true, force: true });
});
const NOW = 1800000000000;
const quotaError = `{"error":{"type":"usage_limit_reached","resets_at":${(NOW + 900_000) / 1000}}}`;
const raw = JSON.parse(
  readFileSync(
    new URL('../test/fixtures/router.json', import.meta.url),
    'utf8',
  ),
);
const { config, warnings } = normalizeConfig(raw);
const store = JSON.parse(
  readFileSync(
    new URL('../test/fixtures/models.json', import.meta.url),
    'utf8',
  ),
);
const models = new Map<string, any>();
for (const provider of Object.keys(store)) {
  for (const model of store[provider].models ?? [])
    models.set(`${provider}/${model.id}`, model);
}
function fixture(
  profile = 'auto',
  guard = new CodexQuotaGuard(temporary()),
  unauthenticated: string[] = [],
) {
  let classifierLookups = 0;
  const registry = {
    find: (p: string, id: string) => models.get(`${p}/${id}`),
    hasConfiguredAuth: (m: any) => !unauthenticated.includes(m.provider),
    findOfType: () => {
      classifierLookups++;
      return undefined;
    },
    streamSimple: () => {
      classifierLookups++;
      throw new Error('Unexpected classifier call');
    },
  };
  const state: any = {
    currentConfig: config,
    currentModelRegistry: registry,
    selectedProfile: profile,
    currentCwd: '/tmp',
    lastRegisteredModels: '',
    routerEnabled: true,
    pinnedTierByProfile: {},
    thinkingByProfile: {},
    accumulatedCost: 0,
    codexQuotaGuard: guard,
  };
  const actions: any = {
    persistState() {},
    recordDebugDecision() {},
    getThinkingOverride: (p: string, t: string) =>
      state.thinkingByProfile[p]?.[t],
    syncPiThinkingLevel() {},
    updateStatus() {},
  };
  async function route(tier: string, options: any = {}) {
    const { pin = true, ...routeOptions } = options;
    if (pin) state.pinnedTierByProfile[profile] = tier;
    return routeVirtualModelRequest(
      {
        model: { provider: 'router', id: profile } as any,
        thinkingLevel: 'high',
        reason: 'user',
        messages: [
          { role: 'user', content: 'Test route', timestamp: Date.now() },
        ],
        ...routeOptions,
      },
      undefined,
      state,
      actions,
    );
  }
  return { route, state, guard, classifierLookups: () => classifierLookups };
}
function failure(ref: string, errorMessage: string) {
  const model = models.get(ref);
  return {
    model,
    message: {
      role: 'assistant',
      provider: model.provider,
      model: model.id,
      stopReason: 'error',
      errorMessage,
      content: [],
      timestamp: Date.now(),
    },
  };
}
const ref = (r: any) => `${r.model.provider}/${r.model.id}`;

test('loadRouterConfig preserves global escalation and applies project overrides', () => {
  const cwd = temporary();
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(
    join(cwd, '.pi', 'model-router.json'),
    JSON.stringify({
      lowEscalation: {
        enabledProfiles: ['auto'],
        maxToolRounds: 4,
        maxConsecutiveFailedRounds: 1,
      },
    }),
  );
  const loaded = loadRouterConfig(cwd);
  expect(loaded.warnings).toEqual([]);
  expect(loaded.config.lowEscalation).toEqual({
    enabledProfiles: ['auto'],
    maxToolRounds: 4,
    maxConsecutiveFailedRounds: 1,
  });
});

test('configuration enables bounded low escalation for auto', () => {
  const active = normalizeConfig({
    ...raw,
    lowEscalation: {
      enabledProfiles: ['auto'],
      maxToolRounds: 6,
      maxConsecutiveFailedRounds: 2,
    },
  });
  expect(active.warnings).toEqual([]);
  expect(active.config.lowEscalation).toEqual({
    enabledProfiles: ['auto'],
    maxToolRounds: 6,
    maxConsecutiveFailedRounds: 2,
  });
});

function toolRounds(count: number, errors: boolean[] = [], parallelCalls = 1) {
  const messages: any[] = [
    { role: 'user', content: 'work', timestamp: Date.now() },
  ];
  for (let i = 0; i < count; i++) {
    const ids = Array.from(
      { length: parallelCalls },
      (_, j) => `call-${i}-${j}`,
    );
    messages.push(
      {
        role: 'assistant',
        stopReason: 'toolUse',
        content: ids.map((id) => ({
          type: 'toolCall',
          id,
          name: 'test',
          arguments: {},
        })),
        timestamp: Date.now(),
      },
      ...ids.map((toolCallId, j) => ({
        role: 'toolResult',
        toolCallId,
        content: [],
        isError: errors[i] ?? false,
        timestamp: Date.now(),
      })),
    );
  }
  return messages;
}

async function beginLowRoute(f: ReturnType<typeof fixture>) {
  f.state.currentConfig.lowEscalation = {
    enabledProfiles: ['auto'],
    maxToolRounds: 6,
    maxConsecutiveFailedRounds: 2,
  };
  const first = await f.route('low');
  delete f.state.pinnedTierByProfile.auto;
  return first;
}

test('auto low escalation counts assistant tool rounds once and triggers at six', async () => {
  const f = fixture();
  const first = await beginLowRoute(f);
  const messages = toolRounds(6, [], 3);
  const result = await f.route('low', {
    pin: false,
    reason: 'continuation',
    state: first.state,
    messages,
  });
  expect(ref(result)).toBe('openai-codex/gpt-6.1-terra');
  expect(result.state?.lastDecision.reasoning).toContain(
    '6 assistant tool rounds',
  );
});

test('two consecutive all-error tool rounds escalate; mixed parallel outcomes do not', async () => {
  const f = fixture();
  const first = await beginLowRoute(f);
  const failed = await f.route('low', {
    pin: false,
    reason: 'continuation',
    state: first.state,
    messages: toolRounds(2, [true, true], 3),
  });
  expect(ref(failed)).toBe('openai-codex/gpt-6.1-terra');
  expect(failed.state?.lastDecision.reasoning).toContain(
    '2 consecutive tool rounds failed',
  );

  const mixedFixture = fixture();
  const mixedStart = await beginLowRoute(mixedFixture);
  const mixed = await mixedFixture.route('low', {
    pin: false,
    reason: 'continuation',
    state: mixedStart.state,
    messages: toolRounds(2, [true, false], 2),
  });
  expect(ref(mixed)).toBe('openai-codex/gpt-6-luna');
});

test('incomplete and aborted tool rounds are excluded, retries do not escalate', async () => {
  const f = fixture();
  const first = await beginLowRoute(f);
  const incomplete = toolRounds(2, [true, true]);
  incomplete.pop();
  const stillLow = await f.route('low', {
    pin: false,
    reason: 'continuation',
    state: first.state,
    messages: incomplete,
  });
  expect(ref(stillLow)).toBe('openai-codex/gpt-6-luna');
  const aborted = toolRounds(2, [true, true]);
  aborted[1]!.stopReason = 'aborted';
  const abortedResult = await f.route('low', {
    pin: false,
    reason: 'continuation',
    state: first.state,
    messages: aborted,
  });
  expect(ref(abortedResult)).toBe('openai-codex/gpt-6-luna');
  const retry = await f.route('low', {
    pin: false,
    reason: 'retry',
    state: first.state,
    messages: toolRounds(2, [true, true]),
    failed: failure('openai-codex/gpt-6-luna', 'temporary error'),
  });
  expect(retry.state?.lastDecision.tier).toBe('low');
});

test('pins, matched rules, budget, fallback changes, and restored branch state are respected', async () => {
  const pinnedFixture = fixture();
  pinnedFixture.state.currentConfig.lowEscalation = {
    enabledProfiles: ['auto'],
    maxToolRounds: 6,
    maxConsecutiveFailedRounds: 2,
  };
  const pinned = await pinnedFixture.route('low');
  expect(
    ref(
      await pinnedFixture.route('low', {
        reason: 'continuation',
        state: pinned.state,
        messages: toolRounds(2, [true, true]),
      }),
    ),
  ).toBe('openai-codex/gpt-6-luna');

  const ruleFixture = fixture();
  const ruleStart = await beginLowRoute(ruleFixture);
  ruleStart.state!.lastDecision.isRuleMatched = true;
  expect(
    ref(
      await ruleFixture.route('low', {
        pin: false,
        reason: 'continuation',
        state: ruleStart.state,
        messages: toolRounds(2, [true, true]),
      }),
    ),
  ).toBe('openai-codex/gpt-6-luna');

  const budgetFixture = fixture();
  const budgetStart = await beginLowRoute(budgetFixture);
  budgetFixture.state.currentConfig.maxSessionBudget = 1;
  budgetFixture.state.accumulatedCost = 1;
  expect(
    ref(
      await budgetFixture.route('low', {
        pin: false,
        reason: 'continuation',
        state: budgetStart.state,
        messages: toolRounds(2, [true, true]),
      }),
    ),
  ).toBe('openai-codex/gpt-6-luna');

  const fallbackFixture = fixture('auto', undefined, ['openai-codex']);
  const fallbackStart = await beginLowRoute(fallbackFixture);
  const escalated = await fallbackFixture.route('low', {
    pin: false,
    reason: 'continuation',
    state: fallbackStart.state,
    messages: toolRounds(2, [true, true]),
  });
  expect(ref(escalated)).toBe('opencode-go/deepseek-v4.1-flash');
  expect(escalated.state?.lastDecision.tier).toBe('medium');
  const restored = await fallbackFixture.route('low', {
    pin: false,
    reason: 'continuation',
    state: JSON.parse(JSON.stringify(escalated.state)),
    messages: toolRounds(2, [true, true]),
  });
  expect(ref(restored)).toBe('opencode-go/deepseek-v4.1-flash');
});

test('a new user request resets round scope and incomplete results do not count', async () => {
  const f = fixture();
  const first = await beginLowRoute(f);
  const result = await f.route('low', {
    pin: false,
    reason: 'user',
    state: first.state,
    messages: [
      ...toolRounds(6, [true, true, true, true, true, true]),
      { role: 'user', content: 'another request', timestamp: Date.now() },
      ...toolRounds(1),
    ],
  });
  expect(ref(result)).toBe('openai-codex/gpt-6-luna');
});

test('staged configuration normalizes without warnings and all models exist', () => {
  expect(warnings).toEqual([]);
  for (const p of Object.values(config.profiles)) {
    for (const t of Object.values(p).filter(Boolean) as any[]) {
      for (const r of [t.model, ...(t.fallbacks ?? [])])
        expect(models.has(r)).toBe(true);
    }
  }
});

test('Go targets do not duplicate any Codex model IDs', () => {
  const codex = new Set(store['openai-codex'].models.map((m: any) => m.id));
  for (const p of Object.values(config.profiles)) {
    for (const t of Object.values(p).filter(Boolean) as any[]) {
      for (const r of [t.model, ...(t.fallbacks ?? [])]) {
        if (r.startsWith('opencode-go/'))
          expect(codex.has(r.slice('opencode-go/'.length))).toBe(false);
      }
    }
  }
});

test('routing keyword matches use word boundaries', () => {
  expect(containsAny('The planet is visible.', ['plan'])).toBe(false);
  expect(containsAny('Please plan the migration.', ['plan'])).toBe(true);
  expect(containsAny('find the root cause', ['root cause'])).toBe(true);
});

test('single-tier profiles skip classifier lookup', async () => {
  const f = fixture('deep');
  const result = await f.route('high', { pin: false });
  expect(ref(result)).toBe('openai-codex/gpt-6.1-sol');
  expect(f.classifierLookups()).toBe(0);
});

test('Jev can route a bounded cleanup to low and receives risk-aware criteria', async () => {
  const f = fixture();
  let criteria: any;
  f.state.currentModelRegistry.findOfType = () => ({
    provider: 'typesafe',
    id: 'jev-latest',
    api: 'typesafe-system-one',
    input: ['text'],
  });
  f.state.currentModelRegistry.classify = async (_model: any, context: any) => {
    criteria = context.questions.tier.criteria;
    return {
      stopReason: 'stop',
      answers: { tier: { type: 'choice', choice: 'low', confidence: 0.9 } },
    };
  };
  const result = await f.route('medium', {
    pin: false,
    messages: [
      {
        role: 'user',
        content: 'Delete all old sessions except this one',
        timestamp: Date.now(),
      },
    ],
  });
  expect(ref(result)).toBe('openai-codex/gpt-6-luna');
  expect(f.state.lastDecision.isClassifier).toBe(true);
  expect(criteria.low).toContain('file or session cleanup');
  expect(criteria.low).toContain('safeguards');
});

test('classifier failures record and show the heuristic fallback', async () => {
  const f = fixture();
  const notices: string[] = [];
  f.state.lastExtensionContext = {
    ui: { notify: (message: string) => notices.push(message) },
  };
  f.state.currentModelRegistry.streamSimple = undefined;
  f.state.currentModelRegistry.classify = async () => ({
    stopReason: 'error',
    errorMessage: 'secret',
    answers: {},
  });
  f.state.currentModelRegistry.findOfType = () => ({
    provider: 'typesafe',
    id: 'jev-latest',
    api: 'typesafe-system-one',
    input: ['text'],
  });
  const result = await f.route('medium', {
    pin: false,
    messages: [
      {
        role: 'user',
        content:
          'delete all pi agent sessions, not just the jsonl files, other than this current session',
        timestamp: Date.now(),
      },
    ],
  });
  expect(ref(result)).toBe('openai-codex/gpt-6.1-terra');
  expect(f.state.lastDecision.reasoning).toContain(
    'Classifier fallback: Classifier request ended with error',
  );
  expect(notices[0]).toContain('heuristic fallback');
  expect(notices[0]).not.toContain('secret');
});

test('classifier reports unavailable and malformed results', async () => {
  const context: any = {
    messages: [{ role: 'user', content: 'test', timestamp: Date.now() }],
  };
  const reasons: string[] = [];
  const report = (reason: string) => reasons.push(reason);
  await runClassifier(
    'typesafe/jev-latest',
    { find: () => undefined } as any,
    context,
    undefined,
    undefined,
    0.5,
    undefined,
    report,
  );
  expect(reasons.at(-1)).toBe('Classifier API is unavailable');
  const registry: any = {
    find: () => undefined,
    findOfType: () => ({
      provider: 'typesafe',
      id: 'jev-latest',
      api: 'typesafe-system-one',
      input: ['text'],
    }),
    classify: async () => ({ stopReason: 'stop', answers: {} }),
  };
  await runClassifier(
    'typesafe/jev-latest',
    registry,
    context,
    undefined,
    undefined,
    0.5,
    undefined,
    report,
  );
  expect(reasons.at(-1)).toBe('Classifier returned an invalid tier answer');
});

test('image requests fail clearly when the profile has no image-capable target', async () => {
  const f = fixture('free');
  const messages = [
    {
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: '' }],
      timestamp: Date.now(),
    },
  ];
  await expect(f.route('medium', { pin: false, messages })).rejects.toThrow(
    'No image-capable model is available',
  );
  await expect(
    f.route('medium', { pin: false, reason: 'direct', messages }),
  ).rejects.toThrow('No image-capable model is configured');
});

test('reported epoch is used rather than adding another five hours', () => {
  expect(codexQuotaDeadline(quotaError, NOW)).toBe(NOW + 900_000);
});
test('millisecond epoch is accepted', () => {
  expect(
    codexQuotaDeadline(`usage_limit_reached resets_at=${NOW + 900_000}`, NOW),
  ).toBe(NOW + 900_000);
});
test('rounded friendly reset gets a conservative one-minute margin', () => {
  expect(
    codexQuotaDeadline(
      'You have hit your ChatGPT usage limit. Try again in ~15 min.',
      NOW,
    ),
  ).toBe(NOW + 960_000);
});
test('unknown reset schedules a short probe, not a fresh five-hour wait', () => {
  expect(codexQuotaDeadline('usage_limit_reached', NOW)).toBe(NOW + 300_000);
});
test('ordinary throttling, auth errors, and server failures do not suspend Codex', () => {
  for (const m of [
    '429 rate_limit_exceeded',
    '401 unauthorized',
    '503 overloaded',
    'ECONNRESET',
  ])
    expect(codexQuotaDeadline(m, NOW)).toBeUndefined();
});
test('other provider quota errors cannot suspend Codex', () => {
  const g = new CodexQuotaGuard(temporary());
  g.observe('opencode-go', quotaError, NOW);
  expect(g.deadline(NOW)).toBeUndefined();
});
test('expired reset does not create a new cooldown', () => {
  expect(
    codexQuotaDeadline(
      `usage_limit_reached resets_at=${(NOW - 1000) / 1000}`,
      NOW,
    ),
  ).toBeUndefined();
});
test('independent guards share durable state without shortening the latest deadline', () => {
  const dir = temporary();
  const a = new CodexQuotaGuard(dir);
  const b = new CodexQuotaGuard(dir);
  a.observe('openai-codex', quotaError, NOW);
  b.observe('openai-codex', 'usage_limit_reached', NOW);
  expect(new CodexQuotaGuard(dir).deadline(NOW)).toBe(NOW + 900_000);
  expect(a.deadline(NOW + 901_000)).toBeUndefined();
});
test('manual reset removes only owned markers', () => {
  const dir = temporary();
  const g = new CodexQuotaGuard(dir);
  writeFileSync(join(dir, 'unrelated.txt'), 'keep');
  g.observe('openai-codex', quotaError, NOW);
  g.clear();
  expect(g.deadline(NOW)).toBeUndefined();
  expect(readFileSync(join(dir, 'unrelated.txt'), 'utf8')).toBe('keep');
});
test('final error observation handles a quota even when native retry is exhausted', () => {
  const g = new CodexQuotaGuard(temporary());
  g.observeMessage(
    failure('openai-codex/gpt-6.1-sol', quotaError).message,
    NOW,
  );
  expect(g.deadline(NOW)).toBe(NOW + 900_000);
});

for (const [tier, model, thinking] of [
  ['high', 'openai-codex/gpt-6.1-sol', 'high'],
  ['medium', 'openai-codex/gpt-6.1-terra', 'medium'],
  ['low', 'openai-codex/gpt-6-luna', 'low'],
]) {
  test(`Codex is first for ${tier}`, async () => {
    const r = await fixture().route(tier);
    expect(ref(r)).toBe(model);
    expect(r.thinkingLevel).toBe(thinking);
  });
}

test('quota switches medium Terra/medium to Go DeepSeek/high', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(NOW);
  try {
    const f = fixture();
    const first = await f.route('medium');
    const r = await f.route('medium', {
      reason: 'retry',
      state: first.state,
      failed: failure(ref(first), quotaError),
    });
    expect(ref(r)).toBe('opencode-go/deepseek-v4.1-flash');
    expect(r.thinkingLevel).toBe('high');
    expect((r.state as any).lastDecision.thinking).toBe('high');
  } finally {
    clock.mockRestore();
  }
});

test('Codex quota is shared across tiers, sessions, and profiles', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(NOW);
  try {
    const dir = temporary();
    const g = new CodexQuotaGuard(dir);
    g.observe('openai-codex', quotaError, NOW);
    expect(
      ref(await fixture('auto', new CodexQuotaGuard(dir)).route('high')),
    ).toBe('opencode-go/gemini-4-argon');
    expect(
      ref(await fixture('auto', new CodexQuotaGuard(dir)).route('low')),
    ).toBe('opencode-go/claude-haiku-5-5');
    expect(
      ref(await fixture('deep', new CodexQuotaGuard(dir)).route('high')),
    ).toBe('openrouter/anthropic/claude-opus-5.5');
  } finally {
    clock.mockRestore();
  }
});

test('new user turn returns to Codex after reset, while a Go tool continuation stays sticky', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(NOW);
  try {
    const f = fixture();
    f.guard.observe('openai-codex', quotaError, NOW);
    const before = await f.route('medium');
    expect(ref(before)).toBe('opencode-go/deepseek-v4.1-flash');
    clock.mockReturnValue(NOW + 901_000);
    const follow = await f.route('medium', {
      reason: 'continuation',
      state: before.state,
    });
    expect(ref(follow)).toBe('opencode-go/deepseek-v4.1-flash');
    expect(follow.thinkingLevel).toBe('high');
    const after = await f.route('medium', {
      reason: 'user',
      state: follow.state,
    });
    expect(ref(after)).toBe('openai-codex/gpt-6.1-terra');
    expect(after.thinkingLevel).toBe('medium');
  } finally {
    clock.mockRestore();
  }
});

for (const [tier, expected, thinking] of [
  ['high', 'openrouter/anthropic/claude-sonnet-5.5', 'high'],
  ['medium', 'openrouter/deepseek/deepseek-v4.1-flash', 'high'],
  ['low', 'openrouter/openai/gpt-6-luna', 'low'],
]) {
  test(`paid fallback follows both subscriptions for ${tier} (simulation only)`, async () => {
    const f = fixture();
    const primary = await f.route(tier);
    const go = await f.route(tier, {
      reason: 'retry',
      state: primary.state,
      failed: failure(ref(primary), '503 overloaded'),
    });
    expect(go.model.provider).toBe('opencode-go');
    const paid = await f.route(tier, {
      reason: 'retry',
      state: go.state,
      failed: failure(ref(go), '429 quota exceeded'),
    });
    expect(ref(paid)).toBe(expected);
    expect(paid.thinkingLevel).toBe(thinking);
  });
}

test('deep/max failover preserves max across premium targets (simulation only)', async () => {
  const f = fixture('deep');
  const first = await f.route('high');
  expect(ref(first)).toBe('openai-codex/gpt-6.1-sol');
  expect(first.thinkingLevel).toBe('max');
  const opus = await f.route('high', {
    reason: 'retry',
    state: first.state,
    failed: failure(ref(first), '503 overloaded'),
  });
  expect(ref(opus)).toBe('openrouter/anthropic/claude-opus-5.5');
  expect(opus.thinkingLevel).toBe('max');
  const sonnet = await f.route('high', {
    reason: 'retry',
    state: opus.state,
    failed: failure(ref(opus), '503 overloaded'),
  });
  expect(ref(sonnet)).toBe('openrouter/anthropic/claude-sonnet-5.5');
  expect(sonnet.thinkingLevel).toBe('max');
});

test('explicit user thinking override still wins over per-model defaults', async () => {
  const f = fixture();
  f.state.thinkingByProfile.auto = { medium: 'max' };
  const r = await f.route('medium');
  expect(r.thinkingLevel).toBe('max');
});
test('native quota errors become bounded retries only on managed subscription chains', async () => {
  const dir = temporary();
  mkdirSync(join(dir, '.pi'));
  writeFileSync(join(dir, '.pi/model-router.json'), JSON.stringify(raw));
  const guard = new CodexQuotaGuard(join(dir, 'quota'));
  const observe = spyOn(codexQuotaGuard, 'observe').mockImplementation(
    (p, m, n) => guard.observe(p, m, n),
  );
  const deadline = spyOn(codexQuotaGuard, 'deadline').mockImplementation((n) =>
    guard.deadline(n),
  );
  try {
    const handlers = new Map<string, any[]>();
    const defs = new Map<string, any>();
    const commands = new Map<string, any>();
    const entries: any[] = [];
    const pi: any = {
      on: (event: string, fn: any) =>
        handlers.set(event, [...(handlers.get(event) ?? []), fn]),
      registerVirtualModel: (def: any) => defs.set(def.id, def),
      unregisterVirtualModel: () => {},
      registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
      appendEntry: (type: string, data: any) => entries.push({ type, data }),
      setThinkingLevel: () => {},
      setModel: async () => true,
    };
    routerExtension(pi);
    const ctx: any = {
      cwd: dir,
      model: { provider: 'router', id: 'auto' },
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        theme: { fg: (_: string, s: string) => s },
      },
      modelRegistry: {
        find: (p: string, id: string) =>
          p === 'router' ? defs.get(id) : models.get(`${p}/${id}`),
        hasConfiguredAuth: () => true,
      },
    };
    for (const fn of handlers.get('session_start') ?? []) await fn({}, ctx);
    await commands.get('router').handler('pin medium', ctx);
    const request: any = {
      model: ctx.model,
      reason: 'user',
      thinkingLevel: 'medium',
      messages: [{ role: 'user', content: 'test', timestamp: Date.now() }],
    };
    const first = await defs.get('auto').route(request, ctx);
    expect(ref(first)).toBe('openai-codex/gpt-6.1-terra');
    const original = failure(
      ref(first),
      'subscription_sharing_usage_limit_exceeded',
    ).message;
    expect(isRetryableAssistantError(original as any)).toBe(false);
    const hook = handlers.get('message_end')![0];
    const repaired = hook({ message: original }, ctx).message;
    expect(isRetryableAssistantError(repaired)).toBe(true);
    expect(
      entries.some(
        (e) =>
          e.type === 'router-subscription-limit' &&
          e.data.originalError === original.errorMessage,
      ),
    ).toBe(true);
    const go = await defs.get('auto').route(
      {
        ...request,
        reason: 'retry',
        state: first.state,
        failed: { model: first.model, message: repaired },
      },
      ctx,
    );
    expect(ref(go)).toBe('opencode-go/deepseek-v4.1-flash');
    expect(go.thinkingLevel).toBe('high');
    const goError = failure(
      ref(go),
      'GoUsageLimitError: Monthly usage limit reached',
    ).message;
    expect(isRetryableAssistantError(goError as any)).toBe(false);
    const repairedGo = hook({ message: goError }, ctx).message;
    expect(isRetryableAssistantError(repairedGo)).toBe(true);
    const paid = await defs.get('auto').route(
      {
        ...request,
        reason: 'retry',
        state: go.state,
        failed: { model: go.model, message: repairedGo },
      },
      ctx,
    );
    expect(ref(paid)).toBe('openrouter/deepseek/deepseek-v4.1-flash');
    expect(paid.thinkingLevel).toBe('high');
    expect(
      hook({ message: failure(ref(paid), 'insufficient_quota').message }, ctx),
    ).toBeUndefined();
    expect(
      hook(
        {
          message: failure('openai-codex/gpt-6.1-terra', '401 unauthorized')
            .message,
        },
        ctx,
      ),
    ).toBeUndefined();
    expect(
      hook(
        { message: original },
        { ...ctx, model: { provider: 'openai-codex', id: 'gpt-6.1-terra' } },
      ),
    ).toBeUndefined();
  } finally {
    observe.mockRestore();
    deadline.mockRestore();
  }
});

test('free profile has one verified free, text-only target and no paid fallback', () => {
  const tiers = Object.values(config.profiles.free).filter(Boolean) as any[];
  expect(tiers).toHaveLength(1);
  expect(tiers[0].model).toBe('opencode-go/beam-free');
  expect(tiers[0].fallbacks ?? []).toEqual([]);
  expect(models.get(tiers[0].model)?.input).toEqual(['text']);
});
