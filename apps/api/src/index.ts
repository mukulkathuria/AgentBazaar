/** Package entry for embedding AgentBazaar (the demo app, scripts). The server itself starts from main.ts. */
export { createApp, type CreateAppOptions, type RunningApp } from './bootstrap/create-app.js';
export { seedDemo, type SeedOptions, type SeedResult } from './cli/seed.js';
export { ConfigError, loadConfig, type AppConfig } from '@agentbazaar/config';
