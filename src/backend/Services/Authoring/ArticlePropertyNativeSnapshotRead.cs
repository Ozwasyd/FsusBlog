using System.Data;
using System.Text;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Actual native MVCC data, not a Query generation, document/parser epoch or permission grant.</summary>
internal sealed record ArticlePropertyNativeSnapshotObservation(string PostgreSqlSnapshot, bool ReadOnly);

internal static class ArticlePropertyNativeSnapshotRead
{
    private const int MaxSnapshotBytes = 64 * 1024;

    internal static NpgsqlConnection Require(ISqlSugarClient db, NpgsqlTransaction transaction)
    {
        if (!ReferenceEquals(db.Ado.Transaction, transaction) || db.Ado.Connection is not NpgsqlConnection connection
            || !ReferenceEquals(transaction.Connection, connection) || connection.State != ConnectionState.Open
            || !SupportsConsistentSnapshot(transaction.IsolationLevel))
            throw new ArticlePropertyDefinitionIntegrityException("article_property_native_snapshot_required");
        return connection;
    }

    internal static bool SupportsConsistentSnapshot(IsolationLevel isolation)
        => isolation is IsolationLevel.RepeatableRead or IsolationLevel.Serializable;

    internal static async Task<ArticlePropertyNativeSnapshotObservation> ObserveAsync(
        ISqlSugarClient db, NpgsqlTransaction transaction, CancellationToken cancellationToken)
    {
        using var command = new NpgsqlCommand("""
            SELECT CASE WHEN octet_length(pg_current_snapshot()::text)<=65536
                        THEN pg_current_snapshot()::text ELSE NULL END,
                   current_setting('transaction_isolation'),current_setting('transaction_read_only');
            """, Require(db, transaction), transaction);
        using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false) || reader.IsDBNull(0)
            || reader.GetString(1) is not ("repeatable read" or "serializable")
            || reader.GetString(2) is not ("on" or "off"))
            throw new ArticlePropertyDefinitionIntegrityException("article_property_native_snapshot_unavailable");
        Require(db, transaction);
        string snapshot = reader.GetString(0);
        if (snapshot.Length == 0 || Encoding.UTF8.GetByteCount(snapshot) > MaxSnapshotBytes)
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_native_snapshot_budget");
        return new(snapshot, reader.GetString(2) == "on");
    }
}
