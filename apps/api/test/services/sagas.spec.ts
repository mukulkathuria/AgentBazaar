import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InventoryService } from '../../src/modules/inventory/index.js';
import { WORKFLOW_ENGINE, sagaId, type WorkflowEngine } from '../../src/modules/orders/index.js';
import { WORKFLOWS_PATH } from '../../src/modules/orders/infrastructure/temporal/worker.js';
import { PaymentsService, type MockPaymentAdapter } from '../../src/modules/payments/index.js';
import { generateKeyEnv } from '../../src/shared/crypto/keyring.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { createLogger } from '../../src/shared/observability/logger.js';
import {
  buy,
  completeCheckout,
  createShopApp,
  newCart,
  startCheckout,
  stockOf,
  type ShopApp,
} from '../support/shop.js';

const WORKER = fileURLToPath(new URL('./saga-worker.ts', import.meta.url));
const SKU = 'VOLTEDGE-1000P';
/** Every step of the happy path; the worker dies right after the step's side effects, before Temporal records it. */
const STEPS = [
  'reserveStock',
  'createOrder',
  'createPayment',
  'paymentState',
  'commitStock',
  'issueInvoice',
  'notify',
];
const SCENARIO_MS = 150_000;

type Stock = { on_hand: number; reserved: number };

