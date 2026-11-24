namespace FsusBlog.V2.Integration.Tests;

public sealed partial class NightlyFixturePostgresTests
{
    private const int CheckpointPilotCount = 20;
    private const int MillionArticleCount = 1_000_000;
    private const int CheckpointPilotBatchSize = 8;
    private const int InterruptedRows = 3;
    private const string CheckpointApplication = "fsusv2-nightly-checkpoint-writer";

    private async Task<(long ArchiveOffset, int Batches)> WriteCheckpointPilot(NpgsqlConnection control,
        NpgsqlConnectionStringBuilder settings, InstanceLease lease, Stream source, int count, int archiveStart,
        Identity actor, CheckpointBinding binding, CancellationToken ct)
    {
        if (count != CheckpointPilotCount || settings.Username != "fsusv2_nightly_qa")
            throw new InvalidOperationException("Checkpoint interruption is permitted only in the owned 20-article fixture.");
        Assert.Equal(binding.PlanHash, await ReadCheckpointSourceHash(source, ct));
        var reader = new PlanReader(source);
        Assert.Equal(Header, await reader.Read(ct));
        await InitializeCheckpoint(control, lease, actor, binding, reader.Position, ct);

        var writer = new NpgsqlConnectionStringBuilder(settings.ConnectionString) { ApplicationName = CheckpointApplication };
        var first = await WriteNext(CheckpointPilotBatchSize, CheckpointInterruption.None);
        Assert.Equal(CheckpointPilotBatchSize, first.Through);

        var rolledBack = await Assert.ThrowsAsync<CheckpointInterrupted>(
            () => WriteNext(InterruptedRows, CheckpointInterruption.BeforeCommit));
        Assert.Equal(CheckpointInterruption.BeforeCommit, rolledBack.Boundary);
        var rolledBackState = await ReadCheckpoint(control, null, binding, ct);
        Assert.Equal(first, rolledBackState);

        var lost = await Assert.ThrowsAsync<CheckpointInterrupted>(
            () => WriteNext(CheckpointPilotBatchSize, CheckpointInterruption.AfterCommit, repairGap: InterruptedRows));
        Assert.Equal(CheckpointInterruption.AfterCommit, lost.Boundary);
        var durable = await ReadCheckpoint(control, null, binding, ct);
        Assert.Equal(2 * CheckpointPilotBatchSize, durable.Through);
        output.WriteLine("checkpoint_before_commit=terminated_owned_writer committed_articles={0} burned_article_and_release_ids={1}",
            rolledBackState.Through, InterruptedRows);
        output.WriteLine("checkpoint_after_commit=discarded_writer_confirmation committed_articles={0}", durable.Through);

        var final = await WriteNext(CheckpointPilotBatchSize, CheckpointInterruption.None);
        Assert.Equal(count, final.Through);
        Assert.Equal(source.Length, final.NextOffset);
        Assert.True(final.ArchiveOffset > 0);
        Assert.Equal(final, await ReadCheckpoint(control, null, binding, ct));
        output.WriteLine("checkpoint_initial_graph_resumed=yes articles={0} release_high_water={1}", final.Through, final.ReleaseHighWater);
        return (final.ArchiveOffset, 3);

        async Task<CheckpointPosition> WriteNext(int rowsToWrite, CheckpointInterruption interruption, int repairGap = 0)
        {
            Assert.Equal(binding.PlanHash, await ReadCheckpointSourceHash(source, ct));
            await using var db = new NpgsqlConnection(writer.ConnectionString);
            await db.OpenAsync(ct);
            await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
            var previous = await ReadCheckpoint(db, tx, binding, ct);
            await VerifyAndRepairCheckpointSequences(db, tx, previous, repairGap, ct);

            var next = await WriteCheckpointBatch(db, tx, new PlanReader(source), actor, previous, binding, archiveStart, rowsToWrite, ct);
            Assert.Equal(next, await ReadCheckpoint(db, tx, binding, ct));

            if (interruption == CheckpointInterruption.BeforeCommit)
            {
                await using var terminate = Store.Sql(control, null, """
                    select pg_catalog.pg_terminate_backend(pid,5000)
                    from pg_catalog.pg_stat_activity
                    where pid=$1 and datname=current_database() and usename=current_user
                        and backend_type='client backend' and application_name=$2 and backend_xid is not null
                    """, db.ProcessID, CheckpointApplication);
                Assert.True(await terminate.ExecuteScalarAsync(ct) is true);
                await Assert.ThrowsAnyAsync<NpgsqlException>(() => InstanceLease.CommitProtected(tx, lease, ct));
                throw new CheckpointInterrupted(interruption);
            }

            await InstanceLease.CommitProtected(tx, lease, ct);
            // PostgreSQL committed. Interrupt delivery of the test writer's confirmation to its caller.
            if (interruption == CheckpointInterruption.AfterCommit) throw new CheckpointInterrupted(interruption);
            return next;
        }
    }

