using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

public static class ArticleScaleContractVersions
{
    public const string PlanSchema = "fsusblog.article-scale-plan.v1";
    public const string GraphSchema = "fsusblog.article-scale-graph.v1";
    public const string Factory = "fsusblog.canonical-article-graph-factory.v1";
    public const string SemanticIdPolicy = "fsusblog.article-scale-semantic-id.v1";
}

public enum ArticleScaleVariant
{
    Published,
    Scheduled,
    PublishedWithScheduledUpdate,
    Archived,
    Deleted
}

public enum ArticleScaleRowKind
{
    Article,
    ArticleBody,
    ArticleRevision,
    ArticleRevisionContentBlock,
    ArticleRightsPolicy,
    ArticleRightsSnapshot,
    ArticleRightsProof,
    ArticleResponsibilitySnapshot,
    ArticlePublication,
    ArticleMutationOutbox,
    ArticleMutationOutboxEdge,
    AuditCoordinate
}

public enum ArticleScaleRelationKind
{
    ArticleBody,
    CurrentRevision,
    RevisionContentBlock,
    RevisionRightsSnapshot,
    RightsPolicySnapshot,
    RightsSnapshotProof,
    RevisionResponsibilitySnapshot,
    CurrentPublication,
    PublicationRevision,
    PublicationRightsSnapshot,
    PublicationResponsibilitySnapshot,
    OutboxRevision,
    OutboxPublication,
    OutboxRightsSnapshot,
    OutboxResponsibilitySnapshot,
    OutboxEdges,
    AuditMutation
}

public enum ArticleScalePointerKind
{
    CurrentRevision,
    CurrentPublication,
    ScheduledPublishAt,
    PendingPublicationAt,
    PublishedAt,
    ArchivedAt,
    DeletedAt
}

public sealed record ArticleScaleArtifactReference(
    string CatalogId,
    string ArtifactId,
    string ContentDigest);

public sealed record ArticleScaleArtifactBindings(
    ArticleScaleArtifactReference Temporal,
    IReadOnlyList<ArticleScaleArtifactReference> Content,
    IReadOnlyList<ArticleScaleArtifactReference> Media,
    IReadOnlyList<ArticleScaleArtifactReference> Taxonomy);

public sealed record ArticleScaleSemanticIdPolicy(
    string PolicyId,
    string NamespacePrefix);

public sealed record ArticleScaleTransitionContract(
    ArticleStatusTransitionOperation? Operation,
    ArticleStatus TargetStatus,
    string TransitionKind,
    string OccurredAtRole,
    string? ScheduledAtRole = null);

public sealed record ArticleScaleRowRequirement(
    ArticleScaleRowKind Kind,
    int CountPerArticle);

public sealed record ArticleScaleVariantContract(
    ArticleScaleVariant Variant,
    IReadOnlyList<ArticleScaleTransitionContract> Transitions,
    IReadOnlyList<ArticleScaleRowRequirement> Rows,
    IReadOnlyList<ArticleScaleRelationKind> Relations,
    IReadOnlyList<ArticleScalePointerKind> RequiredPointers,
    IReadOnlyList<string> OutboxEdgeObligations,
    bool RetainsPublicationHistory,
    bool IsDeleted);

public sealed record ArticleScaleVariantAllocation(
    ArticleScaleVariant Variant,
    int Count,
    ArticleScaleVariantContract Contract);

public sealed record ArticleScaleExpectedRowCount(
    ArticleScaleRowKind Kind,
    long Count);

public sealed record ArticleScalePostconditions(
    IReadOnlyList<ArticleScaleExpectedRowCount> ExpectedRows,
    int ExpectedOrphans,
    IReadOnlyList<string> RequiredInvariants);

