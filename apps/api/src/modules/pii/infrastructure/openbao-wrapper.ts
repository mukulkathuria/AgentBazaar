import type { KeyWrapper } from '../../../shared/crypto/keyring.js';
import { CircuitBreaker, TimeoutError, withTimeout } from '../../../shared/resilience/resilience.js';

const TIMEOUT_MS = 3000;

/** The network-level reason fetch failed (ECONNREFUSED, ENOTFOUND, ...) instead of a bare "fetch failed". */
function networkReason(err: unknown): string {
  const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
  return cause?.code ?? cause?.errors?.[0]?.code ?? (err instanceof Error ? err.message : String(err));
}

/**
 * Growth/scale: data keys are wrapped by OpenBao Transit, so the master key never enters the app.
 * The transit key must be created with `derived=true` because each wrap uses the customer as context.
 */
export class OpenBaoKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  private readonly breaker = new CircuitBreaker('openbao', 5, 15_000);
  private readonly base: string;

  constructor(
    addr: string,
    private readonly token: string,
    private readonly keyName: string,
    /** Transit secrets engine mount path. */
    mount = 'transit',
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.keyId = `openbao:${keyName}`;
    this.base = `${addr.replace(/\/$/, '')}/v1/${mount}`;
  }

  private async call(
    op: 'encrypt' | 'decrypt' | 'rewrap' | 'keys',
    body?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const url = `${this.base}/${op}/${encodeURIComponent(this.keyName)}`;
    const request = () =>
      withTimeout(async (signal) => {
        let res: Response;
        try {
          res = await this.fetchFn(url, {
            method: body ? 'POST' : 'GET',
            headers: { 'X-Vault-Token': this.token, 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal,
          });
        } catch (err) {
          throw new Error(`OpenBao at ${this.base} is unreachable: ${networkReason(err)}`, { cause: err });
        }
        const json = (await res.json().catch(() => ({}))) as {
          data?: Record<string, unknown>;
          errors?: string[];
        };
        if (!res.ok) {
          const why = (json.errors ?? []).join('; ').slice(0, 200) || res.statusText;
          throw new Error(
            `OpenBao ${op} with transit key "${this.keyName}" failed with HTTP ${res.status}: ${why}`,
          );
        }
        if (!json.data) throw new Error(`OpenBao ${op} returned no data`);
        return json.data;
      }, TIMEOUT_MS);
    return this.breaker.exec(() =>
      request().catch((err: unknown) => {
        throw err instanceof TimeoutError
          ? new Error(`OpenBao at ${this.base} did not answer within ${TIMEOUT_MS} ms`)
          : err;
      }),
    );
  }

  private async ciphertext(op: 'encrypt' | 'rewrap', body: Record<string, string>): Promise<string> {
    const { ciphertext } = await this.call(op, body);
    if (typeof ciphertext !== 'string') throw new Error(`OpenBao ${op} returned no ciphertext`);
    return ciphertext;
  }

  async wrap(dek: Buffer, context: string): Promise<string> {
    return this.ciphertext('encrypt', {
      plaintext: dek.toString('base64'),
      context: Buffer.from(context).toString('base64'),
    });
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    const { plaintext } = await this.call('decrypt', {
      ciphertext: wrapped,
      context: Buffer.from(context).toString('base64'),
    });
    if (typeof plaintext !== 'string') throw new Error('OpenBao returned no plaintext');
    return Buffer.from(plaintext, 'base64');
  }

  /** Re-encrypts under the latest key version inside OpenBao; the data key never leaves it. */
  async rewrap(wrapped: string, context: string): Promise<string> {
    return this.ciphertext('rewrap', {
      ciphertext: wrapped,
      context: Buffer.from(context).toString('base64'),
    });
  }

  /** The key version new wraps use; Transit ciphertext starts with `vault:v<version>:`. */
  async latestVersion(): Promise<number> {
    const { latest_version: version } = await this.call('keys');
    if (typeof version !== 'number') throw new Error('OpenBao returned no latest_version');
    return version;
  }
}
