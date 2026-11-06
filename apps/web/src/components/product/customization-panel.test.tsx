// @vitest-environment jsdom
import type { CustomizationOptions } from '@agentbazaar/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { jsonResponse, renderWithProviders } from '@/test/render';
import { CustomizationPanel, type CustomizationState } from './customization-panel';

const options: CustomizationOptions = {
  productId: '3f1e2d4c-5b6a-4789-8a1b-2c3d4e5f6a7b',
  schemaId: '4a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d',
  fields: [{ key: 'line1', label: 'Name on mug', minLength: 1, maxLength: 20, script: 'latin', required: true, allowEmoji: false }],
  designs: [{ id: '5b3c4d5e-6f7a-4b2c-8d3e-4f5a6b7c8d9e', name: 'Floral', previewUrl: '/api/v1/customization/designs/floral.svg' }],
  designRequired: false,
  surchargePaise: 9_900,
  nonReturnable: true,
  notice: 'Personalised mugs are made to order and cannot be returned.',
};

describe('CustomizationPanel', () => {
  it('shows the non-returnable notice before any input', () => {
    renderWithProviders(<CustomizationPanel sku="MUG-ROSE-11OZ" options={options} onStateChange={vi.fn()} />);
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('Personalised items can’t be returned');
    expect(note.textContent).toContain(options.notice);
    expect(screen.getByText('Personalisation adds ₹99 per item.')).toBeTruthy();
  });

  it('validates text live against the API and shows the issues on the field', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        verdict: 'rejected',
        issues: [{ field: 'line1', code: 'blocked_word', message: 'That word is not allowed on products.' }],
        normalized: null,
        surchargePaise: 9_900,
        previewUrl: '/api/v1/customization/MUG-ROSE-11OZ/preview.svg?v=1',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onStateChange = vi.fn<(s: CustomizationState) => void>();
    renderWithProviders(<CustomizationPanel sku="MUG-ROSE-11OZ" options={options} onStateChange={onStateChange} />);

    const input = screen.getByLabelText('Name on mug (Required)');
    fireEvent.change(input, { target: { value: 'badword' } });

    expect(await screen.findByText('That word is not allowed on products.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('cz-line1-error');
    expect(screen.getByRole('status').textContent).toBe('Please fix the highlighted text before adding to cart.');
    expect(screen.getByRole('img', { name: 'Preview of your personalised item' }).getAttribute('src')).toBe(
      '/api/proxy/api/v1/customization/MUG-ROSE-11OZ/preview.svg?v=1',
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/proxy/api/v1/customization/MUG-ROSE-11OZ/validate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ text: { line1: 'badword' } });
    await waitFor(() => expect(onStateChange).toHaveBeenLastCalledWith({ values: { text: { line1: 'badword' } }, ready: false }));
  });
});
