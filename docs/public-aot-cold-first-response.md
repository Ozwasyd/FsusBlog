# Public AOT cold first response and traffic-switch gates

## Production contract and SLO

In production, the first `GET` for an `seoEligible` public URL must be exactly one of:

- `200`: `X-Fsus-Public-Aot-Source: server-ssr`, `X-Fsus-Public-Aot-State: fresh`, and body content under `<main>` with title, description, canonical, robots, Open Graph, Twitter, and parseable JSON-LD. The response also declares renderer, frontend asset, release, and slot identities.
- `503`: the backend is generating or temporarily unable to generate the URL, with a positive integer `Retry-After`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`, and `X-Fsus-Public-Aot-Source: server-status`. It must not contain an empty SPA shell that could be mistaken for a complete page.

Missing content returns `404`; permanently removed content returns `410`. Neither is a cold-cache fallback or eligible for successful retry by the warmer. The cold-first-screen contract SLO is 100% compliance. A retryable `503` must converge to a complete `200` within the default 15-second warmup window; without convergence, traffic switching is forbidden.

## Cold-cache and change paths

On a production cache miss, `PublicAotShellService` classifies the route/resource, queues backfill, and returns a retryable failure to the current request. Empty SPA `200` remains only for development source-resource mode and is not a production fallback.

Article create/edit/delete and category, tag, or archive-relation changes clear the corresponding AOT entry through the existing invalidation path. The first request after invalidation follows the same `200/503/404/410` contract; old HTML or hydration sidecars cannot represent new content. A frontend-asset version change makes old cache entries incompatible, so the new version must be generated again.

## Full pre-switch warmup evidence

During `candidate-smoke`, before `gateway-switch`, `release-rollout.sh` runs `warm-public-aot-cache.mjs --scope all --fail-fast` against the candidate's full manifest. Concurrency remains dynamically calculated from machine CPU, memory, and explicit limits; worker count is not hard-coded.

`public-aot-warm.json` records:

- every manifest route and its SHA-256 digest;
- first and final response for each URL: status, source, state, Retry-After, and cache/noindex;
- renderer, frontend asset, release, and slot identities;
- title, description, canonical, robots, Open Graph, Twitter, JSON-LD, and `<main>` body checks;
- first-response and convergence latency, generation time, canonical origin, and scope.

`verify-public-aot-warm-evidence.mjs` independently verifies the report. A missing/expired report, non-`all` scope, manifest-digest mismatch, missing/duplicate route coverage, contract-violating first response, incomplete final response, non-unique version identity, or release/slot/canonical-origin mismatch exits nonzero and blocks candidate smoke and traffic switching.

## Observability and troubleshooting

HTTP headers distinguish `server-ssr/fresh`, `server-status/transient-failure`, `not-found`, and `gone` per request. Existing Public AOT metrics record render source, outcome, backfill result, and latency; runtime health exposes worker probe, queue, circuit breaker, and route quarantine. Troubleshoot each URL against warmup evidence first, then inspect backfill failures, DB gates, Redis/cache, and SSR-worker state; one final successful request is insufficient.

## Rollback and no-restart degradation

If candidate smoke fails before switching, keep the candidate off public traffic, repair data/cache/worker/resources, and rerun candidate smoke. Do not skip or manually rewrite evidence. A transient failure after a content change continues to return retryable `503` until backfill recovers and the response returns to complete `200`; no process restart is required.

If the new release remains unhealthy after switching, use the existing gateway rollback to return traffic to the previous slot/release within its retention window, retaining failed-candidate evidence for diagnosis. The rollback target must pass its own release/slot, resource-compatibility, and public-AOT contract checks. Never use an empty SPA `200` as a fallback.

## Verification coverage

Backend unit tests cover production cold-route queueing with transient failure, complete existing-cache responses, and classified `404/410/503`. Tool tests cover complete `200`, retryable `503`, empty-SPA `200` rejection, explicit `404` rejection, expired reports, digest/coverage omissions, resource-version drift, canonical-origin drift, and pre-switch gate order. Full-manifest release evidence covers real homepage, article, archive, category, tag, and static-page URLs.
