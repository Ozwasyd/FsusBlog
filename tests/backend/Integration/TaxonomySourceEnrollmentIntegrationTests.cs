using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Articles;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

public sealed partial class ArticleSourceMutationHooksIntegrationTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LiveTaxonomy_BorrowedCreateUpdateDeleteBatchKeepsOriginalTransactionAndRollsBack(bool tag)
    {
        using SqlSugarClient db = await DatabaseAsync();
        db.Ado.BeginTran();
        var original = db.Ado.Transaction;
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db);
        int id = tag
            ? await BinaryEndpoints.CreateTagAsync(db, "borrowed target", null, default)
            : await BinaryEndpoints.CreateCategoryAsync(db, "borrowed target", null, default);
        Assert.Same(original, db.Ado.Transaction);
        var updated = tag
            ? await BinaryEndpoints.UpdateTagAndEnqueueProjectionAsync(db, id, "borrowed target", "updated", false, default)
            : await BinaryEndpoints.UpdateCategoryAndEnqueueProjectionAsync(db, id, "borrowed target", "updated", false, default);
        Assert.Equal(BinaryEndpoints.TaxonomyUpdateOutcome.Updated, updated.Outcome);
        Assert.Same(original, db.Ado.Transaction);
        if (tag)
            Assert.Equal(BinaryEndpoints.TagDeleteOutcome.Deleted, await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, id));
        else
            Assert.Equal(BinaryEndpoints.CategoryDeleteOutcome.Deleted, await BinaryEndpoints.DeleteCategoryIfUnlinkedAsync(db, id));
        Assert.Same(original, db.Ado.Transaction);
        Assert.Equal(3, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(3, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;"));
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;"));
        db.Ado.RollbackTran();
        Assert.Equal(0, await observer.Queryable<Category>().CountAsync());
        Assert.Equal(0, await observer.Queryable<Tag>().CountAsync());
        Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;"));
        Assert.Equal(0, await observer.Queryable<ArticleSourceObservation>().CountAsync());
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Fact]
    public async Task LiveTaxonomy_BorrowedEnrollmentFailureEscapesToOriginalGroupOwner()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION fail_borrowed_taxonomy_source() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'borrowed taxonomy enrollment failed'; END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER fail_borrowed_taxonomy_source BEFORE INSERT ON article_source_observation
                FOR EACH ROW WHEN (NEW.origin_kind = 'taxonomy') EXECUTE FUNCTION fail_borrowed_taxonomy_source();
            """);
        db.Ado.BeginTran();
        var original = db.Ado.Transaction;
        await Assert.ThrowsAnyAsync<Exception>(() => BinaryEndpoints.CreateTagAsync(db, "group failure", null, default));
        Assert.Same(original, db.Ado.Transaction);
        db.Ado.RollbackTran();
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(0, await observer.Queryable<Tag>().CountAsync());
        Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;"));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LiveTaxonomy_CreateDescriptionNoOpAndDelete_EnrollOnlyActualReceipts(bool tag)
    {
        using SqlSugarClient db = await DatabaseAsync();
        int id = tag
            ? await BinaryEndpoints.CreateTagAsync(db, "source target", "before", default)
            : await BinaryEndpoints.CreateCategoryAsync(db, "source target", "before", default);
        Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        var changed = tag
            ? await BinaryEndpoints.UpdateTagAndEnqueueProjectionAsync(db, id, "source target", "after", false, default)
            : await BinaryEndpoints.UpdateCategoryAndEnqueueProjectionAsync(db, id, "source target", "after", false, default);
        Assert.Equal(BinaryEndpoints.TaxonomyUpdateOutcome.Updated, changed.Outcome);
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        var noOp = tag
            ? await BinaryEndpoints.UpdateTagAndEnqueueProjectionAsync(db, id, "source target", "after", false, default)
            : await BinaryEndpoints.UpdateCategoryAndEnqueueProjectionAsync(db, id, "source target", "after", false, default);
        Assert.Equal(BinaryEndpoints.TaxonomyUpdateOutcome.NoOp, noOp.Outcome);
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        if (tag)
            Assert.Equal(BinaryEndpoints.TagDeleteOutcome.Deleted, await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, id));
        else
            Assert.Equal(BinaryEndpoints.CategoryDeleteOutcome.Deleted, await BinaryEndpoints.DeleteCategoryIfUnlinkedAsync(db, id));
        Assert.Equal(3, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(3, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;"));
        Assert.Equal(3, await db.Queryable<ArticleSourceObservation>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleSourceSequence>().CountAsync());
        Assert.Equal(0, await db.Queryable<ArticleMutationOutboxEvent>().CountAsync());
        Assert.Equal(0, await db.Ado.GetIntAsync("""
            SELECT count(*) FROM taxonomy_mutation_receipt receipt
            FULL JOIN article_source_observation observation
                ON observation.origin_kind = 'taxonomy' AND observation.origin_key = receipt.receipt_id::text
            WHERE receipt.receipt_id IS NULL OR observation.origin_key IS NULL
                OR observation.article_id IS NOT NULL OR observation.source_sequence IS NOT NULL;
            """));
    }

    [Fact]
    public async Task LiveTaxonomy_CategoryDeletePreservesOriginalLinkedArticleGuard()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int category = await BinaryEndpoints.CreateCategoryAsync(db, "linked source", null, default);
        Assert.Equal(1, category);
        var created = await db.Ado.UseTranAsync(async () => await CreateAsync(db));
        Assert.True(created.IsSuccess, created.ErrorException?.ToString());
        Assert.Equal(BinaryEndpoints.CategoryDeleteOutcome.HasArticles,
            await BinaryEndpoints.DeleteCategoryIfUnlinkedAsync(db, category));
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(db));
        Assert.Equal(1, await db.Queryable<Category>().CountAsync());
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;"));
    }

    [Fact]
    public async Task LiveTaxonomy_EnrollmentFailureRollsBackOriginalInsertReceiptAndClock()
    {
        using SqlSugarClient db = await DatabaseAsync();
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION fail_taxonomy_source() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'actual taxonomy enrollment failed'; END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER fail_taxonomy_source BEFORE INSERT ON article_source_observation
                FOR EACH ROW WHEN (NEW.origin_kind = 'taxonomy') EXECUTE FUNCTION fail_taxonomy_source();
            """);
        Exception error = await Assert.ThrowsAnyAsync<Exception>(() =>
            BinaryEndpoints.CreateCategoryAsync(db, "rollback source", null, default));
        Assert.Contains("actual taxonomy enrollment failed", error.ToString());
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal(0, await observer.Queryable<Category>().CountAsync());
        Assert.Equal(0, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;"));
        Assert.Null(await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
    }

    [Fact]
    public async Task LiveTaxonomy_ArticleOutboxFailureRollsBackEarlierTaxonomyReceiptAndEnrollment()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int category = await BinaryEndpoints.CreateCategoryAsync(db, "before", null, default);
        var created = await db.Ado.UseTranAsync(async () => await CreateAsync(db));
        Assert.True(created.IsSuccess, created.ErrorException?.ToString());
        await db.Ado.ExecuteCommandAsync("""
            CREATE FUNCTION fail_taxonomy_article_event() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'actual taxonomy article event failed'; END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER fail_taxonomy_article_event BEFORE INSERT ON article_mutation_outbox
                FOR EACH ROW EXECUTE FUNCTION fail_taxonomy_article_event();
            """);
        await Assert.ThrowsAnyAsync<Exception>(() => BinaryEndpoints.UpdateCategoryAndEnqueueProjectionAsync(db, category, "after", default));
        using SqlSugarClient observer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        Assert.Equal("before", (await observer.Queryable<Category>().SingleAsync()).Name);
        Assert.Equal(1, await observer.Ado.GetIntAsync("SELECT COUNT(*) FROM taxonomy_mutation_receipt;"));
        Assert.Equal(2, await ArticleSourceGenerationAuthority.ReadGenerationAsync(observer));
        await AssertEveryEventEnrolledAsync(observer, 1);
    }

    [Fact]
    public async Task LiveTaxonomy_ContendingCreateWaitsForFamilyBeforeItsTaxonomyRowOrCaptureLocks()
    {
        using SqlSugarClient blocker = await DatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(blocker.CurrentConnectionConfig.ConnectionString);
        writer.Ado.Open();
        int pid = ((NpgsqlConnection)writer.Ado.Connection).ProcessID;
        blocker.Ado.BeginTran();
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(blocker);
        Task<int> waiting = BinaryEndpoints.CreateCategoryAsync(writer, "contending source", null, default);
        try
        {
            await WaitForAdvisoryWaitAsync(blocker.CurrentConnectionConfig.ConnectionString, pid);
            await using var monitor = new NpgsqlConnection(blocker.CurrentConnectionConfig.ConnectionString);
            await monitor.OpenAsync();
            await using var query = new NpgsqlCommand("""
                SELECT count(*) FROM pg_locks WHERE pid = @Pid AND granted
                    AND (locktype = 'advisory' OR relation = 'category'::regclass);
                """, monitor);
            query.Parameters.AddWithValue("Pid", pid);
            Assert.Equal(0L, (long)(await query.ExecuteScalarAsync())!);
            blocker.Ado.RollbackTran();
            Assert.True(await waiting > 0);
            Assert.Equal(1, await ArticleSourceGenerationAuthority.ReadGenerationAsync(writer));
        }
        finally
        {
            if (blocker.Ado.Transaction is not null)
                blocker.Ado.RollbackTran();
            await waiting;
        }
    }
}
