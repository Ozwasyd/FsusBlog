using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Services.PrivateAssets;

namespace FsusBlog.Server.Services.DocumentExport.Jobs;

internal sealed record DocumentExportStoredGrant(
    string TokenDigest,
    string TaskId,
    string OutputId,
    long UserId,
    string SiteScope,
    string SessionDigest,
    DateTimeOffset ExpiresAt);

internal sealed record DocumentExportStoredJob(
    DocumentExportJobSnapshot Snapshot,
    DocumentExportTask AdmissionTask,
    DocumentExportFrozenInput? Input,
    string RequestDigest,
    string? WorkerDigest,
    DocumentExportTask? ExecutionTask,
    DocumentExportOutputRecord? PendingOutput,
    DocumentExportProviderReceipt? Receipt,
    System.Collections.Immutable.ImmutableArray<DocumentExportJobAuditEvent> Audit,
    bool StopRequested,
    DocumentExportSandboxReceipt? SandboxFailure);

internal sealed record DocumentExportJobState(
    string Schema,
    List<DocumentExportStoredJob> Jobs,
    List<DocumentExportStoredGrant> Grants,
    string ContentDigest);

/// <summary>
/// Single local durable custody owner under the existing private release root.
/// Cross-process exclusive locking serializes commit/download/cleanup. Sealed
/// encrypted snapshots are flushed before atomic replacement; corrupt state
/// fails closed and is never reconstructed from a directory listing.
/// </summary>
internal sealed class DocumentExportJobRepository
{
    internal const string StateSchema = "fsusblog.document-export-job-state.v2";
    private const int MaximumStateBytes = 96 * 1024 * 1024;
    private readonly string _root;
    private readonly Microsoft.AspNetCore.DataProtection.IDataProtector _protector;
    private readonly Lazy<PrivateAssetAnchoredFileSystem> _files;

