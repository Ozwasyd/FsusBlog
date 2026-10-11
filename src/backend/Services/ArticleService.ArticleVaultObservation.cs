using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services;

public partial class ArticleService : IArticleVaultCurrentObservationAuthority
{
    async Task<IReadOnlyList<ArticleVaultCurrentArticleObservation>>
        IArticleVaultCurrentObservationAuthority.ObserveGroupAsync(
            ArticleVaultSealedExecutionBundle bundle,
            VaultSyncPlanGroup group,
            CancellationToken cancellationToken)
    {
        CancellationToken ct = ResolveCancellationToken(cancellationToken);
        AdminPrincipal? principal = await _db.Queryable<AdminPrincipal>()
            .Where(item => item.Id == bundle.AdminPrincipalId)
            .FirstAsync(ct).ConfigureAwait(false);
        if (principal is null)
        {
            throw new ArticleVaultExecutionRejectedException("article_vault_admin_principal_missing");
        }

        var observations = new List<ArticleVaultCurrentArticleObservation>(group.Items.Count);
        var byOperation = new Dictionary<string, ArticleVaultCurrentArticleObservation>(StringComparer.Ordinal);
        foreach (VaultSyncPlanItem item in group.Items)
        {
            ct.ThrowIfCancellationRequested();
            ArticleUpdateState? state = ParseArticleId(item.ServerArticleIdentity, out int articleId)
                ? await LoadArticleUpdateStateAsync(articleId).ConfigureAwait(false)
                : null;
            string rightsBoundary = await ComputeRightsBoundaryAsync(articleId, state is not null, ct)
                .ConfigureAwait(false);
            string publicationBoundary = ComputePublicationBoundary(state);
            string authorityPermission = ComputeVaultPermissionBoundary(
                bundle.Plan.SiteIdentity,
                principal,
                rightsBoundary,
                publicationBoundary);
            bool permitted = IsVaultMutationPermitted(principal);
            string dependency = ComputeDependencyBoundary(item, byOperation);
            VaultArticleCoordinate coordinate = BuildCurrentCoordinate(state, dependency, authorityPermission);
            var unsignedServer = new ArticleVaultServerObservation(
                ArticleVaultPlanSchemas.ServerObservation,
                ArticleVaultPlanSchemas.Version,
                bundle.Plan.SiteIdentity,
                bundle.Plan.VaultIdentity,
                bundle.Plan.DeviceIdentity,
                item.PortableArticleIdentity,
                state is null ? null : item.ServerArticleIdentity,
                coordinate,
                string.Empty);
            string observationDigest = ArticleVaultSyncPlanCodec.ComputeContentSha256(unsignedServer);
            ArticleVaultServerObservation server = unsignedServer with
            {
                ContentSha256 = observationDigest
            };
            var observation = new ArticleVaultCurrentArticleObservation(
                item.PortableArticleIdentity,
                server.ServerArticleIdentity,
                coordinate.ServerRevision,
                coordinate.Lifecycle,
                permitted,
                coordinate.PermissionSha256,
                coordinate.DependencySha256,
                publicationBoundary,
                rightsBoundary,
                coordinate.Source?.Sha256,
                server.ContentSha256);
            observations.Add(observation);
            byOperation.Add(item.OperationIdentity, observation);
        }
        return observations;
    }

    private static bool ParseArticleId(string? value, out int articleId)
        => int.TryParse(
            value,
            System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture,
            out articleId)
            && articleId > 0;

    private static string ComputeVaultPermissionBoundary(
        string siteIdentity,
        AdminPrincipal principal,
        string rightsBoundary,
        string publicationBoundary)
    {
        string[] permissions = principal.Permissions
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        bool permitted = IsVaultMutationPermitted(principal);
        return ArticleVaultExecutionIntegrity.Digest(new
        {
            siteIdentity,
            principal.Id,
            principal.Status,
            principal.IsRoot,
            Permissions = permissions,
            RequiredPermission = AdminPermissions.ArticleWrite,
            permitted,
            rightsBoundary,
            publicationBoundary
        });
    }

