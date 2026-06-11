# Roadmap

This roadmap describes public-preview direction. Future items do not block v1.1.0 public preview unless a separate readiness issue says so.

## v1.1.0 Public Preview

Goal: make the repository public, reviewable, and usable for development, evaluation, and personal self-hosting experiments.

Scope:

- Single-process high-performance blog baseline.
- Kestrel-only internal performance baseline.
- AEDS binary runtime API baseline.
- Public HotRead baseline.
- Public AOT baseline.
- Security, moderation, anti-crawler, PoW, MFA, Passkey, and session baseline.
- Admin console baseline.
- Public documentation, security reporting, contribution workflow, and release-readiness evidence.

Status:

- Public Preview.
- API Stability: Experimental.
- Deployment: Self-hosting preview.
- Production SLA: none.

## v1.2.0

Goal: establish localization and public-facing UX maturity after public preview.

Planned work:

- i18n foundation.
- `zh-CN` and `en-US` system UI dictionaries.
- Locale-aware public shell, article UX, auth pages, route titles, dates, numbers, and errors.
- Public documentation cleanup based on external contributor feedback.
- More explicit stable extension points where appropriate.

v1.2.0 is not a blocker for opening v1.1.0 as public preview.

## v1.3.0

Goal: add multi-node and distributed runtime capabilities without sacrificing the single-process baseline.

Planned work:

- Homogeneous binary, heterogeneous runtime node model.
- Cluster membership and capability registry.
- Lease, checkpoint, fencing token, and idempotency protocols.
- Local / remote module invocation boundary.
- Adaptive responsibility scheduling.
- Cluster operations, observability, and failover diagnostics.

v1.3.0 is a future architecture direction, not a public-preview requirement.

## Post-v1.3.0

Longer-term ecosystem work:

- Plugin system.
- Theme system.
- Font system.
- Plugin admin UI and observability.
- Benchmark evidence automation.
- Full accessibility audit.
- Release artifact signing and SBOM hardening.
- Ecosystem hardening for third-party integrations.

## Stability Rule

Only documented stable extension points should be treated as stable. Undocumented internal APIs, AEDS frames, admin routes, and database schema remain experimental during v1.1.x.
