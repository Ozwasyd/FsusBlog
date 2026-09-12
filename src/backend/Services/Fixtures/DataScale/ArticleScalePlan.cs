using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

public static class ArticleScaleContractIds
{
    public const string PlanSchema = "fsusblog.article-scale-plan.v1";
    public const string GraphSchema = "fsusblog.article-scale-graph-row-plan.v1";
    public const string RequiredGraphFactory = "fsusblog.canonical-article-graph-factory.v1";
    public const string SemanticIdPolicy = "fsusblog.article-scale-semantic-id.v1";
    public const string TemporalArtifactSchema = "fsusblog.resolved-temporal-roles.v1";
    public const string FixtureVariantCatalogSchema = "fsusblog.fixture-variant-catalog.v1";
    public const string ContentShapeCatalogSchema = "fsusblog.content-shape-catalog.v1";
    public const string MediaShapeCatalogSchema = "fsusblog.media-shape-catalog.v1";
    public const string DistributionShape = "deterministic-bulk";
    public const string TaxonomyShape = "taxonomy";
}

public static class ArticleScaleTemporalRoles
{
    public const string ArticleCreated = "article.created";
    public const string ArticleRevision = "article.revision";
    public const string ArticlePublication = "article.publication";
    public const string ArticlePublished = "article.published";
    public const string ArticleMetadataUpdated = "article.metadata-updated";
    public const string CommandTime = "fixture.command-time";
    public const string BoundaryTime = "fixture.boundary-time";
    public const string Occurred = "fixture.occurred";

    public static IReadOnlySet<string> All
    {
        get;
    } = new HashSet<string>(StringComparer.Ordinal)
    {
        ArticleCreated,
        ArticleRevision,
        ArticlePublication,
        ArticlePublished,
        ArticleMetadataUpdated,
        CommandTime,
        BoundaryTime,
        Occurred
    };
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
    ArticleTaxonomyReference,
    ArticleMutationOutboxEnvelope,
    ArticleMutationOutboxEdge,
    ArticleAuditCoordinate
}

