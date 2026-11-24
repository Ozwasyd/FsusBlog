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

        await database.Exec("""
            INSERT INTO public.blog_user (id, name, generation, enabled)
            VALUES ('f4a1a998-7b96-4b9a-b578-bbb20157d941','Schema fixture',1,true)
            """);
        var valid = await ReadState(database);
        foreach (var (prepare, restore, expected) in scenarios)
        {
            await database.Exec(prepare);
            var before = await ReadState(database);
            await ExpectServerRejected(database.ConnectionString, expected, ct);
            Assert.Equal(before, await ReadState(database));
            await database.Exec(restore);
            Assert.Equal(valid, await ReadState(database));
        }

        await using var accepted = await ServerProcess.Start(database.ConnectionString, ct);
        await CheckStatusAsync(NoContent, accepted.Client.GetAsync("/health/ready", ct));
        Assert.Equal(valid, await ReadState(database));
    }

    [PostgresFact]
    public async Task CommentBatchSchemaAcceptsLegacyAbsenceAndRejectsPartialOrWrongPurposeStorage()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        await CurrentSchema.VerifyAsync(connection, ct, new(AdminCommentBatch: true));
        await ExpectVerifyError(connection, "batch schema presence", ct, new(AdminCommentBatch: false), StringComparison.OrdinalIgnoreCase);

        await database.Exec("ALTER TABLE public.admin_comment_batch_item RENAME TO incomplete_comment_batch_item");
        await ExpectVerifyError(connection, "batch storage is incomplete", ct, cmp: StringComparison.OrdinalIgnoreCase);
        await database.Exec("ALTER TABLE public.incomplete_comment_batch_item RENAME TO admin_comment_batch_item");

        await database.Exec("""
            ALTER TABLE public.admin_comment_batch_step_up
                DROP CONSTRAINT admin_comment_batch_step_up_action_check, ADD CHECK (action = 1)
            """);
        await ExpectVerifyError(connection, "admin_comment_batch_step_up c action action=6", ct);

        await database.Exec("DROP TABLE public.admin_comment_batch_item, public.admin_comment_batch, public.admin_comment_batch_step_up");
        await CurrentSchema.VerifyAsync(connection, ct, new(AdminCommentBatch: false));
        await CurrentSchema.VerifyAsync(connection, ct);
        await ExpectVerifyError(connection, "batch schema presence", ct, new(AdminCommentBatch: true), StringComparison.OrdinalIgnoreCase);
    }

    [PostgresFact]
    public async Task DocumentExportsRequireExactPrivateOutputConstraintsAndIndexesWhenInstalled()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        await CurrentSchema.VerifyAsync(connection, ct, new(DocumentExports: true));

        await database.Exec("ALTER INDEX public.author_document_export_pending RENAME TO wrong_document_export_pending");
        await ExpectVerifyError(connection, "document export index shape mismatch", ct);
        await database.Exec("ALTER INDEX public.wrong_document_export_pending RENAME TO author_document_export_pending");

        await database.Exec("ALTER TABLE public.author_document_export DROP CONSTRAINT author_document_export_output_check");
        await ExpectVerifyError(connection, "octet_length(output)<=4194304", ct);

        await database.Exec("DROP TABLE public.author_document_export");
        await CurrentSchema.VerifyAsync(connection, ct);
        await ExpectVerifyError(connection, "document export schema presence", ct, new(DocumentExports: true));
    }

    [PostgresFact]
    public async Task CommentAppealStepUpRequiresBoundedOptionsPairedWithKind()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(90));
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        var admin = await database.AdminAsync("appeal-step-up-schema", 5);

        var widest = new string('\u4e2d', 2730) + "ab";
        var overByOne = widest + "c";
        var multibyteOver = new string('\u4e2d', 2731);
        Assert.Equal(8192, await database.Scalar<int>("SELECT octet_length($1::text)", widest));
        Assert.Equal(8193, await database.Scalar<int>("SELECT octet_length($1::text)", overByOne));
        Assert.Equal(8193, await database.Scalar<int>("SELECT octet_length($1::text)", multibyteOver));
        Assert.True(multibyteOver.Length < 8192);

        foreach (var (kind, options) in new (short, string?)[] { (1, "x"), (1, widest), (2, null) })
        {
            await InsertAppealStepUp(database, admin, kind, options);
            await database.Exec("DELETE FROM public.comment_appeal_admin_step_up");
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
            var rejected = await Assert.ThrowsAsync<PostgresException>(() => InsertAppealStepUp(database, admin, kind, options));
            Assert.Equal((PostgresErrorCodes.CheckViolation, constraint), (rejected.SqlState, rejected.ConstraintName));
        }
        Assert.Equal(0L, await database.Scalar<long>("SELECT count(*) FROM public.comment_appeal_admin_step_up"));

        const string tbl = "ALTER TABLE public.comment_appeal_admin_step_up ";
        const string bounds = "comment_appeal_admin_step_up c options octet_length(options)>=1ANDoctet_length(options)<=8192";
        const string pair = "comment_appeal_admin_step_up c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL";
        const string restoreBounds = tbl + "ADD CONSTRAINT comment_appeal_admin_step_up_options_check CHECK (octet_length(options) BETWEEN 1 AND 8192)";
        const string restorePair = tbl + "ADD CONSTRAINT comment_appeal_admin_step_up_check CHECK ((kind = 1 AND options IS NOT NULL) OR (kind = 2 AND options IS NULL))";
        var drifts = new (string Prepare, string Restore, string Expected)[]
        {
            (tbl + "DROP CONSTRAINT comment_appeal_admin_step_up_options_check", restoreBounds, $"Missing [{bounds}]"),
            (tbl + "DROP CONSTRAINT comment_appeal_admin_step_up_options_check, ADD CONSTRAINT comment_appeal_admin_step_up_options_check CHECK (octet_length(options) BETWEEN 1 AND 16384)",
                tbl + "DROP CONSTRAINT comment_appeal_admin_step_up_options_check;" + restoreBounds, $"Missing [{bounds}]"),
            (tbl + "DROP CONSTRAINT comment_appeal_admin_step_up_check", restorePair, $"Missing [{pair}]"),
            (tbl + "DROP CONSTRAINT comment_appeal_admin_step_up_check, ADD CONSTRAINT comment_appeal_admin_step_up_kind_check CHECK (kind BETWEEN 1 AND 2)",
                tbl + "DROP CONSTRAINT comment_appeal_admin_step_up_kind_check;" + restorePair, "Unexpected [comment_appeal_admin_step_up c kind kind>=1ANDkind<=2]"),
            (tbl + "DROP CONSTRAINT comment_appeal_admin_step_up_check;" + restorePair + " NOT VALID",
                tbl + "VALIDATE CONSTRAINT comment_appeal_admin_step_up_check", $"Unexpected [{pair} not-validated]")
        };
        foreach (var (prepare, restore, expected) in drifts)
        {
            await database.Exec(prepare);
            var msg = await ExpectVerifyError(connection, "constraint shape mismatch", ct);
            Assert.Contains(expected, msg, StringComparison.Ordinal);
            await database.Exec(restore);
            await CurrentSchema.VerifyAsync(connection, ct);
        }

        await database.Exec(drifts[2].Prepare);
        var before = await ReadConstraints(database);
        await ExpectServerRejected(database.ConnectionString, "constraint shape mismatch", ct);
        Assert.Equal(before, await ReadConstraints(database));
        await database.Exec(drifts[2].Restore);
        await CurrentSchema.VerifyAsync(connection, ct);
    }

    private static async Task ExpectServerRejected(string dsn, string expected, CancellationToken ct)
    {
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(async () => { await using var _ = await ServerProcess.Start(dsn, ct); });
        Assert.Contains(expected, failure.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<string> ExpectVerifyError(NpgsqlConnection db, string expected, CancellationToken ct,
        SchemaAdmission options = default, StringComparison cmp = StringComparison.Ordinal)
    {
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct, options));
        Assert.Contains(expected, failure.Message, cmp);
        return failure.Message;
    }

    private static Task<int> InsertAppealStepUp(ScratchDatabase db, (Guid Id, string Token, byte[] Digest) admin, short kind, string? options) =>
        db.Exec("""
            INSERT INTO public.comment_appeal_admin_step_up(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
            VALUES ($1,$2,$3,1,5,$4,$5,clock_timestamp()+interval '1 minute',$6)
            """, RandomNumberGenerator.GetBytes(32), admin.Id, admin.Digest, RandomNumberGenerator.GetBytes(32),
            options is null ? DBNull.Value : options, kind);

    private static Task<string> ReadConstraints(ScratchDatabase db) => db.Scalar<string>("""
        SELECT coalesce(string_agg(conname || ':' || pg_get_constraintdef(oid) || ':' || convalidated, E'\n' ORDER BY conname), '')
        FROM pg_constraint WHERE conrelid = 'public.comment_appeal_admin_step_up'::regclass
        """);

    private static Task<string> ReadState(ScratchDatabase db) => db.Scalar<string>("""
        SELECT jsonb_build_object(
            'version', (SELECT version FROM public.v2_schema WHERE singleton),
            'tables', (SELECT jsonb_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public'),
            'columns', (SELECT jsonb_agg(jsonb_build_array(table_name,column_name,data_type) ORDER BY table_name,column_name)
                        FROM information_schema.columns WHERE table_schema='public'),
            'users', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.blog_user u),
            'events', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id), '[]') FROM public.blog_outbox e)
        )::text
        """);
}
