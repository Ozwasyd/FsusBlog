using System.Net;
using FsusBlogV2.Storage;
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

    [PostgresFact]
    public async Task CommentBatchSchemaAcceptsLegacyAbsenceAndRejectsPartialOrWrongPurposeStorage()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var ct = timeout.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        await CurrentSchema.VerifyAsync(connection, ct, requireAdminCommentBatch: true);

        await Execute(connection, "ALTER TABLE public.admin_comment_batch_item RENAME TO incomplete_comment_batch_item", ct);
        var partial = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(connection, ct));
        Assert.Contains("batch storage is incomplete", partial.Message, StringComparison.OrdinalIgnoreCase);
        await Execute(connection, "ALTER TABLE public.incomplete_comment_batch_item RENAME TO admin_comment_batch_item", ct);

        await Execute(connection, """
            ALTER TABLE public.admin_comment_batch_step_up
                DROP CONSTRAINT admin_comment_batch_step_up_action_check,
                ADD CHECK (action = 1)
            """, ct);
        var wrongPurpose = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(connection, ct));
        Assert.Contains("admin_comment_batch_step_up c action action=6", wrongPurpose.Message, StringComparison.Ordinal);

        await Execute(connection, "DROP TABLE public.admin_comment_batch_item, public.admin_comment_batch, public.admin_comment_batch_step_up", ct);
        await CurrentSchema.VerifyAsync(connection, ct);
        var missing = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CurrentSchema.VerifyAsync(connection, ct, requireAdminCommentBatch: true));
        Assert.Contains("batch schema presence", missing.Message, StringComparison.OrdinalIgnoreCase);
    }

    [PostgresFact]
    public async Task DocumentExportsRequireExactPrivateOutputConstraintsAndIndexesWhenInstalled()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        var ct = timeout.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        await CurrentSchema.VerifyAsync(connection, ct, requireDocumentExports: true);

        await Execute(connection, "ALTER INDEX public.author_document_export_pending RENAME TO wrong_document_export_pending", ct);
        var indexDrift = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(connection, ct));
        Assert.Contains("document export index shape mismatch", indexDrift.Message, StringComparison.Ordinal);
        await Execute(connection, "ALTER INDEX public.wrong_document_export_pending RENAME TO author_document_export_pending", ct);

        await Execute(connection, "ALTER TABLE public.author_document_export DROP CONSTRAINT author_document_export_output_check", ct);
        var constraintDrift = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(connection, ct));
        Assert.Contains("octet_length(output)<=4194304", constraintDrift.Message, StringComparison.Ordinal);

        await Execute(connection, "DROP TABLE public.author_document_export", ct);
        await CurrentSchema.VerifyAsync(connection, ct);
        var missing = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CurrentSchema.VerifyAsync(connection, ct, requireDocumentExports: true));
        Assert.Contains("document export schema presence", missing.Message, StringComparison.Ordinal);
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand(sql, db);
        await command.ExecuteNonQueryAsync(ct);
    }

    private static async Task<string> ReadState(NpgsqlConnection db, CancellationToken ct)
    {
        return (string)(await FixtureSql.ScalarAsync(db, null, ct, """
            SELECT jsonb_build_object(
                'version', (SELECT version FROM public.v2_schema WHERE singleton),
                'tables', (SELECT jsonb_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public'),
                'columns', (SELECT jsonb_agg(jsonb_build_array(table_name,column_name,data_type) ORDER BY table_name,column_name)
                            FROM information_schema.columns WHERE table_schema='public'),
                'users', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.blog_user u),
                'events', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id), '[]') FROM public.blog_outbox e)
            )::text
            """))!;
    }
}
