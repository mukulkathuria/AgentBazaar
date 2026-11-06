// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { CheckoutForm } from './checkout-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function renderForm() {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  renderWithProviders(<CheckoutForm sessionId={SESSION} token="cap-token" terms={['Prices include GST.']} />);
  return fetchMock;
}

describe('CheckoutForm address validation', () => {
  it('shows contract-schema errors tied to their inputs and does not submit', async () => {
    const fetchMock = renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByText('Enter a valid Indian mobile number')).toBeTruthy();
    expect(screen.getByText('Enter a valid 6-digit PIN code')).toBeTruthy();
    expect(screen.getByText('You must accept the terms of sale')).toBeTruthy();
    expect(screen.getAllByText('This field is required').length).toBeGreaterThanOrEqual(4); // email, name, line1, city, state

    const phone = screen.getByLabelText('Mobile number');
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(phone.getAttribute('aria-describedby')).toBe('phone-hint phone-error');
    expect(screen.getByLabelText('I have read and accept the terms of sale').getAttribute('aria-describedby')).toBe('acceptTerms-error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed phone and PIN even when everything else is filled in', async () => {
    const fetchMock = renderForm();
    const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fill('Email', 'asha@example.com');
    fill('Full name', 'Asha Verma');
    fill('Mobile number', '12345');
    fill('PIN code', '012345');
    fill('House, building and street', '12 MG Road');
    fill('City', 'Bengaluru');
    fill('State', 'KA');
    fireEvent.click(screen.getByLabelText('I have read and accept the terms of sale'));
    fireEvent.click(screen.getByRole('button', { name: 'Place order' }));

    expect(await screen.findByText('Enter a valid Indian mobile number')).toBeTruthy();
    expect(screen.getByText('Enter a valid 6-digit PIN code')).toBeTruthy();
    expect(screen.queryByText('This field is required')).toBeNull();
    expect(screen.queryByText('You must accept the terms of sale')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
