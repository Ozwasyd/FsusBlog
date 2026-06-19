using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentGovernanceContractTests
{
    [Fact]
    public void AnonymousCommentGovernance_DefinesStorageAndMigration()
    {
        string entities = string.Join(
            "\n",
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AnonymousCommentPolicy.cs"),
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AnonymousCredential.cs"),
            BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/CommentAnonymousNullifier.cs"));
        string migrations = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("[SugarTable(\"anonymous_comment_policy\")]", entities, StringComparison.Ordinal);
        Assert.Contains("[SugarTable(\"anonymous_credential\")]", entities, StringComparison.Ordinal);
        Assert.Contains("[SugarTable(\"comment_anonymous_nullifier\")]", entities, StringComparison.Ordinal);
        Assert.Contains("BuildAnonymousCommentGovernanceMigration()", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS anonymous_comment_policy", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS anonymous_credential", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS comment_anonymous_nullifier", migrations, StringComparison.Ordinal);

        foreach (string requiredColumn in new[]
        {
            "anonymous_comments_enabled",
            "public_comments_enabled",
            "zk_anonymous_enabled",
            "default_author_mode",
            "supported_display_languages",
            "snapshot_hash",
            "updated_reason",
            "commitment_hash",
            "credential_level",
            "revoked_at_utc",
            "nullifier_hash",
            "use_count",
            "blocked"
        })
        {
            Assert.Contains(requiredColumn, migrations, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void AnonymousCommentGovernance_RegistersPolicyCredentialAndNullifierServices()
    {
        string services = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs");

        Assert.Contains("IAnonymousCommentPolicyService", services, StringComparison.Ordinal);
        Assert.Contains("AnonymousCommentPolicyService", services, StringComparison.Ordinal);
        Assert.Contains("IAnonymousCredentialService", services, StringComparison.Ordinal);
        Assert.Contains("AnonymousCredentialService", services, StringComparison.Ordinal);
        Assert.Contains("ICommentAnonymousNullifierService", services, StringComparison.Ordinal);
        Assert.Contains("CommentAnonymousNullifierService", services, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCommentPolicyService_UsesPersistentRuntimeSnapshotAndInvalidatesPolicyCache()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AnonymousCommentPolicyService.cs");
        string cache = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs");
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/AuthoringEndpoints.cs");

        Assert.Contains("IServiceScopeFactory", service, StringComparison.Ordinal);
        Assert.Contains("LoadPersistedPolicy", service, StringComparison.Ordinal);
        Assert.Contains("PersistPolicy", service, StringComparison.Ordinal);
        Assert.Contains("Queryable<AnonymousCommentPolicy>()", service, StringComparison.Ordinal);
        Assert.Contains("Updateable(entity)", service, StringComparison.Ordinal);
        Assert.Contains("SnapshotHash", service, StringComparison.Ordinal);
        Assert.Contains("ChangedBy", service, StringComparison.Ordinal);
        Assert.Contains("Reason", service, StringComparison.Ordinal);
        Assert.Contains("InvalidateCommentPolicyAsync", service, StringComparison.Ordinal);
        Assert.Contains("InvalidateCommentPolicyAsync", cache, StringComparison.Ordinal);
        Assert.Contains("snapshot.SnapshotHash", endpoints, StringComparison.Ordinal);
        Assert.Contains("request.Reason", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCommentPolicy_DefaultsToAnonymousAndRejectsImplicitPublicMode()
    {
        var service = new AnonymousCommentPolicyService(BuildConfiguration([]));

        CommentAuthorModeDecision anonymous = service.EvaluateAuthorMode(null, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision implicitPublic = service.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision explicitPublic = service.EvaluateAuthorMode(CommentAuthorModes.Public, publicSendExplicitlySelected: true);

        Assert.True(anonymous.Allowed);
        Assert.Equal(CommentAuthorModes.Anonymous, anonymous.EffectiveAuthorMode);
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

        CommentAuthorModeDecision anonymous = service.EvaluateAuthorMode(CommentAuthorModes.Anonymous, publicSendExplicitlySelected: false);
        CommentAuthorModeDecision zk = service.EvaluateAuthorMode(CommentAuthorModes.ZkAnonymous, publicSendExplicitlySelected: false);

        Assert.False(anonymous.Allowed);
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
            SupportedDisplayLanguages: ["zh-CN", "en", "fr"]));

        Assert.True(updated.ZkAnonymousEnabled);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, updated.DefaultAuthorMode);
        Assert.Equal(["zh-CN", "en"], updated.SupportedDisplayLanguages);
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
            Reason: "unit")));

        Assert.Equal("DefaultAuthorMode", ex.ParamName);
    }

    [Fact]
    public async Task AnonymousCommentPolicyService_LoadsPersistsInvalidatesAndReloadsRuntimeSnapshot()
    {
        string dbPath = Path.Combine(Path.GetTempPath(), $"fsus-anonymous-policy-{Guid.NewGuid():N}.db");
        try
        {
            SeedPolicyDatabase(dbPath, new AnonymousCommentPolicy
            {
                Id = 1,
                AnonymousCommentsEnabled = false,
                PublicCommentsEnabled = false,
                ZkAnonymousEnabled = false,
                DefaultAuthorMode = CommentAuthorModes.ZkAnonymous,
                SupportedDisplayLanguages = "en",
                ChangedBy = "seed",
                UpdatedReason = "seeded",
                UpdatedAtUtc = new DateTime(2026, 6, 16, 0, 0, 0, DateTimeKind.Utc)
            });

            var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
            dispatcher.InvalidateCommentPolicyAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
            await using ServiceProvider provider = BuildPolicyProvider(dbPath, dispatcher);
            IServiceScopeFactory scopeFactory = provider.GetRequiredService<IServiceScopeFactory>();
            IConfiguration configuration = BuildConfiguration(new Dictionary<string, string?>
            {
                ["AnonymousIdentity:AnonymousCommentsEnabled"] = "true",
                ["AnonymousIdentity:PublicCommentsEnabled"] = "true",
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true",
                ["AnonymousIdentity:DefaultAuthorMode"] = CommentAuthorModes.Public
            });

            var service = new AnonymousCommentPolicyService(configuration, scopeFactory);
            AnonymousCommentPolicySnapshot initial = service.Current;

            Assert.False(initial.AnonymousCommentsEnabled);
            Assert.False(initial.PublicCommentsEnabled);
            Assert.False(initial.ZkAnonymousEnabled);
            Assert.Equal(CommentAuthorModes.ZkAnonymous, initial.DefaultAuthorMode);
            Assert.Equal(["en"], initial.SupportedDisplayLanguages);

            AnonymousCommentPolicySnapshot updated = service.UpdatePolicy(new AnonymousCommentPolicyUpdateRequest(
                AnonymousCommentsEnabled: true,
                PublicCommentsEnabled: true,
                ZkAnonymousEnabled: true,
                DefaultAuthorMode: CommentAuthorModes.Anonymous,
                SupportedDisplayLanguages: ["fr", "zh-CN"],
                Reason: "policy rollout"),
                adminPrincipalId: 42);

            Assert.True(updated.AnonymousCommentsEnabled);
            Assert.True(updated.PublicCommentsEnabled);
            Assert.True(updated.ZkAnonymousEnabled);
            Assert.Equal(CommentAuthorModes.Anonymous, updated.DefaultAuthorMode);
            Assert.Equal(["zh-CN"], updated.SupportedDisplayLanguages);
            Assert.Equal("admin:42", updated.ChangedBy);
            Assert.Equal("policy rollout", updated.Reason);
            Assert.NotEmpty(updated.SnapshotHash);

            await dispatcher.Received(1).InvalidateCommentPolicyAsync(Arg.Any<CancellationToken>());

            using SqlSugarClient verifyDb = CreatePolicyDb(dbPath);
            AnonymousCommentPolicy stored = verifyDb.Queryable<AnonymousCommentPolicy>()
                .First(static item => item.Id == 1);
            Assert.True(stored.AnonymousCommentsEnabled);
            Assert.True(stored.PublicCommentsEnabled);
            Assert.True(stored.ZkAnonymousEnabled);
            Assert.Equal(CommentAuthorModes.Anonymous, stored.DefaultAuthorMode);
            Assert.Equal("zh-CN", stored.SupportedDisplayLanguages);
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

            AnonymousCommentPolicySnapshot reloaded = restarted.Current;
            Assert.True(reloaded.AnonymousCommentsEnabled);
            Assert.True(reloaded.PublicCommentsEnabled);
            Assert.True(reloaded.ZkAnonymousEnabled);
            Assert.Equal(CommentAuthorModes.Anonymous, reloaded.DefaultAuthorMode);
            Assert.Equal(["zh-CN"], reloaded.SupportedDisplayLanguages);
            Assert.Equal(updated.SnapshotHash, reloaded.SnapshotHash);
            Assert.Equal("admin:42", reloaded.ChangedBy);
            Assert.Equal("policy rollout", reloaded.Reason);
        }
        finally
        {
            if (File.Exists(dbPath))
            {
                File.Delete(dbPath);
            }
        }
    }

    [Fact]
    public void CredentialAndNullifierServices_DoNotExposeReverseLookupFromNullifierToAccount()
    {
        string credentialService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AnonymousCredentialService.cs");
        string nullifierService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentAnonymousNullifierService.cs");

        Assert.Contains("IssueAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("GetActiveCredentialAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("RevokeAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("GetCredentialLevelAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("CheckAndReserveAsync", nullifierService, StringComparison.Ordinal);
        Assert.Contains("IncrementUsageAsync", nullifierService, StringComparison.Ordinal);
        Assert.Contains("BlockAsync", nullifierService, StringComparison.Ordinal);

        Assert.DoesNotContain("GetAccount", nullifierService, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", nullifierService, StringComparison.Ordinal);
        Assert.DoesNotContain("AnonymousCredential", nullifierService, StringComparison.Ordinal);
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();

    private static ServiceProvider BuildPolicyProvider(
        string dbPath,
        ICacheInvalidationDispatcher dispatcher)
    {
        var services = new ServiceCollection();
        services.AddSingleton(dispatcher);
        services.AddScoped<ISqlSugarClient>(_ => CreatePolicyDb(dbPath));
        return services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });
    }

    private static void SeedPolicyDatabase(string dbPath, AnonymousCommentPolicy policy)
    {
        using SqlSugarClient db = CreatePolicyDb(dbPath);
        db.CodeFirst.InitTables<AnonymousCommentPolicy>();
        db.Insertable(policy).ExecuteCommand();
    }

    private static SqlSugarClient CreatePolicyDb(string dbPath)
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={dbPath}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });
}
