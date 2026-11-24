namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminArticleRollbackPostgresTests
{
    [PostgresFact]
    public async Task AdministratorArchiveWithdrawsAndRequiresExplicitRepublishing()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (author, administrator, other, siteSession, rollback, service, publications, originalProjection) =
            await OpenRollbackFixture(fixture, ct, "archive", seedResponsibility: true);
        var previousAuthorCommand = await fixture.Scalar<Guid>("select command_id from public.article_command where article_id=1 and revision=2");
        await fixture.Exec("update public.article_command set fingerprint=$1 where actor_id=$2 and command_id=$3",
            Publishing.Fingerprint(ArticleAction.Publish, new(1, 1, previousAuthorCommand, "", "")), author, previousAuthorCommand);
        var session = await fixture.SignIn(author, ct, minutes: 1);

        var archive = new AdminArticleArchiveIntent(1, 2, 2, 1, Guid.NewGuid(), "Archive the reviewed historical release", 3);
        var archiveDigest = AdminArticleArchiveStore.ArticleArchiveIntentDigest(archive);
        var draft = new AdminArticleDraftRollbackIntent(1, 2, 2, 1, archive.IdempotencyKey, archive.Reason, 0);
        Assert.False(archiveDigest.AsSpan().SequenceEqual(AdminArticleRollbackStore.ArticleDraftRollbackIntentDigest(draft)));
        await Denied(Rejection.Unauthorized, () => service.CheckArticleArchiveAvailability(null, ct));
        await Denied(Rejection.Unauthorized, () => service.CheckArticleArchiveAvailability(siteSession.Token, ct));
        await service.CheckArticleArchiveAvailability(administrator.Token, ct);
        await Denied(Rejection.Unauthorized, () => service.ListArchivedArticles(siteSession.Token, 0, ct));
        Assert.Empty((await service.ListArchivedArticles(administrator.Token, 0, ct)).Items);
        await Denied(Rejection.Conflict, () => service.BeginArticleArchiveStepUp(administrator.Token, archive with { ExpectedReleaseId = 99 }, ct));
        var challengeToken = ChallengeToken(await service.BeginArticleArchiveStepUp(administrator.Token, archive, ct));
        await Denied(Rejection.Forbidden, () => rollback.CompleteArticleDraftRollbackStepUp(administrator.Token,
            new PasskeyLoginRequest(challengeToken, "", [], [], [], [], [], false), ct));
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.admin_article_rollback_step_up where session_digest=$1 and action=8 and body_digest=$2 and kind=1
            """, administrator.Digest, archiveDigest));

        var staleArchive = archive with { ExpectedReleaseId = 99 };
        var staleProof = await SeedProof(fixture, administrator, AdminArticleArchiveStore.ArticleArchiveIntentDigest(staleArchive), action: 8);
        await Denied(Rejection.Conflict, () => Perform(administrator, staleProof, staleArchive));
        await fixture.Exec("delete from public.admin_article_rollback_step_up where session_digest=$1 and kind=2", administrator.Digest);
        var proof = await SeedProof(fixture, administrator, archiveDigest, action: 8);
        foreach (var (actor, assertion, command) in new[]
        {
            (administrator, (string?)null, archive),
            (other, proof, archive),
            (administrator, proof, archive with { Reason = "Changed archived source after verification" }),
        })
            await Denied(Rejection.Forbidden, () => Perform(actor, assertion, command));
        await Denied(Rejection.Forbidden, () => publications.AdministrativePublication(
            invalidate => rollback.ExecuteArticleDraftRollback(administrator.Token, proof, draft, invalidate, ct), ct));

        await RejectOutbox(3, administrator, proof, archive);
        Assert.Same(originalProjection, publications.Snapshot);
        Assert.Equal(2L, await fixture.Scalar<long>("select published_revision from public.article where id=1"));
        Assert.Equal(2L, await fixture.Scalar<long>("select publication_id from public.article_publication where article_id=1"));

        var replays = await Task.WhenAll(Perform(administrator, proof, archive), Perform(administrator, proof, archive));
        var archived = replays[0];
        Assert.Equal(archived, replays[1]);
        Assert.Equal(archived, await Perform(administrator, null, archive));
        Assert.Equal((1, 3L, 1L, 2L, 3, 3),
            (archived.ArticleId, archived.Revision, archived.SourceRevision, archived.PreviousReleaseId, archived.PublicationNo, archived.TargetStatus));
        Assert.True(archived.ReleaseId > 2 && archived.TransitionedUnixMs > 0);
        Assert.Equal(archived, Wire.DecodeAdminArticleArchiveReceipt(Wire.EncodeAdminArticleArchiveReceipt(archived)));
        await Denied(Rejection.Conflict, () => Perform(administrator, null, archive with { Reason = "Different reason for this saved command" }));
        var archivedProjection = publications.Snapshot!;
        Assert.Null(archivedProjection.Article(1));
        Assert.NotEqual(originalProjection.Generation, archivedProjection.Generation);
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.article where id=1 and owner_id=$1 and revision=3 and published_revision is null
                and publication_count=3 and not deleted and title='Historical release' and body='Historical body'
            """, author));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_publication where article_id=1"));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_publication_canonical where article_id=1"));
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.article_publication_history where article_id=1 and event_no=3 and revision=3
                and publication_no=3 and publication_id is null and supersedes_id=2 and kind='retract'
                and reason='administrator-rollback-archived' and actor_id is null and admin_actor_id=$1 and admin_command_id=$2
            """, administrator.Id, archive.IdempotencyKey));
        await AssertDurableRelease(administrator, archive, archived, false, 1, "retract");
        var archivedPage = await service.ListArchivedArticles(other.Token, 0, ct);
        Assert.Equal(0, archivedPage.NextId);
        Assert.Equal(new AdminArticleArchiveRow(1, 3, archived.ReleaseId, 3, archived.TransitionedUnixMs, "Historical release"),
            Assert.Single(archivedPage.Items));
        Assert.Empty((await service.ListArchivedArticles(other.Token, archived.ArticleId, ct)).Items);

        var previewState = await PreviewState();
        var shown = Wire.DecodeAdminArticleArchivePreview(await service.PreviewArchivedArticle(other.Token, 1, 3, archived.ReleaseId, ct));
        Assert.Equal(new AdminArticleArchivePreview(1, 3, archived.ReleaseId, "Historical release", "Historical body"), shown);
        var rawSource = shown with { Markdown = "\uFEFF原文\r\n末尾空格  \n" };
        Assert.Equal(rawSource, Wire.DecodeAdminArticleArchivePreview(Wire.EncodeAdminArticleArchivePreview(rawSource)));
        foreach (var (rejection, tok, artId, rev, relId) in new[]
        {
            (Rejection.Unauthorized, (string?)null, 1, 3L, archived.ReleaseId),
            (Rejection.Unauthorized, siteSession.Token, 1, 3L, archived.ReleaseId),
            (Rejection.Conflict, other.Token, 2, 3L, archived.ReleaseId),
            (Rejection.Conflict, other.Token, 1, 2L, archived.ReleaseId),
            (Rejection.Conflict, other.Token, 1, 3L, 2L),
        })
            await Denied(rejection, () => service.PreviewArchivedArticle(tok, artId, rev, relId, ct));
        Assert.Equal(previewState, await PreviewState());
        Assert.Same(archivedProjection, publications.Snapshot);

        var draftPath = WireRoutes.Draft.Replace("{id:int}", "1", StringComparison.Ordinal);
        await using (var stoppedAfterArchive = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var client = stoppedAfterArchive.Client;
            await AssertPublicGone(client, originalProjection.GenerationHeader, ct);
            var comparison = WireRoutes.DraftRevisionComparison.Replace("{id:int}", "1", StringComparison.Ordinal)
                .Replace("{sourceRevision:long}", "1", StringComparison.Ordinal) + "?revision=3";
            foreach (var path in new[] { draftPath, comparison })
                await SiteAedsFixture.SendStatus(client, HttpMethod.Get, path, null, session.Token, null, NotFound, ct);
            foreach (var scope in new[] { "active", "trash" })
            {
                var bytes = await SiteAedsFixture.ExpectStatus(client, HttpMethod.Get,
                    $"{WireRoutes.AuthorArticles}?scope={scope}&article=1", null, session.Token, null, OK, ct);
                Assert.Equal(0, BinaryPrimitives.ReadInt32LittleEndian(Aeds.Decode(bytes, FrameType.AuthorArticlePage)));
            }
            foreach (var (path, cmd) in new[]
            {
                (WireRoutes.Publish, new ArticleCommand(1, 3, Guid.NewGuid(), "", "")),
                (WireRoutes.Restore, new ArticleCommand(1, 3, Guid.NewGuid(), "", "")),
                (WireRoutes.Publish, new ArticleCommand(1, 1, previousAuthorCommand, "", "")),
            })
                await SiteAedsFixture.SendStatus(client, HttpMethod.Post, path, Wire.EncodeArticleCommand(cmd), session.Token, null, NotFound, ct);
        }

        var release = new AdminArticleArchiveIntent(1, 3, archived.ReleaseId, 3, Guid.NewGuid(), "Republish the archived release after review", 2);
        var releaseDigest = AdminArticleArchiveStore.ArticleArchiveIntentDigest(release);
        Assert.False(archiveDigest.AsSpan().SequenceEqual(releaseDigest));
        await Denied(Rejection.Conflict, () => service.BeginArticleArchiveStepUp(other.Token, release with { ExpectedReleaseId = 2 }, ct));
        Aeds.Decode(await service.BeginArticleArchiveStepUp(other.Token, release, ct), FrameType.PasskeyLoginBegin);
        var releaseProof = await SeedProof(fixture, other, releaseDigest, action: 8);
        await Denied(Rejection.Forbidden, () => Perform(administrator, releaseProof, release));
        await RejectOutbox(4, other, releaseProof, release);
        Assert.Same(archivedProjection, publications.Snapshot);
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_publication where article_id=1"));

        var restored = await Perform(other, releaseProof, release);
        Assert.Equal(restored, await Perform(other, null, release));
        Assert.Equal((1, 4L, 3L, archived.ReleaseId, 4, 2),
            (restored.ArticleId, restored.Revision, restored.SourceRevision, restored.PreviousReleaseId, restored.PublicationNo, restored.TargetStatus));
        Assert.True(restored.ReleaseId > archived.ReleaseId && restored.RightsSnapshotId != archived.RightsSnapshotId);
        Assert.Equal("Historical body", publications.Snapshot!.Article(1)!.Body);
        Assert.NotEqual(archivedProjection.Generation, publications.Snapshot!.Generation);
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.article_publication_history h
            join public.article_publication p on p.article_id=h.article_id and p.revision=h.revision and p.publication_id=h.publication_id
            where h.article_id=1 and h.event_no=4 and h.revision=4 and h.publication_no=4 and h.publication_id=$1
                and h.kind='publish' and h.reason='administrator-archive-republished' and h.actor_id is null
                and h.admin_actor_id=$2 and h.admin_command_id=$3
            """, restored.ReleaseId, other.Id, release.IdempotencyKey));
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.article_publication_canonical c
            join public.blog_outbox o on o.id=c.outbox_id and o.kind='publish' and o.revision=4 and o.processed_at is not null
            where c.article_id=1 and c.revision=4 and c.transition='publish' and c.publication_id=$1 and c.rights_snapshot_id=$2
            """, restored.ReleaseId, restored.RightsSnapshotId));
        await AssertDurableRelease(other, release, restored, true, archived.ResponsibilitySnapshotId, "publish");
        Assert.Empty((await service.ListArchivedArticles(other.Token, 0, ct)).Items);
        await Denied(Rejection.Conflict, () => service.PreviewArchivedArticle(other.Token, 1, 3, archived.ReleaseId, ct));
        await Denied(Rejection.Conflict, () => service.BeginArticleArchiveStepUp(other.Token, release with { IdempotencyKey = Guid.NewGuid() }, ct));

        await using var restoredServer = await ServerProcess.Start(fixture.ConnectionString, ct);
        foreach (var path in PublicArticlePaths)
            await CheckStatusAsync(OK, restoredServer.Client.GetAsync(path, ct));
        await AssertSearchCount(restoredServer.Client, 1, ct);
        Assert.Equal(new Draft(1, 4, "Historical release", "Historical body", true),
            Wire.DecodeDraft(await SiteAedsFixture.ExpectStatus(restoredServer.Client, HttpMethod.Get, draftPath, null, session.Token, null, OK, ct)));

        Task<AdminArticleArchiveReceipt> Perform((Guid Id, string Token, byte[] Digest) actor, string? assertion,
            AdminArticleArchiveIntent command) =>
            publications.AdministrativePublication(
                invalidate => service.ExecuteArticleArchive(actor.Token, assertion, command, invalidate, ct), ct);

        async Task RejectOutbox(int revision, (Guid Id, string Token, byte[] Digest) actor, string assertion,
            AdminArticleArchiveIntent command)
        {
            await fixture.Exec($"alter table public.blog_outbox add constraint fixture_reject_archive check (revision <> {revision}) not valid");
            var failure = await Assert.ThrowsAsync<PostgresException>(() => Perform(actor, assertion, command));
            Assert.Equal(PostgresErrorCodes.CheckViolation, failure.SqlState);
            Assert.Equal(0L, await fixture.Scalar<long>("""
                select (select count(*) from public.article_revision where revision=$1) +
                       (select count(*) from public.admin_article_rollback where revision=$1) +
                       (select count(*) from public.article_publication_history where revision=$1) +
                       (select count(*) from public.article_revision_responsibility where revision=$1) +
                       (select count(*) from public.article_publication_rights where revision=$1) +
                       (select count(*) from public.blog_outbox where revision=$1)
                """, (long)revision));
            Assert.Equal(1L, await fixture.Scalar<long>("""
                select count(*) from public.admin_article_rollback_step_up where session_digest=$1 and kind=2 and action=8
                """, actor.Digest));
            await fixture.Exec("alter table public.blog_outbox drop constraint fixture_reject_archive");
        }

        async Task AssertDurableRelease((Guid Id, string Token, byte[] Digest) actor, AdminArticleArchiveIntent command,
            AdminArticleArchiveReceipt receipt, bool fromArchive, long responsibilitySource, string eventKind)
        {
            Assert.Equal(1L, await fixture.Scalar<long>(RollbackSnapshotQuery + "\n" + """
                where b.principal_id=$1 and b.command_id=$2 and b.reason=$3 and b.destination=$4 and b.from_archive=$5
                    and b.previous_publication_id=$6 and b.publication_id=$7 and d.source_snapshot_id=$8 and b.rights_snapshot_id=$9
                    and b.responsibility_snapshot_id=$10 and r.copyright_holder='Original holder' and r.license_type='CC-BY-4.0'
                    and d.responsible_party='Historical claimant'
                """, actor.Id, command.IdempotencyKey, command.Reason, command.TargetStatus, fromArchive, receipt.PreviousReleaseId,
                receipt.ReleaseId, responsibilitySource, receipt.RightsSnapshotId, receipt.ResponsibilitySnapshotId));
            Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.blog_outbox where article_id=1 and revision=$1", receipt.Revision));
            Assert.Equal(1L, await fixture.Scalar<long>("""
                select count(*) from public.blog_outbox where article_id=1 and revision=$1 and kind=$2 and processed_at is not null
                """, receipt.Revision, eventKind));
            Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_command where command_id=$1", command.IdempotencyKey));
        }

        Task<string> PreviewState() => fixture.Scalar<string>("""
            select jsonb_build_array(
                (select to_jsonb(a) from public.article a where id=1),
                (select count(*) from public.article_revision where article_id=1),
                (select count(*) from public.article_publication_history where article_id=1),
                (select count(*) from public.admin_article_rollback where article_id=1),
                (select count(*) from public.article_publication_rights where article_id=1),
                (select count(*) from public.article_publication_responsibility where article_id=1),
                (select count(*) from public.admin_article_rollback_step_up),
                (select count(*) from public.article_publication where article_id=1),
                (select count(*) from public.article_publication_canonical where article_id=1),
                (select count(*) from public.blog_outbox where article_id=1))::text
            """);
    }
}
