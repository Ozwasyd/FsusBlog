using System.Security.Cryptography;
using System.Buffers.Binary;
using FsusBlog.V2.Core;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server;

internal sealed class Store(NpgsqlDataSource source, InstanceLease? lease = null)
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
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
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
                and not exists(select 1 from public.passkey_credential where user_id=$2)
            """, ticket, id))
            if (await consume.ExecuteNonQueryAsync(ct) != 1) throw Unauthenticated();

        var secret = RandomNumberGenerator.GetBytes(32);
        await using var add = Sql(db, tx, """
            insert into public.user_session(digest,user_id,generation,expires_at)
            values($1,$2,$3,clock_timestamp()+interval '8 hours') returning expires_at
            """, SHA256.HashData(secret), id, generation);
        var expiry = (DateTime)(await add.ExecuteScalarAsync(ct))!;
        await InstanceLease.CommitProtected(tx, lease, ct);
        return (Convert.ToHexStringLower(secret), new(id, name, generation, canAuthor, expiry));
    }

    internal Task<T> WithSession<T>(string? token, bool author, Func<NpgsqlConnection, NpgsqlTransaction, Identity, Task<T>> run, CancellationToken ct) =>
        WithSession(token, author, lockAccount: false, run, ct);

    internal Task<T> WithSessionForAccountUpdate<T>(string? token, Func<NpgsqlConnection, NpgsqlTransaction, Identity, Task<T>> run, CancellationToken ct) =>
        WithSession(token, author: false, lockAccount: true, run, ct);

    private async Task<T> WithSession<T>(string? token, bool author, bool lockAccount,
        Func<NpgsqlConnection, NpgsqlTransaction, Identity, Task<T>> run, CancellationToken ct)
    {
        if (TokenDigest(token) is not { } digest) throw Unauthenticated();
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        if (lockAccount)
        {
            await using var account = Sql(db, tx, """
                select id from public.blog_user where enabled
                and id=(select user_id from public.user_session where digest=$1) for update
                """, digest);
            if (await account.ExecuteScalarAsync(ct) is null) throw Unauthenticated();
        }
        Identity actor;
        await using (var cmd = Sql(db, tx, """
            select u.id,u.name,u.generation,u.can_author,s.expires_at
            from public.blog_user u join public.user_session s on s.user_id=u.id
            where u.enabled and s.digest=$1 and u.generation=s.generation and s.expires_at>clock_timestamp()
            """ + (lockAccount ? " for update of s" : " for share of u,s"), digest))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Unauthenticated();
            actor = new(row.GetGuid(0), row.GetString(1), row.GetInt64(2), row.GetBoolean(3), row.GetFieldValue<DateTimeOffset>(4));
        }
        if (author && !actor.CanAuthor) throw new BusinessException(Rejection.Forbidden, "This account cannot write articles.");
        var result = await run(db, tx, actor);
        if (actor.ExpiresAt <= DateTimeOffset.UtcNow) throw Unauthenticated();
        await InstanceLease.CommitProtected(tx, lease, ct);
        return result;
    }

    internal async Task SignOut(string? token, CancellationToken ct)
    {
        if (TokenDigest(token) is not { } digest) return;
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        await using var cmd = Sql(db, tx, "delete from public.user_session where digest=$1", digest);
        await cmd.ExecuteNonQueryAsync(ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    internal static async Task<ArticleState> Find(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, int id, bool locking,
        CancellationToken ct, bool includeDeleted = false)
    {
        const string owned = "from public.article a where a.id=$1 and a.owner_id=$2 and ($3 or not a.deleted)";
        if (locking)
        {
            await using var take = Sql(db, tx, $"select a.id {owned} for update", id, actor.Id, includeDeleted);
            if (await take.ExecuteScalarAsync(ct) is null)
                throw new BusinessException(Rejection.NotFound, "Article not found.");
        }
        // A fresh statement after locking observes the archive event committed by any prior holder.
        await using var cmd = Sql(db, tx, $"""
            select revision,title,body,published_revision,deleted
            {owned} and {ArchivedArticleAuthority.Available}
            """, id, actor.Id, includeDeleted);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new BusinessException(Rejection.NotFound, "Article not found.");
        return new(id, actor.Id, row.GetInt64(0), row.GetString(1), row.GetString(2),
            row.IsDBNull(3) ? null : row.GetInt64(3), row.GetBoolean(4));
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

    internal static Task<(ArticleState Article, bool Changed)> Execute(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleAction action, Edit edit, CancellationToken ct) => Execute(db, tx, actor, action, edit, ct, null);

    internal static Task<(ArticleState Article, bool Changed)> SaveBodyInsertion(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, Edit edit, ArticleBodyInsertionCommand insertion, CancellationToken ct) =>
        Execute(db, tx, actor, ArticleAction.Save, edit, ct, null, insertion: insertion);

    internal static Task<(ArticleState Article, bool Changed)> SaveBodyInsertions(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, Edit edit, ArticleBodyInsertionsCommand insertions, CancellationToken ct) =>
        Execute(db, tx, actor, ArticleAction.Save, edit, ct, null, insertions: insertions);

    internal static Task<(ArticleState Article, bool Changed)> SaveBodyEdits(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, Edit edit, ArticleBodyEditsCommand bodyEdits, CancellationToken ct) =>
        Execute(db, tx, actor, ArticleAction.Save, edit, ct, null, bodyEdits: bodyEdits);

    internal static Task<(ArticleState Article, bool Changed)> PublishWithImages(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, Edit edit, Content.PublishedMediaStore media, Content.PublishedMediaSelection selection, CancellationToken ct) =>
        Execute(db, tx, actor, ArticleAction.Publish, edit, ct, null, publishedMedia: (media, selection));

    internal static async Task<DraftTaxonomy> AssignTaxonomy(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        TaxonomyAssignment input, CancellationToken ct)
    {
        var edit = new Edit(input.Id, input.ExpectedRevision, input.IdempotencyKey, "", "");
        var saved = await Execute(db, tx, actor, ArticleAction.Save, edit, ct, input);
        return await Content.TaxonomyStore.ReadDraft(db, tx, saved.Article.Id, saved.Article.Revision, ct);
    }

    internal static async Task<ArticleState> RollbackDraft(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        DraftRollback input, CancellationToken ct)
    {
        var edit = new Edit(input.Id, input.ExpectedRevision, input.IdempotencyKey, "", "");
        var saved = await Execute(db, tx, actor, ArticleAction.Save, edit, ct, null, input);
        return saved.Article;
    }

    internal static async Task<ArticleState> SetSummary(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleSummaryCommand input, CancellationToken ct)
    {
        if (input.Text.Any(character => char.IsControl(character) && character is not ('\r' or '\n' or '\t')))
            throw new BusinessException(Rejection.Invalid, "The article summary contains unsupported control characters.");
        var summary = input with { Text = input.Text.Trim() };
        var edit = new Edit(input.Id, input.ExpectedRevision, input.IdempotencyKey, "", "");
        return (await Execute(db, tx, actor, ArticleAction.Save, edit, ct, null, summary: summary)).Article;
    }

    private static async Task<(ArticleState Article, bool Changed)> Execute(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleAction action, Edit edit, CancellationToken ct, TaxonomyAssignment? taxonomy, DraftRollback? rollback = null,
        ArticleScheduleCommand? schedule = null, ArticleRightsCommand? rights = null, ArticleMediaCommand? attachment = null,
        (Content.PublishedMediaStore Store, Content.PublishedMediaSelection Selection)? publishedMedia = null,
        ArticleSummaryCommand? summary = null, ArticleBodyInsertionCommand? insertion = null,
        ArticleBodyInsertionsCommand? insertions = null, ArticleBodyEditsCommand? bodyEdits = null)
    {
        var fingerprint = publishedMedia is { } media ? media.Selection.Fingerprint(edit) :
            attachment is not null ? SHA256.HashData(Wire.EncodeArticleMediaCommand(attachment)) :
            rights is not null ? SHA256.HashData(Wire.EncodeArticleRightsCommand(rights)) :
            schedule is not null ? SHA256.HashData(Wire.EncodeArticleScheduleCommand(schedule)) :
            rollback is not null ? SHA256.HashData(Wire.EncodeDraftRollback(rollback)) :
            taxonomy is not null ? SHA256.HashData(Wire.EncodeTaxonomyAssignment(taxonomy)) :
            summary is not null ? SHA256.HashData(Wire.EncodeArticleSummaryCommand(summary)) :
            bodyEdits is not null ? SHA256.HashData(Wire.EncodeArticleBodyEditsCommand(bodyEdits)) :
            insertions is not null ? SHA256.HashData(Wire.EncodeArticleBodyInsertionsCommand(insertions)) :
            insertion is not null ? SHA256.HashData(Wire.EncodeArticleBodyInsertionCommand(insertion)) : Publishing.Fingerprint(action, edit);
        await LockCommand(db, tx, actor.Id, edit.Key, ct);
        var current = taxonomy is not null || rollback is not null || schedule is not null || rights is not null || attachment is not null || summary is not null
            ? await Find(db, tx, actor, edit.Id, true, ct) : null;
        ArticleState? replay = null;
        await using (var existing = Sql(db, tx, """
            select fingerprint,article_id,revision,title,body,published from public.article_command where actor_id=$1 and command_id=$2
            """, actor.Id, edit.Key))
        await using (var row = await existing.ExecuteReaderAsync(ct))
        {
            if (await row.ReadAsync(ct))
            {
                if (!CryptographicOperations.FixedTimeEquals(fingerprint, row.GetFieldValue<byte[]>(0)))
                    throw new BusinessException(Rejection.Conflict, "This command key is already in use.");
                replay = new(row.GetInt32(1), actor.Id, row.GetInt64(2), row.GetString(3), row.GetString(4),
                    row.GetBoolean(5) ? row.GetInt64(2) : null, action == ArticleAction.Delete);
            }
        }
        if (replay is not null)
        {
            if (current is null)
            {
                // A command that created the article carries zero as its input ID.
                await using var article = Sql(db, tx, "select id from public.article where id=$1 for share", replay.Id);
                if (await article.ExecuteScalarAsync(ct) is null)
                    throw new BusinessException(Rejection.NotFound, "Article not found.");
                await ArchivedArticleAuthority.RequireLockedAvailability(db, tx, replay.Id, ct);
            }
            return (replay, false);
        }
        ArticleState state;
        Authoring.ArticleBodyInsertionWitness? bodyInsertion = null;
        IReadOnlyList<Content.PublishedMediaReference>? images = null;
        if (edit.Id == 0)
        {
            await using var create = Sql(db, tx, """
                insert into public.article(owner_id,revision,title,body,deleted) values($1,1,$2,$3,false) returning id
                """, actor.Id, edit.Title, edit.Body);
            state = new((int)(await create.ExecuteScalarAsync(ct))!, actor.Id, 1, edit.Title, edit.Body, null, false);
        }
        else
        {
            current ??= await Find(db, tx, actor, edit.Id, true, ct, includeDeleted: action == ArticleAction.Restore);
            if (taxonomy is not null || rights is not null || attachment is not null || summary is not null)
                edit = edit with { Title = current.Title, Body = current.Body };
            if (schedule is not null)
            {
                Authoring.RevisionHistoryStore.RequireRevision(current.Revision, schedule.ExpectedRevision);
                await Authoring.ArticleScheduleStore.Validate(db, tx, current, schedule, ct);
                edit = edit with { Title = current.Title, Body = current.Body };
            }
            if (rollback is not null)
            {
                Authoring.RevisionHistoryStore.RequireRevision(current.Revision, rollback.ExpectedRevision);
                var source = await Authoring.RevisionHistoryStore.ReadSource(db, tx, edit.Id, rollback.SourceRevision, ct);
                edit = edit with { Title = source.Title, Body = source.Body };
            }
            state = Publishing.Change(action, edit, current, actor);
            if (insertion is not null)
            {
                var source = await Authoring.RevisionHistoryStore.ReadSource(db, tx, edit.Id, edit.ExpectedRevision, ct);
                bodyInsertion = Authoring.ArticleBodyInsertionStore.Prepare(source.Body, state.Body, insertion.Offset, insertion.Length);
            }
            if (insertions is not null)
            {
                var source = await Authoring.RevisionHistoryStore.ReadSource(db, tx, edit.Id, edit.ExpectedRevision, ct);
                var witness = Authoring.ArticleBodyInsertionStore.PrepareSequence(source.Body, state.Body, insertions.Insertions);
                if (witness is not null && await CurrentSchema.HasArticleBodyInsertionOperationsAsync(db, tx, ct))
                    bodyInsertion = witness;
            }
            if (bodyEdits is not null)
            {
                var source = await Authoring.RevisionHistoryStore.ReadSource(db, tx, edit.Id, edit.ExpectedRevision, ct);
                bodyInsertion = Authoring.ArticleBodyInsertionStore.PrepareEdits(source.Body, state.Body, bodyEdits.Edits);
            }
            if (publishedMedia is { } share)
                images = await share.Store.Prepare(db, tx, actor, edit, share.Selection, ct);
            await using var update = Sql(db, tx, """
                update public.article set revision=$2,title=$3,body=$4,published_revision=$5,deleted=$6,updated_at=now() where id=$1
                """, state.Id, state.Revision, state.Title, state.Body,
                new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bigint, Value = (object?)state.PublishedRevision ?? DBNull.Value }, state.Deleted);
            await update.ExecuteNonQueryAsync(ct);
        }
        await using (var revision = Sql(db, tx, """
            insert into public.article_revision(article_id,revision,title,body,happened_at,author_summary)
            values($1,$2,$3,$4,now(),case when $6::text is not null then nullif($6,'') else
                (select author_summary from public.article_revision where article_id=$1 and revision=$5) end)
            """, state.Id, state.Revision, state.Title, state.Body, rollback?.SourceRevision ?? edit.ExpectedRevision,
            new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)summary?.Text ?? DBNull.Value }))
            await revision.ExecuteNonQueryAsync(ct);
        if (rollback is null)
            await Authoring.PropertyStore.CaptureSnapshot(db, tx, actor.Id, state.Id, state.Revision, ct);
        else
            await Authoring.PropertyStore.CopySnapshot(db, tx, state.Id, rollback.SourceRevision, state.Revision, ct);
        if (bodyInsertion is not null)
            await Authoring.ArticleBodyInsertionStore.Record(db, tx, state.Id, state.Revision, edit.ExpectedRevision, bodyInsertion, ct);
        if (taxonomy is not null)
            await Content.TaxonomyStore.Replace(db, tx, state.Id, state.Revision, taxonomy.CategoryId, taxonomy.TagIds, ct);
        else if (edit.Id != 0)
            await Content.TaxonomyStore.CarryForward(db, tx, state.Id, rollback?.SourceRevision ?? edit.ExpectedRevision, state.Revision, ct);
        if (rights is not null || edit.Id == 0)
            await Authoring.PublicationRightsStore.Insert(db, tx,
                rights is null ? Wire.DefaultRights(state.Id, state.Revision) : Wire.RightsPolicy(rights, state.Revision), ct);
        else
            await Authoring.PublicationRightsStore.CarryForward(db, tx, state.Id, rollback?.SourceRevision ?? edit.ExpectedRevision, state.Revision, ct);
        if (edit.Id != 0)
            await Content.ArticleMediaStore.Copy(db, tx, actor, state.Id, rollback?.SourceRevision ?? edit.ExpectedRevision,
                state.Revision, attachment, ct);
        await using (var record = Sql(db, tx, """
            insert into public.article_command(actor_id,command_id,fingerprint,article_id,revision,title,body,published)
            values($1,$2,$3,$4,$5,$6,$7,$8)
            """, actor.Id, edit.Key, fingerprint, state.Id, state.Revision, state.Title, state.Body, state.PublishedRevision.HasValue))
            await record.ExecuteNonQueryAsync(ct);
        if (action is ArticleAction.Publish or ArticleAction.Retract or ArticleAction.Delete)
            await Authoring.PublicationHistoryStore.Apply(db, tx, actor.Id, edit.Key, action, current!, state, ct, images);
        if (rollback is not null)
            await Authoring.RevisionHistoryStore.RecordRollback(db, tx, actor, state.Revision, rollback, ct);
        if (schedule is not null)
            await Authoring.ArticleScheduleStore.Record(db, tx, actor, state, schedule, ct);
        else if (edit.Id != 0)
            await Authoring.ArticleScheduleStore.Clear(db, tx, state.Id, ct);
        if (action == ArticleAction.Publish)
            await Authoring.PublicationHistoryStore.RecordPublishedOutbox(db, tx, state.Id, state.Revision, ct);
        else
        {
            await using var enqueue = Sql(db, tx, "insert into public.blog_outbox(article_id,revision,kind) values($1,$2,$3)",
                state.Id, state.Revision, attachment is not null ? "draft-media" : rights is not null ? "rights" : schedule is not null ? (schedule.DueUnixMs == 0 ? "schedule-cancel" : "schedule") :
                rollback is null ? action.ToString().ToLowerInvariant() : "draft-rollback");
            await enqueue.ExecuteNonQueryAsync(ct);
        }
        return (state, true);
    }

    internal static async Task<ArticleRightsPolicy> SetRights(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleRightsCommand input, CancellationToken ct)
    {
        var edit = new Edit(input.Id, input.ExpectedRevision, input.IdempotencyKey, "", "");
        var saved = await Execute(db, tx, actor, ArticleAction.Save, edit, ct, null, rights: input);
        return await Authoring.PublicationRightsStore.Read(db, tx, saved.Article.Id, saved.Article.Revision, ct);
    }

    internal static async Task<ArticleState> SetPrivateAttachment(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleMediaCommand input, CancellationToken ct)
    {
        var edit = new Edit(input.Id, input.ExpectedRevision, input.IdempotencyKey, "", "");
        var saved = await Execute(db, tx, actor, ArticleAction.Save, edit, ct, null, attachment: input);
        return saved.Article;
    }

    internal static async Task<ArticleSchedule> Schedule(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleScheduleCommand input, CancellationToken ct)
    {
        var edit = new Edit(input.Id, input.ExpectedRevision, input.IdempotencyKey, "", "");
        var saved = await Execute(db, tx, actor, ArticleAction.Save, edit, ct, null, schedule: input);
        return await Authoring.ArticleScheduleStore.ReadReceipt(db, tx, actor.Id, input.IdempotencyKey, saved.Article, ct);
    }

    internal static byte[]? TokenDigest(string? token)
    {
        if (token is not { Length: 64 } || !token.All(c => char.IsAsciiHexDigitLower(c))) return null;
        return SHA256.HashData(Convert.FromHexString(token));
    }

    private static BusinessException Unauthenticated() => new(Rejection.Unauthorized, "Session or sign-in ticket is invalid or expired.");
}