    internal DocumentExportJobRepository(ReleaseStorageLayout layout,
        Microsoft.AspNetCore.DataProtection.IDataProtectionProvider protection, IPrivateAssetDirectorySync? directorySync = null)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(protection);
        _root = Path.Combine(layout.Paths.PrivateAssetRoot, "document-export");
        _protector = protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
        _files = new Lazy<PrivateAssetAnchoredFileSystem>(() => directorySync is null
            ? new(layout.Paths.PrivateAssetRoot, layout.Paths.UploadCommitRoot)
            : new(layout.Paths.PrivateAssetRoot, layout.Paths.UploadCommitRoot, directorySync));
    }

    internal async Task<T> ReadAsync<T>(Func<DocumentExportJobState, Task<T>> action, CancellationToken cancellationToken)
    {
        if (!Directory.Exists(_root))
        {
            return await action(new DocumentExportJobState(StateSchema, [], [], string.Empty)).ConfigureAwait(false);
        }
        using FileStream owner = await LockAsync(false, cancellationToken).ConfigureAwait(false);
        return await action(Load()).ConfigureAwait(false);
    }

    internal async Task<T> UpdateAsync<T>(Func<DocumentExportJobState, Task<T>> action,
        CancellationToken cancellationToken, bool initialize = false, Action? validatePublication = null)
    {
        if (!initialize && !Directory.Exists(_root))
        {
            return await action(new DocumentExportJobState(StateSchema, [], [], string.Empty)).ConfigureAwait(false);
        }
        using FileStream owner = await LockAsync(initialize, cancellationToken).ConfigureAwait(false);
        DocumentExportJobState state = Load();
        Dictionary<string, long> originalVersions = state.Jobs.ToDictionary(job => job.Snapshot.Task.TaskId, job => job.Snapshot.Version);
        Dictionary<string, DocumentExportStoredJob> originalJobs = state.Jobs.ToDictionary(job => job.Snapshot.Task.TaskId);
        T result = await action(state).ConfigureAwait(false);
        try
        {
            validatePublication?.Invoke();
            Save(state);
            if (owner.Length == 0)
            {
                owner.WriteByte(1);
                owner.Flush(flushToDisk: true);
            }
            validatePublication?.Invoke();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidDataException
            || (validatePublication is not null && exception is DocumentExportBudgetExceededException or OperationCanceledException))
        {
            bool attemptExpired = exception is DocumentExportBudgetExceededException { FailureCode: "task-wall-time-budget" };
            bool publicationCancelled = validatePublication is not null && exception is OperationCanceledException;
            bool resourceUnqualified = exception is DocumentExportJobResourceStateException;
            string reason = attemptExpired ? "task_wall_time_budget_failed"
                : publicationCancelled ? "sandbox_cancelled"
                : resourceUnqualified ? "attempt_resources_unqualified" : "persistence_unqualified";
            bool fenced = false;
            for (int index = 0; index < state.Jobs.Count; index++)
            {
                DocumentExportStoredJob job = state.Jobs[index];
                if (job.Snapshot.Task.Status == DocumentExportTaskStatus.Succeeded
                    && originalVersions.GetValueOrDefault(job.Snapshot.Task.TaskId) != job.Snapshot.Version)
                {
                    state.Jobs[index] = job with
                    {
                        WorkerDigest = resourceUnqualified ? originalJobs[job.Snapshot.Task.TaskId].WorkerDigest : job.WorkerDigest,
                        ExecutionTask = resourceUnqualified ? originalJobs[job.Snapshot.Task.TaskId].ExecutionTask : job.ExecutionTask,
                        Input = resourceUnqualified ? originalJobs[job.Snapshot.Task.TaskId].Input : job.Input,
                        PendingOutput = resourceUnqualified ? job.PendingOutput ?? job.Snapshot.Output : job.PendingOutput,
                        Snapshot = job.Snapshot with
                        {
                            Output = resourceUnqualified ? null : job.Snapshot.Output,
                            Task = DocumentExportContractValidator.Seal(job.Snapshot.Task with
                            {
                                Status = DocumentExportTaskStatus.CleanupRequired
                            }),
                            Reason = reason,
                            Attempts = job.Snapshot.Attempts.Length != 0
                                ? job.Snapshot.Attempts.SetItem(job.Snapshot.Attempts.Length - 1, job.Snapshot.Attempts[^1] with
                                {
                                    Status = publicationCancelled ? DocumentExportTaskStatus.Cancelled : DocumentExportTaskStatus.Failed,
                                    Reason = reason
                                })
                                : job.Snapshot.Attempts,
                            Version = job.Snapshot.Version + 1
                        }
                    };
                    state.Grants.RemoveAll(grant => grant.TaskId == job.Snapshot.Task.TaskId);
                    fenced = true;
                }
            }
            if (fenced)
            {
                // Keep the exclusion lock for the recovery attempt. A second
                // save failure cannot replace the original publication failure
                // or establish that the nondownloadable fence is durable.
                try
                {
                    Save(state);
                }
                catch (Exception recoveryFailure)
                {
                    // Closed diagnostics carry no provider paths, credentials or
                    // exception messages. The outer rethrow retains the first stack.
                    exception.Data["document_export_recovery_fence"] = "unconfirmed";
                    exception.Data["document_export_recovery_failure"] = recoveryFailure switch
                    {
                        UnauthorizedAccessException => "access_denied",
                        IOException => "io_failure",
                        _ => "save_failure"
                    };
                }
            }
            throw;
        }
        return result;
    }

    internal void Save(DocumentExportJobState state)
    {
        DocumentExportJobState unsigned = state with
        {
            ContentDigest = string.Empty
        };
        byte[] bytes = DocumentExportDigest.Serialize(unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        });
        if (bytes.Length > MaximumStateBytes)
        {
            throw new InvalidOperationException("document_export_state_budget");
        }
        byte[] protectedBytes = _protector.Protect(bytes);
        if (protectedBytes.Length > MaximumStateBytes)
        {
            throw new InvalidOperationException("document_export_state_budget");
        }
        string temporary = Resolve("state.pending");
        if (File.Exists(temporary))
        {
            File.Delete(temporary);
        }
        WritePrivate(temporary, protectedBytes);
        File.Move(temporary, Resolve("state.bin"), overwrite: true);
        _files.Value.SyncExistingEntry("document-export/state.bin");
    }

    internal async Task CommitObjectAsync(DocumentExportOutputRecord output, byte[] bytes)
    {
        string key = ObjectKey(output);
        using FileStream? existing = _files.Value.TryOpenRead(key);
        if (existing is not null)
        {
            VerifyObject(output, ReadBounded(existing, output.Length));
            return;
        }
        await using AnchoredTemporaryFile staging = _files.Value.CreateTemporary();
        staging.Stream.Write(bytes);
        staging.Stream.Flush(flushToDisk: true);
        _files.Value.Commit(staging, key, _files.Value.TryGetIdentity(staging.Stream));
        ReadObject(output);
    }

    internal byte[] ReadObject(DocumentExportOutputRecord output)
    {
        using FileStream stream = _files.Value.TryOpenRead(ObjectKey(output))
            ?? throw new InvalidDataException("document_export_object_missing");
        PrivateAssetFileIdentity? before = _files.Value.TryGetIdentity(stream);
        byte[] bytes = ReadBounded(stream, output.Length);
        VerifyObject(output, bytes);
        if (before != _files.Value.TryGetIdentity(stream))
        {
            throw new InvalidDataException("document_export_object_tampered");
        }
        return bytes;
    }

    internal void DeleteObject(DocumentExportOutputRecord output)
    {
        _files.Value.Delete(ObjectKey(output));
    }

    private static string ObjectKey(DocumentExportOutputRecord output)
        => $"document-export/objects/{Opaque(output.ObjectId)}-{DigestHex(output.OutputDigest)}.object";

    private static byte[] ReadBounded(FileStream stream, long length)
    {
        if (length <= 0 || length > DocumentExportJobPolicy.MaximumOutputBytes || stream.Length != length)
        {
            throw new InvalidDataException("document_export_object_tampered");
        }
        byte[] bytes = new byte[(int)length];
        stream.ReadExactly(bytes);
        return bytes;
    }

    private static string Opaque(string value)
        => value.Length == 32 && value.All(char.IsAsciiHexDigit)
            ? value : throw new InvalidDataException("document_export_object_identity_invalid");

    private static string DigestHex(string value)
    {
        DocumentExportContractValidator.RequireDigest(value, nameof(value));
        return value[7..];
    }

    private static void VerifyObject(DocumentExportOutputRecord output, byte[] bytes)
    {
        if (bytes.LongLength != output.Length || DocumentExportDigest.ComputeBytes(bytes) != output.OutputDigest)
        {
            throw new InvalidDataException("document_export_object_tampered");
        }
    }

    private DocumentExportJobState Load()
    {
        string path = Resolve("state.bin");
        if (!File.Exists(path))
        {
            // A lock file is a durable initialization marker. Missing state in an
            // initialized store must never silently erase cancellation/grants.
            if (new FileInfo(Resolve("owner.lock")).Length != 0)
            {
                throw new InvalidDataException("document_export_state_missing");
            }
            return new DocumentExportJobState(StateSchema, [], [], string.Empty);
        }
        using FileStream stateFile = _files.Value.TryOpenRead("document-export/state.bin")
            ?? throw new InvalidDataException("document_export_state_missing");
        if (stateFile.Length > MaximumStateBytes)
        {
            throw new InvalidDataException("document_export_state_budget");
        }
        PrivateAssetFileIdentity? identity = _files.Value.TryGetIdentity(stateFile);
        byte[] protectedBytes = new byte[(int)stateFile.Length];
        stateFile.ReadExactly(protectedBytes);
        if (identity != _files.Value.TryGetIdentity(stateFile))
        {
            throw new InvalidDataException("document_export_state_tampered");
        }
        byte[] plaintext;
        try
        {
            plaintext = _protector.Unprotect(protectedBytes);
        }
        catch (CryptographicException)
        {
            throw new InvalidDataException("document_export_state_tampered");
        }
        DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(plaintext);
        if (state.Schema != StateSchema
            || state.ContentDigest != DocumentExportDigest.Compute(state with
            {
                ContentDigest = string.Empty
            })
            || state.Jobs.Count > DocumentExportJobPolicy.MaximumJobs
            || state.Grants.Count > DocumentExportJobPolicy.MaximumGrants
            || state.Jobs.Select(job => job.Snapshot.Task.TaskId).Distinct(StringComparer.Ordinal).Count() != state.Jobs.Count)
        {
            throw new InvalidDataException("document_export_state_tampered");
        }
        foreach (DocumentExportStoredJob job in state.Jobs)
        {
            DocumentExportJobService.ValidateStoredJob(job);
        }
        return state;
    }

    private async Task<FileStream> LockAsync(bool create, CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("document_export_private_acl_adapter_required");
        }
        ValidateAncestors();
        if (create)
        {
            Directory.CreateDirectory(_root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        if (File.GetUnixFileMode(_root) != (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute))
        {
            throw new InvalidDataException("document_export_private_mode_refused");
        }
        DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(10);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string path = Resolve("owner.lock");
            if (File.Exists(path) && File.GetUnixFileMode(path) != (UnixFileMode.UserRead | UnixFileMode.UserWrite))
            {
                throw new InvalidDataException("document_export_private_mode_refused");
            }
            try
            {
                var options = new FileStreamOptions
                {
                    Mode = create ? FileMode.OpenOrCreate : FileMode.Open,
                    Access = FileAccess.ReadWrite,
                    Share = FileShare.None
                };
                if (create)
                {
                    options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                }
                return new FileStream(path, options);
            }
            catch (IOException) when (DateTimeOffset.UtcNow < deadline)
            {
                await Task.Delay(25, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private void ValidateAncestors()
    {
        for (DirectoryInfo? directory = new(_root); directory is not null; directory = directory.Parent)
        {
            if (directory.LinkTarget is not null)
            {
                throw new InvalidDataException("document_export_storage_link_refused");
            }
        }
    }

    private string Resolve(string name)
    {
        ValidateAncestors();
        string candidate = Path.Combine(_root, name);
        if (!CanonicalPathBoundary.TryResolveRelative(_root, name, out string canonical)
            || canonical != candidate
            || new FileInfo(candidate).LinkTarget is not null)
        {
            throw new InvalidDataException("document_export_storage_boundary_refused");
        }
        return canonical;
    }

    private static void WritePrivate(string path, ReadOnlySpan<byte> bytes)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("document_export_private_acl_adapter_required");
        }
        using var stream = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite
        });
        stream.Write(bytes);
        stream.Flush(flushToDisk: true);
    }
}
