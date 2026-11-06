import { apiAssetUrl } from '@/lib/urls';

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
}

export function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

/** Product photo, or a deterministic two-tone placeholder with initials when the product has no images. */
export function ProductImage({
  src,
  name,
  decorative = false,
  className = '',
}: {
  src?: string | null;
  name: string;
  /** Inside a link that already names the product: hide the image from assistive tech. */
  decorative?: boolean;
  className?: string;
}) {
  const box = `aspect-square w-full rounded-md ${className}`;
  if (src) {
    return <img src={apiAssetUrl(src)} alt={decorative ? '' : name} loading="lazy" decoding="async" className={`${box} object-cover`} />;
  }
  const hue = hash(name) % 360;
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name };
  return (
    <svg viewBox="0 0 100 100" className={box} {...a11y}>
      <rect width="100" height="100" fill={`hsl(${hue} 55% 36%)`} />
      <path d="M0 100 L100 0 L100 100 Z" fill={`hsl(${(hue + 50) % 360} 60% 26%)`} />
      <text x="50" y="50" dy="0.35em" textAnchor="middle" fontSize="30" fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">
        {initials(name)}
      </text>
    </svg>
  );
}
