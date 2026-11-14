using System.Security.Cryptography;
using System.Buffers.Binary;
using FsusBlog.V2.Core;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server;

internal sealed class Store(NpgsqlDataSource source)
{
    internal static NpgsqlCommand Sql(NpgsqlConnection db, NpgsqlTransaction? transaction, string sql, params object[] parameters)
    {
        var command = new NpgsqlCommand(sql, db, transaction);
        foreach (var parameter in parameters)
            command.Parameters.Add(parameter is NpgsqlParameter typed ? typed : new NpgsqlParameter { Value = parameter });
        return command;
    }

    internal async Task<(string Token, Identity User)> SignIn(string token, CancellationToken ct)
    {
        if (TokenDigest(token) is not { } ticket) throw Unauthenticated();
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await db.BeginTransactionAsync(ct);
        Guid id;
        string name;
        long generation;
        bool canAuthor;
        await using (var cmd = Sql(db, tx, """
            select id,name,generation,can_author from public.blog_user where enabled and
                id=(select user_id from public.login_ticket where digest=$1 and expires_at>clock_timestamp()) for update
            """, ticket))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Unauthenticated();
            (id, name, generation, canAuthor) = (row.GetGuid(0), row.GetString(1), row.GetInt64(2), row.GetBoolean(3));
        }
        await using (var consume = Sql(db, tx, """
            delete from public.login_ticket where digest=$1 and user_id=$2 and expires_at>clock_timestamp()
            """, ticket, id))
            if (await consume.ExecuteNonQueryAsync(ct) != 1) throw Unauthenticated();

