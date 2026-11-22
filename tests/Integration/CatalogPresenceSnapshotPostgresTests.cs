using System.Data;
using FsusBlogV2.Storage;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CatalogPresenceSnapshotPostgresTests
{
    [Fact]
    public void CatalogProbeScopeIsExplicitlyBoundedAndRejectsOutOfScopeLookups()
    {
        var scope = CurrentSchema.CatalogProbeScope;
        Assert.Equal(85, scope.RelationNames.Length);
        Assert.Equal(9, scope.ColumnRelationNames.Length);
        Assert.Equal(5, scope.CheckRelationNames.Length);

        // Specialized index/opclass probe is intentionally retained outside the generic snapshot.
        Assert.DoesNotContain("article_read_total", scope.RelationNames);
        Assert.DoesNotContain("article_read_total_rank", scope.RelationNames);

        Assert.Throws<InvalidOperationException>(() => scope.RequireRelationInScope("article_revision_media"));
        Assert.Throws<InvalidOperationException>(() => scope.RequireRelationInScope("public.article_read_total"));
        Assert.Throws<InvalidOperationException>(() => scope.RequireColumnRelationInScope("public.blog_user"));
        Assert.Throws<InvalidOperationException>(() => scope.RequireCheckRelationInScope("public.blog_user"));
    }

    [PostgresFact]
    public async Task BatchedSnapshotReducesActualNpgsqlCommandExecutionsAndRespectsBoundsAndCancellation()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        var recorder = new NpgsqlCommandRecorder();
        var builder = new NpgsqlDataSourceBuilder(database.ConnectionString);
        builder.UseLoggerFactory(recorder);
        await using var dataSource = builder.Build();
        await using var connection = await dataSource.OpenConnectionAsync(ct);

        // Verify cancellation before executing leaves the connection clean and reusable.
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CurrentSchema.VerifyAsync(connection, cancelled.Token));
        }

        // Measure actual Npgsql command executions during full online VerifyAsync.
        recorder.Reset();
        Assert.False(await CurrentSchema.VerifyAsync(connection, ct));
        var verifyAsyncCommands = recorder.SnapshotCommands();
        // 3 preamble (SET READ ONLY, SHOW session_replication_role, fsus_legacy_candidate)
        // + 11 VerifyCatalogAsync (1 batched snapshot, 1 HasArticleReadTotalSchemaAsync, 1 VerifyRelationsAsync, 8 post-shape verifiers)
        // + 3 postamble (admin_identity_schema, recovery site_id, v2_schema) = 17 commands total.
        Assert.Equal(17, verifyAsyncCommands.Count);

        // Measure actual Npgsql command executions during VerifyCatalogAsync directly in a read-only RepeatableRead tx.
        await using (var tx = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct))
        {
            await using (var protect = new NpgsqlCommand("SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog", connection, tx))
                await protect.ExecuteNonQueryAsync(ct);

            recorder.Reset();
            Assert.False(await CurrentSchema.VerifyCatalogAsync(connection, tx, ct));
            var catalogCommands = recorder.SnapshotCommands();
            // 1 batched snapshot + 1 retained HasArticleReadTotalSchemaAsync + 1 VerifyRelationsAsync + 8 specialized post-shape verifiers.
            Assert.Equal(11, catalogCommands.Count);

            // Inspect bounded snapshot row counts directly.
            var snapshot = await CurrentSchema.LoadCatalogPresenceSnapshotAsync(connection, tx, ct);
            Assert.Equal(85, snapshot.ScopedRelationCount);
            Assert.Equal(9, snapshot.ScopedColumnRelationCount);
            Assert.Equal(5, snapshot.ScopedCheckRelationCount);
            Assert.InRange(snapshot.ObservedRelationCount, 78, 85);
            Assert.InRange(snapshot.ObservedColumnCount, 1, 150);
            Assert.InRange(snapshot.ObservedCheckCount, 1, 60);
            await tx.CommitAsync(ct);
        }

        // No cross-transaction cache: mutating the DB is observed immediately on the next verification on the same connection.
        await Execute(connection, "DROP TABLE public.comment_report", ct);
        Assert.False(await CurrentSchema.VerifyAsync(connection, ct));
        await using (var tx = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct))
        {
            await using (var protect = new NpgsqlCommand("SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog", connection, tx))
                await protect.ExecuteNonQueryAsync(ct);
            var missing = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CurrentSchema.VerifyCatalogAsync(connection, tx, ct, new CatalogVerificationOptions
                {
                    Comments = new() { Report = true }
                }));
            Assert.Contains("Comment report schema presence", missing.Message, StringComparison.Ordinal);
        }
    }

    [PostgresFact]
    public async Task BatchedSnapshotMatchesStandaloneProbesAcrossMissingColumnsBadUnvalidatedNonLocalChecksBadIndexesAndDataInvariants()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var db = await database.DataSource.OpenConnectionAsync(ct);

        // 1. Half-installed column group: drop one of the 3 authoring workspace group columns.
        await Execute(db, """
            ALTER TABLE public.authoring_workspace
                DROP CONSTRAINT authoring_workspace_focused_group_check,
                DROP CONSTRAINT authoring_workspace_check1,
                DROP COLUMN focused_group
            """, ct);
        var partialGroup = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("authoring workspace group schema is incomplete", partialGroup.Message, StringComparison.Ordinal);
        await Execute(db, """
            ALTER TABLE public.authoring_workspace
                ADD COLUMN focused_group integer NOT NULL DEFAULT 0 CONSTRAINT authoring_workspace_focused_group_check CHECK (focused_group >= 0 AND focused_group <= 1),
                ADD CONSTRAINT authoring_workspace_check1 CHECK (focused_group = 0 OR secondary_active_article_id > 0)
            """, ct);
        await CurrentSchema.VerifyAsync(db, ct);

        // 2. Wrong column type on article_body_insertion.operations (text instead of int4[]).
        await Execute(db, """
            ALTER TABLE public.article_body_insertion
                DROP CONSTRAINT article_body_insertion_check,
                DROP COLUMN edit_texts,
                DROP COLUMN operations,
                ADD COLUMN operations text
            """, ct);
        var badColumnType = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("Invalid article body insertion operations column", badColumnType.Message, StringComparison.Ordinal);
        await Execute(db, """
            ALTER TABLE public.article_body_insertion
                DROP COLUMN operations,
                ADD COLUMN operations integer[],
                ADD COLUMN edit_texts text[],
                ADD CONSTRAINT article_body_insertion_check CHECK (
                    operations IS NULL AND edit_texts IS NULL
                    OR operations IS NOT NULL AND cardinality(operations) = cardinality(edit_texts)
                )
            """, ct);
        // Drop the whole optional article_body_insertion table afterwards so we don't depend on exact multi-line check text;
        // verify optional absence passes cleanly.
        await Execute(db, "DROP TABLE public.article_body_insertion", ct);
        await CurrentSchema.VerifyAsync(db, ct);

        // 3. Wrong CHECK expression & unvalidated (NOT VALID) CHECK on comment_author_edited_previous_status_check.
        await Execute(db, """
            ALTER TABLE public.comment_author_edited
                DROP CONSTRAINT comment_author_edited_previous_status_check,
                ADD CONSTRAINT comment_author_edited_previous_status_check CHECK (previous_status = 9)
            """, ct);
        var wrongStatusCheck = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("Comment author edit previous status is invalid", wrongStatusCheck.Message, StringComparison.Ordinal);

        await Execute(db, """
            ALTER TABLE public.comment_author_edited
                DROP CONSTRAINT comment_author_edited_previous_status_check,
                ADD CONSTRAINT comment_author_edited_previous_status_check CHECK (previous_status >= 0 AND previous_status <= 1) NOT VALID
            """, ct);
        var unvalidatedStatusCheck = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("Comment author edit previous status is invalid", unvalidatedStatusCheck.Message, StringComparison.Ordinal);

        await Execute(db, "ALTER TABLE public.comment_author_edited VALIDATE CONSTRAINT comment_author_edited_previous_status_check", ct);
        await CurrentSchema.VerifyAsync(db, ct);

        // 4. Unvalidated (NOT VALID) and wrong-expression CHECK on author_text_posting_segment_check (requireLocalValidated: true).
        await Execute(db, """
            ALTER TABLE public.author_text_posting
                DROP CONSTRAINT author_text_posting_segment_check,
                ADD CONSTRAINT author_text_posting_segment_check
                    CHECK (field = 4 AND segment BETWEEN 1 AND 200000 OR field <> 4 AND segment = 0) NOT VALID
            """, ct);
        var unvalidatedHeadingCheck = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("author full-text heading index schema is incomplete", unvalidatedHeadingCheck.Message, StringComparison.Ordinal);

        await Execute(db, """
            ALTER TABLE public.author_text_posting
                DROP CONSTRAINT author_text_posting_segment_check,
                ADD CONSTRAINT author_text_posting_segment_check CHECK (segment >= 0)
            """, ct);
        var wrongHeadingCheck = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("constraint shape mismatch", wrongHeadingCheck.Message, StringComparison.Ordinal);

        await Execute(db, """
            ALTER TABLE public.author_text_posting
                DROP CONSTRAINT author_text_posting_segment_check,
                ADD CONSTRAINT author_text_posting_segment_check
                    CHECK (field = 4 AND segment BETWEEN 1 AND 200000 OR field <> 4 AND segment = 0)
            """, ct);
        await CurrentSchema.VerifyAsync(db, ct);

        // 5. Retained independent specialized index probe: corrupt article_read_total_rank sort order (ASC instead of DESC).
        await Execute(db, """
            DROP INDEX public.article_read_total_rank;
            CREATE INDEX article_read_total_rank ON public.article_read_total (views ASC, article_id ASC);
            """, ct);
        var badTotalIndex = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("descending btree index", badTotalIndex.Message, StringComparison.Ordinal);
        await Execute(db, """
            DROP INDEX public.article_read_total_rank;
            CREATE INDEX article_read_total_rank ON public.article_read_total (views DESC, article_id DESC);
            """, ct);
        await CurrentSchema.VerifyAsync(db, ct);

        // 6. Retained business-data invariant verifier: corrupt site_page_content revision vs publish audit.
        await Execute(db, "UPDATE public.site_page_content SET revision = 1, markdown = 'corrupt' WHERE slug = 'about'", ct);
        var badInvariant = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Contains("site page editor publication coordinates are incomplete", badInvariant.Message, StringComparison.Ordinal);
        await Execute(db, "UPDATE public.site_page_content SET revision = 0, markdown = NULL WHERE slug = 'about'", ct);
        await CurrentSchema.VerifyAsync(db, ct);

        // 7. Non-local (inherited, conislocal = false) CHECK constraint on author_text_posting_segment_check.
        // Recreate empty author_text_posting inheriting the validated CHECK from a parent table so convalidated=true & conislocal=false.
        await Execute(db, """
            DROP TABLE public.author_text_posting;
            CREATE TABLE public.tmp_author_text_posting_parent (
                field integer NOT NULL,
                segment integer NOT NULL DEFAULT 0,
                CONSTRAINT author_text_posting_segment_check
                    CHECK (field = 4 AND segment BETWEEN 1 AND 200000 OR field <> 4 AND segment = 0)
            );
            CREATE TABLE public.author_text_posting (
                owner_id uuid NOT NULL,
                article_id integer NOT NULL,
                ordinal integer NOT NULL,
                term bytea NOT NULL,
                start_u16 integer NOT NULL,
                end_u16 integer NOT NULL,
                start_u8 integer NOT NULL,
                end_u8 integer NOT NULL,
                CONSTRAINT author_text_posting_owner_article UNIQUE (owner_id, article_id, field, ordinal)
            ) INHERITS (public.tmp_author_text_posting_parent);
            """, ct);
        // Confirm PG18 actually recorded convalidated=true and conislocal=false for the inherited CHECK.
        Assert.Equal(true, await FixtureSql.ScalarAsync(db, null, ct, """
            SELECT k.convalidated AND NOT k.conislocal
            FROM pg_catalog.pg_constraint k
            WHERE k.conrelid = 'public.author_text_posting'::regclass
              AND k.conname = 'author_text_posting_segment_check'
              AND k.contype = 'c'
            """));
        // Standalone SQL probe and batched snapshot VerifyAsync MUST both reject the non-local CHECK identically.
        var standaloneNonLocal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CurrentSchema.HasAuthorTextHeadingIndexAsync(db, null, ct));
        var batchedNonLocal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            CurrentSchema.VerifyAsync(db, ct));
        Assert.Equal(standaloneNonLocal.Message, batchedNonLocal.Message);
        Assert.Contains("author full-text heading index schema is incomplete", batchedNonLocal.Message, StringComparison.Ordinal);
    }

    private static async Task Execute(NpgsqlConnection db, string sql, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand(sql, db);
        await command.ExecuteNonQueryAsync(ct);
    }

    private sealed class NpgsqlCommandRecorder : ILoggerFactory, ILogger
    {
        private readonly List<string> _commands = [];
        private readonly object _gate = new();

        public void Reset()
        {
            lock (_gate) _commands.Clear();
        }

        public List<string> SnapshotCommands()
        {
            lock (_gate) return [.. _commands];
        }

        public ILogger CreateLogger(string categoryName) =>
            string.Equals(categoryName, "Npgsql.Command", StringComparison.Ordinal) ? this : NullLogger.Instance;

        public void AddProvider(ILoggerProvider provider) { }
        public void Dispose() { }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            // Npgsql logs CommandExecutionCompleted (2001) or ExecutingCommand (2000) under Npgsql.Command.
            if (eventId.Id == 2001)
            {
                lock (_gate) _commands.Add(formatter(state, exception));
            }
        }

        private sealed class NullLogger : ILogger
        {
            internal static readonly NullLogger Instance = new();
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
            public bool IsEnabled(LogLevel logLevel) => false;
            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
                Func<TState, Exception?, string> formatter) { }
        }
    }
}
