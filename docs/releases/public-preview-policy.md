# Public Preview Policy

This document is the current source of truth for FsusBlog's Public Preview status. Public Preview is a capability and support classification, not a product version.

## Status

- Product stage: Public Preview.
- API stability: Experimental unless explicitly classified otherwise.
- Deployment: Personal self-hosting preview on the documented single-process baseline.
- Production SLA: none.
- Build identity: canonical ReleaseId (`YYYYMMDDHHmmss-sha12`) plus the full commit SHA.

## Available Capabilities

- Single-process Kestrel application baseline with PostgreSQL and Redis.
- AEDS binary runtime API, Public HotRead, and Public AOT reading paths.
- Vue frontend, public hydration, admin console, and authoring workflow baseline.
- PoW, MFA, Passkey, session, anti-crawler, moderation, audit, and security console baseline.
- Public contribution, security reporting, development onboarding, and documentation entry points.

## Stability Boundary

The classifications in [API Stability](../api/stability.md) govern compatibility:

- undocumented AEDS frames, internal APIs, database schema, admin routes, and deployment internals are experimental;
- a stable extension point requires a dedicated document that grants that status and defines its compatibility tests;
- RSS, Atom, JSON Feed, Sitemap, `robots.txt`, and health probes follow their external standards or documented operations contracts independently of product release identity.

## Known Limitations and Roadmap

[Known Limitations](../known-limitations.md) describes the current unsupported or experimental surfaces. [ROADMAP.md](../../ROADMAP.md) organizes planned work by capability stage and completion condition without promising a product version or delivery date.

## Historical Provenance

The retired product-version policy is preserved at [Legacy Public Preview Policy](v1.1.0-public-preview.md). Its version label and the matching `docs/reports/open-source-readiness/v1.1.0-public-preview/` snapshot describe historical provenance only; neither is a current policy or a release credential.

Historical evidence must retain its original paths and snapshot hashes. Any later path migration requires a separate redirect map, regenerated inventory, and provenance explanation.

## Support and Rollback

There is no production support, uptime guarantee, or response-time commitment. Support routing is documented in [SUPPORT.md](../../SUPPORT.md).

This documentation-only policy can be rolled back without restarting the application. If a wording or link regression is discovered, revert the documentation commit and keep existing immutable ReleaseId artifacts unchanged; no runtime, schema, binary, notification stream, or deployment behavior changes in this policy.