    private static async Task<CheckpointPosition> WriteCheckpointBatch(NpgsqlConnection db, NpgsqlTransaction tx, PlanReader reader,
        Identity actor, CheckpointPosition previous, CheckpointBinding binding, int archiveStart, int batchSize, CancellationToken ct)
    {
        Assert.InRange(previous.NextOffset, 1, reader.Length - 1);
        if (reader.Position != previous.NextOffset) reader.Seek(previous.NextOffset);
        int last = Math.Min(binding.Count, previous.Through + batchSize);
        var batch = await ReadInitialBatch(reader, previous.Through + 1, last, binding.Count, archiveStart, previous.ArchiveOffset, ct);
        await WriteInitialBatch(db, tx, actor, batch.Rows, binding.Due, ct);
        var next = new CheckpointPosition(last, reader.Position, batch.ArchiveOffset,
            previous.ReleaseHighWater + batch.Rows.Count(row => row.Kind != "scheduled"));
        await using var advance = Store.Sql(db, tx, """
            update fsus_nightly_fixture.article_checkpoint
            set committed_articles=$1,next_offset=$2,archive_offset=$3,release_high_water=$4
            where singleton and archive_stage=0 and archived_articles=0 and not finished
                and committed_articles=$5 and next_offset=$6
            """, next.Through, next.NextOffset, next.ArchiveOffset, next.ReleaseHighWater, previous.Through, previous.NextOffset);
        Assert.Equal(1, await advance.ExecuteNonQueryAsync(ct));
        return next;
    }

    private async Task WriteMillionArticleFixture(NpgsqlConnection db, NpgsqlConnectionStringBuilder settings,
        InstanceLease lease, Stream source, long firstOffset, Identity actor, CheckpointBinding binding, int archiveStart,
        int band, CancellationToken ct)
    {
        if (settings.Username != "fsusv2_nightly_qa")
            throw new InvalidOperationException("The standalone article fixture requires the owned PostgreSQL role.");
        await using var marker = Store.Sql(db, null, """
            select to_regclass('fsus_nightly_fixture.article_checkpoint') is not null
            """);
        bool resumed = await marker.ExecuteScalarAsync(ct) is true;
        if (!resumed) await InitializeCheckpoint(db, lease, actor, binding, firstOffset, ct);
        var position = await ReadCheckpoint(db, null, binding, ct);
        output.WriteLine("checkpoint_worker_start articles={0} archived={1} stage={2} resumed={3}",
            position.Through, position.Archived, position.ArchiveStage, resumed);
        if (position.Finished) return;

        if (position.Through < binding.Count)
        {
            Assert.Equal(0, position.Archived);
            Assert.Equal(0, position.ArchiveStage);
            await using (var recover = await InstanceLease.BeginProtected(db, lease, ct))
            {
                await RequireInitialCheckpointGraph(db, recover, position, ct);
                var (actualArticle, actualRelease) = await ReadCheckpointSequenceHeads(db, recover, ct);
                long articleNext = position.Through + 1L;
                long releaseNext = position.ReleaseHighWater + 1;
                Assert.InRange(actualArticle - articleNext, 0, BatchSize);
                Assert.InRange(actualRelease - releaseNext, 0, actualArticle - articleNext);
                await RepairCheckpointSequences(db, recover, actualArticle, actualRelease, articleNext, releaseNext, ct);
                await InstanceLease.CommitProtected(recover, lease, ct);
            }

            var reader = new PlanReader(source);
            while (position.Through < binding.Count)
            {
                await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
                var next = await WriteCheckpointBatch(db, tx, reader, actor, position, binding, archiveStart, BatchSize, ct);
                await InstanceLease.CommitProtected(tx, lease, ct);
                position = next;
                if (position.Through % 65_536 == 0 || position.Through == binding.Count)
                    output.WriteLine("checkpoint_committed_article_prefix={0}", position.Through);
            }
            // This process just completed the initial writes; an archive could not have been interrupted yet.
            resumed = false;
        }
        Assert.Equal(source.Length, position.NextOffset);
        Assert.InRange(position.ArchiveOffset, 1, source.Length - 1);
        if (position.Archived < band)
            await CompleteScaleArchives(db, settings, lease, source, actor, binding, position, archiveStart, band, resumed, ct);
        await RetireArchiveSession(db, lease, ct, binding);
        output.WriteLine("checkpoint_worker_complete articles={0} archives={1}", binding.Count, band);
    }

