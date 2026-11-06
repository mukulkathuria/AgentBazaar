import type { Env } from '@agentbazaar/config';
import { ErrorCode } from '@agentbazaar/contracts';
import {
  ApplicationFailure,
  Client,
  Connection,
  WithStartWorkflowOperation,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import { AppError } from '../../../../shared/kernel/errors.js';
import { SAGA, sagaId, type PlacedCheckout, type WorkflowEngine } from '../../application/checkout-saga.js';
import type { checkoutSaga } from './checkout.workflow.js';

type TemporalEnv = Pick<Env, 'TEMPORAL_ADDRESS' | 'TEMPORAL_NAMESPACE' | 'TEMPORAL_TASK_QUEUE'>;

/** The API's side of the Temporal engine: starts checkout sagas and wakes them when their payment changes. */
export async function connectTemporalEngine(env: TemporalEnv): Promise<WorkflowEngine> {
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS! });
  const client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
  return {
    async startCheckout(input) {
      // One saga per session: a second start for a running or finished checkout is refused, a failed one may be retried.
      const startWorkflowOperation = new WithStartWorkflowOperation<typeof checkoutSaga>(SAGA.workflow, {
        workflowId: sagaId(input.sessionId),
        taskQueue: env.TEMPORAL_TASK_QUEUE,
        args: [input],
        workflowIdConflictPolicy: 'FAIL',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
      });
      try {
        return await client.workflow.executeUpdateWithStart<typeof checkoutSaga, PlacedCheckout, []>(
          SAGA.placed,
          {
            startWorkflowOperation,
          },
        );
      } catch (err) {
        throw refusal(err);
      }
    },
    async wake(sessionId) {
      try {
        await client.workflow.getHandle(sagaId(sessionId)).signal(SAGA.wake);
        return true;
      } catch (err) {
        if (err instanceof WorkflowNotFoundError) return false;
        throw err;
      }
    },
    close: () => connection.close(),
  };
}

/** The saga reports a refused checkout as a failure typed with the API's error code; anything else stays a 500. */
function refusal(err: unknown): unknown {
  if (err instanceof WorkflowExecutionAlreadyStartedError)
    return new AppError('conflict', 'This checkout is already complete');
  const cause = err instanceof WorkflowUpdateFailedError ? err.cause : undefined;
  if (!(cause instanceof ApplicationFailure)) return err;
  const code = ErrorCode.safeParse(cause.type);
  if (!code.success) return err;
  return cause.details?.length
    ? new AppError(code.data, cause.message, cause.details[0])
    : new AppError(code.data, cause.message);
}
