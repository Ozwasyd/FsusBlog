using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.ArticleVault.Assets;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

/// <summary>Composes the existing read authorities with an explicit server-owned Vault site binding.</summary>
public static class ArticleVaultRecoveryServiceCollectionExtensions
{
    /// <summary>Requires the original property authority; installs no fallback provider or persistence.</summary>
    public static IServiceCollection AddFsusArticleVaultCurrentPropertyInputs(
        this IServiceCollection services, string trustedPropertySiteScope)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(trustedPropertySiteScope);
        if (services.Any(static descriptor => descriptor.ServiceType == typeof(ArticlePackageCurrentPropertyReader)
            || descriptor.ServiceType == typeof(ArticleVaultCurrentPropertyInputReader)))
        {
            throw new InvalidOperationException("article_vault_current_property_input_already_registered");
        }
        Type[] owners = [typeof(IArticlePropertyValueAuthority), typeof(ArticleVaultCurrentSourceReader)];
        if (owners.Any(owner => !services.Any(descriptor => descriptor.ServiceType == owner)))
        {
            throw new InvalidOperationException("article_vault_current_property_input_owner_missing");
        }
        services.AddScoped<ArticlePackageCurrentPropertyReader>();
        services.AddScoped(provider => new ArticleVaultCurrentPropertyInputReader(
            provider.GetRequiredService<ArticleVaultCurrentSourceReader>(),
            provider.GetRequiredService<ArticlePackageCurrentPropertyReader>(), trustedPropertySiteScope));
        return services;
    }

    /// <summary>
    /// Uses existing authenticated source/upload owners and one explicit host site binding.
    /// Missing owners fail before registration; no fallback source, store or grant is installed.
    /// </summary>
    public static IServiceCollection AddFsusArticleVaultCurrentUploadAssetInputs(
        this IServiceCollection services, string trustedVaultSiteIdentity)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(trustedVaultSiteIdentity);
        if (services.Any(static descriptor => descriptor.ServiceType == typeof(ArticleVaultUploadAssetBindingReader)
            || descriptor.ServiceType == typeof(ArticleVaultCurrentUploadAssetInputReader)))
        {
            throw new InvalidOperationException("article_vault_current_upload_input_already_registered");
        }
        Type[] owners = [typeof(IArticleVaultExecutionStore), typeof(IArticleVaultCurrentObservationAuthority),
            typeof(IAuthoringArticleCurrentSourceReader), typeof(IFileService), typeof(TimeProvider)];
        if (owners.Any(owner => !services.Any(descriptor => descriptor.ServiceType == owner)))
        {
            throw new InvalidOperationException("article_vault_current_upload_input_owner_missing");
        }
        services.AddScoped(provider => new ArticleVaultUploadAssetBindingReader(
            provider.GetRequiredService<IArticleVaultExecutionStore>(),
            provider.GetRequiredService<IArticleVaultCurrentObservationAuthority>(),
            provider.GetRequiredService<IAuthoringArticleCurrentSourceReader>(),
            provider.GetRequiredService<IFileService>(), provider.GetRequiredService<TimeProvider>(), trustedVaultSiteIdentity));
        services.AddScoped(provider => new ArticleVaultCurrentUploadAssetInputReader(
            provider.GetRequiredService<IArticleVaultExecutionStore>(),
            provider.GetRequiredService<ArticleVaultUploadAssetBindingReader>(),
            provider.GetRequiredService<TimeProvider>(), trustedVaultSiteIdentity));
        return services;
    }

    /// <summary>
    /// Binds the canonical operation adapter to a host-owned agent session, root manifest and actor.
    /// The native session owns the only dispatcher. This installs no endpoint, lease, grant, watcher
    /// or first-execution admission; missing original stores/executor remain composition failures.
    /// </summary>
    public static IServiceCollection AddFsusArticleVaultAgentCanonicalOperations(
        this IServiceCollection services,
        ArticleVaultAgentBinding binding,
        string rootManifestSha256,
        long trustedAdminPrincipalId)
    {
        ArgumentNullException.ThrowIfNull(services);
        if (!ArticleVaultAgentProtocol.IsBinding(binding) || !ArticleVaultAgentProtocol.IsDigest(rootManifestSha256)
            || trustedAdminPrincipalId <= 0)
        {
            throw new InvalidOperationException("article_vault_agent_trusted_context_invalid");
        }
        if (services.Any(static descriptor => descriptor.ServiceType == typeof(ArticleVaultAgentCanonicalOperationAdapter)
            || descriptor.ServiceType == typeof(IArticleVaultAgentCanonicalOperations)))
        {
            throw new InvalidOperationException("article_vault_agent_operation_adapter_already_registered");
        }
        services.AddScoped(provider => new ArticleVaultAgentCanonicalOperationAdapter(
            provider.GetRequiredService<IArticleVaultExecutionStore>(),
            provider.GetRequiredService<IArticleVaultOperationCheckpointStore>(),
            provider.GetRequiredService<IArticleVaultSyncPlanExecutor>(), binding, rootManifestSha256,
            trustedAdminPrincipalId, provider.GetRequiredService<TimeProvider>()));
        services.AddScoped<IArticleVaultAgentCanonicalOperations>(
            provider => provider.GetRequiredService<ArticleVaultAgentCanonicalOperationAdapter>());
        return services;
    }

    /// <summary>Composes sole canonical stores with a host-supplied Npgsql data source; creates no pool or migration.</summary>
    public static IServiceCollection AddFsusArticleVaultPostgresRecoveryStores(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        if (services.Any(static descriptor => descriptor.ServiceType == typeof(IArticleVaultResolutionProposalStore)
            || descriptor.ServiceType == typeof(IArticleVaultOperationCheckpointStore)
            || descriptor.ServiceType == typeof(IArticleVaultRecoveryOperationCheckpointWriter)))
        {
            throw new InvalidOperationException("article_vault_recovery_store_already_registered");
        }
        services.AddScoped<PostgresArticleVaultResolutionProposalStore>();
        services.AddScoped<IArticleVaultResolutionProposalStore>(
            provider => provider.GetRequiredService<PostgresArticleVaultResolutionProposalStore>());
        services.AddScoped<PostgresArticleVaultOperationCheckpointStore>();
        services.AddScoped<IArticleVaultOperationCheckpointStore>(
            provider => provider.GetRequiredService<PostgresArticleVaultOperationCheckpointStore>());
        services.AddScoped<IArticleVaultRecoveryOperationCheckpointWriter>(
            provider => provider.GetRequiredService<PostgresArticleVaultOperationCheckpointStore>());
        return services;
    }

    /// <summary>Uses the existing application key facility without creating a key store or recovery key.</summary>
    public static IServiceCollection AddFsusArticleVaultRecoveryBackupProtection(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        if (!services.Any(static descriptor => descriptor.ServiceType == typeof(IAuditRetentionEpochKeyStore)))
        {
            throw new InvalidOperationException("article_vault_recovery_key_owner_unavailable");
        }
        if (services.Any(static descriptor => descriptor.ServiceType == typeof(ArticleVaultRecoveryBackupProtectionAuthority)
            || descriptor.ServiceType == typeof(IArticleVaultRecoveryBackupProtectionAuthority)))
        {
            throw new InvalidOperationException("article_vault_recovery_protection_already_registered");
        }
        services.AddSingleton<ArticleVaultRecoveryBackupProtectionAuthority>();
        services.AddSingleton<IArticleVaultRecoveryBackupProtectionAuthority>(
            provider => provider.GetRequiredService<ArticleVaultRecoveryBackupProtectionAuthority>());
        return services;
    }

    /// <summary>Requires the existing key facility or an explicit trusted protection authority; never derives keys.</summary>
    public static IServiceCollection AddFsusArticleVaultEncryptedRecoveryStorage(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        if (services.Any(static descriptor => descriptor.ServiceType == typeof(PostgresArticleVaultRecoveryStorage)
            || descriptor.ServiceType == typeof(IArticleVaultTransactionalRecoveryJournalStore)))
        {
            throw new InvalidOperationException("article_vault_recovery_journal_store_already_registered");
        }
        if (!services.Any(static descriptor => descriptor.ServiceType == typeof(IArticleVaultRecoveryBackupProtectionAuthority)))
        {
            services.AddFsusArticleVaultRecoveryBackupProtection();
        }
        services.AddScoped<PostgresArticleVaultRecoveryStorage>();
        services.AddScoped<IArticleVaultTransactionalRecoveryJournalStore>(
            provider => provider.GetRequiredService<PostgresArticleVaultRecoveryStorage>());
        return services;
    }

    /// <summary>
    /// The host supplies the trusted Vault identity independently of request/manifest inputs. The
    /// existing domain registration owns the canonical execution/checkpoint stores, revision reader and SQL
    /// permission provider. The host must supply the real recovery protection authority before enabling encrypted backup storage.
    /// No fallback identity, endpoint, database migration, journal writer or native grant is installed.
    /// </summary>
    public static IServiceCollection AddFsusArticleVaultRecoveryReaders(
        this IServiceCollection services, string trustedVaultSiteIdentity)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentException.ThrowIfNullOrWhiteSpace(trustedVaultSiteIdentity);
        if (services.Any(static descriptor => descriptor.ServiceType == typeof(ArticleVaultAcceptedSourceAdapter)
            || descriptor.ServiceType == typeof(ArticleVaultCurrentSourceReader)
            || descriptor.ServiceType == typeof(ArticleVaultRecoveryCheckpointReader)
            || descriptor.ServiceType == typeof(ArticleVaultConflictReviewReader)))
        {
            throw new InvalidOperationException("article_vault_recovery_site_binding_already_registered");
        }

        services.AddScoped(provider => new ArticleVaultAcceptedSourceAdapter(
            provider.GetRequiredService<IArticleVaultExecutionStore>(),
            provider.GetRequiredService<IRevisionComparePackageReader>(),
            provider.GetRequiredService<IAuthorRecentArticleHistoryPermissionProjectionProvider>(),
            provider.GetRequiredService<IConfiguration>(), trustedVaultSiteIdentity));
        services.AddScoped(provider => new ArticleVaultCurrentSourceReader(
            provider.GetRequiredService<IArticleVaultExecutionStore>(),
            provider.GetRequiredService<IArticleVaultCurrentObservationAuthority>(),
            provider.GetRequiredService<IRevisionComparePackageReader>(),
            provider.GetRequiredService<IAuthorRecentArticleHistoryPermissionProjectionProvider>(),
            provider.GetRequiredService<IConfiguration>(), provider.GetRequiredService<TimeProvider>(), trustedVaultSiteIdentity));
        services.AddScoped<ArticleVaultRecoveryCheckpointReader>();
        services.AddScoped<ArticleVaultRecoveryStoredProposalReader>();
        services.AddScoped(provider => new ArticleVaultRecoveryHistoryReader(
            provider.GetRequiredService<IArticleVaultResolutionProposalStore>(),
            provider.GetRequiredService<IArticleVaultExecutionStore>(),
            provider.GetRequiredService<ArticleVaultRecoveryStoredProposalReader>(),
            provider.GetRequiredService<IAuthorRecentArticleHistoryPermissionProjectionProvider>(),
            provider.GetRequiredService<IConfiguration>(), trustedVaultSiteIdentity));
        services.AddScoped(provider => new ArticleVaultConflictReviewReader(
            provider.GetRequiredService<IArticleVaultResolutionProposalStore>(),
            provider.GetRequiredService<IArticleVaultExecutionStore>(),
            provider.GetRequiredService<ArticleVaultRecoveryCheckpointReader>(),
            provider.GetRequiredService<IAuthorRecentArticleHistoryPermissionProjectionProvider>(),
            provider.GetRequiredService<IConfiguration>(), trustedVaultSiteIdentity));
        return services;
    }
}