public enum ArticleScaleRelationKind
{
    BodyToArticle,
    RevisionToArticle,
    ContentBlockToRevision,
    RevisionToRightsSnapshot,
    RightsSnapshotToPolicy,
    RightsProofToSnapshot,
    RevisionToResponsibilitySnapshot,
    RevisionToTaxonomy,
    PublicationToRevision,
    PublicationToRightsSnapshot,
    PublicationToResponsibilitySnapshot,
    OutboxToRevision,
    OutboxToPublication,
    OutboxToRightsSnapshot,
    OutboxToResponsibilitySnapshot,
    OutboxToRequiredEdges,
    AuditToOutbox
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

public enum ArticleScaleKeySource
{
    Semantic,
    DatabaseGeneratedMappedBySemanticRole
}

public enum ArticleScaleTemporalOrder
{
    SameInstant,
    SameOrBefore,
    StrictlyBefore
}

public sealed record ArticleScaleArtifactReference(
    string Schema,
    string AuthorityId,
    string ShapeId,
    string ContentDigest);

public sealed record ArticleScaleArtifactBindings(
    ArticleScaleArtifactReference Temporal,
    ArticleScaleArtifactReference Distribution,
    IReadOnlyList<ArticleScaleArtifactReference> Content,
    IReadOnlyList<ArticleScaleArtifactReference> Media,
    IReadOnlyList<ArticleScaleArtifactReference> Taxonomy);

public sealed record ArticleScaleVariantAllocation(
    ArticleScaleVariant Variant,
    int Count,
    ArticleScaleVariantContract Contract);

public sealed record ArticleScaleRowRequirement(
    ArticleScaleRowKind Kind,
    int CountPerArticle);

public sealed record ArticleScaleTemporalRequirement(
    string Purpose,
    string RoleId);

public sealed record ArticleScaleTemporalOrderRequirement(
    string EarlierRoleId,
    string LaterRoleId,
    ArticleScaleTemporalOrder Order);

public sealed record ArticleScaleTransitionRequirement(
    ArticleStatusTransitionOperation? Operation,
    ArticleStatus TargetStatus,
    string TransitionKind,
    string OutboxEventType,
    string OccurredAtRole,
    string? ScheduledAtRole);

public sealed record ArticleScaleOutboxEventRequirement(
    string EventType,
    int RevisionOrdinal,
    int? PublicationOrdinal,
    bool RequiresRightsSnapshot,
    bool RequiresResponsibilitySnapshot,
    string OccurredAtRole);

public sealed record ArticleScalePointerRequirement(
    ArticleScalePointerKind Kind,
    string SemanticTargetRole);

public sealed record ArticleScaleVariantContract(
    ArticleScaleVariant Variant,
    ArticleStatus TerminalStatus,
    bool IsDeleted,
    bool RetainsPublicationHistory,
    bool RetainsPriorPublicationWhileScheduled,
    IReadOnlyList<ArticleScaleTransitionRequirement> Transitions,
    IReadOnlyList<ArticleScaleRowRequirement> Rows,
    IReadOnlyList<ArticleScaleRelationKind> Relations,
    IReadOnlyList<ArticleScalePointerRequirement> Pointers,
    IReadOnlyList<ArticleScaleTemporalRequirement> TemporalRoles,
    IReadOnlyList<ArticleScaleTemporalOrderRequirement> TemporalOrder,
    IReadOnlyList<ArticleScaleOutboxEventRequirement> OutboxEvents);

public sealed record ArticleScaleSemanticKeyMapping(
    ArticleScaleRowKind RowKind,
    string SemanticRoleTemplate,
    ArticleScaleKeySource KeySource);

public sealed record ArticleScaleSemanticIdPolicy(
    string PolicyId,
    int ArticleOrdinalBase,
    string NamespacePrefix,
    IReadOnlyList<ArticleScaleSemanticKeyMapping> KeyMappings);

public sealed record ArticleScaleOutboxContract(
    string FactoryId,
    string EnvelopeSchemaId,
    int EnvelopeSchemaVersion,
    string EdgeContractId,
    IReadOnlyList<string> RequiredEdges);

public sealed record ArticleScaleExpectedRowCount(
    ArticleScaleRowKind Kind,
    long Count);

public sealed record ArticleScalePostconditions(
    IReadOnlyList<ArticleScaleExpectedRowCount> ExpectedRows,
    int ExpectedOrphans,
    IReadOnlyList<string> RequiredInvariants,
    IReadOnlyList<string> SemanticGraphDigestInputs);

public sealed record ArticleScalePlan(
    string Schema,
    string GraphSchema,
    string RequiredGraphFactory,
    string ScaleTier,
    string Namespace,
    int ArticleCount,
    IReadOnlyList<ArticleScaleVariantAllocation> StateDistribution,
    ArticleScaleArtifactBindings Artifacts,
    ArticleScaleSemanticIdPolicy IdAllocation,
    ArticleScaleOutboxContract Outbox,
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

public static class ArticleScaleDistributionCatalog
{
    private static readonly IReadOnlyDictionary<string, int> s_tierArticleCounts
        = new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["scale-xs"] = 1,
            ["scale-s"] = 100,
            ["scale-m"] = 10_000,
            ["scale-l-nightly"] = 100_000
        };

    public static bool TryGetArticleCount(string scaleTier, out int articleCount)
        => s_tierArticleCounts.TryGetValue(scaleTier, out articleCount);

    public static IReadOnlyDictionary<ArticleScaleVariant, int> Create(string scaleTier)
    {
        if (!TryGetArticleCount(scaleTier, out int articleCount))
        {
            throw new ArgumentException($"Unknown data-scale tier {scaleTier}.", nameof(scaleTier));
        }

        if (articleCount == 1)
        {
            return new Dictionary<ArticleScaleVariant, int>
            {
                [ArticleScaleVariant.Published] = 1,
                [ArticleScaleVariant.Scheduled] = 0,
                [ArticleScaleVariant.PublishedWithScheduledUpdate] = 0,
                [ArticleScaleVariant.Archived] = 0,
                [ArticleScaleVariant.Deleted] = 0
            };
        }

        int lifecycleCount = articleCount / 20;
        return new Dictionary<ArticleScaleVariant, int>
        {
            [ArticleScaleVariant.Published] = articleCount - (lifecycleCount * 4),
            [ArticleScaleVariant.Scheduled] = lifecycleCount,
            [ArticleScaleVariant.PublishedWithScheduledUpdate] = lifecycleCount,
            [ArticleScaleVariant.Archived] = lifecycleCount,
            [ArticleScaleVariant.Deleted] = lifecycleCount
        };
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
        return new Dictionary<ArticleScaleVariant, ArticleScaleVariantContract>
        {
            [ArticleScaleVariant.Published] = Contract(
                ArticleScaleVariant.Published,
                ArticleStatus.Published,
                isDeleted: false,
                retainsPublicationHistory: true,
                retainsPriorPublicationWhileScheduled: false,
                revisions: 1,
                publications: 1,
                transitions:
                [
                    Transition(
                        ArticleStatusTransitionOperation.Create,
                        ArticleStatus.Published,
                        ArticlePublicationTransitionKinds.ImmediatePublish,
                        ArticleMutationEventTypes.Created,
                        ArticleScaleTemporalRoles.ArticlePublished)
                ],
                pointers:
                [
                    Pointer(ArticleScalePointerKind.CurrentRevision, "revision:1"),
                    Pointer(ArticleScalePointerKind.CurrentPublication, "publication:1"),
                    Pointer(ArticleScalePointerKind.PublishedAt, ArticleScaleTemporalRoles.ArticlePublished)
                ],
                temporalRoles:
                [
                    Temporal("created", ArticleScaleTemporalRoles.ArticleCreated),
                    Temporal("revision", ArticleScaleTemporalRoles.ArticleRevision),
                    Temporal("publication", ArticleScaleTemporalRoles.ArticlePublication),
                    Temporal("published", ArticleScaleTemporalRoles.ArticlePublished)
                ],
                temporalOrder:
                [
                    Order(ArticleScaleTemporalRoles.ArticleCreated, ArticleScaleTemporalRoles.ArticleRevision),
                    Order(ArticleScaleTemporalRoles.ArticleRevision, ArticleScaleTemporalRoles.ArticlePublication),
                    Order(
                        ArticleScaleTemporalRoles.ArticlePublication,
                        ArticleScaleTemporalRoles.ArticlePublished,
                        ArticleScaleTemporalOrder.SameInstant)
                ]),
            [ArticleScaleVariant.Scheduled] = Contract(
                ArticleScaleVariant.Scheduled,
                ArticleStatus.Scheduled,
                isDeleted: false,
                retainsPublicationHistory: false,
                retainsPriorPublicationWhileScheduled: false,
                revisions: 1,
                publications: 0,
                transitions:
                [
                    Transition(
                        ArticleStatusTransitionOperation.Create,
                        ArticleStatus.Scheduled,
                        ArticlePublicationTransitionKinds.Schedule,
                        ArticleMutationEventTypes.Created,
                        ArticleScaleTemporalRoles.CommandTime,
                        ArticleScaleTemporalRoles.BoundaryTime)
                ],
                pointers:
                [
                    Pointer(ArticleScalePointerKind.CurrentRevision, "revision:1"),
                    Pointer(ArticleScalePointerKind.ScheduledPublishAt, ArticleScaleTemporalRoles.BoundaryTime)
                ],
                temporalRoles:
                [
                    Temporal("created", ArticleScaleTemporalRoles.ArticleCreated),
                    Temporal("revision", ArticleScaleTemporalRoles.ArticleRevision),
                    Temporal("schedule-command", ArticleScaleTemporalRoles.CommandTime),
                    Temporal("scheduled-due", ArticleScaleTemporalRoles.BoundaryTime)
                ],
                temporalOrder:
                [
                    Order(ArticleScaleTemporalRoles.ArticleCreated, ArticleScaleTemporalRoles.ArticleRevision),
                    Order(ArticleScaleTemporalRoles.ArticleRevision, ArticleScaleTemporalRoles.CommandTime),
                    Order(
                        ArticleScaleTemporalRoles.CommandTime,
                        ArticleScaleTemporalRoles.BoundaryTime,
                        ArticleScaleTemporalOrder.StrictlyBefore)
                ]),
            [ArticleScaleVariant.PublishedWithScheduledUpdate] = Contract(
                ArticleScaleVariant.PublishedWithScheduledUpdate,
                ArticleStatus.Published,
                isDeleted: false,
                retainsPublicationHistory: true,
                retainsPriorPublicationWhileScheduled: true,
                revisions: 2,
                publications: 1,
                transitions:
                [
                    Transition(
                        ArticleStatusTransitionOperation.Create,
                        ArticleStatus.Published,
                        ArticlePublicationTransitionKinds.ImmediatePublish,
                        ArticleMutationEventTypes.Created,
                        ArticleScaleTemporalRoles.ArticlePublished),
                    Transition(
                        ArticleStatusTransitionOperation.Update,
                        ArticleStatus.Scheduled,
                        ArticlePublicationTransitionKinds.Schedule,
                        ArticleMutationEventTypes.Updated,
                        ArticleScaleTemporalRoles.CommandTime,
                        ArticleScaleTemporalRoles.BoundaryTime)
                ],
                pointers:
                [
                    Pointer(ArticleScalePointerKind.CurrentRevision, "revision:2"),
                    Pointer(ArticleScalePointerKind.CurrentPublication, "publication:1"),
                    Pointer(ArticleScalePointerKind.PublishedAt, ArticleScaleTemporalRoles.ArticlePublished),
                    Pointer(ArticleScalePointerKind.PendingPublicationAt, ArticleScaleTemporalRoles.BoundaryTime)
                ],
                temporalRoles:
                [
                    Temporal("created", ArticleScaleTemporalRoles.ArticleCreated),
                    Temporal("published-revision", ArticleScaleTemporalRoles.ArticleRevision),
                    Temporal("publication", ArticleScaleTemporalRoles.ArticlePublication),
                    Temporal("published", ArticleScaleTemporalRoles.ArticlePublished),
                    Temporal("scheduled-revision", ArticleScaleTemporalRoles.ArticleMetadataUpdated),
                    Temporal("update-command", ArticleScaleTemporalRoles.CommandTime),
                    Temporal("pending-publication", ArticleScaleTemporalRoles.BoundaryTime)
                ],
                temporalOrder:
                [
                    Order(ArticleScaleTemporalRoles.ArticleCreated, ArticleScaleTemporalRoles.ArticleRevision),
                    Order(ArticleScaleTemporalRoles.ArticleRevision, ArticleScaleTemporalRoles.ArticlePublication),
                    Order(
                        ArticleScaleTemporalRoles.ArticlePublication,
                        ArticleScaleTemporalRoles.ArticlePublished,
                        ArticleScaleTemporalOrder.SameInstant),
                    Order(
                        ArticleScaleTemporalRoles.ArticlePublished,
                        ArticleScaleTemporalRoles.ArticleMetadataUpdated),
                    Order(
                        ArticleScaleTemporalRoles.ArticleMetadataUpdated,
                        ArticleScaleTemporalRoles.CommandTime),
                    Order(
                        ArticleScaleTemporalRoles.CommandTime,
                        ArticleScaleTemporalRoles.BoundaryTime,
                        ArticleScaleTemporalOrder.StrictlyBefore)
                ]),
            [ArticleScaleVariant.Archived] = Contract(
                ArticleScaleVariant.Archived,
                ArticleStatus.Archived,
                isDeleted: false,
                retainsPublicationHistory: true,
                retainsPriorPublicationWhileScheduled: false,
                revisions: 1,
                publications: 1,
                transitions:
                [
                    Transition(
                        ArticleStatusTransitionOperation.Create,
                        ArticleStatus.Published,
                        ArticlePublicationTransitionKinds.ImmediatePublish,
                        ArticleMutationEventTypes.Created,
                        ArticleScaleTemporalRoles.ArticlePublished),
                    Transition(
                        ArticleStatusTransitionOperation.Update,
                        ArticleStatus.Archived,
                        ArticlePublicationTransitionKinds.Archive,
                        ArticleMutationEventTypes.Updated,
                        ArticleScaleTemporalRoles.Occurred)
                ],
                pointers:
                [
                    Pointer(ArticleScalePointerKind.CurrentRevision, "revision:1"),
                    Pointer(ArticleScalePointerKind.CurrentPublication, "publication:1"),
                    Pointer(ArticleScalePointerKind.PublishedAt, ArticleScaleTemporalRoles.ArticlePublished),
                    Pointer(ArticleScalePointerKind.ArchivedAt, ArticleScaleTemporalRoles.Occurred)
                ],
                temporalRoles:
                [
                    Temporal("created", ArticleScaleTemporalRoles.ArticleCreated),
                    Temporal("revision", ArticleScaleTemporalRoles.ArticleRevision),
                    Temporal("publication", ArticleScaleTemporalRoles.ArticlePublication),
                    Temporal("published", ArticleScaleTemporalRoles.ArticlePublished),
                    Temporal("archived", ArticleScaleTemporalRoles.Occurred)
                ],
                temporalOrder:
                [
                    Order(ArticleScaleTemporalRoles.ArticleCreated, ArticleScaleTemporalRoles.ArticleRevision),
                    Order(ArticleScaleTemporalRoles.ArticleRevision, ArticleScaleTemporalRoles.ArticlePublication),
                    Order(
                        ArticleScaleTemporalRoles.ArticlePublication,
                        ArticleScaleTemporalRoles.ArticlePublished,
                        ArticleScaleTemporalOrder.SameInstant),
                    Order(ArticleScaleTemporalRoles.ArticlePublished, ArticleScaleTemporalRoles.Occurred)
                ]),
            [ArticleScaleVariant.Deleted] = Contract(
                ArticleScaleVariant.Deleted,
                ArticleStatus.Deleted,
                isDeleted: true,
                retainsPublicationHistory: true,
                retainsPriorPublicationWhileScheduled: false,
                revisions: 1,
                publications: 1,
                transitions:
                [
                    Transition(
                        ArticleStatusTransitionOperation.Create,
                        ArticleStatus.Published,
                        ArticlePublicationTransitionKinds.ImmediatePublish,
                        ArticleMutationEventTypes.Created,
                        ArticleScaleTemporalRoles.ArticlePublished),
                    Transition(
                        operation: null,
                        ArticleStatus.Deleted,
                        "article-delete-flow",
                        ArticleMutationEventTypes.Deleted,
                        ArticleScaleTemporalRoles.Occurred)
                ],
                pointers:
                [
                    Pointer(ArticleScalePointerKind.CurrentRevision, "revision:1"),
                    Pointer(ArticleScalePointerKind.CurrentPublication, "publication:1"),
                    Pointer(ArticleScalePointerKind.PublishedAt, ArticleScaleTemporalRoles.ArticlePublished),
                    Pointer(ArticleScalePointerKind.DeletedAt, ArticleScaleTemporalRoles.Occurred)
                ],
                temporalRoles:
                [
                    Temporal("created", ArticleScaleTemporalRoles.ArticleCreated),
                    Temporal("revision", ArticleScaleTemporalRoles.ArticleRevision),
                    Temporal("publication", ArticleScaleTemporalRoles.ArticlePublication),
                    Temporal("published", ArticleScaleTemporalRoles.ArticlePublished),
                    Temporal("deleted", ArticleScaleTemporalRoles.Occurred)
                ],
                temporalOrder:
                [
                    Order(ArticleScaleTemporalRoles.ArticleCreated, ArticleScaleTemporalRoles.ArticleRevision),
                    Order(ArticleScaleTemporalRoles.ArticleRevision, ArticleScaleTemporalRoles.ArticlePublication),
                    Order(
                        ArticleScaleTemporalRoles.ArticlePublication,
                        ArticleScaleTemporalRoles.ArticlePublished,
                        ArticleScaleTemporalOrder.SameInstant),
                    Order(ArticleScaleTemporalRoles.ArticlePublished, ArticleScaleTemporalRoles.Occurred)
                ])
        };
    }

    private static ArticleScaleVariantContract Contract(
        ArticleScaleVariant variant,
        ArticleStatus terminalStatus,
        bool isDeleted,
        bool retainsPublicationHistory,
        bool retainsPriorPublicationWhileScheduled,
        int revisions,
        int publications,
        IReadOnlyList<ArticleScaleTransitionRequirement> transitions,
        IReadOnlyList<ArticleScalePointerRequirement> pointers,
        IReadOnlyList<ArticleScaleTemporalRequirement> temporalRoles,
        IReadOnlyList<ArticleScaleTemporalOrderRequirement> temporalOrder)
    {
        int outboxEvents = transitions.Count;
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
            new(ArticleScaleRowKind.ArticleTaxonomyReference, revisions),
            new(ArticleScaleRowKind.ArticleMutationOutboxEnvelope, outboxEvents),
            new(
                ArticleScaleRowKind.ArticleMutationOutboxEdge,
                checked(outboxEvents * ArticleMutationReplayEdges.Required.Count)),
            new(ArticleScaleRowKind.ArticleAuditCoordinate, outboxEvents)
        };
        var relations = new List<ArticleScaleRelationKind>
        {
            ArticleScaleRelationKind.BodyToArticle,
            ArticleScaleRelationKind.RevisionToArticle,
            ArticleScaleRelationKind.ContentBlockToRevision,
            ArticleScaleRelationKind.RevisionToRightsSnapshot,
            ArticleScaleRelationKind.RightsSnapshotToPolicy,
            ArticleScaleRelationKind.RightsProofToSnapshot,
            ArticleScaleRelationKind.RevisionToResponsibilitySnapshot,
            ArticleScaleRelationKind.RevisionToTaxonomy,
            ArticleScaleRelationKind.OutboxToRevision,
            ArticleScaleRelationKind.OutboxToRightsSnapshot,
            ArticleScaleRelationKind.OutboxToResponsibilitySnapshot,
            ArticleScaleRelationKind.OutboxToRequiredEdges,
            ArticleScaleRelationKind.AuditToOutbox
        };
        if (publications > 0)
        {
            relations.AddRange([
                ArticleScaleRelationKind.PublicationToRevision,
                ArticleScaleRelationKind.PublicationToRightsSnapshot,
                ArticleScaleRelationKind.PublicationToResponsibilitySnapshot,
                ArticleScaleRelationKind.OutboxToPublication
            ]);
        }

        ArticleScaleOutboxEventRequirement[] outbox = transitions
            .Select((transition, index) => new ArticleScaleOutboxEventRequirement(
                transition.OutboxEventType,
                RevisionOrdinal: Math.Min(index + 1, revisions),
                PublicationOrdinal: publications == 0 ? null : 1,
                RequiresRightsSnapshot: true,
                RequiresResponsibilitySnapshot: true,
                transition.OccurredAtRole))
            .ToArray();
        return new(
            variant,
            terminalStatus,
            isDeleted,
            retainsPublicationHistory,
            retainsPriorPublicationWhileScheduled,
            transitions,
            rows,
            relations,
            pointers,
            temporalRoles,
            temporalOrder,
            outbox);
    }

