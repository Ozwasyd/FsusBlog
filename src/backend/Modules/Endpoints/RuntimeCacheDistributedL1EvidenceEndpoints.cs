using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

internal static class RuntimeCacheDistributedL1EvidenceEndpoints
{
    private const string Prefix = "/_fsus/testing/runtime-cache/scenarios";
    private const int MaximumRunIdLength = 96;
    private const int MaximumL1KeyCount = 100_000;
    private const int MaximumPayloadBytes = 4 * 1024;
    private const int CleanupBatchSize = 1_000;

    internal static WebApplication MapRuntimeCacheDistributedL1EvidenceEndpoints(this WebApplication app)
    {
        if ((!app.Environment.IsDevelopment() && !app.Environment.IsEnvironment("Test")) ||
            string.IsNullOrWhiteSpace(app.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey]))
        {
            return app;
        }

        app.MapPost($"{Prefix}/distributed/prepare", PrepareDistributedAsync).AllowAnonymous();
        app.MapPost($"{Prefix}/distributed/trigger", TriggerDistributedAsync).AllowAnonymous();
        app.MapGet($"{Prefix}/snapshot", ReadSnapshotAsync).AllowAnonymous();
        app.MapPut($"{Prefix}/l1/{{runId}}/{{ordinal:int}}", WriteL1Async).AllowAnonymous();
        app.MapPost($"{Prefix}/cleanup", CleanupAsync).AllowAnonymous();
        return app;
    }

    private static async Task<IResult> PrepareDistributedAsync(
        HttpContext context,
        DistributedPrepareRequest request,
        ICacheRawWriter writer,
        ICacheDiagnostics diagnostics,
        DistributedInvalidationOptions distributed,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !ValidRunId(request.RunId) || request.ArticleId <= 0 || !HasTwoNodeTopology(distributed))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        await writer.SetRawAsync(
            CachePolicyId.CommentCursorFrame,
            DistributedIdentity(request.ArticleId),
            Encoding.UTF8.GetBytes($"distributed:{request.RunId}:{distributed.NodeId}"),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        await writer.SetRawAsync(
            CachePolicyId.SystemPage,
            UnrelatedIdentity(request.RunId),
            Encoding.UTF8.GetBytes($"unrelated:{request.RunId}:{distributed.NodeId}"),
            cancellationToken: cancellationToken).ConfigureAwait(false);

        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("redis");
        return Results.Ok(new
        {
            prepared = new
            {
                request.RunId,
                request.ArticleId,
                distributed.NodeId,
                processId = Environment.ProcessId,
                targetIdentity = DistributedIdentity(request.ArticleId),
                unrelatedIdentity = UnrelatedIdentity(request.RunId)
            },
            policies = ProjectPolicies(diagnostics)
        });
    }

    private static async Task<IResult> TriggerDistributedAsync(
        HttpContext context,
        DistributedTriggerRequest request,
        IDistributedInvalidationPublisher publisher,
        DistributedInvalidationOptions distributed,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !ValidRunId(request.RunId) || request.ArticleId <= 0 ||
            !ValidEventId(request.EventId) || !HasTwoNodeTopology(distributed))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        DistributedInvalidationPublishResult result = await publisher.PublishAsync(
            new DistributedInvalidationRequest(
                DistributedInvalidationEventKinds.CommentMutation,
                ["comments", "stats"],
                [$"article:{request.ArticleId}:comments"],
                ["public-hot-read"],
                request.EventId),
            cancellationToken).ConfigureAwait(false);

        if (result.Status != DistributedInvalidationPublishStatus.Published || result.Event is null)
        {
            return Results.Problem(
                $"distributed_invalidation_publish_{result.Status}:{result.Detail}",
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("database");
        RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
            "distributed-invalidation",
            request.EventId,
            "published");
        return Results.Ok(new
        {
            result.Event.EventId,
            kind = result.Event.Kind,
            result.Event.SourceNodeId,
            result.Event.RuntimeScope,
            publishStatus = result.Status.ToString(),
            transportStatus = result.TransportReceipt?.TransportStatus.ToString(),
            result.TransportReceipt?.TopologyDigest,
            subscriberCount = result.TransportReceipt?.SubscriberCount,
            expectedSubscribers = result.TransportReceipt?.ExpectedMinimumSubscribers
        });
    }

    private static async Task<IResult> ReadSnapshotAsync(
        HttpContext context,
        string? eventId,
        ICacheDiagnostics diagnostics,
        PublicHotReadStore publicHotReads,
        CacheInvalidationRuntimeState invalidationState,
        DistributedInvalidationOptions distributed,
        DistributedInvalidationEventFactory eventFactory,
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !HasTwoNodeTopology(distributed) ||
            (!string.IsNullOrEmpty(eventId) && !ValidEventId(eventId)))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        string runtimeScope = eventFactory.RuntimeScope;
        DurableEvidence? durable = string.IsNullOrEmpty(eventId)
            ? null
            : await ReadDurableAsync(db, runtimeScope, eventId, cancellationToken).ConfigureAwait(false);
        int durableScopeRows = await db.Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.RuntimeScope == runtimeScope)
            .CountAsync(cancellationToken).ConfigureAwait(false);
        PublicHotReadRuntimeSnapshot hot = publicHotReads.CreateRuntimeSnapshot();
        return Results.Ok(new
        {
            node = new
            {
                nodeId = distributed.NodeId,
                processId = Environment.ProcessId,
                runtimeScope,
                topologyDigest = distributed.Topology!.Digest,
                topologyNodeIds = distributed.Topology.SubscriberNodeIds.Order(StringComparer.Ordinal).ToArray()
            },
            policies = ProjectPolicies(diagnostics),
            publicHotRead = new
            {
                state = hot.State,
                earlyDataPlaneState = hot.EarlyDataPlaneState,
                version = hot.Version,
                residentBytes = hot.ResidentBytes,
                residentByteBudget = hot.ResidentByteBudget
            },
            cacheInvalidation = invalidationState.Snapshot(),
            durableScopeRows,
            durable
        });
    }

    private static async Task<IResult> WriteL1Async(
        HttpContext context,
        string runId,
        int ordinal,
        ICacheRawWriter writer,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !ValidRunId(runId) || ordinal is < 1 or > MaximumL1KeyCount)
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        byte[]? payload = await ReadBoundedBodyAsync(context.Request, cancellationToken).ConfigureAwait(false);
        if (payload is null)
        {
            return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
        }

        CachePolicyId policy = PolicyForOrdinal(ordinal);
        string identity = BuildL1Identity(runId, ordinal);
        await writer.SetRawAsync(policy, identity, payload, cancellationToken: cancellationToken).ConfigureAwait(false);
        RuntimeCacheEvidenceObservation.Current?.MarkLayerSource("redis");
        RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent("l1-residency", identity, "published");
        return Results.Ok(new
        {
            written = true,
            payloadBytes = payload.Length
        });
    }

    private static async Task<IResult> CleanupAsync(
        HttpContext context,
        RuntimeCacheCleanupRequest request,
        ICacheInvalidationStore sharedCache,
        ICacheLocalInvalidator localCache,
        DistributedInvalidationEventFactory eventFactory,
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        if (!Authorized(context) || !ValidRunId(request.RunId) ||
            request.KeyCount is < 0 or > MaximumL1KeyCount ||
            (request.ArticleId < 0) ||
            (!string.IsNullOrEmpty(request.EventId) && !ValidEventId(request.EventId)))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        if (string.Equals(request.Scenario, "l1-residency", StringComparison.Ordinal))
        {
            for (int start = 1; start <= request.KeyCount; start += CleanupBatchSize)
            {
                CacheKeyIdentity[] keys = Enumerable.Range(start, Math.Min(CleanupBatchSize, request.KeyCount - start + 1))
                    .Select(ordinal => new CacheKeyIdentity(PolicyForOrdinal(ordinal), BuildL1Identity(request.RunId, ordinal)))
                    .ToArray();
                _ = localCache.InvalidateLocal(keys);
                if (request.DeleteShared)
                {
                    await sharedCache.RemoveManyAsync(keys, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        else if (string.Equals(request.Scenario, "distributed-invalidation", StringComparison.Ordinal) && request.ArticleId > 0)
        {
            CacheKeyIdentity[] keys =
            [
                new(CachePolicyId.CommentCursorFrame, DistributedIdentity(request.ArticleId)),
                new(CachePolicyId.SystemPage, UnrelatedIdentity(request.RunId))
            ];
            _ = localCache.InvalidateLocal(keys);
            if (request.DeleteShared)
            {
                await sharedCache.RemoveManyAsync(keys, cancellationToken).ConfigureAwait(false);
            }
        }
        else
        {
            return Results.BadRequest(new
            {
                error = "runtime_cache_cleanup_scenario_invalid"
            });
        }

        int durableRowsBefore = 0;
        int durableRowsAfter = 0;
        if (request.DeleteDurable && !string.IsNullOrEmpty(request.EventId))
        {
            string runtimeScope = eventFactory.RuntimeScope;
            durableRowsBefore = await CountDurableRowsAsync(db, runtimeScope, request.EventId, cancellationToken).ConfigureAwait(false);
            _ = await db.Deleteable<DistributedInvalidationInboxEntity>()
                .Where(item => item.RuntimeScope == runtimeScope && item.EventId == request.EventId)
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            _ = await db.Deleteable<DistributedInvalidationConvergenceObligationEntity>()
                .Where(item => item.RuntimeScope == runtimeScope && item.EventId == request.EventId)
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            durableRowsAfter = await CountDurableRowsAsync(db, runtimeScope, request.EventId, cancellationToken).ConfigureAwait(false);
        }

        return Results.Ok(new
        {
            request.Scenario,
            request.RunId,
            request.KeyCount,
            request.DeleteShared,
            durableRowsBefore,
            durableRowsAfter
        });
    }

    internal static string BuildL1Identity(string runId, int ordinal)
        => $"runtime-cache-evidence:{runId}:l1:{ordinal:D6}";

    internal static CachePolicyId PolicyForOrdinal(int ordinal)
        => (ordinal & 1) == 1 ? CachePolicyId.SystemPage : CachePolicyId.SystemCompliance;

    internal static bool ValidRunId(string value)
        => value.Length is > 0 and <= MaximumRunIdLength && value.All(static character =>
            char.IsAsciiLetterOrDigit(character) || character is '.' or '-');

    private static string DistributedIdentity(int articleId) => $"article:{articleId}";

    private static string UnrelatedIdentity(string runId) => $"runtime-cache-evidence:{runId}:distributed:unrelated";

    private static bool ValidEventId(string value)
        => value.Length is > 0 and <= 64 && value.All(static character =>
            char.IsAsciiLetterOrDigit(character) || character is '.' or '-');

    private static bool HasTwoNodeTopology(DistributedInvalidationOptions options)
        => options.Enabled && options.Topology is { SubscriberNodeIds.Count: 2 } topology &&
            topology.SubscriberNodeIds.Contains(options.NodeId, StringComparer.Ordinal);

    private static bool Authorized(HttpContext context)
    {
        string expected = context.RequestServices.GetRequiredService<IConfiguration>()
            [RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] ?? string.Empty;
        string provided = context.Request.Headers[RuntimeCacheEvidenceMiddleware.SecretHeader].ToString();
        byte[] left = Encoding.UTF8.GetBytes(expected);
        byte[] right = Encoding.UTF8.GetBytes(provided);
        return left.Length > 0 && left.Length == right.Length &&
            CryptographicOperations.FixedTimeEquals(left, right);
    }

    private static object[] ProjectPolicies(ICacheDiagnostics diagnostics)
        => diagnostics.GetL1PolicyResidencySnapshots()
            .Select(static item => new
            {
                policyId = item.PolicyId.ToString(),
                maxEntries = item.MaxEntries,
                maxLogicalBytes = item.MaxLogicalBytes,
                maxCapacityBytes = item.MaxCapacityBytes,
                entries = item.Entries,
                logicalBytes = item.LogicalBytes,
                capacityBytes = item.CapacityBytes,
                capacityEvictions = item.CapacityEvictions,
                invalidatedEvictions = item.InvalidatedEvictions,
                contendedLockWaitTicks = item.ContendedLockWaitTicks
            })
            .Cast<object>()
            .ToArray();

    private static async Task<byte[]?> ReadBoundedBodyAsync(HttpRequest request, CancellationToken cancellationToken)
    {
        if (request.ContentLength is > MaximumPayloadBytes)
        {
            return null;
        }

        using var stream = new MemoryStream(MaximumPayloadBytes);
        byte[] buffer = new byte[1024];
        while (true)
        {
            int read = await request.Body.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                return stream.ToArray();
            }
            if (stream.Length + read > MaximumPayloadBytes)
            {
                return null;
            }
            stream.Write(buffer, 0, read);
        }
    }

    private static async Task<DurableEvidence?> ReadDurableAsync(
        ISqlSugarClient db,
        string runtimeScope,
        string eventId,
        CancellationToken cancellationToken)
    {
        DistributedInvalidationConvergenceObligationEntity? obligation = await db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.RuntimeScope == runtimeScope && item.EventId == eventId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (obligation is null)
        {
            return null;
        }

        List<DistributedInvalidationInboxEntity> inboxes = await db.Queryable<DistributedInvalidationInboxEntity>()
            .Where(item => item.RuntimeScope == runtimeScope && item.EventId == eventId)
            .OrderBy(item => item.TargetNodeId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return new DurableEvidence(
            new DurableObligationEvidence(
                obligation.EventId,
                obligation.Kind,
                obligation.SourceNodeId,
                obligation.State,
                obligation.PublishStatus,
                obligation.TransportStatus,
                obligation.PayloadDigest,
                ParseNodeIds(obligation.RequiredNodeIds),
                ParseNodeIds(obligation.AckedNodeIds)),
            inboxes.Select(static item => new DurableInboxEvidence(
                item.TargetNodeId,
                item.ApplyState,
                item.PayloadDigest,
                item.AppliedGeneration)).ToArray());
    }

    private static async Task<int> CountDurableRowsAsync(
        ISqlSugarClient db,
        string runtimeScope,
        string eventId,
        CancellationToken cancellationToken)
    {
        int obligations = await db.Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(item => item.RuntimeScope == runtimeScope && item.EventId == eventId)
            .CountAsync(cancellationToken).ConfigureAwait(false);
        int inboxes = await db.Queryable<DistributedInvalidationInboxEntity>()
            .Where(item => item.RuntimeScope == runtimeScope && item.EventId == eventId)
            .CountAsync(cancellationToken).ConfigureAwait(false);
        return obligations + inboxes;
    }

    private static string[] ParseNodeIds(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<string[]>(value) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private sealed record DistributedPrepareRequest(string RunId, int ArticleId);
    private sealed record DistributedTriggerRequest(string RunId, int ArticleId, string EventId);
    private sealed record RuntimeCacheCleanupRequest(
        string Scenario,
        string RunId,
        int ArticleId,
        string? EventId,
        int KeyCount,
        bool DeleteDurable,
        bool DeleteShared = false);
    private sealed record DurableEvidence(DurableObligationEvidence Obligation, IReadOnlyList<DurableInboxEvidence> Inboxes);
    private sealed record DurableObligationEvidence(
        string EventId,
        string Kind,
        string SourceNodeId,
        string State,
        string PublishStatus,
        string? TransportStatus,
        string? PayloadDigest,
        IReadOnlyList<string> RequiredNodeIds,
        IReadOnlyList<string> AckedNodeIds);
    private sealed record DurableInboxEvidence(
        string TargetNodeId,
        string ApplyState,
        string PayloadDigest,
        long? AppliedGeneration);
}
