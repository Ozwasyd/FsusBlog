# AEDS v2 access projections

## Authority and scope

`src/shared/Contracts/Validation/aeds-access-profiles.json` is the only access-profile authority. It describes each consumer's required, optional, deferred and ignored fields, semantic validations, output contract and reference to the current wire layout. It does not own the AEDS frame header, frame numbers or payload layout. Those remain owned by `aeds-protocol.json` and the existing POD contracts.

The first default profile is `publicArticleListCard`. The authority also reserves reviewed, disabled profiles for filter/archive items, notification previews and local search ranking. Disabled profiles are declarations, not production branches.

Run:

```bash
cd src/frontend
pnpm generate:aeds-access-profiles
pnpm check:aeds-access-profiles
```

The generator emits:

- `src/core/Cache/AedsAccessProfiles.Generated.cs`;
- `src/frontend/src/generated/aedsAccessProfiles.ts`;
- `src/frontend/wasm/aeds/include/aeds_access_profiles.generated.hpp`.

CI and local governance use `--check`; generated drift fails closed.

## Validation and materialization

The transport still validates the 16-byte AEDS v2 header, expected frame type, payload length and CRC before selecting a payload reader. The selected reader then validates the cursor envelope, counts, exact current record size, reserved bytes, every slice range, strict UTF-8, tag ranges and trailing bytes exactly once.

`publicArticleListCard` accepts only cursor envelope v2 and 100-byte ArticleList records. It materializes only card identity, creation time, category, title, summary and the five tags that the public card can render. Views, deletion state, lifecycle dates and revision/publication coordinates are validated structurally but are not converted to objects or strings.

The payload layout is defined once in `aeds-protocol.json` under `payloadLayouts.ArticleList`; `generate-aeds-protocol.mjs` generates the C#, TypeScript and C++ wire constants. Access profiles do not declare offsets or record sizes. Both canonical and selective readers reject 56/76-byte records, cursor v1, missing envelopes, invalid revision/publication coordinates and malformed bytes.

## Direct public view path

The home feed calls `getPublicArticleCardProjections`, which passes the generated profile id through the same binary transport and Worker protocol. Both main-thread and Worker decoding dispatch through `decodeBinaryFramePayload(frameType, payload, accessProfile)`. The result feeds the existing `createArticleListCardViewContract` helper directly:

```text
AEDS frame
  -> validated ArticleList payload
  -> PublicArticleListCardProjection
  -> ArticleListCardViewContract
```

Formatting, route generation, relative-time rendering and notification reconciliation remain outside the wire codec. Admin/private callers continue using the canonical decoder, so revision and publication coordinates are unchanged.

## Benchmark gate and rollback

`AedsAccessProjectionBenchmarks` covers 5/20/100-item pages, 1/8 tags per article and current 100-byte records. `MemoryDiagnoser` reports time, allocations and allocated bytes for canonical decode, projection decode and canonical decode plus view digest; setup verifies a correctness digest before measurement. Browser/Worker focused tests record parity and malformed rejection.

Only profiles showing at least 25% lower allocated bytes/op or 15% lower decode-plus-projection time may set `defaultEnabled: true`. A profile that misses the gate stays declared but disabled.

The checked baseline in `tests/performance/aeds-access-projection-baseline.json` passes every matrix case: allocation falls by 44.2–64.4% and projection decode time falls by 17.5–72.1%. This is historical profile admission evidence. It does not establish current-only candidate benchmark, allocation or bundle acceptance; rerun the current 5/20/100-item matrix and compare the exact baseline before accepting the removal.

Operational rollback does not change the wire or require a server restart: the public caller can be switched back to `getArticles`, or a previous frontend asset can be selected, while cached AEDS v2 frames remain valid. Rollback must retain the current wire contract. No reader interprets retired layouts.
