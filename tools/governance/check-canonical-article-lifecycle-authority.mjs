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
    "src/backend/Services/Articles/ArticleLifecycleTransitionWriter.cs",
    "src/backend/Services/Fixtures/CanonicalArticleLifecycleFixturePort.cs",
    "src/backend/Services/Fixtures/CanonicalArticleLifecycleVerifier.cs",
    "src/backend/Services/Fixtures/CanonicalArticleProjectionVerifier.cs",
    "src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs",
    "src/backend/Services/Fixtures/PublicContentFixtureSeeder.Verification.cs",
    "src/backend/Services/ArticleMutationSideEffects.cs",
    "src/backend/Services/SearchIndexService.ProjectionEvidence.cs",
    "src/backend/Services/ArticlePublicationTransition.cs",
    "src/backend/Services/Articles/ArticleRevisionPersistence.cs",
    "src/backend/Services/Articles/ArticleRightsSnapshotBuilder.cs",
    "src/backend/Infrastructure/Integrity/ArticleResponsibilitySnapshotBuilder.cs",
    "src/backend/Services/ArticleMutationOutboxProducer.cs",
    "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs"
]);

export function checkCanonicalArticleLifecycleAuthority(repositoryRoot = defaultRoot)
{
    const violations = [];
    for (const relative of requiredAuthorityFiles)
    {
        if (!existsSync(path.join(repositoryRoot, relative)))
        {
            violations.push(`required authority file missing: ${relative}`);
        }
    }
    if (violations.length > 0)
    {
        return violations;
    }

    const read = (relative) => readFileSync(path.join(repositoryRoot, relative), "utf8");
    const writer = read("src/backend/Services/Articles/ArticleLifecycleTransitionWriter.cs");
    const port = read("src/backend/Services/Fixtures/CanonicalArticleLifecycleFixturePort.cs");
    const verifier = read("src/backend/Services/Fixtures/CanonicalArticleLifecycleVerifier.cs");
    const projectionVerifier = read("src/backend/Services/Fixtures/CanonicalArticleProjectionVerifier.cs");
    const publicContentSeeder = read("src/backend/Services/Fixtures/PublicContentFixtureSeeder.cs");
    const publicContentVerification = read("src/backend/Services/Fixtures/PublicContentFixtureSeeder.Verification.cs");
    const productionEdges = read("src/backend/Services/ArticleMutationSideEffects.cs");
    const lifecycleProjectionStart = publicContentVerification.indexOf("if (lifecycle is not null)");
    const publicationProjectionStart = publicContentVerification.indexOf(
        'else if (original.Fields.ContainsKey("projectionAggregate"))', lifecycleProjectionStart);
    const lifecycleProjectionObservation = lifecycleProjectionStart >= 0 && publicationProjectionStart > lifecycleProjectionStart
        ? publicContentVerification.slice(lifecycleProjectionStart, publicationProjectionStart) : "";
    if (!lifecycleProjectionObservation.includes("projectionVerifier.VerifyAsync(")
        || !lifecycleProjectionObservation.includes("lifecycle, invocation.Binding, cancellationToken)")
        || !/RequireVerificationEquality\(original\.Fields, fields,\s*"projectionAggregate", "requiredProjectionEdgesVerified"\)/u.test(lifecycleProjectionObservation))
    {
        violations.push("independent public verification must reread and match the sealed projection aggregate");
    }
    const publicationProjectionEnd = publicContentVerification.indexOf(
        'else if (original.Kind is "category" or "tag")', publicationProjectionStart);
    const publicationProjectionObservation = publicationProjectionStart >= 0 && publicationProjectionEnd > publicationProjectionStart
        ? publicContentVerification.slice(publicationProjectionStart, publicationProjectionEnd) : "";
    if (!publicationProjectionObservation.includes("snapshot.Publications")
        || !publicationProjectionObservation.includes(".SingleOrDefault(item => item.ArticleId == id)")
        || !publicationProjectionObservation.includes("RequirePublicationInvocation(snapshot, id)")
        || !/fields\["projectionAggregate"\]\s*=\s*await projectionVerifier\.VerifyAsync\(\s*preparedPublication, invocation\.Request, cancellationToken\)/u.test(publicationProjectionObservation)
        || !/RequireVerificationEquality\(original\.Fields, fields,\s*"projectionAggregate", "requiredProjectionEdgesVerified"\)/u.test(publicationProjectionObservation))
    {
        violations.push("independent publication verification must reread and match the sealed projection aggregate using its original invocation");
    }
    const registration = read("src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs");

    const requiredVariants = [
        "Draft", "Scheduled", "Published", "PublishedScheduledUpdate", "Archived",
        "Deleted", "Restore", "Rollback", "MultipleRevisions", "MultiplePublications"
    ];
    for (const variant of requiredVariants)
    {
        if (!port.includes(`CanonicalArticleLifecycleVariants.${variant}`))
        {
            violations.push(`lifecycle variant missing: ${variant}`);
        }
    }

    if (!registration.includes("ICanonicalArticleLifecycleFixturePort")
        || !registration.includes("CanonicalArticleLifecycleFixturePort"))
    {
        violations.push("ICanonicalArticleLifecycleFixturePort must be registered in DI");
    }
    const localBlock = /if\s*\(\s*ShouldAddLocalCommentFixtureServices\b[\s\S]*?ICanonicalArticleLifecycleFixturePort[\s\S]*?\}/u;
    if (!localBlock.test(registration))
    {
        violations.push("lifecycle fixture port must only be registered in the local fixture block");
    }
    if (registration.replace(localBlock, "").includes("ICanonicalArticleLifecycleFixturePort"))
    {
        violations.push("lifecycle fixture port must not be registered for production");
    }
    if (!localBlock.test(registration)
        || !localBlock.exec(registration)?.[0].includes("CanonicalArticleProjectionVerifier"))
    {
        violations.push("projection verifier must only be registered in the local fixture block");
    }

    if (!port.includes("ArticleLifecycleTransitionWriter.CreateAsync")
        || !port.includes("ArticleLifecycleTransitionWriter.UpdateAsync")
        || !port.includes("ArticleLifecycleTransitionWriter.DeleteAsync")
        || !port.includes("ArticleLifecycleTransitionWriter.RestoreAsync")
        || !port.includes("ArticleLifecycleTransitionWriter.RollbackAsync")
        || !port.includes("ArticleLifecycleTransitionWriter.PublishScheduledAsync"))
    {
        violations.push("all lifecycle variants must call the shared lifecycle transition writer");
    }
    if (!port.includes("db.Ado.UseTranAsync")
        || !port.includes("BeginPublicMutationFenceAsync")
        || !port.includes("CommitPublicMutationFenceAsync")
        || !port.includes("RecoverAbortedPublicMutationFenceAsync"))
    {
        violations.push("lifecycle fixture port must use the production transaction and mutation fence");
    }
    if (!/new ArticleLifecycleTransitionWriter\.ScheduledPublishRequest\(\s*scheduledReceipt\.ArticleId,\s*scheduledReceipt\.CurrentRevisionId,\s*now,/u.test(port)
        || !port.includes("if (now < dueAt)")
        || !port.includes("scheduled_publication_not_due")
        || !verifier.includes("operation.TransitionedAtUtc > now")
        || !verifier.includes("operation_ahead_of_business_clock"))
    {
        violations.push("scheduled completion must use the observed business clock and reject future authority facts");
    }
    if (/(?:INSERT\s+INTO\s+article|UPDATE\s+article|DELETE\s+FROM\s+article)/iu.test(port)
        || /\bAdo\.ExecuteCommand\s*\(/u.test(port))
    {
        violations.push("lifecycle fixture port must not directly mutate article lifecycle tables");
    }
    if (port.includes("new ArticleRevision")
        || port.includes("new ArticlePublicationRecord")
        || port.includes("new ArticleRightsSnapshot")
        || port.includes("new ArticleResponsibilitySnapshot"))
    {
        violations.push("lifecycle fixture port must not construct immutable lifecycle rows directly");
    }

    if (!writer.includes("ArticleRevisionPersistence.SaveAsync")
        || !writer.includes("ArticlePublicationTransitionWriter.ApplyAsync")
        || !writer.includes("ArticleMutationOutboxProducer.Create")
        || !writer.includes("AuthoringSignedAuditWriter.InsertAsync")
        || !writer.includes("RollbackSourceRevisionId"))
    {
        violations.push("shared writer must persist revision, publication, outbox, audit, and rollback coordinates");
    }
    if (/UPDATE\s+article_revision\b/iu.test(writer)
        || /UPDATE\s+article_publication\b/iu.test(writer)
        || /DELETE\s+FROM\s+article_revision\b/iu.test(writer)
        || /DELETE\s+FROM\s+article_publication\b/iu.test(writer))
    {
        violations.push("immutable revision/publication history must never be rewritten");
    }
    if (!writer.includes("active_admin_required")
        || !writer.includes("article_write_permission_required")
        || !writer.includes("EnsureExpectedRevision")
        || !writer.includes("ScheduledAtMustBeFuture"))
    {
        violations.push("writer must fail closed on admin, stale revision, and time drift");
    }

    const verifierEntities = [
        "Queryable<Article>",
        "Queryable<ArticleRevision>",
        "Queryable<ArticlePublicationRecord>",
        "Queryable<ArticleRevisionContentBlock>",
        "Queryable<ArticleRightsSnapshot>",
        "Queryable<ArticleResponsibilitySnapshot>",
        "Queryable<ArticleMutationOutboxEvent>",
        "Queryable<AuditLog>"
    ];
    for (const entity of verifierEntities)
    {
        if (!verifier.includes(entity))
        {
            violations.push(`lifecycle verifier must inspect ${entity}`);
        }
    }
    if (!verifier.includes("receipt_digest_tamper_detected")
        || !verifier.includes("ArticleMutationOutboxEnvelopeCodec.Read")
        || !verifier.includes("AuditTamperEvidence.Verify"))
    {
        violations.push("lifecycle verifier must validate receipt, outbox, and audit integrity");
    }
    if (!port.includes("CanonicalArticleLifecycleVerifier")
        || !port.includes("VerifyAsync(db, configuration, receipt"))
    {
        violations.push("lifecycle fixture receipt must be checked by an independent verifier");
    }

    if (!productionEdges.includes("public static readonly IReadOnlySet<string> Required")
        || !projectionVerifier.includes("ArticleMutationReplayEdges.Required")
        || !projectionVerifier.includes("ArticleMutationReplayEdges.ContractId"))
    {
        violations.push("projection verifier must consume the production required edge contract");
    }
    const derivedReaders = [
        "ISearchIndexService",
        "ISearchProjectionEvidenceReader",
        "IPublicArticleProjectionStore",
        "IArticleDetailAedsArtifactStore",
        "PublicHotReadStore",
        "IPublicAotInvalidationGenerationAuthority",
        "PublicArtifactRevocationRegistry",
        "IPublicArtifactRevocationStateStore",
        "IArticleCoreGateway",
        "ICacheStringReader"
    ];
    for (const reader of derivedReaders)
    {
        if (!projectionVerifier.includes(reader))
        {
            violations.push(`projection verifier must independently read ${reader}`);
        }
    }
    if (!projectionVerifier.includes("authority.RunId")
        || !projectionVerifier.includes("authority.Namespace")
        || !projectionVerifier.includes("authority.ReceiptDigest")
        || !projectionVerifier.includes("ArticleMutationOutboxEnvelopeCodec.Read")
        || !projectionVerifier.includes("ComputeTerminalReceiptDigest")
        || !projectionVerifier.includes("ComputeAggregateDigest"))
    {
        violations.push("projection verifier must bind current-run authority, sealed payload, and tamper digests");
    }
    const forbiddenVerifierWrites = [
        ".BuildIndexAsync(",
        ".AddOrUpdateIndexAsync(",
        ".SetStringAsync(",
        ".SetRawAsync(",
        ".StringIncrementAsync(",
        ".KeyDeleteAsync(",
        ".SortedSetAddAsync(",
        ".ScriptEvaluateAsync(",
        ".Insertable<",
        ".Updateable<",
        ".Deleteable<",
        ".ExecuteCommand",
        ".UpsertAsync(",
        ".GenerateAndStoreAsync(",
        ".InvalidateArticleMutationAsync(",
        "File.Exists(",
        "Directory.Exists("
    ];
    for (const marker of forbiddenVerifierWrites)
    {
        if (projectionVerifier.includes(marker))
        {
            violations.push(`projection verifier must remain read-only: ${marker}`);
        }
    }
    const forbiddenFixtureRepair = [
        "\"search-rebuild\"",
        "\"public-hot-rebuild\"",
        ".BuildIndexAsync(",
        ".AddOrUpdateIndexAsync(",
        ".SetStringAsync(",
        ".SetRawAsync(",
        ".SortedSetAddAsync(",
        ".StringIncrementAsync(",
        ".KeyDeleteAsync(",
        ".ScriptEvaluateAsync(",
        ".GenerateAndStoreAsync("
    ];
    // #2175 must not migrate #2690's non-canonical paths. Only the exact guarded
    // else branch and the existing exclusive empty-profile method retain rebuilds.
    const legacyPrepare = /if \(capabilities\.Any\(IsLifecycleCapability\)\)\s*\{\s*await AwaitPublicHotProjectionAsync\(cancellationToken\)\.ConfigureAwait\(false\);\s*\}\s*else\s*\{[\s\S]*?\n {8}\}\n\n {8}\/\/ Observe real read ports\./u;
    const legacyEmpty = / {4}private async Task EnsureEmptyOwnedNamespaceAsync\(string ownerPrefix, CancellationToken cancellationToken\)\n {4}\{[\s\S]*?\n {4}\}/u;
    if (!legacyPrepare.test(publicContentSeeder))
    {
        violations.push("canonical lifecycle preparation must be isolated from non-canonical rebuilds");
    }
    const canonicalSeeder = publicContentSeeder.replace(legacyPrepare, "").replace(legacyEmpty, "");
    for (const marker of forbiddenFixtureRepair)
    {
        const source = marker.includes("rebuild") ? canonicalSeeder : publicContentSeeder;
        if (source.includes(marker))
        {
            violations.push(`public-content fixture must not repair required projections: ${marker}`);
        }
    }
    if (!publicContentSeeder.includes("AwaitPublicHotProjectionAsync")
        || !publicContentSeeder.includes(".VerifyAsync(result.Receipt")
        || !publicContentSeeder.includes("requiredProjectionEdgesVerified"))
    {
        violations.push("canonical fixture must wait for production owners and publish verified projection evidence");
    }
    return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    const violations = checkCanonicalArticleLifecycleAuthority();
    if (violations.length > 0)
    {
        console.error("Canonical article lifecycle authority violations detected:");
        for (const violation of violations)
        {
            console.error(` - ${violation}`);
        }
        process.exit(1);
    }
    console.log("Canonical article lifecycle authority OK.");
}
