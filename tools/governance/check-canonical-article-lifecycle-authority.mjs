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
