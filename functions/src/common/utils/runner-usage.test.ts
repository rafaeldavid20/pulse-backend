import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerUsageReport } from './runner-usage';

test('Claude input includes cache categories exactly once', () => {
  const parsed = parseRunnerUsageReport({
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, session: 'discard me' },
    costUsd: 0.02, prompt: 'discard me',
  }, 'claude');
  assert.deepEqual(parsed, { usage: { inputTokens: 45, outputTokens: 4, cacheReadInputTokens: 30, cacheCreationInputTokens: 5 }, costUsd: 0.02 });
});

test('Codex input already includes cached input', () => {
  assert.deepEqual(parseRunnerUsageReport({ usage: { input_tokens: 45, output_tokens: 4, cached_input_tokens: 30 } }, 'codex'),
    { usage: { inputTokens: 45, outputTokens: 4, cacheReadInputTokens: 30 } });
});

test('missing usage stays unavailable even when cost is reported', () => {
  assert.deepEqual(parseRunnerUsageReport({ costUsd: 0.1 }, 'claude'), { usage: null, costUsd: 0.1 });
  assert.deepEqual(parseRunnerUsageReport(undefined, 'codex'), { usage: null });
});

test('legacy agent kinds discard unsupported usage without blocking completion', () => {
  assert.deepEqual(parseRunnerUsageReport(undefined, 'chatgpt'), { usage: null });
  assert.deepEqual(parseRunnerUsageReport({ usage: { input_tokens: 8, output_tokens: 3 }, costUsd: 1, prompt: 'discard me' }, 'chatgpt'), { usage: null });
});

test('rejects malformed, negative, fractional and inconsistent counters', () => {
  for (const usage of [
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: 1, output_tokens: NaN },
    { input_tokens: 1, output_tokens: 1, cached_input_tokens: 2 },
  ]) assert.throws(() => parseRunnerUsageReport({ usage }, 'codex'));
});
