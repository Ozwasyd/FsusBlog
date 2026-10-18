using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Storage;

namespace FsusBlog.Server.Services.DocumentExport.Jobs;

/// <summary>
/// The sole persistent job/custody lifecycle. Provider execution and verification
/// stay with their canonical owners. Explicit worker claims fence duplicate,
/// cancelled and stale commits; interrupted claims require original-authority
/// quiescence before retry. This service grants no physical qualification.
/// </summary>
public sealed class DocumentExportJobService : IDocumentExportJobs
{
    private readonly DocumentExportJobRepository _repository;
    private readonly IDocumentExportJobAuthorization _authorization;
    private readonly TimeProvider _time;

    public DocumentExportJobService(ReleaseStorageLayout layout, Microsoft.AspNetCore.DataProtection.IDataProtectionProvider protection,
        IDocumentExportJobAuthorization authorization, TimeProvider? time = null)
    {
        _repository = new DocumentExportJobRepository(layout, protection);
        _authorization = authorization ?? throw new ArgumentNullException(nameof(authorization));
        _time = time ?? TimeProvider.System;
    }

    internal DocumentExportJobService(DocumentExportJobRepository repository,
        IDocumentExportJobAuthorization authorization, TimeProvider time)
    {
        _repository = repository;
        _authorization = authorization;
        _time = time;
    }

    public async Task<DocumentExportJobSnapshot> CreateAsync(DocumentExportJobActor actor,
        DocumentExportTask task, DocumentExportFrozenInput input, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        RequireInputAdmission(task, input);
        DocumentExportContractValidator.Validate(task, input);
        if (task.UserId != actor.UserId || task.SiteScope != actor.SiteScope || task.Status != DocumentExportTaskStatus.Queued)
        {
            throw new DocumentExportJobDeniedException();
        }
        await RequirePermissionAsync(actor, task, DocumentExportJobOperation.Create, cancellationToken).ConfigureAwait(false);
        // Seal only after validating the received digest; never silently repair tampering.
        DocumentExportFrozenInput frozen = DocumentExportContractValidator.Seal(input);
        string requestDigest = RequestDigest(task);
        return await _repository.UpdateAsync(async state =>
        {
            await RequirePermissionAsync(actor, task, DocumentExportJobOperation.Create, cancellationToken).ConfigureAwait(false);
            DocumentExportStoredJob? existing = state.Jobs.SingleOrDefault(job =>
                SameOwner(job.Snapshot.Task, actor) && job.AdmissionTask.IdempotencyKey == task.IdempotencyKey);
            if (existing is not null)
            {
                if (existing.RequestDigest != requestDigest || existing.Snapshot.ExpiresAt <= Now)
                {
                    throw new DocumentExportJobDeniedException();
                }
                return existing.Snapshot;
            }
            if (state.Jobs.Any(job => job.Snapshot.Task.TaskId == task.TaskId)
                || state.Jobs.Count >= DocumentExportJobPolicy.MaximumJobs
                || state.Jobs.Where(job => job.Input is not null).Sum(job => InputBytes(job.Input!)) + InputBytes(frozen)
                    > DocumentExportJobPolicy.MaximumTotalInputBytes
                || state.Jobs.Count(job => job.Snapshot.Task.UserId == actor.UserId) >= DocumentExportJobPolicy.MaximumOwnerJobs
                || state.Jobs.Count(job => job.Snapshot.Task.SiteScope == actor.SiteScope) >= DocumentExportJobPolicy.MaximumSiteJobs)
            {
                throw new DocumentExportJobDeniedException();
            }
            DateTimeOffset created = Now;
            var snapshot = new DocumentExportJobSnapshot(DocumentExportJobPolicy.SnapshotSchema, task,
                created, created.Add(DocumentExportJobPolicy.JobTtl), [], null, "queued", 1);
            state.Jobs.Add(Audit(new DocumentExportStoredJob(snapshot, task, frozen, requestDigest, null, null, null, null, [], false, null),
                "created", "queued"));
            return snapshot;
        }, cancellationToken, initialize: true).ConfigureAwait(false);
    }

    public Task<ImmutableArray<DocumentExportJobSnapshot>> ListAsync(DocumentExportJobActor actor, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        return _repository.ReadAsync(async state =>
        {
            var visible = ImmutableArray.CreateBuilder<DocumentExportJobSnapshot>();
            foreach (DocumentExportStoredJob job in state.Jobs.Where(job => SameOwner(job.Snapshot.Task, actor)))
            {
                if (await AllowedAsync(actor, job.Snapshot.Task, DocumentExportJobOperation.Read, cancellationToken).ConfigureAwait(false))
                {
                    visible.Add(Project(job.Snapshot));
                }
            }
            return visible.OrderByDescending(job => job.CreatedAt).ToImmutableArray();
        }, cancellationToken);
    }

