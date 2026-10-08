using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeProtocolActivationGuardTests
{
    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-activation-durable-receipt-and-fence")]
    public async Task Guard_RemainsClosedUntilDurableExactReceiptThenFailsClosedOnFenceDrift()
    {
        ServiceProvider services = new ServiceCollection().AddDistributedMemoryCache().BuildServiceProvider();
        IPerceptionCharacterV3CutoverStore store = Substitute.For<IPerceptionCharacterV3CutoverStore>();
        IPerceptionCharacterV3ArtifactPool pool = HealthyPool();
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified());
        var guard = CreateGuard(
            services.GetRequiredService<IDistributedCache>(),
            store,
            pool,
            PolicyProvider(),
            fence);
        PerceptionCharacterV3CutoverReceipt receipt = Receipt();

        Assert.False(await guard.IsOpenAsync());
        await Assert.ThrowsAsync<InvalidOperationException>(() => guard.OpenAsync(receipt));

        store.ReadReceiptAsync(receipt.OperationId, Arg.Any<CancellationToken>())
            .Returns(receipt);
        await guard.OpenAsync(receipt);

        Assert.True(await guard.IsOpenAsync());
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(RejectedFence());
        Assert.False(await guard.IsOpenAsync());
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-activation-pool-fingerprint-exact")]
    public async Task Guard_FailsClosedWhenPoolPolicyOrFrontendFingerprintDrifts()
    {
        ServiceProvider services = new ServiceCollection().AddDistributedMemoryCache().BuildServiceProvider();
        IPerceptionCharacterV3CutoverStore store = Substitute.For<IPerceptionCharacterV3CutoverStore>();
        IPerceptionCharacterV3ArtifactPool pool = HealthyPool();
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified());
        var guard = CreateGuard(
            services.GetRequiredService<IDistributedCache>(),
            store,
            pool,
            PolicyProvider(),
            fence);
        PerceptionCharacterV3CutoverReceipt receipt = Receipt();
        store.ReadReceiptAsync(receipt.OperationId, Arg.Any<CancellationToken>()).Returns(receipt);
        await guard.OpenAsync(receipt);

        pool.GetIdentityAsync(Arg.Any<CancellationToken>())
            .Returns(new PerceptionCharacterV3PoolIdentity(
                PoolGeneration,
                new string('e', 64),
                PerceptionCharacterV3ReleaseTarget.ContractDigest,
                new string('d', 64)));

        Assert.False(await guard.IsOpenAsync());
    }

    [Theory]
    [InlineData("Production", false)]
    [InlineData("Development", true)]
    [InlineData("Testing", true)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary, InvariantId = "challenge-activation-local-environment-boundary")]
    public async Task InvalidReleaseSlotOnlyBypassesActivationInExplicitLocalEnvironments(
        string environmentName,
        bool expectedOpen)
    {
        ServiceProvider services = new ServiceCollection().AddDistributedMemoryCache().BuildServiceProvider();
        IReleaseIdentityProvider identity = Substitute.For<IReleaseIdentityProvider>();
        identity.Current.Returns(new ReleaseIdentitySnapshot(
            "release-a",
            "invalid",
            "commit",
            "image",
            "digest",
            true));
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns(environmentName);
        var guard = new SecurityChallengeProtocolActivationGuard(
            services.GetRequiredService<IDistributedCache>(),
            identity,
            environment,
            new ConfigurationBuilder().Build(),
            Substitute.For<IPerceptionCharacterV3CutoverStore>(),
            Substitute.For<IPerceptionCharacterV3ArtifactPool>(),
            PolicyProvider(),
            Substitute.For<IActiveReleaseFence>());

        Assert.Equal(expectedOpen, await guard.IsOpenAsync());
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-activation-cache-failure-fails-closed")]
    public async Task ProductionCacheFailureFailsClosed()
    {
        IDistributedCache cache = Substitute.For<IDistributedCache>();
        cache.GetAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns<Task<byte[]?>>(_ => throw new InvalidOperationException("cache unavailable"));
        var guard = CreateGuard(
            cache,
            Substitute.For<IPerceptionCharacterV3CutoverStore>(),
            HealthyPool(),
            PolicyProvider(),
            Substitute.For<IActiveReleaseFence>());

        Assert.False(await guard.IsOpenAsync());
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-frontend-aeds-fingerprint-exact")]
    public void PublishedFrontendTarget_ExactBuildPassesAndMixedFingerprintFailsReadinessValidation()
    {
        string root = Path.Combine(Path.GetTempPath(), "fsus-v3-target-" + Guid.CreateVersion7().ToString("N"));
        string target = Path.Combine(
            root,
            PerceptionCharacterV3ReleaseTargetValidator.PublicTargetPath.Replace(
                '/',
                Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        try
        {
            File.WriteAllText(target, System.Text.Json.JsonSerializer.Serialize(new
            {
                schema = PerceptionCharacterV3ReleaseTarget.Schema,
                algorithm = PerceptionCharacterV3ReleaseTarget.Algorithm,
                wireName = PerceptionCharacterV3ReleaseTarget.WireName,
                contractDigest = PerceptionCharacterV3ReleaseTarget.ContractDigest,
                aedsSchemaFingerprint = PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint,
                targetFingerprint = PerceptionCharacterV3ReleaseTarget.TargetFingerprint
            }));
            PerceptionCharacterV3ReleaseTargetValidator.ValidatePublishedFrontendTarget(root);

            string mixed = File.ReadAllText(target).Replace(
                PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint,
                new string('f', 64),
                StringComparison.Ordinal);
            File.WriteAllText(target, mixed);
            InvalidOperationException error = Assert.Throws<InvalidOperationException>(
                () => PerceptionCharacterV3ReleaseTargetValidator.ValidatePublishedFrontendTarget(root));
            Assert.Contains("mixed aedsSchemaFingerprint", error.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static SecurityChallengeProtocolActivationGuard CreateGuard(
        IDistributedCache cache,
        IPerceptionCharacterV3CutoverStore store,
        IPerceptionCharacterV3ArtifactPool pool,
        ISecurityRiskPolicyProvider policy,
        IActiveReleaseFence fence)
    {
        IReleaseIdentityProvider identity = Substitute.For<IReleaseIdentityProvider>();
        identity.Current.Returns(new ReleaseIdentitySnapshot(
            "release-a",
            "green",
            "commit",
            "image",
            $"sha256:{new string('a', 64)}",
            true));
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns("Production");
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?>
            {
                ["FSUSBLOG_DEPLOYMENT_GENERATION"] = "42"
            }).Build();
        return new(cache, identity, environment, configuration, store, pool, policy, fence);
    }

    internal static IPerceptionCharacterV3ArtifactPool HealthyPool()
    {
        IPerceptionCharacterV3ArtifactPool pool = Substitute.For<IPerceptionCharacterV3ArtifactPool>();
        pool.GetIdentityAsync(Arg.Any<CancellationToken>()).Returns(new PerceptionCharacterV3PoolIdentity(
            PoolGeneration,
            PoolManifestDigest,
            PerceptionCharacterV3ReleaseTarget.ContractDigest,
            new string('d', 64)));
        pool.GetInventoryAsync(Arg.Any<CancellationToken>()).Returns(new PerceptionCharacterV3PoolInventory(
            PoolGeneration,
            100,
            100,
            200,
            0,
            0,
            false,
            false,
            true));
        return pool;
    }

    internal static ISecurityRiskPolicyProvider PolicyProvider(string version = PolicyVersion)
        => new FixedRiskPolicyProvider(new SecurityRiskPolicy(
            "risk-policy-snapshot-1",
            version,
            DateTimeOffset.UtcNow,
            SecuritySystemModes.Enforce,
            100,
            125,
            null,
            new SecurityRiskActionPolicy(
                "*",
                new SecurityRiskActionThresholds(10, 25, 50, 75, 90),
                PerceptionCharacterV3ReleaseTarget.WireName,
                1,
                null,
                AnonymousWriteAllowed: true),
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal)));

    internal static PerceptionCharacterV3CutoverTarget Target()
    {
        var target = new PerceptionCharacterV3CutoverTarget(
            PerceptionCharacterV3ReleaseTarget.ContractDigest,
            PoolGeneration,
            PoolManifestDigest,
            PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint,
            PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint,
            PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint,
            PolicyVersion,
            string.Empty);
        return target with
        {
            TargetFingerprint = PerceptionCharacterV3ContractCutover.ComputeTargetFingerprint(target)
        };
    }

    internal static PerceptionCharacterV3CutoverReceipt Receipt()
    {
        PerceptionCharacterV3CutoverTarget target = Target();
        return new(
            PerceptionCharacterV3ContractCutover.ReceiptSchemaVersion,
            "operation-a",
            new string('1', 64),
            new string('2', 64),
            "release-a",
            "green",
            42,
            target.ContractDigest,
            target.PoolGeneration,
            target.PoolManifestDigest,
            target.BackendAedsSchemaFingerprint,
            target.SharedAedsSchemaFingerprint,
            target.FrontendAedsSchemaFingerprint,
            target.PolicySnapshotVersion,
            target.TargetFingerprint,
            false,
            true,
            false,
            "activated",
            null,
            true,
            true,
            true,
            new PerceptionCharacterV3CutoverMutationResult(
                1,
                2,
                3,
                4,
                5,
                6,
                7,
                new string('3', 64)),
            DateTimeOffset.UtcNow);
    }

    internal static ActiveReleaseFenceOperationResult Verified() => new(
        true,
        true,
        "verified",
        null,
        false,
        new ActiveReleaseFenceSnapshot(
            true,
            ActiveReleaseFenceStatuses.Active,
            "release-a",
            "green",
            42,
            $"sha256:{new string('a', 64)}",
            DateTimeOffset.UtcNow,
            null));

    internal static ActiveReleaseFenceOperationResult RejectedFence() => new(
        false,
        false,
        "rejected",
        "active_release_generation_mismatch",
        false,
        new ActiveReleaseFenceSnapshot(
            false,
            ActiveReleaseFenceStatuses.Revoked,
            "release-b",
            "blue",
            43,
            $"sha256:{new string('b', 64)}",
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow));

    internal const string PoolGeneration = "generation-a";
    internal const string PoolManifestDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    internal const string PolicyVersion = "policy-a";

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicy policy)
        : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicy CurrentRiskPolicy => policy;
    }
}
