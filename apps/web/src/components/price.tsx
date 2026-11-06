import type { Language } from '@agentbazaar/contracts';
import { fmt } from '@/lib/format';
import type { Dict } from '@/lib/i18n/en';
import { inr } from '@/lib/money';

/** Selling price (or range) with MRP and discount, all in Indian grouping (₹1,23,456). */
export function Price({
  pricePaise,
  maxPricePaise,
  mrpPaise,
  lang,
  t,
  large = false,
}: {
  pricePaise: number;
  maxPricePaise?: number;
  mrpPaise?: number;
  lang: Language;
  t: Dict['product'];
  large?: boolean;
}) {
  const range = maxPricePaise !== undefined && maxPricePaise > pricePaise;
  const text = range ? `${inr(pricePaise, lang)} – ${inr(maxPricePaise, lang)}` : inr(pricePaise, lang);
  const discount = mrpPaise && mrpPaise > pricePaise ? Math.round(((mrpPaise - pricePaise) / mrpPaise) * 100) : 0;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className={large ? 'text-2xl font-bold' : 'font-semibold'}>{text}</span>
      {discount > 0 && mrpPaise !== undefined && (
        <>
          <span className="text-sm text-gray-700">
            {t.mrp}: <s>{inr(mrpPaise, lang)}</s>
          </span>
          <span className="text-sm font-semibold text-green-800">{fmt(t.off, { n: discount })}</span>
        </>
      )}
    </p>
  );
}
