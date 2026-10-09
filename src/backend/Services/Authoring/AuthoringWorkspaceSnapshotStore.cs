using FsusBlog.Contracts.AuthoringWorkspace;

namespace FsusBlog.Server.Services.Authoring;

public sealed record AuthoringWorkspaceSnapshotStoredRow(long Revision, byte[] Bytes);

/// <summary>One user/site/default row. CompareExchange must be atomic across processes/devices.</summary>
public interface IAuthoringWorkspaceSnapshotPersistence
{
    Task<AuthoringWorkspaceSnapshotStoredRow?> ReadAsync(
        AuthoringWorkspaceSnapshotScope scope, CancellationToken cancellationToken);
    Task<bool> CompareExchangeAsync(
        AuthoringWorkspaceSnapshotScope scope, long expectedRevision,
        AuthoringWorkspaceSnapshotStoredRow next, CancellationToken cancellationToken);
}

public sealed record AuthoringWorkspaceSnapshotReceipt(
    string Schema, string Action, string Status, string? Reason,
    AuthoringWorkspaceSnapshotScope Scope, string WorkspaceId, string SourceDigest,
    long RevisionBefore, long RevisionAfter, int TabCount, int ByteCount,
    string InputDigest, string? SnapshotDigest, string ContentDigest);

public sealed record AuthoringWorkspaceSnapshotResult(
    string Status, long Revision, AuthoringWorkspaceSnapshot? Snapshot,
    AuthoringWorkspaceSnapshotReceipt Receipt);

