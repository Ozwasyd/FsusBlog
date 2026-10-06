// fixture-catalog: port canonical-article-projection-verifier
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using AngleSharp.Dom;
using AngleSharp.Html.Parser;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Background;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public sealed record CanonicalArticleProjectionCoordinates(
    int ArticleId,
    long RevisionId,
    int RevisionNo,
    long? PublicationId,
    int? PublicationNo,
    long? RightsSnapshotId,
    long? ResponsibilitySnapshotId,
    int? ResponsibilityVersion);

internal sealed record CanonicalArticleProjectionVersionCoordinates(
    long RevisionId,
    int RevisionNo,
    long? PublicationId,
    int? PublicationNo);

internal sealed record CanonicalArticleProjectionConsistencyEvidence(
    bool PubliclyVisible,
    bool SearchQueryFound,
    bool SearchQueryTitleMatches,
    SearchProjectionEvidence SearchEvidence,
    CanonicalArticleProjectionCoordinates ExpectedCoordinates,
    string ExpectedTitleDigest,
    bool AedsProjectionFound,
    bool AedsArtifactFound,
    bool HotReadFound,
    bool HotReadPublicationVerified,
    string AedsProjectionFrameDigest,
    string AedsArtifactFrameDigest,
    string HotReadFrameDigest,
    CanonicalArticleProjectionVersionCoordinates? DetailCoordinates,
    string? DetailContentDigest,
    long? DetailRightsSnapshotId,
    CanonicalArticleProjectionVersionCoordinates? ListCoordinates,
    string ExpectedContentDigest,
    string? AotLastMutationId,
    string? ExpectedEventId);

public sealed record CanonicalArticleProjectionEdgeObservation(
    string EventId,
    int EventVersion,
    string EdgeName,
    string Owner,
    string Status,
    int AttemptCount,
    long Generation,
    string DeliveryKey,
    string InputDigest,
    string OutputDigest,
    CanonicalArticleProjectionCoordinates Coordinates,
    string TerminalReceiptDigest);

public sealed record CanonicalArticleProjectionOutputAggregate(
    string Schema,
    string RunId,
    string Namespace,
    string AuthorityReceiptDigest,
    string RequiredEdgeContractId,
    IReadOnlyList<string> RequiredEdges,
    CanonicalArticleProjectionCoordinates CurrentCoordinates,
    bool PubliclyVisible,
    string ContentDigest,
    string SearchDigest,
    string AotDigest,
    string RevocationDigest,
    string AedsDigest,
    string HotReadDigest,
    string PublicListDigest,
    string PublicDetailDigest,
    string CacheDigest,
    IReadOnlyList<CanonicalArticleProjectionEdgeObservation> Edges,
    IReadOnlyList<string> Failures,
    string AggregateDigest);

public sealed class CanonicalArticleProjectionVerificationException(
    IReadOnlyList<string> violations)
    : InvalidOperationException(
        $"canonical_article_projection_verification_failed:{string.Join(',', violations)}")
{
    public IReadOnlyList<string> Violations { get; } = violations;
}

