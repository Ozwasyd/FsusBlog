using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>Exact host-reviewed installation/mapping coordinates, never browser or editable-config authority.</summary>
public sealed record ArticleVaultInstallationSiteIdentityExpectation(
    int LifecycleVersion,
    int Generation,
    int MappingRevision,
    SystemSiteIdentityScope ApprovedScope);

/// <summary>
/// Prepares an uncached typed candidate read from the original SystemService interface. A returned
/// candidate is not qualified runtime authority and is not wired into execution or trusted-site DI.
/// SystemService lifecycle fixes and its canonical scoped alias remain the original owner's work.
/// </summary>
public sealed class ArticleVaultInstallationSiteIdentityCandidateReader(ISystemSiteIdentityReader original)
{
    public async Task<SystemSiteIdentityReadModel> ReadCandidateAsync(
        ArticleVaultInstallationSiteIdentityExpectation expected,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(expected);
        cancellationToken.ThrowIfCancellationRequested();
        if (expected.LifecycleVersion != 1 || expected.Generation <= 0 || expected.MappingRevision <= 0
            || expected.ApprovedScope is null || string.IsNullOrWhiteSpace(expected.ApprovedScope.Scope)
            || expected.ApprovedScope.Revision <= 0 || expected.ApprovedScope.Revision > expected.MappingRevision)
        {
            throw Rejected("article_vault_installation_site_expectation_invalid");
        }
        // No cache, catch/fallback, provisioning, URL-derived identity or configuration writes.
        SystemSiteIdentityReadModel candidate = await original.ReadCurrentSiteIdentityAsync(cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (candidate is null || candidate.State != SystemSiteIdentityState.Current)
        {
            throw Rejected(candidate?.State switch
            {
                SystemSiteIdentityState.Absent => "article_vault_installation_site_absent",
                SystemSiteIdentityState.MigrationRequired => "article_vault_installation_site_migration_required",
                SystemSiteIdentityState.Ambiguous => "article_vault_installation_site_ambiguous",
                SystemSiteIdentityState.Malformed => "article_vault_installation_site_malformed",
                SystemSiteIdentityState.UnsupportedVersion => "article_vault_installation_site_unsupported_version",
                _ => "article_vault_installation_site_state_unknown"
            });
        }
        const string IdentityPrefix = "fsus-site:";
        if (candidate.Identity is not { Length: 74 } identity || !identity.StartsWith(IdentityPrefix, StringComparison.Ordinal)
            || !identity.Skip(IdentityPrefix.Length).All(static character => "0123456789abcdef".Contains(character))
            || candidate.Scopes is null || candidate.Scopes.Any(static scope => scope is null))
        {
            throw Rejected("article_vault_installation_site_malformed");
        }
        if (candidate.LifecycleVersion != expected.LifecycleVersion || candidate.Generation != expected.Generation
            || candidate.MappingRevision != expected.MappingRevision)
        {
            throw Rejected("article_vault_installation_site_coordinates_stale");
        }
        SystemSiteIdentityScope[] matching = [.. candidate.Scopes.Where(scope => scope.Scope == expected.ApprovedScope.Scope)];
        if (matching.Length != 1 || matching[0].Revision != expected.ApprovedScope.Revision)
        {
            throw Rejected("article_vault_installation_site_scope_not_approved");
        }
        // Preserve the canonical typed model without making a new identity or normalized URL binding.
        return candidate;
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason) => new(reason);
}
