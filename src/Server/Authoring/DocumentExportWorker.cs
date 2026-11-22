using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal sealed class DocumentExportWorker(NpgsqlDataSource source, InstanceLease lease, PdfDocumentExport? pdf,
    MediaFiles? media, ILogger<DocumentExportWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, lease.Stopped);
        var ct = lifetime.Token;
        var initialized = false;
        var nextCleanup = DateTimeOffset.MinValue;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    if (!initialized)
                    {
                        await InterruptPreviousRun(ct);
                        initialized = true;
                    }
                    if (DateTimeOffset.UtcNow >= nextCleanup)
                    {
                        await RemoveExpired(ct);
                        nextCleanup = DateTimeOffset.UtcNow.AddSeconds(30);
                    }
                    var job = await Claim(ct);
                    if (job is not null) await Run(job, ct);
                    else await Task.Delay(TimeSpan.FromSeconds(1), ct);
                }
                catch (Exception error) when (!ct.IsCancellationRequested && lease.IsCurrent &&
                    error is NpgsqlException or TimeoutException or PublicUnavailableException)
                {
                    // A failed terminal write leaves a running receipt. Interrupt that attempt after reconnecting.
                    initialized = false;
                    log.LogWarning("Document export polling paused after {ErrorKind}.", error.GetType().Name);
                    await Task.Delay(TimeSpan.FromSeconds(2), ct);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (PublicUnavailableException) when (!lease.IsCurrent) { }
    }

    private Task<int> InterruptPreviousRun(CancellationToken ct) =>
        InTransaction(async (db, tx) =>
        {
            return await SqlCommands.Execute(db, tx, ct, """
                update public.author_document_export
                set state=case when state=7 then 5 else 4 end,
                    failure=case when state=7 then 0 else 4 end, finished_at=statement_timestamp()
                where state in (2,7)
                """);
        }, ct);

    private Task<int> RemoveExpired(CancellationToken ct) =>
        InTransaction(async (db, tx) =>
        {
            return await SqlCommands.Execute(db, tx, ct, """
                delete from public.author_document_export e
                where e.expires_at<=statement_timestamp()
                   or not exists (select from public.admin_principal p where p.id=e.owner_id
                       and p.enabled and p.generation=e.author_generation)
                   or exists (select from public.article a where a.id=e.article_id and a.deleted)
                """);
        }, ct);

    private Task<Job?> Claim(CancellationToken ct) =>
        InTransaction<Job?>(async (db, tx) =>
        {
            await using var claim = Store.Sql(db, tx, """
                with next as (
                    select owner_id,id from public.author_document_export
                    where state=1 and expires_at>statement_timestamp()
                    order by created_at,owner_id,id limit 1 for update skip locked
                )
                update public.author_document_export e set state=2,started_at=statement_timestamp()
                from next where e.owner_id=next.owner_id and e.id=next.id
                returning e.owner_id,e.author_generation,e.id,e.article_id,e.expected_revision,e.source_revision,e.format,e.source_digest,e.provider
                """);
            await using var row = await claim.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct)) return null;
            return new(row.GetGuid(0), row.GetInt64(1), new(row.GetGuid(2), row.GetInt32(3), row.GetInt64(4),
                row.GetInt64(5), (DocumentExportFormat)row.GetInt16(6)), row.GetFieldValue<byte[]>(7), row.GetInt16(8));
        }, ct);

    private async Task Run(Job job, CancellationToken ct)
    {
        byte[]? output = null;
        var failure = DocumentExportFailure.None;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(20));
        var cancellation = WatchCancellation(job, budget);
        try
        {
            var input = await InTransaction(async (db, tx) =>
            {
                await RequireAuthority(db, tx, job, budget.Token);
                return await DocumentExportInput.ReadVerified(db, tx, job.Request, media, job.Owner, job.Provider,
                    job.SourceDigest, pdf?.ToolDigest, budget.Token);
            }, budget.Token);
            output = await DocumentExportInput.Render(job.Request.Format, input.Title, input.Body, input.HappenedAt,
                input.Attachments, pdf, budget.Token, includeTables: job.Provider != 1);
            budget.Token.ThrowIfCancellationRequested();
            if (output.Length is <= 0 or > PdfWorkerProtocol.MaximumOutput) throw new PublicUnavailableException();
        }
        catch (BusinessException error)
        {
            output = null;
            failure = error.Rejection is Rejection.Forbidden or Rejection.NotFound
                ? DocumentExportFailure.Permission : DocumentExportFailure.Unsupported;
        }
        catch (Exception error) when (!ct.IsCancellationRequested && error is PublicUnavailableException or
            OperationCanceledException or TimeoutException or NpgsqlException or InvalidOperationException)
        {
            output = null;
            failure = error is OperationCanceledException
                ? DocumentExportFailure.Interrupted : DocumentExportFailure.Unavailable;
        }
        finally
        {
            await budget.CancelAsync();
            await cancellation;
        }

        ct.ThrowIfCancellationRequested();
        await Finish(job, output, failure, ct);
    }

    private async Task WatchCancellation(Job job, CancellationTokenSource budget)
    {
        var ct = budget.Token;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(400), ct);
                await using var db = await source.OpenConnectionAsync(ct);
                await using var check = Store.Sql(db, null, """
                    select exists(
                        select from public.author_document_export e join public.admin_principal p on p.id=e.owner_id
                        join public.article a on a.id=e.article_id
                        where e.owner_id=$1 and e.id=$2 and e.state=2 and e.expires_at>statement_timestamp()
                        and p.enabled and p.generation=e.author_generation
                        and not a.deleted)
                    """, job.Owner, job.Request.Id);
                check.CommandTimeout = 2;
                if (await check.ExecuteScalarAsync(ct) is true) continue;
                await budget.CancelAsync();
                return;
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception error) when (error is NpgsqlException or TimeoutException)
        {
            await budget.CancelAsync();
        }
    }

    private Task<int> Finish(Job job, byte[]? output, DocumentExportFailure failure, CancellationToken ct) =>
        InTransaction(async (db, tx) =>
        {
            try { await RequireAuthority(db, tx, job, ct); }
            catch (BusinessException error) when (error.Rejection is Rejection.Forbidden or Rejection.NotFound)
            {
                output = null;
                failure = DocumentExportFailure.Permission;
            }
            var state = failure switch
            {
                DocumentExportFailure.None => DocumentExportState.Succeeded,
                DocumentExportFailure.Permission => DocumentExportState.Blocked,
                _ => DocumentExportState.Failed
            };
            var digest = output is null ? null : SHA256.HashData(output);
            return await SqlCommands.Execute(db, tx, ct, """
                update public.author_document_export
                set state=case when state=7 then 5 else $3 end,
                    failure=case when state=7 then 0 else $4 end, finished_at=statement_timestamp(),
                    output_digest=case when state=7 then null else $5 end,
                    output=case when state=7 then null else $6 end
                where owner_id=$1 and id=$2 and state in (2,7) and expires_at>statement_timestamp()
                """, job.Owner, job.Request.Id, (short)state, (short)failure,
                SqlCommands.Optional(NpgsqlDbType.Bytea, digest),
                SqlCommands.Optional(NpgsqlDbType.Bytea, output));
        }, ct);

    private static async Task RequireAuthority(NpgsqlConnection db, NpgsqlTransaction tx, Job job, CancellationToken ct)
    {
        if (await SqlCommands.Scalar(db, tx, ct, """
            select true from public.admin_principal p
            where p.id=$1 and p.generation=$2 and p.enabled
            for share
            """, job.Owner, job.Generation) is not true)
            throw new BusinessException(Rejection.Forbidden, "Document export author authority changed.");
        await RevisionHistoryStore.LockOwned(db, tx, job.Owner, job.Request.Article, ct);
    }

    private async Task<T> InTransaction<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> operation, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var result = await operation(db, tx);
        await InstanceLease.CommitProtected(tx, lease, ct);
        return result;
    }

    private sealed record Job(Guid Owner, long Generation, DocumentExportCreate Request, byte[] SourceDigest, short Provider);
}
