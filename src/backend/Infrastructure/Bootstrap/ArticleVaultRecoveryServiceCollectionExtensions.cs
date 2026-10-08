using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

/// <summary>Composes the existing read authorities with an explicit server-owned Vault site binding.</summary>
public static class ArticleVaultRecoveryServiceCollectionExtensions
{
    /// <summary>
    /// The host supplies the trusted Vault identity independently of request/manifest inputs. The
    /// existing domain registration owns the canonical execution/checkpoint stores, revision reader and SQL
    /// permission provider. The proposal owner must separately supply its admitted store/schema.
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
        services.AddScoped(provider => new ArticleVaultConflictReviewReader(
            provider.GetRequiredService<IArticleVaultResolutionProposalStore>(),
            provider.GetRequiredService<IArticleVaultExecutionStore>(),
            provider.GetRequiredService<ArticleVaultRecoveryCheckpointReader>(),
            provider.GetRequiredService<IAuthorRecentArticleHistoryPermissionProjectionProvider>(),
            provider.GetRequiredService<IConfiguration>(), trustedVaultSiteIdentity));
        return services;
    }
}
