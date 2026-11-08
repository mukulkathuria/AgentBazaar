import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomizationService } from '../../src/modules/customization/application/customization.service.js';
import { inTransaction } from '../../src/shared/db/database.js';
import { createShopApp, type ShopApp } from '../support/shop.js';

const MUG = 'MITTI-MUG-WHITE';
const TEE = 'DESI-TEE-M';
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Customization service against a seeded shop: options, previews and the human review queue. */
describe('@lite customization service', () => {
  let app: ShopApp;
  let svc: CustomizationService;
  const q = <T>(text: string, params: unknown[] = []) => app.infra.database.query<T>(text, params);

  beforeAll(async () => {
    app = await createShopApp();
    svc = app.app.get(CustomizationService);
  }, 120_000);
  afterAll(async () => app.close());

  it('describes the options of a personalisable item and refuses the rest', async () => {
    const mug = await svc.options(MUG);
    expect(mug).toMatchObject({ designRequired: false, surchargePaise: 9_900, nonReturnable: true });
    expect(mug.fields.map((f) => f.key)).toEqual(['name', 'message']);
    expect(mug.designs.map((d) => d.name)).toContain('Diwali Diyas');
    expect(mug.designs.every((d) => d.previewUrl.startsWith('data:image/svg+xml;base64,'))).toBe(true);
    // Designs are filtered by product type: the line-art design is for T-shirts only.
    expect(mug.designs.map((d) => d.name)).not.toContain('Mountain Line Art');
    expect((await svc.options(TEE)).designRequired).toBe(true);
    await expect(svc.options('THOCK-TK87-RED')).rejects.toMatchObject({ code: 'validation_failed', message: expect.stringContaining('cannot be customized') });
  });

  it('validates values and links a preview of the normalised text', async () => {
    const ok = await svc.validate(MUG, { text: { name: '  Asha  Verma ' } });
    expect(ok).toMatchObject({ verdict: 'approved', normalized: { text: { name: 'Asha Verma' } }, surchargePaise: 9_900 });
    expect(ok.previewUrl).toBe(`http://api.test/api/v1/customization/${MUG}/preview.svg?d=${encode({ text: { name: 'Asha Verma' } })}`);
    const missing = await svc.validate(MUG, { text: {} });
    expect(missing).toMatchObject({ verdict: 'rejected', normalized: null, previewUrl: null });
    await expect(svc.requireAcceptable(MUG, { text: {} })).rejects.toMatchObject({ code: 'validation_failed', message: 'This customization cannot be accepted' });
  });

  it('renders previews with the buyer text escaped and the chosen catalogue design', async () => {
    const svg = await svc.previewSvg(MUG, encode({ text: { name: 'Tom & Jerry' } }));
    expect(svg).toContain('>Tom &amp; Jerry</text>');
    expect(svg).not.toContain('<svg x="150"');
    // The chosen design is embedded, not just the first one; an empty optional field adds no text.
    const designs = (await svc.options(TEE)).designs;
    const chosen = designs[designs.length - 1]!;
    const svgOf = (d: { previewUrl: string }) => Buffer.from(d.previewUrl.split(',')[1]!, 'base64').toString('utf8');
    const inner = svgOf(chosen).replace(/^<svg[^>]*>|<\/svg>$/g, '');
    const withDesign = await svc.previewSvg(TEE, encode({ text: { name: 'Ravi' }, designId: chosen.id }));
    expect(withDesign).toContain(`<svg x="150" y="110" width="100" height="100">${inner}</svg>`);
    expect([...withDesign.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1])).toEqual(['Ravi']);
  });

  it('refuses preview data that is too large, unreadable, off-schema or not acceptable', async () => {
    const invalid = { code: 'validation_failed', message: 'Invalid preview data' };
    await expect(svc.previewSvg(MUG, 'a'.repeat(4001))).rejects.toMatchObject({ code: 'validation_failed', message: 'Preview data too large' });
    // Exactly 4,000 characters is still read (and here fails as data, not as size).
    await expect(svc.previewSvg(MUG, 'a'.repeat(4000))).rejects.toMatchObject(invalid);
    await expect(svc.previewSvg(MUG, encode('x').slice(0, -1) + '!')).rejects.toMatchObject(invalid);
    await expect(svc.previewSvg(MUG, Buffer.from('{not json').toString('base64url'))).rejects.toMatchObject(invalid);
    await expect(svc.previewSvg(MUG, encode({ text: 'Asha' }))).rejects.toMatchObject(invalid);
    await expect(svc.previewSvg(MUG, encode({ text: {} }))).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'This customization cannot be previewed',
    });
  });

  it('queues flagged text once and lets an admin approve or reject it, with an audit entry', async () => {
    await inTransaction(app.infra.db, (tx) =>
      svc.flagForReview(tx, MUG, [
        { field: 'name', text: 'review me', flags: ['wordlist', 'mixed_script'] },
        { field: 'message', text: 'and me', flags: ['wordlist'] },
      ]),
    );
    const queued = (await svc.listReviews()).filter((r) => r.sku === MUG);
    expect(queued.map((r) => [r.field, r.text, r.flags, r.status])).toEqual(
      expect.arrayContaining([
        ['name', 'review me', ['wordlist', 'mixed_script'], 'pending'],
        ['message', 'and me', ['wordlist'], 'pending'],
      ]),
    );
    const [first, second] = queued;
    expect(await svc.decideReview(first!.id, true, 'fine', 'admin:1')).toMatchObject({ id: first!.id, status: 'approved' });
    expect(await svc.decideReview(second!.id, false, undefined, 'admin:1')).toMatchObject({ status: 'rejected' });
    await expect(svc.decideReview(first!.id, false, undefined, 'admin:1')).rejects.toMatchObject({
      code: 'conflict',
      message: 'Review not found or already decided',
    });
    const audit = await q<{ action: string; target: string; data: unknown }>(`SELECT action, target, data FROM audit_log WHERE action LIKE 'customization.%' ORDER BY id`);
    expect(audit).toEqual([
      { action: 'customization.approved', target: first!.id, data: { sku: MUG } },
      { action: 'customization.rejected', target: second!.id, data: { sku: MUG } },
    ]);
    const [note] = await q<{ note: string | null; decided_by: string }>('SELECT note, decided_by FROM customization_reviews WHERE id = $1', [first!.id]);
    expect(note).toEqual({ note: 'fine', decided_by: 'admin:1' });
  });
});
