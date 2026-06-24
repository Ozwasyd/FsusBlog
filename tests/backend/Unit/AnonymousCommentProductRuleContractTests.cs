using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using SqlSugar;
using System.Linq.Expressions;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentProductRuleContractTests
{
    [Fact]
    public void PublicCommentPolicyBinaryEndpoint_ExposesServerPolicyForComposerControls()
    {
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");

        Assert.Contains("group.MapGet(\"/comment/policy\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("IAnonymousCommentPolicyService", endpoints, StringComparison.Ordinal);
        Assert.Contains("ToCommentPolicyCore", endpoints, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.CommentPolicySnapshot", endpoints, StringComparison.Ordinal);
        Assert.Contains("PodBinaryCodec.WriteCommentPolicySnapshot", endpoints, StringComparison.Ordinal);
        Assert.Contains(".AllowAnonymous()", endpoints, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"public_read\")", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCommentPolicy_EnforcesAnonymousDefaultPublicOptInAndAdminDisabledState()
    {
        var enabled = new AnonymousCommentPolicyService(BuildConfiguration([]));

        CommentAuthorModeDecision implicitDefault = enabled.EvaluateAuthorMode(null, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision publicWithoutOptIn = enabled.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision publicWithOptIn = enabled.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: true);

        Assert.True(implicitDefault.Allowed);
        Assert.Equal(CommentAuthorModes.Anonymous, implicitDefault.EffectiveAuthorMode);
        Assert.False(publicWithoutOptIn.Allowed);
        Assert.Equal("public_opt_in_required", publicWithoutOptIn.Status);
        Assert.True(publicWithOptIn.Allowed);

        var disabled = new AnonymousCommentPolicyService(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:AnonymousCommentsEnabled"] = "false",
            ["AnonymousIdentity:PublicCommentsEnabled"] = "true",
            ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
        }));

        Assert.False(disabled.EvaluateAuthorMode(CommentAuthorModes.Anonymous, publicSendExplicitlySelected: false).Allowed);
        Assert.False(disabled.EvaluateAuthorMode(CommentAuthorModes.ZkAnonymous, publicSendExplicitlySelected: false).Allowed);
        Assert.True(disabled.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: true).Allowed);
    }

    [Fact]
    public void AnonymousCommentPolicyService_DoesNotBlockOnSqlSugarAsyncCalls()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AnonymousCommentPolicyService.cs");

        Assert.DoesNotContain(".GetAwaiter().GetResult()", service, StringComparison.Ordinal);
        Assert.Contains("Task<AnonymousCommentPolicySnapshot> GetCurrentAsync", service, StringComparison.Ordinal);
        Assert.Contains("Task<AnonymousCommentPolicySnapshot> UpdatePolicyAsync", service, StringComparison.Ordinal);
        Assert.Contains("Task<CommentAuthorModeDecision> EvaluateAuthorModeAsync", service, StringComparison.Ordinal);
        Assert.Contains("LoadPersistedPolicyAsync", service, StringComparison.Ordinal);
        Assert.Contains("PersistPolicyAsync", service, StringComparison.Ordinal);
        Assert.Contains("InvalidatePolicyCacheAsync", service, StringComparison.Ordinal);
        Assert.Contains(".FirstAsync(cancellationToken)", service, StringComparison.Ordinal);
        Assert.Contains(".ExecuteCommandAsync(cancellationToken)", service, StringComparison.Ordinal);
        Assert.Contains(".InvalidateCommentPolicyAsync(cancellationToken)", service, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnonymousCommentPolicyService_GetCurrentAsyncYieldsWhilePolicyQueryIsSlow()
    {
        var queryStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseQuery = new TaskCompletionSource<AnonymousCommentPolicy>(TaskCreationOptions.RunContinuationsAsynchronously);
        var queryable = Substitute.For<ISugarQueryable<AnonymousCommentPolicy>>();
        queryable.Where(Arg.Any<Expression<Func<AnonymousCommentPolicy, bool>>>()).Returns(queryable);
        queryable.FirstAsync(Arg.Any<CancellationToken>()).Returns(_ =>
        {
            queryStarted.TrySetResult();
            return releaseQuery.Task;
        });

        var db = Substitute.For<ISqlSugarClient>();
        db.Queryable<AnonymousCommentPolicy>().Returns(queryable);
        await using ServiceProvider provider = new ServiceCollection()
            .AddSingleton(db)
            .BuildServiceProvider();
        var service = new AnonymousCommentPolicyService(
            BuildConfiguration([]),
            provider.GetRequiredService<IServiceScopeFactory>());

        Task<AnonymousCommentPolicySnapshot> loadTask = service.GetCurrentAsync(CancellationToken.None);
        await queryStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
        Task<int> unrelatedWork = Task.Run(static () => Environment.CurrentManagedThreadId);

        Assert.Same(unrelatedWork, await Task.WhenAny(unrelatedWork, Task.Delay(TimeSpan.FromMilliseconds(250))));
        Assert.False(loadTask.IsCompleted);

        releaseQuery.SetResult(new AnonymousCommentPolicy
        {
            Id = 1,
            AnonymousCommentsEnabled = false,
            PublicCommentsEnabled = true,
            ZkAnonymousEnabled = true,
            DefaultAuthorMode = CommentAuthorModes.ZkAnonymous,
            SupportedDisplayLanguages = "en",
            ChangedBy = "test",
            UpdatedReason = "slow-db",
            UpdatedAtUtc = new DateTime(2026, 6, 24, 0, 0, 0, DateTimeKind.Utc)
        });
        AnonymousCommentPolicySnapshot snapshot = await loadTask.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.False(snapshot.AnonymousCommentsEnabled);
        Assert.True(snapshot.PublicCommentsEnabled);
        Assert.True(snapshot.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, snapshot.DefaultAuthorMode);
    }

    [Fact]
    public void AnonymousDisplayNames_AreCuratedLocalizedStableAndDoNotLeakIdentityTokens()
    {
        var generator = new CommentAnonymousDisplayNameGenerator();
        var zh = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "zh-CN",
            "article:42",
            "account:100|username:alice|public:AliceChen|credential:cred-1|nullifier:abc123"));
        var zhAgain = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "zh-CN",
            "article:42",
            "account:100|username:alice|public:AliceChen|credential:cred-1|nullifier:abc123"));
        var en = generator.Generate(new CommentAnonymousDisplayNameRequest(
            "en",
            "article:42",
            "account:100|username:alice|public:AliceChen|credential:cred-1|nullifier:abc123"));

        Assert.Equal(zh, zhAgain);
        Assert.Equal("zh-CN", zh.DisplayLanguage);
        Assert.Equal("en", en.DisplayLanguage);
        Assert.StartsWith("匿名用户", zh.DisplayName, StringComparison.Ordinal);
        Assert.StartsWith("Anonymous User ", en.DisplayName, StringComparison.Ordinal);

        foreach (string leakedToken in new[] { "100", "alice", "AliceChen", "cred-1", "abc123", "credential", "nullifier", "public" })
        {
            Assert.DoesNotContain(leakedToken, zh.DisplayName, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(leakedToken, en.DisplayName, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
}
