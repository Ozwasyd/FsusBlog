using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using Npgsql;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleVaultRecoveryServiceRegistrationTests
{
    [Fact]
    public void ExplicitAgentOperationComposition_SharesCanonicalAdapterWithoutCreatingAnotherDispatcherOrStore()
    {
        var services = new ServiceCollection();
        var executions = Substitute.For<IArticleVaultExecutionStore>();
        var checkpoints = Substitute.For<IArticleVaultOperationCheckpointStore>();
        var executor = Substitute.For<IArticleVaultSyncPlanExecutor>();
        services.AddSingleton(executions);
        services.AddSingleton(checkpoints);
        services.AddSingleton(executor);
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        var binding = new ArticleVaultAgentBinding("site-primary", "vault-primary", "device-primary",
            "agent-primary", "session-primary", ArticleVaultOperationFixture.DigestA,
            ArticleVaultOperationFixture.DigestB, "1.0.0", ArticleVaultAgentProtocol.Version);
        services.AddFsusArticleVaultAgentCanonicalOperations(binding, ArticleVaultOperationFixture.DigestC, 1001);
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultAgentCanonicalOperations(
            binding, ArticleVaultOperationFixture.DigestC, 1001));
        using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateScopes = true,
            ValidateOnBuild = true
        });
        using IServiceScope scope = provider.CreateScope();
        Assert.Same(scope.ServiceProvider.GetRequiredService<ArticleVaultAgentCanonicalOperationAdapter>(),
            scope.ServiceProvider.GetRequiredService<IArticleVaultAgentCanonicalOperations>());
        Assert.Single(services, static descriptor => descriptor.ServiceType == typeof(IArticleVaultExecutionStore));
        Assert.Single(services, static descriptor => descriptor.ServiceType == typeof(IArticleVaultOperationCheckpointStore));
        Assert.DoesNotContain(services, static descriptor => descriptor.ServiceType == typeof(ArticleVaultAgentDispatchScope));
        Assert.Empty(executions.ReceivedCalls());
        Assert.Empty(checkpoints.ReceivedCalls());
        Assert.Empty(executor.ReceivedCalls());
    }

    [Fact]
    public void InvalidAgentContextAndMissingCanonicalOwners_CannotInstallFallbackExecutionAuthority()
    {
        var services = new ServiceCollection();
        var binding = new ArticleVaultAgentBinding("site-primary", "vault-primary", "device-primary",
            "agent-primary", "session-primary", ArticleVaultOperationFixture.DigestA,
            ArticleVaultOperationFixture.DigestB, "1.0.0", ArticleVaultAgentProtocol.Version);
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultAgentCanonicalOperations(
            binding with
            {
                ProtocolVersion = 0
            }, ArticleVaultOperationFixture.DigestC, 1001));
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultAgentCanonicalOperations(
            binding, "invalid-root", 1001));
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultAgentCanonicalOperations(
            binding, ArticleVaultOperationFixture.DigestC, 0));
        Assert.Empty(services);
        services.AddFsusArticleVaultAgentCanonicalOperations(binding, ArticleVaultOperationFixture.DigestC, 1001);
        using ServiceProvider provider = services.BuildServiceProvider();
        Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<IArticleVaultAgentCanonicalOperations>());
        Assert.DoesNotContain(services, static descriptor => descriptor.ServiceType == typeof(IArticleVaultExecutionStore)
            || descriptor.ServiceType == typeof(IArticleVaultOperationCheckpointStore)
            || descriptor.ServiceType == typeof(IArticleVaultSyncPlanExecutor));
    }

    [Fact]
    public void ExplicitServerComposition_ResolvesCanonicalReadersInOneScopedBinding()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.example/" }).Build());
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddSingleton(Substitute.For<IArticleVaultOperationCheckpointStore>());
        services.AddSingleton(Substitute.For<IArticleVaultResolutionProposalStore>());
        services.AddSingleton(Substitute.For<IArticleVaultCurrentObservationAuthority>());
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        services.AddSingleton(Substitute.For<IAuthoringRevisionCompareAuthority>());
        services.AddSingleton(Substitute.For<IAuthoringDraftLifecycle>());
        services.AddSingleton(Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>());
        services.AddFsusArticleVaultRecoveryReaders("site-primary");
        using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
        using IServiceScope scope = provider.CreateScope();
        Assert.IsType<AuthoringRevisionComparePackageReader>(scope.ServiceProvider.GetRequiredService<IRevisionComparePackageReader>());
        Assert.IsType<ArticleVaultAcceptedSourceAdapter>(scope.ServiceProvider.GetRequiredService<ArticleVaultAcceptedSourceAdapter>());
        Assert.IsType<ArticleVaultCurrentSourceReader>(scope.ServiceProvider.GetRequiredService<ArticleVaultCurrentSourceReader>());
        Assert.Same(scope.ServiceProvider.GetRequiredService<ArticleVaultCurrentSourceReader>(),
            scope.ServiceProvider.GetRequiredService<ArticleVaultCurrentSourceReader>());
        Assert.IsType<ArticleVaultRecoveryCheckpointReader>(scope.ServiceProvider.GetRequiredService<ArticleVaultRecoveryCheckpointReader>());
        Assert.IsType<ArticleVaultConflictReviewReader>(scope.ServiceProvider.GetRequiredService<ArticleVaultConflictReviewReader>());
        Assert.IsType<ArticleVaultRecoveryStoredProposalReader>(scope.ServiceProvider.GetRequiredService<ArticleVaultRecoveryStoredProposalReader>());
        Assert.IsType<ArticleVaultRecoveryHistoryReader>(scope.ServiceProvider.GetRequiredService<ArticleVaultRecoveryHistoryReader>());
        Assert.Equal(ServiceLifetime.Scoped, Assert.Single(services,
            static descriptor => descriptor.ServiceType == typeof(ArticleVaultAcceptedSourceAdapter)).Lifetime);
        Assert.Equal("article_vault_recovery_site_binding_already_registered", Assert.Throws<InvalidOperationException>(
            () => services.AddFsusArticleVaultRecoveryReaders("foreign-site")).Message);
    }

    [Fact]
    public void ProductionComposition_ResolvesTheExistingPostgresCheckpointStoreWithinEachScope()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        services.AddFsusArticleVaultPostgresRecoveryStores();
        using NpgsqlDataSource dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Database=vault-di-only;Username=vault-di-only");
        services.AddSingleton(dataSource);
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
        using IServiceScope first = provider.CreateScope();
        using IServiceScope second = provider.CreateScope();
        var store = first.ServiceProvider.GetRequiredService<IArticleVaultOperationCheckpointStore>();
        Assert.IsType<PostgresArticleVaultOperationCheckpointStore>(store);
        Assert.Same(store, first.ServiceProvider.GetRequiredService<PostgresArticleVaultOperationCheckpointStore>());
        Assert.Same(store, first.ServiceProvider.GetRequiredService<IArticleVaultRecoveryOperationCheckpointWriter>());
        var proposals = first.ServiceProvider.GetRequiredService<IArticleVaultResolutionProposalStore>();
        Assert.IsType<PostgresArticleVaultResolutionProposalStore>(proposals);
        Assert.Same(proposals, first.ServiceProvider.GetRequiredService<PostgresArticleVaultResolutionProposalStore>());
        Assert.NotSame(proposals, second.ServiceProvider.GetRequiredService<IArticleVaultResolutionProposalStore>());
        Assert.NotSame(store, second.ServiceProvider.GetRequiredService<IArticleVaultOperationCheckpointStore>());
        Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<IArticleVaultOperationCheckpointStore>());
    }

    [Fact]
    public void OrdinaryDomain_DoesNotEnableRecoveryStoresWithoutExplicitHostBinding()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        Assert.DoesNotContain(services, static descriptor => descriptor.ServiceType == typeof(IArticleVaultResolutionProposalStore));
        Assert.DoesNotContain(services, static descriptor => descriptor.ServiceType == typeof(IArticleVaultOperationCheckpointStore));
        Assert.DoesNotContain(services, static descriptor => descriptor.ServiceType == typeof(ArticleVaultRecoveryHistoryReader));
    }

    [Fact]
    public void ExplicitPostgresComposition_RequiresActualHostDataSourceAndRefusesSecondStore()
    {
        var services = new ServiceCollection();
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        services.AddFsusArticleVaultPostgresRecoveryStores();
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultPostgresRecoveryStores());
        Assert.Throws<AggregateException>(() => services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateScopes = true,
            ValidateOnBuild = true
        }));
    }

    [Fact]
    public void EncryptedRecoveryComposition_RequiresProtectionAndUsesTheSoleStorageInstance()
    {
        var services = new ServiceCollection();
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultEncryptedRecoveryStorage());
        Assert.Empty(services);
        services.AddSingleton(Substitute.For<IArticleVaultRecoveryBackupProtectionAuthority>());
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddSingleton(Substitute.For<IArticleVaultResolutionProposalStore>());
        services.AddSingleton(Substitute.For<IArticleVaultOperationCheckpointStore>());
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        using NpgsqlDataSource dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Database=vault-di-only;Username=vault-di-only");
        services.AddSingleton(dataSource);
        services.AddFsusArticleVaultEncryptedRecoveryStorage();
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultEncryptedRecoveryStorage());
        using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateScopes = true,
            ValidateOnBuild = true
        });
        using IServiceScope scope = provider.CreateScope();
        Assert.Same(scope.ServiceProvider.GetRequiredService<PostgresArticleVaultRecoveryStorage>(),
            scope.ServiceProvider.GetRequiredService<IArticleVaultTransactionalRecoveryJournalStore>());
        Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<IArticleVaultTransactionalRecoveryJournalStore>());
    }

    [Fact]
    public void BackupProtectionComposition_RequiresExistingKeyOwnerAndSharesTheActualProvider()
    {
        var services = new ServiceCollection();
        Assert.Equal("article_vault_recovery_key_owner_unavailable", Assert.Throws<InvalidOperationException>(
            () => services.AddFsusArticleVaultRecoveryBackupProtection()).Message);
        Assert.Empty(services);
        var keys = Substitute.For<IAuditRetentionEpochKeyStore>();
        services.AddSingleton(keys);
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        services.AddFsusArticleVaultRecoveryBackupProtection();
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultRecoveryBackupProtection());
        using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateScopes = true,
            ValidateOnBuild = true
        });
        Assert.Same(provider.GetRequiredService<ArticleVaultRecoveryBackupProtectionAuthority>(),
            provider.GetRequiredService<IArticleVaultRecoveryBackupProtectionAuthority>());
        Assert.Same(keys, provider.GetRequiredService<IAuditRetentionEpochKeyStore>());
        Assert.Single(services, static descriptor => descriptor.ServiceType == typeof(IAuditRetentionEpochKeyStore));
        Assert.Empty(keys.ReceivedCalls());
    }

    [Fact]
    public void EncryptedRecoveryComposition_BindsExistingKeysToActualProtectionWithoutCreatingOrReadingKeys()
    {
        var services = new ServiceCollection();
        var keys = Substitute.For<IAuditRetentionEpochKeyStore>();
        services.AddSingleton(keys);
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddSingleton(Substitute.For<IArticleVaultResolutionProposalStore>());
        services.AddSingleton(Substitute.For<IArticleVaultOperationCheckpointStore>());
        services.AddSingleton<TimeProvider>(TimeProvider.System);
        using NpgsqlDataSource dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Database=vault-di-only;Username=vault-di-only");
        services.AddSingleton(dataSource);
        services.AddFsusArticleVaultEncryptedRecoveryStorage();
        using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateScopes = true,
            ValidateOnBuild = true
        });
        using IServiceScope scope = provider.CreateScope();
        Assert.IsType<ArticleVaultRecoveryBackupProtectionAuthority>(
            scope.ServiceProvider.GetRequiredService<IArticleVaultRecoveryBackupProtectionAuthority>());
        Assert.Same(scope.ServiceProvider.GetRequiredService<PostgresArticleVaultRecoveryStorage>(),
            scope.ServiceProvider.GetRequiredService<IArticleVaultTransactionalRecoveryJournalStore>());
        Assert.Empty(keys.ReceivedCalls());
    }

    [Fact]
    public void MissingProposalOwner_DoesNotInstallAnAlternativeStoreOrGrantAReview()
    {
        var services = new ServiceCollection();
        services.AddFsusArticleVaultRecoveryReaders("site-primary");
        using ServiceProvider provider = services.BuildServiceProvider();
        Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<ArticleVaultConflictReviewReader>());
        Assert.DoesNotContain(services, static descriptor => descriptor.ServiceType == typeof(IArticleVaultResolutionProposalStore));
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    public void MissingExplicitSite_DoesNotInstallAReaderOrGuessFromConfiguration(string site)
    {
        var services = new ServiceCollection();
        Assert.Throws<ArgumentException>(() => services.AddFsusArticleVaultRecoveryReaders(site));
        Assert.Empty(services);
    }

    [Fact]
    public void MissingCanonicalCheckpointStore_IsARealCompositionFailure()
    {
        var services = new ServiceCollection();
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddFsusArticleVaultRecoveryReaders("site-primary");
        using ServiceProvider provider = services.BuildServiceProvider();
        Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<ArticleVaultRecoveryCheckpointReader>());
        Assert.DoesNotContain(services, static descriptor => descriptor.ServiceType == typeof(IArticleVaultOperationCheckpointStore));
    }
}
