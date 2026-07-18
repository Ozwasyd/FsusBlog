# A3-7 PublicAOT legacy sidecar-hash retirement

Status: code landed; full rebuild and residual scan deferred.

## Change

PublicAOT hydration sidecars are validated only against lowercase hexadecimal
SHA-256. `MatchesLegacyBase64UrlPayloadHash` and the OR fallback are absent. A cache
document containing the legacy Base64Url hash format is treated as a miss and its
document entry is removed; it is never served as compatible content.

## Release gate

Run one complete `aot-rebuild`, preserve its release evidence, then scan all retained
sidecar references and record a legacy-format count of zero. This implementation
phase did not run the rebuild or inspect a production artifact volume.

## Operational fallback

Invalidate and rebuild affected PublicAOT entries without restarting the server.
Do not restore acceptance of the legacy hash. If the artifact volume is inconsistent,
keep the affected documents as cache misses while the canonical rebuild completes.

## Test ownership

- `PublicAotFileShellCacheTests.TryGetEntryAsync_LegacyBase64UrlHydrationSidecarHash_TreatsDocumentAsMiss`
- `RuntimeFallbackRetirementAcceptanceTests.A3_7_PublicAotAcceptsOnlyCanonicalHexSidecarHash`
