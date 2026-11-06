import { fileURLToPath } from 'node:url';

// Endpoints of tests/infra/docker-compose.yml; variables already set in the environment win.
process.loadEnvFile(fileURLToPath(new URL('../../../../tests/infra/services.env', import.meta.url)));
