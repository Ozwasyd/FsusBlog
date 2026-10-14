using System.Data;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Migration;

/// <summary>
/// Checks original raw-session counts before the legacy descriptor can clear or drop them.
/// Borrows the descriptor's transaction; it neither retires data nor grants Apply admission.
/// </summary>
internal static class MessageRawSessionRetirementPreflight
{
    private const string ConversationTable = "msg_conversation";
    private const string ConversationColumn = "createdbyadminsessionid";
    private const string MessageTable = "msg_message";
    private const string MessageColumn = "senderadminsessionid";

    internal static bool RequiresGuard(ISchemaMigrationDescriptor descriptor)
        => descriptor.MigrationId == Definitions.MessagePrivacyRetentionMigrationDefinitions.MigrationId
            || descriptor.Steps.Any(static step => step switch
            {
                DropColumnStep column => (column.TableName == ConversationTable && column.ColumnName == ConversationColumn)
                    || (column.TableName == MessageTable && column.ColumnName == MessageColumn),
                DropTableStep table => table.TableName is ConversationTable or MessageTable,
                _ => false
            });

    internal static async Task RequireEmptyAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL
                || db.Ado.Connection is not NpgsqlConnection connection || connection.State != ConnectionState.Open
                || db.Ado.Transaction is not NpgsqlTransaction transaction
                || !ReferenceEquals(transaction.Connection, connection)
                || transaction.IsolationLevel != IsolationLevel.ReadCommitted)
            {
                // A previously established RR snapshot can miss a write committed before the lock.
                throw new PreflightFailure("message_raw_session_preflight_native_transaction_required");
            }

            var beforeLock = await ReadShapeAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            await using (var command = new NpgsqlCommand("""
                LOCK TABLE public.msg_conversation, public.msg_message IN SHARE ROW EXCLUSIVE MODE NOWAIT;
                """, connection, transaction))
            {
                await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }
            var locked = await ReadShapeAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            if (beforeLock != locked)
            {
                throw new PreflightFailure("message_raw_session_preflight_relation_changed");
            }

            // Both exact counts are observed before deciding; no raw value leaves either table.
            long conversationCount = await CountAsync(connection, transaction, """
                SELECT COUNT(*) FROM public.msg_conversation WHERE createdbyadminsessionid IS NOT NULL;
                """, cancellationToken).ConfigureAwait(false);
            long messageCount = await CountAsync(connection, transaction, """
                SELECT COUNT(*) FROM public.msg_message WHERE senderadminsessionid IS NOT NULL;
                """, cancellationToken).ConfigureAwait(false);
            if (conversationCount != 0 || messageCount != 0)
            {
                throw new PreflightFailure(FormattableString.Invariant(
                    $"message_raw_session_preflight_nonzero:{ConversationTable}.{ConversationColumn}={conversationCount};{MessageTable}.{MessageColumn}={messageCount}"));
            }
            cancellationToken.ThrowIfCancellationRequested();
            // PostgreSQL retains both locks until the original descriptor transaction ends.
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (PreflightFailure)
        {
            throw;
        }
        catch (Exception)
        {
            // Provider messages/inner exceptions are not a privacy-safe diagnostic channel.
            throw new PreflightFailure("message_raw_session_preflight_read_failed");
        }
    }

    private static async Task<(long Conversation, long Message)> ReadShapeAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            SELECT relation.oid::bigint, relation.relname, relation.relkind::text,
                attribute.attname, type_namespace.nspname, type_meta.typname, attribute.atttypmod,
                attribute.attnotnull, attribute.attidentity::text, attribute.attgenerated::text,
                attribute.atthasdef, relation.relpersistence::text, relation.relispartition,
                relation.relrowsecurity, relation.relforcerowsecurity,
                EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inheritance
                    WHERE inheritance.inhrelid = relation.oid OR inheritance.inhparent = relation.oid),
                EXISTS (SELECT 1 FROM pg_catalog.pg_rewrite rule WHERE rule.ev_class = relation.oid),
                relation.oid = pg_catalog.to_regclass(relation.relname) AS resolves_public_relation
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
            LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
                AND attribute.attnum > 0 AND NOT attribute.attisdropped
                AND ((relation.relname = 'msg_conversation' AND attribute.attname = 'createdbyadminsessionid')
                    OR (relation.relname = 'msg_message' AND attribute.attname = 'senderadminsessionid'))
            LEFT JOIN pg_catalog.pg_type type_meta ON type_meta.oid = attribute.atttypid
            LEFT JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid = type_meta.typnamespace
            WHERE namespace.nspname = 'public' AND relation.relname IN ('msg_conversation', 'msg_message');
            """, connection, transaction);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        long conversation = 0;
        long message = 0;
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            string table = reader.GetString(1);
            string expectedColumn = table switch
            {
                ConversationTable => ConversationColumn,
                MessageTable => MessageColumn,
                _ => throw new PreflightFailure("message_raw_session_preflight_shape_unavailable")
            };
            // Only the original nullable varchar(64) on ordinary public tables is measured.
            // Views, RLS, inheritance, domains, generated/defaulted columns and absence refuse.
            if (reader.GetString(2) != "r" || reader.IsDBNull(3) || reader.GetString(3) != expectedColumn
                || reader.GetString(4) != "pg_catalog" || reader.GetString(5) != "varchar"
                || reader.GetInt32(6) != 68 || reader.GetBoolean(7)
                || reader.GetString(8) != string.Empty || reader.GetString(9) != string.Empty
                || reader.GetBoolean(10) || reader.GetString(11) != "p" || reader.GetBoolean(12)
                || reader.GetBoolean(13) || reader.GetBoolean(14) || reader.GetBoolean(15)
                || reader.GetBoolean(16) || reader.IsDBNull(17) || !reader.GetBoolean(17))
            {
                throw new PreflightFailure("message_raw_session_preflight_shape_unavailable");
            }
            long relation = reader.GetInt64(0);
            if (relation <= 0 || (table == ConversationTable ? conversation : message) != 0)
            {
                throw new PreflightFailure("message_raw_session_preflight_shape_unavailable");
            }
            if (table == ConversationTable)
            {
                conversation = relation;
            }
            else
            {
                message = relation;
            }
        }
        if (conversation == 0 || message == 0)
        {
            throw new PreflightFailure("message_raw_session_preflight_shape_unavailable");
        }
        return (conversation, message);
    }

    private static async Task<long> CountAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, string sql, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        if (await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is not long count || count < 0)
        {
            throw new PreflightFailure("message_raw_session_preflight_count_unavailable");
        }
        return count;
    }

    private sealed class PreflightFailure : InvalidOperationException
    {
        internal PreflightFailure(string code) : base(code)
        {
        }
    }
}
