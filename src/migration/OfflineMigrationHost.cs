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
                string? connectionString = ReadEnvironmentFile(options.EnvironmentFilePath)
                    .GetValueOrDefault("ConnectionStrings__DefaultConnection");
                if (string.IsNullOrWhiteSpace(connectionString))
                {
                    throw new InvalidOperationException("schema_connection_string_missing");
                }

                await ObserveSourceAsync(options, connectionString, OfflineMigrationPlanEvidence.CreateOwnedSourceObserver(),
                    Console.In, Console.Out, CancellationToken.None).ConfigureAwait(false);
                return 0;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                // Provider faults must not publish credentials or raw historical row values.
                string code = exception is InvalidOperationException
                    ? exception.Message.Split(':', 2)[0]
                    : "schema_offline_source_observation_failed";
                WriteJson(new { status = "failed", code });
                return 1;
            }
        }

        if (args.Length > 0 && args[0] == "plan")
        {
            try
            {
                OfflineMigrationPlanCommandOptions options = OfflineMigrationCommandLine.ParsePlan(args);
                await WritePlanAsync(options, OfflineMigrationPlanEvidence.CreateOwnedReader(), CancellationToken.None).ConfigureAwait(false);
                return 0;
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
        var captured = await observer.CapturePostgreSqlSnapshotAsync(connectionString, async (source, snapshotId, token) =>
        {
            OfflineMigrationPlanValidation.ValidateObservation(source);
            if (source.Database.Provider != CurrentSchemaProviderKind.PostgreSql || announcedSource is not null)
            {
                throw new InvalidOperationException("schema_source_capture_observation_invalid");
            }

            OfflineMigrationPlanValidation.RequireText(snapshotId, "schema_source_capture_snapshot_invalid");
            announcedSource = source;
            announcedSnapshot = snapshotId;
            capturedAt = DateTimeOffset.UtcNow;
            await output.WriteLineAsync(JsonSerializer.Serialize(new
            {
                Source = source,
                SnapshotId = snapshotId,
                CapturedAt = capturedAt,
                ObserverId = source.ExtractorId,
                ObserverVersion = source.ExtractorVersion
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
        if (announcedSource is null || captured.SnapshotId != announcedSnapshot
            || !OfflineMigrationPlanValidation.Equal(captured.Source, announcedSource))
        {
            throw new InvalidOperationException("schema_source_capture_identity_changed");
        }

        OfflineMigrationPlanValidation.RequireDigest(captured.DumpSha256, "schema_source_capture_dump_digest_invalid");
        var evidence = new OfflineMigrationBackupCaptureEvidence(captured.Source, captured.SnapshotId,
            capturedAt, captured.Source.ExtractorId, captured.Source.ExtractorVersion, captured.DumpSha256);
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
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string rawLine in File.ReadAllLines(path))
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