    private static ArticleScaleTransitionRequirement Transition(
        ArticleStatusTransitionOperation? operation,
        ArticleStatus targetStatus,
        string transitionKind,
        string outboxEventType,
        string occurredAtRole,
        string? scheduledAtRole = null)
        => new(operation, targetStatus, transitionKind, outboxEventType, occurredAtRole, scheduledAtRole);

    private static ArticleScalePointerRequirement Pointer(
        ArticleScalePointerKind kind,
        string semanticTargetRole)
        => new(kind, semanticTargetRole);

    private static ArticleScaleTemporalRequirement Temporal(string purpose, string roleId)
        => new(purpose, roleId);

    private static ArticleScaleTemporalOrderRequirement Order(
        string earlierRoleId,
        string laterRoleId,
        ArticleScaleTemporalOrder order = ArticleScaleTemporalOrder.SameOrBefore)
        => new(earlierRoleId, laterRoleId, order);
}

public static class ArticleScalePlanBuilder
{
    public static ArticleScalePlan Create(
        string scaleTier,
        string @namespace,
        ArticleScaleArtifactBindings artifacts)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(scaleTier);
        ArgumentException.ThrowIfNullOrWhiteSpace(@namespace);
        ArgumentNullException.ThrowIfNull(artifacts);
        if (!ArticleScaleDistributionCatalog.TryGetArticleCount(scaleTier, out int articleCount))
        {
            throw new ArgumentException($"Unknown data-scale tier {scaleTier}.", nameof(scaleTier));
        }