    public Task<DocumentExportJobSnapshot> GetAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        return _repository.ReadAsync(async state =>
        {
            DocumentExportStoredJob job = await RequireJobAsync(state, actor, taskId,
                DocumentExportJobOperation.Read, cancellationToken).ConfigureAwait(false);
            return Project(job.Snapshot);
        }, cancellationToken);
    }

    public Task<DocumentExportJobSnapshot> CancelAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken)
        => StopAsync(actor, taskId, DocumentExportJobOperation.Cancel, cancellationToken);

    public async Task DeleteAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken)
        => await StopAsync(actor, taskId, DocumentExportJobOperation.Delete, cancellationToken).ConfigureAwait(false);

    private Task<DocumentExportJobSnapshot> StopAsync(DocumentExportJobActor actor, string taskId,
        DocumentExportJobOperation operation, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        return _repository.UpdateAsync(async state =>
        {
            DocumentExportStoredJob job = await RequireJobAsync(state, actor, taskId, operation, cancellationToken).ConfigureAwait(false);
            RevokeGrants(state, taskId);
            job = job with
            {
                StopRequested = true
            };
            if (job.WorkerDigest is not null)
            {
                job = Change(job, DocumentExportTaskStatus.Cancelling, "cancel_requested");
            }
            else
            {
                job = Change(job, DocumentExportTaskStatus.CleanupRequired,
                    operation == DocumentExportJobOperation.Delete ? "delete_requested" : "cancel_requested") with
                {
                    Input = null
                };
            }
            Put(state, job);
            _repository.Save(state);
            if (job.WorkerDigest is null)
            {
                job = CleanupJob(state, job, DocumentExportTaskStatus.Cancelled);
            }
            return job.Snapshot;
        }, cancellationToken);
    }

    public Task<DocumentExportJobSnapshot> RetryAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        return _repository.UpdateAsync(async state =>
        {
            DocumentExportStoredJob job = await RequireJobAsync(state, actor, taskId,
                DocumentExportJobOperation.Retry, cancellationToken).ConfigureAwait(false);
            if (job.Snapshot.Task.Status != DocumentExportTaskStatus.Failed || job.WorkerDigest is not null
                || job.PendingOutput is not null || job.Snapshot.Output is not null || job.Input is null
                || job.Snapshot.ExpiresAt <= Now || job.Snapshot.Attempts.Length >= DocumentExportJobPolicy.MaximumAttempts)
            {
                throw new DocumentExportJobDeniedException();
            }
            job = Change(job, DocumentExportTaskStatus.Queued, "diagnostic_retry_queued");
            Put(state, job);
            return job.Snapshot;
        }, cancellationToken);
    }

    /// <summary>
    /// Called by the existing internal dispatcher with a canonical format adapter.
    /// The durable exclusive claim is taken before provider invocation. Duplicate
    /// callers return the current projection without launching another attempt.
    /// </summary>
    public async Task<DocumentExportJobSnapshot> ExecuteAsync(DocumentExportJobActor actor, string taskId,
        IDocumentExportJobProvider provider, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        ArgumentNullException.ThrowIfNull(provider);
        string worker = NewToken();
        string workerDigest = HashToken(worker);
        DocumentExportStoredJob claimed = await _repository.UpdateAsync(async state =>
        {
            DocumentExportStoredJob job = await RequireJobAsync(state, actor, taskId,
                DocumentExportJobOperation.Create, cancellationToken).ConfigureAwait(false);
            if (job.Snapshot.Task.ProviderId != provider.ProviderId)
            {
                throw new DocumentExportJobDeniedException();
            }
            if (job.Snapshot.Task.Status != DocumentExportTaskStatus.Queued || job.WorkerDigest is not null)
            {
                return job;
            }
            if (!DocumentExportContractCatalog.RequireProvider(job.Snapshot.Task.FormatId).ImplementationAvailable)
            {
                job = Change(job, DocumentExportTaskStatus.Blocked, "provider_unavailable");
                Put(state, job);
                return job;
            }
            if (provider is not IDocumentExportAttemptJobProvider)
            {
                job = Change(job, DocumentExportTaskStatus.Blocked, "attempt_resource_adapter_unavailable");
                Put(state, job);
                return job;
            }
            if (job.Input is null || job.Snapshot.ExpiresAt <= Now)
            {
                job = Change(job, DocumentExportTaskStatus.Expired, "expired") with
                {
                    Input = null
                };
                Put(state, job);
                return job;
            }
            DocumentExportContractValidator.Validate(job.Snapshot.Task, job.Input);
            job = Change(job, DocumentExportTaskStatus.Preparing, "preparing");
            job = Change(job, DocumentExportTaskStatus.Running, "running");
            var attempt = new DocumentExportJobAttempt(job.Snapshot.Attempts.Length + 1,
                job.Snapshot.Attempts.Length != 0, Now, null, DocumentExportTaskStatus.Running, "running");
            job = job with
            {
                Snapshot = job.Snapshot with
                {
                    Attempts = job.Snapshot.Attempts.Add(attempt)
                },
                WorkerDigest = workerDigest,
                ExecutionTask = job.Snapshot.Task
            };
            Put(state, job);
            return job;
        }, cancellationToken).ConfigureAwait(false);
        if (claimed.WorkerDigest != workerDigest)
        {
            return Project(claimed.Snapshot);
        }
        using var stop = new CancellationTokenSource();
        using var deadline = new DocumentExportAttemptDeadline(claimed.ExecutionTask!, _time, cancellationToken, stop.Token);
        CancellationToken operation = deadline.Token;
        using var watch = new CancellationTokenSource();
        Task monitor = WatchCancellationAsync(taskId, workerDigest, stop, watch.Token);
        bool resultVerified = false;
        try
        {
            DocumentExportTask execution = claimed.ExecutionTask!;
            DocumentExportFrozenInput input = claimed.Input!;
            operation.ThrowIfCancellationRequested();
            deadline.ThrowIfExpired();
            var attemptProvider = (IDocumentExportAttemptJobProvider)provider;
            DocumentExportAttemptResources resources = attemptProvider.CreateAttemptResources(execution, input, _time)
                ?? throw new InvalidDataException("document_export_attempt_resources_missing");
            DocumentExportProviderResult result = await attemptProvider.ExportAsync(execution, input, resources, operation).ConfigureAwait(false);
            operation.ThrowIfCancellationRequested();
            deadline.ThrowIfExpired();
            DocumentExportProviderContract contract = DocumentExportContractCatalog.RequireProvider(execution.FormatId);
            // Both buffers are provider-owned until copied. Admit their lengths
            // against the canonical owner before allocating either private copy;
            // the provider's supplied plan cannot enlarge this envelope.
            if (result.Bytes is null || result.SandboxOutputBytes is null
                || result.Bytes.LongLength > Math.Min(DocumentExportJobPolicy.MaximumOutputBytes, contract.Budgets.MaxOutputBytes)
                || result.SandboxOutputBytes.LongLength > Math.Min(DocumentExportJobPolicy.MaximumOutputBytes,
                    Math.Min(contract.Budgets.MaxOutputBytes, contract.Budgets.MaxMessageBytes)))
            {
                throw new InvalidDataException("document_export_result_rejected");
            }
            DocumentExportContractValidator.Validate(result.Receipt, execution, input, contract);
            if (result.Bytes.LongLength != result.Receipt.OutputBytes
                || result.Receipt.Status != DocumentExportProviderResultStatus.Succeeded)
            {
                throw new InvalidDataException("document_export_result_rejected");
            }
            // Verification and storage observe the same privately owned bytes.
            DocumentExportProviderResult owned = result with
            {
                Bytes = result.Bytes.ToArray(),
                SandboxOutputBytes = result.SandboxOutputBytes.ToArray(),
                Receipt = result.Receipt with
                {
                    ObservedFeatures = result.Receipt.ObservedFeatures.ToImmutableArray(),
                    Warnings = result.Receipt.Warnings.ToImmutableArray(),
                    Errors = result.Receipt.Errors.ToImmutableArray()
                }
            };
            await attemptProvider.VerifyAsync(owned, execution, input, resources, operation).ConfigureAwait(false);
            resultVerified = true;
            try
            {
                RequireAttemptCompleted(resources, execution, input, deadline);
            }
            catch (DocumentExportJobResourceStateException)
            {
                // A verifier return does not prove a failed or active resource
                // stage quiescent. Preserve the claim for the original recovery.
                resultVerified = false;
                throw;
            }
            catch (DocumentExportBudgetExceededException)
            {
                // Preserve the original caller/stop/deadline cancellation order.
                deadline.ThrowIfExpired();
                throw;
            }
            operation.ThrowIfCancellationRequested();
            deadline.ThrowIfExpired();
            if (owned.Bytes.LongLength != owned.Receipt.OutputBytes
                || DocumentExportDigest.ComputeBytes(owned.Bytes) != owned.Receipt.OutputDigest
                || owned.Receipt.SandboxReceiptDigest != owned.SandboxReceipt.ContentDigest)
            {
                throw new InvalidDataException("document_export_result_rejected");
            }
            return await CommitAsync(actor, taskId, workerDigest, owned, resources, execution, input, deadline, operation).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            if (exception is DocumentExportJobResourceStateException)
            {
                resultVerified = false;
            }
            // The adapter must return/throw only after its sandbox finalization.
            // No exception text, provider path or token enters the stored reason.
            DocumentExportSandboxReceipt? failure = exception switch
            {
                DocumentExportSandboxExecutionException failed => failed.Receipt,
                DocumentExportSandboxCancelledException cancelled => cancelled.Receipt,
                DocumentExportBudgetExceededException budget => budget.Receipt,
                _ => null
            };
            string reason = exception switch
            {
                DocumentExportBudgetExceededException { FailureCode: "task-wall-time-budget" } => "task_wall_time_budget_failed",
                OperationCanceledException when deadline.DeadlineCancelled => "task_wall_time_budget_failed",
                DocumentExportBudgetExceededException => "sandbox_budget_failed",
                DocumentExportSandboxExecutionException => "sandbox_execution_failed",
                DocumentExportSandboxCancelledException => "sandbox_cancelled",
                DocumentExportJobResourceStateException => "attempt_resources_unqualified",
                DocumentExportJobDeniedException => "permission_revoked",
                _ => "provider_failed"
            };
            return await FinishFailedAsync(taskId, workerDigest, cancellationToken.IsCancellationRequested || stop.IsCancellationRequested,
                reason, resultVerified, failure).ConfigureAwait(false);
        }
        finally
        {
            watch.Cancel();
            await monitor.ConfigureAwait(false);
        }
    }

    private static void RequireAttemptCompleted(DocumentExportAttemptResources resources, DocumentExportTask execution,
        DocumentExportFrozenInput input, DocumentExportAttemptDeadline deadline)
    {
        try
        {
            resources.RequireCompleted(execution, input);
        }
        catch (InvalidDataException exception)
        {
            throw new DocumentExportJobResourceStateException(exception);
        }
        catch (DocumentExportBudgetExceededException)
        {
            deadline.ThrowIfExpired();
            throw;
        }
    }

    private async Task WatchCancellationAsync(string taskId, string workerDigest,
        CancellationTokenSource operation, CancellationToken cancellationToken)
    {
        try
        {
            while (true)
            {
                await Task.Delay(100, cancellationToken).ConfigureAwait(false);
                bool cancel = await _repository.ReadAsync(state => Task.FromResult(
                    state.Jobs.SingleOrDefault(job => job.Snapshot.Task.TaskId == taskId) is not { } job
                    || job.WorkerDigest != workerDigest
                    || job.Snapshot.Task.Status == DocumentExportTaskStatus.Cancelling
                    || job.Snapshot.ExpiresAt <= Now), cancellationToken).ConfigureAwait(false);
                if (cancel)
                {
                    operation.Cancel();
                    return;
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch
        {
            operation.Cancel();
        }
    }

    private Task<DocumentExportJobSnapshot> CommitAsync(DocumentExportJobActor actor, string taskId,
        string workerDigest, DocumentExportProviderResult result, DocumentExportAttemptResources resources,
        DocumentExportTask execution, DocumentExportFrozenInput input, DocumentExportAttemptDeadline deadline,
        CancellationToken cancellationToken)
        => _repository.UpdateAsync(async state =>
        {
            DocumentExportStoredJob job = await RequireJobAsync(state, actor, taskId,
                DocumentExportJobOperation.Create, cancellationToken).ConfigureAwait(false);
            RequireAttemptCompleted(resources, execution, input, deadline);
            deadline.ThrowIfExpired();
            if (job.WorkerDigest != workerDigest || job.Snapshot.Task.Status != DocumentExportTaskStatus.Running
                || job.Snapshot.ExpiresAt <= Now || job.ExecutionTask is null || job.Input is null)
            {
                throw new DocumentExportJobDeniedException();
            }
            if (job.Snapshot.Attempts[^1].Diagnostic)
            {
                job = FinishAttempt(Change(job, DocumentExportTaskStatus.Failed, "diagnostic_success_unqualified"),
                    DocumentExportTaskStatus.Failed, "diagnostic_success_unqualified") with
                {
                    WorkerDigest = null
                };
                Put(state, job);
                return job.Snapshot;
            }
            DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(job.Snapshot.Task.FormatId);
            DocumentExportContractValidator.Validate(result.Receipt, job.ExecutionTask, job.Input, provider);
            RequireOutputQuota(state, job.Snapshot.Task, result.Bytes.LongLength);
            DateTimeOffset created = Now;
            DateTimeOffset expires = created.Add(provider.Delivery.RetentionTtl);
            if (expires > job.Snapshot.ExpiresAt)
            {
                expires = job.Snapshot.ExpiresAt;
            }
            var output = new DocumentExportOutputRecord(DocumentExportJobPolicy.OutputSchema, Guid.NewGuid().ToString("N"),
                taskId, actor.UserId, actor.SiteScope, job.Snapshot.Task.InputDigest, provider.ProviderId, provider.ProviderVersion,
                result.Receipt.ContentDigest, Guid.NewGuid().ToString("N"), provider.OutputMediaType, provider.OutputExtension,
                result.Receipt.OutputDigest, result.Bytes.LongLength, created, expires, null, string.Empty);
            output = SealOutput(output);
            RequireAttemptCompleted(resources, execution, input, deadline);
            cancellationToken.ThrowIfCancellationRequested();
            deadline.ThrowIfExpired();
            job = Change(job, DocumentExportTaskStatus.CleanupRequired, "commit_pending") with
            {
                PendingOutput = output,
                Receipt = result.Receipt
            };
            Put(state, job);
            // Durable cleanup obligation precedes the first object mutation.
            _repository.Save(state);
            await _repository.CommitObjectAsync(output, result.Bytes).ConfigureAwait(false);
            RequireAttemptCompleted(resources, execution, input, deadline);
            cancellationToken.ThrowIfCancellationRequested();
            deadline.ThrowIfExpired();
            await RequirePermissionAsync(actor, job.Snapshot.Task, DocumentExportJobOperation.Create, cancellationToken).ConfigureAwait(false);
            RequireAttemptCompleted(resources, execution, input, deadline);
            cancellationToken.ThrowIfCancellationRequested();
            deadline.ThrowIfExpired();
            job = Change(job, DocumentExportTaskStatus.Succeeded, "succeeded");
            job = FinishAttempt(job, DocumentExportTaskStatus.Succeeded, "succeeded") with
            {
                Snapshot = job.Snapshot with
                {
                    Output = output
                },
                Input = null,
                PendingOutput = null,
                WorkerDigest = null
            };
            job = FinishAttempt(job, DocumentExportTaskStatus.Succeeded, "succeeded");
            Put(state, job);
            return job.Snapshot;
        }, cancellationToken, validatePublication: () =>
        {
            RequireAttemptCompleted(resources, execution, input, deadline);
            deadline.ThrowIfExpired();
            cancellationToken.ThrowIfCancellationRequested();
        });

    private Task<DocumentExportJobSnapshot> FinishFailedAsync(string taskId, string workerDigest, bool cancelled,
        string reason, bool resultVerified, DocumentExportSandboxReceipt? failure)
        => _repository.UpdateAsync(state =>
        {
            DocumentExportStoredJob job = state.Jobs.Single(row => row.Snapshot.Task.TaskId == taskId);
            if (job.WorkerDigest is null && job.Snapshot.Task.Status == DocumentExportTaskStatus.Succeeded)
            {
                // A failed final snapshot fsync can leave a renamed success visible.
                // It remains unqualified and must not be converted to a success.
                RevokeGrants(state, taskId);
                job = Change(job, DocumentExportTaskStatus.CleanupRequired, "persistence_unqualified");
                Put(state, job);
                _repository.Save(state);
                return Task.FromResult(job.Snapshot);
            }
            if (job.WorkerDigest != workerDigest)
            {
                return Task.FromResult(Project(job.Snapshot));
            }
            bool stop = cancelled || job.StopRequested || job.Snapshot.ExpiresAt <= Now;
            DocumentExportTaskStatus status = stop ? DocumentExportTaskStatus.Cancelled : DocumentExportTaskStatus.Failed;
            // Logical cancellation cannot overwrite an already observed sandbox failure.
            bool observedFailure = reason is "sandbox_budget_failed" or "sandbox_execution_failed" or "task_wall_time_budget_failed"
                or "attempt_resources_unqualified";
            job = FinishAttempt(Change(job, resultVerified ? status : DocumentExportTaskStatus.CleanupRequired, reason),
                observedFailure ? DocumentExportTaskStatus.Failed : status, reason) with
            {
                WorkerDigest = resultVerified ? null : workerDigest,
                Input = stop && resultVerified ? null : job.Input,
                StopRequested = stop,
                SandboxFailure = failure
            };
            if (job.PendingOutput is not null && job.WorkerDigest is null)
            {
                job = Change(job, DocumentExportTaskStatus.CleanupRequired, "commit_cleanup_required");
            }
            Put(state, job);
            _repository.Save(state);
            if (job.PendingOutput is not null && job.WorkerDigest is null)
            {
                job = CleanupJob(state, job, status);
            }
            return Task.FromResult(job.Snapshot);
        }, default);

    public Task<DocumentExportDownloadGrant> GrantAsync(DocumentExportJobActor actor, string taskId, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        return _repository.UpdateAsync(async state =>
        {
            DocumentExportStoredJob job = await RequireJobAsync(state, actor, taskId,
                DocumentExportJobOperation.Download, cancellationToken).ConfigureAwait(false);
            RequireDownloadable(job);
            state.Grants.RemoveAll(grant => grant.ExpiresAt <= Now);
            if (state.Grants.Count >= DocumentExportJobPolicy.MaximumGrants
                || job.Audit.Count(item => item.Kind == "grant" || item.Kind == "download" || item.Kind == "head") >= 96
                || state.Grants.Count(grant => grant.UserId == actor.UserId && grant.SiteScope == actor.SiteScope)
                    >= DocumentExportJobPolicy.MaximumOwnerGrants)
            {
                throw new DocumentExportJobDeniedException();
            }
            string token = NewToken();
            DateTimeOffset expiry = Now.Add(DocumentExportJobPolicy.GrantTtl);
            if (expiry > job.Snapshot.Output!.ExpiresAt)
            {
                expiry = job.Snapshot.Output.ExpiresAt;
            }
            state.Grants.Add(new DocumentExportStoredGrant(HashToken(token), taskId, job.Snapshot.Output.OutputId,
                actor.UserId, actor.SiteScope, HashToken(actor.SessionId), expiry));
            Put(state, Audit(job, "grant", "single_use_five_minutes"));
            return new DocumentExportDownloadGrant(token, expiry);
        }, cancellationToken);
    }

    public Task<DocumentExportDownload> DownloadAsync(DocumentExportJobActor actor, string token,
        bool head, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        if (token.Length != 64 || !token.All(char.IsAsciiHexDigit))
        {
            throw new DocumentExportJobDeniedException();
        }
        return _repository.UpdateAsync(async state =>
        {
            DocumentExportStoredGrant? grant = state.Grants.SingleOrDefault(candidate => candidate.TokenDigest == HashToken(token));
            if (grant is null || grant.UserId != actor.UserId || grant.SiteScope != actor.SiteScope
                || grant.SessionDigest != HashToken(actor.SessionId) || grant.ExpiresAt <= Now)
            {
                throw new DocumentExportJobDeniedException();
            }
            DocumentExportStoredJob job = await RequireJobAsync(state, actor, grant.TaskId,
                DocumentExportJobOperation.Download, cancellationToken).ConfigureAwait(false);
            RequireDownloadable(job);
            DocumentExportOutputRecord output = job.Snapshot.Output!;
            if (output.OutputId != grant.OutputId)
            {
                throw new DocumentExportJobDeniedException();
            }
            byte[] bytes;
            try
            {
                bytes = _repository.ReadObject(output);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
            {
                RevokeGrants(state, grant.TaskId);
                Put(state, Change(job, DocumentExportTaskStatus.CleanupRequired, "object_integrity_failed"));
                _repository.Save(state);
                throw new DocumentExportJobDeniedException();
            }
            if (!head)
            {
                state.Grants.Remove(grant);
                // Consume before returning private bytes, including delivery failure.
                Put(state, Audit(job, "download", "single_use_consumed"));
                _repository.Save(state);
            }
            else
            {
                if (job.Audit.Count(item => item.Kind == "grant" || item.Kind == "download" || item.Kind == "head") >= 96)
                {
                    throw new DocumentExportJobDeniedException();
                }
                Put(state, Audit(job, "head", "single_use_not_consumed"));
            }
            ImmutableDictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Content-Type"] = output.MediaType,
                ["Content-Length"] = output.Length.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["Content-Disposition"] = $"attachment; filename=\"export{output.Extension}\"",
                ["Cache-Control"] = "private, no-store, max-age=0",
                ["Pragma"] = "no-cache",
                ["Expires"] = "0",
                ["Accept-Ranges"] = "none",
                ["X-Content-Type-Options"] = "nosniff",
                ["Content-Security-Policy"] = "sandbox; default-src 'none'; frame-ancestors 'none'",
                ["Cross-Origin-Resource-Policy"] = "same-origin",
                ["Referrer-Policy"] = "no-referrer",
                ["X-Robots-Tag"] = "noindex, nofollow, noarchive"
            }.ToImmutableDictionary(StringComparer.OrdinalIgnoreCase);
            return new DocumentExportDownload(head ? [] : bytes, output.Length, headers);
        }, cancellationToken);
    }

    public Task RevokeSessionAsync(DocumentExportJobActor actor, CancellationToken cancellationToken)
    {
        RequireActor(actor);
        return _repository.UpdateAsync(state =>
        {
            state.Grants.RemoveAll(grant => grant.UserId == actor.UserId && grant.SiteScope == actor.SiteScope
                && grant.SessionDigest == HashToken(actor.SessionId));
            return Task.FromResult(true);
        }, cancellationToken);
    }

    /// <summary>
    /// Existing background dispatch schedules this method. Expiry and explicit
    /// revocation are fenced before physical cleanup; cleanup failure remains
    /// observable and retryable. Active workers are cancelled rather than reaped.
    /// </summary>
    public Task<DocumentExportJobUsage> CleanupAsync(CancellationToken cancellationToken)
        => _repository.UpdateAsync(state =>
        {
            state.Grants.RemoveAll(grant => grant.ExpiresAt <= Now);
            foreach (DocumentExportStoredJob row in state.Jobs.ToArray())
            {
                DocumentExportStoredJob job = row;
                bool expired = job.Snapshot.ExpiresAt <= Now || job.Snapshot.Output is { } output && output.ExpiresAt <= Now;
                if (expired)
                {
                    RevokeGrants(state, job.Snapshot.Task.TaskId);
                    job = Change(job, job.WorkerDigest is null ? DocumentExportTaskStatus.CleanupRequired
                        : DocumentExportTaskStatus.Cancelling, "expired") with
                    {
                        StopRequested = true
                    };
                    Put(state, job);
                    _repository.Save(state);
                }
                if (job.WorkerDigest is null && job.Snapshot.Task.Status == DocumentExportTaskStatus.CleanupRequired)
                {
                    CleanupJob(state, job, expired ? DocumentExportTaskStatus.Expired : DocumentExportTaskStatus.Cancelled);
                }
                DocumentExportStoredJob current = state.Jobs.Single(item => item.Snapshot.Task.TaskId == job.Snapshot.Task.TaskId);
                if (current.WorkerDigest is null && current.PendingOutput is null && current.Input is null
                    && current.Snapshot.Output is not { DeletedAt: null }
                    && current.Snapshot.ExpiresAt.Add(DocumentExportJobPolicy.TombstoneTtl) <= Now)
                {
                    state.Jobs.Remove(current);
                }
            }
            return Task.FromResult(Usage(state));
        }, cancellationToken);

    public Task<DocumentExportJobUsage> GetUsageAsync(CancellationToken cancellationToken)
        => _repository.ReadAsync(state => Task.FromResult(Usage(state)), cancellationToken);

    public Task<DocumentExportJobSnapshot> RecoverInterruptedAsync(string taskId,
        IDocumentExportJobRecovery recovery, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(recovery);
        return _repository.UpdateAsync(async state =>
        {
            DocumentExportStoredJob job = state.Jobs.SingleOrDefault(item => item.Snapshot.Task.TaskId == taskId)
                ?? throw new DocumentExportJobDeniedException();
            if (job.WorkerDigest is null)
            {
                return Project(job.Snapshot);
            }
            if (job.ExecutionTask is null || !await recovery.IsQuiescentAsync(job.ExecutionTask, cancellationToken).ConfigureAwait(false))
            {
                throw new DocumentExportJobDeniedException();
            }
            DocumentExportTaskStatus terminal = job.Snapshot.ExpiresAt <= Now ? DocumentExportTaskStatus.Expired
                : job.StopRequested ? DocumentExportTaskStatus.Cancelled
                : DocumentExportTaskStatus.Failed;
            job = FinishAttempt(Change(job, terminal, "interrupted_unqualified"),
                terminal, "interrupted_unqualified") with
            {
                WorkerDigest = null,
                Input = terminal == DocumentExportTaskStatus.Failed ? job.Input : null
            };
            if (job.PendingOutput is not null)
            {
                job = Change(job, DocumentExportTaskStatus.CleanupRequired, "interrupted_cleanup_required");
            }
            Put(state, job);
            _repository.Save(state);
            if (job.PendingOutput is not null)
            {
                job = CleanupJob(state, job, terminal);
            }
            return job.Snapshot;
        }, cancellationToken);
    }

    private DocumentExportStoredJob CleanupJob(DocumentExportJobState state, DocumentExportStoredJob job,
        DocumentExportTaskStatus terminal)
    {
        if (job.WorkerDigest is not null || state.Grants.Any(grant => grant.TaskId == job.Snapshot.Task.TaskId && grant.ExpiresAt > Now))
        {
            return job;
        }
        try
        {
            if (job.PendingOutput is { } pending)
            {
                _repository.DeleteObject(pending);
            }
            if (job.Snapshot.Output is { DeletedAt: null } output)
            {
                _repository.DeleteObject(output);
            }
            DocumentExportOutputRecord? tombstone = job.Snapshot.Output is { } record
                ? SealOutput(record with
                {
                    DeletedAt = record.DeletedAt ?? Now
                }) : null;
            job = Change(job, terminal, terminal == DocumentExportTaskStatus.Expired ? "expired" : "cleaned") with
            {
                Snapshot = Change(job, terminal, terminal == DocumentExportTaskStatus.Expired ? "expired" : "cleaned").Snapshot
                    with
                {
                    Output = tombstone
                },
                Input = null,
                PendingOutput = null
            };
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            job = Change(job, DocumentExportTaskStatus.CleanupRequired, "cleanup_failed");
        }
        Put(state, job);
        return job;
    }

    private async Task<DocumentExportStoredJob> RequireJobAsync(DocumentExportJobState state, DocumentExportJobActor actor,
        string taskId, DocumentExportJobOperation operation, CancellationToken cancellationToken)
    {
        DocumentExportStoredJob job = state.Jobs.SingleOrDefault(row => row.Snapshot.Task.TaskId == taskId)
            ?? throw new DocumentExportJobDeniedException();
        await RequirePermissionAsync(actor, job.Snapshot.Task, operation, cancellationToken).ConfigureAwait(false);
        return job;
    }

    private async Task RequirePermissionAsync(DocumentExportJobActor actor, DocumentExportTask task,
        DocumentExportJobOperation operation, CancellationToken cancellationToken)
    {
        if (!await AllowedAsync(actor, task, operation, cancellationToken).ConfigureAwait(false))
        {
            throw new DocumentExportJobDeniedException();
        }
    }

    private ValueTask<bool> AllowedAsync(DocumentExportJobActor actor, DocumentExportTask task,
        DocumentExportJobOperation operation, CancellationToken cancellationToken)
        => SameOwner(task, actor)
            ? _authorization.IsAllowedAsync(actor, task.Coordinate, operation, cancellationToken)
            : ValueTask.FromResult(false);

    private void RequireDownloadable(DocumentExportStoredJob job)
    {
        if (job.Snapshot.Task.Status != DocumentExportTaskStatus.Succeeded || job.WorkerDigest is not null
            || job.PendingOutput is not null || job.Snapshot.ExpiresAt <= Now
            || job.Snapshot.Output is not { DeletedAt: null } output || output.ExpiresAt <= Now)
        {
            throw new DocumentExportJobDeniedException();
        }
    }

    private DocumentExportJobSnapshot Project(DocumentExportJobSnapshot snapshot)
        => snapshot.ExpiresAt <= Now && snapshot.Task.Status != DocumentExportTaskStatus.CleanupRequired
            ? snapshot with
            {
                Task = DocumentExportContractValidator.Seal(snapshot.Task with
                {
                    Status = DocumentExportTaskStatus.Expired
                }),
                Reason = "expired"
            }
            : snapshot;

    private DocumentExportStoredJob Change(DocumentExportStoredJob job, DocumentExportTaskStatus status, string reason)
        => job.Snapshot.Task.Status == status && job.Snapshot.Reason == reason ? job : Audit(job with
        {
            Snapshot = job.Snapshot with
            {
                Task = DocumentExportContractValidator.Seal(job.Snapshot.Task with
                {
                    Status = status
                }),
                Reason = reason,
                Version = job.Snapshot.Version + 1
            }
        }, "status", reason);

    private DocumentExportStoredJob Audit(DocumentExportStoredJob job, string kind, string reason)
    {
        DocumentExportOutputRecord? output = job.Snapshot.Output ?? job.PendingOutput;
        if (kind == "status" && job.Audit.Any(item => item.Kind == kind && item.Status == job.Snapshot.Task.Status
            && item.Reason == reason && item.OutputId == output?.OutputId))
        {
            return job;
        }
        return job with
        {
            Audit = job.Audit.Add(new DocumentExportJobAuditEvent(kind, Now,
            job.Snapshot.Task.Status, output?.OutputId, output?.OutputDigest, output?.Length ?? 0, reason))
        };
    }

    private DocumentExportStoredJob FinishAttempt(DocumentExportStoredJob job, DocumentExportTaskStatus status, string reason)
    {
        DocumentExportJobAttempt last = job.Snapshot.Attempts[^1];
        if (last.FinishedAt is not null)
        {
            return job;
        }
        return job with
        {
            Snapshot = job.Snapshot with
            {
                Attempts = job.Snapshot.Attempts.SetItem(job.Snapshot.Attempts.Length - 1,
                    last with
                    {
                        FinishedAt = Now,
                        Status = status,
                        Reason = reason
                    })
            }
        };
    }

    private static void Put(DocumentExportJobState state, DocumentExportStoredJob job)
        => state.Jobs[state.Jobs.FindIndex(row => row.Snapshot.Task.TaskId == job.Snapshot.Task.TaskId)] = job;

    private static void RevokeGrants(DocumentExportJobState state, string taskId)
        => state.Grants.RemoveAll(grant => grant.TaskId == taskId);

    private static bool SameOwner(DocumentExportTask task, DocumentExportJobActor actor)
        => task.UserId == actor.UserId && task.SiteScope == actor.SiteScope;

    private static void RequireActor(DocumentExportJobActor actor)
    {
        if (actor is null || string.IsNullOrWhiteSpace(actor.SessionId)
            || actor.SessionId.Length > 160 || actor.SessionId.Any(char.IsControl))
        {
            throw new DocumentExportJobDeniedException();
        }
        try
        {
            DocumentExportContractValidator.RequireOwnerScope(actor.UserId, actor.SiteScope);
        }
        catch (ArgumentException)
        {
            throw new DocumentExportJobDeniedException();
        }
    }

    private static string RequestDigest(DocumentExportTask task)
        => DocumentExportDigest.Compute(task with
        {
            TaskId = string.Empty,
            RequestId = string.Empty,
            ContentDigest = string.Empty
        });

    private static void RequireInputAdmission(DocumentExportTask task, DocumentExportFrozenInput input)
    {
        ArgumentNullException.ThrowIfNull(task);
        ArgumentNullException.ThrowIfNull(input);
        // Keep the existing raw-byte quota. Bound metadata/framing separately
        // with the same envelope before shared validation allocates JSON digests.
        // Six bytes per UTF-8 byte bounds JSON escaping; 256 bytes bounds each
        // asset's field names, numeric fields and punctuation (excluding bytes).
        const int AssetFramingBytes = 256;
        if (input.MarkdownUtf8.IsDefault || input.Assets.IsDefault
            || input.MarkdownUtf8.Length > DocumentExportJobPolicy.MaximumInputBytes
            || input.Assets.Length > DocumentExportJobPolicy.MaximumInputBytes / AssetFramingBytes)
        {
            throw new DocumentExportJobDeniedException();
        }
        // No digest or ownership copy of an unsupported embed snapshot is needed.
        DocumentExportFrozenEmbedContract.RequireMaterializer(input.FrozenEmbeds);
        long metadataRemaining = DocumentExportJobPolicy.MaximumInputBytes - 4096
            - (long)input.Assets.Length * AssetFramingBytes;
        foreach (string? value in new[]
        {
            input.Schema, input.InputId, input.SiteScope, input.Coordinate?.DraftKey,
            input.SourceDigest, input.MetadataDigest, input.PropertyDigest, input.AssetManifestDigest,
            input.FontManifestDigest, input.RendererId, input.RendererVersion, input.RendererDigest,
            input.LayoutProfile, input.ThemeProfile, input.Locale, input.ReadingStyleAuthorityDigest, input.ContentDigest,
            task.Schema, task.TaskId, task.RequestId, task.IdempotencyKey, task.SiteScope, task.Coordinate?.DraftKey,
            task.InputId, task.InputDigest, task.SourceDigest, task.MetadataDigest, task.PropertyDigest,
            task.AssetManifestDigest, task.FontManifestDigest, task.ReadingStyleAuthorityDigest, task.RendererDigest,
            task.FormatId, task.ProviderId, task.ProviderVersion, task.LayoutProfile, task.ThemeProfile, task.Locale, task.ContentDigest
        })
        {
            AdmitMetadata(value);
        }
        foreach (DocumentExportAsset asset in input.Assets)
        {
            if (asset is null || asset.Bytes.IsDefault || asset.AltText is null || asset.FontFamily is null)
            {
                throw new DocumentExportJobDeniedException();
            }
            AdmitMetadata(asset.AssetId);
            AdmitMetadata(asset.MediaType);
            AdmitMetadata(asset.Sha256);
            AdmitMetadata(asset.AltText);
            AdmitMetadata(asset.Role);
            AdmitMetadata(asset.FontFamily);
            AdmitMetadata(asset.FontStyle);
        }
        if (InputBytes(input) > DocumentExportJobPolicy.MaximumInputBytes)
        {
            throw new DocumentExportJobDeniedException();
        }

        void AdmitMetadata(string? value)
        {
            if (metadataRemaining < 0 || value is not null
                && (value.Length > metadataRemaining / 6 || 6L * Encoding.UTF8.GetByteCount(value) > metadataRemaining))
            {
                throw new DocumentExportJobDeniedException();
            }
            metadataRemaining -= value is null ? 0 : 6L * Encoding.UTF8.GetByteCount(value);
        }
    }

    private static long InputBytes(DocumentExportFrozenInput input)
    {
        long remaining = DocumentExportJobPolicy.MaximumInputBytes - input.MarkdownUtf8.Length;
        foreach (DocumentExportAsset asset in input.Assets)
        {
            if (remaining < 0 || asset.Bytes.Length > remaining)
            {
                return DocumentExportJobPolicy.MaximumInputBytes + 1;
            }
            remaining -= asset.Bytes.Length;
            foreach (string value in new[] { asset.AltText, asset.FontFamily })
            {
                if (value.Length > remaining || Encoding.UTF8.GetByteCount(value) > remaining)
                {
                    return DocumentExportJobPolicy.MaximumInputBytes + 1;
                }
                remaining -= Encoding.UTF8.GetByteCount(value);
            }
        }
        return DocumentExportJobPolicy.MaximumInputBytes - remaining;
    }

    private static string NewToken() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private static string HashToken(string token) => DocumentExportDigest.ComputeBytes(Encoding.UTF8.GetBytes(token));

    private DateTimeOffset Now => _time.GetUtcNow();

    private static DocumentExportOutputRecord SealOutput(DocumentExportOutputRecord output)
    {
        DocumentExportOutputRecord unsigned = output with
        {
            ContentDigest = string.Empty
        };
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    internal static void ValidateStoredJob(DocumentExportStoredJob job)
    {
        DocumentExportJobSnapshot snapshot = job.Snapshot;
        DocumentExportTask task = snapshot.Task;
        try
        {
            DocumentExportContractValidator.RequireOwnerScope(task.UserId, task.SiteScope);
        }
        catch (ArgumentException exception)
        {
            throw new InvalidDataException("document_export_job_tampered", exception);
        }
        DocumentExportProviderContract canonical = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (snapshot.Schema != DocumentExportJobPolicy.SnapshotSchema || !Enum.IsDefined(task.Status)
            || task.Schema != DocumentExportContractCatalog.TaskSchema || job.AdmissionTask.Schema != DocumentExportContractCatalog.TaskSchema
            || task.ProviderId != canonical.ProviderId || task.ProviderVersion != canonical.ProviderVersion
            || task.ReadingStyleAuthorityDigest != DocumentExportReadingStyleAuthority.AuthorityDigest
            || task.ContentDigest != DocumentExportContractValidator.Seal(task).ContentDigest
            || job.AdmissionTask.ContentDigest != DocumentExportContractValidator.Seal(job.AdmissionTask).ContentDigest
            || job.AdmissionTask.Status != DocumentExportTaskStatus.Queued || snapshot.Version <= 0
            || task.TaskId != job.AdmissionTask.TaskId || task.RequestId != job.AdmissionTask.RequestId
            || RequestDigest(job.AdmissionTask) != job.RequestDigest
            || RequestDigest(task with
            {
                Status = DocumentExportTaskStatus.Queued
            }) != job.RequestDigest
            || snapshot.ExpiresAt != snapshot.CreatedAt.Add(DocumentExportJobPolicy.JobTtl)
            || snapshot.Attempts.Length > DocumentExportJobPolicy.MaximumAttempts || job.Audit.Length > 128)
        {
            throw new InvalidDataException("document_export_job_tampered");
        }
        if (job.Input is not null)
        {
            DocumentExportContractValidator.Validate(job.AdmissionTask, job.Input);
        }
        if (job.ExecutionTask is { } execution && job.Input is not null)
        {
            DocumentExportContractValidator.Validate(execution, job.Input);
        }
        if (job.ExecutionTask is { } storedExecution
            && (storedExecution.TaskId != task.TaskId || storedExecution.RequestId != task.RequestId
                || storedExecution.Status != DocumentExportTaskStatus.Running
                || storedExecution.ContentDigest != DocumentExportContractValidator.Seal(storedExecution).ContentDigest
                || RequestDigest(storedExecution with
                {
                    Status = DocumentExportTaskStatus.Queued
                }) != job.RequestDigest))
        {
            throw new InvalidDataException("document_export_execution_tampered");
        }
        if (job.Receipt is { } receipt && receipt.ContentDigest != DocumentExportContractValidator.Seal(receipt).ContentDigest)
        {
            throw new InvalidDataException("document_export_receipt_tampered");
        }
        if (job.Receipt is { } boundReceipt
            && (boundReceipt.Schema != DocumentExportContractCatalog.ResultSchema
                || boundReceipt.TaskDigest != job.ExecutionTask?.ContentDigest || boundReceipt.InputDigest != task.InputDigest
                || boundReceipt.ProviderId != canonical.ProviderId || boundReceipt.ProviderVersion != canonical.ProviderVersion
                || boundReceipt.RendererId != canonical.RendererId || boundReceipt.RendererVersion != canonical.RendererVersion
                || boundReceipt.RendererDigest != task.RendererDigest
                || boundReceipt.Status != DocumentExportProviderResultStatus.Succeeded))
        {
            throw new InvalidDataException("document_export_receipt_tampered");
        }
        foreach (DocumentExportOutputRecord output in new[] { snapshot.Output, job.PendingOutput }.OfType<DocumentExportOutputRecord>())
        {
            DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
            if (output.Schema != DocumentExportJobPolicy.OutputSchema || output.ContentDigest != SealOutput(output).ContentDigest
                || output.TaskId != task.TaskId || output.UserId != task.UserId || output.SiteScope != task.SiteScope
                || output.InputDigest != task.InputDigest || output.ProviderId != task.ProviderId || output.ProviderVersion != task.ProviderVersion
                || output.MediaType != provider.OutputMediaType || output.Extension != provider.OutputExtension
                || output.Length <= 0 || output.Length > Math.Min(provider.Budgets.MaxOutputBytes, DocumentExportJobPolicy.MaximumOutputBytes)
                || output.ExpiresAt > snapshot.ExpiresAt || output.ExpiresAt <= output.CreatedAt
                || output.ResultReceiptDigest != job.Receipt?.ContentDigest
                || output.OutputDigest != job.Receipt.OutputDigest || output.Length != job.Receipt.OutputBytes)
            {
                throw new InvalidDataException("document_export_output_tampered");
            }
        }
    }

    private static void RequireOutputQuota(DocumentExportJobState state, DocumentExportTask task, long length)
    {
        DocumentExportOutputRecord[] outputs = state.Jobs.SelectMany(job => new[] { job.Snapshot.Output, job.PendingOutput })
            .OfType<DocumentExportOutputRecord>().Where(output => output.DeletedAt is null).ToArray();
        if (length > DocumentExportJobPolicy.MaximumOutputBytes
            || outputs.Sum(output => output.Length) + length > DocumentExportJobPolicy.MaximumTotalOutputBytes
            || outputs.Where(output => output.SiteScope == task.SiteScope).Sum(output => output.Length) + length > DocumentExportJobPolicy.MaximumSiteOutputBytes
            || outputs.Where(output => output.UserId == task.UserId).Sum(output => output.Length) + length
                > DocumentExportJobPolicy.MaximumOwnerOutputBytes)
        {
            throw new DocumentExportJobDeniedException();
        }
    }

    private DocumentExportJobUsage Usage(DocumentExportJobState state)
    {
        DocumentExportOutputRecord[] outputs = state.Jobs.SelectMany(job => new[] { job.Snapshot.Output, job.PendingOutput })
            .OfType<DocumentExportOutputRecord>().Where(output => output.DeletedAt is null).ToArray();
        ImmutableArray<DocumentExportJobScopeUsage> scopes = state.Jobs.GroupBy(job => job.Snapshot.Task.UserId)
            .Select(group => new DocumentExportJobScopeUsage(group.Key, null, group.Count(),
                outputs.Count(output => output.UserId == group.Key), outputs.Where(output => output.UserId == group.Key).Sum(output => output.Length)))
            .Concat(state.Jobs.GroupBy(job => job.Snapshot.Task.SiteScope, StringComparer.Ordinal).Select(group => new DocumentExportJobScopeUsage(null, group.Key,
                group.Count(), outputs.Count(output => output.SiteScope == group.Key), outputs.Where(output => output.SiteScope == group.Key).Sum(output => output.Length))))
            .ToImmutableArray();
        return new DocumentExportJobUsage(state.Jobs.Count, outputs.Length, outputs.Sum(output => output.Length),
            state.Jobs.Count(job => job.Snapshot.Task.Status == DocumentExportTaskStatus.CleanupRequired
                || job.WorkerDigest is not null && job.Snapshot.ExpiresAt <= Now))
        {
            Scopes = scopes
        };
    }
}