public sealed record ArticleScalePlan(
    string Schema,
    string GraphSchema,
    string FactoryVersion,
    string ScaleTier,
    string Namespace,
    int ArticleCount,
    IReadOnlyList<ArticleScaleVariantAllocation> StateDistribution,
    ArticleScaleArtifactBindings Artifacts,
    ArticleScaleSemanticIdPolicy IdAllocation,
    ArticleScalePostconditions Postconditions,
    string ContentDigest);

public sealed record ArticleScalePlanValidationResult(
    bool IsValid,
    IReadOnlyList<string> Errors)
{
    public void ThrowIfInvalid()
    {
        if (!IsValid)
        {
            throw new InvalidOperationException(string.Join("; ", Errors));
        }
    }
}

public static class ArticleScaleVariantContractCatalog
{
    private static readonly IReadOnlyDictionary<ArticleScaleVariant, ArticleScaleVariantContract> s_contracts
        = BuildContracts();

    public static IReadOnlyList<ArticleScaleVariant> Variants { get; } = Enum.GetValues<ArticleScaleVariant>();

    public static ArticleScaleVariantContract Get(ArticleScaleVariant variant)
        => s_contracts.TryGetValue(variant, out ArticleScaleVariantContract? contract)
            ? contract
            : throw new ArgumentOutOfRangeException(nameof(variant), variant, "Article scale variant is not defined.");

