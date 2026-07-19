using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class ScheduledPublishIndexMigrationDefinitions
{
    internal const string MigrationId = "20260720-post-scheduled-publish-due-index";
    internal const string IndexName = "idx_article_scheduled_publish_due_v2";

    internal const string CreateIndexSql = """
        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_article_scheduled_publish_due_v2
        ON article(scheduled_publish_at, id)
        WHERE isdeleted = false
          AND status = 1
          AND scheduled_publish_at IS NOT NULL;
        """;

    internal const string RollbackIndexSql = """
        DROP INDEX CONCURRENTLY IF EXISTS idx_article_scheduled_publish_due_v2;
        """;

    private const string MySqlCreateIndexSql = """
        CREATE INDEX idx_article_scheduled_publish_due_v2
        ON article(isdeleted, status, scheduled_publish_at, id);
        """;

    private const string SqliteCreateIndexSql = """
        CREATE INDEX IF NOT EXISTS idx_article_scheduled_publish_due_v2
        ON article(scheduled_publish_at, id)
        WHERE isdeleted = 0
          AND status = 1
          AND scheduled_publish_at IS NOT NULL;
        """;

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the online partial index used by the scheduled publication due scan.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: false,
            Steps:
            [
                new CreateScheduledPublishDueIndexStep()
            ]);

    private sealed record CreateScheduledPublishDueIndexStep : SchemaMigrationStep
    {
        internal override string Kind => "CreateIndexConcurrently";
        internal override string Fingerprint => $"{IndexName}\n{CreateIndexSql}";

        internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
            => new(
                ddl.Dialect switch
                {
                    SchemaDdlDialect.PostgreSql => CreateIndexSql,
                    SchemaDdlDialect.MySql => MySqlCreateIndexSql,
                    SchemaDdlDialect.Sqlite => SqliteCreateIndexSql,
                    _ => throw new ArgumentOutOfRangeException(nameof(ddl), ddl.Dialect, null)
                },
                IsDdl: true);

        internal override async Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        {
            await base.ExecuteAsync(db, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (SchemaDdlProviders.For(db).Dialect != SchemaDdlDialect.PostgreSql)
            {
                return;
            }

            int validDefinition = await db.Ado.GetIntAsync(
                """
                SELECT COUNT(1)
                FROM pg_index index_state
                JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
                JOIN pg_class table_relation ON table_relation.oid = index_state.indrelid
                WHERE index_relation.relname = 'idx_article_scheduled_publish_due_v2'
                  AND table_relation.relname = 'article'
                  AND index_state.indisvalid
                  AND index_state.indisready
                  AND index_state.indnkeyatts = 2
                  AND pg_get_indexdef(index_state.indexrelid, 1, true) = 'scheduled_publish_at'
                  AND pg_get_indexdef(index_state.indexrelid, 2, true) = 'id'
                  AND pg_get_expr(index_state.indpred, index_state.indrelid, true) LIKE '%isdeleted = false%'
                  AND pg_get_expr(index_state.indpred, index_state.indrelid, true) LIKE '%status = 1%'
                  AND pg_get_expr(index_state.indpred, index_state.indrelid, true) LIKE '%scheduled_publish_at IS NOT NULL%';
                """).ConfigureAwait(false);
            if (validDefinition != 1)
            {
                throw new InvalidOperationException(
                    "Scheduled publish due index is missing, invalid, or has an unexpected definition.");
            }
        }
    }
}
