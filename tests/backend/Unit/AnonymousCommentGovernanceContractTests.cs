using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class AnonymousCommentGovernanceContractTests(PostgresSchemaMigrationFixture fixture)
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
            "account_id",
            "account_binding_hash",
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
    public void AnonymousCredentialAccountBoundContract_DoesNotMixUserAndZkCommitmentSemantics()
    {
        string entity = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AnonymousCredential.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AnonymousCredentialService.cs");
        string actorResolver = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentActorResolver.cs");

        Assert.Contains("AccountId", entity, StringComparison.Ordinal);
        Assert.Contains("account_id", entity, StringComparison.Ordinal);
        Assert.Contains("AccountBindingHash", entity, StringComparison.Ordinal);
        Assert.Contains("account_binding_hash", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("user_id", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("CommitmentHash", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("commitment_hash", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("ZkCommitment", entity, StringComparison.Ordinal);
        Assert.DoesNotContain("zk_commitment", entity, StringComparison.Ordinal);

        Assert.Contains("IssueAccountBoundAsync", service, StringComparison.Ordinal);
        Assert.Contains("GetActiveAccountCredentialAsync", service, StringComparison.Ordinal);
        Assert.Contains("GetAccountCredentialLevelAsync", service, StringComparison.Ordinal);
        Assert.DoesNotContain("IssueAsync(\n        int? userId,\n        string commitmentHash", service, StringComparison.Ordinal);
        Assert.DoesNotContain("GetCredentialLevelAsync(\n        int? userId,\n        string? commitmentHash", service, StringComparison.Ordinal);

        Assert.Contains("accountReader.GetAccountByIdAsync(userId.Value", actorResolver, StringComparison.Ordinal);
        Assert.Contains("account?.AnonymousCredentialLevel", actorResolver, StringComparison.Ordinal);
        string zkBlock = actorResolver[
            actorResolver.IndexOf("if (string.Equals(decision.EffectiveAuthorMode, CommentAuthorModes.ZkAnonymous", StringComparison.Ordinal)..
            actorResolver.IndexOf("string nullifierHash = DeriveEngineeringNullifierHash", StringComparison.Ordinal)];
        Assert.DoesNotContain("credentialService", zkBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", zkBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("AccountId", zkBlock, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCredentialAccountBoundMigration_RenamesLegacyBindingColumns()
    {
        var registry = new SchemaMigrationRegistry();
        string fingerprint = string.Join('\n', registry.GetDescriptors()
            .Where(static descriptor => descriptor.MigrationId.Contains("anonymous-credential-account-binding", StringComparison.Ordinal))
            .SelectMany(static descriptor => descriptor.Steps)
            .Select(static step => step.Fingerprint));

        Assert.Contains("anonymous_credential.user_id->account_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("anonymous_credential.commitment_hash->account_binding_hash", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_anonymous_credential_account", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_anonymous_credential_account_binding", fingerprint, StringComparison.Ordinal);
        Assert.Contains("anonymous_credential.user_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("anonymous_credential.commitment_hash", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("zk_commitment", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void EngineeringAnonymousNullifier_UsesPepperedDomainSeparatedHmacWithoutAccountOrProof()
    {
        string actorResolver = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentActorResolver.cs");

        Assert.Contains("HMACSHA256.HashData", actorResolver, StringComparison.Ordinal);
        Assert.Contains("fsus.anonymous.nullifier.v2", actorResolver, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentity:NullifierPepper", actorResolver, StringComparison.Ordinal);
        Assert.DoesNotContain("account:{account}", actorResolver, StringComparison.Ordinal);
        Assert.DoesNotContain("proof:{proof}", actorResolver, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCommentGovernance_RegistersPolicyCredentialAndNullifierServices()
    {
        string services = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs");

        Assert.Contains("IAnonymousCommentPolicyService", services, StringComparison.Ordinal);
        Assert.Contains("AnonymousCommentPolicyService", services, StringComparison.Ordinal);
        Assert.Contains("IAnonymousCommentPolicyInvalidationSink", services, StringComparison.Ordinal);
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
        Assert.Contains("LoadPersistedPolicyAsync", service, StringComparison.Ordinal);
        Assert.Contains("PersistPolicyAsync", service, StringComparison.Ordinal);
        Assert.Contains("Queryable<AnonymousCommentPolicy>()", service, StringComparison.Ordinal);
        Assert.Contains("Updateable(entity)", service, StringComparison.Ordinal);
        Assert.Contains("SnapshotHash", service, StringComparison.Ordinal);
        Assert.Contains("ChangedBy", service, StringComparison.Ordinal);
        Assert.Contains("Reason", service, StringComparison.Ordinal);
        Assert.Contains("InvalidateCommentPolicyAsync", service, StringComparison.Ordinal);
        Assert.Contains("IAnonymousCommentPolicyInvalidationSink", service, StringComparison.Ordinal);
        Assert.Contains("InvalidateLocalSnapshot", service, StringComparison.Ordinal);
        Assert.Contains("scopeFactory is not null", service, StringComparison.Ordinal);
        Assert.Contains("GetCurrentAsync", service, StringComparison.Ordinal);
        Assert.Contains("InvalidateCommentPolicyAsync", cache, StringComparison.Ordinal);
        Assert.Contains("AnonymousCommentPolicyVersion", cache, StringComparison.Ordinal);
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
    public async Task AnonymousCommentPolicyService_LoadsPersistsInvalidatesAndReloadsRuntimeSnapshot()
    {
        string connectionString = await CreateConnectionStringAsync();
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
            AnonymousCommentPolicySnapshot initial = await service.GetCurrentAsync();
            var secondInstance = new AnonymousCommentPolicyService(configuration, scopeFactory);
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
                DefaultAuthorMode: CommentAuthorModes.Anonymous,
                SupportedDisplayLanguages: ["fr", "zh-CN"],
                CommentMaxChars: 2400,
                CommentMaxUtf8Bytes: 9600,
                Reason: "policy rollout"),
                adminPrincipalId: 42);

            Assert.True(updated.AnonymousCommentsEnabled);
            Assert.True(updated.PublicCommentsEnabled);
            Assert.True(updated.ZkAnonymousEnabled);
            Assert.Equal(CommentAuthorModes.Anonymous, updated.DefaultAuthorMode);
            Assert.Equal(["zh-CN"], updated.SupportedDisplayLanguages);
            Assert.Equal(2400, updated.CommentMaxChars);
            Assert.Equal(9600, updated.CommentMaxUtf8Bytes);
            Assert.Equal("admin:42", updated.ChangedBy);
            Assert.Equal("policy rollout", updated.Reason);
            Assert.NotEmpty(updated.SnapshotHash);

            await dispatcher.Received(1).InvalidateCommentPolicyAsync(Arg.Any<CancellationToken>());

            AnonymousCommentPolicySnapshot secondReloaded = await secondInstance.GetCurrentAsync();
            Assert.True(secondReloaded.AnonymousCommentsEnabled);
            Assert.True(secondReloaded.PublicCommentsEnabled);
            Assert.True(secondReloaded.ZkAnonymousEnabled);
            Assert.Equal(updated.SnapshotHash, secondReloaded.SnapshotHash);
            Assert.Equal("policy rollout", secondReloaded.Reason);

            using SqlSugarClient verifyDb = CreatePolicyDb(connectionString);
            AnonymousCommentPolicy stored = verifyDb.Queryable<AnonymousCommentPolicy>()
                .First(static item => item.Id == 1);
            Assert.True(stored.AnonymousCommentsEnabled);
            Assert.True(stored.PublicCommentsEnabled);
            Assert.Equal(2400, stored.CommentMaxChars);
            Assert.Equal(9600, stored.CommentMaxUtf8Bytes);
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

            AnonymousCommentPolicySnapshot reloaded = await restarted.GetCurrentAsync();
            Assert.True(reloaded.AnonymousCommentsEnabled);
            Assert.True(reloaded.PublicCommentsEnabled);
            Assert.True(reloaded.ZkAnonymousEnabled);
            Assert.Equal(CommentAuthorModes.Anonymous, reloaded.DefaultAuthorMode);
            Assert.Equal(["zh-CN"], reloaded.SupportedDisplayLanguages);
            Assert.Equal(updated.SnapshotHash, reloaded.SnapshotHash);
            Assert.Equal("admin:42", reloaded.ChangedBy);
            Assert.Equal("policy rollout", reloaded.Reason);
    }

    [Fact]
    public void CredentialAndNullifierServices_DoNotExposeReverseLookupFromNullifierToAccount()
    {
        string credentialService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AnonymousCredentialService.cs");
        string nullifierService = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/CommentAnonymousNullifierService.cs");

        Assert.Contains("IssueAccountBoundAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("GetActiveAccountCredentialAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("RevokeAsync", credentialService, StringComparison.Ordinal);
        Assert.Contains("GetAccountCredentialLevelAsync", credentialService, StringComparison.Ordinal);
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

    private Task<string> CreateConnectionStringAsync()
        => PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);

    private static SqlSugarClient CreatePolicyDb(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);
}
