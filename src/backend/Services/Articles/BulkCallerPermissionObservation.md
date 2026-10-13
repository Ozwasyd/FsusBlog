# Original lifecycle caller permission observation

This unregistered internal increment belongs to the original
`ArticleLifecycleTransitionWriter`. It reads actual caller/site/session/permission
facts. It does not implement whole-set admission or change the original group
authority, adapter, registry, authentication, DI or availability contracts.

## Actual inputs and capture

`CaptureBulkCallerPermissionAsync` requires the caller's exact SqlSugar database
and live ambient Npgsql transaction/connection. The scope must be ReadCommitted:
a retained RepeatableRead snapshot cannot establish fresh permission changes when
the original owner later revalidates. This producer neither starts nor concludes
the transaction. The original owner remains responsible for abort/release if a
check fails.

The caller enters through `HttpContext.AuthenticateAsync("Bearer")`, the existing
JwtBearer scheme registered by `JwtHelper.AddJwtAuthentication`. It requires the
successful original authentication ticket, its exact authenticated principal
object as `HttpContext.User`, and the original handler's saved access token.
`IsAuthenticated`, an arbitrary principal, cookie, caller digest or manually
constructed session observation alone is insufficient. The actual registered
`IAdminSessionValidationService` must be the original validator instance. Capture
consumes its accepted current-session observation and retains private original
principal/session/token-hash custody. There is no separate raw-token field, serialization
or logging. Original request/ticket/service-provider identity references are weak;
they do not add strong custody of the original request's headers/cookies/saved token.
Runtime retention/privacy behavior is unqualified. JWT lifetime fields come from the actual original handler's
ticket `IssuedUtc`/`ExpiresUtc`, then are checked with the same registered business
`TimeProvider`; no alternative JWT parser/signature validator is added. The locked
JwtBearer10.0.7 [original handler source](https://github.com/dotnet/aspnetcore/blob/v10.0.7/src/Security/Authentication/JwtBearer/src/JwtBearerHandler.cs)
sets those fields from its validated `SecurityToken.ValidFrom`/`ValidTo` and saves
`access_token` only after the original TokenValidated event succeeds. Authentication
may be cached within the original request, so a repeated authentication result
is not claimed as a new signature validation or future revocation exclusion.

The site is the exact current value from the existing
`SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope` and the same
registered configuration object. Caller site mismatch or configuration/caller/
service replacement is refusal. This binds configured site identity; it does not
establish article/document ownership or a site-wide permission grant.

Native reads join real `admin_principal` and `admin_session` for the actual
authenticated admin/session identities. They retain actual principal status/root/
permissions, both `xmin` values, stored token hash, revocation and idle/absolute
deadlines. Token identity, active status and deadlines must agree with current
original authentication/session checks. Permissions are bounded to32KiB by the
SQL projection before materialization; over-limit/NULL/missing/ambiguous rows
refuse rather than supplying empty or fabricated facts.

## Separate permission decisions

Only the original editable adapter's four operations are supported:
`lifecycle.archive`, `lifecycle.restore`, `lifecycle.inbox-to-draft`, and
`lifecycle.draft-to-inbox`. The original registry supplies each exact operation
policy (`article.lifecycle.write`); registry/catalog values are unchanged.

The original writer's persisted `article.write` rule is preserved: the actual
persisted root bit or exact permission satisfies that check. Separately, an exact
persisted operation policy must be present. There is no inferred mapping from
`article.write`, claim fallback, wildcard or default permission. There is no
implemented original Bulk root-policy bypass, so even a root without the explicit
operation permission yields `ExplicitOperationPermissionAbsent`. A future root
policy must come from its real original owner rather than this observer.

The opaque object's decision distinguishes missing original write permission,
missing explicit operation permission, and both actually present. The last value
describes facts only. It is not executable admission, `Permitted` for a plan item,
an `Actor.AuthorityDigest`, a permission receipt, or a group grant.

## Revalidation and lifetime

`RevalidateBulkCallerPermissionAfterLockAsync` accepts only this producer's exact
opaque object with the same database, transaction, request and configuration.
Private weak-key custody rejects fabricated/copied/foreign objects. It rereads
actual native rows using `FOR SHARE OF ap,s` in that same transaction, requires
exact original facts and decision, rechecks original ticket/principal/token/site/
services/business-time identity, and finishes with actual original projection
revalidation. Cancellation is checked after original/async reads and on the real
request abort token. Failure poisons the observation; it cannot refresh into a
successful replacement. Concurrent revalidation is refused. The transaction owner
retains the acquired share locks and owns their release; cleanup is no receipt.

Checks describe their actual validation points. They do not freeze configuration,
JWT keys, request identity or projected session state after return and cannot
attest future authorization. Same-request JwtBearer cache reuse and snapshot
semantics are explicit limits, not independently qualified session leases.

## Remaining original group integration

The unchanged `IArticleBulkEditableLifecycleGroupAuthority` still owns
`ReserveAsync`, `SealPreparationAsync`, `RevalidateBeforeCommitAsync`,
`CompleteCommitAsync` and `AbortAsync`. This producer is an available input for its
capture/locked revalidation stage, not an implementation of those methods.
Accepted4269/4272 provide real original writer revision resolution/preparation;
accepted4263 provides real persisted draft locks/CAS and is not an editor/unsaved
state permission source. Those facts cannot create missing document/editor/
unsaved-state/lease/fence, whole-set article/site/operation/dependency policy,
side-effect feasibility or durable conclusion producers. Without the full original
facts the group remains unavailable/refused. No false bool wrapper, new issuer,
admission digest, commit/abort/zero-write receipt or DI activation is added.

Ordinary unit controls are source only, UNRUN and uncompiled. Actual JWT/request,
native locks/permission drift, cancellation, repeated/interrupted flows, database,
HTTP, security/privacy and frozen qualification remain HOLD. Static compilation
or source checks do not accept these runtime boundaries. #3735/#3736/#3738 remain
WIP. Rollback is a scoped source revert before activation; no database or live
authentication change has been applied.
