export interface RunnerTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface RunnerUsageReport {
  usage: RunnerTokenUsage | null;
  costUsd?: number;
}

function counter(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} debe ser un entero no negativo.`);
  }
  return value;
}

function optionalCounter(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : counter(value, name);
}

/** Only provider counters enter storage. Raw messages, sessions and prompts are discarded. */
export function parseRunnerUsageReport(value: unknown, provider: string): RunnerUsageReport {
  // Legacy/unknown agent kinds can still finish a job. Their usage format is
  // unsupported, so discard the entire report rather than storing raw fields.
  if (provider !== 'claude' && provider !== 'codex') return { usage: null };
  if (value === undefined || value === null) return { usage: null };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('El reporte de uso debe ser un objeto.');
  const report = value as Record<string, unknown>;
  const costUsd = report.costUsd === undefined ? undefined : report.costUsd;
  if (costUsd !== undefined && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) {
    throw new Error('costUsd debe ser un número no negativo.');
  }
  if (report.usage === undefined || report.usage === null) return { usage: null, costUsd: costUsd as number | undefined };
  if (typeof report.usage !== 'object' || Array.isArray(report.usage)) throw new Error('usage debe ser un objeto.');
  const raw = report.usage as Record<string, unknown>;
  let inputTokens: number;
  let outputTokens: number;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  if (provider === 'claude') {
    // Claude's input_tokens excludes both cache categories; normalize to inclusive input.
    const direct = counter(raw.input_tokens, 'input_tokens');
    outputTokens = counter(raw.output_tokens, 'output_tokens');
    cacheReadInputTokens = optionalCounter(raw.cache_read_input_tokens, 'cache_read_input_tokens');
    cacheCreationInputTokens = optionalCounter(raw.cache_creation_input_tokens, 'cache_creation_input_tokens');
    inputTokens = direct + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
    if (!Number.isSafeInteger(inputTokens)) throw new Error('inputTokens excede el rango seguro.');
  } else {
    // Codex input_tokens already includes cached_input_tokens.
    inputTokens = counter(raw.input_tokens, 'input_tokens');
    outputTokens = counter(raw.output_tokens, 'output_tokens');
    cacheReadInputTokens = optionalCounter(raw.cached_input_tokens, 'cached_input_tokens');
    if (cacheReadInputTokens !== undefined && cacheReadInputTokens > inputTokens) throw new Error('cached_input_tokens excede input_tokens.');
  }
  return {
    usage: {
      inputTokens, outputTokens,
      ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
    },
    ...(costUsd === undefined ? {} : { costUsd: costUsd as number }),
  };
}
