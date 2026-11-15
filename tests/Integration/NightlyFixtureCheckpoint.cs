using System.Globalization;
using System.Security.Cryptography;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Operations;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class NightlyFixturePostgresTests
{
    private const int CheckpointPilotCount = 20;
    private const int CheckpointPilotBatchSize = 8;
    private const int InterruptedRows = 3;
    private const string CheckpointApplication = "fsusv2-nightly-checkpoint-writer";

    private async Task<(long ArchiveOffset, int Batches)> WriteCheckpointPilot(NpgsqlConnection control,
        NpgsqlConnectionStringBuilder settings, InstanceLease lease, FileStream source, int count, int archiveStart, Guid site,
        Identity actor, long due, CancellationToken ct)
    {
        if (count != CheckpointPilotCount || settings.Username != "fsusv2_nightly_qa")
            throw new InvalidOperationException("Checkpoint interruption is permitted only in the owned 20-article fixture.");
        var planHash = Required("CHECKPOINT_PLAN_SHA256");
        Assert.Equal(planHash, await ReadCheckpointSourceHash(source, ct));
        var binding = new CheckpointBinding(site, due, Convert.FromHexString(planHash));
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
            Assert.Equal(planHash, await ReadCheckpointSourceHash(source, ct));
            await using var db = new NpgsqlConnection(writer.ConnectionString);
            await db.OpenAsync(ct);
            await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
            var previous = await ReadCheckpoint(db, tx, binding, ct);
            await VerifyAndRepairCheckpointSequences(db, tx, previous, repairGap, ct);

            Assert.InRange(previous.NextOffset, 1, source.Length - 1);
            source.Seek(previous.NextOffset, SeekOrigin.Begin);
            var batchReader = new PlanReader(source);
            var last = Math.Min(count, previous.Through + rowsToWrite);
            var batch = await ReadInitialBatch(batchReader, previous.Through + 1, last, count, archiveStart, previous.ArchiveOffset, ct);
            await WriteInitialBatch(db, tx, actor, batch.Rows, due, ct);
            var next = new CheckpointPosition(last, batchReader.Position, batch.ArchiveOffset,
                previous.ReleaseHighWater + batch.Rows.Count(row => row.Kind != "scheduled"));
            await using (var advance = Store.Sql(db, tx, """
                update fsus_nightly_fixture.article_checkpoint
                set committed_articles=$1,next_offset=$2,archive_offset=$3,release_high_water=$4
                where singleton and committed_articles=$5 and next_offset=$6
                """, next.Through, next.NextOffset, next.ArchiveOffset, next.ReleaseHighWater, previous.Through, previous.NextOffset))
                Assert.Equal(1, await advance.ExecuteNonQueryAsync(ct));
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

    private static async Task<string> ReadCheckpointSourceHash(FileStream source, CancellationToken ct)
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
                format_version integer not null check(format_version=1),
                schema_version integer not null,
                database_oid oid not null,
                site_id uuid not null,
                plan_sha256 bytea not null check(octet_length(plan_sha256)=32),
                due_unix_ms bigint not null check(due_unix_ms>0),
                committed_articles integer not null check(committed_articles between 0 and 20),
                next_offset bigint not null check(next_offset>0),
                archive_offset bigint not null check(archive_offset>=0),
                release_high_water bigint not null check(release_high_water between 0 and committed_articles)
            );
            """);
        await create.ExecuteNonQueryAsync(ct);
        await using var initialize = Store.Sql(db, tx, """
            insert into fsus_nightly_fixture.article_checkpoint
            select true,1,(select version from public.v2_schema where singleton),oid,$1,$2,$3,0,$4,0,0
            from pg_catalog.pg_database where datname=current_database()
            """, binding.Site, binding.PlanHash, binding.Due, offset);
        Assert.Equal(1, await initialize.ExecuteNonQueryAsync(ct));
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private static async Task<CheckpointPosition> ReadCheckpoint(NpgsqlConnection db, NpgsqlTransaction? tx,
        CheckpointBinding binding, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            select committed_articles,next_offset,archive_offset,release_high_water
            from fsus_nightly_fixture.article_checkpoint
            where singleton and format_version=1 and site_id=$1 and plan_sha256=$2 and due_unix_ms=$3
                and schema_version=(select version from public.v2_schema where singleton)
                and site_id=(select site_id from public.authoring_recovery_site where singleton)
                and database_oid=(select oid from pg_catalog.pg_database where datname=current_database())
                and current_user='fsusv2_nightly_qa' and inet_server_addr() is null
                and current_setting('listen_addresses')=''
            """, binding.Site, binding.PlanHash, binding.Due);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new InvalidOperationException("The checkpoint does not match the owned database, source plan and schedule.");
        return new(row.GetInt32(0), row.GetInt64(1), row.GetInt64(2), row.GetInt64(3));
    }

    private static async Task VerifyAndRepairCheckpointSequences(NpgsqlConnection db, NpgsqlTransaction tx,
        CheckpointPosition position, int repairGap, CancellationToken ct)
    {
        await using (var verify = Store.Sql(db, tx, """
            select (select count(*)=$1 and coalesce(max(id),0)=$1 and coalesce(min(id),1)=1 from public.article)
                and (select count(publication_id)=$2 and count(distinct publication_id)=$2
                    and coalesce(max(publication_id),0)=$2 and coalesce(min(publication_id),1)=1
                    from public.article_publication_history)
                and not exists (select from public.admin_article_rollback)
            """, position.Through, position.ReleaseHighWater))
            Assert.True(await verify.ExecuteScalarAsync(ct) is true);

        long articleNext = position.Through + 1L;
        long releaseNext = position.ReleaseHighWater + 1;
        await using (var inspect = Store.Sql(db, tx, """
            select (select last_value+is_called::integer from public.article_id_seq)=$1
                and (select last_value+is_called::integer from public.article_publication_publication_id_seq)=$2
            """, articleNext + repairGap, releaseNext + repairGap))
            Assert.True(await inspect.ExecuteScalarAsync(ct) is true);
        if (repairGap == 0) return;

        // Only the two dense fixture coordinates need repair. All opaque IDs may retain rollback gaps.
        await using var repair = Store.Sql(db, tx,
            "alter sequence public.article_id_seq restart with " + articleNext.ToString(CultureInfo.InvariantCulture) + ";" +
            "alter sequence public.article_publication_publication_id_seq restart with " + releaseNext.ToString(CultureInfo.InvariantCulture));
        await repair.ExecuteNonQueryAsync(ct);
    }

    private sealed record CheckpointBinding(Guid Site, long Due, byte[] PlanHash);
    private sealed record CheckpointPosition(int Through, long NextOffset, long ArchiveOffset, long ReleaseHighWater);
    private enum CheckpointInterruption { None, BeforeCommit, AfterCommit }
    private sealed class CheckpointInterrupted(CheckpointInterruption boundary) : Exception
    {
        internal CheckpointInterruption Boundary { get; } = boundary;
    }
}
