/**
 * A checkout saga worker in its own process, so sagas.spec.ts can kill it abruptly. With
 * SAGA_CRASH_AFTER=<step> it SIGKILLs itself right after that step's side effects commit and before
 * Temporal hears the step finished, the hardest place for a crash to land.
 */
import { loadConfig } from '@agentbazaar/config';
import { createApp } from '../../src/bootstrap/create-app.js';
import type { CheckoutActivities } from '../../src/modules/orders/application/checkout-saga.js';
import { CheckoutSagaSteps } from '../../src/modules/orders/index.js';
import { runSagaWorker } from '../../src/modules/orders/infrastructure/temporal/worker.js';

type Step = (...args: unknown[]) => Promise<unknown>;

const config = loadConfig();
const running = await createApp(config, { background: false });
const crashAfter = process.env.SAGA_CRASH_AFTER;
const steps = Object.entries(running.app.get(CheckoutSagaSteps).activities) as [string, Step][];
const activities = Object.fromEntries(
  steps.map(([name, step]) => [
    name,
    async (...args: unknown[]) => {
      const result = await step(...args);
      if (name === crashAfter) {
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => undefined); // never report the step as done
      }
      return result;
    },
  ]),
) as unknown as CheckoutActivities;

const env = config.env;
await runSagaWorker({
  address: env.TEMPORAL_ADDRESS!,
  namespace: env.TEMPORAL_NAMESPACE,
  taskQueue: env.TEMPORAL_TASK_QUEUE,
  activities,
  ...(process.env.SAGA_BUNDLE ? { workflowBundlePath: process.env.SAGA_BUNDLE } : {}),
});
await running.close();
