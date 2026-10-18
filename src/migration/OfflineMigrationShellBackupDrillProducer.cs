using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

/// <summary>
/// Original operation-owner configuration, not a CLI plugin or backup approval. The
/// composition owner supplies the actual tools and secret-file locations. Cleanup waits
/// are explicit finite failure-handling selections, not a new operation budget or test policy.
/// </summary>
internal sealed record OfflineMigrationShellBackupDrillConfiguration(
    string RepositoryRoot,
    string BashExecutable,
    string SessionExecutable,
    string DotNetExecutable,
    string MigrationAssembly,
    string IdentityFile,
    string? IdentityPassphraseFile,
    IReadOnlyDictionary<string, string> ExecutionEnvironment,
    int TerminateGraceSeconds,
    int KillReapSeconds)
{
    // Only the original process composition creates this byte/scope binding. Existing
    // raw configurations remain the isolated shell-fixture seam, not production admission.
    internal OfflineMigrationShellBackupDrillOwnedInputs? OwnedInputs
    {
        get; init;
    }
}

/// <summary>
/// Invoke only the original backup-drill owner. This adapter owns its actual child and
/// pipes, while the original script owns authentication, PostgreSQL and restore cleanup.
/// It never authenticates a second package or accepts an external execution report.
/// </summary>
internal sealed class OfflineMigrationShellBackupDrillProducer : IOfflineMigrationBackupDrillProducer
{
    private readonly OfflineMigrationShellBackupDrillConfiguration _configuration;
    private readonly Func<string, FileStream> _createRaw;

    internal OfflineMigrationShellBackupDrillOwnedInputs? OwnedInputs => _configuration.OwnedInputs;

    internal OfflineMigrationShellBackupDrillProducer(OfflineMigrationShellBackupDrillConfiguration configuration)
        : this(configuration, CreateRaw)
    {
    }

