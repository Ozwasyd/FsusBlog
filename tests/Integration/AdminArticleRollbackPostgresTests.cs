namespace FsusBlog.V2.Integration.Tests;

public sealed partial class AdminArticleRollbackPostgresTests
{
    [PostgresFact]
    public async Task PublishedRollbackIsAdministratorAttributedAtomicAndIdempotent()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (author, admin, other, siteUser, service, _, publications, originalProjection) = await OpenRollbackFixture(fixture, ct, "history");
        var intent = new AdminArticleRollbackIntent(1, 2, 2, 1, Guid.NewGuid(), "Restore the verified historical publication");
        await Denied(Rejection.Unauthorized, () => service.CheckArticleRollbackAvailability(null, ct));
        await Denied(Rejection.Unauthorized, () => service.CheckArticleRollbackAvailability(siteUser.Token, ct));
        await Denied(Rejection.NotFound, () => service.PreviewArticleRollback(admin.Token, 2, 1, ct));
        Assert.Equal(2, (await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).BlockingReason);
        await Denied(Rejection.Conflict, () => service.BeginArticleRollbackStepUp(admin.Token, intent, ct));
        await SeedResponsibility(fixture);
        Assert.True((await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).PackageComplete);
        await Denied(Rejection.Conflict, () => service.BeginArticleRollbackStepUp(admin.Token, intent with { ExpectedPublicationId = 998 }, ct));
        Aeds.Decode(await service.BeginArticleRollbackStepUp(admin.Token, intent, ct), FrameType.PasskeyLoginBegin);

        // The browser suite verifies actual user-verifying assertions. Native store integration supplies only the proof row.
        var proof = await SeedProof(fixture, admin, AdminArticleRollbackStore.ArticleRollbackIntentDigest(intent), action: 3);
        foreach (var (actor, assertion, command) in new[]
        {
            (admin, (string?)null, intent),
            (other, proof, intent),
            (admin, proof, intent with { Reason = "A different rollback reason" }),
        })
            await Denied(Rejection.Forbidden, () => Perform(actor, assertion, command));
        await SeedPrivateDraft(fixture, "A newer private draft", "Keep it intact");
        Assert.Equal((int)AdminArticleRollbackBlock.UnpublishedDraft, (await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).BlockingReason);
        await Denied(Rejection.Conflict, () => service.BeginArticleRollbackStepUp(admin.Token, intent with { ExpectedRevision = 3 }, ct));
        await Denied(Rejection.Conflict, () => Perform(admin, proof, intent));
        Assert.Equal("Keep it intact", await fixture.Scalar<string>("select body from public.article where id=1"));
        await RestoreAndFaultOutbox(fixture);
        Assert.Equal(PostgresErrorCodes.CheckViolation, (await Assert.ThrowsAsync<PostgresException>(() => Perform(admin, proof, intent))).SqlState);
        Assert.Same(originalProjection, publications.Snapshot);
        Assert.Equal(2L, await fixture.Scalar<long>("select revision from public.article where id=1"));
        foreach (var (expected, sql) in new[]
        {
            (0L, "select count(*) from public.admin_article_rollback"),
            (0L, "select count(*) from public.article_publication_canonical"),
            (1L, "select count(*) from public.admin_article_rollback_step_up where kind=2"),
        })
            Assert.Equal(expected, await fixture.Scalar<long>(sql));
        await fixture.Exec("alter table public.blog_outbox drop constraint fixture_refusal");

