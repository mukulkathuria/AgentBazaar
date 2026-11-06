import type { AppConfig } from '@agentbazaar/config';
import { createDatabase } from '../bootstrap/infra.js';
import { OpenBaoKeyWrapper, rewrapDataKeys } from '../modules/pii/index.js';
import { LocalKeyWrapper, loadKeyRing } from '../shared/crypto/keyring.js';

/**
 * `cli pii rewrap`: moves every customer data key from PII_MASTER_KEY to OpenBao Transit (the lite to
 * growth step), and re-wraps Transit ciphertext after a key rotation. Returns the process exit code:
 * 0 once every data key is on the Transit key's latest version.
 */
export async function piiRewrap(config: AppConfig, batchSize: number): Promise<number> {
  const { PII_MASTER_KEY, OPENBAO_ADDR, OPENBAO_TOKEN, OPENBAO_TRANSIT_KEY, OPENBAO_TRANSIT_MOUNT } =
    config.env;
  if (!PII_MASTER_KEY || !OPENBAO_ADDR || !OPENBAO_TOKEN) {
    throw new Error(
      'pii rewrap needs PII_MASTER_KEY (the master key the data keys are wrapped with now), OPENBAO_ADDR and OPENBAO_TOKEN',
    );
  }
  const keys = loadKeyRing(config.env);
  const database = await createDatabase(config);
  try {
    const r = await rewrapDataKeys(
      database.db,
      new LocalKeyWrapper(keys.piiMasterKey, keys.piiKeyId),
      new OpenBaoKeyWrapper(OPENBAO_ADDR, OPENBAO_TOKEN, OPENBAO_TRANSIT_KEY, OPENBAO_TRANSIT_MOUNT),
      batchSize,
    );
    console.log(
      `Moved ${r.moved} data keys from PII_MASTER_KEY to OpenBao Transit key "${OPENBAO_TRANSIT_KEY}".`,
    );
    console.log(`Re-wrapped ${r.rotated} data keys to the Transit key's latest version.`);
    if (r.remaining)
      console.error(
        `${r.remaining} data keys were written with PII_MASTER_KEY while this ran: run it again.`,
      );
    if (r.unknownKey)
      console.error(
        `${r.unknownKey} data keys are wrapped by another key (an older PII_MASTER_KEY?) and were left as they are.`,
      );
    return r.remaining || r.unknownKey ? 1 : 0;
  } finally {
    await database.close();
  }
}
