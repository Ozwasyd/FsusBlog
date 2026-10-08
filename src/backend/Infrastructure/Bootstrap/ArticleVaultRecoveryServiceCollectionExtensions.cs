using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

/// <summary>Composes the existing read authorities with an explicit server-owned Vault site binding.</summary>
public static class ArticleVaultRecoveryServiceCollectionExtensions
{
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

    /// <summary>Requires the host's real dedicated protection authority; never derives a substitute key.</summary>
    public static IServiceCollection AddFsusArticleVaultEncryptedRecoveryStorage(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        if (!services.Any(static descriptor => descriptor.ServiceType == typeof(IArticleVaultRecoveryBackupProtectionAuthority)))
        {
            throw new InvalidOperationException("article_vault_recovery_protection_authority_unavailable");
        }
        if (services.Any(static descriptor => descriptor.ServiceType == typeof(PostgresArticleVaultRecoveryStorage)
            || descriptor.ServiceType == typeof(IArticleVaultTransactionalRecoveryJournalStore)))
        {
            throw new InvalidOperationException("article_vault_recovery_journal_store_already_registered");
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
