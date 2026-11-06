/** Server-rendered SVG preview. Buyer text is escaped and rendered as text nodes only. */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

const SILHOUETTES: Record<string, string> = {
  mug: '<rect x="90" y="80" width="190" height="230" rx="18" fill="#ffffff" stroke="#4a5568" stroke-width="4"/><path d="M280 130 q70 0 70 70 q0 70 -70 70" fill="none" stroke="#4a5568" stroke-width="14"/>',
  tshirt: '<path d="M120 70 l-70 50 l30 50 l35 -20 v200 h170 v-200 l35 20 l30 -50 l-70 -50 q-40 30 -80 0 z" fill="#ffffff" stroke="#4a5568" stroke-width="4"/>',
  notebook: '<rect x="100" y="60" width="200" height="280" rx="8" fill="#2c5282"/><rect x="100" y="60" width="18" height="280" fill="#1a365d"/>',
};

export function renderPreview(productType: string, designSvg: string | null, lines: readonly string[]): string {
  const silhouette = SILHOUETTES[productType] ?? '<rect x="80" y="80" width="240" height="240" rx="12" fill="#ffffff" stroke="#4a5568" stroke-width="4"/>';
  const dark = productType === 'notebook';
  // Designs come from our own reviewed catalogue, never from buyers.
  const design = designSvg ? `<svg x="150" y="110" width="100" height="100">${designSvg.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>` : '';
  const text = lines
    .filter(Boolean)
    .slice(0, 3)
    .map(
      (l, i) =>
        `<text x="200" y="${250 + i * 34}" text-anchor="middle" font-family="sans-serif" font-size="${i === 0 ? 28 : 18}" fill="${dark ? '#ffffff' : '#1a202c'}">${escapeXml(l)}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="Customization preview"><rect width="400" height="400" fill="#edf2f7"/>${silhouette}${design}${text}</svg>`;
}
