using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>Actual current reads only; neither finite component nor provenance grants execution.</summary>
public sealed class ArticleVaultCurrentPropertyInput
{
    internal ArticleVaultCurrentPropertyInput(
        ArticleVaultCurrentSourceSnapshot server,
        ArticlePackageCurrentPropertyProjection properties)
    {
        Server = server;
        Properties = properties;
    }

    public ArticleVaultCurrentSourceSnapshot Server
    {
        get;
    }
    public ArticlePackageCurrentPropertyProjection Properties
    {
        get;
    }
    public bool CanExecute => false;
    public bool CanCommitBase => false;
}

/// <summary>
/// Composes the sole authorized revision and persisted-property readers. The host explicitly binds
/// the canonical property site independently of the Vault identity. Repeat reads detect observed
/// movement; they are not an atomic fence, full V1 metadata, historical/base/local acquisition or rights.
/// </summary>
public sealed class ArticleVaultCurrentPropertyInputReader(
    ArticleVaultCurrentSourceReader sources,
    ArticlePackageCurrentPropertyReader properties,
    string trustedPropertySiteScope)
{
    public async Task<ArticleVaultCurrentPropertyInput> ReadAsync(
        ArticleVaultCurrentSourceReference reference,
        ArticleVaultConflictReviewContext context,
        ArticlePackagePropertyMappingBindings bindings,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(bindings);
        cancellationToken.ThrowIfCancellationRequested();
        var coordinates = bindings.SourceCoordinates;
        if (string.IsNullOrWhiteSpace(trustedPropertySiteScope)
            || coordinates.SiteScope != trustedPropertySiteScope || coordinates.ArticleId != context.ArticleId
            || coordinates.DraftId.HasValue || coordinates.DraftServerRevision.HasValue)
        {
            throw Rejected("context_mismatch");
        }

        ArticleVaultCurrentSourceSnapshot before = await sources.ReadAsync(reference, context,
            cancellationToken).ConfigureAwait(false);
        if (coordinates.ArticleRevisionId != before.Package.RevisionId)
        {
            throw Rejected("revision_mismatch");
        }
        ArticlePackageCurrentPropertyReadResult read = await properties.ReadAndMapAsync(
            context.AdminPrincipalId, bindings, cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!read.IsValid || read.Projection is not { } projection)
        {
            throw Rejected(read.ReasonCode ?? "projection_missing");
        }
        ArticleVaultCurrentSourceSnapshot after = await sources.ReadAsync(reference, context,
            cancellationToken).ConfigureAwait(false);
        if (before.Package.PackageDigest != after.Package.PackageDigest || before.Source != after.Source
            || before.PermissionSnapshotSha256 != after.PermissionSnapshotSha256
            || !before.Observations.SequenceEqual(after.Observations))
        {
            throw Rejected("source_or_permission_changed");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return new(after, projection);
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new("article_vault_current_property_input_" + reason);
}
