using Npgsql;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleListKeysetPaginationIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CompositeCursor_PreservesFilteredOrderAcrossConcurrentInsert()
    {
        string connectionString = await CreateFixtureAsync();
        IReadOnlyList<int> original = await ReadAllMatchingIdsAsync(connectionString);

        Page first = await ReadPageAsync(connectionString, cursor: null, limit: 5);
        await fixture.ExecuteAsync(connectionString, """
            INSERT INTO public_article_keyset_fixture(createtime, category_id, tag_ids, title)
            VALUES ('2026-07-21T00:00:00Z', 1, ARRAY[7], 'needle inserted after first page');
            """);

        var seen = new List<int>(original.Count);
        seen.AddRange(first.Ids);
        Page current = first;
        while (current.HasMore)
        {
            current = await ReadPageAsync(connectionString, current.Cursor, limit: 5);
            seen.AddRange(current.Ids);
        }

        Assert.Equal(original, seen);
        Assert.Equal(seen.Count, seen.Distinct().Count());
    }

    [Fact]
    public async Task CompositeCursor_ExplainUsesOrderedIndexWithoutSortOrOffset()
    {
        string connectionString = await CreateFixtureAsync();
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using (NpgsqlCommand disableSeqScan = connection.CreateCommand())
        {
            disableSeqScan.CommandText = "SET enable_seqscan = off;";
            await disableSeqScan.ExecuteNonQueryAsync();
        }

        await using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = """
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT id, createtime
            FROM public_article_keyset_fixture
            WHERE category_id = 1
              AND (createtime < @cursor_time OR (createtime = @cursor_time AND id < @cursor_id))
            ORDER BY createtime DESC, id DESC
            LIMIT 5;
            """;
        command.Parameters.AddWithValue("cursor_time", new DateTime(2026, 7, 20, 0, 0, 0, DateTimeKind.Utc));
        command.Parameters.AddWithValue("cursor_id", int.MaxValue);
        string plan = (string)(await command.ExecuteScalarAsync())!;

        Assert.True(
            plan.Contains("Index Scan", StringComparison.Ordinal)
            || plan.Contains("Index Only Scan", StringComparison.Ordinal),
            plan);
        Assert.DoesNotContain("\"Node Type\": \"Sort\"", plan, StringComparison.Ordinal);
        Assert.DoesNotContain("OFFSET", plan, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Shared Hit Blocks", plan, StringComparison.Ordinal);
    }

    private async Task<string> CreateFixtureAsync()
    {
        string databaseName = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(databaseName);
        await fixture.ExecuteAsync(connectionString, """
            CREATE TABLE public_article_keyset_fixture (
                id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                createtime timestamptz NOT NULL,
                category_id integer NOT NULL,
                tag_ids integer[] NOT NULL,
                title text NOT NULL
            );
            CREATE INDEX idx_public_article_keyset_fixture
                ON public_article_keyset_fixture(category_id, createtime DESC, id DESC);
            INSERT INTO public_article_keyset_fixture(createtime, category_id, tag_ids, title)
            SELECT
                '2026-07-20T00:00:00Z'::timestamptz - (((value - 1) / 3) * interval '1 minute'),
                CASE WHEN value % 4 = 0 THEN 2 ELSE 1 END,
                CASE WHEN value % 5 = 0 THEN ARRAY[8] ELSE ARRAY[7] END,
                CASE WHEN value % 6 = 0 THEN 'other' ELSE 'needle article ' || value::text END
            FROM generate_series(1, 80) AS value;
            ANALYZE public_article_keyset_fixture;
            """);
        return connectionString;
    }

    private static async Task<IReadOnlyList<int>> ReadAllMatchingIdsAsync(string connectionString)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT id
            FROM public_article_keyset_fixture
            WHERE category_id = 1 AND 7 = ANY(tag_ids) AND title LIKE '%needle%'
            ORDER BY createtime DESC, id DESC;
            """;
        var ids = new List<int>();
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            ids.Add(reader.GetInt32(0));
        }
        return ids;
    }

    private static async Task<Page> ReadPageAsync(string connectionString, Position? cursor, int limit)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, createtime
            FROM public_article_keyset_fixture
            WHERE category_id = 1
              AND 7 = ANY(tag_ids)
              AND title LIKE '%needle%'
              AND (@cursor_time IS NULL OR createtime < @cursor_time OR (createtime = @cursor_time AND id < @cursor_id))
            ORDER BY createtime DESC, id DESC
            LIMIT @limit;
            """;
        command.Parameters.AddWithValue(
            "cursor_time",
            NpgsqlTypes.NpgsqlDbType.TimestampTz,
            cursor.HasValue ? cursor.Value.CreateTimeUtc : DBNull.Value);
        command.Parameters.AddWithValue("cursor_id", cursor?.Id ?? int.MaxValue);
        command.Parameters.AddWithValue("limit", limit + 1);
        var rows = new List<Position>(limit + 1);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            rows.Add(new Position(reader.GetDateTime(1).ToUniversalTime(), reader.GetInt32(0)));
        }

        bool hasMore = rows.Count > limit;
        if (hasMore)
        {
            rows.RemoveAt(rows.Count - 1);
        }
        return new Page(rows.Select(static row => row.Id).ToArray(), rows.Count == 0 ? null : rows[^1], hasMore);
    }

    private readonly record struct Position(DateTime CreateTimeUtc, int Id);
    private sealed record Page(IReadOnlyList<int> Ids, Position? Cursor, bool HasMore);
}
