namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Plan occurrence coordinates, not a resource ID or physical thread coordinate.</summary>
public sealed record CommentScaleGraphOccurrence(string ScenarioRole, long Repetition, string ArticleTargetRole);

/// <summary>A symbolic requested edge within one article occurrence; no native ID is inferred.</summary>
public sealed record CommentScaleRequestCoordinate(CommentScaleGraphOccurrence Occurrence, string CommentRole);

/// <summary>
/// Caller-supplied original-owner facts. The article mapping and generated-content
/// artifact must be independently verified before consumption. These records only
/// transport reference bindings; they neither allocate IDs nor authenticate facts.
/// </summary>
public sealed record CommentScaleGraphFactBindings(
    CommentScaleGraphOccurrence Occurrence,
    string Namespace,
    string CommentPlanDigest,
    string ArticlePlanDigest,
    string ArticleSemanticRole,
    int ArticleId,
    CommentScaleArtifactReference NativeArticleBinding,
    IReadOnlyList<CommentScaleRequestFactBinding> Comments);

/// <summary>One existing request's content reference and original policy inputs.</summary>
public sealed record CommentScaleRequestFactBinding(
    string CommentRole,
    string ContentRole,
    CommentScaleArtifactReference ContentArtifact,
    CommentScalePolicyFacts PolicyFacts);

/// <summary>Requested moderation step with its original resolved-role instant, not a generated event.</summary>
public sealed record CommentScaleResolvedModerationRequest(
    CommentScaleModerationStep Request,
    DateTime OccurredAtUtc);

/// <summary>
/// Resolved inputs to the physical-row phase. Parent/reply remain requested semantic
/// edges; base moderation is not final row status. No content, ID, event or proof is generated.
/// </summary>
public sealed record CommentScaleResolvedRequestIntent(
    CommentScaleRequestCoordinate Coordinate,
    CommentScaleRequestCoordinate? Parent,
    CommentScaleRequestCoordinate? ReplyTarget,
    string ContentRole,
    CommentScaleArtifactReference ContentArtifact,
    CommentScalePolicyResolution Policies,
    IReadOnlyList<CommentScaleResolvedModerationRequest> Moderation);

/// <summary>
/// Canonical factory's input-resolution stage, including zero-comment occurrences.
/// Global native-identity uniqueness, original artifact admission and all production
/// thread/privacy/revision/outbox/crypto row authorities remain unqualified. This is
/// neither a graph row plan, a second scale plan nor an equivalence/admission token.
/// </summary>
public sealed record CommentScaleResolvedGraphIntent(
    CommentScaleGraphOccurrence Occurrence,
    string CommentPlanDigest,
    string ArticlePlanDigest,
    string ArticleSemanticRole,
    int ArticleId,
    CommentScaleArtifactReference NativeArticleBinding,
    CommentScaleGraphRequirements Requirements,
    IReadOnlyList<CommentScaleResolvedRequestIntent> Comments);
