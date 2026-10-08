using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Binds a canonical historical package to one exact accepted operation. Package metadata remains
/// in its existing revision schema; it is not a complete portable metadata coordinate or native grant.
/// </summary>
public sealed record ArticleVaultAcceptedSource(
    ArticleVaultMaterializationInstruction Instruction,
    string OperationReceiptSha256,
    RevisionComparePackage Package,
    VaultSourceByteIdentity Source,
    string PermissionSnapshotSha256)
{
    /// <summary>Reading accepted bytes does not verify any local file, manifest or base transaction.</summary>
    public bool CanCommitBase => false;
}

/// <summary>
/// Adapts the existing revision reader rather than introducing another reader or writer. The
/// trusted Vault site identity is supplied by server composition, never by a read request. The
/// existing single-site authority supplies the primary compare scope and configured permission
/// scope. Integration must bind that configured site to this Vault identity before registration.
/// </summary>
public sealed class ArticleVaultAcceptedSourceAdapter
{
    private readonly IArticleVaultExecutionStore _store;
    private readonly IRevisionComparePackageReader _reader;
    private readonly IAuthorRecentArticleHistoryPermissionProjectionProvider _permissions;
    private readonly IConfiguration _configuration;
    private readonly string _trustedVaultSiteIdentity;
    private readonly string _permissionSiteScope;

    public ArticleVaultAcceptedSourceAdapter(
        IArticleVaultExecutionStore store,
        IRevisionComparePackageReader reader,
        IAuthorRecentArticleHistoryPermissionProjectionProvider permissions,
        IConfiguration configuration,
        string trustedVaultSiteIdentity)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(reader);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(configuration);
        if (string.IsNullOrWhiteSpace(trustedVaultSiteIdentity))
        {
            throw Rejected("article_vault_accepted_source_site_binding_invalid");
        }

