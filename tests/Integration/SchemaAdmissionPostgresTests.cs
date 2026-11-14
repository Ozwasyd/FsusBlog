using System.Net;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SchemaAdmissionPostgresTests
{
    [PostgresFact]
    public async Task RealServerDoesNotRepairUnsupportedPostgresStateAtStartup()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var ct = timeout.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var scenarios = new[]
        {
            (Prepare: "UPDATE public.v2_schema SET version=99",
                Restore: "UPDATE public.v2_schema SET version=1", Expected: "schema marker at version 1"),
            (Prepare: "ALTER TABLE public.article ADD COLUMN unexpected_legacy_value text",
                Restore: "ALTER TABLE public.article DROP COLUMN unexpected_legacy_value", Expected: "relation/column shape mismatch"),
            (Prepare: "ALTER TABLE public.article_revision RENAME TO old_article_revision",
                Restore: "ALTER TABLE public.old_article_revision RENAME TO article_revision", Expected: "relation/column shape mismatch")
        };

        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        await Execute(connection, """
            INSERT INTO public.blog_user (id, name, generation, enabled, can_author)
            VALUES ('f4a1a998-7b96-4b9a-b578-bbb20157d941','Schema fixture',1,true,true)
            """, ct);
        var valid = await ReadState(connection, ct);
        foreach (var scenario in scenarios)
        {
            await Execute(connection, scenario.Prepare, ct);
            var before = await ReadState(connection, ct);
            var failure = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            {
                await using var rejected = await ServerProcess.Start(database.ConnectionString, ct);
            });
            Assert.Contains(scenario.Expected, failure.Message, StringComparison.OrdinalIgnoreCase);
            Assert.Equal(before, await ReadState(connection, ct));
            await Execute(connection, scenario.Restore, ct);
            Assert.Equal(valid, await ReadState(connection, ct));
        }

        await using var accepted = await ServerProcess.Start(database.ConnectionString, ct);
        using var ready = await accepted.Client.GetAsync("/health/ready", ct);
        Assert.Equal(HttpStatusCode.NoContent, ready.StatusCode);
        Assert.Equal(valid, await ReadState(connection, ct));
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand(sql, db);
        await command.ExecuteNonQueryAsync(ct);
    }

    private static async Task<string> ReadState(NpgsqlConnection db, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT jsonb_build_object(
                'version', (SELECT version FROM public.v2_schema WHERE singleton),
                'tables', (SELECT jsonb_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public'),
                'columns', (SELECT jsonb_agg(jsonb_build_array(table_name,column_name,data_type) ORDER BY table_name,column_name)
                            FROM information_schema.columns WHERE table_schema='public'),
                'users', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.blog_user u),
                'events', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id), '[]') FROM public.blog_outbox e)
            )::text
            """, db);
        return (string)(await command.ExecuteScalarAsync(ct))!;
    }
}
