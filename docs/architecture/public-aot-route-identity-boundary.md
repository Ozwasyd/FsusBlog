# Public AOT route identity boundary

Public AOT route identity is owned by `IPublicAotRouteIdentity`. Both HTTP route admission and backfill reconstruction use the same one-way boundary:

```text
public HTML / navigation snapshot endpoint
  -> IPublicAotRouteIdentity
       -> IPublicAotRouteRegistry

PublicAotShellService backfill generation
  -> IPublicAotRouteIdentity
```

`PublicAotShellService` no longer exposes a route-resolution forwarding method and no longer depends directly on `IPublicAotRouteRegistry`. `PublicAotRouteIdentity` does not call back into the shell service.

The extracted module owns:

- resolving an incoming `HttpContext` to the canonical `PublicAotRouteMatch`;
- reconstructing the route context used by background backfill;
- the catalog-based fallback for a queued route that is no longer accepted by the current registry.

The public paths, pagination redirect flags, canonical route keys, navigation snapshot response contract, and backfill cache identity are unchanged. Rollback restores the previous route-identity implementation without a data migration or cache format change.
