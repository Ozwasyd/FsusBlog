using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Services.Articles;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

public static class CanonicalArticleGraphFactory
{
    private static readonly DateTime s_baseEpoch = new(2026, 7, 19, 0, 0, 0, DateTimeKind.Utc);

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
        => BuildArticleGraph(plan, articleOrdinal, variant, contract, identities: null);

    public static ArticleScaleArticleGraph BuildArticleGraph(
        ArticleScalePlan plan,
        int articleOrdinal,
        ArticleScaleVariant variant,
        ArticleScaleVariantContract contract,
        ArticleScaleGraphIdentityBindings? identities)
    {
        string prefix = plan.IdAllocation.NamespacePrefix;
        string articleSemanticId = $"{prefix}:article/{articleOrdinal:D6}";
        string bodySemanticId = $"{prefix}:article/{articleOrdinal:D6}/body";
        string rightsPolicySemanticId = $"{prefix}:article/{articleOrdinal:D6}/rights/policy";
        string authoringAdminSemanticId = $"{prefix}:principal/authoring-admin";
        identities?.ValidateFor(plan, articleSemanticId);
        long Identity(string role, long diagnosticIdentity)
            => identities is null ? diagnosticIdentity : identities.Resolve(role);
        int articleId = checked((int)Identity(articleSemanticId, articleOrdinal));
        long policyId = Identity(rightsPolicySemanticId, articleOrdinal);

        IReadOnlyDictionary<string, DateTime> temporal = ResolveTemporalMap(articleOrdinal, contract);
        VariantLifecycleCoordinates lifecycle = DeriveLifecycleCoordinates(contract, temporal);

        string baseTitle = $"Canonical Article {articleOrdinal:D6}";
        string markdownContent = $"# Canonical Article {articleOrdinal:D6}\n\nDeterministic markdown body for article {articleOrdinal} variant {variant}.";
        ArticleRevisionContentAddress contentAddress = ArticleRevisionContentAddress.Compute(markdownContent);
        ArticleSummaryProjectionResult summaryProj = ArticleSummaryProjection.Resolve(null, markdownContent);
        string summary = summaryProj.Text;
        string coverImageUrl = $"https://cdn.example.internal/media/cover-{articleOrdinal:D6}.webp";
        int categoryId = (articleOrdinal % 5) + 1;
        List<int> tagIds = ArticleProductionNormalizers.NormalizeTagIds([(articleOrdinal % 10) + 1, ((articleOrdinal + 2) % 10) + 1]);

        var rows = new List<ArticleScaleRowPlan>();
        var relations = new List<ArticleScaleRelationPlan>();
        var pointers = new List<ArticleScalePointerPlan>();
        var edgeObligations = new List<ArticleScaleEdgeObligationPlan>();

        rows.Add(new ArticleScaleRowPlan(
            ArticleScaleRowKind.ArticleBody,
            bodySemanticId,
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ArticleId"] = articleId,
                ["ArticleSemanticId"] = articleSemanticId,
                ["MarkdownContent"] = markdownContent,
                ["UpdatedAt"] = temporal[ArticleScaleTemporalRoles.ArticleCreated].ToString("O")
            }));
        relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.BodyToArticle, bodySemanticId, articleSemanticId));

        var normalizedRights = ArticleProductionNormalizers.NormalizeArticleRights(null);
        rows.Add(new ArticleScaleRowPlan(
            ArticleScaleRowKind.ArticleRightsPolicy,
            rightsPolicySemanticId,
            new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["ArticleId"] = articleId,
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
                ["CreatedAt"] = temporal[ArticleScaleTemporalRoles.ArticleCreated].ToString("O"),
                ["UpdatedAt"] = temporal[ArticleScaleTemporalRoles.ArticleCreated].ToString("O")
            }));

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

            long revisionId = Identity(revSemanticId, (articleOrdinal * 10L) + revNo);
            long rightsSnapshotId = Identity(rightsSnapSemanticId, (articleOrdinal * 10L) + revNo);
            long? previousResponsibilityId = revNo == 1 ? null
                : Identity($"{prefix}:article/{articleOrdinal:D6}/revision/1/responsibility", (articleOrdinal * 10L) + 1);

            revisionSemanticIds.Add(revSemanticId);
            rightsSnapshotSemanticIds.Add(rightsSnapSemanticId);
            responsibilitySnapshotSemanticIds.Add(respSemanticId);

            DateTime revCreatedAt = revNo == 1
                ? temporal[ArticleScaleTemporalRoles.ArticleRevision]
                : temporal[ArticleScaleTemporalRoles.ArticleMetadataUpdated];
            string revTitle = revNo == 1 ? baseTitle : $"{baseTitle} (Revision {revNo})";
            ArticleStatus revisionStatus = ResolveRevisionStatus(contract, revNo);

            var (rightsSnapshot, contentCanonicalHash, policyHash) = ArticleRightsSnapshotBuilder.Build(
                articleId: articleId,
                revisionId: revisionId,
                revisionNo: revNo,
                policyId: policyId,
                title: revTitle,
                content: markdownContent,
                summary: summary,
                coverImageUrl: coverImageUrl,
                categoryId: categoryId,
                tagIds: tagIds,
                status: revisionStatus,
                publishedAt: lifecycle.PublishedAt,
                scheduledPublishAt: lifecycle.ScheduledPublishAt ?? lifecycle.PendingPublicationAt,
                rights: normalizedRights,
                createdAt: revCreatedAt);

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
                articleId: articleId,
                revisionId: revisionId,
                revisionNo: revNo,
                responsibilityVersion: 1,
                previousSnapshotId: previousResponsibilityId,
                draft: respDraft,
                createdAt: revCreatedAt);

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleRevision,
                revSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleId"] = articleId,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["RevisionNo"] = revNo,
                    ["Title"] = revTitle,
                    ["Summary"] = summary,
                    ["CoverImageUrl"] = coverImageUrl,
                    ["CategoryId"] = categoryId,
                    ["TagIds"] = string.Join(',', tagIds),
                    ["ContentBlockSemanticId"] = contentBlockSemanticId,
                    ["MarkdownContent"] = string.Empty,
                    ["DiffSummary"] = revNo == 1 ? "Initial revision" : "Scheduled update revision",
                    ["CreatedByAdminPrincipalSemanticId"] = authoringAdminSemanticId,
                    ["RollbackSourceRevisionId"] = null,
                    ["RollbackReason"] = null,
                    ["ContentCanonicalHash"] = contentCanonicalHash,
                    ["RightsPolicyHash"] = policyHash,
                    ["RightsSnapshotSemanticId"] = rightsSnapSemanticId,
                    ["ResponsibilitySnapshotSemanticId"] = respSemanticId,
                    ["Status"] = (int)revisionStatus,
                    ["CreatedAt"] = revCreatedAt.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.RevisionToArticle, revSemanticId, articleSemanticId));

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleRevisionContentBlock,
                contentBlockSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["RevisionSemanticId"] = revSemanticId,
                    ["ContentHash"] = contentAddress.ContentHash,
                    ["ByteLength"] = contentAddress.ByteLength,
                    ["BlockOrdinal"] = 1,
                    ["BlockType"] = "markdown",
                    ["Content"] = markdownContent,
                    ["MarkdownContent"] = markdownContent,
                    ["CreatedAt"] = temporal[ArticleScaleTemporalRoles.ArticleRevision].ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.ContentBlockToRevision, contentBlockSemanticId, revSemanticId));

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleRightsSnapshot,
                rightsSnapSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleId"] = articleId,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["ArticleRevisionId"] = revisionId,
                    ["ArticleRevisionSemanticId"] = revSemanticId,
                    ["RevisionSemanticId"] = revSemanticId,
                    ["RevisionNo"] = revNo,
                    ["ArticleRightsPolicyId"] = policyId,
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

            PublishProofPublicationState publicationState = MapPublicationState(revisionStatus, lifecycle);
            var proofInput = new ArticleRightsProofInput(
                ProofVersion: ArticleRightsProofCanonicalPayloadV1.ProofVersion,
                ArticleId: articleId,
                ArticleRevisionId: revisionId,
                RevisionNo: revNo,
                ArticleRightsSnapshotId: rightsSnapshotId,
                PublishProofId: null,
                RightsPolicyHash: policyHash,
                ContentCanonicalHash: contentCanonicalHash,
                IssuedAtUtc: new DateTimeOffset(revCreatedAt, TimeSpan.Zero),
                ProofStatus: PublishProofStatus.Pending,
                PublicationState: publicationState);
            ArticleRightsProofReadiness readiness = ArticleRightsProofReadiness.Evaluate(
                proofInput,
                rightsSnapshotAvailable: true,
                contentHashReady: true,
                publishProofReady: false);
            string proofStatusToken = ToProofStatusToken(readiness.Status);

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleRightsProof,
                rightsProofSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["RightsSnapshotSemanticId"] = rightsSnapSemanticId,
                    ["ArticleId"] = articleId,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["ArticleRevisionId"] = revisionId,
                    ["ArticleRevisionSemanticId"] = revSemanticId,
                    ["RevisionSemanticId"] = revSemanticId,
                    ["RevisionNo"] = revNo,
                    ["ArticleRightsSnapshotId"] = rightsSnapshotId,
                    ["PublishProofId"] = null,
                    ["ProofVersion"] = ArticleRightsProofCanonicalPayloadV1.ProofVersion,
                    ["SignaturePayloadVersion"] = ArticleRightsProofCanonicalPayloadV1.SignaturePayloadVersion,
                    ["IdempotencyKey"] = ArticleRightsProofIdempotency.BuildKey(
                        articleId,
                        revisionId,
                        ArticleRightsProofCanonicalPayloadV1.ProofVersion),
                    ["RightsPolicyHash"] = policyHash,
                    ["ContentCanonicalHash"] = contentCanonicalHash,
                    ["ProofStatus"] = proofStatusToken,
                    ["SigningKeyId"] = null,
                    ["SigningKeyVersion"] = null,
                    ["SigningAlgorithm"] = null,
                    ["SignatureBase64Url"] = null,
                    ["FailureCode"] = readiness.Status is PublishProofStatus.Failed ? readiness.Reason : null,
                    ["FailureDetail"] = null,
                    ["TransparencyLogEntryId"] = null,
                    ["TransparencyLogEntryHash"] = null,
                    ["CreatedAt"] = revCreatedAt.ToString("O"),
                    ["UpdatedAt"] = revCreatedAt.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.RightsProofToSnapshot, rightsProofSemanticId, rightsSnapSemanticId));

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleResponsibilitySnapshot,
                respSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleId"] = articleId,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["ArticleRevisionId"] = revisionId,
                    ["ArticleRevisionSemanticId"] = revSemanticId,
                    ["RevisionSemanticId"] = revSemanticId,
                    ["RevisionNo"] = revNo,
                    ["ResponsibilityVersion"] = 1,
                    ["PreviousSnapshotId"] = previousResponsibilityId,
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

        if (publicationCount > 0)
        {
            if (!lifecycle.HasPublication
                || lifecycle.PublicationTransitionKind is null
                || lifecycle.PublicationPublishedAt is null)
            {
                throw new InvalidOperationException(
                    $"variant {variant} requires a publication row but CreatePlan did not create one.");
            }

            string pubSemanticId = $"{prefix}:article/{articleOrdinal:D6}/publication/1";
            string pubRevId = revisionSemanticIds[0];
            string pubRightsId = rightsSnapshotSemanticIds[0];
            string pubRespId = responsibilitySnapshotSemanticIds[0];

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticlePublication,
                pubSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["ArticleId"] = articleId,
                    ["ArticleSemanticId"] = articleSemanticId,
                    ["PublicationNo"] = 1,
                    ["ArticleRevisionId"] = Identity(pubRevId, (articleOrdinal * 10L) + 1),
                    ["ArticleRevisionSemanticId"] = pubRevId,
                    ["RevisionSemanticId"] = pubRevId,
                    ["RevisionNo"] = 1,
                    ["RightsSnapshotId"] = Identity(pubRightsId, (articleOrdinal * 10L) + 1),
                    ["RightsSnapshotSemanticId"] = pubRightsId,
                    ["ResponsibilitySnapshotId"] = Identity(pubRespId, (articleOrdinal * 10L) + 1),
                    ["ResponsibilitySnapshotSemanticId"] = pubRespId,
                    ["TransitionKind"] = lifecycle.PublicationTransitionKind,
                    ["PublishedAt"] = lifecycle.PublicationPublishedAt.Value.ToString("O"),
                    ["CreatedAt"] = temporal[ArticleScaleTemporalRoles.ArticlePublication].ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.PublicationToRevision, pubSemanticId, pubRevId));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.PublicationToRightsSnapshot, pubSemanticId, pubRightsId));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.PublicationToResponsibilitySnapshot, pubSemanticId, pubRespId));

            currentPubSemanticId = pubSemanticId;
        }

        for (int eventIndex = 0; eventIndex < contract.Transitions.Count; eventIndex++)
        {
            ArticleScaleTransitionRequirement transition = contract.Transitions[eventIndex];
            ArticleScaleOutboxEventRequirement outboxReq = contract.OutboxEvents[eventIndex];
            int eventNo = eventIndex + 1;
            string outboxSemanticId = $"{prefix}:article/{articleOrdinal:D6}/outbox/{eventNo}";
            string auditSemanticId = $"{prefix}:article/{articleOrdinal:D6}/audit/{eventNo}";
            int targetRevNo = outboxReq.RevisionOrdinal;
            string targetRevSemanticId = revisionSemanticIds[targetRevNo - 1];
            string targetRightsSemanticId = rightsSnapshotSemanticIds[targetRevNo - 1];
            string targetRespSemanticId = responsibilitySnapshotSemanticIds[targetRevNo - 1];

            DateTime occurred = temporal[transition.OccurredAtRole];

            long revId = Identity(targetRevSemanticId, (articleOrdinal * 10L) + targetRevNo);
            long rightsId = Identity(targetRightsSemanticId, (articleOrdinal * 10L) + targetRevNo);
            long respId = Identity(targetRespSemanticId, (articleOrdinal * 10L) + targetRevNo);
            long? pubId = publicationCount > 0 ? Identity(currentPubSemanticId!, (articleOrdinal * 10L) + 1) : null;
            int? pubNo = publicationCount > 0 ? 1 : null;

            var versionCoordinates = new ArticleVersionCoordinates(
                RevisionId: revId,
                RevisionNo: targetRevNo,
                RightsSnapshotId: rightsId,
                ResponsibilitySnapshotId: respId,
                PublicationId: pubId,
                PublicationNo: pubNo,
                ResponsibilityVersion: 1);

            ArticleStatus afterStatus = eventIndex == contract.Transitions.Count - 1
                ? lifecycle.StoredStatus
                : transition.TargetStatus == ArticleStatus.Scheduled && lifecycle.HasPublication
                    ? ArticleStatus.Published
                    : transition.TargetStatus;
            bool afterDeleted = afterStatus == ArticleStatus.Deleted || (eventIndex == contract.Transitions.Count - 1 && contract.IsDeleted);
            var scope = new ArticleMutationScopeSnapshot(
                categoryId,
                tagIds.ToArray(),
                ArticleMutationVisibility.From(afterDeleted ? ArticleStatus.Deleted : afterStatus, afterDeleted));

            string payloadJson = ArticlePublicationTransitionWriter.BuildOutboxPayload(
                articleId: articleId,
                eventType: transition.OutboxEventType,
                version: versionCoordinates,
                before: eventIndex == 0 ? null : scope,
                after: scope,
                occurredAt: occurred,
                publicUpdatedAt: lifecycle.PublicUpdatedAt);

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleMutationOutboxEnvelope,
                outboxSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["EventId"] = $"evt-{articleOrdinal:D6}-{eventNo}",
                    ["AggregateType"] = "article",
                    ["AggregateId"] = articleId,
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

            foreach (string edge in plan.Outbox.RequiredEdges)
            {
                string edgeSemanticId = $"{prefix}:article/{articleOrdinal:D6}/outbox/{eventNo}/edge/{edge}";
                rows.Add(new ArticleScaleRowPlan(
                    ArticleScaleRowKind.ArticleMutationOutboxEdge,
                    edgeSemanticId,
                    new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        ["OutboxEventId"] = Identity(outboxSemanticId, 0L),
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

            rows.Add(new ArticleScaleRowPlan(
                ArticleScaleRowKind.ArticleAuditCoordinate,
                auditSemanticId,
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["OutboxSemanticId"] = outboxSemanticId,
                    ["TargetType"] = "article",
                    ["TargetSemanticId"] = articleSemanticId,
                    ["Action"] = transition.OutboxEventType,
                    ["ActorPrincipalSemanticId"] = authoringAdminSemanticId,
                    ["RecordHash"] = "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payloadJson))).ToLowerInvariant(),
                    ["CreatedAt"] = occurred.ToString("O")
                }));
            relations.Add(new ArticleScaleRelationPlan(ArticleScaleRelationKind.AuditToOutbox, auditSemanticId, outboxSemanticId));
        }

        foreach (ArticleScalePointerRequirement pointer in contract.Pointers)
        {
            string targetId = pointer.SemanticTargetRole switch
            {
                "revision:1" => revisionSemanticIds[0],
                "revision:2" => revisionSemanticIds[1],
                "publication:1" => currentPubSemanticId!,
                _ when temporal.TryGetValue(pointer.SemanticTargetRole, out DateTime instant)
                    => instant.ToString("O"),
                _ => pointer.SemanticTargetRole
            };
            pointers.Add(new ArticleScalePointerPlan(pointer.Kind, targetId));
        }

        DateTime created = temporal[ArticleScaleTemporalRoles.ArticleCreated];
        DateTime metadataUpdatedAt = revisionCount > 1
            ? temporal[ArticleScaleTemporalRoles.ArticleMetadataUpdated]
            : created;

        var articleFields = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["Title"] = baseTitle,
            ["Summary"] = summary,
            ["CoverImageUrl"] = coverImageUrl,
            ["CategoryId"] = categoryId,
            ["Views"] = 0,
            ["Status"] = (int)lifecycle.StoredStatus,
            ["IsDeleted"] = lifecycle.IsDeleted,
            ["CreateTime"] = created.ToString("O"),
            ["MetadataUpdatedAt"] = metadataUpdatedAt.ToString("O"),
            ["PublishedAt"] = lifecycle.PublishedAt?.ToString("O"),
            ["ScheduledPublishAt"] = lifecycle.ScheduledPublishAt?.ToString("O"),
            ["LastPublishedAt"] = lifecycle.LastPublishedAt?.ToString("O"),
            ["PublicUpdatedAt"] = lifecycle.PublicUpdatedAt?.ToString("O"),
            ["PendingPublicationAt"] = lifecycle.PendingPublicationAt?.ToString("O"),
            ["ArchivedAt"] = lifecycle.ArchivedAt?.ToString("O"),
            ["DeletedAt"] = lifecycle.DeletedAt?.ToString("O"),
            ["CurrentRevisionId"] = currentRevSemanticId,
            ["CurrentPublicationId"] = currentPubSemanticId
        };
        rows.Insert(0, new ArticleScaleRowPlan(ArticleScaleRowKind.Article, articleSemanticId, articleFields));

        if (identities is not null)
        {
            // Bind row identities here, after all dependent builders have consumed their native
            // coordinates, and before sealing the final graph. Logical audit/taxonomy refs and
            // the article-keyed body do not have independent generated identities.
            var required = new HashSet<string>(StringComparer.Ordinal);
            foreach (ArticleScaleRowPlan row in rows)
            {
                if (row.Kind is ArticleScaleRowKind.ArticleBody or ArticleScaleRowKind.ArticleTaxonomyReference
                    or ArticleScaleRowKind.ArticleAuditCoordinate)
                {
                    continue;
                }
                required.Add(row.SemanticId);
                long id = identities.Resolve(row.SemanticId);
                var fields = (Dictionary<string, object?>)row.Fields;
                fields["Id"] = row.Kind == ArticleScaleRowKind.Article ? (object)checked((int)id) : id;
            }
            if (!required.SetEquals(identities.Ids.Keys))
            {
                throw new InvalidOperationException("identity_role_set_mismatch");
            }
            foreach (IGrouping<ArticleScaleRowKind, ArticleScaleRowPlan> kind in rows.Where(
                row => required.Contains(row.SemanticId)).GroupBy(row => row.Kind))
            {
                foreach (IGrouping<long, ArticleScaleRowPlan> duplicate in kind.GroupBy(row => identities.Resolve(row.SemanticId)))
                {
                    if (duplicate.Count() > 1 && (kind.Key != ArticleScaleRowKind.ArticleRevisionContentBlock
                        || duplicate.Select(row => row.Fields["ContentHash"]).Distinct().Count() != 1))
                    {
                        throw new InvalidOperationException("identity_duplicate_native_id");
                    }
                }
            }
            foreach (IGrouping<object?, ArticleScaleRowPlan> aliases in rows.Where(
                row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock).GroupBy(row => row.Fields["ContentHash"]))
            {
                if (aliases.Select(row => identities.Resolve(row.SemanticId)).Distinct().Count() != 1)
                {
                    throw new InvalidOperationException("identity_content_alias_mismatch");
                }
            }
            articleFields["CurrentRevisionId"] = currentRevSemanticId is null ? null : identities.Resolve(currentRevSemanticId);
            articleFields["CurrentPublicationId"] = currentPubSemanticId is null ? null : identities.Resolve(currentPubSemanticId);
        }
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

    internal static IReadOnlyDictionary<string, DateTime> ResolveTemporalMap(
        int articleOrdinal,
        ArticleScaleVariantContract contract)
    {
        DateTime created = s_baseEpoch.AddMinutes(articleOrdinal * 10);
        DateTime revision = created.AddMinutes(1);
        DateTime publication = revision.AddMinutes(1);
        DateTime published = publication;
        DateTime metadataUpdated = published.AddHours(2);
        DateTime commandTime = published.AddHours(3);
        DateTime boundaryTime = commandTime.AddDays(7);
        DateTime occurred = published.AddDays(1);

        var map = new Dictionary<string, DateTime>(StringComparer.Ordinal)
        {
            [ArticleScaleTemporalRoles.ArticleCreated] = created,
            [ArticleScaleTemporalRoles.ArticleRevision] = revision,
            [ArticleScaleTemporalRoles.ArticlePublication] = publication,
            [ArticleScaleTemporalRoles.ArticlePublished] = published,
            [ArticleScaleTemporalRoles.ArticleMetadataUpdated] = metadataUpdated,
            [ArticleScaleTemporalRoles.CommandTime] = commandTime,
            [ArticleScaleTemporalRoles.BoundaryTime] = boundaryTime,
            [ArticleScaleTemporalRoles.Occurred] = occurred
        };

        foreach (ArticleScaleTemporalRequirement role in contract.TemporalRoles)
        {
            if (!map.ContainsKey(role.RoleId))
            {
                throw new InvalidOperationException($"Temporal role '{role.RoleId}' is not resolved for variant {contract.Variant}.");
            }
        }

        return map;
    }

    internal static VariantLifecycleCoordinates DeriveLifecycleCoordinates(
        ArticleScaleVariantContract contract,
        IReadOnlyDictionary<string, DateTime> temporal)
    {
        bool hasCurrentPublication = false;
        ArticleStatus storedStatus = ArticleStatus.Draft;
        DateTime? scheduledPublishAt = null;
        DateTime? pendingPublicationAt = null;
        DateTime? publishedAt = null;
        DateTime? lastPublishedAt = null;
        DateTime? publicUpdatedAt = null;
        DateTime? archivedAt = null;
        DateTime? deletedAt = null;
        string? publicationTransitionKind = null;
        DateTime? publicationPublishedAt = null;
        bool isDeleted = false;

        foreach (ArticleScaleTransitionRequirement transition in contract.Transitions)
        {
            DateTime occurredAt = temporal[transition.OccurredAtRole];
            DateTime? scheduledAt = transition.ScheduledAtRole is null
                ? null
                : temporal[transition.ScheduledAtRole];

            // Soft-delete is outside ArticlePublicationTransitionWriter.CreatePlan
            // (ValidateTarget rejects Deleted). Mirror LifecycleAndReadModels delete SQL.
            if (transition.TargetStatus == ArticleStatus.Deleted
                || string.Equals(transition.TransitionKind, "article-delete-flow", StringComparison.Ordinal))
            {
                storedStatus = ArticleStatus.Deleted;
                isDeleted = true;
                deletedAt = occurredAt;
                continue;
            }

            ArticlePublicationTransitionPlan plan = ArticlePublicationTransitionWriter.CreatePlan(
                hasCurrentPublication,
                transition.TargetStatus,
                scheduledAt,
                occurredAt);

            storedStatus = plan.StoredStatus;
            scheduledPublishAt = plan.ScheduledPublishAt;
            pendingPublicationAt = plan.PendingPublicationAt;
            archivedAt = plan.ArchivedAt;
            if (plan.PublishedAt.HasValue)
            {
                publishedAt ??= plan.PublishedAt;
            }

            if (plan.CreatePublication)
            {
                hasCurrentPublication = true;
                publicationTransitionKind = transition.TransitionKind;
                publicationPublishedAt = occurredAt;
                lastPublishedAt = plan.PublishedAt ?? occurredAt;
                publicUpdatedAt = occurredAt;
            }
        }

        if (contract.IsDeleted)
        {
            isDeleted = true;
            storedStatus = ArticleStatus.Deleted;
            deletedAt ??= temporal[ArticleScaleTemporalRoles.Occurred];
        }

        if (storedStatus != contract.TerminalStatus)
        {
            throw new InvalidOperationException(
                $"CreatePlan-derived status '{storedStatus}' diverges from catalog terminal status '{contract.TerminalStatus}' for variant {contract.Variant}.");
        }

        return new VariantLifecycleCoordinates(
            StoredStatus: storedStatus,
            IsDeleted: isDeleted || contract.IsDeleted,
            HasPublication: hasCurrentPublication,
            ScheduledPublishAt: scheduledPublishAt,
            PendingPublicationAt: pendingPublicationAt,
            PublishedAt: publishedAt,
            LastPublishedAt: lastPublishedAt,
            PublicUpdatedAt: publicUpdatedAt,
            ArchivedAt: archivedAt,
            DeletedAt: deletedAt,
            PublicationTransitionKind: publicationTransitionKind,
            PublicationPublishedAt: publicationPublishedAt);
    }

    private static ArticleStatus ResolveRevisionStatus(ArticleScaleVariantContract contract, int revNo)
    {
        if (revNo == 2 && contract.RetainsPriorPublicationWhileScheduled)
        {
            return ArticleStatus.Scheduled;
        }

        if (contract.Variant == ArticleScaleVariant.Scheduled)
        {
            return ArticleStatus.Scheduled;
        }

        // First revision is created through the publish/create transition when history is retained.
        if (contract.RetainsPublicationHistory || contract.Variant == ArticleScaleVariant.Published)
        {
            return ArticleStatus.Published;
        }

        return contract.TerminalStatus;
    }

    private static PublishProofPublicationState MapPublicationState(
        ArticleStatus revisionStatus,
        VariantLifecycleCoordinates lifecycle)
    {
        if (lifecycle.IsDeleted)
        {
            return PublishProofPublicationState.Deleted;
        }

        return revisionStatus switch
        {
            ArticleStatus.Published => PublishProofPublicationState.Public,
            ArticleStatus.Scheduled => PublishProofPublicationState.Scheduled,
            ArticleStatus.Archived => PublishProofPublicationState.Archived,
            ArticleStatus.Deleted => PublishProofPublicationState.Deleted,
            _ => PublishProofPublicationState.Draft
        };
    }

    private static string ToProofStatusToken(PublishProofStatus status)
        => status switch
        {
            PublishProofStatus.Pending => "pending",
            PublishProofStatus.Ready => "ready",
            PublishProofStatus.Failed => "failed",
            PublishProofStatus.Retrying => "retrying",
            PublishProofStatus.Superseded => "superseded",
            PublishProofStatus.NotPublic => "not-public",
            _ => throw new ArgumentOutOfRangeException(nameof(status), status, "Unsupported proof status.")
        };

    internal readonly record struct VariantLifecycleCoordinates(
        ArticleStatus StoredStatus,
        bool IsDeleted,
        bool HasPublication,
        DateTime? ScheduledPublishAt,
        DateTime? PendingPublicationAt,
        DateTime? PublishedAt,
        DateTime? LastPublishedAt,
        DateTime? PublicUpdatedAt,
        DateTime? ArchivedAt,
        DateTime? DeletedAt,
        string? PublicationTransitionKind,
        DateTime? PublicationPublishedAt);
}
