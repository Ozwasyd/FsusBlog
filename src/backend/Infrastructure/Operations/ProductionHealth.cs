using System.Diagnostics;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;

using Npgsql;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record ProductionHealthReport(
    string Status,
    DateTimeOffset CheckedAt,
    IReadOnlyDictionary<string, object?> Checks);

public interface IProductionHealthCheck
{
    string Status
    {
        get;
    }
}

public sealed record ProductionDependencyHealthCheck(
    string Status,
    double? LatencyMs = null,
    string? Error = null) : IProductionHealthCheck;

public sealed record PublicHotRecoveryHealthCheck(
    string Status,
    bool TerminalFailure,
    bool Recovered,
    int AttemptCount,
    string? ObligationId,
    string? Error = null) : IProductionHealthCheck;

public sealed record ProductionConfigurationHealthCheck(
    string Status,
    IReadOnlyList<string> Errors) : IProductionHealthCheck;

public sealed record DistributedConvergenceHealthCheck(
    string Status,
    int PendingCount,
    int TerminalFailedCount,
    TimeSpan? OldestPendingAge,
    int AckGapCount,
    bool LedgerAvailable) : IProductionHealthCheck;

public sealed record DistributedIngressHealthCheck(
    string Status,
    int Capacity,
    int QueuedCount,
    int InFlightCount,
    long OverflowCount,
    int PendingInboxCount,
    TimeSpan? OldestPendingAge,
    bool LedgerAvailable,
    string? LastError) : IProductionHealthCheck;

public sealed record BanStateProjectionHealthCheck(
    string Status,
    bool Ready,
    bool Degraded,
    string Detail,
    int Entries,
    long ResidentBytes,
    long VersionLag,
    long AuthorityLoadCommands) : IProductionHealthCheck;

public sealed record AdminSessionProjectionHealthCheck(
    string Status,
    bool Ready,
    string? NotReadyReason,
    int Entries,
    long ResidentBytes,
    long VersionLag,
    int TouchQueueEntries,
    int TouchTrackingEntries) : IProductionHealthCheck;

public sealed record ProductionResourceHealthCheck(
    string Status,
    bool WebRootExists,
    bool IndexExists,
    PublicAotSsrWorkerResourceStatus PublicAotSsrWorker) : IProductionHealthCheck;

public sealed record ProductionObservabilityHealthCheck(
    string Status,
    bool Enabled,
    bool ExporterEnabled,
    string ServiceName,
    string ServiceVersion,
    string ActivitySource,
    string Meter,
    int CustomAttributeCount,
    string? Error = null) : IProductionHealthCheck;

public sealed record ProductionOnlineSchemaCompatibilityHealthCheck(
    string Status,
    string? PublicErrorCode,
    string? ReleaseId,
    string? SchemaCompatibilityCoordinate,
    IReadOnlyList<OnlineSchemaCompatibilityIssue> Issues,
    string? Error = null) : IProductionHealthCheck;

public sealed record ProductionReleaseIdentityHealthCheck(
    string Status,
    string ReleaseId,
    string ReleaseSlot,
    string CommitSha,
    string ImageRef,
    string ImageDigest,
    string? Error = null) : IProductionHealthCheck;

public sealed record ProductionReleaseStorageHealthCheck(
    string Status,
    bool Required,
    bool? DataProtectionReady,
    bool? DataProtectionCanRead,
    bool? DataProtectionCanWrite,
    bool? AssetManifestExists,
    bool? AssetIdentityMatches,
    string ReleaseId,
    string ReleaseSlot,
    int? AssetCount,
    IReadOnlyList<string> Errors) : IProductionHealthCheck;

internal static class ProductionReleaseStorageReadiness
{
    private const string ReleaseAssetManifestSchema = "fsusblog.release-assets.v1";

