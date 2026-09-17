using FsusBlog.Server.Entities;

using SqlSugar;

using DbType = SqlSugar.DbType;

namespace FsusBlog.Tools.Security.AnonymousCredentialRootBootstrap;

internal static class BootstrapDatabase
{
    public static ISqlSugarClient Create(string dbType, string connectionString)
    {
        var config = new ConnectionConfig
        {
            DbType = dbType.Equals("sqlite", StringComparison.OrdinalIgnoreCase)
                ? DbType.Sqlite
                : DbType.PostgreSQL,
            ConnectionString = connectionString,
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true,
            MoreSettings = new ConnMoreSettings
            {
                PgSqlIsAutoToLower = true,
                PgSqlIsAutoToLowerCodeFirst = true
            }
        };

        return new SqlSugarClient(config);
    }

    public static void EnsureLifecycleSchema(ISqlSugarClient db, string dbType)
    {
        if (!dbType.Equals("sqlite", StringComparison.OrdinalIgnoreCase))
        {
            db.CodeFirst.InitTables<AnonymousCredentialEpoch, AnonymousCredentialRoot, AnonymousCredentialRevocation>();
            return;
        }

        foreach (string statement in s_sqliteLifecycleStatements)
        {
            db.Ado.ExecuteCommand(statement);
        }
    }

    private static readonly string[] s_sqliteLifecycleStatements =
    [
        """
        CREATE TABLE IF NOT EXISTS anonymous_credential_epoch (
          epoch INTEGER PRIMARY KEY,
          status TEXT NOT NULL,
          created_at_utc TEXT NOT NULL,
          activated_at_utc TEXT NULL,
          expires_at_utc TEXT NOT NULL,
          root_grace_expires_at_utc TEXT NOT NULL,
          active_root_hash TEXT NULL,
          reason TEXT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS anonymous_credential_root (
          epoch INTEGER PRIMARY KEY,
          root_hash TEXT NOT NULL,
          revocation_root_hash TEXT NOT NULL,
          circuit_id TEXT NOT NULL,
          circuit_numeric_id INTEGER NOT NULL,
          verifying_key_hash TEXT NOT NULL,
          issuer_public_key_hash TEXT NOT NULL,
          public_input_layout_version INTEGER NOT NULL,
          circuit_metadata TEXT NULL,
          root_attestation TEXT NOT NULL,
          root_attestation_key_id TEXT NOT NULL,
          created_at_utc TEXT NOT NULL,
          activated_at_utc TEXT NULL,
          expires_at_utc TEXT NOT NULL,
          root_grace_expires_at_utc TEXT NOT NULL,
          revoked_at_utc TEXT NULL,
          updated_at_utc TEXT NOT NULL,
          status TEXT NOT NULL,
          revoke_reason TEXT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS anonymous_credential_revocation (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          epoch INTEGER NOT NULL,
          root_hash TEXT NOT NULL,
          revocation_handle_hash TEXT NOT NULL,
          revocation_root_hash TEXT NOT NULL,
          reason TEXT NULL,
          actor_id TEXT NULL,
          revoked_at_utc TEXT NOT NULL
        )
        """,
        "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_root_hash ON anonymous_credential_root(root_hash)",
        "CREATE INDEX IF NOT EXISTS idx_anonymous_credential_root_status_epoch ON anonymous_credential_root(status, epoch DESC)",
        "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_revocation_epoch_handle ON anonymous_credential_revocation(epoch, revocation_handle_hash)"
    ];
}