        _store = store;
        _reader = reader;
        _permissions = permissions;
        _configuration = configuration;
        _trustedVaultSiteIdentity = trustedVaultSiteIdentity;
        _permissionSiteScope = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration);
    }

    /// <summary>
    /// Loads only the named immutable plan/result and reads receipt.AfterRevision as ArticleRevision.Id,
    /// not RevisionNo. Rechecks live permission after reading, verifies the canonical package seal,
    /// and explicitly binds all source byte facts because the underlying reader does not check the
    /// expected source digest. Cancellation and refusals return no partial accepted-source result.
    /// </summary>
    public async Task<ArticleVaultAcceptedSource> ReadAsync(
        ArticleVaultOperationIdentity operation,
        string resultReference,
        string resultSha256,
        string itemOperationIdentity,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(operation);
        cancellationToken.ThrowIfCancellationRequested();
        if (operation.SiteIdentity != _trustedVaultSiteIdentity
            || _permissionSiteScope != SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(_configuration)
            || string.IsNullOrWhiteSpace(resultReference) || resultReference.Length > 1024
            || resultSha256 is null || resultSha256.Length != 64
            || string.IsNullOrWhiteSpace(itemOperationIdentity))
        {
            throw Rejected("article_vault_accepted_source_binding_invalid");
        }

        ArticleVaultSealedExecutionBundle bundle = await _store.LoadSealedAsync(
            operation.PlanReference, operation.PlanSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("article_vault_accepted_source_plan_missing");
        ArticleVaultExecutionIntegrity.ValidateBundle(bundle);
        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.ValidateIdentity(operation, bundle.Plan));
        if (bundle.PlanReference != operation.PlanReference || bundle.PlanSha256 != operation.PlanSha256
            || bundle.Plan.SiteIdentity != _trustedVaultSiteIdentity)
        {
            throw Rejected("article_vault_accepted_source_plan_mismatch");
        }

        ArticleVaultExecutionResult result = await _store.LoadResultAsync(resultReference, cancellationToken)
            .ConfigureAwait(false) ?? throw Rejected("article_vault_accepted_source_result_missing");
        if (result.ResultReference != resultReference || result.ContentSha256 != resultSha256)
        {
            throw Rejected("article_vault_accepted_source_result_mismatch");
        }

        ArticleVaultMaterializationPreflight preflight = ArticleVaultMaterializationPreflightVerifier.Prepare(
            bundle, result, operation);
        ArticleVaultMaterializationInstruction? instruction = preflight.SourceInstructions
            .SingleOrDefault(item => item.OperationIdentity == itemOperationIdentity);
        ArticleVaultOperationResultReceipt? receipt = result.Groups.SelectMany(static group => group.Operations)
            .SingleOrDefault(item => item.OperationIdentity == itemOperationIdentity);
        if (instruction?.NewSource is not { } expectedSource || receipt is null
            || receipt.ArticleId is not > 0 || receipt.AfterRevision is not > 0)
        {
            throw Rejected("article_vault_accepted_source_present_revision_missing");
        }

        var owner = new AuthorRecentArticleHistoryOwner(bundle.AdminPrincipalId, _permissionSiteScope);
        Guid requestId = Guid.CreateVersion7();
        var permissionRequest = new AuthorRecentArticleHistoryPermissionRequest(owner, requestId, [receipt.ArticleId.Value]);
        AuthorRecentArticleHistoryPermissionSnapshot before = await _permissions.ResolveAsync(
            permissionRequest, cancellationToken).ConfigureAwait(false);
        RequirePermission(before, owner, receipt.ArticleId.Value);
        cancellationToken.ThrowIfCancellationRequested();

        var context = new RevisionCompareReadContext(bundle.AdminPrincipalId,
            AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, requestId);
        var selector = new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision,
            RevisionId: receipt.AfterRevision.Value, ExpectedSourceDigest: expectedSource.Sha256);
        RevisionComparePackageReadResult read = await _reader.ReadAuthorizedAsync(
            context, receipt.ArticleId.Value, selector, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (read.Status != RevisionComparePackageReadStatus.Available || read.Package is not { } package)
        {
            throw Rejected("article_vault_accepted_source_unavailable");
        }

        if (!RevisionComparePackageSeal.Verify(package)
            || package.SourceKind != RevisionCompareSourceKind.HistoricalRevision
            || package.ArticleId != receipt.ArticleId || package.RevisionId != receipt.AfterRevision
            || package.SourceIdentity != string.Create(System.Globalization.CultureInfo.InvariantCulture,
                $"revision:{receipt.AfterRevision}:{package.RevisionNo}")
            || package.SourceDigest != expectedSource.Sha256
            || package.SourceDigest != receipt.ArticleContentSha256
            || !ArticleVaultMaterializationInstructionCodec.VerifyBytes(instruction, package.RawMarkdown.AsSpan()).IsValid)
        {
            throw Rejected("article_vault_accepted_source_package_mismatch");
        }

        AuthorRecentArticleHistoryPermissionSnapshot after = await _permissions.ResolveAsync(
            permissionRequest, cancellationToken).ConfigureAwait(false);
        RequirePermission(after, owner, receipt.ArticleId.Value);
        cancellationToken.ThrowIfCancellationRequested();
        if (before.ContentDigest != after.ContentDigest
            || _permissionSiteScope != SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(_configuration))
        {
            throw Rejected("article_vault_accepted_source_permission_changed");
        }

        return new(instruction, receipt.ContentSha256, package,
            ArticleVaultManifestCodec.CaptureSourceBytes(package.RawMarkdown.AsSpan()), after.ContentDigest);
    }

    private static void RequirePermission(
        AuthorRecentArticleHistoryPermissionSnapshot snapshot,
        AuthorRecentArticleHistoryOwner owner,
        int articleId)
    {
        if (snapshot.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            || snapshot.Owner != owner || snapshot.Decisions.Count != 1
            || snapshot.Decisions[0].ArticleId != articleId
            || !snapshot.Decisions[0].CanProject || !snapshot.Decisions[0].CanWrite
            || snapshot.ContentDigest != AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot))
        {
            throw Rejected("article_vault_accepted_source_permission_denied");
        }
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new(reason);
}