    public static ProductionReleaseStorageHealthCheck Evaluate(
        IConfiguration configuration,
        IWebHostEnvironment environment,
        ReleaseIdentitySnapshot releaseIdentity)
    {
        if (!environment.IsProduction())
        {
            return new ProductionReleaseStorageHealthCheck(
                "ok",
                Required: false,
                DataProtectionReady: null,
                DataProtectionCanRead: null,
                DataProtectionCanWrite: null,
                AssetManifestExists: null,
                AssetIdentityMatches: null,
                releaseIdentity.ReleaseId,
                releaseIdentity.ReleaseSlot,
                AssetCount: null,
                Errors: []);
        }

        var errors = new List<string>();
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        string keyRingPath = configuration["DataProtection:KeyRingPath"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_PROTECTION_KEY_RING")
            ?? Path.Combine(dataRoot, "data-protection-keys");
        string applicationName = configuration["DataProtection:ApplicationName"] ?? "FsusBlog";
        DataProtectionKeyRingProbeResult dataProtection = DataProtectionKeyRingProbe.Inspect(
            keyRingPath,
            applicationName);
        if (!dataProtection.Ready)
        {
            errors.Add("data_protection_key_ring_unready");
        }

        string releaseAssetRoot = configuration["FSUSBLOG_RELEASE_ASSET_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ASSET_ROOT")
            ?? string.Empty;
        bool manifestExists = false;
        bool identityMatches = false;
        int? assetCount = null;
        if (string.IsNullOrWhiteSpace(releaseAssetRoot))
        {
            errors.Add("release_asset_root_missing");
        }
        else
        {
            try
            {
                string normalizedRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(releaseAssetRoot));
                string manifestPath = Path.GetFullPath(Path.Combine(
                    normalizedRoot,
                    releaseIdentity.ReleaseId,
                    "asset-manifest.json"));
                string rootPrefix = normalizedRoot + Path.DirectorySeparatorChar;
                if (!manifestPath.StartsWith(
                        rootPrefix,
                        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("release asset manifest escaped configured root");
                }

                manifestExists = File.Exists(manifestPath);
                if (!manifestExists)
                {
                    errors.Add("release_asset_manifest_missing");
                }
                else
                {
                    using FileStream stream = File.OpenRead(manifestPath);
                    using JsonDocument manifest = JsonDocument.Parse(stream);
                    JsonElement root = manifest.RootElement;
                    string schema = root.TryGetProperty("schema", out JsonElement schemaValue)
                        ? schemaValue.GetString() ?? string.Empty
                        : string.Empty;
                    string materializedReleaseId = root.TryGetProperty("releaseId", out JsonElement releaseValue)
                        ? releaseValue.GetString() ?? string.Empty
                        : string.Empty;
                    string materializedSlot = root.TryGetProperty("slot", out JsonElement slotValue)
                        ? slotValue.GetString() ?? string.Empty
                        : string.Empty;
                    string frontendBuildId = root.TryGetProperty("frontendBuildId", out JsonElement buildValue)
                        ? buildValue.GetString() ?? string.Empty
                        : string.Empty;
                    assetCount = root.TryGetProperty("files", out JsonElement filesValue)
                        && filesValue.ValueKind == JsonValueKind.Array
                        ? filesValue.GetArrayLength()
                        : null;
                    identityMatches = string.Equals(schema, ReleaseAssetManifestSchema, StringComparison.Ordinal)
                        && string.Equals(materializedReleaseId, releaseIdentity.ReleaseId, StringComparison.Ordinal)
                        && string.Equals(materializedSlot, releaseIdentity.ReleaseSlot, StringComparison.Ordinal)
                        && string.Equals(frontendBuildId, releaseIdentity.ReleaseId, StringComparison.Ordinal)
                        && assetCount > 0;
                    if (!identityMatches)
                    {
                        errors.Add("release_asset_identity_mismatch");
                    }
                }
            }
            catch (Exception exception) when (exception is IOException
                or UnauthorizedAccessException
                or JsonException
                or InvalidOperationException
                or ArgumentException
                or NotSupportedException
                or PathTooLongException)
            {
                errors.Add("release_asset_manifest_invalid");
            }
        }

        return new ProductionReleaseStorageHealthCheck(
            errors.Count == 0 ? "ok" : "failed",
            Required: true,
            dataProtection.Ready,
            dataProtection.CanRead,
            dataProtection.CanWrite,
            manifestExists,
            identityMatches,
            releaseIdentity.ReleaseId,
            releaseIdentity.ReleaseSlot,
            assetCount,
            errors);
    }
}

public sealed record ProductionRiskControlHealthCheck(
    string Status,
    bool ActivePolicy,
    bool LastKnownGoodPolicy,
    bool RedisConsumeOnce,
    bool ChallengeProviderRegistry,
    string? PolicyVersion,
    IReadOnlyList<string> Providers,
    bool PerceptionAeadKey,
    string PerceptionMode,
    SecurityChallengeV2PerformanceBudgetSnapshot PerceptionPerformanceBudget,
    string? Error = null) : IProductionHealthCheck;

internal sealed record RedisConsumeOnceReadiness(bool Ok);

internal sealed record RedisReadiness(
    ProductionDependencyHealthCheck Dependency,
    RedisConsumeOnceReadiness ConsumeOnce);

internal sealed record ProductionReadinessAsyncResults(
    ProductionDependencyHealthCheck Postgres,
    RedisReadiness Redis,
    ProductionRiskControlHealthCheck RiskControl,
    RuntimeHealthSnapshot Runtime);

internal static class ProductionReadinessAsyncCoordinator
{
    public static async Task<ProductionReadinessAsyncResults> RunAsync(
        Func<CancellationToken, Task<ProductionDependencyHealthCheck>> postgres,
        Func<CancellationToken, Task<RedisReadiness>> redis,
        Func<Task<RedisReadiness>, CancellationToken, Task<ProductionRiskControlHealthCheck>> riskControl,
        Func<CancellationToken, Task<RuntimeHealthSnapshot>> runtime,
        CancellationToken cancellationToken)
    {
        Task<ProductionDependencyHealthCheck> postgresTask = postgres(cancellationToken);
        Task<RedisReadiness> redisTask = redis(cancellationToken);
        Task<ProductionRiskControlHealthCheck> riskControlTask = riskControl(redisTask, cancellationToken);
        Task<RuntimeHealthSnapshot> runtimeTask = runtime(cancellationToken);

        await Task.WhenAll(postgresTask, redisTask, riskControlTask, runtimeTask).ConfigureAwait(false);
        return new ProductionReadinessAsyncResults(
            await postgresTask.ConfigureAwait(false),
            await redisTask.ConfigureAwait(false),
            await riskControlTask.ConfigureAwait(false),
            await runtimeTask.ConfigureAwait(false));
    }
}

public sealed record RuntimeHealthSnapshot(
    string Status,
    DbConcurrencyGateSnapshot? DbGate,
    int? NotificationStreamConnections,
    int AvailableWorkerThreads,
    StartupRuntimeSnapshot? Startup,
    ScheduledPublishRuntimeSnapshot? ScheduledPublish,
    PublicHotReadRuntimeSnapshot? PublicHotRead,
    AuditLogRuntimeSnapshot? AuditLog) : IProductionHealthCheck
{
    public RequiredQueueHealthSnapshot? RequiredQueues
    {
        get; init;
    }

    public BoundedQueueDrainHealthCheck? BoundedQueueDrain
    {
        get; init;
    }

    public DbConcurrencyGateDiagnostics? DbGateClasses
    {
        get; init;
    }
    public PublicArticleProjectionRuntimeSnapshot? PublicArticleProjection
    {
        get; init;
    }
    public CommentMutationOutboxRuntimeSnapshot? CommentMutationOutbox
    {
        get; init;
    }
    public PublicHotQuiescenceResult? PublicHotQuiescence
    {
        get; init;
    }
}

public sealed record RequiredQueueHealthSnapshot(
    string Status,
    IReadOnlyDictionary<string, RequiredQueueHealthEntry> Queues) : IProductionHealthCheck
{
    public string? RunId
    {
        get; init;
    }

    public string? ContentDigest
    {
        get; init;
    }

    public string? QualificationStatus
    {
        get; init;
    }

    public IReadOnlyList<string> Blockers { get; init; } = [];

    /// <summary>Gets original queue-owner diagnostics, sampled independently of the qualification receipt.</summary>
    /// <value>Only available owners appear; their cumulative counters must not be summed across participant lanes.</value>
    public IReadOnlyDictionary<string, RequiredQueueOwnerDiagnosticSnapshot> OwnerDiagnostics
    {
        get; init;
    }
        = new Dictionary<string, RequiredQueueOwnerDiagnosticSnapshot>(StringComparer.Ordinal);
}

/// <summary>Preserves original owner counters and controlled disposition without exporting retained item identity.</summary>
public sealed record RequiredQueueOwnerDiagnosticSnapshot(
    string OwnerId,
    long Committed,
    long DurableAccepted,
    long Requeued,
    long Sequence,
    string? LastDisposition)
{
    /// <summary>Gets the independent observation kind, outside aggregate qualification.</summary>
    public string EvidenceKind => "OwnerSnapshot";

    /// <summary>Gets whether these diagnostic values may qualify readiness or drain completion.</summary>
    public bool QualificationEligible => false;

    /// <summary>Omits retained item material, which may contain private identifiers or event text.</summary>
    public string? LastItemReference => null;
}

public sealed record BoundedQueueDrainHealthCheck(
    string Status,
    string RunId,
    string ContentDigest,
    bool Complete,
    string QualificationStatus,
    IReadOnlyList<string> Blockers,
    string? Error = null) : IProductionHealthCheck;

public sealed record RequiredQueueHealthEntry(
    string QueueId,
    long Queued,
    long InFlight,
    long DurablePending,
    long? Committed,
    long? DurableAccepted,
    long? Requeued,
    long TerminalFailed,
    string? LastDisposition,
    string? LastItemReference,
    string? LastFailureReason)
{
    /// <summary>Gets the aggregate participant postcondition, distinct from an owner delivery disposition.</summary>
    public string? CommitPostcondition
    {
        get; init;
    }
}

public static class ProductionLivenessProbe
{
    public static IReadOnlyDictionary<string, object?> CreateReport()
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["status"] = "live",
            ["checkedAt"] = DateTimeOffset.UtcNow
        };
}

public static class ProductionReadinessPublicReport
{
    public static IReadOnlyDictionary<string, object?> Create(ProductionHealthReport report)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["status"] = report.Status,
            ["checkedAt"] = report.CheckedAt
        };
        if (!string.Equals(report.Status, "ready", StringComparison.Ordinal)
            && report.Checks.TryGetValue("schemaCompatibility", out object? schemaValue)
            && schemaValue is ProductionOnlineSchemaCompatibilityHealthCheck schema
            && string.Equals(schema.PublicErrorCode, "schema_incompatible", StringComparison.Ordinal))
        {
            result["code"] = "schema_incompatible";
        }
        return result;
    }
}

