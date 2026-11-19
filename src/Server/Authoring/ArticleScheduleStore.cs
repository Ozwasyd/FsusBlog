using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal static class ArticleScheduleStore
{
    private const int BatchSize = 16;
    private sealed record Candidate(int Id, long Revision, Guid Actor, long Generation, Guid Command);

    internal static async Task<ArticleSchedule> Read(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, int id,
        long expected, CancellationToken ct)
    {
        var published = await RevisionHistoryStore.LockCurrent(db, tx, actor, id, expected, ct);
        await using var cmd = SqlCommands.Create(db, tx, """
            select s.due_at from public.article_schedule s join public.blog_user u on u.id=s.actor_id and u.generation=s.generation
            where s.article_id=$1 and s.revision=$2 and s.actor_id=$3
            """, id, expected, actor.Id);
        return new(id, expected, Milliseconds(await cmd.ExecuteScalarAsync(ct)), published);
    }

    internal static async Task Validate(NpgsqlConnection db, NpgsqlTransaction tx, ArticleState current,
        ArticleScheduleCommand input, CancellationToken ct)
    {
        if (input.DueUnixMs == 0)
        {
            await using var check = SqlCommands.Create(db, tx, "select exists(select from public.article_schedule where article_id=$1)", current.Id);
            if (await check.ExecuteScalarAsync(ct) is not true)
                throw new BusinessException(Rejection.Conflict, "No pending publication remains to cancel.");
            return;
        }
        if (string.IsNullOrWhiteSpace(current.Body))
            throw new BusinessException(Rejection.Invalid, "A nonempty saved draft is required.");
        await PublicationRightsStore.Require(db, tx, current.Id, current.Revision, ct);
        await using var future = SqlCommands.Create(db, tx, "select $1 > clock_timestamp()", Due(input));
        if (await future.ExecuteScalarAsync(ct) is not true)
            throw new BusinessException(Rejection.Invalid, "The publication time must be in the future.");
    }

    internal static async Task Record(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, ArticleState current,
        ArticleScheduleCommand input, CancellationToken ct)
    {
        await using var receipt = SqlCommands.Create(db, tx, """
            insert into public.article_schedule_receipt(actor_id,command_id,due_at,published_revision) values($1,$2,$3,$4)
            """, actor.Id, input.IdempotencyKey, Due(input), current.PublishedRevision ?? 0L);
        await receipt.ExecuteNonQueryAsync(ct);
        if (input.DueUnixMs == 0)
        {
            await Clear(db, tx, current.Id, ct);
            return;
        }
        await using var set = SqlCommands.Create(db, tx, """
            insert into public.article_schedule(article_id,revision,actor_id,generation,command_id,due_at)
            values($1,$2,$3,$4,$5,$6)
            on conflict (article_id) do update set revision=excluded.revision,actor_id=excluded.actor_id,
                generation=excluded.generation,command_id=excluded.command_id,due_at=excluded.due_at
            """, current.Id, current.Revision, actor.Id, actor.Generation, input.IdempotencyKey, Due(input));
        await set.ExecuteNonQueryAsync(ct);
    }

    internal static async Task<ArticleSchedule> ReadReceipt(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor, Guid command,
        ArticleState draft, CancellationToken ct)
    {
        await using var read = SqlCommands.Create(db, tx, """
            select due_at,published_revision from public.article_schedule_receipt where actor_id=$1 and command_id=$2
            """, actor, command);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new InvalidOperationException("Schedule receipt missing.");
        return new(draft.Id, draft.Revision, row.IsDBNull(0) ? 0 : Milliseconds(row.GetDateTime(0)), row.GetInt64(1));
    }

    internal static async Task Clear(NpgsqlConnection db, NpgsqlTransaction tx, int id, CancellationToken ct)
    {
        await using var clear = SqlCommands.Create(db, tx, "delete from public.article_schedule where article_id=$1", id);
        await clear.ExecuteNonQueryAsync(ct);
    }

    // The one-shot clock is an internal integration seam. Production always reads the database clock inside this transaction.
    internal static async Task<int> PublishDue(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct, DateTime? testClock = null)
    {
        await using var time = SqlCommands.Create(db, tx, "select clock_timestamp()");
        var now = testClock ?? (DateTime)(await time.ExecuteScalarAsync(ct))!;
        var due = new List<Candidate>(BatchSize);
        await using (var claim = SqlCommands.Create(db, tx, """
            select a.id,s.revision,s.actor_id,s.generation,s.command_id
            from public.article_schedule s join public.article a on a.id=s.article_id
            where s.due_at<=$1 order by s.due_at,s.article_id limit $2 for update of a skip locked
            """, now, BatchSize))
        await using (var reader = await claim.ExecuteReaderAsync(ct))
        {
            while (await reader.ReadAsync(ct))
                due.Add(new(reader.GetInt32(0), reader.GetInt64(1), reader.GetGuid(2), reader.GetInt64(3), reader.GetGuid(4)));
        }
        var changed = 0;
        foreach (var candidate in due)
        {
            // Account updates lock the account before any article. Skip a busy account instead of reversing that order.
            await using var author = SqlCommands.Create(db, tx, """
                select p.enabled and p.generation=$2
                    and exists (select from public.admin_permission g where g.principal_id=p.id and g.permission='article.write')
                from public.admin_principal p where p.id=$1 for share skip locked
                """, candidate.Actor, candidate.Generation);
            if (await author.ExecuteScalarAsync(ct) is not bool permitted) continue;
            await using var verify = SqlCommands.Create(db, tx, $"""
                select a.published_revision,s.revision=a.revision and s.actor_id=a.owner_id and not a.deleted
                    and {ArchivedArticleAuthority.Available}
                    and a.id=c.article_id and s.revision=c.revision and s.due_at=r.due_at
                    and coalesce(a.published_revision,0)=r.published_revision
                    and exists (select from public.article_revision_rights w where w.article_id=a.id and w.revision=s.revision)
                from public.article_schedule s join public.article a on a.id=s.article_id
                join public.article_schedule_receipt r on r.actor_id=s.actor_id and r.command_id=s.command_id
                join public.article_command c on c.actor_id=s.actor_id and c.command_id=s.command_id
                where s.article_id=$1 and s.revision=$2 and s.actor_id=$3 and s.generation=$4
                  and s.command_id=$5 and s.due_at<=$6
                """, candidate.Id, candidate.Revision, candidate.Actor, candidate.Generation, candidate.Command, now);
            long? publication;
            bool eligible;
            await using (var row = await verify.ExecuteReaderAsync(ct))
            {
                if (!await row.ReadAsync(ct)) continue;
                publication = row.IsDBNull(0) ? null : row.GetInt64(0);
                eligible = row.GetBoolean(1);
            }
            if (permitted && eligible)
            {
                await using var publish = SqlCommands.Create(db, tx, """
                    update public.article set published_revision=$2,updated_at=clock_timestamp() where id=$1
                    """, candidate.Id, candidate.Revision);
                await publish.ExecuteNonQueryAsync(ct);
                // For retained hidden legacy state, use the previous transition boundary, strictly before the scheduled revision.
                await PublicationHistoryStore.Apply(db, tx, candidate.Actor, candidate.Command, ArticleAction.Publish,
                    candidate.Id, candidate.Revision - 1, publication, candidate.Revision, ct, scheduled: true);
                await PublicationHistoryStore.RecordPublishedOutbox(db, tx, candidate.Id, candidate.Revision, ct);
                changed++;
            }
            await Clear(db, tx, candidate.Id, ct);
        }
        return changed;
    }

    private static NpgsqlParameter Due(ArticleScheduleCommand input) => new()
    {
        NpgsqlDbType = NpgsqlDbType.TimestampTz,
        Value = input.DueUnixMs == 0 ? DBNull.Value : DateTimeOffset.FromUnixTimeMilliseconds(input.DueUnixMs).UtcDateTime
    };

    private static long Milliseconds(object? stamp) => stamp is DateTime date ? new DateTimeOffset(date).ToUnixTimeMilliseconds() : 0;
}
