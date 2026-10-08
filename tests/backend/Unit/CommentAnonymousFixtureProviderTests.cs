using System.Net;

using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentAnonymousFixtureProviderTests
{
    private const string Owner = "comment-fixture:provider-tests:run-1";
    private const string TestSession = "fx-0123456789abcdef01234567";
    private const long CommentId = 41;
    private const string ManagementSecret = "fixture-management-secret";

    [Fact]
    public void SimulationConfiguration_DoesNotOverwriteGlobalProductionPolicy()
    {
        IConfiguration baseline = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = "Development",
                ["AnonymousIdentity:ZkCommentPolicy:Enabled"] = "false",
            })
            .Build();

        IConfiguration simulation = CommentAnonymousFixtureProvider.BuildSimulationConfiguration(
            baseline,
            new string('a', 64));

        Assert.True(simulation.GetValue<bool>("AnonymousIdentity:ZkVerifier:Enabled"));
        Assert.True(simulation.GetValue<bool>("AnonymousIdentity:ZkVerifier:LocalDevFixture:Enabled"));
        Assert.Equal(LocalDevZkProofBackend.BackendName, simulation["AnonymousIdentity:ZkVerifier:Backend"]);
        Assert.False(simulation.GetValue<bool>("AnonymousIdentity:ZkCommentPolicy:Enabled"));
        Assert.DoesNotContain(simulation.GetSection("AnonymousIdentity:ZkCommentPolicy").GetChildren(),
            static key => key.Key is "CredentialReady" or "TrustedSetupVerified");
    }

    [Fact]
    public async Task SimulationProofService_DelegatesProofVerificationWithinLocalReadinessDomain()
    {
        IZkAnonymousProofService inner = Substitute.For<IZkAnonymousProofService>();
        var request = new ZkProofVerificationRequest(
            "comment.create",
            "comment:v1:article:42:top",
            "fsus.anonymous.comment.v5",
            new string('a', 64),
            6,
            new string('b', 64),
            new string('c', 64),
            new string('d', 64),
            true,
            true,
            "common",
            false,
            [1],
            new string('e', 64),
            new string('f', 64));
        inner.VerifyCommentProofAsync(request, CancellationToken.None)
            .Returns(ZkProofVerificationResult.Success());
        var simulation = new CommentFixtureZkSimulationProofService(inner);

        ZkProofVerificationResult result = await simulation.VerifyCommentProofAsync(
            request,
            CancellationToken.None);

        Assert.True(result.Verified);
        Assert.True(simulation.CurrentZkCommentPolicy.Enabled);
        Assert.True(simulation.CurrentZkCommentPolicy.CredentialRequired);
        Assert.Empty(simulation.CurrentZkCommentPolicy.UnavailableReason);
        await inner.Received(1).VerifyCommentProofAsync(request, CancellationToken.None);
    }

    [Fact]
    public void ProviderActivation_ActualProductionHostOverridesDevelopmentConfiguration()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = Environments.Development,
                [LocalCommentFixtureEndpoints.AllowConfigurationKey] = "true",
                [LocalCommentFixtureEndpoints.SecretConfigurationKey] = "local-fixture-secret"
            })
            .Build();
        IWebHostEnvironment environment = Substitute.For<IWebHostEnvironment>();
        environment.EnvironmentName.Returns(Environments.Production);
        var httpContext = new DefaultHttpContext();
        httpContext.Connection.RemoteIpAddress = IPAddress.Loopback;
        httpContext.Request.Headers[LocalCommentFixtureEndpoints.SecretHeaderName] = "local-fixture-secret";
        httpContext.Request.Headers[HttpTestSessionKeyScope.HeaderName] = TestSession;
        ITestSessionContext testSession = Substitute.For<ITestSessionContext>();
        testSession.IsActive.Returns(true);
        testSession.SessionId.Returns(TestSession);

        Assert.False(CommentAnonymousFixtureProvider.IsActivationAllowed(
            environment,
            configuration,
            httpContext,
            testSession,
            CreateRequest()));

        environment.EnvironmentName.Returns(Environments.Development);
        Assert.True(CommentAnonymousFixtureProvider.IsActivationAllowed(
            environment,
            configuration,
            httpContext,
            testSession,
            CreateRequest()));

        IConfiguration authFixtureConfiguration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = "true",
                [LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey] = "local-fixture-secret"
            })
            .Build();
        Assert.True(CommentAnonymousFixtureProvider.IsActivationAllowed(
            environment,
            authFixtureConfiguration,
            httpContext,
            testSession,
            CreateRequest()));
    }

    [Fact]
    public async Task CapabilityCustodyFailure_CompensatesWithProductionAnonymousDelete()
    {
        var vault = new ThrowingCapabilityVault();
        ICommentManagementCapabilityService capabilities = Substitute.For<ICommentManagementCapabilityService>();
        ICommentAuthorManagementService management = Substitute.For<ICommentAuthorManagementService>();
        capabilities.IssueChallengeAsync(
                CommentId,
                ManagementSecret,
                CommentManagementPurposes.Delete,
                CancellationToken.None)
            .Returns(new CommentManagementChallengeResult(
                true,
                "delete-challenge",
                DateTime.UtcNow.AddMinutes(1),
                null,
                1));
        management.DeleteAsAnonymousAsync(
                CommentId,
                ManagementSecret,
                "delete-challenge",
                CancellationToken.None)
            .Returns(new CommentAuthorMutationResult(
                true,
                "ok",
                2,
                CommentModerationStatus.Pending));

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CommentAnonymousFixtureProvider.StoreCapabilityOrCompensateAsync(
                vault,
                capabilities,
                management,
                Owner,
                TestSession,
                CommentId,
                ManagementSecret));

        Assert.Contains("compensated through production delete semantics", error.Message, StringComparison.Ordinal);
        await capabilities.Received(1).IssueChallengeAsync(
            CommentId,
            ManagementSecret,
            CommentManagementPurposes.Delete,
            CancellationToken.None);
        await management.Received(1).DeleteAsAnonymousAsync(
            CommentId,
            ManagementSecret,
            "delete-challenge",
            CancellationToken.None);
    }

    [Fact]
    public async Task CapabilityCustodySuccess_DoesNotInvokeCompensation()
    {
        var vault = new CommentAnonymousFixtureCapabilityVault();
        ICommentManagementCapabilityService capabilities = Substitute.For<ICommentManagementCapabilityService>();
        ICommentAuthorManagementService management = Substitute.For<ICommentAuthorManagementService>();

        await CommentAnonymousFixtureProvider.StoreCapabilityOrCompensateAsync(
            vault,
            capabilities,
            management,
            Owner,
            TestSession,
            CommentId,
            ManagementSecret);

        Assert.True(vault.TryGet(Owner, TestSession, CommentId, out string stored));
        Assert.Equal(ManagementSecret, stored);
        await capabilities.DidNotReceiveWithAnyArgs().IssueChallengeAsync(
            default,
            default!,
            default!,
            default);
        await management.DidNotReceiveWithAnyArgs().DeleteAsAnonymousAsync(
            default,
            default!,
            default!,
            default);
    }

    [Fact]
    public async Task CapabilityCustodyAndCompensationFailure_RequiresOuterRecovery()
    {
        var vault = new ThrowingCapabilityVault();
        ICommentManagementCapabilityService capabilities = Substitute.For<ICommentManagementCapabilityService>();
        ICommentAuthorManagementService management = Substitute.For<ICommentAuthorManagementService>();
        capabilities.IssueChallengeAsync(
                CommentId,
                ManagementSecret,
                CommentManagementPurposes.Delete,
                CancellationToken.None)
            .Returns(CommentManagementChallengeResult.Failed("comment_management_capability_invalid"));

        AggregateException error = await Assert.ThrowsAsync<AggregateException>(() =>
            CommentAnonymousFixtureProvider.StoreCapabilityOrCompensateAsync(
                vault,
                capabilities,
                management,
                Owner,
                TestSession,
                CommentId,
                ManagementSecret));

        Assert.Contains("outer isolated namespace recovery is required", error.Message, StringComparison.Ordinal);
        Assert.Equal(2, error.InnerExceptions.Count);
        await management.DidNotReceiveWithAnyArgs().DeleteAsAnonymousAsync(
            default,
            default!,
            default!,
            default);
    }

    [Fact]
    public async Task OperationLedger_PersistsProtectedExactReference()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-comment-ledger-{Guid.NewGuid():N}");
        try
        {
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> { ["FSUSBLOG_DATA_ROOT"] = root })
                .Build();
            var protection = new EphemeralDataProtectionProvider();
            var ledger = new CommentAnonymousFixtureOperationLedger(configuration, protection);
            CommentAnonymousFixtureOperationReference reference = CreateOperationReference();

            await ledger.StoreAsync(reference, CancellationToken.None);
            CommentAnonymousFixtureOperationReference? loaded = await new CommentAnonymousFixtureOperationLedger(
                configuration,
                protection).ReadAsync(reference.OperationPlanDigest, CancellationToken.None);

            Assert.Equal(reference, loaded);
            string payload = await File.ReadAllTextAsync(Path.Combine(
                root,
                "test-fixtures",
                "comment-anonymous-operations",
                $"{reference.OperationPlanDigest}.json"));
            Assert.DoesNotContain(ManagementSecret, payload, StringComparison.Ordinal);

            await ledger.RemoveAsync(reference.OperationPlanDigest, CancellationToken.None);
            Assert.Null(await ledger.ReadAsync(reference.OperationPlanDigest, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task OperationLedger_RejectsConflictingReferenceForSamePlanDigest()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-comment-ledger-{Guid.NewGuid():N}");
        try
        {
            IConfiguration configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?> { ["FSUSBLOG_DATA_ROOT"] = root })
                .Build();
            var ledger = new CommentAnonymousFixtureOperationLedger(
                configuration,
                new EphemeralDataProtectionProvider());
            CommentAnonymousFixtureOperationReference reference = CreateOperationReference();
            await ledger.StoreAsync(reference, CancellationToken.None);

            await Assert.ThrowsAsync<InvalidOperationException>(() => ledger.StoreAsync(
                reference with
                {
                    CommentId = CommentId + 1
                },
                CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void OperationPlanDigest_BindsEveryCommentAndPolicyInput()
    {
        CommentAnonymousFixtureCreateRequest request = CreateRequest();
        string baseline = CommentAnonymousFixtureProvider.ComputeOperationPlanDigest(request, new string('a', 64));
        var alternatives = new[]
        {
            request with { Owner = $"{Owner}-other" },
            request with { TestSession = "fx-fedcba9876543210fedcba98" },
            request with { PlanDigest = Digest('9') },
            request with { SemanticRole = "region-manual-review" },
            request with { ArticleId = 43 },
            request with { Content = "different fixture content" },
            request with { ParentId = "11" },
            request with { RootId = "12" },
            request with { ReplyToCommentId = "13" },
            request with { Scope = "comment:v1:article:43:top" },
            request with { DisplayLanguage = "zh-CN" },
            request with { RegionDecision = null },
            request with { RegionDecision = request.RegionDecision! with { SubmitRegionConfidence = 0.5d } },
            request with { RegionDecision = request.RegionDecision! with { BlockedRegions = [RegionCodes.Japan] } },
            request with { RegionDecision = request.RegionDecision! with { RiskLabels = [ModerationRiskCategories.Gambling] } },
            request with { RegionDecision = request.RegionDecision! with { PolicyVersion = "policy-v2" } },
            request with
            {
                RegionDecision = request.RegionDecision! with
                {
                    RuleHits = [new RegionRuleHit(
                        "rule-1",
                        RegionCodes.Global,
                        ModerationRiskCategories.Gambling,
                        "high",
                        "review",
                        "hide",
                        "review required",
                        "fixture rule")]
                }
            }
        };

        Assert.Matches("^[a-f0-9]{64}$", baseline);
        Assert.All(alternatives, alternative => Assert.NotEqual(
            baseline,
            CommentAnonymousFixtureProvider.ComputeOperationPlanDigest(alternative, new string('a', 64))));
        Assert.NotEqual(
            baseline,
            CommentAnonymousFixtureProvider.ComputeOperationPlanDigest(request, new string('b', 64)));
    }

    [Fact]
    public void PortBinding_RequiresSortedExactCrossDomainReferences()
    {
        CommentFixturePortBinding binding = CreateBinding();

        Assert.True(binding.IsValid());
        Assert.False((binding with
        {
            ProfileId = string.Empty
        }).IsValid());
        Assert.False((binding with
        {
            Capabilities = ["moderation.policy-matrix", "comment.threaded"]
        }).IsValid());
        Assert.False((binding with
        {
            ArticleId = 0
        }).IsValid());
        Assert.False((binding with
        {
            AuthProducerResultDigest = "invalid"
        }).IsValid());
        Assert.False((binding with
        {
            AuthPrepareReferenceDigests = [Digest('a'), Digest('b')]
        }).IsValid());
        Assert.False((binding with
        {
            TemporalContextDigest = "invalid"
        }).IsValid());
        Assert.False((binding with
        {
            ProducerPlanDigest = "invalid"
        }).IsValid());
        Assert.False((binding with
        {
            PlanDigest = "invalid"
        }).IsValid());
    }

    [Fact]
    public void CleanupLedgerHydration_RequiresExactOuterPlanAndOwnedIdentity()
    {
        CommentFixturePortBinding binding = CreateBinding();
        CommentAnonymousFixtureOperationReference reference = CreateOperationReference();
        var expected = new CommentThreadFixtureOwnedIdentity(
            CommentId,
            42,
            "pending",
            CommentAuthorModes.ZkAnonymous,
            null,
            Digest('8'),
            1,
            false,
            $"sha256:{reference.OperationPlanDigest}");

        Assert.True(CommentThreadFixturePort.IsExactAnonymousOperationReference(reference, binding, expected));
        Assert.False(CommentThreadFixturePort.IsExactAnonymousOperationReference(
            reference with
            {
                PlanDigest = Digest('9')
            }, binding, expected));
        Assert.False(CommentThreadFixturePort.IsExactAnonymousOperationReference(
            reference with
            {
                Owner = $"{Owner}-other"
            }, binding, expected));
        Assert.False(CommentThreadFixturePort.IsExactAnonymousOperationReference(
            reference with
            {
                CommentId = CommentId + 1
            }, binding, expected));
        Assert.False(CommentThreadFixturePort.IsExactAnonymousOperationReference(
            reference, binding, expected with
            {
                ActorMode = CommentAuthorModes.Public
            }));
    }

    private static CommentAnonymousFixtureCreateRequest CreateRequest()
        => new(
            Owner,
            TestSession,
            Digest('6'),
            "pending",
            42,
            "fixture content",
            null,
            null,
            null,
            "comment:v1:article:42:top",
            "en",
            new RegionModerationDecision(
                true,
                RegionCodes.Global,
                1d,
                "fixture-region-provider",
                null,
                [],
                [],
                [],
                "policy-v1",
                "allowed",
                "allowed",
                false,
            false));

    private static CommentAnonymousFixtureOperationReference CreateOperationReference()
    {
        var comment = new CommentCreateResult(
            true,
            CommentId,
            CommentId,
            null,
            new DateTime(2042, 5, 17, 9, 30, 0, DateTimeKind.Utc),
            CommentModerationStatus.Pending,
            "pending",
            false,
            false);
        return new CommentAnonymousFixtureOperationReference(
            new string('a', 64),
            Owner,
            TestSession,
            Digest('6'),
            "pending",
            42,
            new string('b', 64),
            null,
            null,
            null,
            "comment:v1:article:42:top",
            "en",
            CommentId,
            ManagementSecret,
            comment,
            new CommentFixtureZkAuthorityEvidence(
                "fsusblog.comment-fixture-zk-authority-evidence.v1",
                "local-dev-simulation",
                LocalDevZkProofBackend.BackendName,
                true,
                false,
                "pending",
                new string('a', 64),
                new string('c', 64),
                new string('d', 64),
                true,
                false));
    }

    private static CommentFixturePortBinding CreateBinding()
        => new(
            "run-1",
            "comment-test",
            TestSession,
            Owner,
            "comments-moderation",
            ["comment.moderation-matrix", "comment.threaded", "moderation.policy-matrix"],
            42,
            Digest('a'),
            [Digest('b'), Digest('c'), Digest('d')],
            Digest('e'),
            Digest('f'),
            Digest('1'),
            Digest('2'),
            Digest('3'),
            Digest('4'),
            Digest('5'),
            Digest('6'));

    private static string Digest(char value) => $"sha256:{new string(value, 64)}";

    private sealed class ThrowingCapabilityVault : ICommentAnonymousFixtureCapabilityVault
    {
        public void Store(string owner, string testSession, long commentId, string managementSecret)
            => throw new InvalidOperationException("fixture custody unavailable");

        public bool TryGet(string owner, string testSession, long commentId, out string managementSecret)
        {
            managementSecret = string.Empty;
            return false;
        }

        public void Remove(string owner, string testSession, long commentId)
        {
        }
    }
}