    private static IReadOnlyDictionary<ArticleScaleVariant, ArticleScaleVariantContract> BuildContracts()
    {
        string[] requiredEdges = [.. ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal)];
        return new Dictionary<ArticleScaleVariant, ArticleScaleVariantContract>
        {
            [ArticleScaleVariant.Published] = Contract(
                ArticleScaleVariant.Published,
                [Transition(ArticleStatusTransitionOperation.Create, ArticleStatus.Published,
                    ArticlePublicationTransitionKinds.ImmediatePublish, "article.published")],
                revisions: 1,
                publications: 1,
                outboxEvents: 1,
                [ArticleScalePointerKind.CurrentRevision, ArticleScalePointerKind.CurrentPublication,
                    ArticleScalePointerKind.PublishedAt],
                requiredEdges,
                retainsPublicationHistory: true),
            [ArticleScaleVariant.Scheduled] = Contract(
                ArticleScaleVariant.Scheduled,
                [Transition(ArticleStatusTransitionOperation.Create, ArticleStatus.Scheduled,
                    ArticlePublicationTransitionKinds.Schedule, "article.created", "article.scheduled")],
                revisions: 1,
                publications: 0,
                outboxEvents: 1,
                [ArticleScalePointerKind.CurrentRevision, ArticleScalePointerKind.ScheduledPublishAt],
                requiredEdges,
                retainsPublicationHistory: false),
            [ArticleScaleVariant.PublishedWithScheduledUpdate] = Contract(
                ArticleScaleVariant.PublishedWithScheduledUpdate,
                [
                    Transition(ArticleStatusTransitionOperation.Create, ArticleStatus.Published,
                        ArticlePublicationTransitionKinds.ImmediatePublish, "article.published"),
                    Transition(ArticleStatusTransitionOperation.Update, ArticleStatus.Scheduled,
                        ArticlePublicationTransitionKinds.Schedule, "article.revision.updated", "article.scheduled")
                ],
                revisions: 2,
                publications: 1,
                outboxEvents: 2,
                [ArticleScalePointerKind.CurrentRevision, ArticleScalePointerKind.CurrentPublication,
                    ArticleScalePointerKind.PublishedAt, ArticleScalePointerKind.PendingPublicationAt],
                requiredEdges,
                retainsPublicationHistory: true),
            [ArticleScaleVariant.Archived] = Contract(
                ArticleScaleVariant.Archived,
                [
                    Transition(ArticleStatusTransitionOperation.Create, ArticleStatus.Published,
                        ArticlePublicationTransitionKinds.ImmediatePublish, "article.published"),
                    Transition(ArticleStatusTransitionOperation.Update, ArticleStatus.Archived,
                        ArticlePublicationTransitionKinds.Archive, "article.archived")
                ],
                revisions: 1,
                publications: 1,
                outboxEvents: 2,
                [ArticleScalePointerKind.CurrentRevision, ArticleScalePointerKind.CurrentPublication,
                    ArticleScalePointerKind.PublishedAt, ArticleScalePointerKind.ArchivedAt],
                requiredEdges,
                retainsPublicationHistory: true),
            [ArticleScaleVariant.Deleted] = Contract(
                ArticleScaleVariant.Deleted,
                [
                    Transition(ArticleStatusTransitionOperation.Create, ArticleStatus.Published,
                        ArticlePublicationTransitionKinds.ImmediatePublish, "article.published"),
                    Transition(null, ArticleStatus.Deleted,
                        ArticleMutationEventTypes.Deleted, "article.deleted")
                ],
                revisions: 1,
                publications: 1,
                outboxEvents: 2,
                [ArticleScalePointerKind.CurrentRevision, ArticleScalePointerKind.CurrentPublication,
                    ArticleScalePointerKind.PublishedAt, ArticleScalePointerKind.DeletedAt],
                requiredEdges,
                retainsPublicationHistory: true,
                isDeleted: true)
        };
    }

    private static ArticleScaleTransitionContract Transition(
        ArticleStatusTransitionOperation? operation,
        ArticleStatus targetStatus,
        string transitionKind,
        string occurredAtRole,
        string? scheduledAtRole = null)
        => new(operation, targetStatus, transitionKind, occurredAtRole, scheduledAtRole);

    private static ArticleScaleVariantContract Contract(
        ArticleScaleVariant variant,
        IReadOnlyList<ArticleScaleTransitionContract> transitions,
        int revisions,
        int publications,
        int outboxEvents,
        IReadOnlyList<ArticleScalePointerKind> pointers,
        IReadOnlyList<string> edgeObligations,
        bool retainsPublicationHistory,
        bool isDeleted = false)
    {
        var rows = new List<ArticleScaleRowRequirement>
        {
            new(ArticleScaleRowKind.Article, 1),
            new(ArticleScaleRowKind.ArticleBody, 1),
            new(ArticleScaleRowKind.ArticleRevision, revisions),
            new(ArticleScaleRowKind.ArticleRevisionContentBlock, revisions),
            new(ArticleScaleRowKind.ArticleRightsPolicy, 1),
            new(ArticleScaleRowKind.ArticleRightsSnapshot, revisions),
            new(ArticleScaleRowKind.ArticleRightsProof, revisions),
            new(ArticleScaleRowKind.ArticleResponsibilitySnapshot, revisions),
            new(ArticleScaleRowKind.ArticlePublication, publications),
            new(ArticleScaleRowKind.ArticleMutationOutbox, outboxEvents),
            new(ArticleScaleRowKind.ArticleMutationOutboxEdge, checked(outboxEvents * edgeObligations.Count)),
            new(ArticleScaleRowKind.AuditCoordinate, outboxEvents)
        };
        var relations = new List<ArticleScaleRelationKind>
        {
            ArticleScaleRelationKind.ArticleBody,
            ArticleScaleRelationKind.CurrentRevision,
            ArticleScaleRelationKind.RevisionContentBlock,
            ArticleScaleRelationKind.RevisionRightsSnapshot,
            ArticleScaleRelationKind.RightsPolicySnapshot,
            ArticleScaleRelationKind.RightsSnapshotProof,
            ArticleScaleRelationKind.RevisionResponsibilitySnapshot,
            ArticleScaleRelationKind.OutboxRevision,
            ArticleScaleRelationKind.OutboxRightsSnapshot,
            ArticleScaleRelationKind.OutboxResponsibilitySnapshot,
            ArticleScaleRelationKind.OutboxEdges,
            ArticleScaleRelationKind.AuditMutation
        };
        if (publications > 0)
        {
            relations.AddRange([
                ArticleScaleRelationKind.CurrentPublication,
                ArticleScaleRelationKind.PublicationRevision,
                ArticleScaleRelationKind.PublicationRightsSnapshot,
                ArticleScaleRelationKind.PublicationResponsibilitySnapshot,
                ArticleScaleRelationKind.OutboxPublication
            ]);
        }

        return new(
            variant,
            transitions,
            rows,
            relations,
            pointers,
            edgeObligations,
            retainsPublicationHistory,
            isDeleted);
    }
}