        var receipts = await Task.WhenAll(Perform(admin, proof, intent), Perform(admin, proof, intent));
        var result = receipts[0];
        Assert.Equal((result, result), (receipts[1], await Perform(admin, null, intent)));
        await Denied(Rejection.Conflict, () => Perform(admin, proof, intent with { Reason = "Attempt a changed admin replay" }));
        await Denied(Rejection.Forbidden, () => Perform(other, proof, intent));
        Assert.Equal((1, 3L, 1L, 2L, 3), (result.ArticleId, result.Revision, result.SourceRevision, result.PreviousPublicationId, result.PublicationNo));
        Assert.True(result.PublicationId > 2);
        Assert.NotSame(originalProjection, publications.Snapshot);
        var restored = publications.Snapshot!.Article(1)!;
        Assert.Equal(("Historical release", "Historical body", result.PublicationId), (restored.Title, restored.Body, restored.Publication));
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.article_publication_canonical c join public.blog_outbox o on o.id=c.outbox_id and o.kind='publish'
            where c.publication_id=$1 and c.revision=$2 and c.rights_snapshot_id=$3 and c.transition='replace'
            """, result.PublicationId, result.Revision, result.RightsSnapshotId));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.article_publication_canonical"));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_command where command_id=$1", intent.IdempotencyKey));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.admin_article_rollback_step_up where kind=2"));
        Assert.Equal(author, await fixture.Scalar<Guid>("select owner_id from public.article where id=1"));
        Assert.Equal(admin.Id, await fixture.Scalar<Guid>("select admin_actor_id from public.article_publication_history where revision=3 and actor_id is null"));
        Assert.Equal(1L, await fixture.Scalar<long>(RollbackSnapshotQuery + "\n" + """
            where b.principal_id=$1 and b.command_id=$2 and b.reason=$3 and d.source_snapshot_id=1
               and r.copyright_holder='Original holder' and d.responsible_party='Historical claimant'
            """, admin.Id, intent.IdempotencyKey, intent.Reason));
        await fixture.Exec("update public.admin_principal set enabled=false where id=$1", admin.Id);
        await Denied(Rejection.Unauthorized, () => Perform(admin, null, intent));

        Task<AdminArticleRollbackReceipt> Perform((Guid Id, string Token, byte[] Digest) actor, string? assertion, AdminArticleRollbackIntent command) =>
            publications.AdministrativePublication(invalidate => service.ExecuteArticleRollback(actor.Token, assertion, command, invalidate, ct), ct);
    }

    [PostgresFact]
    public async Task DraftRollbackWithdrawsTheArticleAndRetainsAnIndependentPrivateRelease()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (author, admin, other, siteUser, service, _, publications, originalProjection) = await OpenRollbackFixture(fixture, ct, "draft-rollback");
        var intent = new AdminArticleDraftRollbackIntent(1, 2, 2, 1, Guid.NewGuid(), "Return reviewed history to a private draft", 0);
        var publishedIntent = new AdminArticleRollbackIntent(1, 2, 2, 1, intent.IdempotencyKey, intent.Reason);
        var draftDigest = AdminArticleRollbackStore.ArticleDraftRollbackIntentDigest(intent);
        var publishedDigest = AdminArticleRollbackStore.ArticleRollbackIntentDigest(publishedIntent);
        Assert.False(draftDigest.AsSpan().SequenceEqual(publishedDigest));

        await Denied(Rejection.Unauthorized, () => service.CheckArticleDraftRollbackAvailability(null, ct));
        await Denied(Rejection.Unauthorized, () => service.CheckArticleDraftRollbackAvailability(siteUser.Token, ct));
        await service.CheckArticleDraftRollbackAvailability(admin.Token, ct);
        await Denied(Rejection.Conflict, () => service.BeginArticleDraftRollbackStepUp(admin.Token, intent, ct));
        await SeedResponsibility(fixture);
        await Denied(Rejection.Conflict, () => service.BeginArticleDraftRollbackStepUp(admin.Token, intent with { ExpectedPublicationId = 998 }, ct));

        Aeds.Decode(await service.BeginArticleRollbackStepUp(admin.Token, publishedIntent, ct), FrameType.PasskeyLoginBegin);
        var token = ChallengeToken(await service.BeginArticleDraftRollbackStepUp(admin.Token, intent, ct));
        await Denied(Rejection.Forbidden, () => service.CompleteArticleRollbackStepUp(admin.Token,
            new PasskeyLoginRequest(token, "", [], [], [], [], [], false), ct));
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.admin_article_rollback_step_up
            where session_digest=$1 and kind=1 and action=7 and body_digest=$2
            """, admin.Digest, draftDigest));

        var publishedProof = await SeedProof(fixture, admin, publishedDigest, action: 3);
        await Denied(Rejection.Forbidden, () => Perform(admin, publishedProof, intent));
        await fixture.Exec("delete from public.admin_article_rollback_step_up where session_digest=$1 and kind=2", admin.Digest);
        var proof = await SeedProof(fixture, admin, draftDigest, action: 7);
        foreach (var (actor, assertion, command) in new[]
        {
            (admin, (string?)null, intent),
            (other, proof, intent),
            (admin, proof, intent with { Reason = "Changed reason after verification" }),
        })
            await Denied(Rejection.Forbidden, () => Perform(actor, assertion, command));
        await Denied(Rejection.Forbidden, () => publications.AdministrativePublication(
            invalidate => service.ExecuteArticleRollback(admin.Token, proof, publishedIntent, invalidate, ct), ct));

        var scheduleCommand = Guid.NewGuid();
        await fixture.Exec("insert into public.article_command values($1,$2,$3,1,2,'Later publication','Later body',true)",
            author, scheduleCommand, RandomNumberGenerator.GetBytes(32));
        await fixture.Exec("insert into public.article_schedule_receipt values($1,$2,clock_timestamp()+interval '1 day',2)", author, scheduleCommand);
        await fixture.Exec("""
            insert into public.article_schedule(article_id,revision,actor_id,generation,command_id,due_at)
            values (1,2,$1,1,$2,clock_timestamp()+interval '1 day')
            """, author, scheduleCommand);
        Assert.Equal((int)AdminArticleRollbackBlock.PendingSchedule, (await service.PreviewArticleRollback(admin.Token, 1, 1, ct)).BlockingReason);
        await Denied(Rejection.Conflict, () => Perform(admin, proof, intent));
        Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.article_schedule where article_id=1"));
        await fixture.Exec("delete from public.article_schedule where article_id=1");
        await SeedPrivateDraft(fixture, "Newer author draft", "Preserve the author draft");
        await Denied(Rejection.Conflict, () => service.BeginArticleDraftRollbackStepUp(admin.Token, intent with { ExpectedRevision = 3 }, ct));
        Assert.Equal("Preserve the author draft", await fixture.Scalar<string>("select body from public.article where id=1"));
        await RestoreAndFaultOutbox(fixture);
        Assert.Equal(PostgresErrorCodes.CheckViolation, (await Assert.ThrowsAsync<PostgresException>(() => Perform(admin, proof, intent))).SqlState);
        Assert.Same(originalProjection, publications.Snapshot);
        Assert.Equal(2, await fixture.Scalar<int>("select publication_count from public.article where id=1"));
        foreach (var (expected, sql) in new[]
        {
            (2L, "select published_revision from public.article where id=1"),
            (2L, "select count(*) from public.article_revision where article_id=1"),
            (0L, "select count(*) from public.admin_article_rollback"),
            (0L, "select count(*) from public.article_revision_responsibility where revision=3"),
            (0L, "select count(*) from public.article_publication_rights where revision=3"),
            (1L, "select count(*) from public.admin_article_rollback_step_up where kind=2 and action=7"),
        })
            Assert.Equal(expected, await fixture.Scalar<long>(sql));
        await fixture.Exec("alter table public.blog_outbox drop constraint fixture_refusal");

        var receipts = await Task.WhenAll(Perform(admin, proof, intent), Perform(admin, proof, intent));
        var result = receipts[0];
        Assert.Equal((result, result), (receipts[1], await Perform(admin, null, intent)));
        Assert.Equal((1, 3L, 1L, 2L, 3, 0),
            (result.ArticleId, result.Revision, result.SourceRevision, result.PreviousPublicationId, result.PublicationNo, result.TargetStatus));
        Assert.True(result.PrivateReleaseId > 2 && result.TransitionedUnixMs > 0);
        await Denied(Rejection.Conflict, () => Perform(admin, null, intent with { Reason = "Different reason for this saved command" }));
        await Denied(Rejection.Conflict, () => publications.AdministrativePublication(
            invalidate => service.ExecuteArticleRollback(admin.Token, null, publishedIntent, invalidate, ct), ct));
        var draftProjection = publications.Snapshot!;
        Assert.Null(draftProjection.Article(1));
        Assert.NotEqual(originalProjection.Generation, draftProjection.Generation);

        Assert.Equal((author, 0L), (await fixture.Scalar<Guid>("select owner_id from public.article where id=1"),
            await fixture.Scalar<long>("select count(*) from public.article_command where command_id=$1", intent.IdempotencyKey)));
        foreach (var (expected, sql) in new[]
        {
            (1L, "select count(*) from public.article where id=1 and revision=3 and published_revision is null and publication_count=3 and not deleted and title='Historical release' and body='Historical body'"),
            (0L, "select count(*) from public.article_publication where article_id=1"),
            (0L, "select count(*) from public.admin_article_rollback_step_up where kind=2"),
            (0L, "select count(*) from public.article_publication_canonical"),
            (1L, "select count(*) from public.blog_outbox where article_id=1 and revision=3 and kind='retract' and processed_at is not null"),
            (1L, "select count(*) from public.blog_outbox where article_id=1 and revision=3"),
        })
            Assert.Equal(expected, await fixture.Scalar<long>(sql));
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.article_publication_history
            where article_id=1 and event_no=3 and revision=3 and publication_no=3 and publication_id is null
              and supersedes_id=2 and kind='retract' and reason='administrator-rollback-draft'
              and actor_id is null and admin_actor_id=$1 and admin_command_id=$2
            """, admin.Id, intent.IdempotencyKey));
        Assert.Equal(1L, await fixture.Scalar<long>(RollbackSnapshotQuery + "\n" + """
            where b.principal_id=$1 and b.command_id=$2 and b.reason=$3 and b.destination=0 and d.source_snapshot_id=1
              and b.publication_id=$4 and b.rights_snapshot_id=$5 and b.responsibility_snapshot_id=$6
              and r.copyright_holder='Original holder' and r.license_type='CC-BY-4.0' and d.responsible_party='Historical claimant'
            """, admin.Id, intent.IdempotencyKey, intent.Reason, result.PrivateReleaseId, result.RightsSnapshotId,
            result.ResponsibilitySnapshotId));
        await fixture.Exec("update public.admin_principal set enabled=false where id=$1", admin.Id);
        await Denied(Rejection.Unauthorized, () => Perform(admin, null, intent));

        // Restart through Kestrel to exercise the public representations and the owner's private draft.
        var (_, sessionToken, _) = await fixture.SignIn(author, ct, minutes: 1);
        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct);
        await AssertPublicGone(restarted.Client, originalProjection.GenerationHeader, ct);
        var savedDraft = await SiteAedsFixture.ExpectStatus(restarted.Client, HttpMethod.Get,
            WireRoutes.Draft.Replace("{id:int}", "1", StringComparison.Ordinal), null, sessionToken, null, OK, ct);
        Assert.Equal(new Draft(1, 3, "Historical release", "Historical body", false), Wire.DecodeDraft(savedDraft));
        await SiteAedsFixture.ExpectStatus(restarted.Client, HttpMethod.Post, WireRoutes.Publish,
            Wire.EncodeArticleCommand(new(1, 3, Guid.NewGuid(), "", "")), sessionToken, null, OK, ct);
        Assert.Equal(1L, await fixture.Scalar<long>("""
            select count(*) from public.article_publication
            where article_id=1 and revision=4 and publication_no=4 and publication_id<>$1
            """, result.PrivateReleaseId));

        Task<AdminArticleDraftRollbackReceipt> Perform((Guid Id, string Token, byte[] Digest) actor, string? assertion, AdminArticleDraftRollbackIntent command) =>
            publications.AdministrativePublication(invalidate => service.ExecuteArticleDraftRollback(actor.Token, assertion, command, invalidate, ct), ct);
    }

    private static async Task SeedPrivateDraft(ScratchDatabase fixture, string draftTitle, string draftBody)
    {
        await fixture.Exec("insert into public.article_revision(article_id,revision,title,body,happened_at) values(1,3,$1,$2,clock_timestamp())", draftTitle, draftBody);
        await fixture.Exec("update public.article set revision=3,title=$1,body=$2 where id=1", draftTitle, draftBody);
    }

    private static Task RestoreAndFaultOutbox(ScratchDatabase fixture) => fixture.Exec("""
        update public.article set revision=2,title='Later publication',body='Later body' where id=1;
        delete from public.article_revision where article_id=1 and revision=3;
        alter table public.blog_outbox add constraint fixture_refusal check (revision <> 3) not valid;
        """);

    private static string ChallengeToken(byte[] frame) => Encoding.ASCII.GetString(
        Aeds.Decode(frame, FrameType.PasskeyLoginBegin).Slice(WireLayouts.PasskeyLoginBeginTokenOffset, WireLayouts.PasskeyTokenSize)).TrimEnd('\0');

    private static async Task<(Guid Author, (Guid Id, string Token, byte[] Digest) Admin, (Guid Id, string Token, byte[] Digest) Other,
        (Guid Id, string Token, string Handle) SiteUser, AdminArticleRollbackStore Rollback,
        AdminArticleArchiveStore Archive, Publications Publications, PublicSnapshot OriginalProjection)>
        OpenRollbackFixture(ScratchDatabase fixture, CancellationToken ct, string prefix, bool seedResponsibility = false)
    {
        var author = await SeedHistory(fixture, ct);
        if (seedResponsibility) await SeedResponsibility(fixture);
        var admin = await fixture.AdminAsync(prefix + "-administrator", 10, RandomNumberGenerator.GetBytes(32), [1], ct);
        var other = await fixture.AdminAsync("other-" + prefix + "-administrator", 10, RandomNumberGenerator.GetBytes(32), [1], ct);
        var siteUser = await fixture.SignInSiteUser(prefix + "-site-user", ct);
        var (rollback, archive) = CreateStores(fixture);
        var publications = PublicationFixture.Project(fixture.DataSource);
        await publications.Refresh(ct);
        var originalProjection = publications.Snapshot!;
        Assert.Equal("Later body", originalProjection.Article(1)!.Body);
        return (author, admin, other, siteUser, rollback, archive, publications, originalProjection);
    }

    private const string RollbackSnapshotQuery = """
        select count(*) from public.admin_article_rollback b
          join public.article_publication_rights w on w.id=b.rights_snapshot_id and w.publication_id=b.publication_id
          join public.article_revision_rights r on r.article_id=w.article_id and r.revision=w.revision
          join public.article_revision_responsibility d on d.id=b.responsibility_snapshot_id
          join public.article_publication_responsibility p on p.publication_id=b.publication_id and p.snapshot_id=d.id
          join public.article_revision_category c on c.article_id=b.article_id and c.revision=b.revision and c.category_id=10
          join public.article_revision_tag t on t.article_id=b.article_id and t.revision=b.revision and t.tag_id=11
        """;

    private static readonly string[] PublicArticlePaths =
        ["/article/1", WireRoutes.PublicArticle.Replace("{id}", "1", StringComparison.Ordinal)];

    private static async Task AssertPublicGone(HttpClient client, string oldGeneration, CancellationToken ct)
    {
        foreach (var path in PublicArticlePaths)
        {
            using var response = Expect(NotFound, await client.GetAsync(path, ct));
            Assert.True(response.Headers.CacheControl?.NoStore);
        }
        await AssertSearchCount(client, 0, ct);
        using var old = new HttpRequestMessage(HttpMethod.Head, $"{WireRoutes.PublicSearchCorpus}?generation={oldGeneration}");
        await CheckStatusAsync(Conflict, client.SendAsync(old, ct));
    }

    private static async Task AssertSearchCount(HttpClient client, int count, CancellationToken ct)
    {
        var payload = Aeds.Decode(await OkBytes(client.GetAsync(WireRoutes.PublicSearch + "?q=Historical", ct), ct), FrameType.ArticleSearch);
        Assert.True(payload[..4].SequenceEqual("FAS4"u8));
        Assert.Equal(count, BinaryPrimitives.ReadInt32LittleEndian(payload[8..]));
    }

    private static async Task<Guid> SeedHistory(ScratchDatabase fixture, CancellationToken ct)
    {
        var (author, _, _) = await fixture.AdminAsync("article-fixture-author", 5, RandomNumberGenerator.GetBytes(8), [1], ct);
        await fixture.Exec("""
            with article as (
                insert into public.article(owner_id,revision,title,body,published_revision,publication_count,deleted)
                    values($1,2,'Later publication','Later body',2,2,false) returning id
            )
            insert into public.article_revision(article_id,revision,title,body,happened_at)
            select article.id, seed.revision, seed.title, seed.body, seed.happened_at
            from article cross join (values
                (1,'Historical release','Historical body',clock_timestamp()-interval '1 day'),
                (2,'Later publication','Later body',clock_timestamp())) seed(revision,title,body,happened_at)
            """, author);
        await fixture.Exec("""
            insert into public.category(id,name) values(10,'Rollback source category'),(20,'Current category');
            insert into public.tag(id,name) values(11,'Rollback source tag'),(21,'Current tag');
            insert into public.article_revision_category values (1,1,10),(1,2,20);
            insert into public.article_revision_tag values (1,1,11),(1,2,21);
            insert into public.article_revision_rights values
                (1,1,true,'CC-BY-4.0','Original holder',2025,'Original license','','append-attribution',40,true,true,false),
                (1,2,true,'all-rights-reserved','Current holder',2026,'Current license','','disabled',0,false,true,false);
            insert into public.article_publication_rights(article_id,publication_id,revision) values(1,1,1),(1,2,2);
            insert into public.article_publication(article_id,revision,publication_no,published_at)
                values(1,2,2,clock_timestamp());
            insert into public.article_publication_history(article_id,event_no,revision,publication_no,publication_id,kind,reason,happened_at)
                select 1,1,1,1,1,'retained-active','pre-history',p.published_at-interval '1 day' from public.article_publication p;
            update public.article_publication set publication_id=2 where article_id=1;
            alter sequence public.article_publication_publication_id_seq restart with 3;
            insert into public.blog_outbox(article_id,revision,kind) values(1,2,'publish');
            """);
        // The current historical tail is produced by the independent site-author role, then retained.
        var authorCommand = Guid.NewGuid();
        await fixture.Exec("insert into public.article_command values($1,$2,$3,1,2,'Later publication','Later body',true)",
            author, authorCommand, RandomNumberGenerator.GetBytes(32));
        await fixture.Exec("""
            insert into public.article_publication_history(article_id,event_no,revision,publication_no,publication_id,supersedes_id,
                kind,reason,happened_at,actor_id,command_id)
                select 1,2,2,2,2,1,'replace','author-replaced',published_at,$1,$2 from public.article_publication
            """, author, authorCommand);
        return author;
    }

    private static Task SeedResponsibility(ScratchDatabase fixture) =>
        fixture.Exec("""
            with record as (
                insert into public.article_revision_responsibility(article_id,revision,responsible_party,basis,reference,recorded_by)
                values(1,1,'Historical claimant','The independent recorded historical source','estate-record-2025',current_user)
                returning id
            )
            insert into public.article_publication_responsibility select 1,1,1,id from record;
            """);

    private static async Task<string> SeedProof(ScratchDatabase fixture, (Guid Id, string Token, byte[] Digest) actor,
        byte[] fingerprint, int action) =>
        (await fixture.SeedStepUpProof("admin_article_rollback_step_up", actor.Id, actor.Digest, action, fingerprint)).Token;

    private static (AdminArticleRollbackStore Rollback, AdminArticleArchiveStore Archive) CreateStores(ScratchDatabase fixture)
    {
        var gate = new AdminSessionGate(fixture.DataSource, null);
        var passkeys = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("https://localhost"), "localhost"));
        var stepUp = new AdminStepUpService(gate, passkeys);
        return (new(gate, stepUp), new(gate, stepUp));
    }
}
