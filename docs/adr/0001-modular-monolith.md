# ADR 0001: Build the core as a NestJS-on-Fastify modular monolith

- Status: Accepted
- Date: 2026-11-05
- Deciders: Mukul Kathuria

## Context

AgentBazaar has many bounded contexts: catalog, search, customization, pricing, inventory, cart and checkout, orders, payments, tax, identity, PII, audit, analytics and the agent layer. It must run on one small VPS for a shop with ten users, and grow to clusters for about ten lakh registered users by configuration. The team is small and much of the code is written with AI assistance, so structure has to be enforced by tools rather than by memory.

Microservices from day one would multiply deployment, observability and consistency work long before traffic needs it. An unstructured monolith would let modules reach into each other's tables and make later extraction impossible.

## Decision

- One deployable TypeScript service, `apps/api`, built with **NestJS** for dependency injection and module wiring, on the **Fastify** adapter for throughput, schema-friendly routing, access to the raw request body (needed to verify webhook signatures) and its security plugins (`@fastify/helmet`, `@fastify/rate-limit`).
- Each module under `apps/api/src/modules/<name>` follows hexagonal layering: `domain` (rules, no framework imports), `application` (use cases), `infrastructure` (adapters) and `interfaces` (REST, MCP and A2A handlers).
- Modules use each other only through their public `index.ts`, or react to domain events from the outbox ([ADR 0003](0003-outbox-and-event-bus.md)). They never read each other's tables.
- The rules are enforced by [dependency-cruiser](../../.dependency-cruiser.cjs) in `pnpm lint`: no cycles, module internals are private, `domain` imports no framework, database or protocol library, `domain` never reaches into its own outer layers, and `shared` never depends on a module.
- Every external dependency sits behind a port so profiles can swap adapters (search, event bus, cache, key wrapping, identity, payments, LLM, classifier, embeddings).
- Python is used only where its ML libraries are needed, in the separate optional `services/ai`, with contracts generated from the same Zod schemas.

## Consequences

- One process, one deployment and one database in lite. A use case that spans modules, such as accepting a signed quote while reserving stock at checkout, can run in a single database transaction through public service calls.
- Pure domain functions (pricing policy, GST, stock rules, the negotiation and payment state machines) are fast to unit and property test.
- Boundaries need discipline even with tooling: a shared database makes it tempting to join across modules, so reviews check that modules keep to their own tables.
- The whole API scales horizontally as one unit. Hot spots are addressed by profile adapters first; extracting a module into its own service (for example a separate PII vault at scale) is possible because it already talks through a port and owns its data.

## Alternatives considered

- **Microservices from the start:** rejected for lite; the operational cost is high and the boundaries are better proven inside one process first.
- **Express or plain Fastify without NestJS:** less structure for dependency injection and module wiring across a large codebase.
- **A Go or JVM core:** would split the shared Zod contracts and the frontend's TypeScript ecosystem.