public static class ArticleScalePlanBuilder
{
    private static readonly IReadOnlyDictionary<string, int> s_tierArticleCounts
        = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["scale-xs"] = 1,
            ["scale-s"] = 100,
            ["scale-m"] = 10_000,
            ["scale-l-nightly"] = 100_000
        };

    internal static bool TryGetArticleCount(string scaleTier, out int articleCount)
        => s_tierArticleCounts.TryGetValue(scaleTier, out articleCount);

    public static ArticleScalePlan Create(
        string scaleTier,
        string @namespace,
        IReadOnlyDictionary<ArticleScaleVariant, int> distribution,
        ArticleScaleArtifactBindings artifacts)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(scaleTier);
        ArgumentException.ThrowIfNullOrWhiteSpace(@namespace);
        ArgumentNullException.ThrowIfNull(distribution);
        ArgumentNullException.ThrowIfNull(artifacts);
        if (!TryGetArticleCount(scaleTier, out int articleCount))
        {
            throw new ArgumentException($"Unknown data-scale tier {scaleTier}.", nameof(scaleTier));
        }
        if (distribution.Count != ArticleScaleVariantContractCatalog.Variants.Count
            || distribution.Keys.Any(static variant => !Enum.IsDefined(variant))
            || !ArticleScaleVariantContractCatalog.Variants.All(distribution.ContainsKey))
        {
            throw new ArgumentException(
                "State distribution must declare every closed lifecycle variant exactly once.",
                nameof(distribution));
        }

        var allocations = ArticleScaleVariantContractCatalog.Variants
            .Select(variant => new ArticleScaleVariantAllocation(
                variant,
                distribution.GetValueOrDefault(variant),
                ArticleScaleVariantContractCatalog.Get(variant)))
            .ToArray();
        var idPolicy = new ArticleScaleSemanticIdPolicy(
            ArticleScaleContractVersions.SemanticIdPolicy,
            $"data-scale:{@namespace}:{scaleTier}:article");
        var unsealed = new ArticleScalePlan(
            ArticleScaleContractVersions.PlanSchema,
            ArticleScaleContractVersions.GraphSchema,
            ArticleScaleContractVersions.Factory,
            scaleTier,
            @namespace,
            articleCount,
            allocations,
            artifacts,
            idPolicy,
            BuildPostconditions(allocations),
            ContentDigest: string.Empty);
        ArticleScalePlan plan = unsealed with
        {
            ContentDigest = ArticleScalePlanDigest.Compute(unsealed)
        };
        ArticleScalePlanValidator.Validate(plan).ThrowIfInvalid();
        return plan;
    }

    internal static ArticleScalePostconditions BuildPostconditions(
        IReadOnlyList<ArticleScaleVariantAllocation> allocations)
    {
        ArticleScaleExpectedRowCount[] expectedRows = Enum.GetValues<ArticleScaleRowKind>()
            .Select(kind => new ArticleScaleExpectedRowCount(
                kind,
                allocations.Sum(allocation => checked(
                    (long)allocation.Count * allocation.Contract.Rows.Single(row => row.Kind == kind).CountPerArticle))))
            .ToArray();
        return new(
            expectedRows,
            ExpectedOrphans: 0,
            [
                "current-revision-resolves",
                "current-publication-resolves-when-required",
                "publication-revision-coordinates-match",
                "rights-policy-snapshot-proof-complete",
                "responsibility-coordinate-resolves",
                "outbox-column-payload-coordinates-match",
                "outbox-required-edge-obligations-complete",
                "scheduled-instants-are-strictly-future",
                "archived-and-deleted-history-retained",
                "semantic-graph-digest-matches"
            ]);
    }
}

