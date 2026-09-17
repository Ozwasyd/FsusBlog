# Operations Infrastructure Layout

FsusBlog has one top-level operational-infrastructure root: `ops/`. Runtime templates live there; deployment policy is configuration under `config/deployment/`; executable orchestration remains under `tools/deployment/` or `tools/operations/`.

## Canonical ownership

| Domain | Canonical path | Responsibility |
| --- | --- | --- |
| Production container and Compose | `ops/docker/` | Immutable production image, production slot Compose, isolated rehearsal infrastructure, and the backend debug override |
| Development dependencies | `ops/development/dependencies.compose.yml` | PostgreSQL and Redis used by local bootstrap scripts |
| Gateway templates | `ops/gateway/` | Production OpenResty baseline, controlled active-upstream example, isolated rehearsal template, and development-machine Nginx example |
| Privacy operations templates | `ops/privacy/` | Operator-owned inventory and lifecycle examples |
| Deployment policy | `config/deployment/zero-downtime-resource-policy.json` | Machine-readable capacity and zero-downtime qualification thresholds |
| Deployment execution | `tools/deployment/` | Slot, gateway, rollout, rollback, recovery, and rehearsal commands |
| General operations execution | `tools/operations/` | Backup, retention, evidence, smoke, and operational checks |

The production application definition is explicitly named `ops/docker/docker-compose.production.yml`. `ops/docker/docker-compose.development-backend.yml` is only the application-container debug override. It is not the PostgreSQL/Redis dependency stack; that stack is `ops/development/dependencies.compose.yml`.

## Historical local proxy decision

The historical local-proxy Compose and Nginx pair had no supported script, documented operator workflow, or CI caller. Its only remaining links were the Compose project listing and a cross-root mount between the two files. Both files are removed instead of being preserved as an implied supported topology. The supported local path is Vite plus the native backend, while the supported production path is the production Compose slot behind the controlled OpenResty gateway.

This retirement does not change production topology, gateway switching, slot identity, resource limits, or security headers. Reintroducing a local proxy requires a documented owner and caller plus an update to the machine-readable layout policy; copying the retired pair back is rejected.

## Governance and rollback

Run:

```bash
node tools/governance/check-operations-layout.mjs
node --test tests/tools/operations-layout.test.mjs
```

The gate reports all violations together. It rejects a second top-level deployment root, unknown `ops/` domains, infrastructure templates outside `ops/`, deployment policy outside `config/deployment/`, stale path references, unapproved cross-root relative Compose mounts, missing ownership/label globs, and the retired local-proxy pair.

Path migration rollback is one atomic repository change: restore the previous path and every real consumer, documentation reference, ownership rule, matrix entry, and policy declaration together. Runtime rollback remains unchanged: gateway rollback/recovery and the retained immutable slot operate on installed host paths, not repository layout. Do not keep both repository paths during rollback because the layout gate treats duplicate authorities as a failure.
