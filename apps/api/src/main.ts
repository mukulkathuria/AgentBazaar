import { ConfigError, loadConfig } from '@agentbazaar/config';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
  // Tracing must start before the app's modules load so their instrumentations apply; without an
  // endpoint the OpenTelemetry SDK is never imported.
  const tracing = config.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? (await import('./shared/observability/tracing.js')).startTracing()
    : undefined;
  const { createApp } = await import('./bootstrap/create-app.js');
  const running = await createApp(config);
  if (process.env.SEED_ON_BOOT === 'true') {
    // Demo containers start empty (embedded database), so they seed the synthetic catalog first.
    const { seedDemo } = await import('./cli/seed.js');
    await seedDemo(running, {});
  }
  await running.app.listen({ port: config.env.PORT, host: config.env.HOST });
  running.infra.logger.info({ profile: config.profile, port: config.env.PORT, adapters: config.adapters }, 'AgentBazaar API listening');

  const shutdown = async (signal: string) => {
    running.infra.logger.info({ signal }, 'shutting down');
    await running.close();
    await tracing?.shutdown(); // flushes the last spans
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