    private async Task CompleteScaleArchives(NpgsqlConnection db, NpgsqlConnectionStringBuilder settings, InstanceLease lease,
        Stream source, Identity actor, CheckpointBinding binding, CheckpointPosition position, int archiveStart, int band,
        bool resumed, CancellationToken ct)
    {
        var archiveSettings = new NpgsqlConnectionStringBuilder(settings.ConnectionString) { Pooling = true, MaxPoolSize = 1 };
        await using var data = NpgsqlDataSource.Create(archiveSettings.ConnectionString);
        var archiveGate = new AdminSessionGate(data, lease);
        var store = new AdminArticleArchiveStore(archiveGate, new AdminStepUpService(archiveGate));
        var session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await using var exists = Store.Sql(db, null, "select exists (select from public.admin_principal)");
        if (await exists.ExecuteScalarAsync(ct) is true)
        {
            await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
            await ReadCheckpoint(db, tx, binding, ct);
            await RotateArchiveCheckpointSession(db, tx, Store.TokenDigest(session)!, ct);
            await InstanceLease.CommitProtected(tx, lease, ct);
        }
        else await StartArchiveSession(db, lease, Store.TokenDigest(session)!, ct);

        var reader = new PlanReader(source);
        while (position.Archived < band)
        {
            Assert.InRange(position.ArchiveOffset, 1, reader.Length - 1);
            if (reader.Position != position.ArchiveOffset) reader.Seek(position.ArchiveOffset);
            var article = Parse(await reader.Read(ct), archiveStart + position.Archived, binding.Count);
            var intent = ArchiveIntent(article, binding.Count, band, position.Archived);
            var fingerprint = AdminArticleArchiveStore.ArticleArchiveIntentDigest(intent);
            bool committed = position.ArchiveStage == 1 && await HasArchiveCommand(db, intent.IdempotencyKey, ct);
            if (resumed)
            {
                await VerifyArchiveCheckpointState(db, lease, binding, position, article, intent, fingerprint, committed, ct);
                resumed = false;
            }

            int invalidations = 0;
            AdminArticleArchiveReceipt receipt;
            if (committed)
            {
                var durable = await ReadCommittedArchive(db, intent, fingerprint, ct);
                receipt = await store.ExecuteArticleArchive(session, null, intent, () => invalidations++, ct);
                Assert.Equal(durable, receipt);
            }
            else
            {
                string proof;
                if (position.ArchiveStage == 0)
                    proof = await PrepareArchive(db, lease, actor, article, article.Id - band,
                        intent, Store.TokenDigest(session)!, ct, binding);
                else
                {
                    Assert.Equal(1, position.ArchiveStage);
                    session = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
                    proof = await ReauthorizePreparedArchive(db, lease, article, article.Id - band, intent, fingerprint,
                        Store.TokenDigest(session)!, binding, ct);
                }
                receipt = await store.ExecuteArticleArchive(session, proof, intent, () => invalidations++, ct);
            }
            RequireArchiveReceipt(article, intent, receipt);
            Assert.Equal(committed ? 0 : 1, invalidations);
            position = await AcknowledgeArchiveCheckpoint(db, lease, binding, position, intent, fingerprint, receipt, reader.Position, ct);
            if (position.Archived % 1_000 == 0 || position.Archived == band)
                output.WriteLine("checkpoint_committed_archive_prefix={0}", position.Archived);
        }
    }

    private static async Task<bool> HasArchiveCommand(NpgsqlConnection db, Guid command, CancellationToken ct)
    {
        await using var find = Store.Sql(db, null, """
            select exists (select from public.admin_article_rollback where principal_id=$1 and command_id=$2)
            """, ArchiveAdministrator, command);
        return await find.ExecuteScalarAsync(ct) is true;
    }

