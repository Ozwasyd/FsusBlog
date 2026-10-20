using Npgsql;

namespace FsusBlog.Server.Services.Articles;

internal static partial class ArticleSourceGenerationPersistence
{
    internal static async Task<ArticleSourceObservationCursor?> ReadObservationAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, string kind, string key, int? articleId, string facts, CancellationToken cancellationToken)
    {
        await using NpgsqlCommand command = new("""
            SELECT observation.article_id, observation.source_generation, observation.source_sequence,
                   observation.origin_facts, clock.family_id, clock.source_generation, sequence.source_sequence
            FROM article_source_observation observation
            LEFT JOIN article_source_generation clock ON clock.family_id = 1
            LEFT JOIN article_source_sequence sequence ON sequence.article_id = observation.article_id
            WHERE observation.origin_kind = @Kind AND observation.origin_key = @Key;
            """, connection, transaction);
        command.Parameters.AddWithValue("Kind", kind);
        command.Parameters.AddWithValue("Key", key);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            return null;
        int? storedArticle = reader.IsDBNull(0) ? null : reader.GetInt32(0);
        long generation = reader.GetInt64(1);
        long? sequence = reader.IsDBNull(2) ? null : reader.GetInt64(2);
        if (storedArticle != articleId || reader.GetString(3) != facts)
            throw new InvalidOperationException("article_source_observation_facts_changed");
        if (generation <= 0 || reader.IsDBNull(4) || reader.GetInt32(4) != 1
            || reader.IsDBNull(5) || generation > reader.GetInt64(5)
            || (articleId.HasValue
                ? sequence is not > 0 || sequence > generation || reader.IsDBNull(6) || sequence > reader.GetInt64(6)
                : sequence.HasValue))
            throw new InvalidOperationException("article_source_journal_cursor_invalid");
        return new(generation, articleId, sequence);
    }

    internal static Task<ArticleSourceObservationCursor> AllocateObservationAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, string kind, string key, int? articleId, string facts, CancellationToken cancellationToken)
        => AllocateCoreAsync(connection, transaction, kind, key, articleId, facts, cancellationToken);

    // The original article allocator and every admitted original observation share this
    // sole clock/sequence allocation. The common observation registry makes generation
    // and optional per-article sequence uniqueness apply across ALL admitted origins.
    private static async Task<ArticleSourceObservationCursor> AllocateCoreAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, string kind, string key, int? articleId, string facts, CancellationToken cancellationToken)
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
                    throw new InvalidOperationException("article_source_family_invalid");
            }
        }
        if (!generation.HasValue)
        {
            await using NpgsqlCommand orphan = new("""
                SELECT EXISTS (SELECT 1 FROM article_source_sequence)
                    OR EXISTS (SELECT 1 FROM article_source_mutation)
                    OR EXISTS (SELECT 1 FROM article_source_observation);
                """, connection, transaction);
            if ((bool)(await orphan.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false))!)
                throw new InvalidOperationException("article_source_clock_missing_for_persisted_state");
        }
        if (articleId.HasValue)
        {
            await using NpgsqlCommand sequence = new(
                "SELECT source_sequence FROM article_source_sequence WHERE article_id = @ArticleId FOR UPDATE;", connection, transaction);
            sequence.Parameters.AddWithValue("ArticleId", articleId.Value);
            object? value = await sequence.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            if (value is long persisted && (persisted <= 0 || !generation.HasValue || persisted > generation.Value))
                throw new InvalidOperationException("article_source_sequence_invalid");
            if (value is null)
            {
                await using NpgsqlCommand orphan = new("""
                    SELECT EXISTS (SELECT 1 FROM article_source_mutation WHERE article_id = @ArticleId)
                        OR EXISTS (SELECT 1 FROM article_source_observation WHERE article_id = @ArticleId);
                    """, connection, transaction);
                orphan.Parameters.AddWithValue("ArticleId", articleId.Value);
                if ((bool)(await orphan.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false))!)
                    throw new InvalidOperationException("article_source_sequence_missing_for_persisted_state");
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
                INSERT INTO article_source_sequence(article_id, source_sequence)
                SELECT @ArticleId, 1 WHERE @ArticleId IS NOT NULL
                ON CONFLICT (article_id) DO UPDATE
                SET source_sequence = article_source_sequence.source_sequence + 1
                RETURNING source_sequence
            ), observation AS (
                INSERT INTO article_source_observation(origin_kind, origin_key, article_id,
                    source_generation, source_sequence, origin_facts)
                SELECT @Kind, @Key, @ArticleId, clock.source_generation, sequence.source_sequence, @Facts
                FROM clock LEFT JOIN sequence ON true
                RETURNING article_id, source_generation, source_sequence
            ), article_event AS (
                INSERT INTO article_source_mutation(event_id, article_id, source_generation, source_sequence, event_facts)
                SELECT @Key, article_id, source_generation, source_sequence, @Facts
                FROM observation WHERE @Kind = 'article'
            )
            SELECT article_id, source_generation, source_sequence FROM observation;
            """, connection, transaction);
        command.Parameters.AddWithValue("ArticleId", NpgsqlTypes.NpgsqlDbType.Integer, (object?)articleId ?? DBNull.Value);
        command.Parameters.AddWithValue("Kind", kind);
        command.Parameters.AddWithValue("Key", key);
        command.Parameters.AddWithValue("Facts", facts);
        await using NpgsqlDataReader allocated = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await allocated.ReadAsync(cancellationToken).ConfigureAwait(false))
            throw new InvalidOperationException("article_source_allocation_missing");
        return new(allocated.GetInt64(1), allocated.IsDBNull(0) ? null : allocated.GetInt32(0),
            allocated.IsDBNull(2) ? null : allocated.GetInt64(2));
    }
}
