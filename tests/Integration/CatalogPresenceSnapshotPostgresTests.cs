using System.Data;
using Microsoft.Extensions.Logging;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CatalogPresenceSnapshotPostgresTests
{
    [Fact]
    public void CatalogProbeScopeIsExplicitlyBoundedAndRejectsOutOfScopeLookups()
    {
        var scope = CurrentSchema.CatalogProbeScope;
        Assert.Equal((85, 9, 5), (scope.RelationNames.Length, scope.ColumnRelationNames.Length, scope.CheckRelationNames.Length));
        Assert.DoesNotContain("article_read_total", scope.RelationNames);
        Assert.DoesNotContain("article_read_total_rank", scope.RelationNames);
        foreach (Action invalid in new Action[]
        {
            () => scope.RequireRelationInScope("article_revision_media"),
            () => scope.RequireRelationInScope("public.article_read_total"),
            () => scope.RequireColumnRelationInScope("public.blog_user"),
            () => scope.RequireCheckRelationInScope("public.blog_user")
        }) Assert.Throws<InvalidOperationException>(invalid);
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

        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CurrentSchema.VerifyAsync(connection, cancelled.Token));
        }

        recorder.Reset();
        Assert.False(await CurrentSchema.VerifyAsync(connection, ct));
        Assert.Equal(17, recorder.SnapshotCommands().Count);

        async Task RunReadOnlyTx(Func<NpgsqlTransaction, Task> body, bool commit = false)
        {
            await using var tx = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
            await FixtureSql.ExecuteAsync(connection, tx, ct, "SET TRANSACTION READ ONLY; SET LOCAL search_path TO pg_catalog");
            await body(tx);
            if (commit) await tx.CommitAsync(ct);
        }

        await RunReadOnlyTx(async tx =>
        {
            recorder.Reset();
            Assert.False(await CurrentSchema.VerifyCatalogAsync(connection, tx, ct));
            Assert.Equal(11, recorder.SnapshotCommands().Count);
            var snapshot = await CurrentSchema.LoadCatalogPresenceSnapshotAsync(connection, tx, ct);
            Assert.Equal((85, 9, 5), (snapshot.ScopedRelationCount, snapshot.ScopedColumnRelationCount, snapshot.ScopedCheckRelationCount));
            Assert.InRange(snapshot.ObservedRelationCount, 78, 85);
            Assert.InRange(snapshot.ObservedColumnCount, 1, 150);
            Assert.InRange(snapshot.ObservedCheckCount, 1, 60);
        }, commit: true);

        await database.Exec("DROP TABLE public.comment_report");
        Assert.False(await CurrentSchema.VerifyAsync(connection, ct));
        await RunReadOnlyTx(async tx =>
        {
            var missing = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                CurrentSchema.VerifyCatalogAsync(connection, tx, ct, new CatalogVerificationOptions { Comments = new() { Report = true } }));
            Assert.Contains("Comment report schema presence", missing.Message, StringComparison.Ordinal);
        });
    }

    [PostgresFact]
    public async Task BatchedSnapshotMatchesStandaloneProbesAcrossMissingColumnsBadUnvalidatedNonLocalChecksBadIndexesAndDataInvariants()
    {
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(60));
        await using var db = await database.DataSource.OpenConnectionAsync(ct);

        async Task Drift(string mutate, string expected, string? restore = null)
        {
            await database.Exec(mutate);
            await FixtureSql.ExpectSchemaError(db, expected, ct);
            if (restore is not null)
            {
                await database.Exec(restore);
                await CurrentSchema.VerifyAsync(db, ct);
            }
        }

        await Drift("""
            ALTER TABLE public.authoring_workspace
                DROP CONSTRAINT authoring_workspace_focused_group_check,
                DROP CONSTRAINT authoring_workspace_check1, DROP COLUMN focused_group
            """, "authoring workspace group schema is incomplete", """
            ALTER TABLE public.authoring_workspace
                ADD COLUMN focused_group integer NOT NULL DEFAULT 0 CONSTRAINT authoring_workspace_focused_group_check CHECK (focused_group >= 0 AND focused_group <= 1),
                ADD CONSTRAINT authoring_workspace_check1 CHECK (focused_group = 0 OR secondary_active_article_id > 0)
            """);

        await Drift("""
            ALTER TABLE public.article_body_insertion
                DROP CONSTRAINT article_body_insertion_check, DROP COLUMN edit_texts, DROP COLUMN operations, ADD COLUMN operations text
            """, "Invalid article body insertion operations column", "DROP TABLE public.article_body_insertion");

        await Drift("""
            ALTER TABLE public.comment_author_edited DROP CONSTRAINT comment_author_edited_previous_status_check,
                ADD CONSTRAINT comment_author_edited_previous_status_check CHECK (previous_status = 9)
            """, "Comment author edit previous status is invalid");
        await Drift("""
            ALTER TABLE public.comment_author_edited DROP CONSTRAINT comment_author_edited_previous_status_check,
                ADD CONSTRAINT comment_author_edited_previous_status_check CHECK (previous_status >= 0 AND previous_status <= 1) NOT VALID
            """, "Comment author edit previous status is invalid",
            "ALTER TABLE public.comment_author_edited VALIDATE CONSTRAINT comment_author_edited_previous_status_check");

        await Drift("""
            ALTER TABLE public.author_text_posting DROP CONSTRAINT author_text_posting_segment_check,
                ADD CONSTRAINT author_text_posting_segment_check CHECK (field = 4 AND segment BETWEEN 1 AND 200000 OR field <> 4 AND segment = 0) NOT VALID
            """, "author full-text heading index schema is incomplete");
        await Drift("""
            ALTER TABLE public.author_text_posting DROP CONSTRAINT author_text_posting_segment_check,
                ADD CONSTRAINT author_text_posting_segment_check CHECK (segment >= 0)
            """, "constraint shape mismatch", """
            ALTER TABLE public.author_text_posting DROP CONSTRAINT author_text_posting_segment_check,
                ADD CONSTRAINT author_text_posting_segment_check CHECK (field = 4 AND segment BETWEEN 1 AND 200000 OR field <> 4 AND segment = 0)
            """);

        await Drift("DROP INDEX public.article_read_total_rank; CREATE INDEX article_read_total_rank ON public.article_read_total (views ASC, article_id ASC);",
            "descending btree index",
            "DROP INDEX public.article_read_total_rank; CREATE INDEX article_read_total_rank ON public.article_read_total (views DESC, article_id DESC);");

        await Drift("UPDATE public.site_page_content SET revision = 1, markdown = 'corrupt' WHERE slug = 'about'",
            "site page editor publication coordinates are incomplete",
            "UPDATE public.site_page_content SET revision = 0, markdown = NULL WHERE slug = 'about'");

        await database.Exec("""
            DROP TABLE public.author_text_posting;
            CREATE TABLE public.tmp_author_text_posting_parent (
                field integer NOT NULL, segment integer NOT NULL DEFAULT 0,
                CONSTRAINT author_text_posting_segment_check CHECK (field = 4 AND segment BETWEEN 1 AND 200000 OR field <> 4 AND segment = 0)
            );
            CREATE TABLE public.author_text_posting (
                owner_id uuid NOT NULL, article_id integer NOT NULL, ordinal integer NOT NULL, term bytea NOT NULL,
                start_u16 integer NOT NULL, end_u16 integer NOT NULL, start_u8 integer NOT NULL, end_u8 integer NOT NULL,
                CONSTRAINT author_text_posting_owner_article UNIQUE (owner_id, article_id, field, ordinal)
            ) INHERITS (public.tmp_author_text_posting_parent);
            """);
        Assert.True(await database.Scalar<bool>("""
            SELECT k.convalidated AND NOT k.conislocal FROM pg_catalog.pg_constraint k
            WHERE k.conrelid = 'public.author_text_posting'::regclass AND k.conname = 'author_text_posting_segment_check' AND k.contype = 'c'
            """));
        var standaloneNonLocal = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.HasAuthorTextHeadingIndexAsync(db, null, ct));
        var batchedNonLocal = await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchema.VerifyAsync(db, ct));
        Assert.Equal(standaloneNonLocal.Message, batchedNonLocal.Message);
        Assert.Contains("author full-text heading index schema is incomplete", batchedNonLocal.Message, StringComparison.Ordinal);
    }

    private sealed class NpgsqlCommandRecorder : ILoggerFactory, ILogger
    {
        private readonly List<string> _commands = [];
        private readonly object _gate = new();
        public void Reset() { lock (_gate) _commands.Clear(); }
        public List<string> SnapshotCommands() { lock (_gate) return [.. _commands]; }
        public ILogger CreateLogger(string categoryName) =>
            string.Equals(categoryName, "Npgsql.Command", StringComparison.Ordinal) ? this : NullLogger.Instance;
        public void AddProvider(ILoggerProvider provider) { }
        public void Dispose() { }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (eventId.Id == 2001) lock (_gate) _commands.Add(formatter(state, exception));
        }
    }
}
