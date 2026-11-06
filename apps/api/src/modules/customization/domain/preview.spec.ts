import { describe, expect, it } from 'vitest';
import { escapeXml, renderPreview } from './preview.js';

const texts = (svg: string) => [...svg.matchAll(/<text [^>]*font-size="(\d+)" fill="([^"]+)">([^<]*)<\/text>/g)].map((m) => m.slice(1));

describe('@lite customization preview', () => {
  it('escapes every XML special character in buyer text', () => {
    expect(escapeXml(`<b>"Tom" & 'Jerry'</b>`)).toBe('&lt;b&gt;&quot;Tom&quot; &amp; &apos;Jerry&apos;&lt;/b&gt;');
    expect(escapeXml('plain text')).toBe('plain text');
  });

  it('renders buyer lines as escaped text nodes: first line large, at most three lines, blanks skipped', () => {
    const svg = renderPreview('mug', null, ['<script>alert(1)</script>', '', 'Line two', 'Line three', 'Line four']);
    expect(svg).not.toContain('<script>');
    expect(texts(svg)).toEqual([
      ['28', '#1a202c', '&lt;script&gt;alert(1)&lt;/script&gt;'],
      ['18', '#1a202c', 'Line two'],
      ['18', '#1a202c', 'Line three'],
    ]);
    expect([...svg.matchAll(/<text x="200" y="(\d+)"/g)].map((m) => m[1])).toEqual(['250', '284', '318']);
  });

  it('draws the product silhouette, a generic frame for unknown types and light text on the dark notebook', () => {
    expect(renderPreview('mug', null, [])).toContain('<path d="M280 130');
    expect(renderPreview('tshirt', null, [])).toContain('<path d="M120 70');
    expect(renderPreview('notebook', null, [])).toContain('fill="#2c5282"');
    const generic = renderPreview('poster', null, ['Hi']);
    expect(generic).toContain('<rect x="80" y="80" width="240" height="240"');
    expect(texts(generic)[0]![1]).toBe('#1a202c');
    expect(texts(renderPreview('notebook', null, ['Hi']))[0]![1]).toBe('#ffffff');
  });

  it('embeds a catalogue design without its own svg wrapper', () => {
    const svg = renderPreview('mug', '<svg viewBox="0 0 10 10"><circle r="4"/></svg>', []);
    expect(svg).toContain('<svg x="150" y="110" width="100" height="100"><circle r="4"/></svg>');
    expect(renderPreview('mug', null, [])).not.toContain('<svg x="150"');
  });

  it('is a complete, labelled SVG document', () => {
    const svg = renderPreview('mug', null, ['A']);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-label="Customization preview">')).toBe(true);
    expect(svg.endsWith('</text></svg>')).toBe(true);
  });
});
