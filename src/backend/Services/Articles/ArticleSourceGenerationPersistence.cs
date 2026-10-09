using System.Data;

using Npgsql;

using NpgsqlTypes;

using SqlSugar;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Articles;

/// <summary>SQL implementation over the caller's original connection and transaction; no schema or lifecycle writer.</summary>
internal static class ArticleSourceGenerationPersistence
{
    internal static NpgsqlConnection RequireConnection(ISqlSugarClient db)
    {
        ArgumentNullException.ThrowIfNull(db);
        if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL
            || db.Ado.Connection is not NpgsqlConnection connection
            || (db.Ado.Transaction is not null
                && (db.Ado.Transaction is not NpgsqlTransaction transaction
                    || !ReferenceEquals(transaction.Connection, connection))))
        {
            throw new InvalidOperationException("article_source_native_provider_mismatch");
        }
        return connection;
    }

    internal static Task<long?> ReadGenerationAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => ReadAsync<long?>(db, async (connection, transaction) =>
        {
            if (!await TableExistsAsync(connection, transaction, "article_source_generation", cancellationToken)
                .ConfigureAwait(false))
            {
                return null;
            }
            await using NpgsqlCommand command = new(
                "SELECT family_id, source_generation FROM article_source_generation;", connection, transaction);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            long generation = ReadClock(reader);
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("article_source_family_invalid");
            }
            return generation;
        }, cancellationToken);

    internal static Task<ArticleSourceCursor?> ReadArticleCursorAsync(
        ISqlSugarClient db, int articleId, CancellationToken cancellationToken)
        => ReadAsync<ArticleSourceCursor?>(db, async (connection, transaction) =>
        {
            if (!await TableExistsAsync(connection, transaction, "article_source_generation", cancellationToken)
                .ConfigureAwait(false)
                || !await TableExistsAsync(connection, transaction, "article_source_sequence", cancellationToken)
                    .ConfigureAwait(false))
            {
                return null;
            }
            await using NpgsqlCommand command = new("""
                SELECT clock.family_id, clock.source_generation, sequence.source_sequence
                FROM article_source_generation clock
                LEFT JOIN article_source_sequence sequence ON sequence.article_id = @ArticleId;
                """, connection, transaction);
            command.Parameters.AddWithValue("ArticleId", articleId);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            long generation = ReadClock(reader);
            long? sequence = reader.IsDBNull(2) ? null : reader.GetInt64(2);
            if (sequence is <= 0 || sequence > generation
                || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("article_source_cursor_invalid");
            }
            return sequence.HasValue ? new ArticleSourceCursor(articleId, generation, sequence.Value) : null;
        }, cancellationToken);

    private static async Task<T> ReadAsync<T>(ISqlSugarClient db,
        Func<NpgsqlConnection, NpgsqlTransaction?, Task<T>> read, CancellationToken cancellationToken)
    {
        NpgsqlConnection connection = RequireConnection(db);
        cancellationToken.ThrowIfCancellationRequested();
        bool opened = connection.State == ConnectionState.Closed;
        if (opened)
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        }
        try
        {
            return await read(connection, db.Ado.Transaction as NpgsqlTransaction).ConfigureAwait(false);
        }
        finally
        {
            if (opened)
            {
                await connection.CloseAsync().ConfigureAwait(false);
            }
        }
    }

    private static async Task<bool> TableExistsAsync(NpgsqlConnection connection, NpgsqlTransaction? transaction,
        string name, CancellationToken cancellationToken)
    {
        await using NpgsqlCommand command = new("SELECT to_regclass(@TableName) IS NOT NULL;", connection, transaction);
        command.Parameters.AddWithValue("TableName", name);
        return (bool)(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false))!;
    }

    internal static async Task RequireLockAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken)
    {
        await using NpgsqlCommand command = new("""
            SELECT EXISTS (
                SELECT 1 FROM pg_locks
                WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
                  AND mode = 'ExclusiveLock' AND classid = @Namespace::oid
                  AND objid = @Key::oid AND objsubid = 2
            );
            """, connection, transaction);
        command.Parameters.AddWithValue("Namespace", ArticleSourceGenerationAuthority.LockNamespace);
        command.Parameters.AddWithValue("Key", ArticleSourceGenerationAuthority.LockKey);
        if (!(bool)(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false))!)
        {
            throw new InvalidOperationException("article_source_mutation_lock_lost");
        }
    }

    internal static async Task<ArticleMutationOutboxEvent> ReadEventAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, string eventId, CancellationToken cancellationToken)
    {
        await using NpgsqlCommand command = new("""
            SELECT id, event_id, aggregate_type, aggregate_id, schema_version, event_type,
                   article_revision_id, revision_no, rights_snapshot_id, responsibility_snapshot_id,
                   responsibility_version, article_publication_id, publication_no, payload_json, created_at
            FROM article_mutation_outbox WHERE event_id = @EventId FOR UPDATE;
            """, connection, transaction);
        command.Parameters.AddWithValue("EventId", eventId);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("article_source_event_missing");
        }
        var item = new ArticleMutationOutboxEvent
        {
            Id = reader.GetInt64(0),
            EventId = reader.GetString(1),
            AggregateType = reader.GetString(2),
            AggregateId = reader.GetInt32(3),
            SchemaVersion = reader.GetInt32(4),
            EventType = reader.GetString(5),
            ArticleRevisionId = NullableInt64(reader, 6),
            RevisionNo = NullableInt32(reader, 7),
            RightsSnapshotId = NullableInt64(reader, 8),
            ResponsibilitySnapshotId = NullableInt64(reader, 9),
            ResponsibilityVersion = NullableInt32(reader, 10),
            ArticlePublicationId = NullableInt64(reader, 11),
            PublicationNo = NullableInt32(reader, 12),
            PayloadJson = reader.GetString(13),
            CreatedAt = DateTime.SpecifyKind(reader.GetDateTime(14), DateTimeKind.Utc)
        };
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("article_source_event_ambiguous");
        }
        return item;
    }

    internal static async Task<ArticleSourceCursor?> ReadEnrollmentAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, ArticleMutationOutboxEvent item, string facts, CancellationToken cancellationToken)
    {
        await using NpgsqlCommand command = new("""
            SELECT journal.article_id, journal.source_generation, journal.source_sequence, journal.event_facts,
                   clock.family_id, clock.source_generation, sequence.source_sequence
            FROM article_source_mutation journal
            LEFT JOIN article_source_generation clock ON clock.family_id = 1
            LEFT JOIN article_source_sequence sequence ON sequence.article_id = journal.article_id
            WHERE journal.event_id = @EventId;
            """, connection, transaction);
        command.Parameters.AddWithValue("EventId", item.EventId);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        if (reader.GetInt32(0) != item.AggregateId || !string.Equals(reader.GetString(3), facts, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("article_source_event_facts_changed");
        }
        long generation = reader.GetInt64(1);
        long sequence = reader.GetInt64(2);
        if (generation <= 0 || sequence <= 0 || sequence > generation
            || reader.IsDBNull(4) || reader.GetInt32(4) != 1 || reader.IsDBNull(5) || reader.IsDBNull(6)
            || generation > reader.GetInt64(5) || sequence > reader.GetInt64(6)
            || reader.GetInt64(6) > reader.GetInt64(5))
        {
            throw new InvalidOperationException("article_source_journal_cursor_invalid");
        }
        return new ArticleSourceCursor(item.AggregateId, generation, sequence);
    }

    internal static async Task RequireCoordinatesAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        ArticleMutationOutboxEvent item, CancellationToken cancellationToken)
    {
        // Validate immutable ownership, not current pointers: old events are invalidations,
        // and the original adapter must reread the current source before indexing anything.
        await using NpgsqlCommand command = new("""
            SELECT EXISTS (
                SELECT 1 FROM article_revision revision
                WHERE revision.id = @RevisionId AND revision.article_id = @ArticleId
                  AND revision.revision_no = @RevisionNo
                  AND (@RightsId IS NULL OR EXISTS (
                      SELECT 1 FROM article_rights_snapshot rights
                      WHERE rights.id = @RightsId AND rights.article_id = revision.article_id
                        AND rights.article_revision_id = revision.id))
                  AND (@ResponsibilityId IS NULL OR EXISTS (
                      SELECT 1 FROM article_responsibility_snapshot responsibility
                      WHERE responsibility.id = @ResponsibilityId AND responsibility.article_id = @ArticleId
                        AND responsibility.article_revision_id = @RevisionId
                        AND responsibility.responsibility_version = @ResponsibilityVersion))
                  AND (@PublicationId IS NULL OR EXISTS (
                      SELECT 1 FROM article_publication publication
                      WHERE publication.id = @PublicationId AND publication.article_id = @ArticleId
                        AND publication.article_revision_id = @RevisionId AND publication.revision_no = @RevisionNo
                        AND publication.publication_no = @PublicationNo AND publication.rights_snapshot_id = @RightsId
                        AND publication.responsibility_snapshot_id IS NOT DISTINCT FROM @ResponsibilityId))
            );
            """, connection, transaction);
        command.Parameters.AddWithValue("ArticleId", item.AggregateId);
        command.Parameters.AddWithValue("RevisionId", item.ArticleRevisionId!.Value);
        command.Parameters.AddWithValue("RevisionNo", item.RevisionNo!.Value);
        command.Parameters.Add("RightsId", NpgsqlDbType.Bigint).Value = (object?)item.RightsSnapshotId ?? DBNull.Value;
        command.Parameters.Add("ResponsibilityId", NpgsqlDbType.Bigint).Value = (object?)item.ResponsibilitySnapshotId ?? DBNull.Value;
        command.Parameters.Add("ResponsibilityVersion", NpgsqlDbType.Integer).Value = (object?)item.ResponsibilityVersion ?? DBNull.Value;
        command.Parameters.Add("PublicationId", NpgsqlDbType.Bigint).Value = (object?)item.ArticlePublicationId ?? DBNull.Value;
        command.Parameters.Add("PublicationNo", NpgsqlDbType.Integer).Value = (object?)item.PublicationNo ?? DBNull.Value;
        if (!(bool)(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false))!)
        {
            throw new InvalidOperationException("article_source_event_ownership_invalid");
        }
    }

    internal static async Task<ArticleSourceCursor> AllocateAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        ArticleMutationOutboxEvent item, string facts, CancellationToken cancellationToken)
    {
        long? generation = null;
        await using (NpgsqlCommand clock = new(
            "SELECT family_id, source_generation FROM article_source_generation FOR UPDATE;", connection, transaction))
        await using (NpgsqlDataReader reader = await clock.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false))
        {
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                generation = ReadClock(reader);
                if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    throw new InvalidOperationException("article_source_family_invalid");
                }
            }
        }
        await using (NpgsqlCommand sequence = new(
            "SELECT source_sequence FROM article_source_sequence WHERE article_id = @ArticleId FOR UPDATE;", connection, transaction))
        {
            sequence.Parameters.AddWithValue("ArticleId", item.AggregateId);
            object? value = await sequence.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            if (value is long persisted && (persisted <= 0 || !generation.HasValue || persisted > generation.Value))
            {
                throw new InvalidOperationException("article_source_sequence_invalid");
            }
            _ = checked((value is long current ? current : 0) + 1);
        }
        _ = checked((generation ?? 0) + 1);
        await using NpgsqlCommand command = new("""
            WITH clock AS (
                INSERT INTO article_source_generation(family_id, source_generation) VALUES (1, 1)
                ON CONFLICT (family_id) DO UPDATE
                SET source_generation = article_source_generation.source_generation + 1
                RETURNING source_generation
            ), sequence AS (
                INSERT INTO article_source_sequence(article_id, source_sequence) VALUES (@ArticleId, 1)
                ON CONFLICT (article_id) DO UPDATE
                SET source_sequence = article_source_sequence.source_sequence + 1
                RETURNING source_sequence
            )
            INSERT INTO article_source_mutation(event_id, article_id, source_generation, source_sequence, event_facts)
            SELECT @EventId, @ArticleId, clock.source_generation, sequence.source_sequence, @Facts
            FROM clock CROSS JOIN sequence
            RETURNING article_id, source_generation, source_sequence;
            """, connection, transaction);
        command.Parameters.AddWithValue("ArticleId", item.AggregateId);
        command.Parameters.AddWithValue("EventId", item.EventId);
        command.Parameters.AddWithValue("Facts", facts);
        await using NpgsqlDataReader allocated = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await allocated.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new InvalidOperationException("article_source_allocation_missing");
        }
        return new ArticleSourceCursor(allocated.GetInt32(0), allocated.GetInt64(1), allocated.GetInt64(2));
    }

    private static long ReadClock(NpgsqlDataReader reader)
    {
        if (reader.GetInt32(0) != 1 || reader.GetInt64(1) <= 0)
        {
            throw new InvalidOperationException("article_source_clock_invalid");
        }
        return reader.GetInt64(1);
    }

    private static long? NullableInt64(NpgsqlDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : reader.GetInt64(ordinal);

    private static int? NullableInt32(NpgsqlDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
}
