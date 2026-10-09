# Stable SiteIdentity source review

Checked master `9d72a1c93b297f719d8695a642cdfb1615cf1d51`. This is read-only authority discovery for Package3663 and Graph actor context, not an implementation or a new identity registry. Exact blobs/hashes and bounded search coverage are in source-review.json. No current canonical stable-reader method or persisted creation/lifecycle contract was found in the reviewed source. This finding is bounded; an existing original owner outside those fetched objects can still supply its exact source and evidence.

## Actual boundary

`ArticleRelationContractValidator.Validate(ArticleRelationActorContext)` requires both actor/site context IDs to contain a colon, length3..160, and forbids `http` case-insensitively, whitespace/control, `/`, backslash, `?`, `=`, `#`. `SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope` returns only configured `SITE_BASEURL.Trim().TrimEnd('/')`, defaulting to public SEO BaseUrl. These are different contracts; hashing/mapping the URL or loosening the validator would silently change authority.

`PublicSiteIdentityDefaults` is SEO content. `SystemConfig` stores generic editable key/value, with SystemService owning SEO/baseURL changes; no formal immutable installation/site identifier key is declared. `ArticleVaultExecutionBundleEntity.SiteIdentity` and its group/operation rows are persisted, but `PostgresArticleVaultExecutionStore.SealAsync` copies `bundle.Plan.SiteIdentity`; those rows attest a supplied bundle and do not create/resolve the current server site. `AuthoringStateScope.SiteId` and RPC grants bind supplied scope values; neither declares server site creation/lookup/alias lifecycle.

## Exact unmerged candidates checked

Remote heads were discovered using read-only git ls-remote, fetched by their actual exact IDs and inspected only. Nothing was restored, cherry-picked or merged.

- `33e6e41d99cdb54bba707d8bc6eefb43da645772`, original3653 site-scope-contracts: actual endpoint ResolveActor uses the same recent-history URL scope; no new persisted stable identity.
- `c576838198b8a1a2034119cb3171f379b10302f7`, original3653 site-scope: original Jobs README explicitly replaces numericSiteId with configured URL SiteScope, rejects old schemas and has no alias/automatic migration.
- `3826541c65e0740566caed291af8b1d32b961c81` and `63360650bea0ecf5d41fdb0d56762cfc4e2a69e5`: actual API/job consumers retain that same URL-scope contract.

These candidates cannot supply Package/Graph’s stable SiteIdentity. Their code is not consumed here and their acceptance evidence is not rebound. The existing URL scope remains valid for its original permission/export contract.

## Missing decisions

1. Name the sole persisted site/installation identity owner, its canonical namespace/format, and trusted first-create operation. Decide whether creation occurs during install/provisioning or an explicit governed migration; ordinary read/POST must never opportunistically create a site.
2. For existing deployments, supply explicit ownership mapping from historical URL scopes and imported identities to the server identity. Ambiguous or cross-site rows remain refused; current URL alone is insufficient to silently claim every old scope.
3. Define URL change/alias addition/removal lifecycle and revision/fencing. Multiple approved URL aliases may represent one stable identity; imported package/source-site identity cannot select the target server identity. Original permission SiteScope must remain separately bound until an approved migration aligns consumers.
4. Define backup/restore versus database cloning semantics: continuation should preserve identity; a new independent site may need a new identity and explicit data reassignment. Do not infer either behavior from BaseUrl, database name or SEO.

## Two finite implementation choices

| Choice | Authority and lifecycle | Consequence |
| --- | --- | --- |
| Single installation identity within the existing SystemService/SystemConfig owner (recommended for the present one-site model) | Formally define one immutable persisted identity record/key under that owner, trusted one-time create, versioned lifecycle, explicit old-scope mapping and URL-alias policy. Only after that contract is approved add its typed server read/binding port. | Smallest storage/ownership change; still requires governed migration and clone/restore rules. No arbitrary key or config-provided caller identity is introduced by this review. |
| Explicit multi-site identity authority owned by the original site/schema/lifecycle team | Formally define multiple persisted site records plus alias ownership/version rules and migration across all site-scoped facts, then expose one current server binding port. | Supports multiple sites explicitly, but requires broader schema/lifecycle ownership and migration acceptance. It must be an explicit product decision, never a silent second registry in Package/Graph. |

If an existing canonical owner already decided these elsewhere, prefer consuming its exact commit and method over either new design. Until that source or decision is supplied, there is no truthful production method/SHA to hand Package/Graph. This is a normative identity lifecycle gap, not a missing user credential, external native blocker or generic environment issue. No URL hash, site:primary, package-site, SEO substitution, random config key, fabricated stable ID or fallback authority was implemented.

## Already usable independent source

Export choices wire source `10b33204607627d167e34f7ad69bcfccaee03b2c`, evidence HEAD `61db8354f4047e9aaf36d137658227203b9f6333`, branch `codex/shared-export-source-options-current-base-20261009`, remains ready for original3653 handler integration. That original URL SiteScope contract was preserved; this read-only finding does not rewrite it. Graphfreshness source47a4e786a/evidence979d9ea6 remains supplied separately; original3657 still owes root-preserving A527/B548/total1075 closure.

