# Demo Data

FsusBlog includes deterministic fictional demo seed data for public-preview local development.

Run it through the one-command dev stack:

```bash
./tools/dev/start.sh --seed-demo
```

Or run the seed step after the backend has started once and created the schema:

```bash
./tools/dev/seed-demo-data.sh
```

## Demo Identity

The seed creates a fictional anonymous account container with public handle
`demo-reader`. It does not create a password login row, and it does not grant
backend authority through `sys_user.role`.
It also does not write `sys_user.lastloginip` or `sys_user.lastlogintime`; demo
identity rows stay limited to anonymous account container metadata.

The seed also creates a disabled mock `admin principal` handle, `demo-admin`, for
audit and moderation attribution examples only. It has no Passkey credential and
is not a root administrator.

For real local admin access, use the local Passkey injection flow in
[docs/development.md](../development.md#本地-passkey-注入), then complete the
root admin bootstrap flow. Do not add password-based demo admins.

## Seed Contents

The seed inserts or refreshes:

- one fictional anonymous account container
- one disabled mock admin principal for attribution
- fictional categories and tags
- two fictional published articles with distinct content-evidence covers: a
  public route map and an AEDS frame inspection; neither asset embeds the
  article title or UI copy
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

The seed is deterministic:

- demo article IDs use the `910xxx` range
- demo comment IDs use the `9100xxx` range
- rerunning the script refreshes demo rows instead of accumulating duplicates
- existing non-demo content is not deleted

The backend must run at least once before seeding so SqlSugar CodeFirst migrations can create the database schema.

## Reset

To remove local development containers and volumes:

```bash
./tools/dev/start.sh --cleanup
```

This deletes the local PostgreSQL and Redis Docker volumes created by `ops/development/dependencies.compose.yml`.
