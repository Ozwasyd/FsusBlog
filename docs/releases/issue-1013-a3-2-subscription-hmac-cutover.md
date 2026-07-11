# A3-2 Site-subscription HMAC cutover

Status: code landed; database milestone verification deferred.

## Change

Subscription writes and unsubscribe ownership proofs now derive only the current
`hmac-v1` identity with `Subscription:EmailHashPepper`. Runtime SQL has no legacy
SHA-256 parameter, OR branch, or `LegacySha256EmailHash` helper.

Migration `20260709-post-site-subscription-hmac-finalize` changes the column default
to `hmac-v1`, quarantines legacy rows by disabling them and setting
`unsubscribed_at`, changes their version marker, and asserts that no
`hash_version='sha256-legacy'` row remains. A SHA-256 digest cannot be converted into
an HMAC without the original email; the migration deliberately does not pretend to
recover plaintext identity. A later subscription creates the canonical HMAC row.

## Release gate

Capture the applied migration history and the exact result `0` from:

```sql
SELECT COUNT(*)
FROM site_subscription
WHERE hash_version = 'sha256-legacy';
```

No production query was executed in this implementation phase.

## Operational fallback

Do not re-enable SHA-256 lookup. On a cutover problem, pause subscription mutations,
restore the pre-migration database into an isolated target for diagnosis, and keep
the current HMAC-only runtime fail-closed until a corrected migration is ready.

## Test ownership

- `SchemaMigrationIntegrationTests.RunAsync_FinalizesLegacySiteSubscriptionHashes`
- `SubscriptionEndpointsContractTests.SubscribeAsync_RepeatedCurrentHmacSubscriptionPersistsOneEnabledRowWithoutLegacyHash`
- `RuntimeFallbackRetirementAcceptanceTests.A3_2_SubscriptionRuntimeUsesOnlyCurrentHmacIdentity`