public sealed class ProductionReadinessProbe(
    IConfiguration configuration,
    IWebHostEnvironment environment,
    IServiceProvider serviceProvider,
    IConfigurationHealthSnapshot configurationSnapshot,
    IReleaseIdentityProvider releaseIdentity,
    ILogger<ProductionReadinessProbe> logger)
{
    public ProductionReadinessProbe(
        IConfiguration configuration,
        IWebHostEnvironment environment,
        IServiceProvider serviceProvider,
        IConfigurationHealthSnapshot configurationSnapshot,
        ILogger<ProductionReadinessProbe> logger)
        : this(
            configuration,
            environment,
            serviceProvider,
            configurationSnapshot,
            new ReleaseIdentityProvider(configuration),
            logger)
    {
    }

    public async Task<ProductionHealthReport> CheckAsync(CancellationToken cancellationToken)
    {
        long checkStartedAt = Stopwatch.GetTimestamp();
        Task<ProductionReadinessAsyncResults> asyncChecksTask = ProductionReadinessAsyncCoordinator.RunAsync(
            ct => RecordReadinessCheckElapsed("postgres", CheckPostgresAsync(ct)),
            ct => RecordReadinessCheckElapsed("redis", CheckRedisReadinessAsync(ct)),
            (redisTask, ct) => RecordReadinessCheckElapsed("risk_control", CheckRiskControlAsync(redisTask, ct)),
            ct => RecordReadinessCheckElapsed("runtime", CheckRuntimeAsync(ct)),
            cancellationToken);
        Dictionary<string, object?> checks = new(StringComparer.Ordinal)
        {
            ["configuration"] = RedactConfigurationHealth(CheckConfiguration()),
            ["release"] = releaseIdentity.CreateHealthCheck(environment.IsProduction()),
            ["releaseStorage"] = ProductionReleaseStorageReadiness.Evaluate(
                configuration,
                environment,
                releaseIdentity.Current),
            ["spaAssets"] = serviceProvider.GetService<ISpaAssetManifestService>()?.GetReadiness()
                ?? SpaAssetManifestReadiness.Failed("spa_manifest_service_missing"),
            ["observability"] = CheckObservability(),
            ["resources"] = CheckResources()
        };
        if (environment.IsProduction())
        {
            checks["schemaCompatibility"] = CheckOnlineSchemaCompatibility();
        }
        ProductionReadinessAsyncResults asyncChecks = await asyncChecksTask;

        if (serviceProvider.GetService<IDistributedInvalidationObligationStore>() is { } obligations)
        {
            DistributedInvalidationConvergenceSnapshot snapshot = await obligations.SnapshotAsync(cancellationToken).ConfigureAwait(false);
            checks["distributedConvergence"] = new DistributedConvergenceHealthCheck(
                snapshot.Degraded ? "failed" : "ok",
                snapshot.PendingCount,
                snapshot.TerminalFailedCount,
                snapshot.OldestPendingAge,
                snapshot.AckGapCount,
                snapshot.LedgerAvailable);
        }

        if (serviceProvider.GetService<DistributedInvalidationIngressRuntimeState>() is { } ingress)
        {
            DistributedInvalidationIngressSnapshot ingressSnapshot = ingress.Snapshot();
            string ingressStatus =
                ingressSnapshot.Degraded
                || !ingressSnapshot.LedgerAvailable
                || ingressSnapshot.LastError is not null
                    ? "failed"
                    : "ok";
            checks["distributedIngress"] = new DistributedIngressHealthCheck(
                ingressStatus,
                ingressSnapshot.Capacity,
                ingressSnapshot.QueuedCount,
                ingressSnapshot.InFlightCount,
                ingressSnapshot.OverflowCount,
                ingressSnapshot.PendingInboxCount,
                ingressSnapshot.OldestPendingAge,
                ingressSnapshot.LedgerAvailable,
                ingressSnapshot.LastError);
        }

        if (serviceProvider.GetService<BanStateProjection>() is { } banProjection
            && serviceProvider.GetService<BanStateProjectionRuntimeState>() is { } banRuntime)
        {
            BanStateProjectionSnapshot projectionSnapshot = banProjection.Snapshot();
            BanStateProjectionRuntimeSnapshot runtimeSnapshot = banRuntime.Snapshot();
            checks["banStateProjection"] = new BanStateProjectionHealthCheck(
                runtimeSnapshot.Ready && !runtimeSnapshot.Degraded ? "ok" : "failed",
                runtimeSnapshot.Ready,
                runtimeSnapshot.Degraded,
                runtimeSnapshot.Detail,
                projectionSnapshot.Entries,
                projectionSnapshot.Utf8ResidentBytes,
                projectionSnapshot.VersionLag,
                runtimeSnapshot.AuthorityLoadCommands);
        }

        if (serviceProvider.GetService<AdminSessionProjection>() is { } adminSessions)
        {
            AdminSessionProjectionSnapshot projection = adminSessions.Snapshot();
            AdminSessionTouchRuntimeSnapshot touch = serviceProvider
                .GetService<IAdminSessionTouchScheduler>()?
                .Snapshot() ?? default;
            checks["adminSessionProjection"] = new AdminSessionProjectionHealthCheck(
                projection.IsReady ? "ok" : "failed",
                projection.IsReady,
                projection.NotReadyReason,
                projection.SessionEntries + projection.PrincipalEntries,
                projection.ResidentBytes,
                Math.Max(0, projection.ReadyGeneration - projection.LastProcessedGeneration),
                touch.QueueEntries,
                touch.TrackingEntries);
        }

        checks["postgres"] = asyncChecks.Postgres;
        checks["redis"] = asyncChecks.Redis.Dependency;
        checks["riskControl"] = asyncChecks.RiskControl;
        checks["runtime"] = asyncChecks.Runtime;
        checks["publicHotRecovery"] = await CheckPublicHotRecoveryAsync(cancellationToken).ConfigureAwait(false);

        bool dependencyGatesReady = checks.Values.All(IsHealthyCheck);
        if (serviceProvider.GetService<DeploymentDrainCoordinator>() is { } deployment)
        {
            DeploymentRuntimeSnapshot deploymentSnapshot = deployment.CreateSnapshot();
            checks["deployment"] = deployment.EvaluateReadiness(dependencyGatesReady);
            if (environment.IsProduction()
                && serviceProvider.GetService<ActiveReleaseFenceReadiness>() is { } activeReleaseFence)
            {
                bool requireLocalOwnership = string.Equals(
                    deploymentSnapshot.Mode,
                    DeploymentRuntimeModes.Active,
                    StringComparison.Ordinal);
                checks["activeReleaseFence"] = await activeReleaseFence
                    .EvaluateAsync(requireLocalOwnership, cancellationToken)
                    .ConfigureAwait(false);
            }
        }

        bool healthy = checks.Values.All(IsHealthyCheck);
        FsusObservability.RecordReadinessCheckElapsed("check", FsusObservability.GetElapsed(checkStartedAt));
        return new ProductionHealthReport(
            healthy ? "ready" : "not_ready",
            DateTimeOffset.UtcNow,
            checks);
    }

    private ProductionConfigurationHealthCheck CheckConfiguration()
    {
        return configurationSnapshot.Current;
    }

    private ProductionOnlineSchemaCompatibilityHealthCheck CheckOnlineSchemaCompatibility()
    {
        OnlineSchemaCompatibilityReport? report = serviceProvider
            .GetService<OnlineSchemaCompatibilityRuntimeState>()?
            .Current;
        if (report is null)
        {
            return new ProductionOnlineSchemaCompatibilityHealthCheck(
                "failed",
                "schema_incompatible",
                releaseIdentity.Current.ReleaseId,
                null,
                [],
                "schema_compatibility_unavailable");
        }

        return new ProductionOnlineSchemaCompatibilityHealthCheck(
            report.Ready ? "ok" : "failed",
            report.PublicErrorCode,
            report.ReleaseId,
            report.SchemaCompatibilityCoordinate,
            report.Issues,
            report.Ready ? null : "schema_incompatible");
    }

    private static ProductionConfigurationHealthCheck RedactConfigurationHealth(ProductionConfigurationHealthCheck check)
        => string.Equals(check.Status, "ok", StringComparison.Ordinal)
            ? check
            : new ProductionConfigurationHealthCheck("failed", ["configuration_invalid"]);

    private ProductionResourceHealthCheck CheckResources()
    {
        string webRoot = environment.WebRootPath;
        if (string.IsNullOrWhiteSpace(webRoot))
        {
            webRoot = Path.Combine(environment.ContentRootPath, "wwwroot");
        }

        bool webRootExists = Directory.Exists(webRoot);
        bool indexExists = File.Exists(Path.Combine(webRoot, "index.html"));
        PublicAotSsrRuntimeState? publicAotSsrRuntime = serviceProvider.GetService<PublicAotSsrRuntimeState>();
        PublicAotSsrWorkerResourceStatus publicAotSsrWorker = publicAotSsrRuntime is not null
            ? publicAotSsrRuntime.GetOrCreateWorkerResourceSnapshot(
                () => PublicAotNodeSsrRenderer.CheckWorkerResource(environment, configuration))
            : PublicAotNodeSsrRenderer.CheckWorkerResource(environment, configuration);
        bool publicAotSsrWorkerReady = !environment.IsProduction()
            || string.Equals(publicAotSsrWorker.Status, "ok", StringComparison.Ordinal);

        return new ProductionResourceHealthCheck(
            webRootExists && indexExists && publicAotSsrWorkerReady ? "ok" : "failed",
            webRootExists,
            indexExists,
            publicAotSsrWorker);
    }

    private ProductionObservabilityHealthCheck CheckObservability()
    {
        ObservabilityRuntimeState? state = serviceProvider.GetService<ObservabilityRuntimeState>();
        return state is null
            ? new ProductionObservabilityHealthCheck(
                "failed",
                Enabled: false,
                ExporterEnabled: false,
                ServiceName: string.Empty,
                ServiceVersion: string.Empty,
                ActivitySource: FsusObservability.ActivitySourceName,
                Meter: FsusObservability.MeterName,
                CustomAttributeCount: FsusObservability.CustomAttributeNames.Count,
                Error: "observability_not_registered")
            : new ProductionObservabilityHealthCheck(
                "ok",
                state.Enabled,
                state.ExporterEnabled,
                state.ServiceName,
                state.ServiceVersion,
                FsusObservability.ActivitySourceName,
                FsusObservability.MeterName,
                FsusObservability.CustomAttributeNames.Count);
    }

    private async Task<RuntimeHealthSnapshot> CheckRuntimeAsync(CancellationToken cancellationToken)
    {
        DbConcurrencyGateSnapshot? dbGate = null;
        DbConcurrencyGateDiagnostics? dbGateClasses = null;
        if (serviceProvider.GetService<IDbConcurrencyGate>() is { } gate)
        {
            dbGate = gate.GetSnapshot();
            dbGateClasses = (gate as IClassifiedDbConcurrencyGate)?.GetDiagnostics();
        }

        PublicArticleProjectionRuntimeSnapshot? publicArticleProjection = serviceProvider
            .GetService<PublicArticleProjectionRuntimeState>()
            ?.Snapshot();

        int? notificationStreamConnections = serviceProvider.GetService<NotificationStreamConnectionManager>()?.ConnectionCount;
        StartupRuntimeState? startupRuntime = serviceProvider.GetService<StartupRuntimeState>();
        ScheduledPublishRuntimeState? scheduledPublish = serviceProvider.GetService<ScheduledPublishRuntimeState>();
        CommentMutationOutboxRuntimeSnapshot? commentMutationOutbox = serviceProvider
            .GetService<CommentMutationOutboxRuntimeState>()
            ?.CreateSnapshot();
        PublicHotReadStore? publicHotReadStore = serviceProvider.GetService<PublicHotReadStore>();
        AuditLogRuntimeState? auditLogRuntime = serviceProvider.GetService<AuditLogRuntimeState>();
        (RequiredQueueHealthSnapshot requiredQueues, BoundedQueueDrainHealthCheck boundedQueueDrain) = CaptureBoundedQueueAuthority();
        PublicHotArtifactUpdateQueue? publicHotQueue = serviceProvider.GetService<PublicHotArtifactUpdateQueue>();
        Task<PublicHotReadRuntimeSnapshot?> publicHotReadTask = Task.Run(
            () => publicHotReadStore?.CreateRuntimeSnapshot(),
            cancellationToken);
        Task<PublicHotQuiescenceResult?> publicHotQuiescenceTask = Task.Run(
            () => ReadPublicHotQuiescenceAsync(publicHotQueue, cancellationToken),
            cancellationToken);
        Task<AuditLogRuntimeSnapshot?> auditLogTask = Task.Run(
            () => auditLogRuntime?.Snapshot(),
            cancellationToken);
        Task<RuntimePressureSnapshot> pressureTask = Task.Run(
            RuntimePressureSnapshot.Capture,
            cancellationToken);
        await Task.WhenAll(publicHotReadTask, publicHotQuiescenceTask, auditLogTask, pressureTask);
        PublicHotReadRuntimeSnapshot? publicHotRead = await publicHotReadTask;
        PublicHotQuiescenceResult? publicHotQuiescence = await publicHotQuiescenceTask;
        AuditLogRuntimeSnapshot? auditLog = await auditLogTask;
        // Operations AuditRead does not grant investigation access to retained item material.
        auditLog = ProjectAuditLogDiagnostics(auditLog);
        RuntimePressureSnapshot pressure = await pressureTask;
        string status = (publicHotRead is null
                || (string.Equals(publicHotRead.State, nameof(PublicHotReadState.Ready), StringComparison.Ordinal)
                    && !publicHotRead.ArticleFrameLimitExceeded
                    && !publicHotRead.ResidentByteBudgetExceeded))
            && (publicHotQuiescence?.Drained ?? true)
            && (commentMutationOutbox?.PoisonCount ?? 0) == 0
            && string.Equals(requiredQueues.Status, "ok", StringComparison.Ordinal)
            && string.Equals(boundedQueueDrain.Status, "ok", StringComparison.Ordinal)
            ? "ok"
            : "degraded";

        return new RuntimeHealthSnapshot(
            status,
            dbGate,
            notificationStreamConnections,
            pressure.AvailableWorkerThreads,
            startupRuntime?.CreateSnapshot(),
            scheduledPublish?.CreateSnapshot(),
            publicHotRead,
            auditLog)
        {
            DbGateClasses = dbGateClasses,
            PublicArticleProjection = publicArticleProjection,
            CommentMutationOutbox = commentMutationOutbox,
            PublicHotQuiescence = publicHotQuiescence,
            RequiredQueues = requiredQueues,
            BoundedQueueDrain = boundedQueueDrain
        };
    }

    internal (RequiredQueueHealthSnapshot Required, BoundedQueueDrainHealthCheck Drain) CaptureBoundedQueueAuthority()
    {
        if (serviceProvider.GetService<BoundedQueueDrainAggregator>() is not { } aggregator)
        {
            var failed = new BoundedQueueDrainHealthCheck(
                "failed",
                string.Empty,
                string.Empty,
                Complete: false,
                "failed",
                ["observer-unavailable"],
                "observer_unavailable");
            return (new RequiredQueueHealthSnapshot("failed", new Dictionary<string, RequiredQueueHealthEntry>(StringComparer.Ordinal))
            {
                QualificationStatus = "failed",
                Blockers = failed.Blockers,
                OwnerDiagnostics = CaptureRequiredQueueOwnerDiagnostics(serviceProvider)
            }, failed);
        }

        BoundedQueueDrainAggregateReceipt aggregate = aggregator.Observe();
        // Optional diagnostic reads must not change the aggregate observation order or availability.
        IReadOnlyDictionary<string, RequiredQueueOwnerDiagnosticSnapshot> ownerDiagnostics = CaptureRequiredQueueOwnerDiagnostics(serviceProvider);
        var queues = new Dictionary<string, RequiredQueueHealthEntry>(StringComparer.Ordinal);
        foreach (BoundedQueueParticipantReceipt participant in aggregate.Participants)
        {
            if (!BoundedQueueDrainEvaluation.IsBlockingDeliveryClass(participant.DeliveryClass)
                && participant.TerminalFailures > 0
                && BoundedQueueDrainEvaluation.AllowsTerminalFailures(participant.DeliveryClass, participant.DropProof))
            {
                continue;
            }

            queues[participant.QueueId] = new RequiredQueueHealthEntry(
                participant.QueueId,
                participant.Queued,
                participant.InFlight,
                participant.DurablePending,
                Committed: null,
                DurableAccepted: null,
                Requeued: null,
                participant.TerminalFailures,
                LastDisposition: null,
                LastItemReference: null,
                participant.ErrorCode)
            {
                CommitPostcondition = participant.CommitPostcondition.ToString()
            };
        }

        var drain = new BoundedQueueDrainHealthCheck(
            aggregate.HealthStatus,
            aggregate.RunId,
            aggregate.ContentDigest,
            aggregate.Complete,
            aggregate.QualificationStatus,
            aggregate.Blockers,
            aggregate.ErrorCode);
        return (new RequiredQueueHealthSnapshot(aggregate.HealthStatus, queues)
        {
            RunId = aggregate.RunId,
            ContentDigest = aggregate.ContentDigest,
            QualificationStatus = aggregate.QualificationStatus,
            Blockers = aggregate.Blockers,
            OwnerDiagnostics = ownerDiagnostics
        }, drain);
    }

    /// <summary>Projects the four existing owners without creating a second readiness or delivery authority.</summary>
    internal static IReadOnlyDictionary<string, RequiredQueueOwnerDiagnosticSnapshot> CaptureRequiredQueueOwnerDiagnostics(IServiceProvider serviceProvider)
    {
        var queues = new Dictionary<string, RequiredQueueOwnerDiagnosticSnapshot>(StringComparer.Ordinal);
        Capture<AuditLogChannel>("audit-log", static owner =>
        {
            AuditLogChannelSnapshot snapshot = owner.Snapshot();
            return new("audit-log", snapshot.CommittedCount, snapshot.DurableAcceptedCount, snapshot.RequeuedCount, snapshot.Sequence, ControlledQueueDisposition(snapshot.LastDisposition));
        });
        Capture<AdminAuditLogChannel>("admin-audit-log", static owner =>
        {
            AdminAuditLogChannelSnapshot snapshot = owner.Snapshot();
            return new("admin-audit-log", snapshot.CommittedCount, snapshot.DurableAcceptedCount, snapshot.RequeuedCount, snapshot.Sequence, ControlledQueueDisposition(snapshot.LastDisposition));
        });
        Capture<SecurityRiskEventWriteQueue>("security-risk-event", static owner =>
        {
            SecurityRiskEventWriteQueueSnapshot snapshot = owner.Snapshot();
            return new("security-risk-event", snapshot.CommittedCount, snapshot.DurableAcceptedCount, snapshot.RequeuedCount, snapshot.Sequence, ControlledQueueDisposition(snapshot.LastDisposition));
        });
        Capture<ChallengeV2AuditEventQueue>("challenge-v2-event", static owner =>
        {
            ChallengeV2AuditEventQueueSnapshot snapshot = owner.Snapshot();
            return new("challenge-v2-event", snapshot.CommittedCount, snapshot.DurableAcceptedCount, snapshot.RequeuedCount, snapshot.Sequence, ControlledQueueDisposition(snapshot.LastDisposition));
        });

        void Capture<TOwner>(string ownerId, Func<TOwner, RequiredQueueOwnerDiagnosticSnapshot> project) where TOwner : class
        {
            try
            {
                if (serviceProvider.GetService<TOwner>() is { } owner)
                {
                    queues[ownerId] = project(owner);
                }
            }
            catch (Exception)
            {
                // Unavailable diagnostics are omitted, never zero-filled or promoted to qualification.
                // The aggregate independently retains its original structured observer failure.
            }
        }

        return queues;
    }

    internal static AuditLogRuntimeSnapshot? ProjectAuditLogDiagnostics(AuditLogRuntimeSnapshot? snapshot)
        => snapshot is null ? null : snapshot with
        {
            LastItemReference = null
        };

    private static string? ControlledQueueDisposition(string? disposition)
        => disposition switch
        {
            null => null,
            "queued" or "in-flight" or "committed" or "durable-pending" or "durable-accepted"
                or "requeued" or "rejected" or "terminal-failed" or "closed" => disposition,
            _ => "unknown"
        };

    private static async Task<PublicHotQuiescenceResult?> ReadPublicHotQuiescenceAsync(
        PublicHotArtifactUpdateQueue? publicHotQueue,
        CancellationToken cancellationToken)
    {
        if (publicHotQueue is null)
        {
            return null;
        }

        PublicHotActivitySnapshot snapshot = await publicHotQueue
            .CreateActivitySnapshotAsync(cancellationToken)
            .ConfigureAwait(false);
        return PublicHotQuiescence.Evaluate(snapshot, snapshot.CurrentTargetGeneration ?? 0);
    }

    private async Task<PublicHotRecoveryHealthCheck> CheckPublicHotRecoveryAsync(CancellationToken cancellationToken)
    {
        if (serviceProvider.GetService<IPublicHotArtifactObligationStore>() is not { } obligations)
        {
            return new PublicHotRecoveryHealthCheck("ok", false, false, 0, null);
        }

        try
        {
            PublicHotArtifactObligation? obligation = await obligations.GetActiveAsync(cancellationToken).ConfigureAwait(false);
            bool terminal = await obligations.HasTerminalFailureAsync(cancellationToken).ConfigureAwait(false);
            return obligation is null
                ? new PublicHotRecoveryHealthCheck(terminal ? "failed" : "ok", terminal, false, 0, null, terminal ? "terminal-obligation-retained" : null)
                : new PublicHotRecoveryHealthCheck(
                    terminal ? "failed" : "ok",
                    terminal,
                    obligation.Recovered,
                    obligation.AttemptNumber,
                    obligation.ObligationId,
                    terminal ? obligation.LastFailureKind.ToString() : null);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "public-hot recovery readiness check failed");
            return new PublicHotRecoveryHealthCheck("failed", false, false, 0, null, ex.GetType().Name);
        }
    }

    private async Task<ProductionRiskControlHealthCheck> CheckRiskControlAsync(
        Task<RedisReadiness> redisTask,
        CancellationToken cancellationToken)
    {
        try
        {
            SecurityRiskPolicySnapshotV2? policy = serviceProvider.GetService<ISecurityRiskPolicyProvider>()?.CurrentRiskPolicyV2;
            string? policyVersion = policy?.PolicyVersion;
            bool activePolicy = policy is not null
                && !string.IsNullOrWhiteSpace(policy.SnapshotId)
                && !string.IsNullOrWhiteSpace(policy.PolicyVersion)
                && policy.DefaultAction is not null;
            bool lastKnownGoodPolicy = policy is not null
                && !string.IsNullOrWhiteSpace(policy.LastKnownGoodSnapshotId);
            if (!string.IsNullOrWhiteSpace(policyVersion))
            {
                FsusObservability.RecordSecurityPolicyVersion(policyVersion);
            }

            IReadOnlyList<string> providers = ResolveChallengeProviders();
            bool challengeProviderRegistry = ChallengeProviderRegistryReady(providers, policy);
            RedisReadiness redisReadiness = await redisTask;
            bool redisConsumeOnce = redisReadiness.ConsumeOnce.Ok;
            bool perceptionAeadKey = CheckPerceptionAeadKey();
            string perceptionMode = ResolvePerceptionMode(policy);
            SecurityChallengeV2PerformanceBudgetSnapshot perceptionBudget =
                FsusObservability.CreateSecurityChallengeV2PerformanceBudgetSnapshot();
            bool ok = activePolicy && lastKnownGoodPolicy && challengeProviderRegistry && redisConsumeOnce && perceptionAeadKey;
            return new ProductionRiskControlHealthCheck(
                ok ? "ok" : "failed",
                activePolicy,
                lastKnownGoodPolicy,
                redisConsumeOnce,
                challengeProviderRegistry,
                policyVersion,
                providers,
                perceptionAeadKey,
                perceptionMode,
                perceptionBudget,
                ok ? null : "risk_control_dependency_unavailable");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "risk-control readiness check failed");
            return new ProductionRiskControlHealthCheck(
                "failed",
                ActivePolicy: false,
                LastKnownGoodPolicy: false,
                RedisConsumeOnce: false,
                ChallengeProviderRegistry: false,
                PolicyVersion: null,
                Providers: [],
                PerceptionAeadKey: false,
                PerceptionMode: "unknown",
                PerceptionPerformanceBudget: FsusObservability.CreateSecurityChallengeV2PerformanceBudgetSnapshot(),
                Error: "dependency_unavailable");
        }
    }

    private string ResolvePerceptionMode(SecurityRiskPolicySnapshotV2? policy)
    {
        if (policy is null)
        {
            return "missing";
        }

        return SecuritySystemModes.Normalize(policy.GlobalMode);
    }

    private bool CheckPerceptionAeadKey()
    {
        const string SectionName = PerceptionSealedTokenOptions.SectionName;
        string currentKeyVersion = (configuration[$"{SectionName}:CurrentKeyVersion"] ?? string.Empty).Trim();
        if (currentKeyVersion.Length == 0)
        {
            return false;
        }

        string? key = configuration[$"{SectionName}:Keys:{currentKeyVersion}"];
        return TryDecodePerceptionAeadKey(key, out _);
    }

    private static bool TryDecodePerceptionAeadKey(string? encodedKey, out byte[] key)
    {
        key = [];
        string value = (encodedKey ?? string.Empty).Trim();
        if (value.Length == 0)
        {
            return false;
        }

        if (value.StartsWith("hex:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeHexPerceptionAeadKey(value[4..], out key);
        }

        if (value.StartsWith("base64:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeBase64PerceptionAeadKey(value[7..], out key);
        }

        if (value.StartsWith("base64url:", StringComparison.OrdinalIgnoreCase))
        {
            return TryDecodeBase64UrlPerceptionAeadKey(value[10..], out key);
        }

        return HexText.IsSha256Hex(value)
            ? TryDecodeHexPerceptionAeadKey(value, out key)
            : TryDecodeBase64PerceptionAeadKey(value, out key)
              || TryDecodeBase64UrlPerceptionAeadKey(value, out key);
    }

    private static bool TryDecodeHexPerceptionAeadKey(string value, out byte[] key)
    {
        key = [];
        try
        {
            key = Convert.FromHexString(value);
        }
        catch (FormatException)
        {
            return false;
        }

        return key.Length == 32;
    }

    private static bool TryDecodeBase64PerceptionAeadKey(string value, out byte[] key)
    {
        key = [];
        try
        {
            key = Convert.FromBase64String(value);
        }
        catch (FormatException)
        {
            return false;
        }

        return key.Length == 32;
    }

    private static bool TryDecodeBase64UrlPerceptionAeadKey(string value, out byte[] key)
    {
        key = [];
        try
        {
            key = WebEncoders.Base64UrlDecode(value);
        }
        catch (FormatException)
        {
            return false;
        }

        return key.Length == 32;
    }

    private IReadOnlyList<string> ResolveChallengeProviders()
        => serviceProvider
            .GetServices<ISecurityChallengeProvider>()
            .Select(static provider => (provider.Kind ?? string.Empty).Trim())
            .Where(static kind => kind.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static kind => kind, StringComparer.Ordinal)
            .ToArray();

    internal static bool ChallengeProviderRegistryReady(
        IReadOnlyList<string> providers,
        SecurityRiskPolicySnapshotV2? policy)
    {
        if (providers.Count == 0)
        {
            return false;
        }

        HashSet<string> registered = providers.ToHashSet(StringComparer.Ordinal);
        if (policy is null)
        {
            return registered.All(static kind =>
                SecurityChallengeContracts.TryParseKind(kind, out SecurityChallengeKind parsed)
                && string.Equals(kind, SecurityChallengeContracts.ToWireName(parsed), StringComparison.Ordinal));
        }

        IEnumerable<SecurityRiskActionPolicy> actions = policy.ActionOverrides.Values.Prepend(policy.DefaultAction);
        foreach (SecurityRiskActionPolicy action in actions)
        {
            IReadOnlyList<string> baseChallenge = [action.ChallengeKind];
            if (!ChallengeSetReady(baseChallenge, action, registered))
            {
                return false;
            }

            IReadOnlyList<string> hardChallenge = action.HardChallengeKinds.Count > 0
                ? action.HardChallengeKinds
                : baseChallenge;
            if (!ChallengeSetReady(hardChallenge, action, registered))
            {
                return false;
            }

            foreach (SecurityRiskDecisionBand band in action.DecisionBands)
            {
                if (band.Outcome is not (SecurityRiskPolicyOutcomes.Challenge or SecurityRiskPolicyOutcomes.HardChallenge))
                {
                    continue;
                }

                IReadOnlyList<string> bandChallenge = band.ChallengeKinds.Count > 0
                    ? band.ChallengeKinds
                    : band.Outcome == SecurityRiskPolicyOutcomes.HardChallenge
                        ? hardChallenge
                        : baseChallenge;
                if (!ChallengeSetReady(bandChallenge, action, registered))
                {
                    return false;
                }
            }
        }

        return true;
    }

    private static bool ChallengeSetReady(
        IReadOnlyList<string> requiredKinds,
        SecurityRiskActionPolicy action,
        IReadOnlySet<string> registered)
    {
        if (requiredKinds.Count is <= 0 or > SecurityChallengeContracts.MaxAssignmentsPerEnvelope)
        {
            return false;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string requiredKind in requiredKinds)
        {
            string normalized = (requiredKind ?? string.Empty).Trim();
            if (normalized.Length == 0 || !seen.Add(normalized) ||
                !SecurityChallengeContracts.TryParseKind(normalized, out SecurityChallengeKind parsed))
            {
                return false;
            }

            string wireName = SecurityChallengeContracts.ToWireName(parsed);
            if (!string.Equals(normalized, wireName, StringComparison.Ordinal) || !registered.Contains(wireName))
            {
                return false;
            }

            SecurityChallengeCapabilityResolution capability = SecurityChallengeCapabilityCatalog.Resolve(
                parsed,
                action.ActionName,
                SecurityChallengeCapabilityCatalog.ResolveMode(action.ActionName),
                providerAvailable: true);
            if (!capability.PolicyEligible
                && !RiskActionRegistry.UsesSpecializedStepUp(action.ActionName, parsed))
            {
                return false;
            }
        }

        return true;
    }

    private async Task<RedisReadiness> CheckRedisReadinessAsync(CancellationToken cancellationToken)
    {
        Task<ProductionDependencyHealthCheck> dependencyTask = CheckRedisAsync(cancellationToken);
        Task<RedisConsumeOnceReadiness> consumeOnceTask = CheckRedisConsumeOnceReadinessAsync(cancellationToken);
        await Task.WhenAll(dependencyTask, consumeOnceTask);
        return new RedisReadiness(await dependencyTask, await consumeOnceTask);
    }

    private async Task<RedisConsumeOnceReadiness> CheckRedisConsumeOnceReadinessAsync(CancellationToken cancellationToken)
    {
        try
        {
            ICacheStringWriter? cacheWriter = serviceProvider.GetService<ICacheStringWriter>();
            ICacheOneTimeStore? oneTimeStore = serviceProvider.GetService<ICacheOneTimeStore>();
            if (cacheWriter is null || oneTimeStore is null)
            {
                return new RedisConsumeOnceReadiness(false);
            }

            string identity = "risk-control-readiness:" + Guid.NewGuid().ToString("N");
            await cacheWriter.SetStringAsync(
                CachePolicyId.SecurityChallengeProof,
                identity,
                "readiness",
                TimeSpan.FromSeconds(5),
                cancellationToken);
            bool firstConsume = await oneTimeStore.ConsumeOnceAsync(CachePolicyId.SecurityChallengeProof, identity, cancellationToken);
            bool replayConsume = await oneTimeStore.ConsumeOnceAsync(CachePolicyId.SecurityChallengeProof, identity, cancellationToken);
            return new RedisConsumeOnceReadiness(firstConsume && !replayConsume);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "redis consume-once readiness check failed");
            return new RedisConsumeOnceReadiness(false);
        }
    }

    private async Task<ProductionDependencyHealthCheck> CheckPostgresAsync(CancellationToken cancellationToken)
    {
        long startedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("db.postgres.ping", "db", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.db.system", "postgresql");
        FsusObservability.SetTag(activity, "fsus.db.operation", "ping");
        string? connectionString = configuration.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            FsusObservability.RecordDbOperation("ping", "missing_connection_string", FsusObservability.GetElapsed(startedAt));
            return new ProductionDependencyHealthCheck("failed", Error: "missing_connection_string");
        }

        try
        {
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select 1";
            command.CommandTimeout = 3;
            object? result = await command.ExecuteScalarAsync(cancellationToken);
            TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
            FsusObservability.RecordDbOperation("ping", Convert.ToInt32(result) == 1 ? "ok" : "unexpected_result", elapsed);
            return Convert.ToInt32(result) == 1
                ? new ProductionDependencyHealthCheck("ok", LatencyMs: elapsed.TotalMilliseconds)
                : new ProductionDependencyHealthCheck("failed", Error: "unexpected_result");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "postgres readiness check failed");
            FsusObservability.RecordDbOperation("ping", "failed", FsusObservability.GetElapsed(startedAt));
            return new ProductionDependencyHealthCheck("failed", Error: "dependency_unavailable");
        }
    }

    private async Task<ProductionDependencyHealthCheck> CheckRedisAsync(CancellationToken cancellationToken)
    {
        long startedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.redis.ping", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "ping");
        FsusObservability.SetTag(activity, "fsus.cache.policy", "redis");
        FsusObservability.SetTag(activity, "fsus.cache.layer", "l2");
        try
        {
            IRedisOperationExecutor redis = serviceProvider.GetRequiredService<IRedisOperationExecutor>();
            TimeSpan latency = await redis.ExecuteAsync(
                    RedisOperationPort.ProductionHealth,
                    (multiplexer, _) => multiplexer.GetDatabase().PingAsync(CommandFlags.DemandMaster),
                    cancellationToken)
                .ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("ping", "redis", "l2", "ok", FsusObservability.GetElapsed(startedAt));
            return new ProductionDependencyHealthCheck("ok", LatencyMs: latency.TotalMilliseconds);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "redis readiness check failed");
            FsusObservability.RecordCacheOperation("ping", "redis", "l2", "failed", FsusObservability.GetElapsed(startedAt));
            return new ProductionDependencyHealthCheck("failed", Error: "dependency_unavailable");
        }
    }

    private static bool IsHealthyCheck(object? check)
        => check is IProductionHealthCheck health
            && string.Equals(health.Status, "ok", StringComparison.Ordinal);

    private static async Task<T> RecordReadinessCheckElapsed<T>(string check, Task<T> task)
    {
        long startedAt = Stopwatch.GetTimestamp();
        try
        {
            return await task;
        }
        finally
        {
            FsusObservability.RecordReadinessCheckElapsed(check, FsusObservability.GetElapsed(startedAt));
        }
    }
}

