using System.Data;
using System.Data.Common;
using System.Security.Cryptography;

using Npgsql;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// PostgreSQL exclusion on the actual authority rows. FOR SHARE conflicts with ordinary
/// non-key UPDATEs (FOR KEY SHARE would not). Locks survive until this exact transaction ends.
/// Neither a projection reread nor another connection establishes commit atomicity.
/// </summary>
internal static class AdminRequestSqlFence
{
    internal static async Task PublishReadAsync<T>(
        AdminAuthenticatedRequestLifetime lifetime,
        DbConnection connection,
        Func<DbConnection, DbTransaction, CancellationToken, Task<T>> read,
        Func<T, CancellationToken, Task> publish,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(read);
        ArgumentNullException.ThrowIfNull(publish);
        RequirePostgres(connection);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Invalidated);
        await using DbTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, linked.Token);
        await VerifyAndFenceAsync(lifetime, connection, transaction, linked.Token);
        T value = await read(connection, transaction, linked.Token);
        // Rechecks wall-clock expiry after an arbitrarily slow read while the same locks remain held.
        await VerifyAndFenceAsync(lifetime, connection, transaction, linked.Token);
        await publish(value, linked.Token);
        await transaction.CommitAsync(linked.Token);
    }

    internal static async Task VerifyAndFenceAsync(
        AdminAuthenticatedRequestLifetime lifetime,
        DbConnection connection,
        DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        RequirePostgres(connection);
        if (transaction is not NpgsqlTransaction || !ReferenceEquals(transaction.Connection, connection)
            || transaction.IsolationLevel != IsolationLevel.ReadCommitted)
        {
            throw new InvalidOperationException("The original open PostgreSQL ReadCommitted transaction is required.");
        }
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, lifetime.Invalidated);
        AdminRequestBinding binding = lifetime.RequireBinding();
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = 5;
        // Acquire principal first, then session. All later checks run after waiting for both locks.
        // Version/expiry predicates must not be used to accidentally omit a row from locking.
        command.CommandText = """
            SELECT status, validationversion FROM admin_principal WHERE id = @principal FOR SHARE;
            """;
        Add(command, "principal", binding.PrincipalId);
        await using (DbDataReader reader = await command.ExecuteReaderAsync(linked.Token))
        {
            if (!await reader.ReadAsync(linked.Token)
                || reader.GetString(0) != "active" || reader.GetInt64(1) != binding.PrincipalVersion)
            {
                throw Denied();
            }
        }
        command.Parameters.Clear();
        command.CommandText = """
            SELECT adminprincipalid, accesstokenhash, validationversion, revokedatutc,
                   idleexpiresatutc, absoluteexpiresatutc,
                   idleexpiresatutc > (clock_timestamp() AT TIME ZONE 'UTC')
                       AND absoluteexpiresatutc > (clock_timestamp() AT TIME ZONE 'UTC') AS unexpired
            FROM admin_session WHERE sessionid = @session FOR SHARE;
            """;
        Add(command, "session", binding.SessionId);
        await using (DbDataReader reader = await command.ExecuteReaderAsync(linked.Token))
        {
            if (!await reader.ReadAsync(linked.Token)
                || reader.GetInt64(0) != binding.PrincipalId
                || !HashMatches(reader.GetString(1), binding.TokenHash)
                || reader.GetInt64(2) != binding.SessionVersion
                || !reader.IsDBNull(3)
                || Utc(reader.GetDateTime(4)) != binding.IdleExpiresAtUtc
                || Utc(reader.GetDateTime(5)) != binding.AbsoluteExpiresAtUtc
                || !reader.GetBoolean(6))
            {
                throw Denied();
            }
        }
        _ = lifetime.RequireBinding();
        linked.Token.ThrowIfCancellationRequested();
    }

    private static void RequirePostgres(DbConnection connection)
    {
        if (connection is not NpgsqlConnection || connection.State != ConnectionState.Open)
        {
            throw new InvalidOperationException("An open PostgreSQL connection is required.");
        }
    }

    private static void Add(DbCommand command, string name, object value)
    {
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = name;
        parameter.Value = value;
        command.Parameters.Add(parameter);
    }

    private static bool HashMatches(string encoded, byte[] expected)
    {
        Span<byte> decoded = stackalloc byte[32];
        return Convert.FromHexString(encoded, decoded, out int consumed, out int written) == System.Buffers.OperationStatus.Done
            && consumed == encoded.Length && written == 32 && CryptographicOperations.FixedTimeEquals(decoded, expected);
    }

    private static DateTimeOffset Utc(DateTime value)
        => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private static OperationCanceledException Denied() => new("Admin SQL authority fence rejected the request.");
}
