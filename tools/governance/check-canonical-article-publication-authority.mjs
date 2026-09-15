#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);

export const requiredAuthorityFiles = Object.freeze([
    "src/backend/Services/Fixtures/CanonicalArticlePublicationFixturePort.cs",
    "src/backend/Services/Fixtures/CanonicalArticlePublicationVerifier.cs",
    "src/backend/Services/Articles/ArticleProductionNormalizers.cs",
    "src/backend/Services/Articles/ArticleRightsSnapshotBuilder.cs",
    "src/backend/Services/Articles/ArticleRightsPolicyPersistence.cs",
    "src/backend/Services/Articles/ArticleRevisionPersistence.cs",
    "src/backend/Services/Articles/ArticleCreateMutationAuthority.cs",
    "src/backend/Infrastructure/Integrity/ArticleResponsibilitySnapshotBuilder.cs",
    "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs",
    "src/backend/Services/ArticleService.cs",
    "src/backend/Services/ArticleService.CacheAndInvalidation.cs",
    "src/backend/Infrastructure/Integrity/ArticleResponsibilityManifest.cs"
]);

export function checkCanonicalArticlePublicationAuthority(repositoryRoot = defaultRoot)
{
    const violations = [];

    // 1. Check existence of authority files
    for (const relative of requiredAuthorityFiles)
    {
        const absolute = path.join(repositoryRoot, relative);
        if (!existsSync(absolute))
        {
            violations.push(`required authority file missing: ${relative}`);
        }
    }

    if (violations.length > 0)
    {
        return violations;
    }

    const portSource = readFileSync(
        path.join(repositoryRoot, "src/backend/Services/Fixtures/CanonicalArticlePublicationFixturePort.cs"),
        "utf8"
    );
    const verifierSource = readFileSync(
        path.join(repositoryRoot, "src/backend/Services/Fixtures/CanonicalArticlePublicationVerifier.cs"),
        "utf8"
    );
    const registrationSource = readFileSync(
        path.join(repositoryRoot, "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs"),
        "utf8"
    );

    // 2. Test port production exposure check
    if (!registrationSource.includes("ICanonicalArticlePublicationFixturePort"))
    {
        violations.push("ICanonicalArticlePublicationFixturePort must be registered in DI");
    }

    // Must be inside fixture-only block (ShouldAddLocalCommentFixtureServices)
    const fixtureBlockRegex = /if\s*\(\s*ShouldAddLocalCommentFixtureServices\b[\s\S]*?ICanonicalArticlePublicationFixturePort[\s\S]*?\}/u;
    if (!fixtureBlockRegex.test(registrationSource))
    {
        violations.push("ICanonicalArticlePublicationFixturePort must only be registered within local comment/fixture services condition");
    }

    // Must NOT be registered outside fixture block
    const strippedRegistration = registrationSource.replace(fixtureBlockRegex, "");
    if (strippedRegistration.includes("ICanonicalArticlePublicationFixturePort"))
    {
        violations.push("ICanonicalArticlePublicationFixturePort must not be registered outside fixture block (production exposure prohibited)");
    }

    // 3. Direct SQL prohibition
    if (/(?:INSERT\s+INTO\s+article|UPDATE\s+article|DELETE\s+FROM\s+article)/iu.test(portSource))
    {
        violations.push("direct article raw SQL query string prohibited in CanonicalArticlePublicationFixturePort");
    }
    if (/\b(?:ExecuteSql|Ado\.ExecuteCommand\s*\(\s*["'])/u.test(portSource))
    {
        violations.push("direct raw SQL execution prohibited in CanonicalArticlePublicationFixturePort");
    }

    // 4. Manual Redis / Cache / Search / AOT projection prohibition
    if (/\b(?:Redis|ConnectionMultiplexer|IConnectionMultiplexer|IDatabase|StackExchange\.Redis)\b/u.test(portSource))
    {
        violations.push("manual Redis usage prohibited in CanonicalArticlePublicationFixturePort");
    }
    if (/\b(?:ISearchIndexService|IPublicAot|IArticleHotRead)\b/u.test(portSource))
    {
        violations.push("direct search or AOT projection execution prohibited in CanonicalArticlePublicationFixturePort");
    }

    // 5. Admin ID 0 prohibition
    if (!portSource.includes("admin_principal_id_invalid") || !portSource.includes("AdminPrincipalId <= 0"))
    {
        violations.push("CanonicalArticlePublicationFixturePort must reject AdminPrincipalId <= 0 with admin_principal_id_invalid");
    }

    // 6. Rights / Content sentinel prohibition
    if (!portSource.includes("rights_recompute_sentinel_forbidden") || !portSource.includes("recompute"))
    {
        violations.push("CanonicalArticlePublicationFixturePort must reject recompute sentinel");
    }

    // 7. Atomic transaction enforcement
    if (!portSource.includes("db.Ado.UseTranAsync"))
    {
        violations.push("CanonicalArticlePublicationFixturePort must execute mutations inside an atomic transaction (UseTranAsync)");
    }

    // 8. Verifier must verify all 7 table entities
    const requiredEntities = [
        "Article",
        "ArticleRevision",
        "ArticlePublicationRecord",
        "ArticleRightsSnapshot",
        "ArticleResponsibilitySnapshot",
        "ArticleMutationOutboxEvent"
    ];

    for (const entity of requiredEntities)
    {
        if (!verifierSource.includes(`Queryable<${entity}>`))
        {
            violations.push(`CanonicalArticlePublicationVerifier must verify entity table Queryable<${entity}>`);
        }
    }

    if (!verifierSource.includes("sys_audit_log"))
    {
        violations.push("CanonicalArticlePublicationVerifier must verify audit log persistence from sys_audit_log");
    }

    // 9. Production must call shared normalizer / rights / responsibility seams (no parallel fork)
    const articleServiceSource = readFileSync(
        path.join(repositoryRoot, "src/backend/Services/ArticleService.cs"),
        "utf8"
    );
    const cacheSource = readFileSync(
        path.join(repositoryRoot, "src/backend/Services/ArticleService.CacheAndInvalidation.cs"),
        "utf8"
    );
    const responsibilitySource = readFileSync(
        path.join(repositoryRoot, "src/backend/Infrastructure/Integrity/ArticleResponsibilityManifest.cs"),
        "utf8"
    );
    const authoritySource = readFileSync(
        path.join(repositoryRoot, "src/backend/Services/Articles/ArticleCreateMutationAuthority.cs"),
        "utf8"
    );
    if (!articleServiceSource.includes("ArticleProductionNormalizers.NormalizeArticleRights"))
    {
        violations.push("ArticleService must call ArticleProductionNormalizers.NormalizeArticleRights");
    }
    if (!articleServiceSource.includes("ArticleRightsSnapshotBuilder.Build"))
    {
        violations.push("ArticleService must call ArticleRightsSnapshotBuilder.Build");
    }
    if (!articleServiceSource.includes("ArticleRightsPolicyPersistence.UpsertAsync"))
    {
        violations.push("ArticleService must call ArticleRightsPolicyPersistence.UpsertAsync");
    }
    if (!cacheSource.includes("ArticleProductionNormalizers.NormalizeText")
        || !cacheSource.includes("ArticleProductionNormalizers.NormalizeTagIds"))
    {
        violations.push("ArticleService cache helpers must delegate NormalizeText/NormalizeTagIds to ArticleProductionNormalizers");
    }
    if (!responsibilitySource.includes("ArticleResponsibilitySnapshotBuilder.Build"))
    {
        violations.push("ArticleResponsibilityAuthoringService must call ArticleResponsibilitySnapshotBuilder.Build");
    }
    if (!portSource.includes("ArticleRightsPolicyPersistence.UpsertAsync")
        && !authoritySource.includes("ArticleRightsPolicyPersistence.UpsertAsync"))
    {
        violations.push("Canonical article publication authority must reuse ArticleRightsPolicyPersistence.UpsertAsync");
    }
    if (!portSource.includes("ArticleCreateMutationAuthority.ExecuteAsync"))
    {
        violations.push("CanonicalArticlePublicationFixturePort must call ArticleCreateMutationAuthority.ExecuteAsync");
    }
    if (!portSource.includes("BeginPublicMutationFenceAsync")
        || !portSource.includes("IArticlePublicMutationFence"))
    {
        violations.push("CanonicalArticlePublicationFixturePort must establish production public mutation fence");
    }
    if (!portSource.includes("CommitPublicMutationFenceAsync")
        || !portSource.includes("RecoverAbortedPublicMutationFenceAsync"))
    {
        violations.push("CanonicalArticlePublicationFixturePort must commit or recover public mutation fence");
    }
    if (portSource.includes("Insertable(new ArticleRevision")
        || portSource.includes("new ArticleRevision"))
    {
        violations.push("CanonicalArticlePublicationFixturePort must not fixture-locally insert ArticleRevision");
    }
    if (!articleServiceSource.includes("ArticleCreateMutationAuthority.ExecuteAsync"))
    {
        violations.push("ArticleService.CreateMutationAsync must call ArticleCreateMutationAuthority.ExecuteAsync");
    }
    if (!articleServiceSource.includes("ArticleRevisionPersistence.SaveAsync"))
    {
        violations.push("ArticleService.SaveArticleRevisionAsync must call ArticleRevisionPersistence.SaveAsync");
    }
    if (!authoritySource.includes("ArticleRevisionPersistence.SaveAsync"))
    {
        violations.push("ArticleCreateMutationAuthority must call ArticleRevisionPersistence.SaveAsync");
    }

    // 10. Verifier must check receipt digest
    if (!verifierSource.includes("receipt_digest_tamper_detected") || !verifierSource.includes("ComputeReceiptDigest"))
    {
        violations.push("CanonicalArticlePublicationVerifier must verify receipt digest against canonical parameters");
    }

    return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    const violations = checkCanonicalArticlePublicationAuthority();
    if (violations.length > 0)
    {
        console.error("Canonical article publication authority violations detected:");
        for (const v of violations)
        {
            console.error(` - ${v}`);
        }
        process.exit(1);
    }
    console.log("Canonical article publication authority OK.");
}
