'use client';

import type { CustomizationOptions, PublicProduct, PublicVariant } from '@agentbazaar/contracts';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { addToCart } from '@/app/(store)/cart/actions';
import { Price } from '@/components/price';
import { Button, Field, inputClass } from '@/components/ui';
import { fmt } from '@/lib/format';
import { useI18n } from '@/lib/i18n/context';
import { CustomizationPanel, type CustomizationState } from './customization-panel';

type PurchaseProduct = Pick<PublicProduct, 'variants' | 'returnable' | 'returnWindowDays'>;

function VariantPicker({ variants, sku, onChange }: { variants: PublicVariant[]; sku: string; onChange: (sku: string) => void }) {
  const { t } = useI18n();
  if (variants.length < 2) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t.product.options}</legend>
      <div className="flex flex-wrap gap-2">
        {variants.map((v) => (
          <label
            key={v.sku}
            className="flex cursor-pointer items-center gap-2 rounded-md border border-gray-400 px-3 py-2 has-[:checked]:border-blue-700 has-[:checked]:ring-2 has-[:checked]:ring-blue-700"
          >
            <input type="radio" name="variant" value={v.sku} checked={v.sku === sku} onChange={() => onChange(v.sku)} className="size-4" />
            <span>{v.title}</span>
            {!v.inStock && <span className="text-sm text-red-700">({t.product.outOfStock})</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Availability({ variant }: { variant: PublicVariant }) {
  const { t } = useI18n();
  if (!variant.inStock) return <p className="font-semibold text-red-700">{t.product.outOfStock}</p>;
  const text = variant.availableQty <= 5 ? fmt(t.product.onlyLeft, { n: variant.availableQty }) : t.product.inStock;
  return <p className="font-semibold text-green-800">{text}</p>;
}

function ReturnInfo({ product }: { product: PurchaseProduct }) {
  const { t } = useI18n();
  const returnable = product.returnable && product.returnWindowDays > 0;
  return (
    <p className={returnable ? 'text-gray-800' : 'font-medium text-amber-900'}>
      {returnable ? fmt(t.product.returnable, { n: product.returnWindowDays }) : t.product.nonReturnable}
    </p>
  );
}

/** Variant, quantity, personalisation and add-to-cart (via a server action that owns the cart cookie). */
export function ProductPurchase({
  product,
  initialSku,
  customization,
}: {
  product: PurchaseProduct;
  initialSku?: string;
  customization: CustomizationOptions | null;
}) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const variants = product.variants;
  const [sku, setSku] = useState(
    () => (variants.find((v) => v.sku === initialSku) ?? variants.find((v) => v.inStock) ?? variants[0])?.sku ?? '',
  );
  const [quantity, setQuantity] = useState(1);
  const [cz, setCz] = useState<CustomizationState>({ values: undefined, ready: !customization });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const variant = variants.find((v) => v.sku === sku) ?? variants[0];
  if (!variant) return null;
  const maxQty = Math.max(1, Math.min(10, variant.availableQty));

  const add = () => {
    setError(null);
    startTransition(async () => {
      const line = { sku: variant.sku, quantity: Math.min(quantity, maxQty), ...(cz.values ? { customization: cz.values } : {}) };
      const res = await addToCart(line);
      if (res.ok) router.push('/cart');
      else setError(res.message ?? t.product.addFailed);
    });
  };

  return (
    <div className="space-y-4">
      <Price pricePaise={variant.pricePaise} mrpPaise={variant.mrpPaise} lang={lang} t={t.product} large />
      <p className="text-sm text-gray-700">{t.product.taxIncluded}</p>
      <Availability variant={variant} />
      <VariantPicker variants={variants} sku={variant.sku} onChange={setSku} />
      <Field id="quantity" label={t.product.quantity} className="max-w-32">
        {(a) => (
          <select {...a} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className={inputClass}>
            {Array.from({ length: maxQty }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        )}
      </Field>
      {customization && <CustomizationPanel sku={variant.sku} options={customization} onStateChange={setCz} />}
      <ReturnInfo product={product} />
      <Button onClick={add} disabled={!variant.inStock || !cz.ready || pending} className="w-full sm:w-auto">
        {pending ? t.product.adding : t.product.addToCart}
      </Button>
      {error && (
        <p role="alert" className="font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
