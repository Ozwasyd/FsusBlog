using static FsusBlog.V2.Server.SqlCommands;

namespace FsusBlog.V2.Server;

internal sealed class Store(NpgsqlDataSource source, InstanceLease? lease = null)
{
    internal static NpgsqlCommand Sql(NpgsqlConnection db, NpgsqlTransaction? transaction, string sql, params object[] parameters) =>
        Create(db, transaction, sql, parameters);

    internal Task<(string Token, Identity User)> SignIn(string token, CancellationToken ct)
    {
        if (TokenDigest(token) is not { } ticket) throw Unauthenticated();
        return InstanceLease.RunProtected(source, lease, async (db, tx) =>
        {
            var (id, name, generation) = await QueryRequired(db, tx, ct, """
                select id,name,generation from public.blog_user where enabled and
                    id=(select user_id from public.login_ticket where digest=$1 and expires_at>clock_timestamp()) for update
                """, r => (r.GetGuid(0), r.GetString(1), r.GetInt64(2)), Unauthenticated, ticket);
            if (await CurrentSchema.RequiresSiteRecoveryAsync(db, tx, id, ct)) throw Unauthenticated();
            if (await SqlCommands.Execute(db, tx, ct, """
                delete from public.login_ticket where digest=$1 and user_id=$2 and expires_at>clock_timestamp()
                    and not exists(select 1 from public.passkey_credential where user_id=$2)
                """, ticket, id) != 1) throw Unauthenticated();

            var secret = RandomNumberGenerator.GetBytes(32);
            var expiry = (DateTime)(await Scalar(db, tx, ct, """
                insert into public.user_session(digest,user_id,generation,expires_at)
                values($1,$2,$3,clock_timestamp()+interval '8 hours') returning expires_at
                """, SHA256.HashData(secret), id, generation))!;
            return (Convert.ToHexStringLower(secret), new Identity(id, name, generation, false, expiry));
        }, ct);
    }

    internal Task<T> WithSession<T>(string? token, bool author, Func<NpgsqlConnection, NpgsqlTransaction, Identity, Task<T>> run, CancellationToken ct) =>
        WithSession(token, author, lockAccount: false, run, ct);

    internal Task<T> WithSessionForAccountUpdate<T>(string? token, Func<NpgsqlConnection, NpgsqlTransaction, Identity, Task<T>> run, CancellationToken ct) =>
        WithSession(token, author: false, lockAccount: true, run, ct);

    private Task<T> WithSession<T>(string? token, bool author, bool lockAccount,
        Func<NpgsqlConnection, NpgsqlTransaction, Identity, Task<T>> run, CancellationToken ct)
    {
        if (TokenDigest(token) is not { } digest) throw Unauthenticated();
        return InstanceLease.RunProtected(source, lease, async (db, tx) =>
        {
            Identity actor;
            if (author)
            {
                actor = await VerifyLiveAdminAsync(db, tx, digest, ct);
            }
            else
            {
                if (lockAccount && await Scalar(db, tx, ct, """
                    select id from public.blog_user where enabled
                    and id=(select user_id from public.user_session where digest=$1) for update
                    """, digest) is null) throw Unauthenticated();
                actor = await QueryRequired(db, tx, ct, """
                    select u.id,u.name,u.generation,s.expires_at
                    from public.blog_user u join public.user_session s on s.user_id=u.id
                    where u.enabled and s.digest=$1 and u.generation=s.generation and s.expires_at>clock_timestamp()
                    """ + (lockAccount ? " for update of s" : " for share of u,s"),
                    r => new Identity(r.GetGuid(0), r.GetString(1), r.GetInt64(2), false, r.GetFieldValue<DateTimeOffset>(3)),
                    Unauthenticated, digest);
            }
            var result = await run(db, tx, actor);
            if (actor.ExpiresAt <= DateTimeOffset.UtcNow) throw Unauthenticated();
            return result;
        }, ct);
    }