public interface IConfigurationHealthSnapshot
{
    ProductionConfigurationHealthCheck Current
    {
        get;
    }

    void Refresh();
}

public sealed class ConfigurationHealthSnapshot(
    IConfiguration configuration,
    IWebHostEnvironment environment,
    IServiceProvider serviceProvider,
    ILogger<ConfigurationHealthSnapshot> logger) : IConfigurationHealthSnapshot
{
    private ProductionConfigurationHealthCheck _current = new("failed", ["configuration_snapshot_not_initialized"]);
    private int _initialized;

    public ProductionConfigurationHealthCheck Current
    {
        get
        {
            EnsureInitialized();
            return Volatile.Read(ref _current);
        }
    }

    public void Refresh()
    {
        try
        {
            IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
                configuration,
                environment.IsProduction(),
                ResolveZkProdReadiness());
            Volatile.Write(
                ref _current,
                errors.Count == 0
                    ? new ProductionConfigurationHealthCheck("ok", [])
                    : new ProductionConfigurationHealthCheck("failed", errors));
            Volatile.Write(ref _initialized, 1);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "configuration readiness snapshot refresh failed");
            Volatile.Write(ref _current, new ProductionConfigurationHealthCheck("failed", ["configuration_snapshot_unavailable"]));
            Volatile.Write(ref _initialized, 1);
        }
    }

    private void EnsureInitialized()
    {
        if (Volatile.Read(ref _initialized) == 1)
        {
            return;
        }

        Refresh();
    }

    private ZkProdRuntimeReadiness ResolveZkProdReadiness()
    {
        IZkProofVerifier? verifier = serviceProvider.GetService<IZkProofVerifier>();
        IAnonymousCredentialRootReader? rootReader = serviceProvider.GetService<IAnonymousCredentialRootReader>();
        IRfc9474BlindCredentialSigner? credentialSigner = serviceProvider.GetService<IRfc9474BlindCredentialSigner>();
        IBlindCredentialRuntimeGate? credentialGate = serviceProvider.GetService<IBlindCredentialRuntimeGate>();
        DateTimeOffset now = DateTimeOffset.UtcNow;
        bool rootReady = rootReader?.CurrentSnapshot.AcceptedRoots.Any(root =>
            root.GraceExpiresAtUtc > now &&
            !string.IsNullOrWhiteSpace(root.RootHash) &&
            !string.IsNullOrWhiteSpace(root.RevocationRootHash) &&
            !string.IsNullOrWhiteSpace(root.IssuerPublicKeyHash) &&
            (string.Equals(root.Status, AnonymousCredentialRootStatuses.Active, StringComparison.Ordinal) ||
             string.Equals(root.Status, AnonymousCredentialRootStatuses.Grace, StringComparison.Ordinal))) == true;
        return new ZkProdRuntimeReadiness(
            verifier?.IsConfigured == true,
            rootReady,
            credentialSigner?.IsConfigured == true && credentialGate?.IsEnabled == true);
    }
}

