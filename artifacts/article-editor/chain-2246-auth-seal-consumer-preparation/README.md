# Auth seal consumer compatibility preparation: no production intake

Readonly original auth source `59434d862035228830aa13e5529407f48535f226` / offered head `902fdaea1d4a64f5241778323a0fd20d1431614c`, draft4235. Parent reports independent3P2: nested surface transition marker/promise mismatch; missing final mutation fence after surface/clock reads; getter-only projections breaking original negative-cache test setup. This head is NOT accepted and is NOT consumed into Writer. Original author owns repair; no Root auth implementation or store copy.

Actual types read from the original owner: nominal `AdminPrincipalSeal` exported from `store/admin.ts`; nominal `PrivateSurfaceAuthoritySeal` from `services/privateSurfaceRuntime.ts`. The admin instance exposes `sealAdminPrincipalAuthority(expectedIdentityId)`, `hasAdminPrincipalAuthorityCustody(seal)` and `cancelAdminPrincipalAuthority(seal)`. Admin's real private record holds its original private-surface token and checkedAt; tokens are scoped to that issuer instance. Private surface exposes `sealAuthority`, `hasAuthorityCustody` and `cancelAuthority`. These are the actual declared APIs, not Root-created placeholder interfaces.

## Minimal future Writer connection, conditional on original repaired sources

- Import the actual original nominal token type; capture a genuine callback-free original issuer port, not a caller-supplied object or structural predicates.
- Acquire actual auth custody for the original captured document principal BEFORE physical/native admission. Keep the token in the SAME original mounted reservation, not a new auth/store/identity owner. Release only that token on refusal, cancel or physical retirement.
- Recheck actual auth custody and actual Document lifetime/membership token after borrowed readers; final private has must call the actual pure original producer predicates and recheck own original physical identity/generation. Never replace these with authGeneration/isClearing/id/permission watch observations.
- Preserve return/token/refusal/exception identity. Missing/failed/unaccepted issuer, missing Document token or incomplete expiry authority still refuses positive issuance. No successful stub or cached authority boolean.

This is a concrete integration map only; no phantom production imports or calls to unavailable APIs are added. Current Writer source remainsb697; the named three methods still refuse usable positive authority. Document4228 source/interfaces and accepted repaired auth are still pending.

## Additional actual consumer-boundary check for auth owner

The installed primary Pinia implementation (`source-identity.json` records version/hash) wraps setup-store returned function properties as actions at pinia.mjs1502. Its action wrapper at1369 creates argument/after/error containers, calls action subscriptions before the function, then calls after subscribers at1419 BEFORE returning the captured original result. A `.bind(adminStore)` of the returned method keeps that wrapper; it does not expose the raw closure or remove allocations/callbacks.

Source-only counterexample to the exposed has predicate being callback-free:

```ts
// Precondition: a genuine active seal issued by this actual original admin store.
store.$onAction(({ name, after }) => {
    if (name === 'hasAdminPrincipalAuthorityCustody') {
        after(() => store.cancelAdminPrincipalAuthority(genuineSeal));
    }
});
const result = store.hasAdminPrincipalAuthorityCustody(genuineSeal);
// Original raw has can compute true; Pinia's after callback then cancels
// that actual seal before the wrapper returns the captured true result.
```

This trace was read from actual source ONLY. It was NOT executed, not a runtime finding/receipt or replacement for the independent3P2 review. Token cancellation needs no reactive principal change, so a downstream id/deep watcher is not the required private authority fence. Consumer cannot treat this exposed Pinia action as a pure final lookup. Original auth owner should confirm and expose its real callback-free private port (for example an original frozen nested port whose functions are not setup action properties, or an authentic owner-issued raw-port accessor); Root must not unwrap private Pinia markers or implement a proxy owner. Exact repaired source and nominal port types are needed before choosing the connection. No owner repair is performed here.

## Expiry/permission scope stays limited

The real supplied owner expressly states `ADMIN_ACTIVE_TTL_MS` is refresh-cache freshness, not server absolute expiry. Its timer callback and explicit expired/session-expired transitions attest producer-observed retirement only; blocked tasks/delayed timers do not establish exact wall-clock expiry or unobserved server revocation. The token also does not itself grant the Writer's exact required permission. This preparation never promotes it to a complete server permissions/expiry guarantee, live authority, full-host restoration or full-ready. Those missing authority inputs remain explicit refusal limits.

Only original source/git/package reads and this artifact's diff check were performed. Production Writer/auth/Document/private-surface/Journal source is unchanged. No compiler/lint result is carried forward as a new source run; existing b697 checks retain their original binding. All tests/list/discovery/collection/candidate imports/mount/native/SDK/security/receipt/expiry/full-ref/restore/qualification and frozen-authority holds remain. Nine execution issues remain unaccepted and #1809 tracking incomplete. No issue closure, merge, deployment, master push or final cross-chain conflict resolution.