public static class ArticleScalePlanValidator
{
    public static ArticleScalePlanValidationResult Validate(ArticleScalePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var errors = new List<string>();
        RequireEqual(plan.Schema, ArticleScaleContractVersions.PlanSchema, "schema", errors);
        RequireEqual(plan.GraphSchema, ArticleScaleContractVersions.GraphSchema, "graph schema", errors);
        RequireEqual(plan.FactoryVersion, ArticleScaleContractVersions.Factory, "factory version", errors);
        if (string.IsNullOrWhiteSpace(plan.Namespace) || plan.Namespace.Length > 96
            || plan.Namespace.Any(static value => !(char.IsAsciiLetterOrDigit(value) || value is '-' or '_' or '.')))
        {
            errors.Add("namespace must be a bounded ASCII identity token");
        }
        if (!ArticleScalePlanBuilder.TryGetArticleCount(plan.ScaleTier, out int expectedArticleCount))
        {
            errors.Add("scale tier is not defined by the current data-scale contract");
        }
        else if (plan.ArticleCount != expectedArticleCount)
        {
            errors.Add("article count does not match the current data-scale tier contract");
        }

        ValidateDistribution(plan, errors);
        ValidateArtifacts(plan.Artifacts, errors);
        if (plan.IdAllocation is null)
        {
            errors.Add("semantic ID allocation policy is required");
        }
        else if (!string.Equals(plan.IdAllocation.PolicyId, ArticleScaleContractVersions.SemanticIdPolicy, StringComparison.Ordinal)
            || !string.Equals(
                plan.IdAllocation.NamespacePrefix,
                $"data-scale:{plan.Namespace}:{plan.ScaleTier}:article",
                StringComparison.Ordinal))
        {
            errors.Add("semantic ID allocation policy does not bind the plan namespace and tier");
        }

        if (errors.Count == 0)
        {
            ArticleScalePostconditions expected = ArticleScalePlanBuilder.BuildPostconditions(plan.StateDistribution);
            if (!SequenceEqual(plan.Postconditions.ExpectedRows, expected.ExpectedRows)
                || plan.Postconditions.ExpectedOrphans != 0
                || !plan.Postconditions.RequiredInvariants.SequenceEqual(expected.RequiredInvariants, StringComparer.Ordinal))
            {
                errors.Add("postconditions do not match the exact row graph contract");
            }
            string expectedDigest = ArticleScalePlanDigest.Compute(plan);
            if (!string.Equals(plan.ContentDigest, expectedDigest, StringComparison.Ordinal))
            {
                errors.Add("plan content digest does not match canonical content");
            }
        }

        return new(errors.Count == 0, errors);
    }

