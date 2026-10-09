using System.Data.Common;

using FsusBlog.Contracts.AuthoringWorkspace;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Atomic PostgreSQL CAS. No history/queue/second store; retained row replacement has a fixed byte budget.</summary>
public sealed class AuthoringWorkspaceSnapshotPostgresPersistence(ISqlSugarClient db) : IAuthoringWorkspaceSnapshotPersistence
{
    // Migration registration belongs to the integration owner. Never provision schema on request or startup here.
    public const string SchemaSql = """
        CREATE TABLE authoring_workspace_snapshot (
            user_id bigint NOT NULL REFERENCES admin_principal(id) ON DELETE CASCADE,
            site_id varchar(128) NOT NULL,
            workspace_id varchar(7) NOT NULL CHECK (workspace_id = 'default'),
            revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
            snapshot_bytes bytea NOT NULL CHECK (octet_length(snapshot_bytes) BETWEEN 1 AND 65536),
            PRIMARY KEY (user_id, site_id, workspace_id)
        );
        """;

    public async Task<AuthoringWorkspaceSnapshotStoredRow?> ReadAsync(
        AuthoringWorkspaceSnapshotScope scope, CancellationToken cancellationToken)
    {
        AuthoringWorkspaceSnapshotContract.ValidateScope(scope);
        cancellationToken.ThrowIfCancellationRequested();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT revision, snapshot_bytes FROM authoring_workspace_snapshot
            WHERE user_id = @UserId AND site_id = @SiteId AND workspace_id = 'default';
            """,
            new SugarParameter("@UserId", scope.UserId), new SugarParameter("@SiteId", scope.SiteId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        long revision = reader.GetInt64(0);
        // Inspect the provider length before allocation, including damaged rows from an obsolete schema.
        long length = reader.GetBytes(1, 0, null, 0, 0);
        if (length is < 1 or > AuthoringWorkspaceSnapshotContract.MaxBytes)
        {
            throw new AuthoringWorkspaceSnapshotException("oversize");
        }
        var bytes = new byte[(int)length];
        if (reader.GetBytes(1, 0, bytes, 0, bytes.Length) != length)
        {
            throw new AuthoringWorkspaceSnapshotException("corrupt");
        }
        return new(revision, bytes);
    }

    public async Task<bool> CompareExchangeAsync(
        AuthoringWorkspaceSnapshotScope scope, long expectedRevision,
        AuthoringWorkspaceSnapshotStoredRow next, CancellationToken cancellationToken)
    {
        AuthoringWorkspaceSnapshotContract.ValidateScope(scope);
        if (expectedRevision < 0 || expectedRevision >= AuthoringWorkspaceSnapshotContract.MaxSafeInteger
            || next.Revision != expectedRevision + 1 || next.Bytes.Length is < 1 or > AuthoringWorkspaceSnapshotContract.MaxBytes)
        {
            throw new AuthoringWorkspaceSnapshotException("invalid_cas_candidate");
        }
        // The service supplies canonical validated bytes. Recheck closure at the storage adapter boundary.
        byte[] bytes = next.Bytes.ToArray();
        using var document = System.Text.Json.JsonDocument.Parse(bytes);
        string source = document.RootElement.GetProperty("sourceDigest").GetString()!;
        AuthoringWorkspaceSnapshot snapshot = AuthoringWorkspaceSnapshotContract.Parse(bytes, scope, source);
        if (snapshot.Revision != next.Revision)
        {
            throw new AuthoringWorkspaceSnapshotException("stored_revision_mismatch");
        }
        cancellationToken.ThrowIfCancellationRequested();
        string sql = expectedRevision == 0
            ? """
              INSERT INTO authoring_workspace_snapshot(user_id, site_id, workspace_id, revision, snapshot_bytes)
              VALUES (@UserId, @SiteId, 'default', @NextRevision, @Bytes)
              ON CONFLICT (user_id, site_id, workspace_id) DO NOTHING;
              """
            : """
              UPDATE authoring_workspace_snapshot SET revision = @NextRevision, snapshot_bytes = @Bytes
              WHERE user_id = @UserId AND site_id = @SiteId AND workspace_id = 'default'
                AND revision = @ExpectedRevision;
              """;
        int changed = await db.Ado.ExecuteCommandAsync(sql,
            new SugarParameter("@UserId", scope.UserId), new SugarParameter("@SiteId", scope.SiteId),
            new SugarParameter("@ExpectedRevision", expectedRevision), new SugarParameter("@NextRevision", next.Revision),
            new SugarParameter("@Bytes", bytes)).ConfigureAwait(false);
        return changed == 1;
    }
}
