# Original actor context and canonical server site input

This records inspected source contracts and the new bounded producer's application
signature. It is not a persisted site observation, production grant, wire API or
site lifecycle policy. The coordinator initially investigated site supply through
root #3735, then explicitly assigned the sole SystemService/SystemConfig identity
authority to task `01a12083-5888-74c3-bd48-2d091c82b02d`. This task does not duplicate
that authority or edit its seven exclusive files. Its reader signature is not yet
published; no `ISystemSiteIdentityReader` call has been guessed or implemented here.

## Exact original context contract

`src/shared/Contracts/ArticleRelations/ArticleRelationContracts.cs` defines:

```csharp
public sealed record ArticleRelationActorContext(
    string ActorIdentity,
    string SiteIdentity,
    string PermissionContextDigest);
```

`ArticleRelationContractValidator.Validate(ArticleRelationActorContext? actor)`
returns `article_relation_actor_context_invalid` for null or any invalid field.
Both identity strings use the same private `IsContextIdentity` implementation:

- Non-null; `string.Length` is 3 through 160 inclusive, measured by C# UTF-16
  string length.
- Must contain the literal `:` character.
- Must not contain the substring `http`, using `OrdinalIgnoreCase` comparison.
- Each character must pass `!char.IsWhiteSpace` and `!char.IsControl`.
- None of `/`, `\`, `?`, `=`, `#` is permitted.
- No UUID, ASCII-only, prefix namespace, lowercase identity or URL canonicalization
  rule is imposed by this validator. Do not infer those extra rules from fixtures.

`ArticleRelationDigest.IsSha256` requires a non-null string of length exactly 64;
every character must be `0`–`9` or `a`–`f`. A prefix or uppercase hex is rejected.
The original package request calls permission/policy digests assertions; matching
syntax or digest values does not observe persisted current permissions.

## Original consumer signatures

```csharp
public sealed record ArticlePackageImportCandidateRequest(
    ArticleRelationActorContext Actor,
    ArticlePackageImportCandidateMode Mode,
    string PolicyDigest,
    DateTime CreatedAtUtc,
    DateTime ExpiresAtUtc,
    IReadOnlyList<ArticlePackageImportRequestedTarget>? RequestedTargets);

public static ArticlePackageManifestCandidateResult TryCreatePlan(
    ArticlePackageValidatedImportCandidate? candidate,
    ArticlePackageImportCandidateRequest? request,
    out ArticlePackageImportCandidatePlan? plan,
    CancellationToken cancellationToken = default);

public static ArticlePackageManifestCandidateResult TryReadCandidate(
    ReadOnlySpan<byte> archiveBytes,
    out ArticlePackageImportZipCandidate? candidate,
    CancellationToken cancellationToken = default);

public static ArticlePackageManifestCandidateResult TryProject(
    ArticlePackageImportCandidatePlan? plan,
    int pageIndex,
    int pageSize,
    DateTime nowUtc,
    out ArticlePackageCandidateReview? review);
```

The original planner validates the actor through that sole validator, requires a
SHA-256 policy assertion, UTC endpoints with expiry after creation, a known mode
and bounded copied target hints. `RequireExecutionAuthority()` still returns
`article_package_import_authority_unavailable` for every finite plan.

## Implemented bounded application structure

The two exclusive new producer/test files are present at source
`018fe311aa6a214cc698281edcac23e6cd4704cf`. They use the original context type and
validator; no new shared authority or registry was introduced.

```csharp
public Task<ArticlePackageImportCandidateReviewProduction> ProduceAsync(
    ReadOnlyMemory<byte> archiveBytes,
    ArticlePackageImportCandidateRequest? request,
    int pageIndex,
    int pageSize,
    Func<CancellationToken, ValueTask<ArticleRelationActorContext?>>? observeServerContext,
    CancellationToken cancellationToken = default);
```

