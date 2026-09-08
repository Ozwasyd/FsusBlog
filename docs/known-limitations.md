# Known Limitations

FsusBlog is in Public Preview and is not stable production software.

It is suitable for:

- development
- evaluation
- code review
- personal self-hosting experiments

It should not be treated as:

- a stable production release
- an API-stable platform
- a commercial SLA-backed system
- a guaranteed third-party client target

## Current Limitations

- Internal API contracts may change unless a dedicated stability document explicitly classifies the surface as stable.
- Internal AEDS frame contracts are experimental unless explicitly documented as stable.
- Database schema may change.
- Admin workflows may still be consolidated.
- Deployment configuration may change.
- Public API stability is experimental.
- Multi-node runtime has not entered the supported deployment baseline; see the Distributed Runtime stage in [ROADMAP.md](../ROADMAP.md).
- i18n is not complete; see the Localization and Public UX stage in [ROADMAP.md](../ROADMAP.md).
- Production SLA is not provided.
- Performance claims require benchmark mode and environment metadata.
- Kestrel-only internal baseline must be separated from optional reverse proxy or CDN deployment evidence.

## What Is Safe To Try

- Run the development stack.
- Review the architecture and security model.
- Experiment with personal self-hosting.
- Test public AOT and HotRead behavior.
- Inspect AEDS contracts and client adapters with the expectation that they may change.
- File bugs, feature requests, and performance reports using the issue templates.

## What Should Not Be Relied On Yet

- Undocumented internal routes.
- Stable AEDS frame layout for third-party clients.
- Stable admin API routes.
- Stable database schema.
- Multi-node runtime behavior.
- Production support or response time commitments.

## Reporting Issues

Use [CONTRIBUTING.md](CONTRIBUTING.md) and the GitHub issue templates for normal reports. Do not file security vulnerabilities as public issues; use [SECURITY.md](SECURITY.md).

See [ROADMAP.md](../ROADMAP.md) for capability stages, dependencies, and completion conditions.
