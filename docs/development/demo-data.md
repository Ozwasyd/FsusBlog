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

## Demo Login

| Role | Username | Password |
|------|----------|----------|
| Admin | `demo-admin` | `ChangeMe123!` |
| User | `demo-reader` | `ChangeMe123!` |

These accounts are for local development only. They are safe fictional credentials and must not be copied into production.

## Seed Contents

The seed inserts or refreshes:

- fictional admin and reader users
- fictional categories and tags
- two fictional published articles
- one approved comment
- one pending moderation queue comment
- fictional audit/security events

The seed does not include real production content, real domains, real emails, real IP addresses, real logs, tokens, or private identifiers.

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

This deletes the local PostgreSQL and Redis Docker volumes created by `deploy/dev/docker-compose.yml`.
