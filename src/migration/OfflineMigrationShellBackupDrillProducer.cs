using System.Diagnostics;
using System.Globalization;
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
    int KillReapSeconds);

/// <summary>
/// Invoke only the original backup-drill owner. This adapter owns its actual child and
/// pipes, while the original script owns authentication, PostgreSQL and restore cleanup.
/// It never authenticates a second package or accepts an external execution report.
/// </summary>
internal sealed class OfflineMigrationShellBackupDrillProducer(
    OfflineMigrationShellBackupDrillConfiguration configuration) : IOfflineMigrationBackupDrillProducer
{
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
        Require(configuration.TerminateGraceSeconds is > 0 and <= int.MaxValue / 1000
            && configuration.KillReapSeconds is > 0 and <= int.MaxValue / 1000, "cleanup_selection_invalid");
        string root = Canonical(privateRoot);
        Require(invocation.Length == 32 && invocation.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'),
            "invocation_identity_invalid");
        Require(options.RestoreDrillPath == Path.Combine(root, "backup-restore-drill.json")
            && options.BackupManifestPath == Path.Combine(root, "package-manifest.json")
            && !Directory.Exists(root) && !File.Exists(root) && new DirectoryInfo(root).LinkTarget is null,
            "fresh_owned_paths_required");
        RequireDirectoryChain(Path.GetDirectoryName(root)!);
        string repository = Canonical(configuration.RepositoryRoot);
        RequireDirectoryChain(repository);
        string script = Path.Combine(repository, "tools/operations/backup-restore-drill.sh");
        foreach (string path in new[] { script, configuration.BashExecutable, configuration.SessionExecutable,
            configuration.DotNetExecutable, configuration.MigrationAssembly, configuration.IdentityFile,
            options.BackupPackagePath })
        {
            RequireOperationInput(path);
        }
        if (configuration.IdentityPassphraseFile is not null)
        {
            RequireOperationInput(configuration.IdentityPassphraseFile);
        }

        using var producer = new Process();
        producer.StartInfo = CreateStartInfo(options, root, invocation, repository, script,
            deadline.RemainingWholeSeconds(cancellationToken));
        // Siblings exist before the producer creates its fresh root. Both complete streams
        // remain protected on failure; the adapter never removes the original owner's work.
        await using FileStream stdout = CreateRaw(root + ".invocation.stdout");
        await using FileStream stderr = CreateRaw(root + ".invocation.stderr");
        using var pipeCancellation = new CancellationTokenSource();
        Task? stdoutDrain = null;
        Task? stderrDrain = null;
        bool started = false;
        string? identity = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            producer.StartInfo.ArgumentList[^1] = deadline.RemainingWholeSeconds(cancellationToken)
                .ToString(CultureInfo.InvariantCulture);
            Require(producer.Start(), "process_start_failed");
            started = true;
            producer.StandardInput.Close();
            stdoutDrain = producer.StandardOutput.BaseStream.CopyToAsync(stdout, pipeCancellation.Token);
            stderrDrain = producer.StandardError.BaseStream.CopyToAsync(stderr, pipeCancellation.Token);
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
            await producer.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            Require(GroupEmpty(producer.Id), "process_group_terminal_unverified");
            await Task.WhenAll(stdoutDrain, stderrDrain).WaitAsync(cancellationToken).ConfigureAwait(false);
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
            return new(producer.ExitCode, output);
        }
        catch
        {
            if (started)
            {
                bool terminal = await StopOwnedAsync(producer, identity).ConfigureAwait(false);
                // A descendant retaining a pipe is not terminal, even when its parent exited.
                using var drainDeadline = new CancellationTokenSource(
                    TimeSpan.FromSeconds(configuration.KillReapSeconds));
                try
                {
                    if (stdoutDrain is not null && stderrDrain is not null)
                    {
                        await Task.WhenAll(stdoutDrain, stderrDrain).WaitAsync(drainDeadline.Token).ConfigureAwait(false);
                    }
                }
                catch
                {
                    terminal = false;
                    pipeCancellation.Cancel();
                    // Close this owner's pipe handles so abandoned descendants cannot keep
                    // our drains/resources alive. This is refusal, never child-release proof.
                    producer.StandardOutput.Dispose();
                    producer.StandardError.Dispose();
                    if (stdoutDrain is not null && stderrDrain is not null)
                    {
                        try
                        {
                            await Task.WhenAll(stdoutDrain, stderrDrain)
                                .WaitAsync(TimeSpan.FromSeconds(configuration.KillReapSeconds)).ConfigureAwait(false);
                        }
                        catch
                        {
                            // Still unverified: retain raw/work and refuse, not a successful
                            // disposal claim or an unbounded post-timeout pipe wait.
                            terminal = false;
                        }
                    }
                }
                try
                {
                    stdout.Flush(flushToDisk: true);
                    stderr.Flush(flushToDisk: true);
                }
                catch (IOException)
                {
                    throw Failure("raw_retention_failed");
                }
                if (!terminal)
                {
                    throw Failure("cleanup_unverified");
                }
            }
            // Cancellation/timeout cannot turn a partially cleaned original restore into
            // ExitCode zero, and private values from process failures are not public errors.
            throw Failure("invocation_failed_or_cancelled");
        }
    }

    private ProcessStartInfo CreateStartInfo(OfflineMigrationPlanCommandOptions options, string root,
        string invocation, string repository, string script, int remainingSeconds)
    {
        var start = new ProcessStartInfo(configuration.SessionExecutable)
        {
            WorkingDirectory = repository,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.ArgumentList.Add("--wait");
        start.ArgumentList.Add(configuration.BashExecutable);
        start.ArgumentList.Add(script);
        start.ArgumentList.Add("--migration-evidence");
        start.ArgumentList.Add("--timeout-seconds");
        start.ArgumentList.Add(remainingSeconds.ToString(CultureInfo.InvariantCulture));
        start.Environment.Clear();
        foreach ((string name, string value) in configuration.ExecutionEnvironment)
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
        start.Environment["FSUSBLOG_BACKUP_IDENTITY_FILE"] = configuration.IdentityFile;
        if (configuration.IdentityPassphraseFile is not null)
        {
            start.Environment["FSUSBLOG_BACKUP_IDENTITY_PASSPHRASE_FILE"] = configuration.IdentityPassphraseFile;
        }
        start.Environment["FSUSBLOG_MIGRATION_SERVER_DLL"] = configuration.MigrationAssembly;
        start.Environment["DOTNET_BIN"] = configuration.DotNetExecutable;
        return start;
    }

    private async Task<bool> StopOwnedAsync(Process producer, string? registeredIdentity)
    {
        try
        {
            if (!producer.HasExited || !GroupEmpty(producer.Id))
            {
                if (!SignalOwned(producer.Id, registeredIdentity, 15)) return false;
                if (!await AwaitTerminalAsync(producer, configuration.TerminateGraceSeconds).ConfigureAwait(false))
                {
                    if (!SignalOwned(producer.Id, registeredIdentity, 9)) return false;
                    if (!await AwaitTerminalAsync(producer, configuration.KillReapSeconds).ConfigureAwait(false)) return false;
                }
            }
            await producer.WaitForExitAsync().ConfigureAwait(false);
            return GroupEmpty(producer.Id);
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private static async Task<bool> AwaitTerminalAsync(Process producer, int seconds)
    {
        using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
        try
        {
            await producer.WaitForExitAsync(wait.Token).ConfigureAwait(false);
            while (!GroupEmpty(producer.Id))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(10), wait.Token).ConfigureAwait(false);
            }
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
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
            if (!int.TryParse(Path.GetFileName(entry), out _)) continue;
            try
            {
                string stat = File.ReadAllText(Path.Combine(entry, "stat"));
                string[] fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (fields.Length <= 2) return false;
                if (fields[2] == pid.ToString(CultureInfo.InvariantCulture)) return false;
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
        }
        return true;
    }

    private static FileStream CreateRaw(string path) => new(path, new FileStreamOptions
    {
        Mode = FileMode.CreateNew,
        Access = FileAccess.ReadWrite,
        Share = FileShare.None,
        Options = FileOptions.Asynchronous,
        UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite
    });

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
        if (!condition) throw Failure(code);
    }

    private static InvalidOperationException Failure(string code) => new("offline_backup_shell_" + code);

    private static class NativeMethods
    {
        [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
        internal static extern int Kill(int pid, int signal);
    }
}