        IReadOnlyDictionary<ArticleScaleVariant, int> distribution
            = ArticleScaleDistributionCatalog.Create(scaleTier);
        ArticleScaleVariantAllocation[] allocations = ArticleScaleVariantContractCatalog.Variants
            .Select(variant => new ArticleScaleVariantAllocation(
                variant,
                distribution[variant],
                ArticleScaleVariantContractCatalog.Get(variant)))
            .ToArray();
        var unsealed = new ArticleScalePlan(
            ArticleScaleContractIds.PlanSchema,
            ArticleScaleContractIds.GraphSchema,
            ArticleScaleContractIds.RequiredGraphFactory,
            scaleTier,
            @namespace,
            articleCount,
            allocations,
            artifacts,
            BuildSemanticIdPolicy(scaleTier, @namespace),
            BuildOutboxContract(),
            BuildPostconditions(allocations),
            ContentDigest: string.Empty);
        ArticleScalePlan plan = unsealed with
        {
            ContentDigest = ArticleScalePlanDigest.Compute(unsealed)
        };
        ArticleScalePlanValidator.Validate(plan, artifacts).ThrowIfInvalid();
        return plan;
    }

    internal static ArticleScaleSemanticIdPolicy BuildSemanticIdPolicy(
        string scaleTier,
        string @namespace)
        => new(
            ArticleScaleContractIds.SemanticIdPolicy,
            ArticleOrdinalBase: 1,
            NamespacePrefix: $"data-scale:{@namespace}:{scaleTier}",
            KeyMappings:
            [
                Mapping(ArticleScaleRowKind.Article, "article/{article}"),
                Mapping(ArticleScaleRowKind.ArticleBody, "article/{article}/body"),
                Mapping(ArticleScaleRowKind.ArticleRevision, "article/{article}/revision/{revision}"),
                Mapping(
                    ArticleScaleRowKind.ArticleRevisionContentBlock,
                    "article/{article}/revision/{revision}/content/{block}"),
                Mapping(ArticleScaleRowKind.ArticleRightsPolicy, "article/{article}/rights/policy"),
                Mapping(
                    ArticleScaleRowKind.ArticleRightsSnapshot,
                    "article/{article}/revision/{revision}/rights/snapshot"),
                Mapping(
                    ArticleScaleRowKind.ArticleRightsProof,
                    "article/{article}/revision/{revision}/rights/proof"),
                Mapping(
                    ArticleScaleRowKind.ArticleResponsibilitySnapshot,
                    "article/{article}/revision/{revision}/responsibility"),
                Mapping(ArticleScaleRowKind.ArticlePublication, "article/{article}/publication/{publication}"),
                Mapping(
                    ArticleScaleRowKind.ArticleTaxonomyReference,
                    "article/{article}/revision/{revision}/taxonomy"),
                Mapping(ArticleScaleRowKind.ArticleMutationOutboxEnvelope, "article/{article}/outbox/{event}"),
                Mapping(
                    ArticleScaleRowKind.ArticleMutationOutboxEdge,
                    "article/{article}/outbox/{event}/edge/{edge}"),
                Mapping(ArticleScaleRowKind.ArticleAuditCoordinate, "article/{article}/audit/{event}")
            ]);

    internal static ArticleScaleOutboxContract BuildOutboxContract()
        => new(
            ArticleMutationOutboxProducer.FactoryId,
            ArticleMutationOutboxEnvelopeCodec.CurrentSchemaId,
            ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion,
            ArticleMutationReplayEdges.ContractId,
            [.. ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal)]);

    internal static ArticleScalePostconditions BuildPostconditions(
        IReadOnlyList<ArticleScaleVariantAllocation> allocations)
    {
        ArticleScaleExpectedRowCount[] expectedRows = Enum.GetValues<ArticleScaleRowKind>()
            .Select(kind => new ArticleScaleExpectedRowCount(
                kind,
                allocations.Sum(allocation => checked(
                    (long)allocation.Count
                    * allocation.Contract.Rows.Single(row => row.Kind == kind).CountPerArticle))))
            .ToArray();
        return new(
            expectedRows,
            ExpectedOrphans: 0,
            RequiredInvariants:
            [
                "current-revision-resolves",
                "current-publication-resolves-when-required",
                "published-publication-revision-rights-responsibility-coordinates-match",
                "scheduled-due-is-strictly-future",
                "scheduled-update-retains-prior-publication",
                "archived-and-deleted-history-is-retained",
                "rights-policy-snapshot-proof-is-complete-and-final",
                "responsibility-snapshot-resolves",
                "outbox-column-payload-coordinates-match",
                "outbox-required-edges-match-production-contract",
                "semantic-keys-map-database-generated-keys",
                "semantic-graph-digest-matches"
            ],
            SemanticGraphDigestInputs:
            [
                "plan.schema",
                "plan.graphSchema",
                "plan.requiredGraphFactory",
                "plan.scaleTier",
                "plan.namespace",
                "plan.articleCount",
                "plan.stateDistribution",
                "plan.artifacts",
                "plan.idAllocation",
                "plan.outbox",
                "plan.postconditions.expectedRows",
                "plan.postconditions.requiredInvariants"
            ]);
    }

    private static ArticleScaleSemanticKeyMapping Mapping(
        ArticleScaleRowKind rowKind,
        string semanticRoleTemplate)
        => new(rowKind, semanticRoleTemplate, ArticleScaleKeySource.DatabaseGeneratedMappedBySemanticRole);
}

