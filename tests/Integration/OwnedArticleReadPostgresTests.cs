namespace FsusBlog.V2.Integration.Tests;

public sealed class OwnedArticleReadPostgresTests
{
    [PostgresFact]
    public async Task LockWaitReadsTheCommittedHeadAndChecksAvailabilityInANewStatement()
    {
        foreach (var archive in new[] { false, true })
        {
            await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
            var owner = Guid.NewGuid();
            await fixture.InTx(async (db, seed) =>
            {
                await FixtureSql.AdminPrincipalAsync(db, seed, ct, owner, "owned-lock-fixture");
                await FixtureSql.ExecuteAsync(db, seed, ct, """
                    insert into public.article(id,owner_id,revision,title,body,deleted) overriding system value values(42,$1,1,'Initial','Saved',false)
                    """, owner);
                await FixtureSql.ExecuteAsync(db, seed, ct,
                    "insert into public.article_revision(article_id,revision,title,body,happened_at) values(42,1,'Initial','Saved',clock_timestamp())");
            }, ct);
            await using var writer = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var reader = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var write = await writer.BeginTransactionAsync(ct);
            await FixtureSql.ExecuteAsync(writer, write, ct, """
                update public.article set revision=2 where id=42;
                insert into public.article_revision(article_id,revision,title,body,happened_at) values(42,2,'Current','Saved',clock_timestamp());
                """ + (archive ? "insert into public.article_publication_history(article_id,event_no,revision,publication_no,kind,reason) values(42,1,2,0,'retract','administrator-rollback-archived');" : ""));
            await using var read = await reader.BeginTransactionAsync(ct);
            var pending = OwnedArticleRead.TryLock(reader, read, owner, 42, ct);
            var blocked = false;
            for (var attempt = 0; attempt < 200 && !blocked; attempt++)
            {
                blocked = await FixtureSql.ScalarAsync(writer, write, ct, "select $1=any(pg_blocking_pids($2))", writer.ProcessID, reader.ProcessID) is true;
                if (!blocked) await Task.Delay(10, ct);
            }
            Assert.True(blocked, "The owned reader must actually wait for the writer's article row lock.");
            Assert.False(pending.IsCompleted);
            await write.CommitAsync(ct);
            var observed = await pending;
            if (archive) Assert.Null(observed);
            else Assert.Equal(new OwnedArticleHead(2, null), observed);
            await read.RollbackAsync(ct);
        }
    }
}