    internal static async Task<Identity> VerifyLiveAdminAsync(NpgsqlConnection db, NpgsqlTransaction tx, byte[] digest, CancellationToken ct)
    {
        var (principal, handle, generation) = await QueryRequired(db, tx, ct, """
            select id,handle,generation from public.admin_principal where enabled
            and id=(select principal_id from public.admin_session where digest=$1)
            for share
            """, r => (r.GetGuid(0), r.GetString(1), r.GetInt64(2)), Unauthenticated, digest);
        var expiresAt = await Scalar(db, tx, ct, """
            select expires_at from public.admin_session where digest=$1 and principal_id=$2 and generation=$3
            and expires_at>clock_timestamp()
            and exists (select from public.admin_passkey_credential where principal_id=$2)
            for share
            """, digest, principal, generation) is DateTime expiry
            ? new DateTimeOffset(expiry)
            : throw Unauthenticated();
        return new(principal, handle, generation, true, expiresAt);
    }

    internal Task SignOut(string? token, CancellationToken ct) =>
        TokenDigest(token) is not { } digest ? Task.CompletedTask :
        InstanceLease.RunProtected(source, lease, (db, tx) => SqlCommands.Execute(db, tx, ct, "delete from public.user_session where digest=$1", digest), ct);

    internal static async Task<ArticleState> Find(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, int id, bool locking,
        CancellationToken ct, bool includeDeleted = false)
    {
        const string owned = "from public.article a where a.id=$1 and ($2 or not a.deleted)";
        if (locking && await Scalar(db, tx, ct, $"select a.id {owned} for update", id, includeDeleted) is null)
            throw new BusinessException(Rejection.NotFound, "Article not found.");
        // A fresh statement after locking observes the archive event committed by any prior holder.
        return await QueryRequired(db, tx, ct, $"""
            select revision,title,body,published_revision,deleted
            {owned} and {ArchivedArticleAuthority.Available}
            """, r => new ArticleState(id, actor.Id, r.GetInt64(0), r.GetString(1), r.GetString(2),
                r.IsDBNull(3) ? null : r.GetInt64(3), r.GetBoolean(4)),
            () => new BusinessException(Rejection.NotFound, "Article not found."), id, includeDeleted);
    }

