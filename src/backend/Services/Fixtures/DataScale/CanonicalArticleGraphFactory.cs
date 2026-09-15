using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Integrity;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

public static class CanonicalArticleGraphFactory
{
    private static readonly DateTime s_baseEpoch = new(2026, 7, 19, 0, 0, 0, DateTimeKind.Utc);
    private static readonly JsonSerializerOptions s_jsonWeb = new(JsonSerializerDefaults.Web);

    public static IReadOnlyDictionary<string, string> GetProductionContractVersions()
        => new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PlanSchema"] = ArticleScaleContractIds.PlanSchema,
            ["GraphSchema"] = ArticleScaleContractIds.GraphSchema,
            ["FactoryId"] = ArticleScaleContractIds.RequiredGraphFactory,
            ["SemanticIdPolicy"] = ArticleScaleContractIds.SemanticIdPolicy,
            ["OutboxFactoryId"] = ArticleMutationOutboxProducer.FactoryId,
            ["OutboxEnvelopeSchema"] = ArticleMutationOutboxEnvelopeCodec.CurrentSchemaId,
            ["OutboxEnvelopeVersion"] = ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion.ToString(CultureInfo.InvariantCulture),
            ["ReplayEdgesContract"] = ArticleMutationReplayEdges.ContractId,
            ["CanonicalContentHashVersion"] = "canonical-v1",
            ["CanonicalRightsHashVersion"] = "canonical-v1",
            ["SummaryProjectionVersion"] = ArticleSummaryProjection.CurrentGenerationVersion
        };

    public static IEnumerable<ArticleScaleArticleGraph> GenerateGraphStream(ArticleScalePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArticleScalePlanValidator.Validate(plan, plan.Artifacts).ThrowIfInvalid();

        int currentOrdinal = plan.IdAllocation.ArticleOrdinalBase;

        foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
        {
            for (int i = 0; i < allocation.Count; i++)
            {
                yield return BuildArticleGraph(plan, currentOrdinal, allocation.Variant, allocation.Contract);
                currentOrdinal++;
            }
        }
    }

    public static IEnumerable<IReadOnlyList<ArticleScaleArticleGraph>> GenerateBatches(
        ArticleScalePlan plan,
        int batchSize = 1000)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(batchSize, 0);

        var batch = new List<ArticleScaleArticleGraph>(batchSize);
        foreach (ArticleScaleArticleGraph graph in GenerateGraphStream(plan))
        {
            batch.Add(graph);
            if (batch.Count >= batchSize)
            {
                yield return batch;
                batch = new List<ArticleScaleArticleGraph>(batchSize);
            }
        }
        if (batch.Count > 0)
        {
            yield return batch;
        }
    }

    public static ArticleScaleGraphReceipt GenerateReceipt(ArticleScalePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArticleScalePlanValidator.Validate(plan, plan.Artifacts).ThrowIfInvalid();

        var sw = Stopwatch.StartNew();
        long startMemory = GC.GetTotalMemory(forceFullCollection: false);

        var variantCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        var rowCounts = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (ArticleScaleRowKind kind in Enum.GetValues<ArticleScaleRowKind>())
        {
            rowCounts[kind.ToString()] = 0;
        }
        foreach (ArticleScaleVariant v in Enum.GetValues<ArticleScaleVariant>())
        {
            variantCounts[v.ToString()] = 0;
        }

        long totalEdges = 0;
        using var hasher = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

        foreach (ArticleScaleArticleGraph graph in GenerateGraphStream(plan))
        {
            variantCounts[graph.Variant.ToString()]++;
            foreach (ArticleScaleRowPlan row in graph.Rows)
            {
                rowCounts[row.Kind.ToString()]++;
            }
            totalEdges += graph.EdgeObligations.Count;

            byte[] articleDigestBytes = Encoding.UTF8.GetBytes(graph.ArticleDigest);
            hasher.AppendData(articleDigestBytes);
        }

        string semanticGraphDigest = "sha256:" + Convert.ToHexString(hasher.GetHashAndReset()).ToLowerInvariant();

        sw.Stop();
        long peakMemory = Math.Max(0, GC.GetTotalMemory(forceFullCollection: false) - startMemory);

        return new ArticleScaleGraphReceipt(
            Schema: ArticleScaleContractIds.GraphSchema,
            PlanSchema: plan.Schema,
            PlanDigest: ArticleScalePlanDigest.Compute(plan),
            FactoryId: ArticleScaleContractIds.RequiredGraphFactory,
            ProductionContractVersions: GetProductionContractVersions(),
            VariantCounts: variantCounts,
            RowCounts: rowCounts,
            EdgeCount: totalEdges,
            SemanticGraphDigest: semanticGraphDigest,
            ElapsedMilliseconds: sw.ElapsedMilliseconds,
            PeakMemoryBytes: peakMemory,
            ContentDigest: plan.ContentDigest);
    }

    public static ArticleScaleArticleGraph BuildArticleGraph(
        ArticleScalePlan plan,
        int articleOrdinal,
        ArticleScaleVariant variant,
        ArticleScaleVariantContract contract)
    {
        string prefix = plan.IdAllocation.NamespacePrefix;
        string articleSemanticId = $"{prefix}:article/{articleOrdinal:D6}";
        string bodySemanticId = $"{prefix}:article/{articleOrdinal:D6}/body";
        string rightsPolicySemanticId = $"{prefix}:article/{articleOrdinal:D6}/rights/policy";

        // Temporal calculation matching contract
        DateTime created = s_baseEpoch.AddMinutes(articleOrdinal * 10);
        DateTime rev1Time = created.AddMinutes(1);
        DateTime pub1Time = rev1Time.AddMinutes(1);
        DateTime publishedTime = pub1Time;
        DateTime rev2Time = publishedTime.AddHours(2);
        DateTime commandTime = publishedTime.AddHours(3);
        DateTime boundaryTime = commandTime.AddDays(7);
        DateTime occurredTime = publishedTime.AddDays(1);

        // Content derivation
        string baseTitle = $"Canonical Article {articleOrdinal:D6}";
        string markdownContent = $"# Canonical Article {articleOrdinal:D6}\n\nDeterministic markdown body for article {articleOrdinal} variant {variant}.";
        ArticleSummaryProjectionResult summaryProj = ArticleSummaryProjection.Resolve(null, markdownContent);
        string summary = summaryProj.Text;
        string coverImageUrl = $"https://cdn.example.internal/media/cover-{articleOrdinal:D6}.webp";
        int categoryId = (articleOrdinal % 5) + 1;
        List<int> tagIds = ArticleProductionNormalizers.NormalizeTagIds([(articleOrdinal % 10) + 1, ((articleOrdinal + 2) % 10) + 1]);

        var rows = new List<ArticleScaleRowPlan>();
        var relations = new List<ArticleScaleRelationPlan>();
        var pointers = new List<ArticleScalePointerPlan>();
        var edgeObligations = new List<ArticleScaleEdgeObligationPlan>();

        // 1. Article Body Row
        rows.Add(new ArticleScaleRowPlan(
            ArticleScaleRowKind.ArticleBody,
            bodySemanticId,
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ArticleId"] = articleOrdinal,
                ["ArticleSemanticId"] = articleSemanticId,
                ["MarkdownContent"] = markdownContent,
                ["UpdatedAt"] = created.ToString("O")
            }));
        relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.BodyToArticle, bodySemanticId, articleSemanticId));

        // 2. Rights Policy Row
        var normalizedRights = ArticleProductionNormalizers.NormalizeArticleRights(null);
        rows.Add(new ArticleScaleRowPlan(
            ArticleScaleRowKind.ArticleRightsPolicy,
            rightsPolicySemanticId,
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ArticleId"] = articleOrdinal,
                ["ArticleSemanticId"] = articleSemanticId,
                ["Enabled"] = true,
                ["LicenseType"] = normalizedRights.LicenseType,
                ["CopyrightHolder"] = null,
                ["CopyrightYear"] = null,
                ["RightsStatement"] = null,
                ["AttributionTemplate"] = null,
                ["CopyPolicy"] = normalizedRights.CopyPolicy,
                ["MaxExcerptChars"] = normalizedRights.MaxExcerptChars,
                ["AllowCodeCopy"] = normalizedRights.AllowCodeCopy,
                ["ShowPublicBadge"] = normalizedRights.ShowPublicBadge,
                ["ProofBindingEnabled"] = normalizedRights.ProofBindingEnabled,
                ["CreatedAt"] = created.ToString("O"),
                ["UpdatedAt"] = created.ToString("O")
            }));

        // Build revisions, publications, outbox
        int revisionCount = contract.Rows.First(r => r.Kind == ArticleScaleRowKind.ArticleRevision).CountPerArticle;
        int publicationCount = contract.Rows.First(r => r.Kind == ArticleScaleRowKind.ArticlePublication).CountPerArticle;

        string? currentRevSemanticId = null;
        string? currentPubSemanticId = null;

        var revisionSemanticIds = new List<string>();
        var rightsSnapshotSemanticIds = new List<string>();
        var responsibilitySnapshotSemanticIds = new List<string>();

        for (int revNo = 1; revNo <= revisionCount; revNo++)
        {
            string revSemanticId = $"{prefix}:article/{articleOrdinal:D6}/revision/{revNo}";
            string contentBlockSemanticId = $"{prefix}:article/{articleOrdinal:D6}/revision/{revNo}/content/1";
            string rightsSnapSemanticId = $"{prefix}:article/{articleOrdinal:D6}/revision/{revNo}/rights/snapshot";
            string rightsProofSemanticId = $"{prefix}:article/{articleOrdinal:D6}/revision/{revNo}/rights/proof";
            string respSemanticId = $"{prefix}:article/{articleOrdinal:D6}/revision/{revNo}/responsibility";
            string taxonomySemanticId = $"{prefix}:article/{articleOrdinal:D6}/revision/{revNo}/taxonomy";

            revisionSemanticIds.Add(revSemanticId);
            rightsSnapshotSemanticIds.Add(rightsSnapSemanticId);
            responsibilitySnapshotSemanticIds.Add(respSemanticId);

            DateTime revCreatedAt = revNo == 1 ? rev1Time : rev2Time;
            string revTitle = revNo == 1 ? baseTitle : $"{baseTitle} (Revision {revNo})";

            // Rights snapshot using ArticleRightsSnapshotBuilder
            var (rightsSnapshot, contentCanonicalHash, policyHash) = ArticleRightsSnapshotBuilder.Build(
                articleId: articleOrdinal,
                revisionId: (articleOrdinal * 10) + revNo,
                revisionNo: revNo,
                policyId: articleOrdinal,
                title: revTitle,
                content: markdownContent,
                summary: summary,
                coverImageUrl: coverImageUrl,
                categoryId: categoryId,
                tagIds: tagIds,
                status: revNo == 1 && variant != ArticleScaleVariant.Scheduled ? ArticleStatus.Published : ArticleStatus.Draft,
                publishedAt: publishedTime,
                scheduledPublishAt: variant == ArticleScaleVariant.Scheduled ? boundaryTime : null,
                rights: normalizedRights,
                createdAt: revCreatedAt);

            // Responsibility snapshot using ArticleResponsibilitySnapshotBuilder
            var respDraft = new ArticleResponsibilityDraft(
                InheritSiteAuthor: false,
                Authors: [new ArticleResponsiblePerson($"Author {articleOrdinal}", $"https://example.internal/authors/author-{articleOrdinal}")],
                Reviewer: new ArticleResponsiblePerson("Lead Reviewer", "https://example.internal/reviewers/lead"),
                Sources: [new ArticleEvidenceSource("Primary Source", "https://data.example.internal/source", "verified", new DateOnly(2026, 7, 19), "1.0", "Citation note", true)],
                UpdateSummary: revNo == 1 ? "Initial publication" : "Scheduled update",
                UpdateReason: revNo == 1 ? "initial" : "routine-update",
                EffectiveAt: revCreatedAt,
                ConclusionImpact: "Neutral",
                Methodology: "Standard canonical data scale pipeline",
                Applicability: "General",
                Limitations: "None",
                ResponsiblePersonConfirmed: true,
                ContainsStrongClaims: false,
                IsSubstantiveUpdate: revNo > 1,
                RequiresMethodsDisclosure: false,
                ExpectedVersion: revNo);

            var respSnapshot = ArticleResponsibilitySnapshotBuilder.Build(
                articleId: articleOrdinal,
                revisionId: (articleOrdinal * 10) + revNo,
                revisionNo: revNo,
                responsibilityVersion: 1,
                previousSnapshotId: revNo == 1 ? null : (articleOrdinal * 10) + 1,
                draft: respDraft,
                createdAt: revCreatedAt);

            // Revision row
            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleRevision,
                revSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleId"] = articleOrdinal,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["RevisionNo"] = revNo,
                    ["Title"] = revTitle,
                    ["Summary"] = summary,
                    ["CoverImageUrl"] = coverImageUrl,
                    ["CategoryId"] = categoryId,
                    ["TagIds"] = string.Join(',', tagIds),
                    ["ContentBlockId"] = 1L,
                    ["ContentBlockSemanticId"] = contentBlockSemanticId,
                    ["MarkdownContent"] = string.Empty,
                    ["DiffSummary"] = revNo == 1 ? "Initial revision" : "Scheduled update revision",
                    ["CreatedByAdminPrincipalId"] = 1L,
                    ["RollbackSourceRevisionId"] = null,
                    ["RollbackReason"] = null,
                    ["ContentCanonicalHash"] = contentCanonicalHash,
                    ["RightsPolicyHash"] = policyHash,
                    ["RightsSnapshotSemanticId"] = rightsSnapSemanticId,
                    ["ResponsibilitySnapshotSemanticId"] = respSemanticId,
                    ["Status"] = revNo == 2 ? (int)ArticleStatus.Scheduled : (int)contract.TerminalStatus,
                    ["CreatedAt"] = revCreatedAt.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.RevisionToArticle, revSemanticId, articleSemanticId));

            // Content block row
            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleRevisionContentBlock,
                contentBlockSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["RevisionSemanticId"] = revSemanticId,
                    ["ContentHash"] = contentCanonicalHash,
                    ["ByteLength"] = Encoding.UTF8.GetByteCount(markdownContent),
                    ["BlockOrdinal"] = 1,
                    ["BlockType"] = "markdown",
                    ["Content"] = markdownContent,
                    ["MarkdownContent"] = markdownContent,
                    ["CreatedAt"] = revCreatedAt.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.ContentBlockToRevision, contentBlockSemanticId, revSemanticId));

            // Rights snapshot row
            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleRightsSnapshot,
                rightsSnapSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleId"] = articleOrdinal,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["ArticleRevisionId"] = (articleOrdinal * 10) + revNo,
                    ["ArticleRevisionSemanticId"] = revSemanticId,
                    ["RevisionSemanticId"] = revSemanticId,
                    ["RevisionNo"] = revNo,
                    ["ArticleRightsPolicyId"] = (long)articleOrdinal,
                    ["ArticleRightsPolicySemanticId"] = rightsPolicySemanticId,
                    ["Enabled"] = true,
                    ["LicenseType"] = normalizedRights.LicenseType,
                    ["CopyrightHolder"] = null,
                    ["CopyrightYear"] = null,
                    ["RightsStatement"] = null,
                    ["AttributionTemplate"] = null,
                    ["CopyPolicy"] = normalizedRights.CopyPolicy,
                    ["MaxExcerptChars"] = normalizedRights.MaxExcerptChars,
                    ["AllowCodeCopy"] = normalizedRights.AllowCodeCopy,
                    ["ShowPublicBadge"] = normalizedRights.ShowPublicBadge,
                    ["ProofBindingEnabled"] = normalizedRights.ProofBindingEnabled,
                    ["CanonicalUrl"] = null,
                    ["PolicyHash"] = policyHash,
                    ["ContentCanonicalHash"] = contentCanonicalHash,
                    ["CreatedAt"] = revCreatedAt.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.RevisionToRightsSnapshot, revSemanticId, rightsSnapSemanticId));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.RightsSnapshotToPolicy, rightsSnapSemanticId, rightsPolicySemanticId));

            // Rights proof row
            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleRightsProof,
                rightsProofSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["RightsSnapshotSemanticId"] = rightsSnapSemanticId,
                    ["ArticleId"] = articleOrdinal,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["ArticleRevisionId"] = (articleOrdinal * 10) + revNo,
                    ["ArticleRevisionSemanticId"] = revSemanticId,
                    ["RevisionSemanticId"] = revSemanticId,
                    ["RevisionNo"] = revNo,
                    ["ArticleRightsSnapshotId"] = (long)((articleOrdinal * 10) + revNo),
                    ["PublishProofId"] = null,
                    ["ProofVersion"] = 1,
                    ["SignaturePayloadVersion"] = 1,
                    ["IdempotencyKey"] = $"idemp-{articleOrdinal:D6}-{revNo}",
                    ["RightsPolicyHash"] = policyHash,
                    ["ContentCanonicalHash"] = contentCanonicalHash,
                    ["ProofStatus"] = "verified",
                    ["SigningKeyId"] = "key-canonical-1",
                    ["SigningKeyVersion"] = 1,
                    ["SigningAlgorithm"] = "Ed25519",
                    ["SignatureBase64Url"] = "sig-verified-canonical",
                    ["FailureCode"] = null,
                    ["FailureDetail"] = null,
                    ["TransparencyLogEntryId"] = null,
                    ["TransparencyLogEntryHash"] = null,
                    ["CreatedAt"] = revCreatedAt.ToString("O"),
                    ["UpdatedAt"] = revCreatedAt.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.RightsProofToSnapshot, rightsProofSemanticId, rightsSnapSemanticId));

            // Responsibility snapshot row
            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleResponsibilitySnapshot,
                respSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleId"] = articleOrdinal,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["ArticleRevisionId"] = (articleOrdinal * 10) + revNo,
                    ["ArticleRevisionSemanticId"] = revSemanticId,
                    ["RevisionSemanticId"] = revSemanticId,
                    ["RevisionNo"] = revNo,
                    ["ResponsibilityVersion"] = 1,
                    ["PreviousSnapshotId"] = revNo == 1 ? null : (long?)((articleOrdinal * 10) + 1),
                    ["InheritSiteAuthor"] = false,
                    ["AuthorsJson"] = respSnapshot.AuthorsJson,
                    ["ReviewerJson"] = respSnapshot.ReviewerJson,
                    ["SourcesJson"] = respSnapshot.SourcesJson,
                    ["UpdateSummary"] = respSnapshot.UpdateSummary,
                    ["UpdateReason"] = respSnapshot.UpdateReason,
                    ["EffectiveAt"] = respSnapshot.EffectiveAt?.ToString("O"),
                    ["ConclusionImpact"] = respSnapshot.ConclusionImpact,
                    ["Methodology"] = respSnapshot.Methodology,
                    ["Applicability"] = respSnapshot.Applicability,
                    ["Limitations"] = respSnapshot.Limitations,
                    ["ResponsiblePersonConfirmed"] = respSnapshot.ResponsiblePersonConfirmed,
                    ["CreatedAt"] = revCreatedAt.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.RevisionToResponsibilitySnapshot, revSemanticId, respSemanticId));

            // Taxonomy reference row
            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleTaxonomyReference,
                taxonomySemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["RevisionSemanticId"] = revSemanticId,
                    ["CategoryId"] = categoryId,
                    ["TagIds"] = tagIds
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.RevisionToTaxonomy, revSemanticId, taxonomySemanticId));

            currentRevSemanticId = revSemanticId;
        }

        // Publications
        if (publicationCount > 0)
        {
            string pubSemanticId = $"{prefix}:article/{articleOrdinal:D6}/publication/1";
            string pubRevId = revisionSemanticIds[0];
            string pubRightsId = rightsSnapshotSemanticIds[0];
            string pubRespId = responsibilitySnapshotSemanticIds[0];

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticlePublication,
                pubSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleId"] = articleOrdinal,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["PublicationNo"] = 1,
                    ["ArticleRevisionId"] = (articleOrdinal * 10) + 1,
                    ["ArticleRevisionSemanticId"] = pubRevId,
                    ["RevisionSemanticId"] = pubRevId,
                    ["RevisionNo"] = 1,
                    ["RightsSnapshotId"] = (articleOrdinal * 10) + 1,
                    ["RightsSnapshotSemanticId"] = pubRightsId,
                    ["ResponsibilitySnapshotId"] = (articleOrdinal * 10) + 1,
                    ["ResponsibilitySnapshotSemanticId"] = pubRespId,
                    ["TransitionKind"] = ArticlePublicationTransitionKinds.ImmediatePublish,
                    ["PublishedAt"] = publishedTime.ToString("O"),
                    ["CreatedAt"] = pub1Time.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.PublicationToRevision, pubSemanticId, pubRevId));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.PublicationToRightsSnapshot, pubSemanticId, pubRightsId));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.PublicationToResponsibilitySnapshot, pubSemanticId, pubRespId));

            currentPubSemanticId = pubSemanticId;
        }

        // Outbox events & Audit
        int eventNo = 1;
        foreach (ArticleScaleTransitionRequirement transition in contract.Transitions)
        {
            string outboxSemanticId = $"{prefix}:article/{articleOrdinal:D6}/outbox/{eventNo}";
            string auditSemanticId = $"{prefix}:article/{articleOrdinal:D6}/audit/{eventNo}";
            int targetRevNo = eventNo == 2 && revisionCount > 1 ? 2 : 1;
            string targetRevSemanticId = revisionSemanticIds[targetRevNo - 1];
            string targetRightsSemanticId = rightsSnapshotSemanticIds[targetRevNo - 1];
            string targetRespSemanticId = responsibilitySnapshotSemanticIds[targetRevNo - 1];

            DateTime occurred = eventNo switch
            {
                1 => publishedTime,
                2 when variant == ArticleScaleVariant.PublishedWithScheduledUpdate => commandTime,
                2 when variant == ArticleScaleVariant.Archived => occurredTime,
                2 when variant == ArticleScaleVariant.Deleted => occurredTime,
                _ => occurredTime
            };

            long revId = (articleOrdinal * 10) + targetRevNo;
            long rightsId = (articleOrdinal * 10) + targetRevNo;
            long respId = (articleOrdinal * 10) + targetRevNo;
            long? pubId = publicationCount > 0 ? (articleOrdinal * 10) + 1 : null;
            int? pubNo = publicationCount > 0 ? 1 : null;

            var versionCoordinates = new ArticleVersionCoordinates(
                RevisionId: revId,
                RevisionNo: targetRevNo,
                RightsSnapshotId: rightsId,
                ResponsibilitySnapshotId: respId,
                PublicationId: pubId,
                PublicationNo: pubNo,
                ResponsibilityVersion: 1);

            var scope = new ArticleMutationScopeSnapshot(
                categoryId,
                tagIds.ToArray(),
                ArticleMutationVisibility.From(contract.TerminalStatus, contract.IsDeleted));

            string payloadJson = ArticlePublicationTransitionWriter.BuildOutboxPayload(
                articleId: articleOrdinal,
                eventType: transition.OutboxEventType,
                version: versionCoordinates,
                before: eventNo == 1 ? null : scope,
                after: scope,
                occurredAt: occurred,
                publicUpdatedAt: variant == ArticleScaleVariant.Scheduled ? null : publishedTime);

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleMutationOutboxEnvelope,
                outboxSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["EventId"] = $"evt-{articleOrdinal:D6}-{eventNo}",
                    ["AggregateType"] = "article",
                    ["AggregateId"] = articleOrdinal,
                    ["AggregateSemanticId"] = articleSemanticId,
                    ["SchemaVersion"] = ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
                    ["EventType"] = transition.OutboxEventType,
                    ["ArticleRevisionId"] = revId,
                    ["RevisionNo"] = targetRevNo,
                    ["RightsSnapshotId"] = rightsId,
                    ["ResponsibilitySnapshotId"] = respId,
                    ["ResponsibilityVersion"] = 1,
                    ["ArticlePublicationId"] = pubId,
                    ["PublicationNo"] = pubNo,
                    ["RevisionSemanticId"] = targetRevSemanticId,
                    ["PublicationSemanticId"] = currentPubSemanticId,
                    ["RightsSnapshotSemanticId"] = targetRightsSemanticId,
                    ["ResponsibilitySnapshotSemanticId"] = targetRespSemanticId,
                    ["PayloadJson"] = payloadJson,
                    ["Status"] = "pending",
                    ["RetryCount"] = 0,
                    ["NextRetryAt"] = occurred.ToString("O"),
                    ["CreatedAt"] = occurred.ToString("O"),
                    ["ProcessedAt"] = null,
                    ["LastError"] = null,
                    ["ClaimToken"] = null,
                    ["ClaimedBy"] = null,
                    ["ClaimedAt"] = null,
                    ["HeartbeatAt"] = null,
                    ["ClaimExpiresAt"] = null
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.OutboxToRevision, outboxSemanticId, targetRevSemanticId));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.OutboxToRightsSnapshot, outboxSemanticId, targetRightsSemanticId));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.OutboxToResponsibilitySnapshot, outboxSemanticId, targetRespSemanticId));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.OutboxToRequiredEdges, outboxSemanticId, $"{prefix}:edges"));
            if (currentPubSemanticId is not null)
            {
                relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.OutboxToPublication, outboxSemanticId, currentPubSemanticId));
            }

            // Edges
            foreach (string edge in plan.Outbox.RequiredEdges)
            {
                string edgeSemanticId = $"{prefix}:article/{articleOrdinal:D6}/outbox/{eventNo}/edge/{edge}";
                rows.Add(new ArticleScaleRowPlan(
                    ArticleScaleRowKind.ArticleMutationOutboxEdge,
                    edgeSemanticId,
                    new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        ["OutboxEventId"] = 0L,
                        ["OutboxSemanticId"] = outboxSemanticId,
                        ["EdgeName"] = edge,
                        ["Required"] = true,
                        ["Status"] = "pending",
                        ["AttemptCount"] = 0,
                        ["NextRetryAt"] = occurred.ToString("O"),
                        ["ClaimToken"] = null,
                        ["ClaimedBy"] = null,
                        ["LastError"] = null,
                        ["ProcessedAt"] = null,
                        ["DeliveryKey"] = null,
                        ["CreatedAt"] = occurred.ToString("O"),
                        ["UpdatedAt"] = occurred.ToString("O")
                    }));
                edgeObligations.Add(new ArticleScaleEdgeObligationPlan(outboxSemanticId, edge));
            }

            // Audit
            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleAuditCoordinate,
                auditSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["OutboxSemanticId"] = outboxSemanticId,
                    ["TargetType"] = "article",
                    ["TargetSemanticId"] = articleSemanticId,
                    ["Action"] = transition.OutboxEventType,
                    ["ActorPrincipalId"] = 1L,
                    ["RecordHash"] = "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payloadJson))).ToLowerInvariant(),
                    ["CreatedAt"] = occurred.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.AuditToOutbox, auditSemanticId, outboxSemanticId));

            eventNo++;
        }

        // Pointers
        foreach (ArticleScalePointerRequirement pointer in contract.Pointers)
        {
            string targetId = pointer.SemanticTargetRole switch
            {
                "revision:1" => revisionSemanticIds[0],
                "revision:2" => revisionSemanticIds[1],
                "publication:1" => currentPubSemanticId!,
                ArticleScaleTemporalRoles.ArticlePublished => publishedTime.ToString("O"),
                ArticleScaleTemporalRoles.BoundaryTime => boundaryTime.ToString("O"),
                ArticleScaleTemporalRoles.Occurred => occurredTime.ToString("O"),
                _ => pointer.SemanticTargetRole
            };
            pointers.Add(new ArticleScalePointerPlan(pointer.Kind, targetId));
        }

        // 0. Article Row
        var articleFields = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["Title"] = baseTitle,
            ["Summary"] = summary,
            ["CoverImageUrl"] = coverImageUrl,
            ["CategoryId"] = categoryId,
            ["Views"] = 0,
            ["Status"] = (int)contract.TerminalStatus,
            ["IsDeleted"] = contract.IsDeleted,
            ["CreateTime"] = created.ToString("O"),
            ["MetadataUpdatedAt"] = (variant == ArticleScaleVariant.PublishedWithScheduledUpdate ? rev2Time : created).ToString("O"),
            ["PublishedAt"] = variant != ArticleScaleVariant.Scheduled ? publishedTime.ToString("O") : null,
            ["ScheduledPublishAt"] = variant == ArticleScaleVariant.Scheduled ? boundaryTime.ToString("O") : null,
            ["LastPublishedAt"] = variant != ArticleScaleVariant.Scheduled ? publishedTime.ToString("O") : null,
            ["PublicUpdatedAt"] = variant == ArticleScaleVariant.Scheduled ? null : (variant == ArticleScaleVariant.PublishedWithScheduledUpdate ? rev2Time.ToString("O") : publishedTime.ToString("O")),
            ["PendingPublicationAt"] = variant == ArticleScaleVariant.PublishedWithScheduledUpdate ? boundaryTime.ToString("O") : null,
            ["ArchivedAt"] = variant == ArticleScaleVariant.Archived ? occurredTime.ToString("O") : null,
            ["DeletedAt"] = variant == ArticleScaleVariant.Deleted ? occurredTime.ToString("O") : null,
            ["CurrentRevisionId"] = currentRevSemanticId,
            ["CurrentPublicationId"] = currentPubSemanticId
        };
        rows.Insert(0, new ArticleScaleRowPlan(ArticleScaleRowKind.Article, articleSemanticId, articleFields));

        string articleDigest = ComputeArticleDigest(articleSemanticId, variant, rows, relations, pointers);

        return new ArticleScaleArticleGraph(
            SemanticArticleId: articleSemanticId,
            ArticleOrdinal: articleOrdinal,
            Variant: variant,
            Rows: rows,
            Relations: relations,
            Pointers: pointers,
            EdgeObligations: edgeObligations,
            ArticleDigest: articleDigest);
    }

    public static string ComputeArticleDigest(
        string semanticArticleId,
        ArticleScaleVariant variant,
        IReadOnlyList<ArticleScaleRowPlan> rows,
        IReadOnlyList<ArticleScaleRelationPlan> relations,
        IReadOnlyList<ArticleScalePointerPlan> pointers)
    {
        var sb = new StringBuilder();
        sb.Append(semanticArticleId).Append('|').Append(variant).Append('|');
        foreach (ArticleScaleRowPlan row in rows)
        {
            sb.Append(row.Kind).Append(':').Append(row.SemanticId).Append('[');
            foreach (var kvp in row.Fields.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                sb.Append(kvp.Key).Append('=');
                if (kvp.Value is IEnumerable<int> intList)
                {
                    sb.Append(string.Join(',', intList));
                }
                else
                {
                    sb.Append(kvp.Value?.ToString() ?? "null");
                }
                sb.Append(';');
            }
            sb.Append("];");
        }
        sb.Append('|');
        foreach (ArticleScaleRelationPlan rel in relations)
        {
            sb.Append(rel.Kind).Append(':').Append(rel.SourceSemanticId).Append("->").Append(rel.TargetSemanticId).Append(';');
        }
        sb.Append('|');
        foreach (ArticleScalePointerPlan ptr in pointers)
        {
            sb.Append(ptr.Kind).Append(':').Append(ptr.TargetSemanticId).Append(';');
        }
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sb.ToString()))).ToLowerInvariant();
    }
}