public static class ArticleScalePlanValidator
{
    public static ArticleScalePlanValidationResult Validate(
        ArticleScalePlan plan,
        ArticleScaleArtifactBindings authoritativeArtifacts)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(authoritativeArtifacts);
        var errors = new List<string>();
        RequireEqual(plan.Schema, ArticleScaleContractIds.PlanSchema, "plan schema", errors);
        RequireEqual(plan.GraphSchema, ArticleScaleContractIds.GraphSchema, "graph schema", errors);
        RequireEqual(
            plan.RequiredGraphFactory,
            ArticleScaleContractIds.RequiredGraphFactory,
            "required graph factory",
            errors);
        ValidateIdentityToken(plan.Namespace, "namespace", errors);
        if (!ArticleScaleDistributionCatalog.TryGetArticleCount(plan.ScaleTier, out int expectedCount))
        {
            errors.Add("scale tier is unknown");
        }
        else if (plan.ArticleCount != expectedCount)
        {
            errors.Add("article count does not match the immutable scale tier");
        }

        ValidateDistribution(plan, errors);
        ValidateArtifacts(plan.Artifacts, errors);
        if (!Equivalent(plan.Artifacts, authoritativeArtifacts))
        {
            errors.Add("artifact references do not exact-match the independently supplied authorities");
        }
        ValidateSemanticIdPolicy(plan, errors);
        ValidateOutboxContract(plan.Outbox, errors);
        if (errors.Count == 0)
        {
            ArticleScalePostconditions expectedPostconditions
                = ArticleScalePlanBuilder.BuildPostconditions(plan.StateDistribution);
            if (!Equivalent(plan.Postconditions, expectedPostconditions))
            {
                errors.Add("postconditions do not match the canonical graph contract");
            }
            if (ContainsForbiddenSubstitute(plan))
            {
                errors.Add("plan contains a provider, sentinel, simplified graph, or manual derived-state substitute");
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
        IReadOnlyDictionary<ArticleScaleVariant, int>? expectedDistribution = null;
        if (ArticleScaleDistributionCatalog.TryGetArticleCount(plan.ScaleTier, out _))
        {
            expectedDistribution = ArticleScaleDistributionCatalog.Create(plan.ScaleTier);
        }
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
                errors.Add($"state distribution count for {allocation.Variant} is negative");
            }
            total += allocation.Count;
            if (expectedDistribution is not null
                && allocation.Count != expectedDistribution[allocation.Variant])
            {
                errors.Add($"state distribution count for {allocation.Variant} is not canonical");
            }
            ArticleScaleVariantContract expectedContract
                = ArticleScaleVariantContractCatalog.Get(allocation.Variant);
            if (!Equivalent(allocation.Contract, expectedContract))
            {
                errors.Add($"variant contract for {allocation.Variant} is incomplete or stale");
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
    }

    private static void ValidateArtifacts(ArticleScaleArtifactBindings artifacts, List<string> errors)
    {
        if (artifacts is null)
        {
            errors.Add("artifact bindings are required");
            return;
        }

        ValidateReferences(
            [artifacts.Temporal],
            "temporal",
            ArticleScaleContractIds.TemporalArtifactSchema,
            requiredShapeId: null,
            errors);
        ValidateReferences(
            [artifacts.Distribution],
            "distribution",
            ArticleScaleContractIds.FixtureVariantCatalogSchema,
            ArticleScaleContractIds.DistributionShape,
            errors);
        ValidateReferences(
            artifacts.Content,
            "content",
            ArticleScaleContractIds.ContentShapeCatalogSchema,
            requiredShapeId: null,
            errors);
        ValidateReferences(
            artifacts.Media,
            "media",
            ArticleScaleContractIds.MediaShapeCatalogSchema,
            requiredShapeId: null,
            errors);
        ValidateReferences(
            artifacts.Taxonomy,
            "taxonomy",
            ArticleScaleContractIds.FixtureVariantCatalogSchema,
            ArticleScaleContractIds.TaxonomyShape,
            errors);
    }

    private static void ValidateReferences(
        IReadOnlyList<ArticleScaleArtifactReference>? references,
        string kind,
        string requiredSchema,
        string? requiredShapeId,
        List<string> errors)
    {
        if (references is null || references.Count == 0)
        {
            errors.Add($"{kind} artifact references are missing");
            return;
        }

        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleScaleArtifactReference reference in references)
        {
            if (reference is null)
            {
                errors.Add($"{kind} artifact reference is null");
                continue;
            }
            if (!string.Equals(reference.Schema, requiredSchema, StringComparison.Ordinal))
            {
                errors.Add($"{kind} artifact schema is not authoritative");
            }
            if (requiredShapeId is not null
                && !string.Equals(reference.ShapeId, requiredShapeId, StringComparison.Ordinal))
            {
                errors.Add($"{kind} artifact shape is not canonical");
            }
            ValidateIdentityToken(reference.AuthorityId, $"{kind} authority", errors);
            ValidateIdentityToken(reference.ShapeId, $"{kind} shape", errors);
            if (!Sha256Digest(reference.ContentDigest))
            {
                errors.Add($"{kind} artifact digest is invalid");
            }
            if (!identities.Add($"{reference.AuthorityId}\n{reference.ShapeId}"))
            {
                errors.Add($"{kind} artifact reference is duplicated");
            }
        }
    }