No test, runtime probe, content API mutation, identity allocation, production DDL, merge, deployment or issue closure occurred in this review.

## Subsequent parent decision and integration preflight

The coordinating parent subsequently selected the single-installation design and assigned its sole implementation owner to thread `01a12083-5888-74c3-bd48-2d091c82b02d` (turn `01a12083-601a`). The design choice above is now decided. The earlier missing-decision section records the review at its original commit; it is not the current blocker. The current dependency is that owner's exact contract/source commit and the parent's existing-file hunk assignment.

The owner exclusively holds `SystemService.SiteIdentity.cs`, `ISystemSiteIdentityReader.cs`, `SystemSiteIdentityContracts.cs`, `SystemSiteIdentityMigrationDefinitions.cs`, the two original `SystemSiteIdentity` test files, and `docs/development/system-site-identity.md`. This branch adds no implementation in those seven paths. Existing SystemService, configuration writers and DI remain read-only until the parent supplies exact hunk ownership. Root retains final Shared/DI integration.

The actual DI file is `src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs`. It already registers scoped `SystemService`; `ISystemService` separately resolves `SystemServiceCoreAdapter`. `SystemCoreGateway` takes the same scoped concrete `SystemService`. A future typed reader alias must reuse that concrete owner, preserve the Core adapter/gateway registration and constructor, and wait for the actual interface contract. No speculative registration was added. The existing service is already partial.

The current public `ISystemService` and binary system endpoints expose typed SEO/compliance/page operations. Its only two `SystemConfig` writes use fixed 24/14-key arrays; no arbitrary caller-key configuration writer was found in the reviewed backend C# source. This bounded finding is not proof of immutable storage. In particular, `PgLegacyNonArticlePreparation` binds all non-Page legacy SystemConfig rows with `replaceSeedValues: true` and generates `ON CONFLICT ... DO UPDATE`. The original identity owner must cover that import boundary and prove protected-key refusal/preservation with its actual contract and tests. Merely providing a read-only getter would not meet that requirement. No migration or database write was executed here.

The readonly preflight commands, exact blob preimages and SHA256s are in `integration-preflight.json` and `configuration-writer-search.txt`. This is source discovery only; no build, test body, runtime, native qualification or identity acceptance is claimed.

Separately, Graph membership is now supplied: source `530c22099ee97532ddc2a951850012f5adf0d0e3`, published evidence HEAD `c3a8cfaa34fcc1e58e778b647a4d70e19e7e9879`, branch `codex/shared-graph-reader-registration-20261009`. Its original checker passed 127 classes / 1075 estimated methods / A527 / B548, and its 11 original Node controls passed with cleanup. This supersedes the earlier pending-count statement; it does not rebind the strict SDK failure or claim managed runtime acceptance.

## Canonical source supplied; independent review pending

The parent supplied source `467857b3cc88aaa2916159552c24088f6f9910b8` on `feat/system-site-identity-20261009`, directly based on `9d72a1c93b297f719d8695a642cdfb1615cf1d51`. This review fetched that exact object and read its actual six added files using `git show`; nothing was cherry-picked, restored or merged. Existing SystemService/configuration-writer/DI preimages are unchanged. The reserved `SystemSiteIdentityMigrationDefinitions.cs` path is absent from this source; the owner's actual implementation uses the existing SystemConfig table and explicit service lifecycle methods instead of runtime DDL. This describes the source supplied, not an acceptance waiver or a claim that migration compatibility is proven.

The actual read port is `ISystemSiteIdentityReader.ReadCurrentSiteIdentityAsync(CancellationToken)`, returning `SystemSiteIdentityReadModel(State, Identity, LifecycleVersion, Generation, MappingRevision, Scopes)`. Its states are `Absent`, `MigrationRequired`, `Ambiguous`, `Malformed`, `UnsupportedVersion`, and `Current`; refusal snapshots expose null authority coordinates and an empty scope list. Only Current may be considered downstream authority. The existing SystemService partial implements the interface. Future scoped alias integration can therefore refer to this exact port and reuse the existing concrete scoped service, without replacing the Core adapter or adding another store/initializer.

The owner exposes separate explicit transaction-bound initialization, legacy binding, versioned scope-change and independent-clone methods on SystemService; they are not called by the reader and are not registered as HTTP routes here. No root registration or downstream promotion is performed before the independent security/compatibility review and parent hunk assignment. Exact scope matching and generation/mapping-revision revalidation remain consumer requirements; the original permission/export URL SiteScope is not silently rewritten.

The owner's six unit methods and thirteen original PostgreSQL integration methods were inspected as source only. Its document reports nineteen plus one configuration-loader executions and also reports missing shared PostgreSQL collection registration, lifecycle registration and other source gates. Those reported executions are not qualified, independently rerun or rebound here. This readonly review neither discovers nor executes managed tests, allocates an identity, initializes a deployment, or claims backup/restore/runtime acceptance. Source bindings and the pending integration gates are recorded in `canonical-source-preflight.json`. Export source `10b33204607627d167e34f7ad69bcfccaee03b2c` remains a separate already delivered increment.
