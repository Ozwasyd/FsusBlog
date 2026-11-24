namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminArticleRollbackStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal const int AdminArticleDraftRollbackStatus = 0;

    internal Task CheckArticleRollbackAvailability(string? session, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (_, _, _) => Task.FromResult(true), ct);

    internal Task CheckArticleDraftRollbackAvailability(string? session, CancellationToken ct) =>
        CheckAvailability(gate, session, RequireArticleDraftRollbackSchema, ct);

    internal Task<AdminArticleRollbackPreview> PreviewArticleRollback(string? session, int article, long revision,
        CancellationToken ct) => gate.WithLiveAdmin(session, async (db, tx, _) =>
    {
        var state = await ReadRollbackTarget(db, tx, article, revision, locking: false, ct);
        return new AdminArticleRollbackPreview(article, state.CurrentRevision, state.CurrentPublication, revision,
            state.SourcePublication, state.SourceTitle, state.Blocker == AdminArticleRollbackBlock.Ready, (int)state.Blocker);
    }, ct);

    internal Task<byte[]> BeginArticleRollbackStepUp(string? session, AdminArticleRollbackIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, ArticleRollbackIntentDigest(intent), async (db, tx, _) =>
            RequireRollbackTarget(await ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: false, ct), intent),
            ct, AdminStepUpAction.PublishArticleRollback);

    internal Task<byte[]> CompleteArticleRollbackStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.PublishArticleRollback, ct);

    internal Task<byte[]> BeginArticleDraftRollbackStepUp(string? session, AdminArticleDraftRollbackIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, ArticleDraftRollbackIntentDigest(intent), async (db, tx, _) =>
        {
            await RequireArticleDraftRollbackSchema(db, tx, ct);
            RequireRollbackTarget(await ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: false, ct), DraftCoordinates(intent));
        }, ct, AdminStepUpAction.DraftArticleRollback);

    internal Task<byte[]> CompleteArticleDraftRollbackStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.DraftArticleRollback, ct, RequireArticleDraftRollbackSchema);

    internal Task<AdminArticleRollbackReceipt> ExecuteArticleRollback(string? session, string? proof, AdminArticleRollbackIntent intent,
        Action invalidatePublic, CancellationToken ct) =>
        ExecuteRollbackAsync(gate, stepUp, session, proof, intent, ArticleRollbackIntentDigest(intent),
            AdminStepUpAction.PublishArticleRollback, Wire.AdminArticleRestoreStatus, invalidatePublic, ct);

    internal async Task<AdminArticleDraftRollbackReceipt> ExecuteArticleDraftRollback(string? session, string? proof,
        AdminArticleDraftRollbackIntent intent, Action invalidatePublic, CancellationToken ct)
    {
        var r = await ExecuteRollbackAsync(gate, stepUp, session, proof, DraftCoordinates(intent),
            ArticleDraftRollbackIntentDigest(intent), AdminStepUpAction.DraftArticleRollback,
            AdminArticleDraftRollbackStatus, invalidatePublic, ct);
        return new(r.ArticleId, r.Revision, r.SourceRevision, r.PreviousPublicationId, r.PublicationId,
            r.PublicationNo, r.PublishedUnixMs, r.RightsSnapshotId, r.ResponsibilitySnapshotId, intent.TargetStatus);
    }

    internal static Task<AdminArticleRollbackReceipt> ExecuteRollbackAsync(AdminSessionGate gate, AdminStepUpService stepUp,
        string? session, string? proof, AdminArticleRollbackIntent intent, byte[] fingerprint, AdminStepUpAction action,
        int destination, Action invalidatePublic, CancellationToken ct) =>
        RunRollback(gate, stepUp, session, proof, intent.IdempotencyKey, fingerprint, action, destination, fromArchive: false,
            action switch
            {
                AdminStepUpAction.DraftArticleRollback => RequireArticleDraftRollbackSchema,
                AdminStepUpAction.ArticleArchive => AdminArticleArchiveStore.RequireArticleArchiveSchema,
                _ => null
            }, async (db, tx, admin) =>
            {
                var stage = await ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: true, ct);
                RequireRollbackTarget(stage, intent);
                return await ApplyRollback(db, tx, admin, intent.ArticleId, stage.CurrentRevision, intent.SourceRevision,
                    stage.CurrentPublication, stage.SourcePublication, stage.SourceTitle, stage.SourceBody, stage.SourceResponsibility!.Value,
                    intent.IdempotencyKey, fingerprint, intent.Reason, destination, restored: null, invalidatePublic, ct);
            }, ct);

    internal static Task<AdminArticleRollbackReceipt> RunRollback(AdminSessionGate gate, AdminStepUpService stepUp,
        string? session, string? proof, Guid commandId, byte[] fingerprint, AdminStepUpAction action, int destination, bool fromArchive,
        Func<NpgsqlConnection, NpgsqlTransaction, CancellationToken, Task>? requireSchema,
        Func<NpgsqlConnection, NpgsqlTransaction, AdminLiveSession, Task<AdminArticleRollbackReceipt>> execute, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            if (requireSchema is not null) await requireSchema(db, tx, ct);
            await Store.LockCommand(db, tx, admin.Id, commandId, ct);
            if (await ReadRetainedRollback(db, tx, admin.Id, commandId, fingerprint, action, destination, fromArchive, ct) is { } retained)
                return retained;
            await stepUp.RequireProofAsync(db, tx, admin, proof, fingerprint, ct, action, action switch
            {
                AdminStepUpAction.DraftArticleRollback => "A current Passkey proof for this exact draft rollback is required.",
                AdminStepUpAction.ArticleArchive => "A current Passkey proof for this exact archive transition is required.",
                AdminStepUpAction.RestoreDeletedPublication => "A current Passkey proof for this exact restoration of a former publication is required.",
                _ => "A current Passkey proof for this exact published rollback is required."
            });
            return await execute(db, tx, admin);
        }, ct);

    internal static async Task<AdminArticleRollbackReceipt> ApplyRollback(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminLiveSession admin, int article, long previousRevision, long sourceRevision, long previousRelease, long sourcePublication,
        string title, string body, long? responsibility, Guid commandId, byte[] fingerprint, string reason, int destination,
        PublicationHistoryStore.AdminPublicationRestoreSource? restored, Action invalidatePublic, CancellationToken ct,
        bool wasDeleted = false, IReadOnlyList<PublishedMediaReference>? assets = null, Guid? copyMediaOwner = null)
    {
        var revision = checked(previousRevision + 1);
        if (await SqlCommands.Execute(db, tx, ct, """
            update public.article set revision=$2,title=$3,body=$4,deleted=false,
                published_revision=case when $6 then $2 else null end,updated_at=clock_timestamp()
            where id=$1 and revision=$5 and deleted=$7
            """, article, revision, title, body, previousRevision, destination == Wire.AdminArticleRestoreStatus, wasDeleted) != 1)
            throw new BusinessException(Rejection.Conflict, "The article has changed.");
        if (await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_revision(article_id,revision,title,body,happened_at,author_summary)
            select $1,$2,$3,$4,clock_timestamp(),author_summary from public.article_revision
            where article_id=$1 and revision=$5
            """, article, revision, title, body, sourceRevision) != 1)
            throw new BusinessException(Rejection.Conflict, "The rollback source is unavailable.");
        await PropertyStore.CopySnapshot(db, tx, article, sourceRevision, revision, ct);
        await TaxonomyStore.CarryForward(db, tx, article, sourceRevision, revision, ct);
        await PublicationRightsStore.CarryForward(db, tx, article, sourceRevision, revision, ct);
        if (copyMediaOwner is { } owner)
            await ArticleMediaStore.Copy(db, tx, owner, article, sourceRevision, revision, null, ct);
        var release = await PublicationHistoryStore.RollbackByAdministrator(db, tx, article, previousRelease,
            sourceRevision, revision, previousRevision, sourcePublication, responsibility, admin.Id, commandId,
            fingerprint, reason, destination, restored, ct, assets);
        invalidatePublic();
        return new(article, revision, sourceRevision, previousRelease, release.Id, release.Number,
            new DateTimeOffset(release.PublishedAt).ToUnixTimeMilliseconds(), release.RightsSnapshot, release.ResponsibilitySnapshot);
    }

    private static Task<AdminArticleRollbackReceipt?> ReadRetainedRollback(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid administrator, Guid command, byte[] fingerprint, AdminStepUpAction action, int destination, bool fromArchive, CancellationToken ct)
    {
        var typedDestination = action != AdminStepUpAction.PublishArticleRollback;
        var archive = action == AdminStepUpAction.ArticleArchive;
        var trash = action == AdminStepUpAction.RestoreDeletedPublication;
        return SqlCommands.QueryOne(db, tx, ct, $"""
            select fingerprint,article_id,revision,{(fromArchive ? "previous_revision" : "source_revision")},
                previous_publication_id,publication_id,publication_no,published_at,rights_snapshot_id,responsibility_snapshot_id,
                {(typedDestination ? "destination" : "2")},{(archive ? "from_archive" : "false")}{(trash ? ",from_trash" : "")}
            from public.admin_article_rollback where principal_id=$1 and command_id=$2
            """, receipt =>
        {
            if (!CryptographicOperations.FixedTimeEquals(receipt.GetFieldValue<byte[]>(0), fingerprint) ||
                receipt.GetInt32(10) != destination || receipt.GetBoolean(11) != fromArchive || (trash && !receipt.GetBoolean(12)))
                throw new BusinessException(Rejection.Conflict, "This administrator rollback command key is already in use.");
            return new AdminArticleRollbackReceipt(receipt.GetInt32(1), receipt.GetInt64(2), receipt.GetInt64(3),
                receipt.GetInt64(4), receipt.GetInt64(5), receipt.GetInt32(6),
                new DateTimeOffset(receipt.GetDateTime(7)).ToUnixTimeMilliseconds(), receipt.GetInt64(8), receipt.GetInt64(9));
        }, administrator, command);
    }

    internal static Task CheckAvailability(AdminSessionGate gate, string? session,
        Func<NpgsqlConnection, NpgsqlTransaction, CancellationToken, Task> require, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) => { await require(db, tx, ct); return true; }, ct);

    internal static async Task RequireSchema(Task<bool> available, string message)
    {
        if (!await available) throw new BusinessException(Rejection.NotFound, message);
    }

    internal static async Task LockArticle(NpgsqlConnection db, NpgsqlTransaction tx, int article, bool deleted,
        Func<BusinessException> notFound, CancellationToken ct)
    {
        if (await SqlCommands.Scalar(db, tx, ct,
            $"select id from public.article where id=$1 and {(deleted ? "deleted" : "not deleted")} for update", article) is null)
            throw notFound();
    }

    internal static byte[] ArticleRollbackIntentDigest(AdminArticleRollbackIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleRollbackIntent(intent));

    internal static byte[] ArticleDraftRollbackIntentDigest(AdminArticleDraftRollbackIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleDraftRollbackIntent(intent));

    private static AdminArticleRollbackIntent DraftCoordinates(AdminArticleDraftRollbackIntent intent) =>
        new(intent.ArticleId, intent.ExpectedRevision, intent.ExpectedPublicationId, intent.SourceRevision, intent.IdempotencyKey, intent.Reason);

    private static Task RequireArticleDraftRollbackSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        RequireSchema(CurrentSchema.HasAdminArticleDraftRollbackSchemaAsync(db, tx, ct), "Draft rollback is unavailable.");

    internal sealed record ArticleRollbackTarget(long CurrentRevision, long CurrentPublication, long SourcePublication,
        string SourceTitle, string SourceBody, long? SourceResponsibility, AdminArticleRollbackBlock Blocker);

    internal static async Task<ArticleRollbackTarget> ReadRollbackTarget(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        long sourceRevision, bool locking, CancellationToken ct)
    {
        if (locking)
            await LockArticle(db, tx, article, deleted: false,
                () => new BusinessException(Rejection.NotFound, "Article is unavailable for published rollback."), ct);
        return await SqlCommands.QueryRequired(db, tx, ct, """
            select a.revision,p.publication_id,source.publication_id,r.title,case when $3 then r.body else '' end,linked.snapshot_id,
                   (rights.id is not null and policy.article_id is not null),
                   exists(select from public.article_revision_media where article_id=a.id and revision=r.revision),
                   exists(select from public.article_schedule where article_id=a.id),a.revision<>p.revision
            from public.article a join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
            join public.article_revision r on r.article_id=a.id and r.revision=$2 and r.revision<a.revision
            join public.article_publication_history source on source.article_id=a.id and source.revision=r.revision
                and source.publication_id is not null and source.publication_no<=p.publication_no
            left join public.article_publication_rights rights on rights.article_id=a.id and rights.revision=r.revision
                and rights.publication_id=source.publication_id
            left join public.article_revision_rights policy on policy.article_id=rights.article_id and policy.revision=rights.revision
            left join public.article_publication_responsibility linked on linked.article_id=a.id and linked.revision=r.revision
                and linked.publication_id=source.publication_id
            where a.id=$1 and not a.deleted
            """, row =>
        {
            long? responsibility = row.IsDBNull(5) ? null : row.GetInt64(5);
            var blocker = row.GetBoolean(8) ? AdminArticleRollbackBlock.PendingSchedule :
                row.GetBoolean(9) ? AdminArticleRollbackBlock.UnpublishedDraft :
                row.GetBoolean(7) ? AdminArticleRollbackBlock.PrivateAttachment :
                !row.GetBoolean(6) ? AdminArticleRollbackBlock.MissingRights :
                responsibility is null ? AdminArticleRollbackBlock.MissingResponsibility : AdminArticleRollbackBlock.Ready;
            return new ArticleRollbackTarget(row.GetInt64(0), row.GetInt64(1), row.GetInt64(2), row.GetString(3), row.GetString(4), responsibility, blocker);
        }, () => new BusinessException(Rejection.NotFound, "The requested historical publication is unavailable for this article."),
            article, sourceRevision, locking);
    }

    internal static void RequireRollbackTarget(ArticleRollbackTarget current, AdminArticleRollbackIntent intent)
    {
        if (current.CurrentRevision != intent.ExpectedRevision || current.CurrentPublication != intent.ExpectedPublicationId)
            throw new BusinessException(Rejection.Conflict, "The current revision or publication changed.");
        if (current.CurrentRevision == long.MaxValue)
            throw new BusinessException(Rejection.Conflict, "The article revision limit was reached.");
        if (current.Blocker != AdminArticleRollbackBlock.Ready)
            throw new BusinessException(Rejection.Conflict, current.Blocker switch
            {
                AdminArticleRollbackBlock.MissingRights => "The historical publication rights snapshot is missing.",
                AdminArticleRollbackBlock.MissingResponsibility => "The historical responsibility snapshot is missing.",
                AdminArticleRollbackBlock.PrivateAttachment => "The historical revision includes an unsupported private attachment.",
                AdminArticleRollbackBlock.PendingSchedule => "Resolve the pending publication before performing a published rollback.",
                _ => "Resolve the unpublished draft before performing a published rollback."
            });
    }
}

internal sealed class AdminArticleArchiveStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    private const string CurrentArchive = $"""
        from public.admin_article_rollback archived
        join public.article a on a.id=archived.article_id and a.revision=archived.revision
        join public.article_revision r on r.article_id=a.id and r.revision=a.revision
        join public.article_publication_history h on h.article_id=a.id and h.revision=a.revision
            and h.admin_actor_id=archived.principal_id and h.admin_command_id=archived.command_id
            and h.publication_no=archived.publication_no and h.happened_at=archived.published_at
            and h.kind='retract' and h.reason='{ArchivedArticleAuthority.Reason}'
        where archived.destination=3 and not archived.from_archive and not a.deleted
            and a.published_revision is null and a.publication_count=archived.publication_no
            and not exists(select from public.article_publication where article_id=a.id)
            and not ({ArchivedArticleAuthority.Available})
        """;

    internal Task CheckArticleArchiveAvailability(string? session, CancellationToken ct) =>
        AdminArticleRollbackStore.CheckAvailability(gate, session, RequireArticleArchiveSchema, ct);

    internal Task<AdminArticleArchivePage> ListArchivedArticles(string? session, int before, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            await RequireArticleArchiveSchema(db, tx, ct);
            var limit = WireLimits.AdminArticleArchivePageSize;
            var items = await SqlCommands.QueryList(db, tx, ct, $"""
                select a.id,a.revision,archived.publication_id,archived.publication_no,h.happened_at,a.title
                {CurrentArchive}
                and archived.article_id<$1
                order by archived.article_id desc limit $2
                """, rows => new AdminArticleArchiveRow(rows.GetInt32(0), rows.GetInt64(1), rows.GetInt64(2), rows.GetInt32(3),
                    new DateTimeOffset(rows.GetDateTime(4)).ToUnixTimeMilliseconds(), rows.GetString(5)),
                before > 0 ? before : (long)int.MaxValue + 1, limit + 1);
            return new AdminArticleArchivePage(SqlCommands.TrimPage(items, limit) ? items[^1].ArticleId : 0, items);
        }, ct);

    internal Task<byte[]> PreviewArchivedArticle(string? session, int article, long revision,
        long privateRelease, CancellationToken ct) => gate.WithLiveAdmin(session, async (db, tx, _) =>
    {
        await RequireArticleArchiveSchema(db, tx, ct);
        if (await SqlCommands.Scalar(db, tx, ct, """
            select id from public.article where id=$1 and revision=$2 and not deleted
                and published_revision is null for share
            """, article, revision) is null)
            throw new BusinessException(Rejection.Conflict, "The article no longer has a matching archived release.");
        var archive = await ReadArchivedTarget(db, tx, article, revision, privateRelease, locking: false, includeBody: true, ct);
        return Wire.EncodeAdminArticleArchivePreview(new(article, revision, privateRelease, archive.Title, archive.Body));
    }, ct);

    internal Task<byte[]> BeginArticleArchiveStepUp(string? session, AdminArticleArchiveIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, ArticleArchiveIntentDigest(intent), async (db, tx, _) =>
        {
            await RequireArticleArchiveSchema(db, tx, ct);
            if (intent.TargetStatus == Wire.AdminArticleArchiveStatus)
                AdminArticleRollbackStore.RequireRollbackTarget(
                    await AdminArticleRollbackStore.ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: false, ct),
                    ArchiveCoordinates(intent));
            else
                await ReadArchivedTarget(db, tx, intent.ArticleId, intent.ExpectedRevision, intent.ExpectedReleaseId, locking: false, includeBody: false, ct);
        }, ct, AdminStepUpAction.ArticleArchive);

    internal Task<byte[]> CompleteArticleArchiveStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.ArticleArchive, ct, RequireArticleArchiveSchema);

    internal async Task<AdminArticleArchiveReceipt> ExecuteArticleArchive(string? session, string? proof,
        AdminArticleArchiveIntent intent, Action invalidatePublic, CancellationToken ct)
    {
        var fingerprint = ArticleArchiveIntentDigest(intent);
        var r = intent.TargetStatus == Wire.AdminArticleArchiveStatus
            ? await AdminArticleRollbackStore.ExecuteRollbackAsync(gate, stepUp, session, proof, ArchiveCoordinates(intent),
                fingerprint, AdminStepUpAction.ArticleArchive, intent.TargetStatus, invalidatePublic, ct)
            : await AdminArticleRollbackStore.RunRollback(gate, stepUp, session, proof, intent.IdempotencyKey, fingerprint,
                AdminStepUpAction.ArticleArchive, intent.TargetStatus, fromArchive: true, RequireArticleArchiveSchema,
                async (db, tx, admin) =>
                {
                    var archive = await ReadArchivedTarget(db, tx, intent.ArticleId, intent.ExpectedRevision, intent.ExpectedReleaseId,
                        locking: true, includeBody: true, ct);
                    return await AdminArticleRollbackStore.ApplyRollback(db, tx, admin, intent.ArticleId, intent.ExpectedRevision,
                        intent.SourceRevision, intent.ExpectedReleaseId, intent.ExpectedReleaseId, archive.Title, archive.Body,
                        archive.Responsibility, intent.IdempotencyKey, fingerprint, intent.Reason, intent.TargetStatus, archive.Lineage,
                        invalidatePublic, ct);
                }, ct);
        return new(r.ArticleId, r.Revision, r.SourceRevision, r.PreviousPublicationId, r.PublicationId, r.PublicationNo,
            r.PublishedUnixMs, r.RightsSnapshotId, r.ResponsibilitySnapshotId, intent.TargetStatus);
    }

    internal static byte[] ArticleArchiveIntentDigest(AdminArticleArchiveIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleArchiveIntent(intent));

    private static AdminArticleRollbackIntent ArchiveCoordinates(AdminArticleArchiveIntent intent) =>
        new(intent.ArticleId, intent.ExpectedRevision, intent.ExpectedReleaseId, intent.SourceRevision, intent.IdempotencyKey, intent.Reason);

    internal static Task RequireArticleArchiveSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AdminArticleRollbackStore.RequireSchema(CurrentSchema.HasAdminArticleArchiveSchemaAsync(db, tx, ct),
            "Article archive transitions are unavailable.");

    private sealed record ArchivedTarget(string Title, string Body, long Responsibility, PublicationHistoryStore.AdminPublicationRestoreSource Lineage);

    private static async Task<ArchivedTarget> ReadArchivedTarget(NpgsqlConnection db, NpgsqlTransaction tx,
        int article, long revision, long privateRelease, bool locking, bool includeBody, CancellationToken ct)
    {
        if (locking)
            await AdminArticleRollbackStore.LockArticle(db, tx, article, deleted: false,
                () => new BusinessException(Rejection.NotFound, "The archived article is unavailable."), ct);
        return await SqlCommands.QueryRequired(db, tx, ct, $"""
            select a.revision,archived.publication_id,r.title,
                case when $2 and ($3 or octet_length(r.body)<=$4) then r.body end,
                archived.responsibility_snapshot_id,h.event_no,archived.source_revision,archived.source_publication_id,
                exists(select from public.article_schedule where article_id=a.id),
                exists(select from public.article_revision_media where article_id=a.id and revision=a.revision),
                exists(select from public.article_publication_rights rights
                    join public.article_revision_rights policy on policy.article_id=rights.article_id and policy.revision=rights.revision
                    where rights.id=archived.rights_snapshot_id and rights.publication_id=archived.publication_id
                        and rights.article_id=a.id and rights.revision=a.revision),
                exists(select from public.article_publication_responsibility linked
                    where linked.publication_id=archived.publication_id and linked.article_id=a.id
                        and linked.revision=a.revision and linked.snapshot_id=archived.responsibility_snapshot_id)
            {CurrentArchive}
            and archived.article_id=$1
            """, row =>
        {
            if (row.GetInt64(0) != revision || row.GetInt64(1) != privateRelease)
                throw new BusinessException(Rejection.Conflict, "The archived revision or private release changed.");
            if (revision == long.MaxValue || row.GetBoolean(8) || row.GetBoolean(9) || !row.GetBoolean(10) || !row.GetBoolean(11))
                throw new BusinessException(Rejection.Conflict, "The archived release package is incomplete or a publication is pending.");
            if (includeBody && row.IsDBNull(3))
                throw new BusinessException(Rejection.Conflict, "The archived source exceeds the preview size limit.");
            return new ArchivedTarget(row.GetString(2), includeBody ? row.GetString(3) : "", row.GetInt64(4),
                new(row.GetInt32(5), row.GetInt64(6), row.GetInt64(7)));
        }, () => new BusinessException(Rejection.Conflict, "The article no longer has a matching archived release."),
            article, includeBody, locking, WireLimits.BodyBytes);
    }
}

internal sealed class AdminArticleTrashRestoreStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal const string TrashArticlePredicate = $"""
        a.id=$1 and a.deleted and a.published_revision is null
            and not exists(select from public.article_publication p where p.article_id=a.id)
            and {ArchivedArticleAuthority.Available}
        """;

    private const string TrashArticle = $"from public.article a where {TrashArticlePredicate}";

    internal Task CheckTrashRestoreAvailability(string? session, CancellationToken ct) =>
        AdminArticleRollbackStore.CheckAvailability(gate, session, RequireTrashRestoreSchema, ct);

    internal Task<byte[]> BeginTrashRestoreStepUp(string? session, AdminArticleTrashRestoreIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, TrashRestoreFingerprint(intent), async (db, tx, _) =>
        {
            await RequireTrashRestoreSchema(db, tx, ct);
            if (await SqlCommands.Scalar(db, tx, ct, $"select a.revision {TrashArticle}", intent.ArticleId) is not long revision ||
                revision != intent.ExpectedRevision)
                throw TrashRestoreConflict();
        }, ct, AdminStepUpAction.RestoreArticleTrash);

    internal Task<byte[]> CompleteTrashRestoreStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, request, AdminStepUpAction.RestoreArticleTrash, ct, RequireTrashRestoreSchema);

    internal Task<AdminArticleTrashRestoreReceipt> RestoreFromTrash(string? session, string? proof, AdminArticleTrashRestoreIntent intent,
        CancellationToken ct) => gate.WithLiveAdmin(session, async (db, tx, admin) =>
    {
        await RequireTrashRestoreSchema(db, tx, ct);
        var fingerprint = TrashRestoreFingerprint(intent);
        await Store.LockCommand(db, tx, admin.Id, intent.IdempotencyKey, ct);
        if (await SqlCommands.QueryOne(db, tx, ct, """
            select fingerprint,article_id,revision from public.admin_article_trash_restore
            where principal_id=$1 and command_id=$2
            """, previous => CryptographicOperations.FixedTimeEquals(fingerprint, previous.GetFieldValue<byte[]>(0))
                ? new AdminArticleTrashRestoreReceipt(previous.GetInt32(1), previous.GetInt64(2))
                : throw new BusinessException(Rejection.Conflict, "This administrator command key is already in use."),
            admin.Id, intent.IdempotencyKey) is { } replayed)
            return replayed;
        await stepUp.RequireProofAsync(db, tx, admin, proof, fingerprint, ct, AdminStepUpAction.RestoreArticleTrash,
            "A current Passkey proof for this exact trash restoration is required.");
        if (await SqlCommands.Scalar(db, tx, ct, "select id from public.article where id=$1 for update", intent.ArticleId) is null)
            throw TrashRestoreConflict();
        var current = await SqlCommands.QueryRequired(db, tx, ct, $"select a.owner_id,a.revision,a.title,a.body {TrashArticle}",
            row => new ArticleState(intent.ArticleId, row.GetGuid(0), row.GetInt64(1), row.GetString(2), row.GetString(3), null, true),
            TrashRestoreConflict, intent.ArticleId);
        var draft = Publishing.Restore(current, intent.ExpectedRevision);
        await Store.WriteRecoveredDraft(db, tx, draft, intent.ExpectedRevision, ct);
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.admin_article_trash_restore(principal_id,command_id,fingerprint,article_id,previous_revision,revision)
            values($1,$2,$3,$4,$5,$6)
            """, admin.Id, intent.IdempotencyKey, fingerprint, draft.Id, intent.ExpectedRevision, draft.Revision);
        return new AdminArticleTrashRestoreReceipt(draft.Id, draft.Revision);
    }, ct);

    internal Task<byte[]> DeleteArticle(string? session, int articleId, Action invalidate, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var (revision, title, body, deleted) = await SqlCommands.QueryRequired(db, tx, ct, $"""
                select a.revision,a.title,a.body,a.deleted from public.article a
                where a.id=$1 and {ArchivedArticleAuthority.Available} for update of a
                """, row => (row.GetInt64(0), row.GetString(1), row.GetString(2), row.GetBoolean(3)),
                () => new BusinessException(Rejection.NotFound, "Article not found."), articleId);
            if (deleted) throw new BusinessException(Rejection.NotFound, "Article not found.");
            var actor = new Identity(admin.Id, admin.Snapshot.Handle, admin.Snapshot.Generation, true, DateTimeOffset.MaxValue);
            await Store.Execute(db, tx, actor, ArticleAction.Delete, new Edit(articleId, revision, Guid.NewGuid(), title, body), ct);
            invalidate();
            return Wire.EncodeEmptySuccess();
        }, ct);

    private static Task RequireTrashRestoreSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AdminArticleRollbackStore.RequireSchema(CurrentSchema.HasAdminArticleTrashRestoreAsync(db, tx, ct),
            "Administrator trash restoration is unavailable.");

    private static byte[] TrashRestoreFingerprint(AdminArticleTrashRestoreIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleTrashRestoreIntent(intent));

    internal static BusinessException TrashRestoreConflict() =>
        new(Rejection.Conflict, "The deleted article revision changed. Reload the trash.");
}

internal sealed class AdminArticleTrashPublicationStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    private sealed record FormerPublication(AdminArticleTrashPublicationPreview Preview, Guid Owner, string Body,
        long? Responsibility, int DeleteEvent);

    internal Task CheckTrashPublicationAvailability(string? session, CancellationToken ct) =>
        AdminArticleRollbackStore.CheckAvailability(gate, session, RequireTrashPublicationSchema, ct);

    internal Task<AdminArticleTrashPublicationPreview> PreviewTrashPublication(string? session, int article, long revision, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) => (await ReadFormerPublication(db, tx, article, revision, locking: false, ct)).Preview, ct);

    internal Task<byte[]> BeginTrashPublicationStepUp(string? session, AdminArticleTrashPublicationIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, TrashPublicationFingerprint(intent), async (db, tx, _) =>
            RequireFormerPublication(intent, (await ReadFormerPublication(db, tx, intent.ArticleId, intent.ExpectedRevision, locking: false, ct)).Preview),
            ct, AdminStepUpAction.RestoreDeletedPublication);

    internal Task<byte[]> CompleteTrashPublicationStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, request, AdminStepUpAction.RestoreDeletedPublication, ct, RequireTrashPublicationSchema);

    internal async Task<AdminArticleTrashPublicationReceipt> RestoreTrashPublication(string? session, string? proof,
        AdminArticleTrashPublicationIntent intent, PublishedMediaStore? media, Action invalidatePublic, CancellationToken ct)
    {
        var fingerprint = TrashPublicationFingerprint(intent);
        var r = await AdminArticleRollbackStore.RunRollback(gate, stepUp, session, proof, intent.IdempotencyKey, fingerprint,
            AdminStepUpAction.RestoreDeletedPublication, Wire.AdminArticleRestoreStatus, fromArchive: false, RequireTrashPublicationSchema,
            async (db, tx, admin) =>
            {
                var source = await ReadFormerPublication(db, tx, intent.ArticleId, intent.ExpectedRevision, locking: true, ct);
                RequireFormerPublication(intent, source.Preview);
                var assets = await PublishedMediaStore.RestoreSelection(db, tx, media, source.Owner, intent.ArticleId,
                    intent.SourceRevision, intent.SourcePublicationId, ct);
                return await AdminArticleRollbackStore.ApplyRollback(db, tx, admin, intent.ArticleId, intent.ExpectedRevision,
                    intent.SourceRevision, intent.SourcePublicationId, intent.SourcePublicationId, source.Preview.Title, source.Body,
                    source.Responsibility, intent.IdempotencyKey, fingerprint, intent.Reason, Wire.AdminArticleRestoreStatus,
                    new(source.DeleteEvent, intent.SourceRevision, intent.SourcePublicationId, FromTrash: true), invalidatePublic, ct,
                    wasDeleted: true, assets, source.Owner);
            }, ct);
        return new(r.ArticleId, r.Revision, r.SourceRevision, r.PreviousPublicationId, r.PublicationId);
    }

    private static async Task<FormerPublication> ReadFormerPublication(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        long revision, bool locking, CancellationToken ct)
    {
        await RequireTrashPublicationSchema(db, tx, ct);
        if (revision == long.MaxValue) throw AdminArticleTrashRestoreStore.TrashRestoreConflict();
        if (locking)
            await AdminArticleRollbackStore.LockArticle(db, tx, article, deleted: true, AdminArticleTrashRestoreStore.TrashRestoreConflict, ct);
        return await SqlCommands.QueryRequired(db, tx, ct, $"""
            select a.owner_id,source.revision,prior.publication_id,source.title,case when $3 then source.body else '' end,
                linked.snapshot_id,deleted.event_no
            from public.article a join public.article_publication_history deleted on deleted.article_id=a.id and deleted.revision=a.revision
            join public.article_command deletion on (deletion.actor_id,deletion.command_id)=(deleted.actor_id,deleted.command_id)
                and deletion.article_id=a.id and deletion.revision=a.revision and not deletion.published
            join public.article_publication_history prior on prior.article_id=a.id and prior.event_no=deleted.event_no-1
                and prior.publication_id=deleted.supersedes_id and prior.publication_no=deleted.publication_no
            join public.article_revision source on source.article_id=a.id and source.revision=prior.revision
            join public.article_publication_rights rights on (rights.article_id,rights.revision,rights.publication_id)=(a.id,source.revision,prior.publication_id)
            join public.article_revision_rights policy on (policy.article_id,policy.revision)=(a.id,source.revision)
            left join public.article_publication_responsibility linked on (linked.article_id,linked.revision,linked.publication_id)=(a.id,source.revision,prior.publication_id)
            where {AdminArticleTrashRestoreStore.TrashArticlePredicate} and a.revision=$2 and prior.revision<a.revision and deleted.kind='delete'
                and deleted.reason='author-deleted' and deleted.actor_id=a.owner_id and deleted.publication_id is null
                and deleted.publication_no=a.publication_count and deleted.happened_at is not null
                and deleted.event_no=(select max(event_no) from public.article_publication_history where article_id=a.id)
                and prior.kind in ('retained-active','publish','replace') and prior.happened_at is not null
                and not exists(select from public.article_schedule where article_id=a.id)
            """, row => new FormerPublication(new(article, revision, row.GetInt64(1), row.GetInt64(2), row.GetString(3)),
                row.GetGuid(0), row.GetString(4), row.IsDBNull(5) ? null : row.GetInt64(5), row.GetInt32(6)),
            () => new BusinessException(Rejection.Conflict, "No verified previous publication is available for this trash item."),
            article, revision, locking);
    }

    private static void RequireFormerPublication(AdminArticleTrashPublicationIntent intent, AdminArticleTrashPublicationPreview source)
    {
        if (intent.SourceRevision != source.SourceRevision || intent.SourcePublicationId != source.SourcePublicationId)
            throw AdminArticleTrashRestoreStore.TrashRestoreConflict();
    }

    private static Task RequireTrashPublicationSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        AdminArticleRollbackStore.RequireSchema(CurrentSchema.HasAdminArticleTrashPublicationSchemaAsync(db, tx, ct),
            "Former publication restoration is unavailable.");

    private static byte[] TrashPublicationFingerprint(AdminArticleTrashPublicationIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleTrashPublicationIntent(intent));
}