    private static void ValidateSemanticIdPolicy(ArticleScalePlan plan, List<string> errors)
    {
        ArticleScaleSemanticIdPolicy expected
            = ArticleScalePlanBuilder.BuildSemanticIdPolicy(plan.ScaleTier, plan.Namespace);
        if (plan.IdAllocation is null || !Equivalent(plan.IdAllocation, expected))
        {
            errors.Add("semantic ID policy or explicit database-key mapping is incomplete or stale");
        }
    }

    private static void ValidateOutboxContract(ArticleScaleOutboxContract outbox, List<string> errors)
    {
        ArticleScaleOutboxContract expected = ArticleScalePlanBuilder.BuildOutboxContract();
        if (outbox is null || !Equivalent(outbox, expected))
        {
            errors.Add("outbox contract does not exact-match the production factory, envelope, and edges");
        }
    }

    private static bool ContainsForbiddenSubstitute(ArticleScalePlan plan)
    {
        string serialized = JsonSerializer.Serialize(plan);
        string[] forbidden =
        [
            "Npgsql",
            "SqlSugar",
            "PostgreSQL",
            "MySQL",
            "SQLite",
            "SELECT ",
            "INSERT ",
            "rights-v3:policy-hash:recompute",
            "rights-v3:content-hash:recompute",
            "placeholder",
            "sentinel",
            "status-modulo",
            "simplified-graph"
        ];
        return forbidden.Any(value => serialized.Contains(value, StringComparison.OrdinalIgnoreCase));
    }

    private static bool Equivalent<T>(T actual, T expected)
        => actual is not null
            && string.Equals(
                JsonSerializer.Serialize(actual),
                JsonSerializer.Serialize(expected),
                StringComparison.Ordinal);

    private static void ValidateIdentityToken(string? value, string field, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > 192
            || value.Contains("://", StringComparison.Ordinal)
            || value.Any(static character => !(char.IsAsciiLetterOrDigit(character)
                || character is '-' or '_' or '.' or ':' or '/')))
        {
            errors.Add($"{field} must be a bounded identity reference, not payload or URL data");
        }
    }

    private static bool Sha256Digest(string? value)
        => value is { Length: 71 }
            && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

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
            plan.RequiredGraphFactory,
            plan.ScaleTier,
            plan.Namespace,
            plan.ArticleCount,
            plan.StateDistribution,
            plan.Artifacts,
            plan.IdAllocation,
            plan.Outbox,
            plan.Postconditions
        });
        return "sha256:" + Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }
}
