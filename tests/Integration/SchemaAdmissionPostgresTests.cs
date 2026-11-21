using System.Net;
using System.Security.Cryptography;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SchemaAdmissionPostgresTests
{
    [PostgresFact]
    public async Task RealServerDoesNotRepairUnsupportedPostgresStateAtStartup()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
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
            INSERT INTO public.blog_user (id, name, generation, enabled)
            VALUES ('f4a1a998-7b96-4b9a-b578-bbb20157d941','Schema fixture',1,true)
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
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        await CurrentSchema.VerifyAsync(connection, ct, new(AdminCommentBatch: true));
        var forbidden = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CurrentSchema.VerifyAsync(connection, ct, new(AdminCommentBatch: false)));
        Assert.Contains("batch schema presence", forbidden.Message, StringComparison.OrdinalIgnoreCase);

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
        await CurrentSchema.VerifyAsync(connection, ct, new(AdminCommentBatch: false));
        await CurrentSchema.VerifyAsync(connection, ct);
        var missing = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CurrentSchema.VerifyAsync(connection, ct, new(AdminCommentBatch: true)));
        Assert.Contains("batch schema presence", missing.Message, StringComparison.OrdinalIgnoreCase);
    }

    [PostgresFact]
    public async Task DocumentExportsRequireExactPrivateOutputConstraintsAndIndexesWhenInstalled()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        await CurrentSchema.VerifyAsync(connection, ct, new(DocumentExports: true));

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
            CurrentSchema.VerifyAsync(connection, ct, new(DocumentExports: true)));
        Assert.Contains("document export schema presence", missing.Message, StringComparison.Ordinal);
    }

    [PostgresFact]
    public async Task CommentAppealStepUpRequiresBoundedOptionsPairedWithKind()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(90));
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        var admin = await FixtureSql.AdminAsync(connection, ct, "appeal-step-up-schema", 5,
            RandomNumberGenerator.GetBytes(16), RandomNumberGenerator.GetBytes(32));

        var widest = new string('\u4e2d', 2730) + "ab";
        var overByOne = widest + "c";
        var multibyteOver = new string('\u4e2d', 2731);
        Assert.Equal(8192, await OctetLength(connection, widest, ct));
        Assert.Equal(8193, await OctetLength(connection, overByOne, ct));
        Assert.Equal(8193, await OctetLength(connection, multibyteOver, ct));
        Assert.True(multibyteOver.Length < 8192);

        foreach (var (kind, options) in new (short, string?)[] { (1, "x"), (1, widest), (2, null) })
        {
            await InsertAppealStepUp(connection, admin, kind, options, ct);
            await Execute(connection, "DELETE FROM public.comment_appeal_admin_step_up", ct);
        }

        foreach (var (kind, options, constraint) in new (short, string?, string)[]
                 {
                     (1, "", "comment_appeal_admin_step_up_options_check"),
                     (1, overByOne, "comment_appeal_admin_step_up_options_check"),
                     (1, multibyteOver, "comment_appeal_admin_step_up_options_check"),
                     (1, null, "comment_appeal_admin_step_up_check"),
                     (2, "x", "comment_appeal_admin_step_up_check"),
                     (3, null, "comment_appeal_admin_step_up_check")
                 })
        {
            var rejected = await Assert.ThrowsAsync<PostgresException>(() => InsertAppealStepUp(connection, admin, kind, options, ct));
            Assert.Equal(PostgresErrorCodes.CheckViolation, rejected.SqlState);
            Assert.Equal(constraint, rejected.ConstraintName);
        }
        Assert.Equal(0L, await FixtureSql.ScalarAsync(connection, null, ct, "SELECT count(*) FROM public.comment_appeal_admin_step_up"));

        const string bounds = "comment_appeal_admin_step_up c options octet_length(options)>=1ANDoctet_length(options)<=8192";
        const string pair = "comment_appeal_admin_step_up c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL";
        const string restoreBounds = """
            ALTER TABLE public.comment_appeal_admin_step_up
                ADD CONSTRAINT comment_appeal_admin_step_up_options_check CHECK (octet_length(options) BETWEEN 1 AND 8192)
            """;
        const string restorePair = """
            ALTER TABLE public.comment_appeal_admin_step_up
                ADD CONSTRAINT comment_appeal_admin_step_up_check
                CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))
            """;
        var drifts = new (string Prepare, string Restore, string Expected)[]
        {
            ("ALTER TABLE public.comment_appeal_admin_step_up DROP CONSTRAINT comment_appeal_admin_step_up_options_check",
                restoreBounds, $"Missing [{bounds}]"),
            ("""
                ALTER TABLE public.comment_appeal_admin_step_up
                    DROP CONSTRAINT comment_appeal_admin_step_up_options_check,
                    ADD CONSTRAINT comment_appeal_admin_step_up_options_check CHECK (octet_length(options) BETWEEN 1 AND 16384)
                """,
                "ALTER TABLE public.comment_appeal_admin_step_up DROP CONSTRAINT comment_appeal_admin_step_up_options_check;" + restoreBounds,
                $"Missing [{bounds}]"),
            ("ALTER TABLE public.comment_appeal_admin_step_up DROP CONSTRAINT comment_appeal_admin_step_up_check",
                restorePair, $"Missing [{pair}]"),
            ("""
                ALTER TABLE public.comment_appeal_admin_step_up
                    DROP CONSTRAINT comment_appeal_admin_step_up_check,
                    ADD CONSTRAINT comment_appeal_admin_step_up_kind_check CHECK (kind BETWEEN 1 AND 2)
                """,
                "ALTER TABLE public.comment_appeal_admin_step_up DROP CONSTRAINT comment_appeal_admin_step_up_kind_check;" + restorePair,
                "Unexpected [comment_appeal_admin_step_up c kind kind>=1ANDkind<=2]"),
            ("ALTER TABLE public.comment_appeal_admin_step_up DROP CONSTRAINT comment_appeal_admin_step_up_check;" + restorePair + " NOT VALID",
                "ALTER TABLE public.comment_appeal_admin_step_up VALIDATE CONSTRAINT comment_appeal_admin_step_up_check",
                $"Unexpected [{pair} not-validated]")
        };
        foreach (var drift in drifts)
        {
            await Execute(connection, drift.Prepare, ct);
            var failure = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(connection, ct));
            Assert.Contains("constraint shape mismatch", failure.Message, StringComparison.Ordinal);
            Assert.Contains(drift.Expected, failure.Message, StringComparison.Ordinal);
            await Execute(connection, drift.Restore, ct);
            await CurrentSchema.VerifyAsync(connection, ct);
        }

        await Execute(connection, drifts[2].Prepare, ct);
        var before = await ReadConstraints(connection, ct);
        var startup = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var rejected = await ServerProcess.Start(database.ConnectionString, ct);
        });
        Assert.Contains("constraint shape mismatch", startup.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(before, await ReadConstraints(connection, ct));
        await Execute(connection, drifts[2].Restore, ct);
        await CurrentSchema.VerifyAsync(connection, ct);
    }

    private static Task<int> InsertAppealStepUp(NpgsqlConnection db, (Guid Id, string Token, byte[] Digest) admin, short kind,
        string? options, CancellationToken ct) => FixtureSql.ExecuteAsync(db, null, ct, """
            INSERT INTO public.comment_appeal_admin_step_up(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
            VALUES ($1,$2,$3,1,5,$4,$5,clock_timestamp()+interval '1 minute',$6)
            """, RandomNumberGenerator.GetBytes(32), admin.Id, admin.Digest, RandomNumberGenerator.GetBytes(32),
            options is null ? DBNull.Value : options, kind);

    private static async Task<int> OctetLength(NpgsqlConnection db, string value, CancellationToken ct) =>
        (int)(await FixtureSql.ScalarAsync(db, null, ct, "SELECT octet_length($1::text)", value))!;

    private static async Task<string> ReadConstraints(NpgsqlConnection db, CancellationToken ct) =>
        (string)(await FixtureSql.ScalarAsync(db, null, ct, """
            SELECT coalesce(string_agg(conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated, E'\n' ORDER BY conname), '')
            FROM pg_constraint WHERE conrelid = 'public.comment_appeal_admin_step_up'::regclass
            """))!;

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