    private static async Task VerifyArchiveCheckpointState(NpgsqlConnection db, InstanceLease lease, CheckpointBinding binding,
        CheckpointPosition position, PlannedArticle article, AdminArticleArchiveIntent intent, byte[] intentHash, bool committed, CancellationToken ct)
    {
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var release = position.ReleaseHighWater + (committed ? 1 : 0);
        int archived = position.Archived + (committed ? 1 : 0);
        long expectedRevision = position.ArchiveStage == 0 ? 3 : committed ? 6 : 5;
        long activeRelease = expectedRevision == 5 ? intent.ExpectedReleaseId : article.Id - binding.Count / 20;
        var (title, body) = expectedRevision == 5 ? (article.ReplacementTitle, article.ReplacementBody) : (article.Title, article.Body);
        await using (var verify = Store.Sql(db, tx, """
            select (select count(*)=$1 and coalesce(max(id),0)=$1 and coalesce(min(id),1)=1 from public.article)
                and (select count(*)=$2 from public.admin_article_rollback where principal_id=$3)
                and (select count(*)=$2 from public.admin_article_rollback)
                and greatest(coalesce((select max(publication_id) from public.article_publication_history),0),
                    coalesce((select max(publication_id) from public.admin_article_rollback),0),
                    coalesce((select max(publication_id) from public.article_publication_rights),0))=$4
                and exists (select from fsus_nightly_fixture.article_checkpoint c
                    where c.singleton and c.archive_stage=$7 and c.archived_articles=$8
                        and (c.archive_stage=0 or (c.archive_article=$5 and c.archive_intent_sha256=$9)))
                and exists (select from public.article a
                    left join public.article_publication p on p.article_id=a.id
                    where a.id=$5 and a.revision=$6 and a.title=$10 and a.body=$11 and not a.deleted
                        and (case when $12 then a.published_revision is null and p.article_id is null
                             else a.published_revision=$6 and p.revision=$6 and p.publication_id=$13 end))
            """, binding.Count, archived, ArchiveAdministrator, release, article.Id, expectedRevision, position.ArchiveStage,
                position.Archived, intentHash, title, body, committed, activeRelease))
            Assert.True(await verify.ExecuteScalarAsync(ct) is true);
        if (position.ArchiveStage != 0)
        {
            Assert.Equal(1, position.ArchiveStage);
            Assert.Equal(intent.ExpectedReleaseId, position.ReleaseHighWater);
        }
        long articleNext = binding.Count + 1L;
        long releaseNext = release + 1;
        var (actualArticle, actualRelease) = await ReadCheckpointSequenceHeads(db, tx, ct);
        Assert.Equal(articleNext, actualArticle);
        Assert.InRange(actualRelease - releaseNext, 0, committed ? 0 : 1);
        await RepairCheckpointSequences(db, tx, actualArticle, actualRelease, articleNext, releaseNext, ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private static async Task<CheckpointPosition> AcknowledgeArchiveCheckpoint(NpgsqlConnection db, InstanceLease lease,
        CheckpointBinding binding, CheckpointPosition previous, AdminArticleArchiveIntent intent, byte[] fingerprint,
        AdminArticleArchiveReceipt receipt, long nextOffset, CancellationToken ct)
    {
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        await using var complete = Store.Sql(db, tx, """
            update fsus_nightly_fixture.article_checkpoint c
            set archive_stage=0,archive_article=null,archive_intent_sha256=null,archived_articles=$1,
                archive_offset=$2,release_high_water=$3
            where c.singleton and c.article_count=$4 and c.archive_stage=1 and c.archived_articles=$1-1
                and c.archive_offset=$5 and c.archive_article=$6 and c.archive_intent_sha256=$7
                and c.release_high_water=$3-1 and exists (
                    select from public.admin_article_rollback r
                    where r.principal_id=$8 and r.command_id=$9 and r.fingerprint=$7 and r.article_id=$6
                        and r.revision=6 and r.publication_id=$3
                )
            """, previous.Archived + 1, nextOffset, receipt.ReleaseId, binding.Count, previous.ArchiveOffset, intent.ArticleId,
                fingerprint, ArchiveAdministrator, intent.IdempotencyKey);
        Assert.Equal(1, await complete.ExecuteNonQueryAsync(ct));
        await InstanceLease.CommitProtected(tx, lease, ct);
        return previous with
        {
            ArchiveStage = 0, Archived = previous.Archived + 1, ArchiveOffset = nextOffset, ReleaseHighWater = receipt.ReleaseId
        };
    }

    private static async Task<string> ReadCheckpointSourceHash(Stream source, CancellationToken ct)
    {
        source.Seek(0, SeekOrigin.Begin);
        var hash = Convert.ToHexStringLower(await SHA256.HashDataAsync(source, ct));
        source.Seek(0, SeekOrigin.Begin);
        return hash;
    }

    private static async Task InitializeCheckpoint(NpgsqlConnection db, InstanceLease lease, Identity actor,
        CheckpointBinding binding, long offset, CancellationToken ct)
    {
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        await Prepare(db, tx, binding.Site, actor, ct);
        await using var create = Store.Sql(db, tx, """
            create schema fsus_nightly_fixture;
            create table fsus_nightly_fixture.article_checkpoint (
                singleton boolean primary key check(singleton),
                format_version integer not null check(format_version=3),
                schema_version integer not null,
                database_oid oid not null,
                site_id uuid not null,
                plan_sha256 bytea not null check(octet_length(plan_sha256)=32),
                manifest_sha256 bytea not null check(octet_length(manifest_sha256)=32),
                due_unix_ms bigint not null check(due_unix_ms>0),
                deadline_unix_ms bigint not null,
                article_count integer not null check(article_count in (20,1000000)),
                committed_articles integer not null check(committed_articles between 0 and article_count),
                next_offset bigint not null check(next_offset>0),
                archive_offset bigint not null check(archive_offset>=0),
                release_high_water bigint not null check(release_high_water between 0 and committed_articles+article_count/20),
                archive_stage smallint not null default 0 check(archive_stage in (0,1)),
                archive_article integer,
                archive_intent_sha256 bytea check(octet_length(archive_intent_sha256)=32),
                archived_articles integer not null default 0 check(archived_articles between 0 and article_count/20),
                finished boolean not null default false,
                check(article_count=20 and deadline_unix_ms=0 or article_count=1000000 and deadline_unix_ms between 1 and due_unix_ms-1),
                check((archive_stage=0)=(archive_article is null)),
                check((archive_article is null)=(archive_intent_sha256 is null)),
                check(not finished or (archive_stage=0 and archived_articles=article_count/20 and committed_articles=article_count))
            );
            """);
        await create.ExecuteNonQueryAsync(ct);
        await using var initialize = Store.Sql(db, tx, """
            insert into fsus_nightly_fixture.article_checkpoint
                (singleton,format_version,schema_version,database_oid,site_id,plan_sha256,manifest_sha256,
                    due_unix_ms,deadline_unix_ms,article_count,committed_articles,next_offset,archive_offset,release_high_water)
            select true,3,(select version from public.v2_schema where singleton),oid,$1,$2,$3,$4,$5,$6,0,$7,0,0
            from pg_catalog.pg_database where datname=current_database()
            """, binding.Site, binding.PlanDigest, binding.ManifestDigest, binding.Due, binding.Deadline, binding.Count, offset);
        Assert.Equal(1, await initialize.ExecuteNonQueryAsync(ct));
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private static async Task<CheckpointPosition> ReadCheckpoint(NpgsqlConnection db, NpgsqlTransaction? tx,
        CheckpointBinding binding, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            select committed_articles,next_offset,archive_offset,release_high_water,archive_stage,archived_articles,finished
            from fsus_nightly_fixture.article_checkpoint
            where singleton and format_version=3 and site_id=$1 and plan_sha256=$2 and due_unix_ms=$3 and manifest_sha256=$4
                and deadline_unix_ms=$5 and article_count=$6
                and schema_version=(select version from public.v2_schema where singleton)
                and site_id=(select site_id from public.authoring_recovery_site where singleton)
                and database_oid=(select oid from pg_catalog.pg_database where datname=current_database())
                and current_user='fsusv2_nightly_qa' and inet_server_addr() is null
                and current_setting('listen_addresses')=''
            """, binding.Site, binding.PlanDigest, binding.Due, binding.ManifestDigest, binding.Deadline, binding.Count);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new InvalidOperationException("The checkpoint does not match the owned database, source plan and schedule.");
        return new(row.GetInt32(0), row.GetInt64(1), row.GetInt64(2), row.GetInt64(3), row.GetInt16(4), row.GetInt32(5), row.GetBoolean(6));
    }

    private static async Task VerifyAndRepairCheckpointSequences(NpgsqlConnection db, NpgsqlTransaction tx,
        CheckpointPosition position, int repairGap, CancellationToken ct)
    {
        await RequireInitialCheckpointGraph(db, tx, position, ct);
        var (articleActual, releaseActual) = await ReadCheckpointSequenceHeads(db, tx, ct);
        long articleNext = position.Through + 1L;
        long releaseNext = position.ReleaseHighWater + 1;
        Assert.Equal(articleNext + repairGap, articleActual);
        Assert.Equal(releaseNext + repairGap, releaseActual);
        await RepairCheckpointSequences(db, tx, articleActual, releaseActual, articleNext, releaseNext, ct);
    }

    private static async Task RequireInitialCheckpointGraph(NpgsqlConnection db, NpgsqlTransaction tx,
        CheckpointPosition position, CancellationToken ct)
    {
        await using var verify = Store.Sql(db, tx, """
            select (select count(*)=$1 and coalesce(max(id),0)=$1 and coalesce(min(id),1)=1 from public.article)
                and (select count(publication_id)=$2 and count(distinct publication_id)=$2
                    and coalesce(max(publication_id),0)=$2 and coalesce(min(publication_id),1)=1
                    from public.article_publication_history)
                and not exists (select from public.admin_article_rollback)
            """, position.Through, position.ReleaseHighWater);
        Assert.True(await verify.ExecuteScalarAsync(ct) is true);
    }

    private static async Task<(long Article, long Release)> ReadCheckpointSequenceHeads(NpgsqlConnection db, NpgsqlTransaction tx,
        CancellationToken ct)
    {
        await using var inspect = Store.Sql(db, tx, """
            select (select last_value+is_called::integer from public.article_id_seq),
                   (select last_value+is_called::integer from public.article_publication_publication_id_seq)
            """);
        await using var row = await inspect.ExecuteReaderAsync(ct);
        Assert.True(await row.ReadAsync(ct));
        return (row.GetInt64(0), row.GetInt64(1));
    }

    private static async Task RepairCheckpointSequences(NpgsqlConnection db, NpgsqlTransaction tx, long currentArticle,
        long currentRelease, long articleNext, long releaseNext, CancellationToken ct)
    {
        // Only the two dense fixture coordinates need repair. All opaque IDs may retain rollback gaps.
        if (currentArticle != articleNext)
        {
            await using var repair = Store.Sql(db, tx,
                "alter sequence public.article_id_seq restart with " + articleNext.ToString(CultureInfo.InvariantCulture));
            await repair.ExecuteNonQueryAsync(ct);
        }
        if (currentRelease != releaseNext)
        {
            await using var repair = Store.Sql(db, tx,
                "alter sequence public.article_publication_publication_id_seq restart with " + releaseNext.ToString(CultureInfo.InvariantCulture));
            await repair.ExecuteNonQueryAsync(ct);
        }
    }

    private static async Task RecordArchivePrepared(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminArticleArchiveIntent intent, CheckpointBinding binding, CancellationToken ct)
    {
        var initial = await ReadCheckpoint(db, tx, binding, ct);
        Assert.Equal(binding.Count, initial.Through);
        Assert.Equal(initial.ReleaseHighWater + 1, intent.ExpectedReleaseId);
        await using var prepared = Store.Sql(db, tx, """
            update fsus_nightly_fixture.article_checkpoint
            set archive_stage=1,archive_article=$1,archive_intent_sha256=$2,release_high_water=$3
            where singleton and archive_stage=0 and archive_offset>0 and release_high_water=$3-1
                and exists (select from public.article_publication p where p.article_id=$1 and p.revision=5 and p.publication_id=$3)
            """, intent.ArticleId, AdminArticleArchiveStore.ArticleArchiveIntentDigest(intent), intent.ExpectedReleaseId);
        Assert.Equal(1, await prepared.ExecuteNonQueryAsync(ct));
    }

    private async Task<AdminArticleArchiveReceipt> ArchiveWithCheckpoint(NpgsqlConnection control, InstanceLease lease,
        AdminArticleArchiveStore store, Stream source, Identity actor, PlannedArticle article, long sourceRelease, AdminArticleArchiveIntent intent,
        byte[] originalSessionDigest, CheckpointBinding binding, Action invalidatePublic, CancellationToken ct)
    {
        var prepareLost = await Assert.ThrowsAsync<CheckpointInterrupted>(async () =>
        {
            await PrepareArchive(control, lease, actor, article, sourceRelease, intent, originalSessionDigest, ct, binding);
            throw new CheckpointInterrupted(CheckpointInterruption.ArchivePrepared);
        });
        Assert.Equal(CheckpointInterruption.ArchivePrepared, prepareLost.Boundary);

        var recoveredSession = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var recoveredDigest = Store.TokenDigest(recoveredSession)!;
        await using var resume = new NpgsqlConnection(control.ConnectionString);
        await resume.OpenAsync(ct);
        var (recoveredArticle, resumedIntent, _) = await ReadArchiveCheckpointInput(resume, source, binding, ct);
        Assert.Equal(intent, resumedIntent);
        var intentHash = AdminArticleArchiveStore.ArticleArchiveIntentDigest(resumedIntent);
        var preparedPosition = await ReadCheckpoint(resume, null, binding, ct);
        await VerifyArchiveCheckpointState(resume, lease, binding, preparedPosition, recoveredArticle, resumedIntent,
            intentHash, committed: false, ct);
        var recoveredProof = await ReauthorizePreparedArchive(resume, lease, recoveredArticle, sourceRelease, resumedIntent, intentHash,
            recoveredDigest, binding, ct);
        output.WriteLine("checkpoint_archive_prepared=discarded_writer_confirmation article={0} revision=5 release={1}",
            intent.ArticleId, intent.ExpectedReleaseId);

        var committedLost = await Assert.ThrowsAsync<CheckpointInterrupted>(async () =>
        {
            await store.ExecuteArticleArchive(recoveredSession, recoveredProof, resumedIntent, invalidatePublic, ct);
            throw new CheckpointInterrupted(CheckpointInterruption.ArchiveCommitted);
        });
        Assert.Equal(CheckpointInterruption.ArchiveCommitted, committedLost.Boundary);
        await using var acknowledge = new NpgsqlConnection(control.ConnectionString);
        await acknowledge.OpenAsync(ct);
        var (replayedArticle, replayIntent, nextOffset) = await ReadArchiveCheckpointInput(acknowledge, source, binding, ct);
        Assert.Equal(resumedIntent, replayIntent);
        var acknowledgement = await ReadCheckpoint(acknowledge, null, binding, ct);
        await VerifyArchiveCheckpointState(acknowledge, lease, binding, acknowledgement, replayedArticle, replayIntent,
            intentHash, committed: true, ct);
        var durable = await ReadCommittedArchive(acknowledge, replayIntent, intentHash, ct);
        var replaySession = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await using (var rotation = await InstanceLease.BeginProtected(acknowledge, lease, ct))
        {
            await ReadCheckpoint(acknowledge, rotation, binding, ct);
            await RotateArchiveCheckpointSession(acknowledge, rotation, Store.TokenDigest(replaySession)!, ct);
            await InstanceLease.CommitProtected(rotation, lease, ct);
        }
        var reconnect = new NpgsqlConnectionStringBuilder(control.ConnectionString) { Pooling = false };
        await using var restartSource = NpgsqlDataSource.Create(reconnect.ConnectionString);
        var restartGate = new AdminSessionGate(restartSource, lease);
        var restartStore = new AdminArticleArchiveStore(restartGate, new AdminStepUpService(restartGate));
        var replay = await restartStore.ExecuteArticleArchive(replaySession, null, replayIntent, invalidatePublic, ct);
        Assert.Equal(durable, replay);
        var conflict = await Assert.ThrowsAsync<BusinessException>(() => restartStore.ExecuteArticleArchive(replaySession, null,
            replayIntent with { Reason = ArchiveReason + " with a different purpose" }, invalidatePublic, ct));
        Assert.Equal(Rejection.Conflict, conflict.Rejection);

        // The native command receipt is durable in the application's transaction. Only acknowledge it here.
        await AcknowledgeArchiveCheckpoint(acknowledge, lease, binding, acknowledgement, replayIntent, intentHash,
            durable, nextOffset, ct);
        output.WriteLine("checkpoint_archive_committed=retained_native_receipt article={0} revision=6 release={1}",
            intent.ArticleId, durable.ReleaseId);
        return replay;
    }

    private static async Task<(PlannedArticle, AdminArticleArchiveIntent, long)> ReadArchiveCheckpointInput(NpgsqlConnection db,
        Stream source, CheckpointBinding binding, CancellationToken ct)
    {
        var position = await ReadCheckpoint(db, null, binding, ct);
        Assert.Equal(CheckpointPilotCount, position.Through);
        Assert.Equal(source.Length, position.NextOffset);
        Assert.Equal(binding.PlanHash, await ReadCheckpointSourceHash(source, ct));
        Assert.InRange(position.ArchiveOffset, 1, source.Length - 1);
        source.Seek(position.ArchiveOffset, SeekOrigin.Begin);
        var reader = new PlanReader(source);
        const int band = CheckpointPilotCount / 20;
        var article = Parse(await reader.Read(ct), 18 * band + 1, CheckpointPilotCount);
        return (article, ArchiveIntent(article, CheckpointPilotCount, band, 0), reader.Position);
    }

    private static async Task<string> ReauthorizePreparedArchive(NpgsqlConnection db, InstanceLease lease,
        PlannedArticle article, long sourceRelease, AdminArticleArchiveIntent intent, byte[] intentHash,
        byte[] recoveredSessionDigest, CheckpointBinding binding, CancellationToken ct)
    {
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        await ReadCheckpoint(db, tx, binding, ct);
        await using (var prepared = Store.Sql(db, tx, """
            select exists (
                select from fsus_nightly_fixture.article_checkpoint c
                join public.article a on a.id=c.archive_article
                join public.article_publication p on p.article_id=a.id and p.revision=a.revision
                join public.article_publication_responsibility responsibility
                    on responsibility.article_id=a.id and responsibility.publication_id=$6 and responsibility.revision=3
                where c.singleton and c.archive_stage=1 and c.archive_article=$1 and c.archive_intent_sha256=$2
                    and c.release_high_water=$3 and a.revision=5 and a.published_revision=5 and not a.deleted
                    and p.publication_id=$3 and a.title=$4 and a.body=$5
            ) and not exists (
                select from public.admin_article_rollback where principal_id=$7 and command_id=$8
            )
            """, intent.ArticleId, intentHash, intent.ExpectedReleaseId, article.ReplacementTitle, article.ReplacementBody, sourceRelease,
                ArchiveAdministrator, intent.IdempotencyKey))
            Assert.True(await prepared.ExecuteScalarAsync(ct) is true);

        await RotateArchiveCheckpointSession(db, tx, recoveredSessionDigest, ct);
        var proof = await IssueArchiveProof(db, tx, intent, recoveredSessionDigest, ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        return proof;
    }

    private static async Task RotateArchiveCheckpointSession(NpgsqlConnection db, NpgsqlTransaction tx,
        byte[] nextSessionDigest, CancellationToken ct)
    {
        await using (var rotate = Store.Sql(db, tx, """
            with replaced as (
                delete from public.admin_session s using public.admin_principal p
                where s.principal_id=$1 and s.generation=1 and p.id=s.principal_id
                    and p.handle='nightly-fixture-archive' and p.enabled and p.generation=1
                returning s.principal_id
            )
            insert into public.admin_session(digest,principal_id,generation,expires_at)
            select $2,principal_id,1,clock_timestamp()+interval '2 minutes'
            from replaced
            """, ArchiveAdministrator, nextSessionDigest))
            Assert.Equal(1, await rotate.ExecuteNonQueryAsync(ct));
        await using var oldProof = Store.Sql(db, tx, """
            select not exists (select from public.admin_article_rollback_step_up where principal_id=$1)
            """, ArchiveAdministrator);
        Assert.True(await oldProof.ExecuteScalarAsync(ct) is true);
    }

    private static async Task<AdminArticleArchiveReceipt> ReadCommittedArchive(NpgsqlConnection db, AdminArticleArchiveIntent intent,
        byte[] intentHash, CancellationToken ct)
    {
        await using var query = Store.Sql(db, null, """
            select r.article_id,r.revision,r.source_revision,r.previous_publication_id,r.publication_id,r.publication_no,
                r.published_at,r.rights_snapshot_id,r.responsibility_snapshot_id,r.destination
            from public.admin_article_rollback r
            join public.article a on (a.id,a.revision)=(r.article_id,r.revision)
            where r.principal_id=$1 and r.command_id=$2 and r.fingerprint=$3 and r.article_id=$4
                and r.revision=6 and r.destination=$5 and not r.from_archive
                and r.previous_publication_id=$6 and r.source_revision=$7
                and not a.deleted and a.published_revision is null
                and (select count(*) from public.blog_outbox e
                    where e.article_id=r.article_id and e.revision=r.revision and e.kind='retract')=1
            """, ArchiveAdministrator, intent.IdempotencyKey, intentHash, intent.ArticleId, intent.TargetStatus,
                intent.ExpectedReleaseId, intent.SourceRevision);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new InvalidOperationException("Archive confirmation was lost without a matching native receipt.");
        return new(row.GetInt32(0), row.GetInt64(1), row.GetInt64(2), row.GetInt64(3), row.GetInt64(4), row.GetInt32(5),
            row.GetFieldValue<DateTimeOffset>(6).ToUnixTimeMilliseconds(), row.GetInt64(7), row.GetInt64(8), row.GetInt32(9));
    }

    private sealed record CheckpointBinding(Guid Site, long Due, string PlanHash, string ManifestHash, int Count, long Deadline)
    {
        internal byte[] PlanDigest { get; } = Convert.FromHexString(PlanHash);
        internal byte[] ManifestDigest { get; } = Convert.FromHexString(ManifestHash);
    }
    private sealed record CheckpointPosition(int Through, long NextOffset, long ArchiveOffset, long ReleaseHighWater,
        short ArchiveStage = 0, int Archived = 0, bool Finished = false);
    private enum CheckpointInterruption { None, BeforeCommit, AfterCommit, ArchivePrepared, ArchiveCommitted }
    private sealed class CheckpointInterrupted(CheckpointInterruption boundary) : Exception
    {
        internal CheckpointInterruption Boundary { get; } = boundary;
    }
}
