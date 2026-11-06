import type { Routes } from '@agentbazaar/contracts';

type RouteName = keyof typeof Routes;

/**
 * Contracts paths used by always-loaded client components, as literals so those bundles skip the contracts
 * barrel (and Zod). `satisfies` fails type-checking if any of them drifts from `Routes`.
 */
export const PATHS = {
  startChat: '/api/v1/chat/sessions',
  sendChat: '/api/v1/chat/sessions/{id}/messages',
  validateCustomization: '/api/v1/customization/{sku}/validate',
  getPayment: '/api/v1/payments/{id}',
  mockGatewayComplete: '/api/v1/mock-gateway/payments/{id}/complete',
} as const satisfies { [K in RouteName]?: (typeof Routes)[K]['path'] };