/// <summary>
/// Independent read-only verifier for the derived side of a canonical article lifecycle receipt.
/// It never invokes a projector, cache writer, rebuild action, or outbox worker.
/// </summary>
public sealed class CanonicalArticleProjectionVerifier(
    ISqlSugarClient db,
    ISearchIndexService searchIndex,
    IArticleCoreGateway articles,
    IPublicArticleProjectionStore projectionStore,
    IArticleDetailAedsArtifactStore artifactStore,
    PublicHotReadStore hotReadStore,
    IPublicAotInvalidationGenerationAuthority aotGenerationAuthority,
    IPublicAotArtifactStore aotArtifactStore,
    IPublicArtifactStorage publicArtifactStorage,
    IHttpContextAccessor httpContextAccessor,
    PublicArtifactRevocationRegistry revocationRegistry,
    IPublicArtifactRevocationStateStore revocationState,
    ICacheStringReader cacheReader,
    IRuntimeKeyScope runtimeKeyScope,
    TimeProvider timeProvider)
{
    public const string Schema = "fsusblog.canonical-article-projection-aggregate.v1";

    private static readonly JsonSerializerOptions s_json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public Task<CanonicalArticleProjectionOutputAggregate> VerifyAsync(
        CanonicalArticleLifecycleReceipt authority,
        CancellationToken cancellationToken = default)
        => throw new CanonicalArticleProjectionVerificationException(["authority_current_run_refs_missing"]);

    public Task<CanonicalArticleProjectionOutputAggregate> VerifyAsync(
        CanonicalArticleLifecycleReceipt authority,
        CanonicalArticleLifecycleFixtureBinding currentInvocation,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(authority);
        ArgumentNullException.ThrowIfNull(currentInvocation);
        currentInvocation.Validate();
        if (authority.RunId != currentInvocation.RunId
            || authority.Namespace != currentInvocation.Namespace
            || authority.ProfileId != currentInvocation.ProfileId
            || authority.AdminPrincipalId != currentInvocation.AdminPrincipalId
            || authority.WriterContractDigest != currentInvocation.WriterContractDigest
            || authority.TemporalContextDigest != currentInvocation.TemporalContextDigest)
        {
            throw new CanonicalArticleProjectionVerificationException(["authority_current_invocation_binding_mismatch"]);
        }
        return VerifyAsync(ProjectionAuthority.From(authority), cancellationToken);
    }

    public Task<CanonicalArticleProjectionOutputAggregate> VerifyAsync(
        CanonicalArticlePublicationReceipt authority,
        CancellationToken cancellationToken = default)
        => VerifyAsync(ProjectionAuthority.From(authority), cancellationToken);

    public async Task<CanonicalArticleProjectionOutputAggregate> VerifyAsync(
        CanonicalArticlePublicationReceipt authority,
        CanonicalArticlePublicationRequest currentInvocation,
        CancellationToken cancellationToken = default)
    {
        await VerifyPublicationInvocationAsync(authority, currentInvocation, cancellationToken).ConfigureAwait(false);
        return await VerifyAsync(ProjectionAuthority.From(authority, hasSealedCurrentRunBinding: true), cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task VerifyAggregateAsync(
        CanonicalArticleProjectionOutputAggregate aggregate,
        CanonicalArticlePublicationReceipt authority,
        CanonicalArticlePublicationRequest currentInvocation,
        CancellationToken cancellationToken = default)
    {
        CanonicalArticleProjectionOutputAggregate reread = await VerifyAsync(
            authority, currentInvocation, cancellationToken).ConfigureAwait(false);
        VerifyAggregate(aggregate, ProjectionAuthority.From(authority, hasSealedCurrentRunBinding: true));
        if (reread.AggregateDigest != aggregate.AggregateDigest)
        {
            throw new CanonicalArticleProjectionVerificationException(["projection_aggregate_current_output_mismatch"]);
        }
    }

    public Task<CanonicalArticleProjectionOutputAggregate> AwaitCurrentOutputAsync(
        CanonicalArticleLifecycleReceipt authority,
        CanonicalArticleLifecycleFixtureBinding currentInvocation,
        TimeSpan observationInterval,
        CancellationToken callerBudgetToken)
        => AwaitCurrentOutputAsync(
            token => VerifyAsync(authority, currentInvocation, token),
            observationInterval, callerBudgetToken);

    public Task<CanonicalArticleProjectionOutputAggregate> AwaitCurrentOutputAsync(
        CanonicalArticlePublicationReceipt authority,
        CanonicalArticlePublicationRequest currentInvocation,
        TimeSpan observationInterval,
        CancellationToken callerBudgetToken)
        => AwaitCurrentOutputAsync(
            token => VerifyAsync(authority, currentInvocation, token),
            observationInterval, callerBudgetToken);

    internal static async Task<CanonicalArticleProjectionOutputAggregate> AwaitCurrentOutputAsync(
        Func<CancellationToken, Task<CanonicalArticleProjectionOutputAggregate>> observe,
        TimeSpan observationInterval,
        CancellationToken callerBudgetToken)
    {
        // The fixture executor owns the existing convergence budget. This observer
        // creates no new deadline and cannot schedule or repair the producer.
        if (!callerBudgetToken.CanBeCanceled || observationInterval <= TimeSpan.Zero)
        {
            throw new ArgumentException("projection observation requires the caller's bounded token and poll interval");
        }
        while (true)
        {
            callerBudgetToken.ThrowIfCancellationRequested();
            try
            {
                CanonicalArticleProjectionOutputAggregate aggregate = await observe(callerBudgetToken)
                    .WaitAsync(callerBudgetToken).ConfigureAwait(false);
                callerBudgetToken.ThrowIfCancellationRequested();
                return aggregate;
            }
            catch (CanonicalArticleProjectionVerificationException error)
                when (error.Violations.Count == 2
                    && error.Violations.Contains("aot_current_document_missing", StringComparer.Ordinal)
                    && error.Violations.Contains("projection_aggregate_contains_failures", StringComparer.Ordinal))
            {
                // Absence at the current versioned key is not success or evidence of
                // a queued job. It may only be reread until the original budget ends.
                // Stale/invalid bytes, drift, failed edges or any other violation are terminal.
                try
                {
                    await Task.Delay(observationInterval, callerBudgetToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (callerBudgetToken.IsCancellationRequested)
                {
                    throw new OperationCanceledException(
                        "canonical projection output observation canceled while current AOT document remained absent",
                        error, callerBudgetToken);
                }
            }
        }
    }

    internal async Task VerifyPublicationInvocationAsync(
        CanonicalArticlePublicationReceipt authority,
        CanonicalArticlePublicationRequest currentInvocation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(authority);
        ArgumentNullException.ThrowIfNull(currentInvocation);
        ArgumentNullException.ThrowIfNull(currentInvocation.Binding);
        ArgumentNullException.ThrowIfNull(currentInvocation.Plan);
        currentInvocation.Binding.Validate();
        CanonicalArticlePublicationFixtureBinding binding = currentInvocation.Binding;
        if (authority.RunId != binding.RunId || authority.Namespace != binding.Namespace
            || authority.ProfileId != binding.ProfileId || authority.AdminPrincipalId != binding.AdminPrincipalId
            || authority.WriterContractDigest != binding.WriterContractDigest
            || authority.SemanticRole != currentInvocation.Plan.SemanticRole)
        {
            throw new CanonicalArticleProjectionVerificationException(["publication_current_invocation_binding_mismatch"]);
        }
        string clientMutationId = CanonicalArticlePublicationFixturePort.DeriveClientMutationId(
            binding.RunId, binding.Namespace, currentInvocation.Plan.SemanticRole).ToString("D");
        List<ArticleMutationCommand> commands = await db.Queryable<ArticleMutationCommand>()
            .Where(item => item.AdminPrincipalId == binding.AdminPrincipalId && item.ClientMutationId == clientMutationId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (commands.Count != 1)
        {
            throw new CanonicalArticleProjectionVerificationException(["publication_current_invocation_command_not_exact"]);
        }
        ArticleMutationCommand command = commands[0];
        if (command.AdminPrincipalId != binding.AdminPrincipalId || command.ClientMutationId != clientMutationId
            || command.RequestHash != CanonicalArticlePublicationFixturePort.ComputeRequestHash(currentInvocation.Plan)
            || command.ArticleId != authority.ArticleId || command.RevisionId != authority.RevisionId
            || command.RevisionNo != authority.RevisionNo || command.ReleaseId != authority.PublicationId
            || command.ReleaseNo != authority.PublicationNo || command.RightsSnapshotId != authority.RightsSnapshotId
            || command.RightsRevisionNo != authority.RevisionNo
            || command.Status != (int)ArticleStatus.Published)
        {
            throw new CanonicalArticleProjectionVerificationException(["publication_current_invocation_command_mismatch"]);
        }

        ArticlePublicationRecord? publication = await db.Queryable<ArticlePublicationRecord>()
            .Where(item => item.Id == authority.PublicationId).FirstAsync(cancellationToken).ConfigureAwait(false);
        ArticleRightsSnapshot? rights = await db.Queryable<ArticleRightsSnapshot>()
            .Where(item => item.Id == authority.RightsSnapshotId).FirstAsync(cancellationToken).ConfigureAwait(false);
        ArticleResponsibilitySnapshot? responsibility = await db.Queryable<ArticleResponsibilitySnapshot>()
            .Where(item => item.Id == authority.ResponsibilitySnapshotId).FirstAsync(cancellationToken).ConfigureAwait(false);
        // Use the receipt's exact immutable audit reference, never a latest/tail lookup.
        List<AuditLog> audits = await db.Queryable<AuditLog>()
            .Where(item => item.ChainId == authority.AuditChainId && item.RecordHash == authority.AuditRecordHash)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (publication is null || publication.Id != authority.PublicationId
            || publication.ArticleId != authority.ArticleId || publication.ArticleRevisionId != authority.RevisionId
            || publication.RevisionNo != authority.RevisionNo || publication.PublicationNo != authority.PublicationNo
            || publication.RightsSnapshotId != authority.RightsSnapshotId
            || publication.ResponsibilitySnapshotId != authority.ResponsibilitySnapshotId
            || rights is null || rights.Id != authority.RightsSnapshotId || rights.ArticleId != authority.ArticleId
            || rights.ArticleRevisionId != authority.RevisionId || rights.RevisionNo != authority.RevisionNo
            || rights.PolicyHash != authority.PolicyHash || rights.ContentCanonicalHash != authority.ContentCanonicalHash
            || responsibility is null || responsibility.Id != authority.ResponsibilitySnapshotId
            || responsibility.ArticleId != authority.ArticleId || responsibility.ArticleRevisionId != authority.RevisionId
            || responsibility.RevisionNo != authority.RevisionNo
            || responsibility.ResponsibilityVersion != authority.ResponsibilityVersion
            || audits.Count != 1)
        {
            throw new CanonicalArticleProjectionVerificationException(["publication_canonical_reference_mismatch"]);
        }
        AuditLog audit = audits[0];
        if (audit.ChainId != authority.AuditChainId || audit.RecordHash != authority.AuditRecordHash
            || audit.TargetType != "article-canonical-publication"
            || audit.TargetId != authority.ArticleId.ToString(CultureInfo.InvariantCulture)
            || audit.ActorId != binding.AdminPrincipalId.ToString(CultureInfo.InvariantCulture)
            || audit.Outcome != "success"
            || audit.EventInfo != CanonicalArticlePublicationFixturePort.ComputeAuditDigest(
                authority.ArticleId, authority.RevisionId, authority.PublicationId, authority.RightsSnapshotId,
                authority.ResponsibilitySnapshotId, authority.OutboxEventId))
        {
            throw new CanonicalArticleProjectionVerificationException(["publication_canonical_audit_mismatch"]);
        }
    }

    private async Task<CanonicalArticleProjectionOutputAggregate> VerifyAsync(
        ProjectionAuthority authority,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(authority);
        cancellationToken.ThrowIfCancellationRequested();
        var violations = new List<string>();
        VerifyAuthorityEnvelope(authority, violations);
        if (violations.Count > 0)
        {
            throw new CanonicalArticleProjectionVerificationException(
                violations.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray());
        }

        string[] eventIds = authority.Operations
            .Select(static operation => operation.OutboxEventId)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        List<ArticleMutationOutboxEvent> outboxEvents = eventIds.Length == 0
            ? []
            : await db.Queryable<ArticleMutationOutboxEvent>()
                .Where(item => eventIds.Contains(item.EventId))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
        long[] outboxIds = outboxEvents.Select(static item => item.Id).ToArray();
        List<ArticleMutationOutboxEdge> edgeRows = outboxIds.Length == 0
            ? []
            : await db.Queryable<ArticleMutationOutboxEdge>()
                .Where(item => outboxIds.Contains(item.OutboxEventId))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

        ProjectionOperation currentOperation = authority.Operations[^1];
        OutboxVerification outboxVerification = VerifyOutboxState(authority, outboxEvents, edgeRows);
        violations.AddRange(outboxVerification.Violations);
        ArticleMutationOutboxEvent? currentOutbox = outboxVerification.CurrentOutbox;
        var observations = new List<CanonicalArticleProjectionEdgeObservation>();

        CanonicalArticleProjectionCoordinates coordinates = CurrentCoordinates(authority);
        ProjectionOutputs outputs = await ReadOutputsAsync(
                authority,
                currentOutbox,
                coordinates,
                cancellationToken)
            .ConfigureAwait(false);
        violations.AddRange(outputs.Violations);

        if (currentOutbox is not null
            && outboxVerification.EdgesByOutboxId.TryGetValue(
                currentOutbox.Id,
                out ArticleMutationOutboxEdge[]? currentEdges))
        {
            foreach (string edgeName in ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal))
            {
                ArticleMutationOutboxEdge[] matching = currentEdges.Where(
                    item => string.Equals(item.EdgeName, edgeName, StringComparison.Ordinal)).ToArray();
                if (matching.Length != 1)
                {
                    continue;
                }
                ArticleMutationOutboxEdge edge = matching[0];

                string outputDigest = outputs.DigestFor(edgeName);
                long generation = outputs.GenerationFor(edgeName, currentOutbox.Id);
                string deliveryKey = edge.DeliveryKey ?? string.Empty;
                var observation = new CanonicalArticleProjectionEdgeObservation(
                    currentOutbox.EventId,
                    currentOutbox.SchemaVersion,
                    edge.EdgeName,
                    $"production-outbox:{edge.EdgeName}",
                    edge.Status,
                    edge.AttemptCount,
                    generation,
                    deliveryKey,
                    currentOperation.OutboxPayloadDigest,
                    outputDigest,
                    coordinates,
                    string.Empty);
                observations.Add(observation with
                {
                    TerminalReceiptDigest = ComputeTerminalReceiptDigest(observation)
                });
            }
        }

        string[] requiredEdges = ArticleMutationReplayEdges.Required
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] failures = violations.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var aggregate = new CanonicalArticleProjectionOutputAggregate(
            Schema,
            authority.RunId,
            authority.Namespace,
            authority.ReceiptDigest,
            ArticleMutationReplayEdges.ContractId,
            requiredEdges,
            coordinates,
            outputs.PubliclyVisible,
            authority.ContentDigest,
            outputs.SearchDigest,
            outputs.AotDigest,
            outputs.RevocationDigest,
            outputs.AedsDigest,
            outputs.HotReadDigest,
            outputs.PublicListDigest,
            outputs.PublicDetailDigest,
            outputs.CacheDigest,
            observations,
            failures,
            string.Empty);
        aggregate = aggregate with
        {
            AggregateDigest = ComputeAggregateDigest(aggregate)
        };

        VerifyAggregate(aggregate, authority, violations);
        if (violations.Count > 0)
        {
            throw new CanonicalArticleProjectionVerificationException(
                violations.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray());
        }
        cancellationToken.ThrowIfCancellationRequested();
        return aggregate;
    }

    public static void VerifyAggregate(
        CanonicalArticleProjectionOutputAggregate aggregate,
        CanonicalArticleLifecycleReceipt authority)
        => VerifyAggregate(aggregate, ProjectionAuthority.From(authority));

    public static void VerifyAggregate(
        CanonicalArticleProjectionOutputAggregate aggregate,
        CanonicalArticlePublicationReceipt authority)
        => VerifyAggregate(aggregate, ProjectionAuthority.From(authority));

    private static void VerifyAggregate(
        CanonicalArticleProjectionOutputAggregate aggregate,
        ProjectionAuthority authority)
    {
        var violations = new List<string>();
        VerifyAuthorityEnvelope(authority, violations);
        if (violations.Count > 0)
        {
            throw new CanonicalArticleProjectionVerificationException(violations);
        }
        VerifyAggregate(aggregate, authority, violations);
        if (violations.Count > 0)
        {
            throw new CanonicalArticleProjectionVerificationException(violations);
        }
    }

    public static string ComputeAggregateDigest(CanonicalArticleProjectionOutputAggregate aggregate)
    {
        ArgumentNullException.ThrowIfNull(aggregate);
        return Digest(new
        {
            aggregate.Schema,
            aggregate.RunId,
            aggregate.Namespace,
            aggregate.AuthorityReceiptDigest,
            aggregate.RequiredEdgeContractId,
            aggregate.RequiredEdges,
            aggregate.CurrentCoordinates,
            aggregate.PubliclyVisible,
            aggregate.ContentDigest,
            aggregate.SearchDigest,
            aggregate.AotDigest,
            aggregate.RevocationDigest,
            aggregate.AedsDigest,
            aggregate.HotReadDigest,
            aggregate.PublicListDigest,
            aggregate.PublicDetailDigest,
            aggregate.CacheDigest,
            aggregate.Edges,
            aggregate.Failures
        });
    }

    public static string ComputeTerminalReceiptDigest(
        CanonicalArticleProjectionEdgeObservation observation)
    {
        ArgumentNullException.ThrowIfNull(observation);
        return Digest(new
        {
            observation.EventId,
            observation.EventVersion,
            observation.Owner,
            observation.EdgeName,
            observation.Status,
            observation.AttemptCount,
            observation.Generation,
            observation.DeliveryKey,
            observation.InputDigest,
            observation.OutputDigest,
            observation.Coordinates
        });
    }

    internal static IReadOnlyList<string> VerifyOutboxStateForTests(
        CanonicalArticleLifecycleReceipt authority,
        IReadOnlyList<ArticleMutationOutboxEvent> outboxEvents,
        IReadOnlyList<ArticleMutationOutboxEdge> edgeRows)
        => VerifyOutboxState(ProjectionAuthority.From(authority), outboxEvents, edgeRows).Violations;

    internal static IReadOnlyList<string> VerifyOutboxStateForTests(
        CanonicalArticlePublicationReceipt authority,
        IReadOnlyList<ArticleMutationOutboxEvent> outboxEvents,
        IReadOnlyList<ArticleMutationOutboxEdge> edgeRows)
        => VerifyOutboxState(ProjectionAuthority.From(authority), outboxEvents, edgeRows).Violations;

    private static OutboxVerification VerifyOutboxState(
        ProjectionAuthority authority,
        IReadOnlyList<ArticleMutationOutboxEvent> outboxEvents,
        IReadOnlyList<ArticleMutationOutboxEdge> edgeRows)
    {
        var violations = new List<string>();
        var outboxByEventId = outboxEvents
            .GroupBy(static item => item.EventId, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToArray(), StringComparer.Ordinal);
        var edgesByOutboxId = edgeRows
            .GroupBy(static item => item.OutboxEventId)
            .ToDictionary(static group => group.Key, static group => group.ToArray());
        ArticleMutationOutboxEvent? currentOutbox = null;
        for (int operationIndex = 0; operationIndex < authority.Operations.Count; operationIndex++)
        {
            ProjectionOperation operation = authority.Operations[operationIndex];
            bool isCurrent = operationIndex == authority.Operations.Count - 1;
            if (!outboxByEventId.TryGetValue(operation.OutboxEventId, out ArticleMutationOutboxEvent[]? matching)
                || matching.Length != 1)
            {
                violations.Add($"outbox_event_not_exact:{operation.OutboxEventId}");
                continue;
            }

            ArticleMutationOutboxEvent outbox = matching[0];
            VerifyOutboxCoordinates(authority, operation, outbox, violations);
            if (isCurrent)
            {
                currentOutbox = outbox;
            }

            if (!edgesByOutboxId.TryGetValue(outbox.Id, out ArticleMutationOutboxEdge[]? persistedEdges))
            {
                violations.Add($"required_edges_missing:{outbox.EventId}");
                continue;
            }

            VerifyRequiredEdgeVector(
                outbox,
                operation,
                isCurrent,
                authority.Operations.Skip(operationIndex + 1).ToArray(),
                persistedEdges,
                violations);
        }

        return new OutboxVerification(currentOutbox, edgesByOutboxId, violations);
    }

    private async Task<ProjectionOutputs> ReadOutputsAsync(
        ProjectionAuthority authority,
        ArticleMutationOutboxEvent? currentOutbox,
        CanonicalArticleProjectionCoordinates coordinates,
        CancellationToken cancellationToken)
    {
        var violations = new List<string>();
        Article? row = await db.Queryable<Article>()
            .ClearFilter()
            .Where(item => item.Id == authority.ArticleId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (row is null)
        {
            violations.Add("article_missing");
            return ProjectionOutputs.Invalid(violations);
        }

        bool publiclyVisible = ArticlePublication.IsPubliclyVisible(
            row,
            timeProvider.GetUtcNow().UtcDateTime);
        if (row.CurrentRevisionId != coordinates.RevisionId
            || row.CurrentPublicationId != coordinates.PublicationId
            || publiclyVisible != authority.PubliclyVisible)
        {
            violations.Add("article_authority_coordinate_mismatch");
        }
        ArticleRevision? revision = await db.Queryable<ArticleRevision>()
            .Where(item => item.Id == coordinates.RevisionId && item.ArticleId == authority.ArticleId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (revision is null || revision.RevisionNo != coordinates.RevisionNo)
        {
            violations.Add("sealed_revision_missing_or_invalid");
            return ProjectionOutputs.Invalid(violations);
        }
        ArticleRightsSnapshot? sealedRights = await db.Queryable<ArticleRightsSnapshot>()
            .Where(item => item.Id == coordinates.RightsSnapshotId
                && item.ArticleId == authority.ArticleId
                && item.ArticleRevisionId == coordinates.RevisionId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (sealedRights is null || sealedRights.RevisionNo != coordinates.RevisionNo)
        {
            violations.Add("sealed_rights_snapshot_missing_or_invalid");
        }
        if (!string.Equals(row.Title, revision.Title, StringComparison.Ordinal)
            || !string.Equals(row.Summary, revision.Summary, StringComparison.Ordinal)
            || !string.Equals(row.CoverImageUrl, revision.CoverImageUrl, StringComparison.Ordinal)
            || row.CategoryId != revision.CategoryId)
        {
            violations.Add("article_latest_metadata_disagrees_with_sealed_revision");
        }
        string query = revision.Title;
        List<Article> searchHits = await searchIndex.SearchAsync(query).ConfigureAwait(false);
        Article? searchHit = searchHits.SingleOrDefault(item => item.Id == authority.ArticleId);
        if (searchIndex is not ISearchProjectionEvidenceReader searchEvidenceReader)
        {
            violations.Add("search_projection_evidence_reader_missing");
            return ProjectionOutputs.Invalid(violations);
        }
        SearchProjectionEvidence searchEvidence = await searchEvidenceReader
            .ReadAsync(authority.ArticleId, cancellationToken)
            .ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(searchEvidence.Generation)
            || !IsDigest(searchEvidence.ArtifactDigest)
            || !IsDigest(searchEvidence.DocumentDigest))
        {
            violations.Add("search_projection_receipt_invalid");
        }
        string searchDigest = Digest(new
        {
            QueryVisible = searchHit is not null,
            QueryTitleDigest = searchHit is null ? null : DigestText(searchHit.Title),
            Evidence = searchEvidence,
            AuthorityContentDigest = authority.ContentDigest
        });

        PublicArticleProjectionReadResult projection = await projectionStore
            .TryReadAsync(authority.ArticleId, cancellationToken)
            .ConfigureAwait(false);
        if (projection.Status is PublicArticleProjectionReadStatus.Invalid
            or PublicArticleProjectionReadStatus.Unavailable)
        {
            violations.Add("aeds_projection_read_failed");
        }
        ArticleDetailAedsArtifact artifact = await artifactStore
            .TryReadAsync(authority.ArticleId, cancellationToken)
            .ConfigureAwait(false);
        PublicHotReadSnapshot hotSnapshot = hotReadStore.Current;
        bool hotFound = hotSnapshot.TryGetArticle(authority.ArticleId, out PublicBinaryArtifact hotArtifact);

        string projectionFrameDigest = projection.Found ? DigestBytes(projection.Frame.Span) : DigestText("absent");
        string artifactFrameDigest = artifact.Found ? DigestBytes(artifact.Frame.Span) : DigestText("absent");
        string hotFrameDigest = hotFound ? DigestBytes(hotArtifact.Frame.Span) : DigestText("absent");
        if (publiclyVisible && projection.Found)
        {
            violations.AddRange(VerifyAedsArticleDetailFrame(
                projection.Frame,
                coordinates,
                authority.ContentDigest,
                revision));
        }

        ArticleDetailCoreModel? detail = await articles
            .GetByIdAsync(new ArticleDetailQuery(authority.ArticleId), cancellationToken)
            .ConfigureAwait(false);

        CorePageResult<ArticleListCoreModel> list = await articles.GetPageListAsync(
                new ArticlePageQuery(
                    1,
                    100,
                    row.CategoryId,
                    null,
                    IsDeleted: false,
                    Status: (int)ArticleStatus.Published,
                    UseSourceCache: true),
                cancellationToken)
            .ConfigureAwait(false);
        ArticleListCoreModel? listItem = list.Items
            .Where(item => item.Id == authority.ArticleId)
            .Select(static item => (ArticleListCoreModel?)item)
            .SingleOrDefault();
        if (detail is ArticleDetailCoreModel metadataDetail
            && !MetadataMatches(revision, metadataDetail.Title, metadataDetail.Summary,
                metadataDetail.CoverImageUrl, metadataDetail.CategoryId, metadataDetail.Tags))
        {
            violations.Add("public_detail_metadata_mismatch");
        }
        if (listItem is ArticleListCoreModel metadataList
            && !MetadataMatches(revision, metadataList.Title, metadataList.Summary,
                metadataList.CoverImageUrl, metadataList.Category.Id, metadataList.Tags))
        {
            violations.Add("public_list_metadata_mismatch");
        }

        PublicAotInvalidationGenerationState aotState = await aotGenerationAuthority
            .LoadAsync(cancellationToken)
            .ConfigureAwait(false);
        violations.AddRange(VerifyProjectionConsistency(
            new CanonicalArticleProjectionConsistencyEvidence(
                publiclyVisible,
                searchHit is not null,
                searchHit is null || string.Equals(searchHit.Title, revision.Title, StringComparison.Ordinal),
                searchEvidence,
                coordinates,
                DigestText(revision.Title),
                projection.Found,
                artifact.Found,
                hotFound,
                hotSnapshot.PublicationEvidence.IsVerifiedFor(hotSnapshot.Version),
                projectionFrameDigest,
                artifactFrameDigest,
                hotFrameDigest,
                detail is ArticleDetailCoreModel detailValue
                    ? new CanonicalArticleProjectionVersionCoordinates(
                        detailValue.CurrentRevisionId,
                        detailValue.RevisionNo,
                        detailValue.CurrentPublicationId,
                        detailValue.PublicationNo)
                    : null,
                detail is ArticleDetailCoreModel contentValue
                    ? DigestText(contentValue.Content)
                    : null,
                detail is ArticleDetailCoreModel rightsValue
                    ? rightsValue.Rights.SnapshotId
                    : null,
                listItem is ArticleListCoreModel listValue
                    ? new CanonicalArticleProjectionVersionCoordinates(
                        listValue.CurrentRevisionId,
                        listValue.RevisionNo,
                        listValue.CurrentPublicationId,
                        listValue.PublicationNo)
                    : null,
                authority.ContentDigest,
                aotState.LastMutationId,
                currentOutbox?.EventId)));
        try
        {
            PublicAotInvalidationGenerationStateCodec.Validate(aotState);
        }
        catch (InvalidOperationException)
        {
            violations.Add("aot_generation_digest_invalid");
        }
        string aotArticleKey = runtimeKeyScope.PrefixKey(CacheKeyBuilder.PublicAotDocument(
            PublicPageId.ArticleDetail, PublicRouteIdentity.BuildArticleRouteKey(authority.ArticleId)));
        string aotPagePrefix = runtimeKeyScope.PrefixKey(CacheKeyBuilder.PublicAotDocument(
            PublicPageId.ArticleDetail, string.Empty));
        long aotGeneration = aotState.Current(aotArticleKey, aotPagePrefix);
        if (aotGeneration <= 0)
        {
            violations.Add("aot_generation_missing");
        }
        if (aotGeneration != aotState.AllGeneration)
        {
            violations.Add("aot_article_generation_mismatch");
        }

        AotOutputObservation aotOutput = await ReadAotOutputAsync(
            authority, coordinates, revision, sealedRights, aotGeneration, cancellationToken).ConfigureAwait(false);
        violations.AddRange(aotOutput.Violations);
        PublicAotInvalidationGenerationState aotAfterRead = await aotGenerationAuthority
            .LoadAsync(cancellationToken).ConfigureAwait(false);
        if (aotAfterRead.ContentDigest != aotState.ContentDigest)
        {
            violations.Add("aot_generation_changed_during_observation");
        }

        IReadOnlyList<PublicArtifactTombstone> activeRevocations = await revocationState
            .LoadActiveAsync(cancellationToken)
            .ConfigureAwait(false);
        bool activeForArticle = activeRevocations.Any(item =>
            item.TargetKind == PublicArtifactRevocationTargetKind.ExactArticle
            && item.ArticleId == authority.ArticleId);
        if (activeForArticle)
        {
            violations.Add("public_artifact_revocation_not_completed");
        }
        long revocationGeneration = revocationRegistry.CurrentGeneration;
        if (revocationGeneration <= 0)
        {
            violations.Add("public_artifact_revocation_generation_missing");
        }

        string? cacheVersionText = await cacheReader
            .GetStringAsync(CachePolicyId.ArticleListVersion, "main", cancellationToken)
            .ConfigureAwait(false);
        if (!long.TryParse(cacheVersionText, NumberStyles.None, CultureInfo.InvariantCulture, out long cacheVersion)
            || cacheVersion <= 0)
        {
            violations.Add("article_list_cache_version_invalid");
        }

        string aedsDigest = Digest(new
        {
            projection.Status,
            projection.Version,
            projection.ETag,
            ProjectionFrameDigest = projectionFrameDigest,
            ArtifactFrameDigest = artifactFrameDigest
        });
        string hotReadDigest = Digest(new
        {
            SnapshotVersion = hotSnapshot.Version,
            hotSnapshot.PublicationEvidence,
            Found = hotFound,
            FrameDigest = hotFrameDigest,
            hotArtifact.ETag,
            ArtifactVersion = hotArtifact.Version
        });
        string publicListDigest = Digest(new
        {
            Visible = listItem.HasValue,
            listItem?.Id,
            listItem?.Title,
            listItem?.Summary,
            listItem?.CoverImageUrl,
            listItem?.Category,
            listItem?.Tags,
            listItem?.CurrentRevisionId,
            listItem?.RevisionNo,
            listItem?.CurrentPublicationId,
            listItem?.PublicationNo
        });
        string publicDetailDigest = Digest(new
        {
            Visible = detail.HasValue,
            detail?.Id,
            detail?.Title,
            detail?.Summary,
            detail?.CoverImageUrl,
            detail?.Category,
            detail?.Tags,
            detail?.CurrentRevisionId,
            detail?.RevisionNo,
            detail?.CurrentPublicationId,
            detail?.PublicationNo,
            ContentDigest = detail.HasValue ? DigestText(detail.Value.Content) : null,
            RightsSnapshotId = detail.HasValue ? (long?)detail.Value.Rights.SnapshotId : null
        });
        string aotDigest = Digest(new
        {
            aotState.RuntimeScope,
            aotState.AllGeneration,
            aotState.KeyGenerations,
            aotState.PrefixGenerations,
            aotState.LastMutationId,
            aotState.ContentDigest,
            ArticleKey = aotArticleKey,
            PagePrefix = aotPagePrefix,
            AppliedGeneration = aotGeneration,
            aotOutput.DocumentDigest,
            aotOutput.BootstrapDigest,
            aotOutput.HydrationDigest
        });
        string revocationDigest = Digest(new
        {
            Generation = revocationGeneration,
            ArticleId = authority.ArticleId,
            ActiveForArticle = activeForArticle,
            ActiveDigest = Digest(activeRevocations
                .OrderBy(static item => item.TargetKind)
                .ThenBy(static item => item.ArticleId)
                .ThenBy(static item => item.Scope)
                .ThenBy(static item => item.Generation)
                .ToArray())
        });
        string cacheDigest = Digest(new
        {
            ArticleListVersion = cacheVersion,
            ListDigest = publicListDigest,
            DetailDigest = publicDetailDigest
        });

        return new ProjectionOutputs(
            publiclyVisible,
            searchDigest,
            aotDigest,
            revocationDigest,
            aedsDigest,
            hotReadDigest,
            publicListDigest,
            publicDetailDigest,
            cacheDigest,
            new DateTimeOffset(DateTime.SpecifyKind(searchEvidence.GeneratedAtUtc, DateTimeKind.Utc))
                .ToUnixTimeMilliseconds(),
            aotGeneration,
            revocationGeneration,
            projection.Version,
            hotSnapshot.Version,
            cacheVersion,
            violations);
    }

    private async Task<AotOutputObservation> ReadAotOutputAsync(
        ProjectionAuthority authority,
        CanonicalArticleProjectionCoordinates coordinates,
        ArticleRevision revision,
        ArticleRightsSnapshot? sealedRights,
        long generation,
        CancellationToken cancellationToken)
    {
        var violations = new List<string>();
        HttpContext? context = httpContextAccessor.HttpContext;
        if (context is null)
        {
            return new AotOutputObservation(null, null, null, ["aot_current_request_scope_missing"]);
        }
        string routeKey = PublicRouteIdentity.BuildArticleRouteKey(authority.ArticleId);
        string routePath = PublicRouteIdentity.BuildCanonicalPath(PublicPageId.ArticleDetail, routeKey, authority.ArticleId);
        var match = new PublicAotRouteMatch(PublicPageKind.ArticleDetail, PublicPageId.ArticleDetail,
            routeKey, routePath, routePath, string.Empty);
        PublicAotArtifactLookup lookup = aotArtifactStore.CreateLookup(context, match);
        PublicAotCacheEntry? entry = await aotArtifactStore.TryGetEntryAsync(lookup, cancellationToken).ConfigureAwait(false);
        if (!authority.PubliclyVisible)
        {
            if (entry is not null)
            {
                violations.Add("aot_document_visibility_mismatch");
            }
            return new AotOutputObservation(DigestText("absent"), null, null, violations);
        }
        if (entry is null)
        {
            return new AotOutputObservation(null, null, null, ["aot_current_document_missing"]);
        }
        if (!aotArtifactStore.IsRenderable(entry, lookup)
            || lookup.UsesDevelopmentSourceAssets
            || entry.CacheKey != lookup.DocumentCacheKey
            || entry.PageId != PublicPageId.ArticleDetail
            || entry.RouteKey != routeKey
            || !lookup.DocumentCacheKey.EndsWith(":iv:" + generation.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)
            || entry.ExpiresAtUtc <= timeProvider.GetUtcNow())
        {
            violations.Add("aot_current_document_identity_mismatch");
        }
        string html = entry.GetHtml();
        string documentDigest = DigestBytes(entry.GetDocument().Utf8Bytes.Span);
        if (!entry.GetDocument().Utf8Bytes.Span.SequenceEqual(Encoding.UTF8.GetBytes(html)))
        {
            violations.Add("aot_document_bytes_disagree");
        }
        // Parse the actual browser document tree with a standalone parser, no resource
        // loader or script engine. Scripting mode only selects browser-compatible noscript parsing.
        using var document = await new HtmlParser(new HtmlParserOptions { IsScripting = true })
            .ParseDocumentAsync(html, cancellationToken).ConfigureAwait(false);
        IElement? bootstrapNode = FindUniqueDataScript(document, "fsus-aot-bootstrap");
        string? bootstrapDigest = null;
        if (bootstrapNode is null
            || !PublicAotBinaryPayload.TryDecodeObject(bootstrapNode.TextContent,
                out Dictionary<string, object?> bootstrap))
        {
            violations.Add("aot_bootstrap_payload_invalid");
        }
        else
        {
            bootstrapDigest = Digest(bootstrap);
            violations.AddRange(VerifyAotArticleOutput(bootstrap, coordinates, authority.ContentDigest, revision, sealedRights));
        }
        string? hydrationDigest = null;
        IElement? hydrationNode = FindUniqueDataScript(document, "fsus-aot-hydration-props");
        if (hydrationNode is null
            || !string.IsNullOrWhiteSpace(hydrationNode.TextContent)
            || !PublicAotHydrationSidecarReference.TryFromUrl(hydrationNode.GetAttribute("data-aeds-src"),
                out PublicAotHydrationSidecarReference sidecar)
            || hydrationNode.GetAttribute("data-aeds-src") != sidecar.Url)
        {
            violations.Add("aot_hydration_reference_missing");
        }
        else
        {
            PublicArtifactKey key = PublicArtifactKey.HydrationSidecar(routeKey, sidecar.Sha256Hex, entry.FrontendAssetVersion);
            PublicArtifactReadResult? hydration = await publicArtifactStorage.TryReadAsync(
                key, LocalPublicArtifactStorage.AedsMediaType, sidecar.Sha256Hex, cancellationToken).ConfigureAwait(false);
            if (hydration is null
                || hydration.Descriptor.Key != key
                || hydration.Descriptor.Sha256Hex != sidecar.Sha256Hex
                || DigestBytes(hydration.Content.Span) != "sha256:" + sidecar.Sha256Hex
                || !PublicAotBinaryPayload.TryDecodeObject(hydration.Content, out Dictionary<string, object?> payload)
                || PublicAotDocumentComposer.BuildPayloadSidecarUrl(Convert.ToBase64String(hydration.Content.Span)) != sidecar.Url)
            {
                violations.Add("aot_hydration_payload_invalid");
            }
            else
            {
                hydrationDigest = DigestBytes(hydration.Content.Span);
                IReadOnlyDictionary<string, object?>? rights = PublicAotBinaryPayload.TryGetObject(payload, "rights");
                if (PublicAotBinaryPayload.TryGetString(payload, "articleId") != authority.ArticleId.ToString(CultureInfo.InvariantCulture)
                    || !AotVersionCoordinatesMatch(payload, coordinates)
                    || DigestText(PublicAotBinaryPayload.TryGetString(payload, "bodyContent")) != authority.ContentDigest
                    || PublicAotBinaryPayload.TryGetString(payload, "title") != revision.Title
                    || rights is null
                    || !AotRightsMatch(rights, coordinates, sealedRights))
                {
                    violations.Add("aot_hydration_semantic_mismatch");
                }
            }
        }
        return new AotOutputObservation(documentDigest, bootstrapDigest, hydrationDigest, violations);
    }

    private static IElement? FindUniqueDataScript(IDocument document, string id)
    {
        // document.All excludes inert template contents, comments and raw-text pseudo-tags.
        IElement[] matches = document.All.Where(node => node.GetAttribute("id") == id).ToArray();
        return matches.Length == 1
            && matches[0].NamespaceUri == "http://www.w3.org/1999/xhtml"
            && matches[0].LocalName == "script"
            && matches[0].GetAttribute("type") == "application/octet-stream"
            && !matches[0].HasAttribute("src")
            ? matches[0] : null;
    }

    private static bool AotVersionCoordinatesMatch(
        IReadOnlyDictionary<string, object?> article,
        CanonicalArticleProjectionCoordinates coordinates)
        => PublicAotBinaryPayload.TryGetString(article, "currentRevisionId") == coordinates.RevisionId.ToString(CultureInfo.InvariantCulture)
            && PublicAotBinaryPayload.TryGetString(article, "revisionNo") == coordinates.RevisionNo.ToString(CultureInfo.InvariantCulture)
            && PublicAotBinaryPayload.TryGetString(article, "currentPublicationId") == coordinates.PublicationId?.ToString(CultureInfo.InvariantCulture)
            && PublicAotBinaryPayload.TryGetString(article, "publicationNo") == coordinates.PublicationNo?.ToString(CultureInfo.InvariantCulture);

    private static IReadOnlyList<string> VerifyAotArticleOutput(
        IReadOnlyDictionary<string, object?> bootstrap,
        CanonicalArticleProjectionCoordinates coordinates,
        string contentDigest,
        ArticleRevision? revision = null,
        ArticleRightsSnapshot? sealedRights = null)
    {
        var violations = new List<string>();
        IReadOnlyDictionary<string, object?>? article = PublicAotBinaryPayload.TryGetObject(bootstrap, "article");
        if (article is null)
        {
            return ["aot_article_output_missing"];
        }
        // A producer that omits publication coordinates cannot prove a current publication.
        if (PublicAotBinaryPayload.TryGetString(article, "id") != coordinates.ArticleId.ToString(CultureInfo.InvariantCulture)
            || !AotVersionCoordinatesMatch(article, coordinates))
        {
            violations.Add("aot_article_output_coordinate_mismatch");
        }
        if (DigestText(PublicAotBinaryPayload.TryGetString(article, "content")) != contentDigest)
        {
            violations.Add("aot_article_output_content_digest_mismatch");
        }
        IReadOnlyDictionary<string, object?>? rights = PublicAotBinaryPayload.TryGetObject(article, "rights");
        if (rights is null || !AotRightsMatch(rights, coordinates, sealedRights))
        {
            violations.Add("aot_article_output_rights_mismatch");
        }
        if (revision is not null)
        {
            IReadOnlyDictionary<string, object?>? category = PublicAotBinaryPayload.TryGetObject(article, "category");
            article.TryGetValue("tags", out object? rawTags);
            object?[] tags = rawTags as object?[] ?? [];
            string tagIds = string.Join(',', tags.OfType<IReadOnlyDictionary<string, object?>>()
                .Select(tag => PublicAotBinaryPayload.TryGetString(tag, "id"))
                .OrderBy(id => int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out int value) ? value : -1));
            if (PublicAotBinaryPayload.TryGetString(article, "title") != revision.Title
                || PublicAotBinaryPayload.TryGetString(article, "summary") != (revision.Summary ?? string.Empty)
                || PublicAotBinaryPayload.TryGetString(article, "coverImageUrl") != (revision.CoverImageUrl ?? string.Empty)
                || category is null
                || PublicAotBinaryPayload.TryGetString(category, "id") != revision.CategoryId.ToString(CultureInfo.InvariantCulture)
                || tagIds != (revision.TagIds ?? string.Empty)
                || tags.OfType<IReadOnlyDictionary<string, object?>>().Any(tag =>
                    !int.TryParse(PublicAotBinaryPayload.TryGetString(tag, "id"), NumberStyles.None,
                        CultureInfo.InvariantCulture, out int tagId) || tagId <= 0)
                || tags.Length != tags.OfType<IReadOnlyDictionary<string, object?>>().Count())
            {
                violations.Add("aot_article_output_metadata_mismatch");
            }
        }
        return violations;
    }

    private static bool AotRightsMatch(
        IReadOnlyDictionary<string, object?> rights,
        CanonicalArticleProjectionCoordinates coordinates,
        ArticleRightsSnapshot? sealedRights)
    {
        if (PublicAotBinaryPayload.TryGetString(rights, "snapshotId") != coordinates.RightsSnapshotId?.ToString(CultureInfo.InvariantCulture)
            || PublicAotBinaryPayload.TryGetString(rights, "articleRevisionId") != coordinates.RevisionId.ToString(CultureInfo.InvariantCulture)
            || PublicAotBinaryPayload.TryGetString(rights, "revisionNo") != coordinates.RevisionNo.ToString(CultureInfo.InvariantCulture))
        {
            return false;
        }
        if (sealedRights is null)
        {
            return true;
        }
        JsonElement expected = JsonSerializer.SerializeToElement(new
        {
            sealedRights.Enabled,
            sealedRights.LicenseType,
            sealedRights.CopyrightHolder,
            sealedRights.CopyrightYear,
            sealedRights.RightsStatement,
            sealedRights.AttributionTemplate,
            sealedRights.CopyPolicy,
            sealedRights.MaxExcerptChars,
            sealedRights.AllowCodeCopy,
            sealedRights.ShowPublicBadge,
            sealedRights.ProofBindingEnabled,
            sealedRights.CanonicalUrl,
            sealedRights.PolicyHash,
            sealedRights.ContentCanonicalHash
        }, s_json);
        foreach (JsonProperty property in expected.EnumerateObject())
        {
            if (!rights.TryGetValue(property.Name, out object? actual)
                || !JsonElement.DeepEquals(property.Value, JsonSerializer.SerializeToElement(actual, s_json)))
            {
                return false;
            }
        }
        return true;
    }

    private sealed record AotOutputObservation(
        string? DocumentDigest,
        string? BootstrapDigest,
        string? HydrationDigest,
        IReadOnlyList<string> Violations);

    internal static IReadOnlyList<string> VerifyProjectionConsistencyForTests(
        CanonicalArticleProjectionConsistencyEvidence evidence)
        => VerifyProjectionConsistency(evidence);

    internal static IReadOnlyList<string> VerifyAedsArticleDetailFrameForTests(
        ReadOnlyMemory<byte> frame,
        CanonicalArticleProjectionCoordinates coordinates,
        string expectedContentDigest)
        => VerifyAedsArticleDetailFrame(frame, coordinates, expectedContentDigest);

    private static IReadOnlyList<string> VerifyAedsArticleDetailFrame(
        ReadOnlyMemory<byte> frame,
        CanonicalArticleProjectionCoordinates coordinates,
        string expectedContentDigest,
        ArticleRevision? revision = null)
    {
        var violations = new List<string>();
        var decodedFrame = new AedsEncoder().TryDecode(frame);
        if (!decodedFrame.IsSuccess
            || decodedFrame.Value.FrameType != AedsFrameType.ArticleDetail
            || !PodBinaryCodec.TryDecodeArticleDetail(
                decodedFrame.Value.Payload,
                out ArticleDetailCoreModel detail))
        {
            violations.Add("aeds_article_detail_frame_invalid");
            return violations;
        }
        if (detail.Id != coordinates.ArticleId
            || detail.CurrentRevisionId != coordinates.RevisionId
            || detail.RevisionNo != coordinates.RevisionNo
            || detail.CurrentPublicationId != coordinates.PublicationId
            || detail.PublicationNo != coordinates.PublicationNo)
        {
            violations.Add("aeds_article_detail_coordinate_mismatch");
        }
        if (!string.Equals(
            DigestText(detail.Content),
            expectedContentDigest,
            StringComparison.Ordinal))
        {
            violations.Add("aeds_article_detail_content_digest_mismatch");
        }
        if (coordinates.RightsSnapshotId is > 0
            && detail.Rights.SnapshotId != coordinates.RightsSnapshotId)
        {
            violations.Add("aeds_article_detail_rights_mismatch");
        }
        if (revision is not null
            && !MetadataMatches(revision, detail.Title, detail.Summary, detail.CoverImageUrl,
                detail.CategoryId, detail.Tags))
        {
            violations.Add("aeds_article_detail_metadata_mismatch");
        }
        return violations;
    }

    private static bool MetadataMatches(
        ArticleRevision revision, string title, string? summary, string? coverImageUrl,
        int categoryId, IReadOnlyList<TagCoreModel> tags)
        => string.Equals(title, revision.Title, StringComparison.Ordinal)
            // POD encodes null/empty optional text as the same empty UTF-8 slice.
            && string.Equals(summary ?? string.Empty, revision.Summary ?? string.Empty, StringComparison.Ordinal)
            && string.Equals(coverImageUrl ?? string.Empty, revision.CoverImageUrl ?? string.Empty, StringComparison.Ordinal)
            && categoryId == revision.CategoryId
            && string.Equals(string.Join(',', tags.Select(static tag => tag.Id).Order()),
                revision.TagIds, StringComparison.Ordinal);

    private static IReadOnlyList<string> VerifyProjectionConsistency(
        CanonicalArticleProjectionConsistencyEvidence evidence)
    {
        var violations = new List<string>();
        if (evidence.PubliclyVisible != evidence.SearchQueryFound)
        {
            violations.Add("search_visibility_mismatch");
        }
        if (evidence.SearchQueryFound && !evidence.SearchQueryTitleMatches)
        {
            violations.Add("search_result_title_mismatch");
        }
        if (evidence.PubliclyVisible != evidence.SearchEvidence.Found)
        {
            violations.Add("search_projection_visibility_mismatch");
        }
        if (evidence.SearchEvidence.Found
            && (evidence.SearchEvidence.ArticleId != evidence.ExpectedCoordinates.ArticleId
                || evidence.SearchEvidence.RevisionId != evidence.ExpectedCoordinates.RevisionId
                || evidence.SearchEvidence.RevisionNo != evidence.ExpectedCoordinates.RevisionNo
                || evidence.SearchEvidence.PublicationId != evidence.ExpectedCoordinates.PublicationId
                || evidence.SearchEvidence.PublicationNo != evidence.ExpectedCoordinates.PublicationNo))
        {
            violations.Add("search_projection_coordinate_mismatch");
        }
        if (evidence.SearchEvidence.Found
            && !string.Equals(
                evidence.SearchEvidence.TitleDigest,
                evidence.ExpectedTitleDigest,
                StringComparison.Ordinal))
        {
            violations.Add("search_projection_metadata_digest_mismatch");
        }
        if (evidence.PubliclyVisible != evidence.AedsProjectionFound)
        {
            violations.Add("aeds_projection_visibility_mismatch");
        }
        if (evidence.PubliclyVisible != evidence.AedsArtifactFound)
        {
            violations.Add("aeds_artifact_visibility_mismatch");
        }
        if (evidence.PubliclyVisible != evidence.HotReadFound)
        {
            violations.Add("hot_read_visibility_mismatch");
        }
        if (evidence.PubliclyVisible
            && (!string.Equals(
                    evidence.AedsProjectionFrameDigest,
                    evidence.AedsArtifactFrameDigest,
                    StringComparison.Ordinal)
                || !string.Equals(
                    evidence.AedsProjectionFrameDigest,
                    evidence.HotReadFrameDigest,
                    StringComparison.Ordinal)))
        {
            violations.Add("aeds_hot_read_frame_digest_mismatch");
        }
        if (evidence.PubliclyVisible && !evidence.HotReadPublicationVerified)
        {
            violations.Add("hot_read_publication_evidence_invalid");
        }
        if (evidence.PubliclyVisible != (evidence.DetailCoordinates is not null))
        {
            violations.Add("public_detail_visibility_mismatch");
        }
        if (evidence.DetailCoordinates is not null
            && !Matches(evidence.DetailCoordinates, evidence.ExpectedCoordinates))
        {
            violations.Add("public_detail_coordinate_mismatch");
        }
        if (evidence.DetailCoordinates is not null
            && !string.Equals(
                evidence.DetailContentDigest,
                evidence.ExpectedContentDigest,
                StringComparison.Ordinal))
        {
            violations.Add("public_detail_content_digest_mismatch");
        }
        if (evidence.DetailCoordinates is not null
            && evidence.ExpectedCoordinates.RightsSnapshotId is > 0
            && evidence.DetailRightsSnapshotId != evidence.ExpectedCoordinates.RightsSnapshotId)
        {
            violations.Add("public_detail_rights_mismatch");
        }
        if (evidence.PubliclyVisible != (evidence.ListCoordinates is not null))
        {
            violations.Add("public_list_visibility_mismatch");
        }
        if (evidence.ListCoordinates is not null
            && !Matches(evidence.ListCoordinates, evidence.ExpectedCoordinates))
        {
            violations.Add("public_list_coordinate_mismatch");
        }
        if (evidence.ExpectedEventId is not null
            && !string.Equals(
                evidence.AotLastMutationId,
                evidence.ExpectedEventId,
                StringComparison.Ordinal))
        {
            violations.Add("aot_event_binding_mismatch");
        }
        return violations;
    }

    private static bool Matches(
        CanonicalArticleProjectionVersionCoordinates actual,
        CanonicalArticleProjectionCoordinates expected)
        => actual.RevisionId == expected.RevisionId
            && actual.RevisionNo == expected.RevisionNo
            && actual.PublicationId == expected.PublicationId
            && actual.PublicationNo == expected.PublicationNo;

    private static void VerifyAuthorityEnvelope(
        ProjectionAuthority authority,
        List<string> violations)
    {
        if (!authority.HasValidReceipt)
        {
            violations.Add("authority_receipt_invalid");
        }
        if (string.IsNullOrWhiteSpace(authority.RunId) || string.IsNullOrWhiteSpace(authority.Namespace))
        {
            violations.Add("authority_current_run_refs_missing");
        }
        if (!authority.HasSealedCurrentRunBinding)
        {
            violations.Add("publication_current_run_binding_missing");
        }
        if (authority.Operations is null || authority.Operations.Count == 0)
        {
            violations.Add("authority_operations_missing");
        }
        if (!IsDigest(authority.ReceiptDigest) || !IsDigest(authority.ContentDigest))
        {
            violations.Add("authority_digest_invalid");
        }
    }

    private static void VerifyOutboxCoordinates(
        ProjectionAuthority authority,
        ProjectionOperation operation,
        ArticleMutationOutboxEvent outbox,
        List<string> violations)
    {
        if (outbox.SchemaVersion != ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion
            || outbox.AggregateId != authority.ArticleId
            || outbox.ArticleRevisionId != operation.AfterRevisionId
            || outbox.RevisionNo != operation.AfterRevisionNo
            || outbox.ArticlePublicationId != operation.AfterPublicationId
            || outbox.PublicationNo != operation.AfterPublicationNo
            || outbox.RightsSnapshotId != operation.RightsSnapshotId
            || outbox.ResponsibilitySnapshotId != operation.ResponsibilitySnapshotId
            || outbox.ResponsibilityVersion != operation.ResponsibilityVersion)
        {
            violations.Add($"outbox_coordinate_mismatch:{outbox.EventId}");
        }
        if (!string.Equals(
                CanonicalArticleLifecycleFixturePort.ComputeOutboxPayloadDigest(outbox.PayloadJson),
                operation.OutboxPayloadDigest,
                StringComparison.Ordinal))
        {
            violations.Add($"outbox_payload_digest_mismatch:{outbox.EventId}");
        }
        try
        {
            ArticleMutationOutboxEnvelope envelope = ArticleMutationOutboxEnvelopeCodec.Read(outbox);
            if (envelope.IsLegacy
                || envelope.ArticleId != authority.ArticleId
                || envelope.Version.RevisionId != operation.AfterRevisionId
                || envelope.Version.RevisionNo != operation.AfterRevisionNo
                || envelope.Version.PublicationId != operation.AfterPublicationId
                || envelope.Version.PublicationNo != operation.AfterPublicationNo
                || envelope.Version.RightsSnapshotId != operation.RightsSnapshotId
                || envelope.Version.ResponsibilitySnapshotId != operation.ResponsibilitySnapshotId
                || envelope.Version.ResponsibilityVersion != operation.ResponsibilityVersion)
            {
                violations.Add($"outbox_payload_uses_unsealed_coordinates:{outbox.EventId}");
            }
        }
        catch
        {
            violations.Add($"outbox_payload_invalid:{outbox.EventId}");
        }
        if (!string.Equals(outbox.Status, "processed", StringComparison.Ordinal)
            || outbox.ProcessedAt is null
            || outbox.LastError is not null)
        {
            violations.Add($"outbox_not_processed:{outbox.EventId}:{outbox.Status}");
        }
    }

    private static void VerifyRequiredEdgeVector(
        ArticleMutationOutboxEvent outbox,
        ProjectionOperation operation,
        bool isCurrent,
        IReadOnlyList<ProjectionOperation> laterOperations,
        IReadOnlyList<ArticleMutationOutboxEdge> persistedEdges,
        List<string> violations)
    {
        if (persistedEdges.Any(edge => !ArticleMutationReplayEdges.All.Contains(edge.EdgeName)))
        {
            violations.Add($"required_edge_vector_unexpected:{outbox.EventId}");
        }
        foreach (string edgeName in ArticleMutationReplayEdges.Required)
        {
            ArticleMutationOutboxEdge[] matching = persistedEdges
                .Where(item => string.Equals(item.EdgeName, edgeName, StringComparison.Ordinal))
                .ToArray();
            if (matching.Length != 1)
            {
                violations.Add($"required_edge_not_exact:{outbox.EventId}:{edgeName}");
                continue;
            }

            ArticleMutationOutboxEdge edge = matching[0];
            bool completed = string.Equals(
                edge.Status,
                ArticleMutationOutboxEdgeStatus.Completed,
                StringComparison.Ordinal);
            bool superseded = !isCurrent
                && string.Equals(edge.Status, ArticleMutationOutboxEdgeStatus.Skipped, StringComparison.Ordinal)
                && IsProductionSupersededReason(edge.LastError, laterOperations);
            bool terminal = completed || superseded;
            if (!terminal)
            {
                violations.Add($"required_edge_not_terminal_success:{outbox.EventId}:{edgeName}:{edge.Status}");
            }
            if (edge.AttemptCount <= 0 || (completed && edge.LastError is not null))
            {
                violations.Add($"required_edge_attempt_invalid:{outbox.EventId}:{edgeName}");
            }
            string expectedDeliveryKey = ArticleMutationDeliveryKey.Build(outbox.EventId, edgeName);
            if (!string.Equals(edge.DeliveryKey, expectedDeliveryKey, StringComparison.Ordinal))
            {
                violations.Add($"required_edge_delivery_key_mismatch:{outbox.EventId}:{edgeName}");
            }
        }

        if (!IsDigest(operation.OutboxPayloadDigest))
        {
            violations.Add($"required_edge_input_digest_invalid:{outbox.EventId}");
        }
    }

    private static bool IsProductionSupersededReason(
        string? reason, IReadOnlyList<ProjectionOperation> laterOperations)
    {
        const string ReleasePrefix = "superseded-by-release:";
        const string RevisionPrefix = "superseded-by-revision:";
        ReadOnlySpan<char> value = reason.AsSpan();
        bool byRelease = value.StartsWith(ReleasePrefix, StringComparison.Ordinal);
        ReadOnlySpan<char> id = byRelease
            ? value[ReleasePrefix.Length..]
            : value.StartsWith(RevisionPrefix, StringComparison.Ordinal)
                ? value[RevisionPrefix.Length..]
                : default;
        return !id.IsEmpty
            && long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out long supersedingId)
            && supersedingId > 0
            && laterOperations.Any(operation => byRelease
                ? operation.AfterPublicationId == supersedingId
                : operation.AfterRevisionId == supersedingId);
    }

    private static CanonicalArticleProjectionCoordinates CurrentCoordinates(
        ProjectionAuthority authority)
    {
        ProjectionOperation current = authority.Operations[^1];
        return new CanonicalArticleProjectionCoordinates(
            authority.ArticleId,
            current.AfterRevisionId,
            current.AfterRevisionNo,
            current.AfterPublicationId,
            current.AfterPublicationNo,
            current.RightsSnapshotId,
            current.ResponsibilitySnapshotId,
            current.ResponsibilityVersion);
    }

    private static void VerifyAggregate(
        CanonicalArticleProjectionOutputAggregate aggregate,
        ProjectionAuthority authority,
        List<string> violations)
    {
        if (!string.Equals(aggregate.Schema, Schema, StringComparison.Ordinal)
            || !string.Equals(aggregate.RunId, authority.RunId, StringComparison.Ordinal)
            || !string.Equals(aggregate.Namespace, authority.Namespace, StringComparison.Ordinal)
            || !string.Equals(aggregate.AuthorityReceiptDigest, authority.ReceiptDigest, StringComparison.Ordinal)
            || !string.Equals(aggregate.ContentDigest, authority.ContentDigest, StringComparison.Ordinal)
            || aggregate.PubliclyVisible != authority.PubliclyVisible
            || aggregate.CurrentCoordinates != CurrentCoordinates(authority))
        {
            violations.Add("projection_aggregate_authority_binding_mismatch");
        }
        if (!IsDigest(aggregate.ContentDigest)
            || !IsDigest(aggregate.SearchDigest)
            || !IsDigest(aggregate.AotDigest)
            || !IsDigest(aggregate.RevocationDigest)
            || !IsDigest(aggregate.AedsDigest)
            || !IsDigest(aggregate.HotReadDigest)
            || !IsDigest(aggregate.PublicListDigest)
            || !IsDigest(aggregate.PublicDetailDigest)
            || !IsDigest(aggregate.CacheDigest))
        {
            violations.Add("projection_aggregate_output_digest_invalid");
        }
        string[] expectedEdges = ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal).ToArray();
        if (!aggregate.RequiredEdges.SequenceEqual(expectedEdges, StringComparer.Ordinal)
            || !string.Equals(
                aggregate.RequiredEdgeContractId,
                ArticleMutationReplayEdges.ContractId,
                StringComparison.Ordinal))
        {
            violations.Add("projection_aggregate_required_edges_mismatch");
        }
        if (aggregate.Failures.Count > 0)
        {
            violations.Add("projection_aggregate_contains_failures");
        }
        if (aggregate.Edges.Count != expectedEdges.Length
            || aggregate.Edges.Select(static edge => edge.EdgeName)
                .Order(StringComparer.Ordinal)
                .SequenceEqual(expectedEdges, StringComparer.Ordinal) is false)
        {
            violations.Add("projection_aggregate_terminal_vector_mismatch");
        }
        if (aggregate.Edges.Any(static edge =>
                !string.Equals(edge.Status, ArticleMutationOutboxEdgeStatus.Completed, StringComparison.Ordinal)
                || edge.EventVersion != ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion
                || edge.AttemptCount <= 0
                || edge.Generation <= 0
                || !IsDigest(edge.InputDigest)
                || !IsDigest(edge.OutputDigest)
                || !IsDigest(edge.TerminalReceiptDigest)))
        {
            violations.Add("projection_aggregate_edge_receipt_invalid");
        }
        ProjectionOperation currentOperation = authority.Operations[^1];
        if (aggregate.Edges.Any(edge =>
                !string.Equals(edge.EventId, currentOperation.OutboxEventId, StringComparison.Ordinal)
                || !string.Equals(edge.Owner, $"production-outbox:{edge.EdgeName}", StringComparison.Ordinal)
                || !string.Equals(edge.InputDigest, currentOperation.OutboxPayloadDigest, StringComparison.Ordinal)
                || !string.Equals(
                    edge.DeliveryKey,
                    ArticleMutationDeliveryKey.Build(currentOperation.OutboxEventId, edge.EdgeName),
                    StringComparison.Ordinal)
                || edge.Coordinates != aggregate.CurrentCoordinates))
        {
            violations.Add("projection_aggregate_edge_authority_binding_mismatch");
        }
        if (aggregate.Edges.Any(edge => !string.Equals(
                edge.TerminalReceiptDigest,
                ComputeTerminalReceiptDigest(edge),
                StringComparison.Ordinal)))
        {
            violations.Add("projection_edge_receipt_tamper_detected");
        }
        if (aggregate.Edges.Any(edge => !string.Equals(
                edge.OutputDigest,
                ExpectedOutputDigest(aggregate, edge.EdgeName),
                StringComparison.Ordinal)))
        {
            violations.Add("projection_edge_output_digest_mismatch");
        }
        if (!string.Equals(
                aggregate.AggregateDigest,
                ComputeAggregateDigest(aggregate),
                StringComparison.Ordinal))
        {
            violations.Add("projection_aggregate_digest_tamper_detected");
        }
    }

    private static string? ExpectedOutputDigest(
        CanonicalArticleProjectionOutputAggregate aggregate,
        string edgeName)
        => edgeName switch
        {
            ArticleMutationReplayEdges.PublicAotInvalidation => aggregate.AotDigest,
            ArticleMutationReplayEdges.HttpCacheInvalidation => aggregate.CacheDigest,
            ArticleMutationReplayEdges.SearchProjection => aggregate.SearchDigest,
            ArticleMutationReplayEdges.ArticleDetailAeds => aggregate.AedsDigest,
            ArticleMutationReplayEdges.TaxonomyProjection => aggregate.PublicListDigest,
            ArticleMutationReplayEdges.PublicArtifactRevocation => aggregate.RevocationDigest,
            ArticleMutationReplayEdges.PublicHotRead => aggregate.HotReadDigest,
            _ => null
        };

    private static string Digest<T>(T value)
        => DigestBytes(JsonSerializer.SerializeToUtf8Bytes(value, s_json));

    private static string DigestText(string value)
        => DigestBytes(Encoding.UTF8.GetBytes(value ?? string.Empty));

    private static string DigestBytes(ReadOnlySpan<byte> value)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

    private static bool IsDigest(string? value)
        => value is { Length: 71 }
            && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private sealed record OutboxVerification(
        ArticleMutationOutboxEvent? CurrentOutbox,
        IReadOnlyDictionary<long, ArticleMutationOutboxEdge[]> EdgesByOutboxId,
        IReadOnlyList<string> Violations);

    private sealed record ProjectionOperation(
        string OutboxEventId,
        string OutboxPayloadDigest,
        long AfterRevisionId,
        int AfterRevisionNo,
        long? AfterPublicationId,
        int? AfterPublicationNo,
        long? RightsSnapshotId,
        long? ResponsibilitySnapshotId,
        int? ResponsibilityVersion);

    private sealed record ProjectionAuthority(
        string RunId,
        string Namespace,
        string ReceiptDigest,
        int ArticleId,
        string ContentDigest,
        bool PubliclyVisible,
        bool HasValidReceipt,
        bool HasSealedCurrentRunBinding,
        IReadOnlyList<ProjectionOperation> Operations)
    {
        public static ProjectionAuthority From(CanonicalArticleLifecycleReceipt receipt)
        {
            ArgumentNullException.ThrowIfNull(receipt);
            bool valid = receipt.Schema == CanonicalArticleLifecycleFixturePort.Schema
                && receipt.WriterContractDigest == CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest
                && receipt.Operations is { Count: > 0 }
                && receipt.RevisionIds is not null
                && receipt.PublicationIds is not null;
            if (valid)
            {
                string expectedDigest = CanonicalArticleLifecycleFixturePort.ComputeReceiptDigest(
                    receipt.WriterContractDigest,
                    receipt.TemporalContextDigest,
                    receipt.RunId,
                    receipt.Namespace,
                    receipt.ProfileId,
                    receipt.SemanticRole,
                    receipt.Variant,
                    receipt.AdminPrincipalId,
                    receipt.ArticleId,
                    receipt.Operations!,
                    receipt.RevisionIds!,
                    receipt.PublicationIds!,
                    receipt.CurrentRevisionId,
                    receipt.CurrentPublicationId,
                    receipt.CurrentStatus,
                    receipt.IsDeleted,
                    receipt.ContentDigest,
                    receipt.RevisionTimelineDigest);
                valid = string.Equals(expectedDigest, receipt.ReceiptDigest, StringComparison.Ordinal);
            }
            return new ProjectionAuthority(
                receipt.RunId,
                receipt.Namespace,
                receipt.ReceiptDigest,
                receipt.ArticleId,
                receipt.ContentDigest,
                receipt.CurrentStatus == ArticleStatus.Published && !receipt.IsDeleted,
                valid,
                true,
                (receipt.Operations ?? []).Select(static operation => new ProjectionOperation(
                    operation.OutboxEventId,
                    operation.OutboxPayloadDigest,
                    operation.AfterRevisionId,
                    operation.AfterRevisionNo,
                    operation.AfterPublicationId,
                    operation.AfterPublicationNo,
                    operation.RightsSnapshotId,
                    operation.ResponsibilitySnapshotId,
                    operation.ResponsibilityVersion)).ToArray());
        }

        public static ProjectionAuthority From(
            CanonicalArticlePublicationReceipt receipt,
            bool hasSealedCurrentRunBinding = false)
        {
            ArgumentNullException.ThrowIfNull(receipt);
            string expectedDigest = CanonicalArticlePublicationFixturePort.ComputeReceiptDigest(
                receipt.WriterContractDigest,
                receipt.ArticleId,
                receipt.RevisionId,
                receipt.PublicationId,
                receipt.RightsSnapshotId,
                receipt.ContentCanonicalHash,
                receipt.PolicyHash,
                receipt.ResponsibilitySnapshotId,
                receipt.OutboxEventId,
                receipt.OutboxPayloadDigest,
                receipt.AuditChainId,
                receipt.AuditRecordHash,
                receipt.ContentDigest);
            bool valid = receipt.Schema == CanonicalArticlePublicationFixturePort.Schema
                && string.Equals(expectedDigest, receipt.ReceiptDigest, StringComparison.Ordinal)
                && receipt.RequiredEdges is not null
                && receipt.RequiredEdges.Order(StringComparer.Ordinal).SequenceEqual(
                    ArticleMutationReplayEdges.Required.Order(StringComparer.Ordinal), StringComparer.Ordinal);
            return new ProjectionAuthority(
                receipt.RunId,
                receipt.Namespace,
                receipt.ReceiptDigest,
                receipt.ArticleId,
                receipt.ContentDigest,
                true,
                valid,
                // Only the original invocation and its exact persisted command can
                // bind these fields; the publication digest does not seal them.
                hasSealedCurrentRunBinding,
                [new ProjectionOperation(
                    receipt.OutboxEventId,
                    receipt.OutboxPayloadDigest,
                    receipt.RevisionId,
                    receipt.RevisionNo,
                    receipt.PublicationId,
                    receipt.PublicationNo,
                    receipt.RightsSnapshotId,
                    receipt.ResponsibilitySnapshotId,
                    receipt.ResponsibilityVersion)]);
        }
    }

    private sealed record ProjectionOutputs(
        bool PubliclyVisible,
        string SearchDigest,
        string AotDigest,
        string RevocationDigest,
        string AedsDigest,
        string HotReadDigest,
        string PublicListDigest,
        string PublicDetailDigest,
        string CacheDigest,
        long SearchGeneration,
        long AotGeneration,
        long RevocationGeneration,
        long AedsGeneration,
        long HotReadGeneration,
        long CacheGeneration,
        IReadOnlyList<string> Violations)
    {
        public static ProjectionOutputs Invalid(IReadOnlyList<string> violations)
            => new(
                false,
                DigestText("invalid-search"),
                DigestText("invalid-aot"),
                DigestText("invalid-revocation"),
                DigestText("invalid-aeds"),
                DigestText("invalid-hot-read"),
                DigestText("invalid-list"),
                DigestText("invalid-detail"),
                DigestText("invalid-cache"),
                0,
                0,
                0,
                0,
                0,
                0,
                violations);

        public string DigestFor(string edgeName)
            => edgeName switch
            {
                ArticleMutationReplayEdges.PublicAotInvalidation => AotDigest,
                ArticleMutationReplayEdges.HttpCacheInvalidation => CacheDigest,
                ArticleMutationReplayEdges.SearchProjection => SearchDigest,
                ArticleMutationReplayEdges.ArticleDetailAeds => AedsDigest,
                ArticleMutationReplayEdges.TaxonomyProjection => PublicListDigest,
                ArticleMutationReplayEdges.PublicArtifactRevocation => RevocationDigest,
                ArticleMutationReplayEdges.PublicHotRead => HotReadDigest,
                _ => DigestText("unknown-required-edge")
            };

        public long GenerationFor(string edgeName, long outboxGeneration)
            => edgeName switch
            {
                ArticleMutationReplayEdges.PublicAotInvalidation => AotGeneration,
                ArticleMutationReplayEdges.HttpCacheInvalidation => CacheGeneration,
                ArticleMutationReplayEdges.SearchProjection => SearchGeneration,
                ArticleMutationReplayEdges.PublicArtifactRevocation => RevocationGeneration,
                // A removed/non-public detail has no persisted projection row version;
                // the processed outbox row is the terminal generation for that absence.
                ArticleMutationReplayEdges.ArticleDetailAeds => AedsGeneration > 0
                    ? AedsGeneration
                    : outboxGeneration,
                ArticleMutationReplayEdges.PublicHotRead => HotReadGeneration,
                _ => outboxGeneration
            };
    }
}
