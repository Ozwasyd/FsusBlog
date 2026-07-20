# Roadmap

This roadmap describes capability stages. Stages express dependencies, scope, and completion conditions; they are not product versions or delivery-date promises.

## Current Public Preview

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

Completion condition: the documented single-process baseline, public contribution workflow, and local acceptance evidence remain reproducible from current `master`.

## Localization and Public UX

Goal: establish localization and public-facing UX maturity after public preview.

Status: planned; tracked by [#72](https://github.com/Ozwasyd/FsusBlog/issues/72).

Planned work:

- i18n foundation.
- `zh-CN` and `en-US` system UI dictionaries.
- Locale-aware public shell, article UX, auth pages, route titles, dates, numbers, and errors.
- Public documentation cleanup based on external contributor feedback.
- More explicit stable extension points where appropriate.

Dependencies and completion condition: localization contract work must be tracked by dedicated issues; the stage completes only when the public shell, authentication flows, route metadata, formatting, errors, and contributor documentation share tested locale behavior.

## Distributed Runtime

Goal: add multi-node and distributed runtime capabilities without sacrificing the single-process baseline.

Status: planned; the supported baseline remains single-process. Cluster operations are tracked by [#115](https://github.com/Ozwasyd/FsusBlog/issues/115), with individual protocol and convergence work kept in their own issues.

Planned work:

- Homogeneous binary, heterogeneous runtime node model.
- Cluster membership and capability registry.
- Lease, checkpoint, fencing token, and idempotency protocols.
- Local / remote module invocation boundary.
- Adaptive responsibility scheduling.
- Cluster operations, observability, and failover diagnostics.

Dependencies and completion condition: this stage depends on explicit cluster protocol, fencing, recovery, and operations contracts. Multi-node deployment is not part of the supported baseline until those contracts and their failure-mode tests are complete.

## Plugin, Theme and Font Ecosystem

Longer-term ecosystem work:

Status: planned; the integrated ecosystem boundary is tracked by [#181](https://github.com/Ozwasyd/FsusBlog/issues/181).

- Plugin system.
- Theme system.
- Font system.
- Plugin admin UI and observability.
- Benchmark evidence automation.
- Full accessibility audit.
- Release artifact signing and SBOM hardening.
- Ecosystem hardening for third-party integrations.

Dependencies and completion condition: each extension surface must have an owner, a dedicated stability document, compatibility fixtures, and a lifecycle policy before it is advertised as stable.

## Stability Rule

Only documented stable extension points should be treated as stable. Undocumented internal APIs, AEDS frames, admin routes, and database schema remain experimental regardless of roadmap stage.
