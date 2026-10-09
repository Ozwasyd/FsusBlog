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