    // IO-fault fixture seam only. Production composition uses the original one-argument
    // constructor; neither CLI nor artifact JSON can choose a raw writer or producer body.
    internal OfflineMigrationShellBackupDrillProducer(OfflineMigrationShellBackupDrillConfiguration configuration,
        Func<string, FileStream> createRaw)
    {
        _configuration = configuration;
        _createRaw = createRaw;
    }
    public async Task<OfflineMigrationBackupDrillTerminal> RunAsync(
        OfflineMigrationPlanCommandOptions options, string privateRoot, string invocation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(OperatingSystem.IsLinux(), "linux_operation_owner_required");
        Require(options.ExpectedDatabase.Provider == CurrentSchemaProviderKind.PostgreSql,
            "provider_capture_capability_missing");
        OfflineMigrationOperationDeadline deadline = options.OperationDeadline
            ?? throw Failure("original_operation_deadline_required");
        if (_configuration.OwnedInputs is not null)
        {
            await _configuration.OwnedInputs.VerifyInvocationAsync(_configuration, options, privateRoot,
                cancellationToken).ConfigureAwait(false);
        }
        Require(_configuration.TerminateGraceSeconds is > 0 and <= int.MaxValue / 1000
            && _configuration.KillReapSeconds is > 0 and <= int.MaxValue / 1000, "cleanup_selection_invalid");
        string root = Canonical(privateRoot);
        Require(invocation.Length == 32 && invocation.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'),
            "invocation_identity_invalid");
        Require(options.RestoreDrillPath == Path.Combine(root, "backup-restore-drill.json")
            && options.BackupManifestPath == Path.Combine(root, "package-manifest.json")
            && !Directory.Exists(root) && !File.Exists(root) && new DirectoryInfo(root).LinkTarget is null,
            "fresh_owned_paths_required");
        RequireDirectoryChain(Path.GetDirectoryName(root)!);
        string repository = Canonical(_configuration.RepositoryRoot);
        RequireDirectoryChain(repository);
        string script = Path.Combine(repository, "tools/operations/backup-restore-drill.sh");
        foreach (string path in new[] { script, _configuration.BashExecutable, _configuration.SessionExecutable,
            _configuration.DotNetExecutable, _configuration.MigrationAssembly, _configuration.IdentityFile,
            options.BackupPackagePath })
        {
            RequireOperationInput(path);
        }
        if (_configuration.IdentityPassphraseFile is not null)
        {
            RequireOperationInput(_configuration.IdentityPassphraseFile);
        }

        using var producer = new Process();
        producer.StartInfo = CreateStartInfo(options, root, invocation, repository, script,
            deadline.RemainingWholeSeconds(cancellationToken));
        // Siblings exist before the producer creates its fresh root. Both complete streams
        // remain protected on failure; the adapter never removes the original owner's work.
        await using var stdoutOwner = new RawFileOwner(_createRaw(root + ".invocation.stdout"));
        await using var stderrOwner = new RawFileOwner(_createRaw(root + ".invocation.stderr"));
        FileStream stdout = stdoutOwner.Stream;
        FileStream stderr = stderrOwner.Stream;
        InvocationPipe? stdoutPipe = null;
        InvocationPipe? stderrPipe = null;
        bool started = false;
        string? identity = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_configuration.OwnedInputs is not null)
            {
                await _configuration.OwnedInputs.VerifyInvocationAsync(_configuration, options, root,
                    cancellationToken).ConfigureAwait(false);
            }
            producer.StartInfo.ArgumentList[^1] = deadline.RemainingWholeSeconds(cancellationToken)
                .ToString(CultureInfo.InvariantCulture);
            Require(producer.Start(), "process_start_failed");
            started = true;
            producer.StandardInput.Close();
            stdoutPipe = new(producer.StandardOutput.BaseStream);
            stderrPipe = new(producer.StandardError.BaseStream);
            // setsid execs the original bash child, without --fork or a second controller.
            // Its PID must actually be the new group leader before group signalling is owned.
            while (!producer.HasExited && identity is null)
            {
                identity = ReadIdentity(producer.Id);
                if (identity is null)
                {
                    _ = deadline.RemainingWholeSeconds(cancellationToken);
                    await Task.Delay(TimeSpan.FromMilliseconds(10), cancellationToken).ConfigureAwait(false);
                }
            }
            // One owner supervises both real nonblocking pipe FDs and the child. Each raw
            // write is actually awaited here; no detached CopyTo task can outlive this scope.
            // A first read/write fault enters owned stop immediately, not after process exit.
            while (!producer.HasExited || !stdoutPipe.EndOfStream || !stderrPipe.EndOfStream)
            {
                cancellationToken.ThrowIfCancellationRequested();
                _ = deadline.RemainingWholeSeconds(cancellationToken);
                bool progressed = await stdoutPipe.TransferNextAsync(stdout, "stdout_pipe_failed", cancellationToken)
                    .ConfigureAwait(false);
                progressed |= await stderrPipe.TransferNextAsync(stderr, "stderr_pipe_failed", cancellationToken)
                    .ConfigureAwait(false);
                if (!progressed)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(10), cancellationToken).ConfigureAwait(false);
                }
            }
            await producer.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            Require(GroupEmpty(producer.Id), "process_group_terminal_unverified");
            cancellationToken.ThrowIfCancellationRequested();
            _ = deadline.RemainingWholeSeconds(cancellationToken);
            await stdout.FlushAsync(cancellationToken).ConfigureAwait(false);
            await stderr.FlushAsync(cancellationToken).ConfigureAwait(false);
            stdout.Flush(flushToDisk: true);
            stderr.Flush(flushToDisk: true);
            Require(stdout.Length <= int.MaxValue, "stdout_representation_exceeded");
            stdout.Position = 0;
            byte[] output = new byte[checked((int)stdout.Length)];
            await stdout.ReadExactlyAsync(output, cancellationToken).ConfigureAwait(false);
            await stdoutOwner.DisposeAsync().ConfigureAwait(false);
            await stderrOwner.DisposeAsync().ConfigureAwait(false);
            Require(!stdoutOwner.Failed && !stderrOwner.Failed, "raw_close_unverified");
            return new(producer.ExitCode, output);
        }
        catch (Exception primary)
        {
            string firstCause = primary.Message switch
            {
                "offline_backup_shell_stdout_pipe_failed" => "stdout_pipe_failed",
                "offline_backup_shell_stderr_pipe_failed" => "stderr_pipe_failed",
                "offline_backup_shell_pipe_setup_failed" => "pipe_setup_failed",
                "offline_backup_shell_raw_close_unverified" => "raw_close_unverified",
                _ => "invocation_failed_or_cancelled"
            };
            if (started)
            {
                identity ??= producer.HasExited ? null : ReadIdentity(producer.Id);
                CleanupOutcome cleanup = await StopOwnedAndDrainAsync(producer, identity,
                    stdoutPipe, stderrPipe, stdoutOwner, stderrOwner, firstCause).ConfigureAwait(false);
                // No native read is pending: nonblocking Read returned before every await,
                // and the only raw write task has actually completed/faulted before catch.
                // Close each existing pipe independently, including partial setup. Closing
                // local FDs is NOT child/container release proof; unknown cleanup stays RED.
                stdoutPipe?.Dispose();
                stderrPipe?.Dispose();
                bool rawComplete = cleanup.RawComplete;
                foreach (RawFileOwner rawOwner in new[] { stdoutOwner, stderrOwner })
                {
                    try
                    {
                        if (!rawOwner.Closed)
                            rawOwner.Stream.Flush(flushToDisk: true);
                    }
                    catch (IOException)
                    {
                        rawComplete = false;
                    }
                }
                if (!cleanup.Terminal)
                {
                    throw Failure("cleanup_unverified:" + firstCause
                        + (rawComplete ? string.Empty : ":raw_retention_failed"));
                }
                if (!rawComplete)
                    throw Failure(firstCause + ":raw_retention_failed");
            }
            // Cancellation/timeout cannot turn a partially cleaned original restore into
            // ExitCode zero, and private values from process failures are not public errors.
            throw Failure(firstCause);
        }
        finally
        {
            stdoutPipe?.Dispose();
            stderrPipe?.Dispose();
        }
    }

    private ProcessStartInfo CreateStartInfo(OfflineMigrationPlanCommandOptions options, string root,
        string invocation, string repository, string script, int remainingSeconds)
    {
        var start = new ProcessStartInfo(_configuration.SessionExecutable)
        {
            WorkingDirectory = repository,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("--wait");
        start.ArgumentList.Add(_configuration.BashExecutable);
        start.ArgumentList.Add(script);
        start.ArgumentList.Add("--migration-evidence");
        start.ArgumentList.Add("--timeout-seconds");
        start.ArgumentList.Add(remainingSeconds.ToString(CultureInfo.InvariantCulture));
        start.Environment.Clear();
        foreach ((string name, string value) in _configuration.ExecutionEnvironment)
        {
            Require(!name.StartsWith("FSUSBLOG_", StringComparison.Ordinal) && name != "DOTNET_BIN"
                && name is not ("BASH_ENV" or "ENV" or "SHELLOPTS" or "BASHOPTS" or "CDPATH")
                && !name.StartsWith("BASH_FUNC_", StringComparison.Ordinal), "execution_environment_override_refused");
            start.Environment.Add(name, value);
        }
        start.Environment["FSUSBLOG_DRILL_MODE"] = "real";
        start.Environment["FSUSBLOG_DRILL_KEEP_WORK"] = "0";
        start.Environment["FSUSBLOG_DRILL_OUTPUT_DIR"] = root;
        start.Environment["FSUSBLOG_DRILL_WORK_DIR"] = Path.Combine(root, "restore-work");
        start.Environment["FSUSBLOG_DRILL_RUN_ID"] = invocation;
        start.Environment["FSUSBLOG_SITE_BACKUP_PACKAGE"] = options.BackupPackagePath;
        start.Environment["FSUSBLOG_BACKUP_IDENTITY_FILE"] = _configuration.IdentityFile;
        if (_configuration.IdentityPassphraseFile is not null)
        {
            start.Environment["FSUSBLOG_BACKUP_IDENTITY_PASSPHRASE_FILE"] = _configuration.IdentityPassphraseFile;
        }
        start.Environment["FSUSBLOG_MIGRATION_SERVER_DLL"] = _configuration.MigrationAssembly;
        start.Environment["DOTNET_BIN"] = _configuration.DotNetExecutable;
        return start;
    }

    private readonly record struct CleanupOutcome(bool Terminal, bool RawComplete);

    private async Task<CleanupOutcome> StopOwnedAndDrainAsync(Process producer, string? registeredIdentity,
        InvocationPipe? stdoutPipe, InvocationPipe? stderrPipe, RawFileOwner stdoutOwner,
        RawFileOwner stderrOwner, string firstCause)
    {
        bool captureStdout = firstCause != "stdout_pipe_failed" && !stdoutOwner.Closed;
        bool captureStderr = firstCause != "stderr_pipe_failed" && !stderrOwner.Closed;
        bool rawComplete = stdoutPipe is not null && stderrPipe is not null && captureStdout && captureStderr
            && !stdoutPipe.CaptureIncomplete && !stderrPipe.CaptureIncomplete;
        bool ownershipVerified = true;
        bool killed = false;
        long cleanupStarted = Stopwatch.GetTimestamp();
        // One finite failure-cleanup ledger covers TERM grace, KILL/reap and both pipes.
        // It is the original explicit Ops selection, not a restarted operation/test budget.
        using var cleanupDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(
            (long)_configuration.TerminateGraceSeconds + _configuration.KillReapSeconds));
        try
        {
            if (!producer.HasExited || !GroupEmpty(producer.Id))
            {
                ownershipVerified = SignalOwned(producer.Id, registeredIdentity, 15);
            }
            while (!cleanupDeadline.IsCancellationRequested)
            {
                bool progressed = false;
                if (stdoutPipe is not null && !stdoutPipe.ReadFailed)
                {
                    try
                    {
                        progressed = await stdoutPipe.TransferNextAsync(captureStdout ? stdoutOwner.Stream : null,
                            "stdout_pipe_failed", cleanupDeadline.Token).ConfigureAwait(false);
                    }
                    catch (InvalidOperationException)
                    {
                        captureStdout = false;
                        rawComplete = false;
                    }
                }
                if (stderrPipe is not null && !stderrPipe.ReadFailed)
                {
                    try
                    {
                        progressed |= await stderrPipe.TransferNextAsync(captureStderr ? stderrOwner.Stream : null,
                            "stderr_pipe_failed", cleanupDeadline.Token).ConfigureAwait(false);
                    }
                    catch (InvalidOperationException)
                    {
                        captureStderr = false;
                        rawComplete = false;
                    }
                }
                bool groupTerminal = producer.HasExited && GroupEmpty(producer.Id);
                bool pipesTerminal = stdoutPipe?.EndOfStream == true && stderrPipe?.EndOfStream == true;
                if (groupTerminal && pipesTerminal)
                {
                    await producer.WaitForExitAsync(cleanupDeadline.Token).ConfigureAwait(false);
                    return new(ownershipVerified, rawComplete);
                }
                if (!killed && Stopwatch.GetElapsedTime(cleanupStarted)
                    >= TimeSpan.FromSeconds(_configuration.TerminateGraceSeconds))
                {
                    killed = true;
                    if (!groupTerminal && !SignalOwned(producer.Id, registeredIdentity, 9))
                    {
                        ownershipVerified = false;
                    }
                }
                if (!progressed)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(10), cleanupDeadline.Token).ConfigureAwait(false);
                }
            }
            return new(false, false);
        }
        catch (Exception error) when (error is IOException or InvalidOperationException
            or OperationCanceledException or System.ComponentModel.Win32Exception)
        {
            return new(false, false);
        }
    }

    private static bool SignalOwned(int pid, string? identity, int signal)
    {
        // Like the original Shell owner, this is a userspace generation recheck, not an
        // atomic kernel group capability. Missing/mismatched ownership must retain/refuse.
        return identity is not null && ReadIdentity(pid) == identity && NativeMethods.Kill(-pid, signal) == 0;
    }

    private static string? ReadIdentity(int pid)
    {
        try
        {
            string stat = File.ReadAllText($"/proc/{pid}/stat");
            string[] fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return fields.Length > 19 && fields[2] == pid.ToString(CultureInfo.InvariantCulture)
                && ulong.TryParse(fields[19], NumberStyles.None, CultureInfo.InvariantCulture, out _)
                ? $"{pid}:{fields[19]}" : null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static bool GroupEmpty(int pid)
    {
        foreach (string entry in Directory.EnumerateDirectories("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(entry), out _))
                continue;
            try
            {
                string stat = File.ReadAllText(Path.Combine(entry, "stat"));
                string[] fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (fields.Length <= 2)
                    return false;
                if (fields[2] == pid.ToString(CultureInfo.InvariantCulture))
                    return false;
            }
            catch (FileNotFoundException)
            {
            }
            catch (DirectoryNotFoundException)
            {
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }
        }
        return true;
    }

    private static FileStream CreateRaw(string path)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw Failure("linux_operation_owner_required");
        }
        return new(path, new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.ReadWrite,
            Share = FileShare.None,
            Options = FileOptions.Asynchronous,
            UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite
        });
    }

    private sealed class RawFileOwner(FileStream stream) : IAsyncDisposable
    {
        internal FileStream Stream { get; } = stream;
        internal bool Failed
        {
            get; private set;
        }
        internal bool Closed
        {
            get; private set;
        }

        public async ValueTask DisposeAsync()
        {
            if (Closed)
                return;
            Closed = true;
            try
            {
                // Await the actual disposal task, never a timed wrapper. A disposal fault
                // must not replace the first pipe error during exception unwinding.
                await Stream.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception)
            {
                Failed = true;
            }
        }
    }

    // Native reads are nonblocking and complete synchronously before control can yield.
    // This avoids claiming a timed/cancelled wait joined an asynchronous pipe copy task.
    private sealed class InvocationPipe : IDisposable
    {
        private readonly Stream _stream;
        private readonly SafeHandle _handle;
        private readonly byte[] _buffer = new byte[64 * 1024];
        internal bool EndOfStream
        {
            get; private set;
        }
        internal bool ReadFailed
        {
            get; private set;
        }
        internal bool CaptureIncomplete
        {
            get; private set;
        }

        internal InvocationPipe(Stream stream)
        {
            _stream = stream;
            _handle = stream switch
            {
                PipeStream pipe => pipe.SafePipeHandle,
                FileStream file => file.SafeFileHandle,
                _ => throw Failure("pipe_setup_failed")
            };
            bool borrowed = false;
            try
            {
                _handle.DangerousAddRef(ref borrowed);
                int descriptor = _handle.DangerousGetHandle().ToInt32();
                int flags = NativeMethods.Fcntl(descriptor, 3, 0); // F_GETFL.
                Require(flags >= 0 && NativeMethods.Fcntl(descriptor, 4, flags | 0x800) == 0,
                    "pipe_setup_failed"); // F_SETFL, O_NONBLOCK; preserve existing flags.
            }
            finally
            {
                if (borrowed)
                    _handle.DangerousRelease();
            }
        }

        internal async Task<bool> TransferNextAsync(FileStream? destination, string failureCode,
            CancellationToken cancellationToken)
        {
            if (EndOfStream)
                return false;
            cancellationToken.ThrowIfCancellationRequested();
            long read;
            int error;
            bool borrowed = false;
            try
            {
                _handle.DangerousAddRef(ref borrowed);
                read = NativeMethods.Read(_handle.DangerousGetHandle().ToInt32(), _buffer,
                    (UIntPtr)_buffer.Length).ToInt64();
                error = read < 0 ? Marshal.GetLastPInvokeError() : 0;
            }
            finally
            {
                if (borrowed)
                    _handle.DangerousRelease();
            }
            if (read == 0)
            {
                EndOfStream = true;
                return true;
            }
            if (read < 0)
            {
                if (error is 4 or 11)
                    return false; // EINTR or EAGAIN; retry under original token/deadline.
                ReadFailed = true;
                throw Failure(failureCode);
            }
            // A failed raw writer remains an explicit incomplete-evidence refusal. Consume
            // its pipe only to unblock the owned child, while still retaining the healthy pipe.
            if (destination is null)
                return true;
            try
            {
                // This task is never raced against a timeout wrapper or left in background.
                await destination.WriteAsync(_buffer.AsMemory(0, checked((int)read)), cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (Exception failure) when (failure is IOException or UnauthorizedAccessException or ObjectDisposedException)
            {
                CaptureIncomplete = true;
                throw Failure(failureCode);
            }
            catch (OperationCanceledException)
            {
                // A read chunk whose write was cancelled has no proven complete retention.
                // Cleanup may keep writing later bytes with its own finite failure token,
                // but cannot invent the lost chunk or call the overall raw complete.
                CaptureIncomplete = true;
                throw;
            }
            return true;
        }

        public void Dispose() => _stream.Dispose();
    }

    private static string Canonical(string path)
    {
        Require(Path.IsPathFullyQualified(path) && Path.GetFullPath(path) == path, "canonical_path_required");
        return path;
    }

    private static void RequireOperationInput(string path)
    {
        path = Canonical(path);
        RequireDirectoryChain(Path.GetDirectoryName(path)!);
        var file = new FileInfo(path);
        // This is invocation preflight, not authentication or FD identity proof. Original
        // envelope/native owners retain their actual regular-file and custody checks.
        Require(file.Exists && file.LinkTarget is null && !file.Attributes.HasFlag(FileAttributes.Directory),
            "operation_input_required");
    }

    private static void RequireDirectoryChain(string path)
    {
        for (DirectoryInfo? directory = new(path); directory is not null; directory = directory.Parent)
        {
            Require(directory.Exists && directory.LinkTarget is null, "owned_directory_required");
        }
    }

    private static void Require(bool condition, string code)
    {
        if (!condition)
            throw Failure(code);
    }

    private static InvalidOperationException Failure(string code) => new("offline_backup_shell_" + code);

    private static class NativeMethods
    {
        [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
        internal static extern int Kill(int pid, int signal);

        [DllImport("libc", EntryPoint = "fcntl", SetLastError = true)]
        internal static extern int Fcntl(int descriptor, int command, int flags);

        [DllImport("libc", EntryPoint = "read", SetLastError = true)]
        internal static extern IntPtr Read(int descriptor, [Out] byte[] buffer, UIntPtr length);
    }
}