This is a server application signature, not a transport DTO. The constructor
uses `IHttpContextAccessor` and optional `TimeProvider`. The actual authenticated
request must supply a positive `admin_id`, the original `admin_principal` kind,
nonempty `admin_sid` and `article.write` permission claim. The backend actor
projection is the observed kind followed by `:` and invariant numeric admin ID;
a client-selected/source-package actor cannot replace it. The server-composed
request and the mandatory context observer must match this actor and each other.

The observer must be supplied by the actual canonical server binding adapter,
never deserialized from a request. It is called before intake and after planning.
Changed/null contexts, changed admin/session/request identity or revoked permission
refuse output. The actual auth context is checked again immediately before return.
Permission-context values retain their original assertion status. Two observations
detect observed drift; they do not claim an atomic DB permission fence. Original
reader/planner/projection refusal reasons and execution refusal are retained.

There is no DI/HTTP registration, fake default site, URL conversion or permanently
unavailable site implementation in this module. Its positive controlled unit
context is only a unit input. Production positive site binding remains WIP until
the canonical port and its actual source commit arrive.

## Inspected current server site APIs

- `ClaimsPrincipalExtensions` owns typed admin/session/kind/permission access;
  none of its methods supplies a stable site identity.
- `AuthorRecentArticleHistoryApplicationFacade.ResolveOwner` uses the authenticated
  server request and delegates URL scope resolution to the existing history owner.
- `SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(IConfiguration)`
  reads `SITE_BASEURL` or `PublicSiteIdentityDefaults.SiteBaseUrl`, then applies
  `Trim().TrimEnd('/')`. The result is a URL scope. Its DB permission observation is
  history-purpose-bound and must not be borrowed as import-target permission.
- `SqlAuthorArticlePinPermissionAuthority` also reads `SITE_BASEURL` as scope.
- `IArticlePropertyValueAuthority.ReadAsync(long actorAdminPrincipalId,
  ArticlePropertyDefinitionOwner owner, int articleId, CancellationToken)` supplies
  the original article/property authorization and coordinates. The owner's
  `SiteScope` is not an `ArticleRelationActorContext.SiteIdentity` factory.
- `ISystemService.GetSeoConfigAsync` / `UpdateSeoConfigAsync` and `SystemService`
  persist the SEO `Seo_BaseUrl`; compliance reads/updates persist public compliance
  fields. These do not supply a canonical stable authoring identity.
- `SystemConfig` maps to the existing `sys_systemConfig` key/value table, with a
  primary-key string of length 64 and value length 512. No inspected field or
  operation defines stable site identity creation, rotation or restore behavior.
- No production `new ArticleRelationActorContext` factory was found in the inspected
  backend before this producer. Sample `site:primary` values are test inputs.

## Canonical source requirement and bounded decisions

An ordinary server persisted identity is product work, not a user credential
blocker. The canonical owner should supply the sole server read/binding port,
including a real persisted identity and its relationship to the current authenticated
server site. Missing, malformed, revoked or ambiguous observations must fail closed;
readonly intake must not initialize, repair, hash or silently rotate that identity.
The observer adapter can reuse the original actor context without a new registry.

The canonical task owns its seven new source/contract/test files plus its actual
configuration binding work. The earlier proposed Authoring authority filenames
have not been created or reserved by this task. Consume only the coordinator's
exact published reader contract, source commit and binding evidence; ambiguous
legacy data must remain refused. No second registry or site authority is needed.

If no original initialization/migration policy exists, the precise decisions are:

1. Provision a fresh identifier once through an explicit canonical server bootstrap,
   persist it atomically and keep readonly requests read-only; or adopt an existing
   authoritative installation identifier if a real provisioning record exists.
2. Define who owns first creation and how an already-installed site is initialized
   without fabricating an old identity. Do not choose a readonly-request fallback.
3. Define backup/restore and clone/fork behavior: restoring the same site preserves
   identity; creating a distinct site needs an explicitly authorized new identity.
4. Define URL/site-scope changes, binding revision and revocation semantics so the
   reader can reject drift without deriving identity from the URL.

These are bounded lifecycle choices for the canonical owner. No default was
selected here. Only genuinely unknown external tenant/provisioning facts require
that external input; absence of ordinary persistence code calls for implementation.