/// <summary>
/// Server authority. Caller supplies a session-derived scope; this domain service never authenticates client scope.
/// Failures propagate, and reads/validation never create, repair, reset or delete stored data.
/// </summary>
public sealed class AuthoringWorkspaceSnapshotStore(
    IAuthoringWorkspaceSnapshotPersistence persistence, TimeProvider timeProvider, string sourceDigest)
{
    public async Task<AuthoringWorkspaceSnapshotResult> ReadAsync(
        AuthoringWorkspaceSnapshotScope scope, CancellationToken cancellationToken = default)
    {
        ValidateScopeAndSource(scope);
        AuthoringWorkspaceSnapshotStoredRow? row = await persistence.ReadAsync(scope, cancellationToken).ConfigureAwait(false);
        if (row is null)
        {
            return Result("read", "missing", null, scope, 0, 0, null, AuthoringWorkspaceSnapshotContract.Digest(scope));
        }
        try
        {
            AuthoringWorkspaceSnapshot snapshot = ValidateRow(scope, row);
            return Result("read", "current", null, scope, row.Revision, row.Revision, snapshot,
                AuthoringWorkspaceSnapshotContract.Digest(scope));
        }
        catch (AuthoringWorkspaceSnapshotException ex)
        {
            return Result("read", "blocked", ex.Reason, scope, row.Revision, row.Revision, null,
                AuthoringWorkspaceSnapshotContract.Digest(scope));
        }
    }

    public Task<AuthoringWorkspaceSnapshotResult> WriteAsync(
        AuthoringWorkspaceSnapshotScope scope, long expectedRevision,
        AuthoringWorkspaceSnapshotLayout layout, CancellationToken cancellationToken = default)
        => MutateAsync("write", scope, expectedRevision, layout, cancellationToken);

    public static string ResetConfirmation(AuthoringWorkspaceSnapshotScope scope, long revision, string sourceDigest)
        => AuthoringWorkspaceSnapshotContract.Digest(new
        {
            action = "reset-default-layout",
            scope,
            workspaceId = AuthoringWorkspaceSnapshotContract.WorkspaceId,
            expectedRevision = revision,
            sourceDigest
        });

    public Task<AuthoringWorkspaceSnapshotResult> ResetAsync(
        AuthoringWorkspaceSnapshotScope scope, long expectedRevision, string confirmationDigest,
        CancellationToken cancellationToken = default)
    {
        ValidateScopeAndSource(scope);
        if (confirmationDigest != ResetConfirmation(scope, expectedRevision, sourceDigest))
        {
            throw new AuthoringWorkspaceSnapshotException("reset_confirmation_mismatch");
        }
        // Reset replaces only layout; there is no article, draft, attachment, preference or journal dependency.
        return MutateAsync("reset", scope, expectedRevision, AuthoringWorkspaceSnapshotContract.DefaultLayout(), cancellationToken);
    }

    private async Task<AuthoringWorkspaceSnapshotResult> MutateAsync(
        string action, AuthoringWorkspaceSnapshotScope scope, long expectedRevision,
        AuthoringWorkspaceSnapshotLayout layout, CancellationToken cancellationToken)
    {
        ValidateScopeAndSource(scope);
        if (expectedRevision < 0 || expectedRevision >= AuthoringWorkspaceSnapshotContract.MaxSafeInteger)
        {
            throw new AuthoringWorkspaceSnapshotException("invalid_expected_revision");
        }
        // Seal before awaiting so the in-flight candidate cannot change through caller-owned arrays.
        AuthoringWorkspaceSnapshot next = AuthoringWorkspaceSnapshotContract.Seal(
            scope, sourceDigest, expectedRevision + 1, timeProvider.GetUtcNow().ToUnixTimeMilliseconds(), layout);
        string inputDigest = AuthoringWorkspaceSnapshotContract.Digest(new
        {
            expectedRevision,
            next.Layout
        });
        AuthoringWorkspaceSnapshotStoredRow? row = await persistence.ReadAsync(scope, cancellationToken).ConfigureAwait(false);
        long actualRevision = row?.Revision ?? 0;
        if (actualRevision != expectedRevision)
        {
            return Result(action, "conflict", "stale_revision", scope, actualRevision, actualRevision, null, inputDigest);
        }
        if (row is not null)
        {
            // An incompatible/corrupt record is blocked, never silently repaired by a write or reset.
            _ = ValidateRow(scope, row);
        }
        byte[] bytes = AuthoringWorkspaceSnapshotContract.Serialize(next);
        bool exchanged = await persistence.CompareExchangeAsync(
            scope, expectedRevision, new(next.Revision, bytes), cancellationToken).ConfigureAwait(false);
        if (!exchanged)
        {
            AuthoringWorkspaceSnapshotStoredRow? current = await persistence.ReadAsync(scope, cancellationToken).ConfigureAwait(false);
            return Result(action, "conflict", "stale_revision", scope, current?.Revision ?? 0,
                current?.Revision ?? 0, null, inputDigest);
        }
        return Result(action, "applied", null, scope, expectedRevision, next.Revision, next, inputDigest);
    }

    private AuthoringWorkspaceSnapshot ValidateRow(
        AuthoringWorkspaceSnapshotScope scope, AuthoringWorkspaceSnapshotStoredRow row)
    {
        AuthoringWorkspaceSnapshot snapshot = AuthoringWorkspaceSnapshotContract.Parse(row.Bytes, scope, sourceDigest);
        if (row.Revision != snapshot.Revision || snapshot.UpdatedAt > timeProvider.GetUtcNow().ToUnixTimeMilliseconds())
        {
            throw new AuthoringWorkspaceSnapshotException("stored_revision_or_time_mismatch");
        }
        return snapshot;
    }

    private void ValidateScopeAndSource(AuthoringWorkspaceSnapshotScope scope)
    {
        AuthoringWorkspaceSnapshotContract.ValidateScope(scope);
        if (!AuthoringWorkspaceSnapshotContract.IsDigest(sourceDigest))
        {
            throw new AuthoringWorkspaceSnapshotException("invalid_source_digest");
        }
    }

    private AuthoringWorkspaceSnapshotResult Result(
        string action, string status, string? reason, AuthoringWorkspaceSnapshotScope scope,
        long before, long after, AuthoringWorkspaceSnapshot? snapshot, string inputDigest)
    {
        var receipt = new AuthoringWorkspaceSnapshotReceipt(
            "fsusblog.authoring-workspace-snapshot-receipt.v1", action, status, reason, scope,
            AuthoringWorkspaceSnapshotContract.WorkspaceId, sourceDigest, before, after,
            snapshot?.Layout.Tabs.Length ?? 0, snapshot is null ? 0 : AuthoringWorkspaceSnapshotContract.Serialize(snapshot).Length,
            inputDigest, snapshot?.ContentDigest, string.Empty);
        receipt = receipt with
        {
            ContentDigest = AuthoringWorkspaceSnapshotContract.Digest(receipt)
        };
        return new(status, after, snapshot, receipt);
    }

    public static bool VerifyReceipt(AuthoringWorkspaceSnapshotResult result)
    {
        AuthoringWorkspaceSnapshotReceipt receipt = result.Receipt;
        if (receipt.Schema != "fsusblog.authoring-workspace-snapshot-receipt.v1"
            || receipt.WorkspaceId != AuthoringWorkspaceSnapshotContract.WorkspaceId
            || receipt.Action is not ("read" or "write" or "reset")
            || receipt.Status != result.Status || receipt.RevisionAfter != result.Revision
            || receipt.Status is not ("current" or "missing" or "blocked" or "applied" or "conflict")
            || receipt.RevisionBefore < 0 || receipt.RevisionAfter < 0
            || receipt.RevisionBefore > AuthoringWorkspaceSnapshotContract.MaxSafeInteger
            || receipt.RevisionAfter > AuthoringWorkspaceSnapshotContract.MaxSafeInteger
            || !AuthoringWorkspaceSnapshotContract.IsDigest(receipt.SourceDigest)
            || !AuthoringWorkspaceSnapshotContract.IsDigest(receipt.InputDigest))
        {
            return false;
        }
        try
        {
            AuthoringWorkspaceSnapshotContract.ValidateScope(receipt.Scope);
            bool hasSnapshot = receipt.Status is "current" or "applied";
            if (hasSnapshot != (result.Snapshot is not null) || (!hasSnapshot
                && (receipt.SnapshotDigest is not null || receipt.TabCount != 0 || receipt.ByteCount != 0)))
            {
                return false;
            }
            if (result.Snapshot is { } snapshot)
            {
                byte[] bytes = AuthoringWorkspaceSnapshotContract.Serialize(snapshot);
                _ = AuthoringWorkspaceSnapshotContract.Parse(bytes, receipt.Scope, receipt.SourceDigest);
                if (snapshot.Revision != result.Revision || snapshot.ContentDigest != receipt.SnapshotDigest
                    || bytes.Length != receipt.ByteCount || snapshot.Layout.Tabs.Length != receipt.TabCount)
                {
                    return false;
                }
            }
            if ((receipt.Status == "missing" && (receipt.Action != "read" || result.Revision != 0))
                || (receipt.Status == "current" && (receipt.Action != "read" || receipt.RevisionBefore != result.Revision))
                || (receipt.Status == "applied" && (receipt.Action == "read" || result.Revision != receipt.RevisionBefore + 1)))
            {
                return false;
            }
            return AuthoringWorkspaceSnapshotContract.Digest(receipt with
            {
                ContentDigest = string.Empty
            }) == receipt.ContentDigest;
        }
        catch (AuthoringWorkspaceSnapshotException)
        {
            return false;
        }
    }
}
