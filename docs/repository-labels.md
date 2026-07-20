# Repository Labels

FsusBlog uses namespaced labels for new issues and pull requests. Historical GitHub default labels may remain on old items, but new issue forms and automation should use the taxonomy below.

## Type Labels

| Label | Meaning |
| ------- | --------- |
| `type:bug` | Reproducible defect or broken expected behavior. |
| `type:feature` | Focused product or engineering enhancement. |
| `type:docs` | Documentation change, stale document, missing guide, or release evidence wording. |
| `type:performance` | Measured latency, throughput, resource, or browser performance report. |
| `type:maintenance` | Repository, workflow, test, support, deployment, or cleanup work. |
| `type:security-hardening` | Defensive improvement without public vulnerability details. |

## Area Labels

| Label | Meaning |
| ------- | --------- |
| `area:backend` | ASP.NET Core backend, services, middleware, or backend tests. |
| `area:frontend` | Vue, Vite, frontend state, UI components, frontend tests, or browser runtime. |
| `area:public-site` | Public reading pages, AOT/hydration, public renderers, SEO, archive/filter/article surfaces. |
| `area:admin` | Admin console, authoring workspace, dashboard, moderation, assets, users, or settings. |
| `area:auth` | Authentication, sessions, MFA, Passkey, JWT, cookie, or authorization boundary. |
| `area:moderation` | Comment moderation, regional policy, dictionary, model signal, or moderation provider work. |
| `area:aeds` | AEDS frame/POD protocol, binary reader/writer, Wasm decoder, or binary transport. |
| `area:api` | Minimal API endpoints, route behavior, API docs, or public contract shape. |
| `area:contracts` | Shared DTOs, OpenAPI/AEDS contract generation, cross-stack contract tests. |
| `area:database` | Persistence model, migrations, PostgreSQL behavior, Redis persistence, or upgrade paths. |
| `area:deployment` | Docker, Kestrel, reverse proxy, CDN, production config, or self-hosting support. |
| `area:docs` | Markdown docs, README, release notes, screenshots, or generated docs. |
| `area:ci` | GitHub Actions, test matrix, dependency review, quality gates, or CI scripts. |
| `area:github` | GitHub issue forms, labels, CODEOWNERS, support routing, PR templates, or repository settings docs. |
| `area:tooling` | Local scripts, generators, governance checks, release evidence collectors, or developer tools. |

## Risk Labels

| Label | Meaning |
| ------- | --------- |
| `risk:breaking-change` | Behavior or contract change that may break existing users or deployments. |
| `risk:migration` | Requires database, cache, data, or deployment migration handling. |
| `risk:security-sensitive` | Touches security-sensitive code or routing. Do not use public issues for vulnerability details. |
| `risk:public-preview-policy` | Affects current status, explicit compatibility classifications, known limitations, release evidence, or required gates. The label name is retained for issue-routing compatibility, not as a product-version line. |

## Status Labels

| Label | Meaning |
| ------- | --------- |
| `status:triage` | New item awaiting maintainer review. |
| `status:needs-info` | Missing required evidence or reproduction detail. |
| `status:accepted` | Maintainer accepted the work as planned. |
| `status:blocked` | Waiting on external state or a prerequisite. |
| `status:duplicate` | Duplicates an existing issue or PR. |
| `status:not-planned` | Maintainer decided not to pursue this work. |

## Evidence Labels

| Label | Meaning |
| ------- | --------- |
| `evidence:needs-repro` | Needs a clear reproduction, command, fixture, or demo seed confirmation. |
| `evidence:needs-tests` | Needs test or check coverage before merge. |
| `evidence:needs-docs` | Needs docs, release notes, support routing, or readiness evidence. |
| `evidence:needs-screenshot` | Needs screenshot, video, a11y tree, trace, or visual proof. |

## Release Note Labels

Exactly one release-note label is required on every pull request. The executable category registry lives in `tools/governance/change-contract-registry.mjs`; `.github/release.yml` and the Change Contract gate consume the same taxonomy.

| Label | Generated release-note disposition |
| ------- | ------------------------------------ |
| `release-note:added` | User-facing `Added` entry. |
| `release-note:changed` | User-facing `Changed` entry. |
| `release-note:fixed` | User-facing `Fixed` entry. |
| `release-note:security` | User-facing defensive `Security` entry without vulnerability detail. |
| `release-note:deprecated` | User-facing `Deprecated` entry. |
| `release-note:removed` | User-facing `Removed` entry. |
| `release-note:internal` | Internal/tooling entry excluded from user-facing categories. |
| `release-note:none` | Excluded from generated release notes. |

## Automatic Triage

Issue forms assign the initial type/status/evidence labels. `.github/workflows/issue-triage.yml` keeps a `status:*` label on new or reopened public issues and marks issues with `_No response_` form sections as `status:needs-info`.

`.github/labeler.yml` and `.github/workflows/labeler.yml` add PR area/risk labels from changed paths. The labeler is advisory: maintainers may adjust labels during review, and no workflow closes issues solely because of age.

Security vulnerabilities must stay out of public issues. Use `SECURITY.md` and GitHub private vulnerability reporting instead of adding vulnerability details to any public label or issue body.