describe('@scale checkout and payment sagas on Temporal: a crash at every step resumes to one correct outcome', () => {
  const queue = `t9-${randomUUID().slice(0, 8)}`;
  const keys = generateKeyEnv();
  const logs: string[] = [];
  let app: ShopApp;
  let connection: Connection;
  let client: Client;
  let bundleDir: string;
  let worker: ChildProcess | undefined;
  let crashes = 0;

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        logs.push(chunk.toString());
        done();
      },
    });
    app = await createShopApp({
      env: {
        ...keys,
        WORKFLOW_ENGINE: 'temporal',
        TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS!,
        TEMPORAL_TASK_QUEUE: queue,
      },
      logger: createLogger('info', sink),
    });
    await app.infra.database.query(
      'UPDATE stock_levels SET on_hand = 1000 FROM variants v WHERE v.id = stock_levels.variant_id AND v.sku = $1',
      [SKU],
    );
    connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS! });
    client = new Client({ connection });
    // Bundled once here instead of by every worker the suite starts.
    bundleDir = await mkdtemp(join(tmpdir(), 't9-saga-'));
    await writeFile(
      join(bundleDir, 'bundle.js'),
      (await bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH })).code,
    );
  }, 180_000);

  afterAll(async () => {
    await stopWorker();
    await connection?.close();
    await app?.close();
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    crashes = 0;
  });
  // Even when a scenario fails: a worker left running would take the next scenario's steps and its crash.
  afterEach(() => stopWorker());

  /** One worker at a time. A worker that dies is replaced by a healthy one, as a process supervisor would. */
  function startWorker(crashAfter?: string): void {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER], {
      env: {
        ...process.env,
        ...keys,
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: app.infra.config.env.DATABASE_URL!,
        DATABASE_POOL_MAX: '4',
        WORKFLOW_ENGINE: 'temporal',
        TEMPORAL_TASK_QUEUE: queue,
        SKIP_MIGRATIONS: '1',
        SAGA_BUNDLE: join(bundleDir, 'bundle.js'),
        ...(crashAfter ? { SAGA_CRASH_AFTER: crashAfter } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    createInterface({ input: child.stdout }).on('line', (l) => logs.push(l));
    createInterface({ input: child.stderr }).on('line', (l) => logs.push(l));
    child.once('exit', () => {
      if (worker !== child) return;
      crashes += 1;
      startWorker();
    });
    worker = child;
  }

  /** Kills the current worker abruptly, without a replacement. */
  async function stopWorker(): Promise<void> {
    const w = worker;
    worker = undefined;
    if (w && w.exitCode === null && w.signalCode === null) {
      w.kill('SIGKILL');
      await once(w, 'exit');
    }
  }

  const sagaResult = (sessionId: string): Promise<string> =>
    client.workflow.getHandle(sagaId(sessionId)).result();
  const count = async (from: string, params: unknown[]) =>
    (await app.infra.database.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${from}`, params))[0]!.n;
  const orderRow = async (id: string) =>
    (
      await app.infra.database.query<{ status: string; invoice_number: string | null }>(
        'SELECT status, invoice_number FROM orders WHERE id = $1',
        [id],
      )
    )[0]!;
  const paidEmails = (number: string) =>
    logs.filter(
      (l) =>
        l.includes('"msg":"order email"') &&
        l.includes('"template":"order.paid"') &&
        l.includes(`"${number}"`),
    ).length;
  const refunds = (orderId: string) =>
    count('refunds r JOIN payments p ON p.id = r.payment_id WHERE p.order_id = $1', [orderId]);

  /** What the mock gateway posts to the webhook endpoint; the outbox drain then wakes the saga. */
  async function webhook(orderId: string, kind: 'captured' | 'failed', eventId?: string): Promise<string> {
    const [p] = await app.infra.database.query<{ provider_order_id: string; amount_paise: number }>(
      'SELECT provider_order_id, amount_paise FROM payments WHERE order_id = $1',
      [orderId],
    );
    const gateway = app.app.get(PaymentsService).port as MockPaymentAdapter;
    const ev = gateway.signedEvent({
      kind,
      providerOrderId: p!.provider_order_id,
      amountPaise: p!.amount_paise,
      ...(eventId ? { eventId } : {}),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/mock',
      headers: { ...ev.headers, 'content-type': 'application/json' },
      payload: ev.raw,
    });
    return res.json<{ result: string }>().result;
  }

  async function expectPaidOnce(order: { orderId: string; number: string }, before: Stock): Promise<void> {
    const o = await orderRow(order.orderId);
    expect(o.status).toBe('paid');
    expect(o.invoice_number).toMatch(/^INV\//);
    expect(await count('invoices WHERE order_id = $1', [order.orderId])).toBe(1);
    expect(await count(`order_events WHERE order_id = $1 AND to_status = 'paid'`, [order.orderId])).toBe(1);
    expect(
      await count(`reservations WHERE owner_ref = $1 AND status = 'committed'`, [`order:${order.orderId}`]),
    ).toBe(1);
    expect(await count(`payments WHERE order_id = $1 AND status = 'captured'`, [order.orderId])).toBe(1);
    expect(await count('payments WHERE order_id = $1', [order.orderId])).toBe(1);
    expect(await refunds(order.orderId)).toBe(0);
    expect(await stockOf(app, SKU)).toEqual({ on_hand: before.on_hand - 1, reserved: before.reserved });
    expect(paidEmails(order.number)).toBe(1);
  }

  async function expectClosedOnce(
    orderId: string,
    status: 'expired' | 'cancelled',
    before: Stock,
    refunded: number,
  ) {
    expect((await orderRow(orderId)).status).toBe(status);
    expect(await count('order_events WHERE order_id = $1 AND to_status = $2', [orderId, status])).toBe(1);
    expect(await count(`reservations WHERE owner_ref = $1 AND status <> 'held'`, [`order:${orderId}`])).toBe(
      1,
    );
    expect(await count('invoices WHERE order_id = $1', [orderId])).toBe(0);
    expect(await refunds(orderId)).toBe(refunded);
    expect(await stockOf(app, SKU)).toEqual(before);
  }

  it.each(STEPS)(
    'a worker killed right after %s resumes to one paid order: stock committed, invoiced and notified once',
    async (step) => {
      const before = await stockOf(app, SKU);
      startWorker(step);
      const { session, order } = await buy(app, { sku: SKU, quantity: 1 });
      expect(await webhook(order.orderId, 'captured')).toBe('applied');
      await app.drain();
      expect(await sagaResult(session.sessionId)).toBe('paid');
      await app.drain(); // the relay's copy of order.paid reaches an email consumer that already sent it
      expect(crashes).toBe(1);
      await expectPaidOnce(order, before);
    },
    SCENARIO_MS,
  );

  it(
    'a worker killed while the saga waits, then replayed and out-of-order webhooks: replays history and pays once',
    async () => {
      const before = await stockOf(app, SKU);
      startWorker();
      const { session, order } = await buy(app, { sku: SKU, quantity: 1 });
      await stopWorker(); // SIGKILL while the saga sleeps on its payment timer
      expect(await webhook(order.orderId, 'failed', `evt_t9_${order.number}_1`)).toBe('applied');
      await app.drain();
      expect(await webhook(order.orderId, 'captured', `evt_t9_${order.number}_2`)).toBe('applied');
      expect(await webhook(order.orderId, 'captured', `evt_t9_${order.number}_2`)).toBe('duplicate');
      expect(await webhook(order.orderId, 'failed', `evt_t9_${order.number}_3`)).toBe('stale');
      await app.drain(); // signals wait in Temporal until a worker is back
      expect((await completeCheckout(app, session)).statusCode).toBe(409); // a double submit never starts a second saga
      startWorker();
      expect(await sagaResult(session.sessionId)).toBe('paid');
      await app.drain();
      await expectPaidOnce(order, before);
    },
    SCENARIO_MS,
  );

  it(
    'payment failed, then the window closed: the order expires once and its stock comes back (killed after abandon)',
    async () => {
      const before = await stockOf(app, SKU);
      startWorker('abandon');
      const { session, order } = await buy(app, { sku: SKU, quantity: 1 });
      expect(await webhook(order.orderId, 'failed')).toBe('applied');
      await app.drain();
      await app.infra.database.query(
        `UPDATE orders SET payment_expires_at = now() + interval '1 second' WHERE id = $1`,
        [order.orderId],
      );
      expect(await app.app.get<WorkflowEngine>(WORKFLOW_ENGINE).wake(session.sessionId)).toBe(true);
      expect(await sagaResult(session.sessionId)).toBe('expired');
      expect(crashes).toBe(1);
      await expectClosedOnce(order.orderId, 'expired', before, 0);
    },
    SCENARIO_MS,
  );

  it(
    'a cancelled saga cancels the order once and puts the stock back (killed after abandon)',
    async () => {
      const before = await stockOf(app, SKU);
      startWorker('abandon');
      const { session, order } = await buy(app, { sku: SKU, quantity: 1 });
      await client.workflow.getHandle(sagaId(session.sessionId)).cancel();
      await expect(sagaResult(session.sessionId)).rejects.toBeInstanceOf(WorkflowFailedError);
      expect(crashes).toBe(1);
      await expectClosedOnce(order.orderId, 'cancelled', before, 0);
    },
    SCENARIO_MS,
  );

  it(
    'money that arrived before a cancel is refunded exactly once (killed after the refund)',
    async () => {
      const before = await stockOf(app, SKU);
      startWorker('refund');
      const { session, order } = await buy(app, { sku: SKU, quantity: 1 });
      expect(await webhook(order.orderId, 'captured')).toBe('applied'); // not drained: the saga has not heard yet
      await client.workflow.getHandle(sagaId(session.sessionId)).cancel();
      await expect(sagaResult(session.sessionId)).rejects.toBeInstanceOf(WorkflowFailedError);
      await app.drain(); // the late capture finds the order closed; the in-process refund is the same single refund
      expect(crashes).toBe(1);
      await expectClosedOnce(order.orderId, 'cancelled', before, 1);
      expect(await count(`payments WHERE order_id = $1 AND status = 'refunded'`, [order.orderId])).toBe(1);
    },
    SCENARIO_MS,
  );

  it(
    'a checkout the saga refuses (sold out after the hold lapsed) answers 409 and leaves no order',
    async () => {
      startWorker();
      const session = await startCheckout(app, { cartId: await newCart(app, [{ sku: SKU, quantity: 1 }]) });
      const inventory = app.app.get(InventoryService);
      await inTransaction(app.infra.db, (tx) =>
        inventory.release(tx, `checkout:${session.sessionId}`, 'expired'),
      );
      const [s] = await app.infra.database.query<Stock>(
        'SELECT s.on_hand, s.reserved FROM stock_levels s JOIN variants v ON v.id = s.variant_id WHERE v.sku = $1',
        [SKU],
      );
      await app.infra.database.query(
        'UPDATE stock_levels SET on_hand = reserved FROM variants v WHERE v.id = stock_levels.variant_id AND v.sku = $1',
        [SKU],
      );
      try {
        const res = await completeCheckout(app, session);
        expect(res.statusCode).toBe(409);
        expect(res.json<{ error: { code: string } }>().error.code).toBe('out_of_stock');
        expect(await count('orders WHERE checkout_session_id = $1', [session.sessionId])).toBe(0);
      } finally {
        await app.infra.database.query(
          'UPDATE stock_levels SET on_hand = $2 FROM variants v WHERE v.id = stock_levels.variant_id AND v.sku = $1',
          [SKU, s!.on_hand],
        );
      }
    },
    SCENARIO_MS,
  );
});