public sealed class ConfigurationHealthSnapshotRefreshWorker(
    IConfigurationHealthSnapshot snapshot,
    ILogger<ConfigurationHealthSnapshotRefreshWorker> logger) : BackgroundService
{
    private static readonly TimeSpan s_refreshInterval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        RefreshSnapshot();
        using PeriodicTimer timer = new(s_refreshInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                RefreshSnapshot();
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    private void RefreshSnapshot()
    {
        try
        {
            snapshot.Refresh();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "configuration readiness snapshot refresh loop failed");
        }
    }
}

public sealed class ProductionReadinessSnapshotCache
{
    private static readonly TimeSpan s_readinessSnapshotTtl = TimeSpan.FromSeconds(5);
    private readonly Func<CancellationToken, Task<ProductionHealthReport>> _refreshAsync;
    private readonly TimeSpan _ttl;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private ProductionHealthReport? _snapshot;

    public ProductionReadinessSnapshotCache(IServiceScopeFactory scopeFactory)
        : this(async cancellationToken =>
        {
            using IServiceScope scope = scopeFactory.CreateScope();
            ProductionReadinessProbe probe = scope.ServiceProvider.GetRequiredService<ProductionReadinessProbe>();
            return await probe.CheckAsync(cancellationToken);
        }, s_readinessSnapshotTtl)
    {
    }

