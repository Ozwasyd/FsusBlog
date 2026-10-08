using System.Collections.Immutable;
using System.Globalization;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>Names one original sealed operation, without asserting current or candidate facts.</summary>
public sealed record ArticleVaultCurrentSourceReference(
    string PlanReference,
    string PlanSha256,
    string GroupIdentity,
    string OperationIdentity);

/// <summary>
/// Actual authorized current-revision bytes and finite revision metadata. The original operation,
/// complete group observations and live permission are bound before and after the read. Neither
/// this snapshot nor its package supplies a V1 metadata manifest, native facts or execution grant.
/// </summary>
public sealed record ArticleVaultCurrentSourceSnapshot(
    ArticleVaultCurrentSourceReference Reference,
    RevisionComparePackage Package,
    VaultSourceByteIdentity Source,
    ImmutableArray<ArticleVaultCurrentArticleObservation> Observations,
    string PermissionSnapshotSha256)
{
    public bool CanExecute => false;
    public bool CanCommitBase => false;
}

/// <summary>Retains the original three-way byte proof and the actual authorized server read.</summary>
public sealed record ArticleVaultCurrentSourceBinding(
    ArticleVaultCurrentSourceSnapshot Server,
    ArticleVaultAdmittedSource Source)
{
    public bool CanExecute => false;
    public bool CanCommitBase => false;
}

