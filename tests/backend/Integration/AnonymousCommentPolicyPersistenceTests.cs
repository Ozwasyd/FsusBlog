using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using SqlSugar;
namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AnonymousCommentPolicyPersistenceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task PolicySnapshot_LoadsPersistsInvalidatesAndReloadsAcrossServiceInstances()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        SeedPolicyDatabase(connectionString, new AnonymousCommentPolicy
        {
            Id = 1,
            AnonymousCommentsEnabled = false,
            PublicCommentsEnabled = false,
            ZkAnonymousEnabled = false,
            DefaultAuthorMode = CommentAuthorModes.ZkAnonymous,
            SupportedDisplayLanguages = "en",
            CommentMaxChars = 1800,
            CommentMaxUtf8Bytes = 7200,
            ChangedBy = "seed",
            UpdatedReason = "seeded",
            UpdatedAtUtc = new DateTime(2026, 6, 16, 0, 0, 0, DateTimeKind.Utc)
        });

        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        dispatcher.InvalidateCommentPolicyAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        await using ServiceProvider provider = BuildPolicyProvider(connectionString, dispatcher);
        IServiceScopeFactory scopeFactory = provider.GetRequiredService<IServiceScopeFactory>();
        IConfiguration configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:AnonymousCommentsEnabled"] = "true",
            ["AnonymousIdentity:PublicCommentsEnabled"] = "true",
            ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true",
            ["AnonymousIdentity:DefaultAuthorMode"] = CommentAuthorModes.Public
        });

        var service = new AnonymousCommentPolicyService(configuration, scopeFactory);
        var secondInstance = new AnonymousCommentPolicyService(configuration, scopeFactory);
        AnonymousCommentPolicySnapshot initial = await service.GetCurrentAsync();
        AnonymousCommentPolicySnapshot secondInitial = await secondInstance.GetCurrentAsync();

        Assert.False(initial.AnonymousCommentsEnabled);
        Assert.False(initial.PublicCommentsEnabled);
        Assert.False(initial.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, initial.DefaultAuthorMode);
        Assert.Equal(["en"], initial.SupportedDisplayLanguages);
        Assert.Equal(initial.SnapshotHash, secondInitial.SnapshotHash);

        AnonymousCommentPolicySnapshot updated = await service.UpdatePolicyAsync(new AnonymousCommentPolicyUpdateRequest(
            AnonymousCommentsEnabled: true,
            PublicCommentsEnabled: true,
            ZkAnonymousEnabled: true,
            DefaultAuthorMode: CommentAuthorModes.ZkAnonymous,
            SupportedDisplayLanguages: ["fr", "zh-CN"],
            CommentMaxChars: 2400,
            CommentMaxUtf8Bytes: 9600,
            Reason: "policy rollout"),
            adminPrincipalId: 42);

        Assert.True(updated.AnonymousCommentsEnabled);
        Assert.True(updated.PublicCommentsEnabled);
        Assert.True(updated.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, updated.DefaultAuthorMode);
        Assert.Equal(["zh-CN"], updated.SupportedDisplayLanguages);
        Assert.Equal(2400, updated.CommentMaxChars);
        Assert.Equal(9600, updated.CommentMaxUtf8Bytes);
        Assert.Equal("admin:42", updated.ChangedBy);
        Assert.Equal("policy rollout", updated.Reason);
        Assert.NotEmpty(updated.SnapshotHash);
        await dispatcher.Received(1).InvalidateCommentPolicyAsync(Arg.Any<CancellationToken>());

        AnonymousCommentPolicySnapshot secondReloaded = await secondInstance.GetCurrentAsync();
        Assert.Equal(updated.SnapshotHash, secondReloaded.SnapshotHash);
        Assert.Equal("policy rollout", secondReloaded.Reason);

        using SqlSugarClient verifyDb = CreatePolicyDb(connectionString);
        AnonymousCommentPolicy stored = verifyDb.Queryable<AnonymousCommentPolicy>()
            .First(static item => item.Id == 1);
        Assert.True(stored.AnonymousCommentsEnabled);
        Assert.True(stored.PublicCommentsEnabled);
        Assert.True(stored.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, stored.DefaultAuthorMode);
        Assert.Equal("zh-CN", stored.SupportedDisplayLanguages);
        Assert.Equal(2400, stored.CommentMaxChars);
        Assert.Equal(9600, stored.CommentMaxUtf8Bytes);
        Assert.Equal("admin:42", stored.ChangedBy);
        Assert.Equal("policy rollout", stored.UpdatedReason);
        Assert.Equal(updated.SnapshotHash, stored.SnapshotHash);
        Assert.Equal(42, stored.UpdatedByAdminId);

        var restarted = new AnonymousCommentPolicyService(BuildConfiguration(new Dictionary<string, string?>
        {
            ["AnonymousIdentity:AnonymousCommentsEnabled"] = "false",
            ["AnonymousIdentity:PublicCommentsEnabled"] = "false",
            ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "false",
            ["AnonymousIdentity:DefaultAuthorMode"] = CommentAuthorModes.Public
        }), scopeFactory);

        AnonymousCommentPolicySnapshot reloaded = await restarted.GetCurrentAsync();
        Assert.True(reloaded.AnonymousCommentsEnabled);
        Assert.True(reloaded.PublicCommentsEnabled);
        Assert.True(reloaded.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, reloaded.DefaultAuthorMode);
        Assert.Equal(["zh-CN"], reloaded.SupportedDisplayLanguages);
        Assert.Equal(updated.SnapshotHash, reloaded.SnapshotHash);
        Assert.Equal("admin:42", reloaded.ChangedBy);
        Assert.Equal("policy rollout", reloaded.Reason);
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

    private static ServiceProvider BuildPolicyProvider(
        string connectionString,
        ICacheInvalidationDispatcher dispatcher)
    {
        var services = new ServiceCollection();
        services.AddSingleton(dispatcher);
        services.AddScoped<ISqlSugarClient>(_ => CreatePolicyDb(connectionString));
        return services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });
    }

    private static void SeedPolicyDatabase(string connectionString, AnonymousCommentPolicy policy)
    {
        using SqlSugarClient db = CreatePolicyDb(connectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AnonymousCommentPolicy));
        db.Insertable(policy).ExecuteCommand();
    }

    private static SqlSugarClient CreatePolicyDb(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);
}
