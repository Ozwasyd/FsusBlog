using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class AuthorTextRebuildWorker(NpgsqlDataSource source, InstanceLease lease, ILogger<AuthorTextRebuildWorker> log)
    : BackgroundService
{
    private const string WorkSavepoint = "author_index_work";
    private static readonly TimeSpan BatchDeadline = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan IdleDelay = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan BatchDelay = TimeSpan.FromMilliseconds(20);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(5);
    private const string MatchJob = """
        owner_id=$1 and profile=$2 and definition_id=$3 and owner_generation=$4
        and schema_revision=$5 and definition_revision=$6 and available_at=$7
        """;

    internal Task EnqueueBody(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, CancellationToken ct,
        bool includeSummary = false, bool includeHeading = false) =>
        Queue.Enqueue(db, tx, actor, includeHeading ? AuthorTextRebuildProfile.Heading :
            includeSummary ? AuthorTextRebuildProfile.Summary : AuthorTextRebuildProfile.Legacy, 0, [(Guid.Empty, 0)], ct);

    internal Task EnqueueProperty(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, Guid definition,
        long schemaRevision, long definitionRevision, CancellationToken ct) =>
        Queue.EnqueueProperties(db, tx, actor, schemaRevision, [(definition, definitionRevision)], ct);

    internal AuthorTextRebuildQueue Queue => new(lease);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!lease.AuthorTextRebuildInstalled) return;
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, lease.Stopped);
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var hadWork = await RunNext(stop.Token);
                await Task.Delay(hadWork ? BatchDelay : IdleDelay, stop.Token);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        catch (PublicUnavailableException) when (!lease.IsCurrent) { }
    }

    private async Task<bool> RunNext(CancellationToken ct)
    {
        Job? job = null;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(BatchDeadline);
        try
        {
            var token = budget.Token;
            await using var db = await source.OpenConnectionAsync(token);
            // The single instance lease owns execution. Select coordinates without a
            // queue lock, since a foreground query holds the owner scope before enqueueing.
            job = await Next(db, token);
            if (job is null) return false;
            await using var tx = await InstanceLease.BeginProtected(db, lease, token);
            await Process(db, tx, job, token);
            await InstanceLease.CommitProtected(tx, lease, token);
            return true;
        }
        catch (Exception error) when (!ct.IsCancellationRequested && error is not PublicUnavailableException)
        {
            log.LogWarning("Private search indexing paused after {ErrorType}; pending work remains durable.", error.GetType().Name);
            if (job is not null) await Defer(job, ct);
            return false;
        }
    }

    private static async Task<Job?> Next(NpgsqlConnection db, CancellationToken ct)
    {
        await using var command = Store.Sql(db, null, """
            select owner_id,profile,definition_id,owner_generation,schema_revision,definition_revision,available_at
            from public.author_text_rebuild_job where available_at<=statement_timestamp()
            order by available_at,owner_id,profile,definition_id limit 1
            """);
        command.CommandTimeout = 3;
        await using var row = await command.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? new(row.GetGuid(0), (AuthorTextRebuildProfile)row.GetInt32(1),
            row.GetGuid(2), row.GetInt64(3), row.GetInt64(4), row.GetInt64(5), row.GetDateTime(6)) : null;
    }

    private static async Task Process(NpgsqlConnection db, NpgsqlTransaction tx, Job job, CancellationToken ct)
    {
        await using (var account = Store.Sql(db, tx, """
            select enabled and can_author and generation=$2 from public.blog_user where id=$1 for share
            """, job.Owner, job.OwnerGeneration))
        {
            account.CommandTimeout = 3;
            if (!job.Valid || await account.ExecuteScalarAsync(ct) is not true)
            {
                await SetPending(db, tx, job, null, ct);
                return;
            }
        }

        var properties = new PropertyStore(db, tx, job.Owner);
        AuthorTextPropertyScope? text = null;
        if (job.Profile == AuthorTextRebuildProfile.PropertyText)
        {
            try { text = await properties.ResolveTextProjection(job.SchemaRevision, job.Definition, job.DefinitionRevision, ct); }
            catch (BusinessException error) when (error.Rejection is Rejection.NotFound or Rejection.Conflict)
            {
                await SetPending(db, tx, job, null, ct);
                return;
            }
        }

        await AuthorTextIndex.LockRebuild(db, tx, job.Owner, ct);
        await using (var current = Store.Sql(db, tx,
            $"select exists(select from public.author_text_rebuild_job where {MatchJob})", job.Arguments()))
            if (await current.ExecuteScalarAsync(ct) is not true) return;

        await tx.SaveAsync(WorkSavepoint, ct);
        try
        {
            var remaining = text is null
                ? await AuthorTextIndex.ResumeBody(db, tx, job.Owner, job.Profile, ct)
                : await AuthorTextIndex.ResumeProperty(db, tx, job.Owner, properties, text, ct);
            await SetPending(db, tx, job, remaining ? TimeSpan.Zero : null, ct);
        }
        catch (AuthorHeadingBudgetException)
        {
            // A foreground heading request will still report its typed 422. Do
            // not keep retrying a source the canonical parser refused to admit.
            await tx.RollbackAsync(WorkSavepoint, ct);
            await SetPending(db, tx, job, null, ct);
        }
    }

    private async Task Defer(Job job, CancellationToken ct)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(IdleDelay);
        try
        {
            await using var db = await source.OpenConnectionAsync(budget.Token);
            await using var tx = await InstanceLease.BeginProtected(db, lease, budget.Token);
            await SetPending(db, tx, job, RetryDelay, budget.Token);
            await InstanceLease.CommitProtected(tx, lease, budget.Token);
        }
        catch (Exception error) when (!ct.IsCancellationRequested && error is not PublicUnavailableException)
        {
            log.LogWarning("Private search indexing could not defer its pending work after {ErrorType}.", error.GetType().Name);
        }
    }

    private static async Task SetPending(NpgsqlConnection db, NpgsqlTransaction tx, Job job, TimeSpan? delay, CancellationToken ct)
    {
        var sql = delay.HasValue ? "update public.author_text_rebuild_job set available_at=clock_timestamp()+$8::interval" :
            "delete from public.author_text_rebuild_job";
        object[] args = delay is { } interval ? [.. job.Arguments(), interval] : job.Arguments();
        await using var command = Store.Sql(db, tx, $"{sql} where {MatchJob}", args);
        command.CommandTimeout = 3;
        await command.ExecuteNonQueryAsync(ct);
    }

    private sealed record Job(Guid Owner, AuthorTextRebuildProfile Profile, Guid Definition, long OwnerGeneration,
        long SchemaRevision, long DefinitionRevision, DateTime AvailableAt)
    {
        internal bool Valid => Profile switch
        {
            AuthorTextRebuildProfile.Legacy or AuthorTextRebuildProfile.Summary or AuthorTextRebuildProfile.Heading =>
                Definition == Guid.Empty && SchemaRevision == 0 && DefinitionRevision == 0,
            AuthorTextRebuildProfile.PropertyText =>
                Definition != Guid.Empty && DefinitionRevision > 0 && SchemaRevision >= DefinitionRevision,
            _ => false
        };

        internal object[] Arguments() => [Owner, (int)Profile, Definition, OwnerGeneration, SchemaRevision, DefinitionRevision, AvailableAt];
    }
}
