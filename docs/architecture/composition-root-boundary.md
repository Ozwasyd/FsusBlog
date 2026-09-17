# Composition root boundary

`WebApplicationCompositionExtensions` is the application assembly map. It owns only:

- the ordered application and endpoint pipeline descriptors;
- the two high-level entry points used by `Program.cs`;
- delegation to named middleware and endpoint modules.

It must not own request policy, HTML/head construction, route identity decisions,
Public AOT/SPA ownership, startup business rules, DTO mapping, or use-case execution.
Those behaviors live behind explicit runtime modules; the current public web adapter is
`PublicWebRuntime` and its HTML materialization companion. Existing focused HTTP tests
exercise those modules directly, while `ArchitectureMaintainabilityBehaviorTests`
fail if implementation tokens return to the composition source.

The two service-registration roots have the same constraint. Infrastructure
registration chooses port implementations, and domain registration chooses application
or Core use cases. Neither registration file may resolve a container to execute a use
case, materialize an HTTP response, map an endpoint, or reconstruct runtime branching.

## Safe change procedure

1. Add behavior to its owning middleware, endpoint module, service, policy or mapper.
2. Add the module registration or ordered delegate to the composition root.
3. Run composition, endpoint snapshot, Public AOT HTML, startup/lifetime and cross-cutting
   control focused tests.
4. Check the source boundary test before changing `Program.cs` or middleware order.

## Runtime rollback

This refactor does not add a runtime switch and does not change pipeline order or route
sets. If a public rendering path must be degraded without restart, keep using the existing
reloadable Public AOT/PublicHotRead feature controls; requests fall back to the canonical
SPA/endpoint path while the composition graph remains unchanged. A code rollback is only
needed if assembly order itself changes.