    internal static Task LockCommand(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor, Guid commandKey, CancellationToken ct) =>
        SqlCommands.LockCommand(db, tx, actor, commandKey, ct);

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
        var saved = await Execute(db, tx, actor, ArticleAction.Save, MetaEdit(input.Id, input.ExpectedRevision, input.IdempotencyKey), ct, input);
        return await Content.TaxonomyStore.ReadDraft(db, tx, saved.Article.Id, saved.Article.Revision, ct);
    }

    internal static async Task<ArticleState> RollbackDraft(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        DraftRollback input, CancellationToken ct) =>
        (await Execute(db, tx, actor, ArticleAction.Save, MetaEdit(input.Id, input.ExpectedRevision, input.IdempotencyKey), ct, null, input)).Article;

    internal static async Task<ArticleState> SetSummary(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleSummaryCommand input, CancellationToken ct)
    {
        if (input.Text.Any(character => char.IsControl(character) && character is not ('\r' or '\n' or '\t')))
            throw new BusinessException(Rejection.Invalid, "The article summary contains unsupported control characters.");
        return (await Execute(db, tx, actor, ArticleAction.Save, MetaEdit(input.Id, input.ExpectedRevision, input.IdempotencyKey), ct, null,
            summary: input with { Text = input.Text.Trim() })).Article;
    }

    private static async Task<(ArticleState Article, bool Changed)> Execute(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleAction action, Edit edit, CancellationToken ct, TaxonomyAssignment? taxonomy, DraftRollback? rollback = null,
        ArticleScheduleCommand? schedule = null, ArticleRightsCommand? rights = null, ArticleMediaCommand? attachment = null,
        (Content.PublishedMediaStore Store, Content.PublishedMediaSelection Selection)? publishedMedia = null,
        ArticleSummaryCommand? summary = null, ArticleBodyInsertionCommand? insertion = null,
        ArticleBodyInsertionsCommand? insertions = null, ArticleBodyEditsCommand? bodyEdits = null, ArticleCoverCommand? cover = null)
    {
        var fingerprint = publishedMedia is { } media ? media.Selection.Fingerprint(edit) :
            attachment is not null ? SHA256.HashData(Wire.EncodeArticleMediaCommand(attachment)) :
            cover is not null ? SHA256.HashData(Wire.EncodeArticleCoverCommand(cover)) :
            rights is not null ? SHA256.HashData(Wire.EncodeArticleRightsCommand(rights)) :
            schedule is not null ? SHA256.HashData(Wire.EncodeArticleScheduleCommand(schedule)) :
            rollback is not null ? SHA256.HashData(Wire.EncodeDraftRollback(rollback)) :
            taxonomy is not null ? SHA256.HashData(Wire.EncodeTaxonomyAssignment(taxonomy)) :
            summary is not null ? SHA256.HashData(Wire.EncodeArticleSummaryCommand(summary)) :
            bodyEdits is not null ? SHA256.HashData(Wire.EncodeArticleBodyEditsCommand(bodyEdits)) :
            insertions is not null ? SHA256.HashData(Wire.EncodeArticleBodyInsertionsCommand(insertions)) :
            insertion is not null ? SHA256.HashData(Wire.EncodeArticleBodyInsertionCommand(insertion)) : Publishing.Fingerprint(action, edit);
        await LockCommand(db, tx, actor.Id, edit.Key, ct);
        var current = taxonomy is not null || rollback is not null || schedule is not null || rights is not null || attachment is not null || cover is not null || summary is not null
            ? await Find(db, tx, actor, edit.Id, true, ct) : null;
        var replay = await QueryOne(db, tx, ct, """
            select fingerprint,article_id,revision,title,body,published from public.article_command where actor_id=$1 and command_id=$2
            """, row =>
        {
            if (!CryptographicOperations.FixedTimeEquals(fingerprint, row.GetFieldValue<byte[]>(0)))
                throw new BusinessException(Rejection.Conflict, "This command key is already in use.");
            return new ArticleState(row.GetInt32(1), actor.Id, row.GetInt64(2), row.GetString(3), row.GetString(4),
                row.GetBoolean(5) ? row.GetInt64(2) : null, action == ArticleAction.Delete);
        }, actor.Id, edit.Key);
        if (replay is not null)
        {
            if (current is null)
            {
                // A command that created the article carries zero as its input ID.
                if (await Scalar(db, tx, ct, "select id from public.article where id=$1 for share", replay.Id) is null)
                    throw new BusinessException(Rejection.NotFound, "Article not found.");
                await ArchivedArticleAuthority.RequireLockedAvailability(db, tx, replay.Id, ct);
            }
            return (replay, false);
        }
        ArticleState state;
        ArticleBodyInsertionWitness? bodyInsertion = null;
        IReadOnlyList<Content.PublishedMediaReference>? images = null;
        if (edit.Id == 0)
        {
            var id = (int)(await Scalar(db, tx, ct, """
                insert into public.article(owner_id,revision,title,body,deleted) values($1,1,$2,$3,false) returning id
                """, actor.Id, edit.Title, edit.Body))!;
            state = new(id, actor.Id, 1, edit.Title, edit.Body, null, false);
        }
        else
        {
            current ??= await Find(db, tx, actor, edit.Id, true, ct, includeDeleted: action == ArticleAction.Restore);
            if (taxonomy is not null || rights is not null || attachment is not null || cover is not null || summary is not null)
                edit = edit with { Title = current.Title, Body = current.Body };
            if (schedule is not null)
            {
                RevisionHistoryStore.RequireRevision(current.Revision, schedule.ExpectedRevision);
                await ArticleScheduleStore.Validate(db, tx, current, schedule, ct);
                edit = edit with { Title = current.Title, Body = current.Body };
            }
            if (rollback is not null)
            {
                RevisionHistoryStore.RequireRevision(current.Revision, rollback.ExpectedRevision);
                var source = await RevisionHistoryStore.ReadSource(db, tx, edit.Id, rollback.SourceRevision, ct);
                edit = edit with { Title = source.Title, Body = source.Body };
            }
            state = Publishing.Change(action, edit, current, actor);
            if (insertion is not null || insertions is not null || bodyEdits is not null)
            {
                var sourceBody = (await RevisionHistoryStore.ReadSource(db, tx, edit.Id, edit.ExpectedRevision, ct)).Body;
                if (insertion is not null)
                    bodyInsertion = ArticleBodyInsertionStore.Prepare(sourceBody, state.Body, insertion.Offset, insertion.Length);
                else if (insertions is not null &&
                    ArticleBodyInsertionStore.PrepareSequence(sourceBody, state.Body, insertions.Insertions) is { } witness &&
                    await CurrentSchema.HasArticleBodyInsertionOperationsAsync(db, tx, ct))
                    bodyInsertion = witness;
                else if (bodyEdits is not null)
                    bodyInsertion = ArticleBodyInsertionStore.PrepareEdits(sourceBody, state.Body, bodyEdits.Edits);
            }
            if (publishedMedia is { } share)
                images = await share.Store.Prepare(db, tx, actor.Id, edit.Id, edit.ExpectedRevision, share.Selection, ct);
            await UpdateArticleHead(db, tx, state, ct);
        }
        var sourceRevision = rollback?.SourceRevision ?? edit.ExpectedRevision;
        await InsertRevision(db, tx, state, sourceRevision, summary?.Text, ct);
        if (rollback is null)
            await PropertyStore.CaptureSnapshot(db, tx, actor.Id, state.Id, state.Revision, ct);
        else
            await PropertyStore.CopySnapshot(db, tx, state.Id, rollback.SourceRevision, state.Revision, ct);
        if (bodyInsertion is not null)
            await ArticleBodyInsertionStore.Record(db, tx, state.Id, state.Revision, edit.ExpectedRevision, bodyInsertion, ct);
        if (taxonomy is not null)
            await Content.TaxonomyStore.Replace(db, tx, state.Id, state.Revision, taxonomy.CategoryId, taxonomy.TagIds, ct);
        else if (edit.Id != 0)
            await Content.TaxonomyStore.CarryForward(db, tx, state.Id, sourceRevision, state.Revision, ct);
        if (rights is not null || edit.Id == 0)
            await PublicationRightsStore.Insert(db, tx,
                rights is null ? Wire.DefaultRights(state.Id, state.Revision) : Wire.RightsPolicy(rights, state.Revision), ct);
        else
            await PublicationRightsStore.CarryForward(db, tx, state.Id, sourceRevision, state.Revision, ct);
        if (edit.Id != 0)
            await Content.ArticleMediaStore.Copy(db, tx, actor.Id, state.Id, sourceRevision,
                state.Revision, attachment, ct, cover);
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_command(actor_id,command_id,fingerprint,article_id,revision,title,body,published)
            values($1,$2,$3,$4,$5,$6,$7,$8)
            """, actor.Id, edit.Key, fingerprint, state.Id, state.Revision, state.Title, state.Body, state.PublishedRevision.HasValue);
        if (action is ArticleAction.Publish or ArticleAction.Retract or ArticleAction.Delete)
            await PublicationHistoryStore.Apply(db, tx, actor.Id, edit.Key, action, current!, state, ct, images);
        if (rollback is not null)
            await RevisionHistoryStore.RecordRollback(db, tx, actor, state.Revision, rollback, ct);
        if (schedule is not null)
            await ArticleScheduleStore.Record(db, tx, actor, state, schedule, ct);
        else if (edit.Id != 0)
            await ArticleScheduleStore.Clear(db, tx, state.Id, ct);
        if (action == ArticleAction.Publish)
            await PublicationHistoryStore.RecordPublishedOutbox(db, tx, state.Id, state.Revision, ct);
        else
            await EnqueueRevision(db, tx, state, attachment is not null || cover is not null ? "draft-media" : rights is not null ? "rights" :
                schedule is not null ? (schedule.DueUnixMs == 0 ? "schedule-cancel" : "schedule") :
                rollback is null ? action.ToString().ToLowerInvariant() : "draft-rollback", ct);
        return (state, true);
    }

    internal static async Task WriteRecoveredDraft(NpgsqlConnection db, NpgsqlTransaction tx, ArticleState draft,
        long sourceRevision, CancellationToken ct)
    {
        await UpdateArticleHead(db, tx, draft, ct);
        await InsertRevision(db, tx, draft, sourceRevision, null, ct);
        await PropertyStore.CaptureSnapshot(db, tx, draft.Owner, draft.Id, draft.Revision, ct);
        await Content.TaxonomyStore.CarryForward(db, tx, draft.Id, sourceRevision, draft.Revision, ct);
        await PublicationRightsStore.CarryForward(db, tx, draft.Id, sourceRevision, draft.Revision, ct);
        await Content.ArticleMediaStore.Copy(db, tx, draft.Owner, draft.Id, sourceRevision, draft.Revision, null, ct);
        await ArticleScheduleStore.Clear(db, tx, draft.Id, ct);
        await EnqueueRevision(db, tx, draft, "restore", ct);
    }

    private static Task UpdateArticleHead(NpgsqlConnection db, NpgsqlTransaction tx, ArticleState state, CancellationToken ct) =>
        SqlCommands.Execute(db, tx, ct, """
            update public.article set revision=$2,title=$3,body=$4,published_revision=$5,deleted=$6,updated_at=now() where id=$1
            """, state.Id, state.Revision, state.Title, state.Body,
            Optional(NpgsqlDbType.Bigint, state.PublishedRevision), state.Deleted);

    private static Task InsertRevision(NpgsqlConnection db, NpgsqlTransaction tx, ArticleState state, long sourceRevision,
        string? summary, CancellationToken ct) =>
        SqlCommands.Execute(db, tx, ct, """
            insert into public.article_revision(article_id,revision,title,body,happened_at,author_summary)
            values($1,$2,$3,$4,now(),case when $6::text is not null then nullif($6,'') else
                (select author_summary from public.article_revision where article_id=$1 and revision=$5) end)
            """, state.Id, state.Revision, state.Title, state.Body, sourceRevision, Optional(NpgsqlDbType.Text, summary));

    private static Task EnqueueRevision(NpgsqlConnection db, NpgsqlTransaction tx, ArticleState state, string kind, CancellationToken ct) =>
        SqlCommands.Execute(db, tx, ct, "insert into public.blog_outbox(article_id,revision,kind) values($1,$2,$3)",
            state.Id, state.Revision, kind);

    internal static async Task<ArticleRightsPolicy> SetRights(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleRightsCommand input, CancellationToken ct)
    {
        var saved = await Execute(db, tx, actor, ArticleAction.Save, MetaEdit(input.Id, input.ExpectedRevision, input.IdempotencyKey), ct, null, rights: input);
        return await PublicationRightsStore.Read(db, tx, saved.Article.Id, saved.Article.Revision, ct);
    }

    internal static async Task<ArticleState> SetPrivateAttachment(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleMediaCommand input, CancellationToken ct) =>
        (await Execute(db, tx, actor, ArticleAction.Save, MetaEdit(input.Id, input.ExpectedRevision, input.IdempotencyKey), ct, null, attachment: input)).Article;

    internal static async Task<ArticleState> SetCover(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleCoverCommand input, CancellationToken ct)
    {
        if (!await CurrentSchema.HasArticleCoverAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Saved article covers are unavailable.");
        return (await Execute(db, tx, actor, ArticleAction.Save, MetaEdit(input.Id, input.ExpectedRevision, input.IdempotencyKey), ct, null, cover: input)).Article;
    }

    internal static async Task<ArticleSchedule> Schedule(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
        ArticleScheduleCommand input, CancellationToken ct)
    {
        var saved = await Execute(db, tx, actor, ArticleAction.Save, MetaEdit(input.Id, input.ExpectedRevision, input.IdempotencyKey), ct, null, schedule: input);
        return await ArticleScheduleStore.ReadReceipt(db, tx, actor.Id, input.IdempotencyKey, saved.Article, ct);
    }

    private static Edit MetaEdit(int id, long expectedRevision, Guid key) => new(id, expectedRevision, key, "", "");

    internal static byte[]? TokenDigest(string? token) =>
        token is { Length: 64 } && token.All(char.IsAsciiHexDigitLower) ? SHA256.HashData(Convert.FromHexString(token)) : null;

    private static BusinessException Unauthenticated() => new(Rejection.Unauthorized, "Session or sign-in ticket is invalid or expired.");
}
