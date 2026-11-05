import { z } from 'zod';
import { ErrorBody, PageQuery, Uuid } from './common.js';
import {
  AdminProductInput,
  Availability,
  CategoryNode,
  ProductSummary,
  PublicProduct,
  SearchQuery,
  SearchResult,
} from './catalog.js';
import { CustomizationOptions, CustomizationValidation, CustomizationValues } from './customization.js';
import { DiscountPolicyInput, MakeOfferInput, NegotiationOutcome, RequestQuoteInput } from './pricing.js';
import {
  CartLineInput,
  CartView,
  CheckoutLink,
  CheckoutSessionView,
  CompleteCheckoutInput,
  OrderView,
  ReturnRequestInput,
  ShipOrderInput,
  StartCheckoutInput,
} from './orders.js';
import { MockGatewayAction, PaymentView } from './payments.js';
import {
  AgentClientView,
  ConsentUpdate,
  CreateAgentClientInput,
  LoginInput,
  MeView,
  RegisterInput,
  TokenResponse,
} from './identity.js';
import { ChatMessageInput, ChatReply, ChatSessionView, ChatStartInput } from './chat.js';
import {
  ApprovalView,
  DashboardView,
  DecisionInput,
  HandoffView,
  NegotiationSummaryView,
  ReviewItemView,
  TrackEventInput,
} from './admin.js';

export type RouteAuth = 'public' | 'optional' | 'customer' | 'admin' | 'quote:create' | 'order:create';

export interface RouteDef {
  readonly method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  readonly auth: RouteAuth;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
  readonly response: z.ZodType;
  readonly status?: number;
  readonly idempotent?: boolean;
}

const Ok = z.object({ ok: z.literal(true) });
const IdParam = z.object({ id: Uuid });
const SlugParam = z.object({ slug: z.string().max(160) });
const SkuParam = z.object({ sku: z.string().max(64) });

