# ADR 0006: Stay on TypeScript 6 until typed linting works with TypeScript 7

- Status: Accepted
- Date: 2026-11-05
- Deciders: Mukul Kathuria

## Context

TypeScript 7 is the native port of the compiler. It is much faster, but when this decision was made typescript-eslint's type-aware rules did not work with it, because they rely on the JavaScript compiler API that the native compiler does not expose in the same way.

Our merge gates depend on type-aware linting: the ESLint config extends `recommendedTypeChecked` and enforces rules such as `no-floating-promises`, `no-misused-promises` and the `no-unsafe-*` family. Losing them would silently weaken the guarantees around async code paths in payments, checkout and the agent layer.

## Decision

- Pin `typescript` to `~6.0.3` in every workspace package.
- Renovate is configured with `allowedVersions: "<7"` for `typescript`, so no upgrade pull request appears until this ADR is superseded.
- Revisit when typescript-eslint announces support for TypeScript 7; the upgrade then needs a new ADR, a green lint run with no rules disabled, and unchanged generated contracts.

## Consequences

- Type checking and builds stay slower than they would be on the native compiler.
- Typed lint gates keep working unchanged.
- We must watch the TypeScript 6 support window and plan the move before it ends.

## Alternatives considered

- **Upgrade to TypeScript 7 and drop typed lint rules:** rejected; those rules catch real bugs in async and money-handling code.
- **Run TypeScript 7 for type checking and TypeScript 6 only for linting:** two compilers can disagree, and the gain does not justify the confusion yet.
