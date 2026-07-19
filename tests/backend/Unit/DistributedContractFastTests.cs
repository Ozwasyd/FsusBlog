using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Background;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DistributedContractFastTests
{
    [Fact]
    public void RuntimeModeOptions_DefaultToSingleWithoutClusterComponents()
    {
        var options = new RuntimeModeOptions();

        Assert.Equal(RuntimeModeKind.Single, options.ResolveMode());
        Assert.False(options.ClusterComponentsEnabled);
        Assert.False(options.AdaptiveSchedulingEnabled);
        Assert.True(options.IsRoleEnabled("article-backfill"));
    }

    [Theory]
    [InlineData("static-role", RuntimeModeKind.StaticRole, true, false)]
    [InlineData("adaptive", RuntimeModeKind.Adaptive, true, true)]
    public void RuntimeModeOptions_BindStaticRoleAndAdaptiveConfigurations(
        string configuredMode,
        RuntimeModeKind expectedMode,
        bool clusterComponentsEnabled,
        bool adaptiveSchedulingEnabled)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Runtime:Mode"] = configuredMode,
                ["Runtime:StaticRoles:0"] = "article-backfill"
            })
            .Build();
        var options = new RuntimeModeOptions();
        configuration.GetSection(RuntimeModeOptions.SectionName).Bind(options);

        Assert.Equal(expectedMode, options.ResolveMode());
        Assert.Equal(clusterComponentsEnabled, options.ClusterComponentsEnabled);
        Assert.Equal(adaptiveSchedulingEnabled, options.AdaptiveSchedulingEnabled);
        Assert.True(options.IsRoleEnabled("article-backfill"));
        Assert.Equal(
            expectedMode == RuntimeModeKind.Adaptive,
            options.IsRoleEnabled("notification-stream"));
    }

    [Fact]
    public async Task PublicAotLease_UsesCanonicalIdentityAndBoundedTtlWithoutNetwork()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-20T08:00:00Z"));
        var store = new DeterministicLeaseStore(clock);
        var lease = new PublicAotBackfillLease(
            store,
            new PublicAotBackfillLeaseOptions(
                PublicAotBackfillLeaseMode.Redis,
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(10)),
            NullLogger<PublicAotBackfillLease>.Instance);
        var request = new PublicAotBackfillRequest(
            PublicPageKind.ArticleDetail,
            "article:42",
            "/article/42",
            string.Empty,
            "cache:article:42")
        {
            FrontendAssetVersion = "frontend-v7",
            TestSessionId = "contract-fast"
        };

        await using IPublicAotBackfillLeaseHandle handle = Assert.IsAssignableFrom<IPublicAotBackfillLeaseHandle>(
            await lease.TryAcquireAsync(request));

        Assert.Equal(CachePolicyId.PublicAotBackfillLease, store.PolicyId);
        Assert.Equal("2:article%3A42:frontend-v7:contract-fast", store.Identity);
        Assert.Equal(TimeSpan.FromSeconds(30), store.Ttl);
        Assert.Equal(TimeSpan.FromSeconds(10), handle.RenewInterval);
        clock.Advance(TimeSpan.FromSeconds(9));
        Assert.True(await handle.RenewAsync());
        Assert.Equal(clock.GetUtcNow().AddSeconds(30), store.ExpiresAtUtc);
    }

    [Fact]
    public void ProjectionCheckpoint_SerializesAndRestoresReplayState()
    {
        var checkpoint = new ArticleMutationOutboxEdge
        {
            OutboxEventId = 431,
            EdgeName = ArticleMutationReplayEdges.ArticleDetailAeds,
            Status = ArticleMutationOutboxEdgeStatus.Failed,
            AttemptCount = 2,
            LastError = "artifact-write-failed",
            UpdatedAt = DateTime.UnixEpoch
        };

        string payload = JsonSerializer.Serialize(checkpoint);
        ArticleMutationOutboxEdge restored = JsonSerializer.Deserialize<ArticleMutationOutboxEdge>(payload)!;

        Assert.Equal(checkpoint.OutboxEventId, restored.OutboxEventId);
        Assert.Equal(checkpoint.EdgeName, restored.EdgeName);
        Assert.Equal(checkpoint.Status, restored.Status);
        Assert.Equal(checkpoint.AttemptCount, restored.AttemptCount);
        Assert.Equal(checkpoint.LastError, restored.LastError);
    }

    [Fact]
    public void OutboxCriticalFailure_RemainsRetryableAndCannotReportSuccess()
    {
        var completed = new HashSet<string>(StringComparer.Ordinal)
        {
            ArticleMutationReplayEdges.PublicAotInvalidation
        };
        var failures = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [ArticleMutationReplayEdges.ArticleDetailAeds] = "artifact-write-failed"
        };

        ArticleMutationReplayResult result = ArticleMutationReplayResult.Failed(
            "critical-side-effect-failed",
            completed,
            failures);

        Assert.False(result.IsSuccess);
        Assert.Equal("critical-side-effect-failed", result.Error);
        Assert.Contains(ArticleMutationReplayEdges.ArticleDetailAeds, ArticleMutationReplayEdges.Required);
        Assert.Equal("artifact-write-failed", result.FailedEdges[ArticleMutationReplayEdges.ArticleDetailAeds]);
        Assert.Empty(result.SkippedEdges);
    }

    [Fact]
    public void DistributedInvalidationEvent_SerializesCanonicalReplayIdentity()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-20T08:15:00Z"));
        DistributedInvalidationEvent value = DistributedInvalidationEvent.Create(
            "event-431",
            DistributedInvalidationEventKinds.ArticleMutation,
            "node-a",
            "test:contract-fast",
            ["article:42", "article:42"],
            ["/article/42"],
            ["detail:42"],
            "trace-431",
            clock);

        string payload = JsonSerializer.Serialize(value);
        DistributedInvalidationEvent restored = JsonSerializer.Deserialize<DistributedInvalidationEvent>(payload)!;
        restored.Validate();

        Assert.Equal("test:contract-fast:event-431", restored.ReplayIdentity);
        Assert.Equal(clock.GetUtcNow(), restored.EmittedAt);
        Assert.Equal(["article:42"], restored.CacheTags);
        Assert.Contains("\"schema\":\"fsusblog.distributed-invalidation.v1\"", payload, StringComparison.Ordinal);
        Assert.Contains("\"sourceNodeId\":\"node-a\"", payload, StringComparison.Ordinal);
        Assert.Contains("\"traceId\":\"trace-431\"", payload, StringComparison.Ordinal);
    }

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;

        public void Advance(TimeSpan delta) => utcNow = utcNow.Add(delta);
    }

    private sealed class DeterministicLeaseStore(TimeProvider clock) : ICacheLeaseStore
    {
        private string? _value;

        public CachePolicyId PolicyId
        {
            get;
            private set;
        }

        public string? Identity
        {
            get;
            private set;
        }

        public TimeSpan Ttl
        {
            get;
            private set;
        }

        public DateTimeOffset ExpiresAtUtc
        {
            get;
            private set;
        }

        public Task<bool> TryAcquireLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string value,
            TimeSpan ttl,
            CancellationToken cancellationToken = default)
        {
            PolicyId = policyId;
            Identity = identity;
            Ttl = ttl;
            _value = value;
            ExpiresAtUtc = clock.GetUtcNow().Add(ttl);
            return Task.FromResult(true);
        }

        public Task<bool> TryRenewLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string expectedValue,
            TimeSpan ttl,
            CancellationToken cancellationToken = default)
        {
            bool matches = policyId == PolicyId
                && string.Equals(identity, Identity, StringComparison.Ordinal)
                && string.Equals(expectedValue, _value, StringComparison.Ordinal)
                && ExpiresAtUtc > clock.GetUtcNow();
            if (matches)
            {
                ExpiresAtUtc = clock.GetUtcNow().Add(ttl);
            }
            return Task.FromResult(matches);
        }

        public Task<bool> TryReleaseLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string expectedValue,
            CancellationToken cancellationToken = default)
        {
            bool matches = policyId == PolicyId
                && string.Equals(identity, Identity, StringComparison.Ordinal)
                && string.Equals(expectedValue, _value, StringComparison.Ordinal);
            if (matches)
            {
                _value = null;
            }
            return Task.FromResult(matches);
        }
    }
}
