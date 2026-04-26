# FsusBlog Operations Runbook

## Release Gate

Before publishing a production image:

```bash
./tools/test.sh fast
./tools/test.sh ci
./tools/test.sh release
./tools/test.sh production
```

For Docker packaging:

```bash
export GITHUB_PACKAGES_TOKEN=...
./tools/build-final-image.sh
docker compose --env-file .env.production config
```

## Rollout

1. Build and tag the new image.
2. Start the container with `docker compose --env-file .env.production up -d`.
3. Wait for `/health/live` to pass.
4. Check `/health/ready`.
5. Switch or keep gateway traffic only after readiness is `ready`.

Rollback is image based:

```bash
docker compose --env-file .env.production down
FSUSBLOG_FINAL_IMAGE_TAG=previous-tag docker compose --env-file .env.production up -d
```

## Daily Checks

- `docker ps` health status is healthy.
- `/health/ready` returns `ready`.
- Disk usage for Docker volumes and container logs is below alert thresholds.
- PostgreSQL connection usage leaves headroom for migrations and backups.
- Redis memory and eviction policy are within expected bounds.
- SSE connection count matches expected traffic and does not grow without release.

## Backups

Back up PostgreSQL as the source of truth. Also back up upload files:

```bash
docker run --rm -v fsusblog_fsus-uploads:/data -v "$PWD/backups:/backup" alpine \
  tar -czf /backup/fsus-uploads-$(date +%Y%m%d%H%M%S).tar.gz -C /data .
```

Redis is a cache/control-plane dependency. Persist Redis according to the infrastructure service policy, but do not treat it as the only copy of business data.

## Disk Hygiene

- Serilog file logs are retained by app settings.
- Docker stdout/stderr logs are rotated by compose `json-file` options.
- AOT cache is a named volume; clean it during maintenance only after confirming public fallback still works.
- Do not commit `.env`, logs, coverage, Playwright outputs, local probes, or temporary build spillover.

## Incident Recovery

- App fails liveness: inspect container logs, then restart the app container.
- App fails readiness only: inspect `/health/ready` detail to distinguish DB, Redis, config, or resource failure.
- DB pressure: lower public traffic at the gateway, check DB concurrency gate detail, and inspect slow SQL logs.
- Redis outage: keep the app isolated from new traffic until readiness returns; public hot paths may degrade without L2 cache.
- SSE pressure: inspect readiness runtime detail and logs for slow consumer disconnects.