    private static void ValidateDistribution(ArticleScalePlan plan, List<string> errors)
    {
        if (plan.StateDistribution is null
            || plan.StateDistribution.Count != ArticleScaleVariantContractCatalog.Variants.Count)
        {
            errors.Add("state distribution must contain every closed variant exactly once");
            return;
        }
        var seen = new HashSet<ArticleScaleVariant>();
        long total = 0;
        foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
        {
            if (!Enum.IsDefined(allocation.Variant))
            {
                errors.Add($"state distribution contains unknown variant {(int)allocation.Variant}");
                continue;
            }
            if (!seen.Add(allocation.Variant))
            {
                errors.Add($"state distribution duplicates {allocation.Variant}");
                continue;
            }
            if (allocation.Count < 0)
            {
                errors.Add($"state distribution count for {allocation.Variant} cannot be negative");
            }
            total += allocation.Count;
            ArticleScaleVariantContract expected = ArticleScaleVariantContractCatalog.Get(allocation.Variant);
            if (!ContractEquivalent(allocation.Contract, expected))
            {
                errors.Add($"variant contract for {allocation.Variant} does not match the canonical catalog");
            }
        }
        if (!ArticleScaleVariantContractCatalog.Variants.All(seen.Contains))
        {
            errors.Add("state distribution omits a closed variant");
        }
        if (total != plan.ArticleCount)
        {
            errors.Add("state distribution counts do not equal article count");
        }
        if (plan.ArticleCount == 1
            && plan.StateDistribution.Single(item => item.Variant == ArticleScaleVariant.Published).Count != 1)
        {
            errors.Add("scale-xs must contain the canonical single published article");
        }
        if (plan.ArticleCount >= ArticleScaleVariantContractCatalog.Variants.Count
            && plan.StateDistribution.Any(static item => item.Count == 0))
        {
            errors.Add("multi-variant tiers must exercise every lifecycle variant");
        }
    }

    private static bool ContractEquivalent(
        ArticleScaleVariantContract actual,
        ArticleScaleVariantContract expected)
        => actual is not null
            && JsonSerializer.Serialize(actual) == JsonSerializer.Serialize(expected);

    private static void ValidateArtifacts(ArticleScaleArtifactBindings artifacts, List<string> errors)
    {
        if (artifacts is null)
        {
            errors.Add("artifact bindings are required");
            return;
        }
        ValidateReferences([artifacts.Temporal], "temporal", requireSingle: true, errors);
        ValidateReferences(artifacts.Content, "content", requireSingle: false, errors);
        ValidateReferences(artifacts.Media, "media", requireSingle: false, errors);
        ValidateReferences(artifacts.Taxonomy, "taxonomy", requireSingle: false, errors);
    }

    private static void ValidateReferences(
        IReadOnlyList<ArticleScaleArtifactReference>? references,
        string kind,
        bool requireSingle,
        List<string> errors)
    {
        if (references is null || references.Count == 0 || (requireSingle && references.Count != 1))
        {
            errors.Add($"{kind} artifact bindings are incomplete");
            return;
        }
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleScaleArtifactReference reference in references)
        {
            if (!IdentityToken(reference.CatalogId) || !IdentityToken(reference.ArtifactId))
            {
                errors.Add($"{kind} artifact identities must be bounded references, not payloads");
            }
            if (!identities.Add($"{reference.CatalogId}\n{reference.ArtifactId}"))
            {
                errors.Add($"{kind} artifact bindings contain a duplicate identity");
            }
            if (!Sha256Digest(reference.ContentDigest))
            {
                errors.Add($"{kind} artifact content digest is invalid");
            }
        }
    }

    private static bool IdentityToken(string? value)
        => !string.IsNullOrWhiteSpace(value)
            && value.Length <= 160
            && !value.Contains("://", StringComparison.Ordinal)
            && value.All(static character => char.IsAsciiLetterOrDigit(character)
                || character is '-' or '_' or '.' or ':' or '/');

    private static bool Sha256Digest(string? value)
        => value is { Length: 71 }
            && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool SequenceEqual(
        IReadOnlyList<ArticleScaleExpectedRowCount> left,
        IReadOnlyList<ArticleScaleExpectedRowCount> right)
        => left.Count == right.Count && left.SequenceEqual(right);

    private static void RequireEqual(string actual, string expected, string field, List<string> errors)
    {
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            errors.Add($"{field} must be {expected}");
        }
    }
}

public static class ArticleScalePlanDigest
{
    public static string Compute(ArticleScalePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new
        {
            plan.Schema,
            plan.GraphSchema,
            plan.FactoryVersion,
            plan.ScaleTier,
            plan.Namespace,
            plan.ArticleCount,
            plan.StateDistribution,
            plan.Artifacts,
            plan.IdAllocation,
            plan.Postconditions
        });
        return "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }
}
