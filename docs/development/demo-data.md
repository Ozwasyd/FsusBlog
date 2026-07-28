# Demo Data

FsusBlog includes deterministic fictional demo seed data for public-preview local development.

Run it through the one-command dev stack with the explicit catalog profile:

```bash
./tools/dev/start.sh --fixture-profile demo-public
```

Default `./tools/dev/start.sh` uses profile `none` and does not seed demo data.

The profile is prepared only by the fixture orchestrator started from that command. There is no standalone SQL or seed-script entrypoint.

## Demo Identity

The seed creates a fictional anonymous account container with public handle
`demo-reader-<owner-token>`. It does not create a password login row, and it does not grant
backend authority through `sys_user.role`.
It also does not write `sys_user.lastloginip` or `sys_user.lastlogintime`; demo
identity rows stay limited to anonymous account container metadata.

The seed also creates a disabled mock `admin principal` handle,
`demo-admin-<owner-token>`, for audit and moderation attribution examples only.
It has no Passkey credential and is not a root administrator.

For real local admin access, use the local Passkey injection flow in
[docs/development.md](../development.md#本地-passkey-注入), then complete the
root admin bootstrap flow. Do not add password-based demo admins.

## Seed Contents

The seed inserts or refreshes:

- one fictional anonymous account container
- one disabled mock admin principal for attribution
- fictional categories and tags
- three fictional published articles; two use distinct content-evidence covers,
  a public route map and an AEDS frame inspection, while the moderation example
  exercises the supported coverless fallback
- one approved anonymous comment
- one pending anonymous moderation queue comment
- fictional audit/security events

The seed does not include real production content, real domains, real emails, real IP addresses, real logs, tokens, or private identifiers.

The demo covers are deterministic SVG fixtures under
`src/frontend/public/fixtures/`. They use the same `center-80` crop-safe area as
the public home and article-detail renderers. Removing either `coverimageurl`
is supported and intentionally falls back to the complete text hierarchy; the
seed does not establish a requirement that published articles have covers.

No real personal data, production logs, production domains, tokens, emails, or IP addresses are included.

## Repeatability

The dataset shape and content are deterministic, but database IDs are allocated
normally by PostgreSQL. A successful `demo-public` run publishes a verified
private FixtureReceipt whose 23 exact entity identities carry one owner,
catalog variant, and server-issued identity digest. The receipt also binds the
current source snapshot and exact PostgreSQL/Redis container generation; it is
stored separately from the zero-data `none` receipt.

When the exact source and service generation is started again, the orchestrator
validates that prior receipt, submits its exact identities to cleanup, and only
then prepares the replacement dataset. Selecting `none`, or starting after the
source/service identity changes, first retires the prior demo dataset through
that same receipt-authorized cleanup path. The receipt is removed only after
cleanup succeeds.

Cleanup does not rediscover ownership from mutable titles, names, handles,
comment scopes, or audit sources. It fails closed if only part of the exact
receipt remains; if all exact rows are already absent after a committed cleanup,
the same receipt may safely retry cache, hot-list, and search convergence.
Existing non-demo content is not deleted.

The backend must run at least once before seeding so SqlSugar CodeFirst migrations can create the database schema.

## Reset

To remove local development containers and volumes:

```bash
./tools/dev/start.sh --cleanup
```

This deletes the local PostgreSQL and Redis Docker volumes created by `ops/development/dependencies.compose.yml`.