    internal ProductionReadinessSnapshotCache(
        Func<CancellationToken, Task<ProductionHealthReport>> refreshAsync,
        TimeSpan ttl)
    {
        _refreshAsync = refreshAsync;
        _ttl = ttl;
    }

    public async Task<ProductionHealthReport> GetSnapshotAsync(bool forceRefresh, CancellationToken cancellationToken)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        if (!forceRefresh && TryGetFreshSnapshot(now, out ProductionHealthReport? cached))
        {
            RecordCacheHit(cached, now);
            return cached;
        }

        await _refreshGate.WaitAsync(cancellationToken);
        try
        {
            now = DateTimeOffset.UtcNow;
            if (!forceRefresh && TryGetFreshSnapshot(now, out cached))
            {
                RecordCacheHit(cached, now);
                return cached;
            }

            long startedAt = Stopwatch.GetTimestamp();
            ProductionHealthReport report = await _refreshAsync(cancellationToken);
            _snapshot = report;
            FsusObservability.RecordReadinessSnapshot(
                cacheHit: false,
                FsusObservability.GetElapsed(startedAt),
                CountDependencyChecks(report),
                TimeSpan.Zero);
            return report;
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    private bool TryGetFreshSnapshot(DateTimeOffset now, out ProductionHealthReport report)
    {
        report = _snapshot!;
        return report is not null && now - report.CheckedAt <= _ttl;
    }

    private static void RecordCacheHit(ProductionHealthReport report, DateTimeOffset now)
        => FsusObservability.RecordReadinessSnapshot(
            cacheHit: true,
            freshCheckElapsed: TimeSpan.Zero,
            dependencyCheckCount: 0,
            snapshotAge: now - report.CheckedAt);

    private static int CountDependencyChecks(ProductionHealthReport report)
        => report.Checks.Values.Count(static check =>
            check is ProductionDependencyHealthCheck or ProductionRiskControlHealthCheck);
}

public static class ProductionHealthEndpoints
{
    public static IEndpointRouteBuilder MapProductionHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/health/live", () => TypedResults.Json(ProductionLivenessProbe.CreateReport())).AllowAnonymous();