    private static bool IsVaultMutationPermitted(AdminPrincipal principal)
        => principal.Status == AdminPrincipalStatus.Active
            && (principal.IsRoot || principal.Permissions
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Contains(AdminPermissions.ArticleWrite, StringComparer.Ordinal));

    private static string ComputeDependencyBoundary(
        VaultSyncPlanItem item,
        IReadOnlyDictionary<string, ArticleVaultCurrentArticleObservation> observations)
        => ArticleVaultExecutionIntegrity.Digest(item.DependsOnOperationIdentities.Select(operationIdentity =>
        {
            if (!observations.TryGetValue(operationIdentity, out ArticleVaultCurrentArticleObservation? observation))
            {
                throw new ArticleVaultExecutionRejectedException("article_vault_dependency_observation_missing");
            }
            return new
            {
                operationIdentity,
                observation.ServerArticleIdentity,
                observation.ServerRevision,
                observation.Lifecycle,
                observation.ContentSha256
            };
        }).ToArray());

    private static VaultArticleCoordinate BuildCurrentCoordinate(
        ArticleUpdateState? state,
        string dependencySha256,
        string permissionSha256)
    {
        if (state is null)
        {
            var absent = new VaultArticleCoordinate(
                ArticleVaultSchemas.Coordinate,
                ArticleVaultSchemas.Version,
                Present: false,
                Deleted: false,
                ServerRevision: null,
                Source: null,
                MetadataManifestSha256: null,
                DependencySha256: null,
                Lifecycle: null,
                PermissionSha256: null,
                string.Empty);
            return absent with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.Digest(absent)
            };
        }

        VaultSourceByteIdentity source = ArticleVaultManifestCodec.CaptureSourceBytes(
            Encoding.UTF8.GetBytes(state.MarkdownContent));
        string metadata = ArticleVaultExecutionIntegrity.Digest(new
        {
            state.Title,
            state.Summary,
            state.CoverImageUrl,
            state.CategoryId,
            TagIds = state.TagIds.Order().ToArray()
        });
        var unsigned = new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate,
            ArticleVaultSchemas.Version,
            Present: true,
            Deleted: false,
            state.CurrentRevisionId,
            source,
            metadata,
            dependencySha256,
            Lifecycle(state.Status),
            permissionSha256,
            string.Empty);
        return unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.Digest(unsigned)
        };
    }

    private async Task<string> ComputeRightsBoundaryAsync(
        int articleId,
        bool articleExists,
        CancellationToken cancellationToken)
    {
        if (!articleExists)
        {
            return ArticleVaultExecutionIntegrity.Digest(new
            {
                Exists = false
            });
        }
        ArticleRightsPolicy? rights = await _db.Queryable<ArticleRightsPolicy>()
            .Where(item => item.ArticleId == articleId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        return ArticleVaultExecutionIntegrity.Digest(new
        {
            Exists = rights is not null,
            rights?.Enabled,
            rights?.LicenseType,
            rights?.CopyrightHolder,
            rights?.CopyrightYear,
            rights?.RightsStatement,
            rights?.AttributionTemplate,
            rights?.CopyPolicy,
            rights?.MaxExcerptChars,
            rights?.AllowCodeCopy,
            rights?.ShowPublicBadge,
            rights?.ProofBindingEnabled
        });
    }

    private static string ComputePublicationBoundary(ArticleUpdateState? state)
        => ArticleVaultExecutionIntegrity.Digest(new
        {
            Exists = state is not null,
            Revision = state is null ? null : (long?)state.CurrentRevisionId,
            Lifecycle = state is null ? null : Lifecycle(state.Status),
            ScheduledPublishAt = state?.ScheduledPublishAt,
            PublishedAt = state?.PublishedAt
        });

    private static string Lifecycle(ArticleStatus status)
        => FsusBlog.Contracts.Articles.ArticleStatusTransitionPolicy.IsDefined((int)status)
            ? FsusBlog.Contracts.Articles.ArticleStatusValues.Token((int)status)
            : throw new ArticleVaultExecutionRejectedException("article_vault_lifecycle_invalid");
}
