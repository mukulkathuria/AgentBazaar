import type { KeyWrapper } from '../../../shared/crypto/keyring.js';
import { CircuitBreaker, withTimeout } from '../../../shared/resilience/resilience.js';

/**
 * Growth/scale: data keys are wrapped by OpenBao Transit, so the master key never enters the app.
 * The transit key must be created with `derived=true` because each wrap uses the customer as context.
 */
export class OpenBaoKeyWrapper implements KeyWrapper {
  readonly keyId: string;
  private readonly breaker = new CircuitBreaker('openbao', 5, 15_000);

  constructor(
    private readonly addr: string,
    private readonly token: string,
    private readonly keyName: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.keyId = `openbao:${keyName}`;
  }

  private async call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, string>> {
    return this.breaker.exec(() =>
      withTimeout(async (signal) => {
        const res = await this.fetchFn(`${this.addr.replace(/\/$/, '')}/v1/transit/${op}/${encodeURIComponent(this.keyName)}`, {
          method: 'POST',
          headers: { 'X-Vault-Token': this.token, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw new Error(`OpenBao ${op} failed with ${res.status}`);
        const json = (await res.json()) as { data?: Record<string, string> };
        if (!json.data) throw new Error(`OpenBao ${op} returned no data`);
        return json.data;
      }, 3000),
    );
  }

  async wrap(dek: Buffer, context: string): Promise<string> {
    const data = await this.call('encrypt', { plaintext: dek.toString('base64'), context: Buffer.from(context).toString('base64') });
    if (!data.ciphertext) throw new Error('OpenBao returned no ciphertext');
    return data.ciphertext;
  }

  async unwrap(wrapped: string, context: string): Promise<Buffer> {
    const data = await this.call('decrypt', { ciphertext: wrapped, context: Buffer.from(context).toString('base64') });
    if (!data.plaintext) throw new Error('OpenBao returned no plaintext');
    return Buffer.from(data.plaintext, 'base64');
  }
}