/// <summary>
/// Root integration of the existing immutable store, current observation authority, revision reader
/// and live permission guard. It creates no proposal, planner, package codec, writer or native grant.
/// Base/local acquisition and complete metadata remain independent admission requirements.
/// </summary>
public sealed class ArticleVaultCurrentSourceReader(
    IArticleVaultExecutionStore store,
    IArticleVaultCurrentObservationAuthority observations,
    IRevisionComparePackageReader revisions,
    IAuthorRecentArticleHistoryPermissionProjectionProvider permissions,
    IConfiguration configuration,
    TimeProvider timeProvider,
    string trustedVaultSiteIdentity)
{
    public async Task<ArticleVaultCurrentSourceSnapshot> ReadAsync(
        ArticleVaultCurrentSourceReference reference,
        ArticleVaultConflictReviewContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        if (!ArticleVaultExecutionIntegrity.IsOpaque(reference.PlanReference, 256)
            || !ArticleVaultExecutionIntegrity.IsDigest(reference.PlanSha256)
            || !ArticleVaultExecutionIntegrity.IsOpaque(reference.GroupIdentity, 256)
            || !ArticleVaultExecutionIntegrity.IsOpaque(reference.OperationIdentity, 256)
            || string.IsNullOrWhiteSpace(trustedVaultSiteIdentity)
            || context.SiteIdentity != trustedVaultSiteIdentity
            || context.AdminPrincipalId <= 0 || context.ArticleId <= 0)
        {
            throw Rejected("context_invalid");
        }

        string permissionSite = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration);
        var owner = new AuthorRecentArticleHistoryOwner(context.AdminPrincipalId, permissionSite);
        Guid requestId = Guid.CreateVersion7();
        var permissionRequest = new AuthorRecentArticleHistoryPermissionRequest(owner, requestId, [context.ArticleId]);
        AuthorRecentArticleHistoryPermissionSnapshot permissionBefore = await permissions.ResolveAsync(
            permissionRequest, cancellationToken).ConfigureAwait(false);
        ArticleVaultAcceptedSourceAdapter.RequirePermission(permissionBefore, owner, context.ArticleId);
        cancellationToken.ThrowIfCancellationRequested();

        ArticleVaultSealedExecutionBundle bundle = await store.LoadSealedAsync(
            reference.PlanReference, reference.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("plan_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        if (bundle.PlanReference != reference.PlanReference || bundle.PlanSha256 != reference.PlanSha256
            || bundle.AdminPrincipalId != context.AdminPrincipalId
            || bundle.Plan.SiteIdentity != context.SiteIdentity
            || bundle.Plan.VaultIdentity != context.VaultIdentity
            || bundle.Plan.DeviceIdentity != context.DeviceIdentity)
        {
            throw Rejected("plan_context_mismatch");
        }
        RequireCurrentLifetime(bundle, cancellationToken);
        VaultSyncPlanGroup group = bundle.Plan.Groups.SingleOrDefault(item => item.GroupIdentity == reference.GroupIdentity)
            ?? throw Rejected("group_missing");
        VaultSyncPlanItem item = group.Items.SingleOrDefault(item => item.OperationIdentity == reference.OperationIdentity)
            ?? throw Rejected("operation_missing");
        if (item.PortableArticleIdentity != context.PortableArticleIdentity
            || item.ServerArticleIdentity != context.ArticleId.ToString(CultureInfo.InvariantCulture)
            || !item.Server.Present || item.Server.Deleted
            || item.Server.ServerRevision is not > 0 || item.Server.Source is not { } expectedSource)
        {
            throw Rejected("present_revision_missing");
        }

        ImmutableArray<ArticleVaultCurrentArticleObservation> before = (await observations.ObserveGroupAsync(
            bundle, group, cancellationToken).ConfigureAwait(false)).ToImmutableArray();
        RequireCurrentLifetime(bundle, cancellationToken);
        ArticleVaultSyncPlanExecutor.ValidateCurrentObservations(group, before);
        var readerContext = new RevisionCompareReadContext(context.AdminPrincipalId,
            AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, requestId);
        var selector = new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision,
            RevisionId: item.Server.ServerRevision, ExpectedSourceDigest: expectedSource.Sha256);
        RevisionComparePackageReadResult read = await revisions.ReadAuthorizedAsync(
            readerContext, context.ArticleId, selector, cancellationToken).ConfigureAwait(false);
        RequireCurrentLifetime(bundle, cancellationToken);
        if (read.Status != RevisionComparePackageReadStatus.Available || read.Package is not { } package)
        {
            throw Rejected("revision_unavailable");
        }
        if (!RevisionComparePackageSeal.Verify(package)
            || package.SourceKind != RevisionCompareSourceKind.CurrentRevision
            || package.ArticleId != context.ArticleId || package.RevisionId != item.Server.ServerRevision
            || package.SourceIdentity != string.Create(CultureInfo.InvariantCulture,
                $"revision:{item.Server.ServerRevision}:{package.RevisionNo}")
            || !ArticleVaultManifestValidator.ValidateSourceBytes(expectedSource, package.RawMarkdown.AsSpan()).IsValid)
        {
            throw Rejected("revision_binding_mismatch");
        }

        ImmutableArray<ArticleVaultCurrentArticleObservation> after = (await observations.ObserveGroupAsync(
            bundle, group, cancellationToken).ConfigureAwait(false)).ToImmutableArray();
        RequireCurrentLifetime(bundle, cancellationToken);
        ArticleVaultSyncPlanExecutor.ValidateCurrentObservations(group, after);
        if (!before.SequenceEqual(after))
        {
            throw Rejected("observation_changed");
        }
        AuthorRecentArticleHistoryPermissionSnapshot permissionAfter = await permissions.ResolveAsync(
            permissionRequest, cancellationToken).ConfigureAwait(false);
        RequireCurrentLifetime(bundle, cancellationToken);
        ArticleVaultAcceptedSourceAdapter.RequirePermission(permissionAfter, owner, context.ArticleId);
        if (permissionBefore.ContentDigest != permissionAfter.ContentDigest
            || permissionSite != SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration))
        {
            throw Rejected("permission_changed");
        }
        return new(reference, package, expectedSource, after, permissionAfter.ContentDigest);
    }

    /// <summary>
    /// Replaces only supplied server bytes with the actual exact-current read, then delegates all
    /// original plan/coordinate/three-way byte checks to the sole source admission owner. It cannot
    /// qualify native base/local acquisition, Git facts, complete metadata or decision admission.
    /// </summary>
    public async Task<ArticleVaultCurrentSourceBinding> BindServerAsync(
        ArticleVaultSourceAdmissionInput current,
        ArticleVaultConflictReviewContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(current.Binding);
        VaultConflictBinding binding = current.Binding;
        ArticleVaultCurrentSourceSnapshot server = await ReadAsync(new(binding.PlanCandidateIdentity,
            binding.PlanSha256, binding.GroupIdentity, binding.OperationIdentity), context, cancellationToken).ConfigureAwait(false);
        ArticleVaultSourceAdmissionResult admitted = ArticleVaultAdmittedSource.AdmitCurrent(current with
        {
            ServerBytes = server.Package.RawMarkdown.ToArray()
        });
        cancellationToken.ThrowIfCancellationRequested();
        return admitted.Source is { } source ? new(server, source)
            : throw new ArticleVaultExecutionRejectedException(admitted.ReasonCode ?? "article_vault_source_admission_rejected");
    }

    private void RequireCurrentLifetime(ArticleVaultSealedExecutionBundle bundle, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (bundle.Plan.CancellationRequested || bundle.Plan.Status == VaultSyncPlanStatus.Cancelled
            || timeProvider.GetUtcNow().ToUnixTimeMilliseconds() > bundle.Plan.ExpiresAtUnixMs)
        {
            throw Rejected("plan_expired_or_cancelled");
        }
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new("article_vault_current_source_" + reason);
}
