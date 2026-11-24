namespace FsusBlog.V2.Integration.Tests;

public sealed class OwnedArticleReadPostgresTests
{
    [PostgresFact]
    public async Task LockWaitReadsTheCommittedHeadAndChecksAvailabilityInANewStatement()
    {
        foreach (var archive in new[] { false, true })
        {
            await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
            await using var writer = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var reader = await fixture.DataSource.OpenConnectionAsync(ct);
            var owner = Guid.NewGuid();
            await using var seed = await writer.BeginTransactionAsync(ct);
            await FixtureSql.AdminPrincipalAsync(writer, seed, ct, owner, "owned-lock-fixture");
            await FixtureSql.ExecuteAsync(writer, seed, ct, """
                insert into public.article(id,owner_id,revision,title,body,deleted)
                    overriding system value values(42,$1,1,'Initial','Saved',false)
                """, owner);
            await FixtureSql.ExecuteAsync(writer, seed, ct, """
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                    values(42,1,'Initial','Saved',clock_timestamp());
                """);
            await seed.CommitAsync(ct);
            await using var write = await writer.BeginTransactionAsync(ct);
            await FixtureSql.ExecuteAsync(writer, write, ct, """
                update public.article set revision=2 where id=42;
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                    values(42,2,'Current','Saved',clock_timestamp());
                """);
            if (archive)
                await FixtureSql.ExecuteAsync(writer, write, ct, """
                    insert into public.article_publication_history(article_id,event_no,revision,publication_no,kind,reason)
                        values(42,1,2,0,'retract','administrator-rollback-archived');
                    """);
            await using var read = await reader.BeginTransactionAsync(ct);
            var pending = OwnedArticleRead.TryLock(reader, read, owner, 42, ct);
            var blocked = false;
            for (var attempt = 0; attempt < 200 && !blocked; attempt++)
            {
                await using var probe = Store.Sql(writer, write,
                    "select $1=any(pg_blocking_pids($2))", writer.ProcessID, reader.ProcessID);
                blocked = await probe.ExecuteScalarAsync(ct) is true;
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
