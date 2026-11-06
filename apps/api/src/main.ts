import { ConfigError, loadConfig } from '@agentbazaar/config';
import { createApp } from './bootstrap/create-app.js';

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
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
