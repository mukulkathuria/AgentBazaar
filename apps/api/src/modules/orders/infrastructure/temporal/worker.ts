import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/activity';
import { NativeConnection, Worker } from '@temporalio/worker';
import { AppError } from '../../../../shared/kernel/errors.js';
import type { CheckoutActivities } from '../../application/checkout-saga.js';

const here = fileURLToPath(import.meta.url);
/** The workflow file beside this one: .ts when running from source (tests), .js from dist. */
export const WORKFLOWS_PATH = join(dirname(here), `checkout.workflow${extname(here)}`);

export interface SagaWorkerOptions {
  address: string;
  namespace: string;
  taskQueue: string;
  activities: CheckoutActivities;
  /** A bundle built ahead with bundleWorkflowCode (tests restart workers often); otherwise bundled at startup. */
  workflowBundlePath?: string;
}

/** Runs the checkout saga worker until the process is told to stop (SIGINT or SIGTERM drain it gracefully). */
export async function runSagaWorker(o: SagaWorkerOptions): Promise<void> {
  const connection = await NativeConnection.connect({ address: o.address });
  try {
    const worker = await Worker.create({
      connection,
      namespace: o.namespace,
      taskQueue: o.taskQueue,
      ...(o.workflowBundlePath
        ? { workflowBundle: { codePath: o.workflowBundlePath } }
        : { workflowsPath: WORKFLOWS_PATH }),
      activities: refusalsFailFast(o.activities),
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

/** A refused checkout (AppError) never succeeds on retry: fail the step at once, typed with the error code. */
function refusalsFailFast(activities: CheckoutActivities): CheckoutActivities {
  const wrapped: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, fn] of Object.entries(activities) as [
    string,
    (...args: unknown[]) => Promise<unknown>,
  ][]) {
    wrapped[name] = async (...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        if (err instanceof AppError)
          throw ApplicationFailure.nonRetryable(
            err.message,
            err.code,
            ...(err.details === undefined ? [] : [err.details]),
          );
        throw err;
      }
    };
  }
  return wrapped as unknown as CheckoutActivities;
}
