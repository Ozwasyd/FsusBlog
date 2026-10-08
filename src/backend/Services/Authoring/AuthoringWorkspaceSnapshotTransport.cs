using FsusBlog.Contracts.AuthoringWorkspace;
using FsusBlog.Shared.Contracts.AuthoringWorkspace;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Maps the single authenticated workspace authority to its typed public contract.</summary>
public sealed class AuthoringWorkspaceSnapshotTransport(
    AuthoringWorkspaceSnapshotStore store, AuthoringWorkspaceSnapshotSourceIdentity sourceIdentity)
{
    public async Task<AuthoringWorkspaceSnapshotResponse> ReadAsync(
        AuthoringWorkspaceSnapshotScope scope, CancellationToken cancellationToken)
        => ToResponse(await store.ReadAsync(scope, cancellationToken).ConfigureAwait(false));

    public async Task<AuthoringWorkspaceSnapshotResponse> MutateAsync(
        AuthoringWorkspaceSnapshotScope scope, AuthoringWorkspaceSnapshotRequest request,
        CancellationToken cancellationToken)
    {
        // Scope comes from the authenticated endpoint. The request never chooses an owner or site.
        AuthoringWorkspaceSnapshotContract.ValidateScope(scope);
        if (!AuthoringWorkspaceSnapshotContract.IsDigest(request.SourceDigest)
            || !string.Equals(request.SourceDigest, sourceIdentity.SourceDigest, StringComparison.Ordinal))
        {
            throw new AuthoringWorkspaceSnapshotException("source_mismatch");
        }
        AuthoringWorkspaceSnapshotResult result = request.Action switch
        {
            "write" when request.Layout is not null && request.ResetConfirmationDigest is null
                => await store.WriteAsync(scope, request.ExpectedRevision, request.Layout,
                    cancellationToken).ConfigureAwait(false),
            "reset" when request.Layout is null && request.ResetConfirmationDigest is not null
                => await ResetAsync(scope, request, cancellationToken).ConfigureAwait(false),
            _ => throw new AuthoringWorkspaceSnapshotException("invalid_mutation_shape")
        };
        return ToResponse(result);
    }

    private Task<AuthoringWorkspaceSnapshotResult> ResetAsync(
        AuthoringWorkspaceSnapshotScope scope, AuthoringWorkspaceSnapshotRequest request,
        CancellationToken cancellationToken)
    {
        // #1805 requires a collapsed outline by default. Preserve the offered source;
        // do not silently rewrite a signed candidate while its upstream default conflicts.
        if (AuthoringWorkspaceSnapshotContract.DefaultLayout().Shell.OutlineOpen)
        {
            throw new AuthoringWorkspaceSnapshotException("default_layout_unqualified");
        }
        return store.ResetAsync(scope, request.ExpectedRevision, request.ResetConfirmationDigest!, cancellationToken);
    }

    private static AuthoringWorkspaceSnapshotResponse ToResponse(AuthoringWorkspaceSnapshotResult result)
    {
        AuthoringWorkspaceSnapshotReceipt receipt = result.Receipt;
        return new(result.Status, result.Revision, result.Snapshot,
            new(receipt.Schema, receipt.Action, receipt.Status, receipt.Reason,
                receipt.Scope, receipt.WorkspaceId, receipt.SourceDigest,
                receipt.RevisionBefore, receipt.RevisionAfter, receipt.TabCount, receipt.ByteCount,
                receipt.InputDigest, receipt.SnapshotDigest, receipt.ContentDigest));
    }
}
