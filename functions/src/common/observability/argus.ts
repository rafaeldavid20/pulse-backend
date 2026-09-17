import { pulseArgusDsn } from '../secrets';

type ArgusSdk = typeof import('@traceargus/sdk');

type CaptureContext = {
  route: string;
  tags?: Record<string, string>;
};

// Functions are compiled as CommonJS while the SDK is ESM. Keeping the native
// dynamic import prevents TypeScript from rewriting it to require().
function loadArgusSdk(): Promise<ArgusSdk> {
  return Function('specifier', 'return import(specifier)')('@traceargus/sdk') as Promise<ArgusSdk>;
}

/** Observability must never change Pulse's response or retry behaviour. */
export async function capturePulseException(
  error: unknown,
  context: CaptureContext,
): Promise<void> {
  const dsn = pulseArgusDsn.value();
  if (!dsn) return;

  try {
    const { createArgusClient } = await loadArgusSdk();
    await createArgusClient({
      dsn,
      environment: process.env.GCLOUD_PROJECT ? 'production' : 'development',
      release: process.env.K_REVISION,
    }).captureException(error, context);
  } catch {
    // Do not log the reporting failure: it can contain transport details and
    // monitoring must stay invisible to Pulse's own callers.
  }
}