        var secret = RandomNumberGenerator.GetBytes(32);
        await using var add = Sql(db, tx, """
            insert into public.user_session(digest,user_id,generation,expires_at)
            values($1,$2,$3,clock_timestamp()+interval '8 hours') returning expires_at
            """, SHA256.HashData(secret), id, generation);
        var expiry = (DateTime)(await add.ExecuteScalarAsync(ct))!;
        await tx.CommitAsync(ct);
        return (Convert.ToHexStringLower(secret), new(id, name, generation, canAuthor, expiry));
    }

    internal async Task<T> WithSession<T>(string? token, bool author, Func<NpgsqlConnection, NpgsqlTransaction, Identity, Task<T>> run, CancellationToken ct)
    {
        if (TokenDigest(token) is not { } digest) throw Unauthenticated();
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await db.BeginTransactionAsync(ct);
        Identity actor;
        await using (var cmd = Sql(db, tx, """
            select u.id,u.name,u.generation,u.can_author,s.expires_at
            from public.blog_user u join public.user_session s on s.user_id=u.id
            where u.enabled and s.digest=$1 and u.generation=s.generation and s.expires_at>clock_timestamp()
            for share of u,s
            """, digest))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Unauthenticated();
            actor = new(row.GetGuid(0), row.GetString(1), row.GetInt64(2), row.GetBoolean(3), row.GetFieldValue<DateTimeOffset>(4));
        }
        if (author && !actor.CanAuthor) throw new BusinessException(Rejection.Forbidden, "This account cannot write articles.");
        var result = await run(db, tx, actor);
        if (actor.ExpiresAt <= DateTimeOffset.UtcNow) throw Unauthenticated();
        await tx.CommitAsync(ct);
        return result;
    }

    internal async Task SignOut(string? token, CancellationToken ct)
    {
        if (TokenDigest(token) is not { } digest) return;
        await using var db = await source.OpenConnectionAsync(ct);
        await using var cmd = Sql(db, null, "delete from public.user_session where digest=$1", digest);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    internal static async Task<ArticleState> Find(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, int id, bool locking, CancellationToken ct)
    {
        await using var cmd = Sql(db, tx, """
            select revision,title,body,published_revision from public.article where id=$1 and owner_id=$2 and not deleted
            """ + (locking ? " for update" : ""), id, actor.Id);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new BusinessException(Rejection.NotFound, "Article not found.");
        return new(id, actor.Id, row.GetInt64(0), row.GetString(1), row.GetString(2), row.IsDBNull(3) ? null : row.GetInt64(3), false);
    }

    internal static async Task LockCommand(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor, Guid commandKey, CancellationToken ct)
    {
        var scope = new byte[32];
        actor.TryWriteBytes(scope);
        commandKey.TryWriteBytes(scope.AsSpan(16));
        var dedupeLock = BinaryPrimitives.ReadInt64LittleEndian(SHA256.HashData(scope));
        await using var serialize = Sql(db, tx, "select pg_advisory_xact_lock($1)", dedupeLock);
        await serialize.ExecuteNonQueryAsync(ct);
    }

    internal static async Task<(ArticleState Article, bool Changed)> Execute(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleAction action, Edit edit, CancellationToken ct)
    {
        var fingerprint = Publishing.Fingerprint(action, edit);
        await LockCommand(db, tx, actor.Id, edit.Key, ct);
        await using (var existing = Sql(db, tx, """
            select fingerprint,article_id,revision,title,body,published from public.article_command where actor_id=$1 and command_id=$2
            """, actor.Id, edit.Key))
        await using (var row = await existing.ExecuteReaderAsync(ct))
        {
            if (await row.ReadAsync(ct))
            {
                if (!CryptographicOperations.FixedTimeEquals(fingerprint, row.GetFieldValue<byte[]>(0)))
                    throw new BusinessException(Rejection.Conflict, "This command key is already in use.");
                return (new(row.GetInt32(1), actor.Id, row.GetInt64(2), row.GetString(3), row.GetString(4),
                    row.GetBoolean(5) ? row.GetInt64(2) : null, action == ArticleAction.Delete), false);
            }
        }
        ArticleState state;
        if (edit.Id == 0)
        {
            await using var create = Sql(db, tx, """
                insert into public.article(owner_id,revision,title,body,deleted) values($1,1,$2,$3,false) returning id
                """, actor.Id, edit.Title, edit.Body);
            state = new((int)(await create.ExecuteScalarAsync(ct))!, actor.Id, 1, edit.Title, edit.Body, null, false);
        }
        else
        {
            state = Publishing.Change(action, edit, await Find(db, tx, actor, edit.Id, true, ct), actor);
            await using var update = Sql(db, tx, """
                update public.article set revision=$2,title=$3,body=$4,published_revision=$5,deleted=$6,updated_at=now() where id=$1
                """, state.Id, state.Revision, state.Title, state.Body,
                new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bigint, Value = (object?)state.PublishedRevision ?? DBNull.Value }, state.Deleted);
            await update.ExecuteNonQueryAsync(ct);
        }
        await using (var revision = Sql(db, tx, """
            insert into public.article_revision(article_id,revision,title,body,happened_at) values($1,$2,$3,$4,now())
            """, state.Id, state.Revision, state.Title, state.Body)) await revision.ExecuteNonQueryAsync(ct);
        if (edit.Id != 0)
            await Content.TaxonomyStore.CarryForward(db, tx, state.Id, edit.ExpectedRevision, state.Revision, ct);
        if (action == ArticleAction.Publish)
        {
            await using var publish = Sql(db, tx, """
                with next_publication as (
                    update public.article set publication_count=publication_count+1 where id=$1 returning publication_count
                )
                insert into public.article_publication(article_id,revision,publication_no,published_at)
                    select $1,$2,publication_count,now() from next_publication
                on conflict(article_id) do update set revision=excluded.revision,publication_no=excluded.publication_no,
                    published_at=excluded.published_at,publication_id=excluded.publication_id
                """, state.Id, state.Revision);
            await publish.ExecuteNonQueryAsync(ct);
        }
        if (action is ArticleAction.Retract or ArticleAction.Delete)
        {
            await using var retract = Sql(db, tx, "delete from public.article_publication where article_id=$1", state.Id);
            await retract.ExecuteNonQueryAsync(ct);
        }
        await using (var record = Sql(db, tx, """
            insert into public.article_command(actor_id,command_id,fingerprint,article_id,revision,title,body,published)
            values($1,$2,$3,$4,$5,$6,$7,$8)
            """, actor.Id, edit.Key, fingerprint, state.Id, state.Revision, state.Title, state.Body, state.PublishedRevision.HasValue))
            await record.ExecuteNonQueryAsync(ct);
        await using (var enqueue = Sql(db, tx, "insert into public.blog_outbox(article_id,revision,kind) values($1,$2,$3)",
            state.Id, state.Revision, action.ToString().ToLowerInvariant())) await enqueue.ExecuteNonQueryAsync(ct);
        return (state, true);
    }

    internal static byte[]? TokenDigest(string? token)
    {
        if (token is not { Length: 64 } || !token.All(c => char.IsAsciiHexDigitLower(c))) return null;
        return SHA256.HashData(Convert.FromHexString(token));
    }

    private static BusinessException Unauthenticated() => new(Rejection.Unauthorized, "Session or sign-in ticket is invalid or expired.");
}
