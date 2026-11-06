# ADR 0007: Built-in EdDSA identity in lite, Keycloak or any OIDC issuer from growth

- Status: Accepted
- Date: 2026-11-05
- Deciders: Mukul Kathuria

## Context

The plan names Keycloak for identity: OIDC for people and OAuth 2.0 client credentials for agents. Keycloak is a JVM service with substantial memory needs, which conflicts with a lite store on one small VPS and with the zero-dependency demo. Agents still need scoped, short-lived credentials, and admins need MFA, in every profile.

## Decision

- A `TokenVerifier` port, selected by `IDENTITY_PROVIDER`:
  - **`builtin` (default, lite):** `TokenService` issues JWTs signed with **EdDSA (Ed25519)** using `jose`, with issuer, audience, expiry and a unique `jti`. Customers get 15-minute access tokens plus rotating refresh tokens; agent clients get 15-minute tokens from `POST /oauth/token` (client credentials), limited to their granted scopes. Passwords are hashed with scrypt; repeated failed logins lock the account temporarily; admin endpoints require a session verified with TOTP.
  - **`oidc` (growth and scale):** `OidcTokenVerifier` checks tokens from Keycloak or another OIDC issuer against its JWKS. The realm role `admin` maps to an admin, `client_id` (or `azp` with the realm role `agent`) maps to an agent with the scopes in its `scope` claim, and `amr`/`acr` carry MFA. The growth Compose profile includes Keycloak.
- Agent clients are created by an admin with explicit scopes (`catalog:read`, `quote:create`, `order:create`) and a per-minute quota; the secret is shown once and stored as a hash.
- `JWT_PRIVATE_KEY` is required in production with the built-in issuer; the config loader refuses to start without it.

## Consequences

- No extra service in lite, and asymmetric signatures mean verification needs only the public key.
- We own a small authentication surface (registration, login, lockout, refresh rotation, MFA enrolment), so it is in scope for the penetration test and the ASVS mapping.
- Rotating `JWT_PRIVATE_KEY` signs everyone out until they log in again ([key rotation runbook](../runbooks/key-rotation.md)).
- The OIDC adapter derives the JWKS URL in Keycloak's format; other issuers may need that made configurable.
- Lite has no single sign-on or social login; operators who need them move to `oidc`.

## Alternatives considered

- **Keycloak in every profile:** too heavy for lite and the demo.
- **HS256 shared-secret JWTs:** every verifier would hold the signing key.
- **A hosted identity provider:** adds a third-party dependency and a data-processing relationship to every self-hosted store.
