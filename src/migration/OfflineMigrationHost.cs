using System.Runtime.InteropServices;
using System.Text.Json;

using SqlSugar;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

/// <summary>
/// Offline migration command host (run-online-migrations.sh invoke target).
/// Applies schema descriptors from the migration assembly against a database
/// selected by <c>ConnectionStrings__DefaultConnection</c> (env file or
/// process environment), outside the Server process boundary.
/// </summary>
public static class OfflineMigrationHost
{
    internal const string StateLockConstant = "fsusblog-offline-migration";

    public static async Task<int> Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "observe-source")
        {
            try
            {
                OfflineMigrationSourceCommandOptions options = OfflineMigrationCommandLine.ParseSourceObservation(args);
                await RunReadOnlyCommandWithSignalsAsync(callerToken => ObserveSourceWithinBudgetAsync(options, async token =>
                {
                    token.ThrowIfCancellationRequested();
                    string[] lines = await File.ReadAllLinesAsync(options.EnvironmentFilePath, token).ConfigureAwait(false);
                    string? connectionString = ParseEnvironmentLines(lines).GetValueOrDefault("ConnectionStrings__DefaultConnection");
                    if (string.IsNullOrWhiteSpace(connectionString))
                    {
                        throw new InvalidOperationException("schema_connection_string_missing");
                    }
                    return connectionString;
                }, OfflineMigrationPlanEvidence.CreateOwnedSourceObserver, Console.In, Console.Out, callerToken)).ConfigureAwait(false);
                return 0;
            }
            catch (OperationCanceledException)
            {
                WriteJson(new { status = "failed", code = "schema_offline_source_operation_cancelled" });
                return 1;
            }
            catch (Exception exception)
            {
                // Provider faults must not publish credentials or raw historical row values.
                string code = exception is InvalidOperationException
                    ? exception.Message.Split(':', 2)[0] : "schema_offline_source_observation_failed";
                WriteJson(new { status = "failed", code });
                return 1;
            }
        }

        if (args.Length > 0 && args[0] == "plan")
        {
            try
            {
                OfflineMigrationPlanCommandOptions options = OfflineMigrationCommandLine.ParsePlan(args);
                await RunReadOnlyCommandWithSignalsAsync(callerToken => WritePlanWithinBudgetAsync(options,
                    OfflineMigrationPlanEvidence.CreateOwnedReader, callerToken)).ConfigureAwait(false);
                return 0;
            }
            catch (OperationCanceledException)
            {
                WriteJson(new { status = "failed", code = "schema_offline_plan_operation_cancelled" });
                return 1;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                WriteJson(new { status = "failed", code = exception.Message });
                return 1;
            }
        }

        OfflineMigrationCommandOptions parsed;
        try
        {
            parsed = OfflineMigrationCommandLine.Parse(args);
        }
        catch (InvalidOperationException exception)
        {
            WriteJson(new
            {
                status = "failed",
                code = exception.Message
            });
            return 2;
        }

        try
        {
            string connectionString = await ResolveConnectionStringAsync(parsed).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException("schema_connection_string_missing");
            }

            string releaseId = ResolveReleaseId(parsed);
            var result = await OfflineMigrationExecutor.RunAsync(
                parsed,
                connectionString,
                releaseId,
                CancellationToken.None).ConfigureAwait(false);
            WriteJson(new
            {
                status = result.Status,
                phase = result.Phase?.ToString().ToLowerInvariant(),
                migrationIds = result.MigrationIds,
                codes = result.Codes
            });
            return result.Status == "ok" ? 0 : 1;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            string code = exception.Message.Split(':', 2, StringSplitOptions.TrimEntries)[0];
            WriteJson(new
            {
                status = "failed",
                code,
                detail = exception.Message
            });
            return 1;
        }
    }

    private static async Task RunReadOnlyCommandWithSignalsAsync(Func<CancellationToken, Task> operation)
    {
        using var callerCancellation = new CancellationTokenSource();
        ConsoleCancelEventHandler cancelHandler = (_, signal) =>
        {
            signal.Cancel = true;
            CancelOperation();
        };
        Console.CancelKeyPress += cancelHandler;
        PosixSignalRegistration? terminate = null;
        PosixSignalRegistration? hangup = null;
        try
        {
            terminate = OperatingSystem.IsWindows() ? null : PosixSignalRegistration.Create(PosixSignal.SIGTERM, signal =>
            {
                signal.Cancel = true;
                CancelOperation();
            });
            hangup = OperatingSystem.IsWindows() ? null : PosixSignalRegistration.Create(PosixSignal.SIGHUP, signal =>
            {
                signal.Cancel = true;
                CancelOperation();
            });
            await operation(callerCancellation.Token).ConfigureAwait(false);
        }
        finally
        {
            try
            {
                hangup?.Dispose();
            }
            finally
            {
                try
                {
                    terminate?.Dispose();
                }
                finally
                {
                    Console.CancelKeyPress -= cancelHandler;
                }
            }
        }

        void CancelOperation()
        {
            try
            {
                callerCancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // An already queued notification cannot reopen a terminal command.
            }
        }
    }

    internal static async Task WritePlanWithinBudgetAsync(
        OfflineMigrationPlanCommandOptions options,
        Func<IOfflineMigrationPlanningEvidence> createEvidence,
        CancellationToken callerToken,
        TimeProvider? timeProvider = null)
    {
        if (options.TimeoutSeconds is <= 0 or > (int.MaxValue / 1000))
        {
            throw new InvalidOperationException("schema_plan_timeout_invalid");
        }
        TimeProvider clock = timeProvider ?? TimeProvider.System;
        var invocationDeadline = new OfflineMigrationOperationDeadline(clock, options.TimeoutSeconds);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(checked(options.TimeoutSeconds * 1000)), clock);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(callerToken, deadline.Token);
        operation.Token.ThrowIfCancellationRequested();
        IOfflineMigrationPlanningEvidence evidence = createEvidence();
        operation.Token.ThrowIfCancellationRequested();
        await WritePlanAsync(options with { OperationDeadline = invocationDeadline }, evidence, operation.Token).ConfigureAwait(false);
        // WritePlanAsync checks the same token before atomic publication. Do not turn an
        // already published immutable artifact into a later cancellation outcome.
    }

    internal static async Task ObserveSourceWithinBudgetAsync(
        OfflineMigrationSourceCommandOptions options,
        Func<CancellationToken, Task<string>> readConnectionString,
        Func<IOfflineMigrationSnapshotSourceObserver> createObserver,
        TextReader control,
        TextWriter output,
        CancellationToken callerToken,
        TimeProvider? timeProvider = null)
    {
        if (options.TimeoutSeconds is <= 0 or > (int.MaxValue / 1000))
        {
            throw new InvalidOperationException("schema_source_observation_timeout_invalid");
        }

        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(checked(options.TimeoutSeconds * 1000)),
            timeProvider ?? TimeProvider.System);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(callerToken, deadline.Token);
        operation.Token.ThrowIfCancellationRequested();
        string connectionString = await readConnectionString(operation.Token).ConfigureAwait(false);
        operation.Token.ThrowIfCancellationRequested();
        // Construct the capability only after budget admission. Its native work must take
        // this token; a capability constructor is not a place to connect to a database.
        IOfflineMigrationSnapshotSourceObserver observer = createObserver();
        operation.Token.ThrowIfCancellationRequested();
        await ObserveSourceAsync(options, connectionString, observer, control, output, operation.Token).ConfigureAwait(false);
        operation.Token.ThrowIfCancellationRequested();
        // Actual native/session drain belongs to the awaited observer, not a timed wait
        // followed by disposing still-active commands. Missing cleanup proof is failure.
    }

    internal static async Task ObserveSourceAsync(
        OfflineMigrationSourceCommandOptions options,
        string connectionString,
        IOfflineMigrationSnapshotSourceObserver observer,
        TextReader control,
        TextWriter output,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!options.CaptureSession)
        {
            OfflineMigrationSourceObservation observed = await observer.ObserveAsync(
                options.Provider, connectionString, cancellationToken).ConfigureAwait(false);
            OfflineMigrationPlanValidation.ValidateObservation(observed);
            if (observed.Database.Provider != options.Provider)
            {
                throw new InvalidOperationException("schema_source_observation_provider_mismatch");
            }

            await output.WriteLineAsync(JsonSerializer.Serialize(observed).AsMemory(), cancellationToken).ConfigureAwait(false);
            await output.FlushAsync(cancellationToken).ConfigureAwait(false);
            return;
        }

        if (options.Provider != CurrentSchemaProviderKind.PostgreSql || options.DumpOutputPath is null
            || !Path.IsPathFullyQualified(options.DumpOutputPath) || File.Exists(options.DumpOutputPath)
            || Directory.Exists(options.DumpOutputPath))
        {
            throw new InvalidOperationException("schema_source_capture_dump_path_not_new");
        }

        OfflineMigrationSourceObservation? announcedSource = null;
        string? announcedSnapshot = null;
        DateTimeOffset capturedAt = default;
        var captured = await observer.CapturePostgreSqlSnapshotAsync(connectionString, async (source, snapshotId, snapshotTime, token) =>
        {
            OfflineMigrationPlanValidation.ValidateObservation(source);
            if (source.Database.Provider != CurrentSchemaProviderKind.PostgreSql || announcedSource is not null)
            {
                throw new InvalidOperationException("schema_source_capture_observation_invalid");
            }

            OfflineMigrationPlanValidation.RequireText(snapshotId, "schema_source_capture_snapshot_invalid");
            if (snapshotTime == default || snapshotTime.Offset != TimeSpan.Zero)
            {
                throw new InvalidOperationException("schema_source_capture_time_invalid");
            }
            announcedSource = source;
            announcedSnapshot = snapshotId;
            capturedAt = snapshotTime;
            await output.WriteLineAsync(JsonSerializer.Serialize(new
            {
                Source = source,
                SnapshotId = snapshotId,
                CapturedAt = capturedAt,
                ObserverId = source.ExtractorId,
                ObserverVersion = source.ExtractorVersion,
                TimeoutSeconds = options.TimeoutSeconds
            }).AsMemory(), token).ConfigureAwait(false);
            await output.FlushAsync(token).ConfigureAwait(false);
            string? terminal = await control.ReadLineAsync(token).ConfigureAwait(false);
            if (terminal != "DUMP_COMPLETED")
            {
                throw new InvalidOperationException("schema_source_capture_dump_terminal_required");
            }

            // The original dump owner owns actual child drain. This closed handshake selects
            // neither a path nor a digest; the observer hashes the path bound before capture.
            return options.DumpOutputPath;
        }, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (announcedSource is null || captured.SnapshotId != announcedSnapshot || captured.CapturedAt != capturedAt
            || !OfflineMigrationPlanValidation.Equal(captured.Source, announcedSource))
        {
            throw new InvalidOperationException("schema_source_capture_identity_changed");
        }

        OfflineMigrationPlanValidation.RequireDigest(captured.DumpSha256, "schema_source_capture_dump_digest_invalid");
        var evidence = new OfflineMigrationBackupCaptureEvidence(captured.Source, captured.SnapshotId,
            capturedAt, captured.Source.ExtractorId, captured.Source.ExtractorVersion, captured.DumpSha256, options.TimeoutSeconds);
        await output.WriteLineAsync(JsonSerializer.Serialize(new { status = "ok", capture = evidence })
            .AsMemory(), cancellationToken).ConfigureAwait(false);
        await output.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    internal static async Task WritePlanAsync(
        OfflineMigrationPlanCommandOptions options,
        IOfflineMigrationPlanningEvidence evidence,
        CancellationToken cancellationToken)
    {
        VerifiedOfflineMigrationPlan verified = await OfflineMigrationPlanEvidence.ReadAndVerifyAsync(
            options, evidence, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // Never overwrite an earlier immutable plan. Publication is after all read-only
        // admission, outside any database transaction and without invoking legacy phases.
        string target = Path.GetFullPath(options.PlanOutputPath);
        string staging = target + "." + Guid.NewGuid().ToString("N") + ".staging";
        try
        {
            await using (var output = new FileStream(staging, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                Options = FileOptions.Asynchronous,
                UnixCreateMode = OperatingSystem.IsWindows() ? null : UnixFileMode.UserRead | UnixFileMode.UserWrite
            }))
            {
                await output.WriteAsync(OfflineMigrationPlanCodec.Serialize(verified.Plan), cancellationToken).ConfigureAwait(false);
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
                output.Flush(flushToDisk: true);
            }

            cancellationToken.ThrowIfCancellationRequested();
            File.Move(staging, target, overwrite: false);
        }
        finally
        {
            File.Delete(staging);
        }
    }

    private static async Task<string> ResolveConnectionStringAsync(OfflineMigrationCommandOptions parsed)
    {
        string? fromFile = parsed.EnvironmentFilePath is null
            ? null
            : ReadEnvironmentFile(parsed.EnvironmentFilePath)
                .GetValueOrDefault("ConnectionStrings__DefaultConnection");
        string fromProcess = Environment.GetEnvironmentVariable("ConnectionStrings__DefaultConnection") ?? string.Empty;
        // Env file wins for deployment invocation; process environment covers local runs.
        return !string.IsNullOrWhiteSpace(fromFile) ? fromFile : fromProcess;
    }

    private static string ResolveReleaseId(OfflineMigrationCommandOptions parsed)
    {
        if (!string.IsNullOrWhiteSpace(parsed.ReleaseManifestPath))
        {
            using JsonDocument document = JsonDocument.Parse(
                File.ReadAllText(parsed.ReleaseManifestPath));
            if (document.RootElement.TryGetProperty("releaseId", out JsonElement releaseId)
                && releaseId.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(releaseId.GetString()))
            {
                return releaseId.GetString()!;
            }
        }

        return Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID")
            ?? "dev-offline";
    }

    private static Dictionary<string, string> ReadEnvironmentFile(string path)
        => ParseEnvironmentLines(File.ReadAllLines(path));

    private static Dictionary<string, string> ParseEnvironmentLines(IEnumerable<string> lines)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string rawLine in lines)
        {
            string line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
            {
                continue;
            }

            line = line.StartsWith("export ", StringComparison.Ordinal)
                ? line["export ".Length..].TrimStart()
                : line;
            int separator = line.IndexOf('=');
            if (separator <= 0)
            {
                throw new InvalidOperationException("schema_env_file_line_invalid");
            }

            string key = line[..separator].Trim();
            string value = line[(separator + 1)..].Trim();
            if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
            {
                value = value[1..^1];
            }

            values[key] = value;
        }

        return values;
    }

    private static void WriteJson(object payload)
        => Console.WriteLine(JsonSerializer.Serialize(payload));

    internal static ISqlSugarClient CreateDatabase(string connectionString)
        => new SqlSugarClient(new ConnectionConfig
        {
            DbType = DbType.PostgreSQL,
            ConnectionString = connectionString,
            IsAutoCloseConnection = false
        });
}