        endpoints.MapGet("/health/ready", async Task<IResult> (
            [FromServices] ProductionReadinessSnapshotCache snapshotCache,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            ProductionHealthReport report = await snapshotCache.GetSnapshotAsync(forceRefresh: false, cancellationToken);
            if (context.RequestServices.GetService<DeploymentDrainCoordinator>() is { } deployment)
            {
                report = deployment.ApplyCurrentState(report);
            }
            int statusCode = report.Status == "ready"
                ? StatusCodes.Status200OK
                : StatusCodes.Status503ServiceUnavailable;
            return TypedResults.Json(ProductionReadinessPublicReport.Create(report), statusCode: statusCode);
        }).AllowAnonymous();

        endpoints.MapGet("/api/ops/health/ready-detail", async Task<IResult> (
            [FromServices] ProductionReadinessSnapshotCache snapshotCache,
            HttpContext context,
            CancellationToken cancellationToken,
            bool forceRefresh = true) =>
        {
            ProductionHealthReport report = await snapshotCache.GetSnapshotAsync(forceRefresh, cancellationToken);
            if (context.RequestServices.GetService<DeploymentDrainCoordinator>() is { } deployment)
            {
                report = deployment.ApplyCurrentState(report);
            }
            int statusCode = report.Status == "ready"
                ? StatusCodes.Status200OK
                : StatusCodes.Status503ServiceUnavailable;
            return TypedResults.Json(report, statusCode: statusCode);
        }).RequireAdminPermission(AdminPermissions.AuditRead);

        endpoints.MapGet("/api/ops/crawler-ranges/status", ([FromServices] CrawlerDetectorService detector) =>
        {
            CrawlerRangeStatus status = detector.GetRangeStatus();
            return TypedResults.Json(new
            {
                googleRanges = status.GoogleRanges,
                bingRanges = status.BingRanges,
                lastSyncAt = status.LastSyncAt,
                lastSuccessAt = status.LastSuccessAt,
                source = status.Source,
                lastError = status.LastError
            });
        }).RequireAdminPermission(AdminPermissions.AuditRead);

        return endpoints;
    }
}