/** Every public REST endpoint. The API uses these schemas for validation, so docs cannot drift. */
export const Routes = {
  // Catalog
  searchProducts: { method: 'get', path: '/api/v1/products', summary: 'Hybrid product search with facets', tag: 'catalog', auth: 'public', query: SearchQuery, response: SearchResult },
  getProduct: { method: 'get', path: '/api/v1/products/{slug}', summary: 'Product detail with variants', tag: 'catalog', auth: 'public', params: SlugParam, response: PublicProduct },
  listCategories: { method: 'get', path: '/api/v1/categories', summary: 'Category tree (ltree)', tag: 'catalog', auth: 'public', response: z.array(CategoryNode) },
  checkAvailability: { method: 'get', path: '/api/v1/availability/{sku}', summary: 'Stock check for a variant', tag: 'catalog', auth: 'public', params: SkuParam, query: z.object({ quantity: z.coerce.number().int().min(1).max(1000).default(1) }), response: Availability },
  recommendations: { method: 'get', path: '/api/v1/products/{slug}/recommendations', summary: 'Bought together and alternatives', tag: 'catalog', auth: 'public', params: SlugParam, response: z.array(ProductSummary) },
  compatibleItems: { method: 'get', path: '/api/v1/products/{slug}/compatible', summary: 'Compatible items from the product graph', tag: 'catalog', auth: 'public', params: SlugParam, response: z.array(ProductSummary) },
  // Customization
  customizationOptions: { method: 'get', path: '/api/v1/customization/{sku}', summary: 'Allowed text fields and designs', tag: 'customization', auth: 'public', params: SkuParam, response: CustomizationOptions },
  validateCustomization: { method: 'post', path: '/api/v1/customization/{sku}/validate', summary: 'Validate text and design choice', tag: 'customization', auth: 'public', params: SkuParam, body: CustomizationValues, response: CustomizationValidation },
  // Negotiation
  requestQuote: { method: 'post', path: '/api/v1/quotes', summary: 'Open a negotiation and get a signed quote', tag: 'negotiation', auth: 'quote:create', body: RequestQuoteInput, response: NegotiationOutcome, status: 201 },
  makeOffer: { method: 'post', path: '/api/v1/negotiations/{id}/offers', summary: 'Counter-offer inside policy limits', tag: 'negotiation', auth: 'quote:create', params: IdParam, body: MakeOfferInput.omit({ negotiationId: true }), response: NegotiationOutcome },
  // Cart and checkout
  createCart: { method: 'post', path: '/api/v1/carts', summary: 'Create an anonymous cart', tag: 'cart', auth: 'optional', response: CartView, status: 201 },
  getCart: { method: 'get', path: '/api/v1/carts/{id}', summary: 'Read a cart', tag: 'cart', auth: 'optional', params: IdParam, response: CartView },
  addCartLine: { method: 'post', path: '/api/v1/carts/{id}/lines', summary: 'Add a line', tag: 'cart', auth: 'optional', params: IdParam, body: CartLineInput, response: CartView },
  updateCartLine: { method: 'patch', path: '/api/v1/carts/{id}/lines/{lineId}', summary: 'Change quantity', tag: 'cart', auth: 'optional', params: z.object({ id: Uuid, lineId: Uuid }), body: z.strictObject({ quantity: z.number().int().min(1).max(1000) }), response: CartView },
  removeCartLine: { method: 'delete', path: '/api/v1/carts/{id}/lines/{lineId}', summary: 'Remove a line', tag: 'cart', auth: 'optional', params: z.object({ id: Uuid, lineId: Uuid }), response: CartView },
  startCheckout: { method: 'post', path: '/api/v1/checkout/sessions', summary: 'Lock prices and reserve stock from a cart or quote', tag: 'checkout', auth: 'optional', body: StartCheckoutInput, response: CheckoutSessionView, status: 201, idempotent: true },
  getCheckout: { method: 'get', path: '/api/v1/checkout/sessions/{id}', summary: 'Read a checkout session (needs its token)', tag: 'checkout', auth: 'optional', params: IdParam, query: z.object({ t: z.string().max(2000) }), response: CheckoutSessionView },
  checkoutLink: { method: 'post', path: '/api/v1/checkout/sessions/{id}/link', summary: 'Signed link a human uses to pay', tag: 'checkout', auth: 'optional', params: IdParam, query: z.object({ t: z.string().max(2000) }), response: CheckoutLink },
  completeCheckout: { method: 'post', path: '/api/v1/checkout/sessions/{id}/complete', summary: 'Human confirms address and payment method', tag: 'checkout', auth: 'optional', params: IdParam, query: z.object({ t: z.string().max(2000) }), body: CompleteCheckoutInput, response: OrderView, status: 201, idempotent: true },
  // Orders
  getOrder: { method: 'get', path: '/api/v1/orders/{id}', summary: 'Order status (owner or order token)', tag: 'orders', auth: 'optional', params: IdParam, query: z.object({ t: z.string().max(2000).optional() }), response: OrderView },
  myOrders: { method: 'get', path: '/api/v1/me/orders', summary: 'Orders of the signed-in customer', tag: 'orders', auth: 'customer', query: PageQuery, response: z.array(OrderView) },
  cancelOrder: { method: 'post', path: '/api/v1/orders/{id}/cancel', summary: 'Cancel before shipping', tag: 'orders', auth: 'optional', params: IdParam, query: z.object({ t: z.string().max(2000).optional() }), response: OrderView },
  requestReturn: { method: 'post', path: '/api/v1/orders/{id}/returns', summary: 'Request a return within the window', tag: 'orders', auth: 'optional', params: IdParam, query: z.object({ t: z.string().max(2000).optional() }), body: ReturnRequestInput, response: OrderView },
  // Payments
  getPayment: { method: 'get', path: '/api/v1/payments/{id}', summary: 'Payment status', tag: 'payments', auth: 'optional', params: IdParam, query: z.object({ t: z.string().max(2000) }), response: PaymentView },
  mockGatewayComplete: { method: 'post', path: '/api/v1/mock-gateway/payments/{id}/complete', summary: 'Mock gateway: simulate the buyer paying (mock adapter only)', tag: 'payments', auth: 'public', params: IdParam, body: MockGatewayAction, response: Ok },
  // Identity
  register: { method: 'post', path: '/api/v1/auth/register', summary: 'Create a customer account', tag: 'identity', auth: 'public', body: RegisterInput, response: TokenResponse, status: 201 },
  login: { method: 'post', path: '/api/v1/auth/login', summary: 'Sign in (admins also send a TOTP code)', tag: 'identity', auth: 'public', body: LoginInput, response: TokenResponse },
  refresh: { method: 'post', path: '/api/v1/auth/refresh', summary: 'Rotate the refresh token', tag: 'identity', auth: 'public', body: z.strictObject({ refreshToken: z.string().min(20).max(500) }), response: TokenResponse },
  me: { method: 'get', path: '/api/v1/me', summary: 'Profile and consents', tag: 'identity', auth: 'customer', response: MeView },
  updateConsent: { method: 'put', path: '/api/v1/me/consents', summary: 'Grant or withdraw a consent', tag: 'identity', auth: 'customer', body: ConsentUpdate, response: MeView },
  exportData: { method: 'get', path: '/api/v1/me/export', summary: 'DPDP data export', tag: 'identity', auth: 'customer', response: z.record(z.string(), z.unknown()) },
  eraseAccount: { method: 'post', path: '/api/v1/me/erase', summary: 'DPDP erasure (crypto-shredding)', tag: 'identity', auth: 'customer', body: z.strictObject({ confirm: z.literal('ERASE') }), response: Ok },
  mfaSetup: { method: 'post', path: '/api/v1/me/mfa/setup', summary: 'Start TOTP enrolment', tag: 'identity', auth: 'customer', response: z.object({ secret: z.string(), otpauthUrl: z.string() }) },
  mfaVerify: { method: 'post', path: '/api/v1/me/mfa/verify', summary: 'Confirm TOTP enrolment', tag: 'identity', auth: 'customer', body: z.strictObject({ code: z.string().regex(/^\d{6}$/) }), response: Ok },
  // Chat
  startChat: { method: 'post', path: '/api/v1/chat/sessions', summary: 'Start a chat with the seller agent', tag: 'chat', auth: 'optional', body: ChatStartInput, response: ChatSessionView, status: 201 },
  sendChat: { method: 'post', path: '/api/v1/chat/sessions/{id}/messages', summary: 'Send a message (JSON, or SSE with Accept: text/event-stream)', tag: 'chat', auth: 'optional', params: IdParam, body: ChatMessageInput, response: ChatReply },
  // Analytics (GEO)
  trackEvent: { method: 'post', path: '/api/v1/analytics/events', summary: 'Record crawler hits and AI referrals (web server only)', tag: 'analytics', auth: 'public', body: TrackEventInput, response: Ok, status: 202 },
  productFeed: { method: 'get', path: '/api/v1/feed/products', summary: 'Product feed for search engines and LLM providers', tag: 'analytics', auth: 'public', query: PageQuery, response: z.array(PublicProduct) },
  // Admin
  adminDashboard: { method: 'get', path: '/api/v1/admin/dashboard', summary: 'Orders, negotiation, agent cost and GEO metrics', tag: 'admin', auth: 'admin', response: DashboardView },
  adminApprovals: { method: 'get', path: '/api/v1/admin/approvals', summary: 'Discounts waiting for a human', tag: 'admin', auth: 'admin', response: z.array(ApprovalView) },
  adminDecideApproval: { method: 'post', path: '/api/v1/admin/approvals/{id}/decide', summary: 'Approve or decline a discount', tag: 'admin', auth: 'admin', params: IdParam, body: DecisionInput, response: ApprovalView },
  adminReviews: { method: 'get', path: '/api/v1/admin/reviews', summary: 'Flagged customization text', tag: 'admin', auth: 'admin', response: z.array(ReviewItemView) },
  adminDecideReview: { method: 'post', path: '/api/v1/admin/reviews/{id}/decide', summary: 'Approve or reject flagged text', tag: 'admin', auth: 'admin', params: IdParam, body: DecisionInput, response: ReviewItemView },
  adminHandoffs: { method: 'get', path: '/api/v1/admin/handoffs', summary: 'Chats escalated to a human', tag: 'admin', auth: 'admin', response: z.array(HandoffView) },
  adminResolveHandoff: { method: 'post', path: '/api/v1/admin/handoffs/{id}/resolve', summary: 'Close a handoff', tag: 'admin', auth: 'admin', params: IdParam, response: HandoffView },
  adminNegotiations: { method: 'get', path: '/api/v1/admin/negotiations', summary: 'Negotiation transcripts', tag: 'admin', auth: 'admin', query: PageQuery, response: z.array(NegotiationSummaryView) },
  adminPolicies: { method: 'get', path: '/api/v1/admin/policies', summary: 'Discount policies per band', tag: 'admin', auth: 'admin', response: z.array(DiscountPolicyInput) },
  adminUpdatePolicy: { method: 'put', path: '/api/v1/admin/policies', summary: 'Edit a band policy', tag: 'admin', auth: 'admin', body: DiscountPolicyInput, response: DiscountPolicyInput },
  adminUpsertProduct: { method: 'post', path: '/api/v1/admin/products', summary: 'Create or update a product with variants', tag: 'admin', auth: 'admin', body: AdminProductInput, response: PublicProduct, status: 201 },
  adminAgentClients: { method: 'get', path: '/api/v1/admin/agent-clients', summary: 'OAuth clients for buyer agents', tag: 'admin', auth: 'admin', response: z.array(AgentClientView) },
  adminCreateAgentClient: { method: 'post', path: '/api/v1/admin/agent-clients', summary: 'Create a scoped agent client', tag: 'admin', auth: 'admin', body: CreateAgentClientInput, response: AgentClientView, status: 201 },
  adminShipOrder: { method: 'post', path: '/api/v1/admin/orders/{id}/ship', summary: 'Mark shipped', tag: 'admin', auth: 'admin', params: IdParam, body: ShipOrderInput, response: OrderView },
  adminDeliverOrder: { method: 'post', path: '/api/v1/admin/orders/{id}/deliver', summary: 'Mark delivered (collects COD)', tag: 'admin', auth: 'admin', params: IdParam, response: OrderView },
  adminCompleteReturn: { method: 'post', path: '/api/v1/admin/orders/{id}/returns/complete', summary: 'Receive return, restock and refund', tag: 'admin', auth: 'admin', params: IdParam, response: OrderView },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof Routes;
export { ErrorBody };
