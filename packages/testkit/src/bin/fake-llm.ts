// Standalone fake model server for load tests: node packages/testkit/dist/bin/fake-llm.js --port 4117 --latency-ms 40
import { parseArgs } from 'node:util';
import { startFakeLlm } from '../fake-llm.js';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4117' }, 'latency-ms': { type: 'string', default: '0' } } });
const llm = await startFakeLlm({ port: Number(values.port), latencyMs: Number(values['latency-ms']) });
process.stdout.write(`fake LLM listening on ${llm.url} (GET /stats for usage)\n`);
const stop = () => void llm.close().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
