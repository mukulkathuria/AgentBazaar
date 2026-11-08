import { Uuid } from '@agentbazaar/contracts';
import { describe, expect, it } from 'vitest';
import { seedProductId } from './seed-ids.js';

describe('@lite seeded product ids', () => {
  it('are valid UUIDs, the same for the same slug on every boot, and distinct across slugs', () => {
    const slugs = ['thock-tk87-mechanical-keyboard', 'zentrix-zx7070-12gb', 'mitti-personalised-ceramic-mug', 'a', 'b'];
    const ids = slugs.map(seedProductId);
    for (const id of ids) expect(Uuid.safeParse(id).success).toBe(true);
    expect(slugs.map(seedProductId)).toEqual(ids);
    expect(new Set(ids).size).toBe(slugs.length);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
