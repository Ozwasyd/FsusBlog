using System.Linq.Expressions;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentPolicyTests
{
    [Fact]
    public void AnonymousCommentPolicy_DefaultsToZkFailClosedAndRejectsImplicitPublicMode()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration([]));

        CommentAuthorModeDecision defaultMode = service.EvaluateAuthorMode(null, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision retired = service.EvaluateAuthorMode(CommentAuthorModes.RetiredAnonymous, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision implicitPublic = service.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision explicitPublic = service.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: true);

        Assert.False(defaultMode.Allowed);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, defaultMode.EffectiveAuthorMode);
        Assert.Equal("zk_anonymous_disabled", defaultMode.Status);
        Assert.False(retired.Allowed);
        Assert.Equal("anonymous_author_mode_retired", retired.Status);
        Assert.False(implicitPublic.Allowed);
        Assert.Equal("public_opt_in_required", implicitPublic.Status);
        Assert.True(explicitPublic.Allowed);
    }

    [Fact]
    public void AnonymousCommentPolicy_DisabledAnonymousRejectsAnonymousAndZkModes()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:AnonymousCommentsEnabled"] = "false",
            ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
        }));

        CommentAuthorModeDecision anonymous = service.EvaluateAuthorMode(CommentAuthorModes.RetiredAnonymous, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision zk = service.EvaluateAuthorMode(CommentAuthorModes.ZkAnonymous, publicSendExplicitlySelected: false);

        Assert.False(anonymous.Allowed);
        Assert.Equal("anonymous_author_mode_retired", anonymous.Status);
        Assert.False(zk.Allowed);
        Assert.Equal("anonymous_comments_disabled", zk.Status);
    }

    [Fact]
    public void AnonymousCommentPolicy_UpdateCanExposeZkAndCuratedLanguages()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration([]));

        AnonymousCommentPolicySnapshot updated = service.UpdatePolicy(new AnonymousCommentPolicyUpdateRequest(
            AnonymousCommentsEnabled: true,
            PublicCommentsEnabled: true,
            ZkAnonymousEnabled: true,
            DefaultAuthorMode: CommentAuthorModes.ZkAnonymous,
            SupportedDisplayLanguages: ["zh-CN", "en", "fr"],
            CommentMaxChars: 2500,
            CommentMaxUtf8Bytes: 10_000));

        Assert.True(updated.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, updated.DefaultAuthorMode);
        Assert.Equal(["zh-CN", "en"], updated.SupportedDisplayLanguages);
        Assert.Equal(2500, updated.CommentMaxChars);
        Assert.Equal(10_000, updated.CommentMaxUtf8Bytes);
    }

    [Fact]
    public void AnonymousCommentPolicy_DefaultsAndValidatesConfigurableCommentLimits()
    {
        var defaults = new AnonymousCommentPolicyService(BuildConfiguration([]));
        AnonymousCommentPolicySnapshot current = defaults.Current;

        Assert.Equal(1000, current.CommentMaxChars);
        Assert.Equal(4096, current.CommentMaxUtf8Bytes);

        var configured = new AnonymousCommentPolicyService(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:CommentMaxChars"] = "2200",
            ["AnonymousIdentity:CommentMaxUtf8Bytes"] = "9000"
        }));

        Assert.Equal(2200, configured.Current.CommentMaxChars);
        Assert.Equal(9000, configured.Current.CommentMaxUtf8Bytes);
    }

    [Fact]
    public void AnonymousCommentPolicy_UpdateRejectsOutOfRangeCommentLimits()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration([]));

        ArgumentOutOfRangeException lowChars = Assert.Throws<ArgumentOutOfRangeException>(() => service.UpdatePolicy(new AnonymousCommentPolicyUpdateRequest(
            AnonymousCommentsEnabled: null,
            PublicCommentsEnabled: null,
            ZkAnonymousEnabled: null,
            DefaultAuthorMode: null,
            SupportedDisplayLanguages: null,
            CommentMaxChars: 99,
            CommentMaxUtf8Bytes: null,
            Reason: "unit")));
        ArgumentOutOfRangeException highBytes = Assert.Throws<ArgumentOutOfRangeException>(() => service.UpdatePolicy(new AnonymousCommentPolicyUpdateRequest(
            AnonymousCommentsEnabled: null,
            PublicCommentsEnabled: null,
            ZkAnonymousEnabled: null,
            DefaultAuthorMode: null,
            SupportedDisplayLanguages: null,
            CommentMaxChars: null,
            CommentMaxUtf8Bytes: 12_289,
            Reason: "unit")));

        Assert.Equal("CommentMaxChars", lowChars.ParamName);
        Assert.Equal("CommentMaxUtf8Bytes", highBytes.ParamName);
    }

    [Fact]
    public void AnonymousCommentPolicy_UpdateRejectsInvalidAuthorMode()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration([]));

        ArgumentException ex = Assert.Throws<ArgumentException>(() => service.UpdatePolicy(new AnonymousCommentPolicyUpdateRequest(
            AnonymousCommentsEnabled: null,
            PublicCommentsEnabled: null,
            ZkAnonymousEnabled: null,
            DefaultAuthorMode: "invalid-mode",
            SupportedDisplayLanguages: ["fr", "zh-CN"],
            CommentMaxChars: null,
            CommentMaxUtf8Bytes: null,
            Reason: "unit")));

        Assert.Equal("DefaultAuthorMode", ex.ParamName);
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

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

}
