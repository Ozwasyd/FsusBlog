using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Security.Cryptography;

using SqlSugar;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;

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

    public static Task<int> Main(string[] args) => RunAsync(args, null);

    internal static Task<int> RunOwnedAsync(string[] args, OfflineMigrationHostOwnedConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return RunAsync(args, configuration);
    }

    private static async Task<int> RunAsync(string[] args, OfflineMigrationHostOwnedConfiguration? configuration)
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
                }, OfflineMigrationPlanEvidence.CreateOwnedSourceObserver, Console.In, Console.Out, callerToken,
                    configuration?.Clock)).ConfigureAwait(false);
                return 0;
            }
            catch (OfflineMigrationSourceFingerprintException fingerprint)
            {
                WriteFingerprintFailure(fingerprint, Console.Out);
                return 1;
            }
            catch (OperationCanceledException)
            {
                WriteJson(new
                {
                    status = "failed",
                    code = "schema_offline_source_operation_cancelled"
                });
                return 1;
            }
            catch (Exception exception)
            {
                // Provider faults must not publish credentials or raw historical row values.
                string code = exception is InvalidOperationException
                    ? exception.Message.Split(':', 2)[0] : "schema_offline_source_observation_failed";
                WriteJson(new
                {
                    status = "failed",
                    code
                });
                return 1;
            }
        }

        if (args.Length > 0 && args[0] == "plan")
        {
            try
            {
                OfflineMigrationPlanCommandOptions options = OfflineMigrationCommandLine.ParsePlan(args);
                await RunReadOnlyCommandWithSignalsAsync(callerToken => WritePlanWithinBudgetAsync(options,
                    () => configuration is null ? OfflineMigrationPlanEvidence.CreateOwnedReader()
                        : configuration.CreatePlanningEvidence(), callerToken, configuration?.Clock)).ConfigureAwait(false);
                return 0;
            }
            catch (OfflineMigrationSourceFingerprintException fingerprint)
            {
                WriteFingerprintFailure(fingerprint, Console.Out);
                return 1;
            }
            catch (OperationCanceledException)
            {
                WriteJson(new
                {
                    status = "failed",
                    code = "schema_offline_plan_operation_cancelled"
                });
                return 1;
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                WriteJson(new
                {
                    status = "failed",
                    code = exception.Message
                });
                return 1;
            }
        }

        if (args.Length > 0 && args[0] == "apply")
        {
            try
            {
                OfflineMigrationApplyCommandOptions options = OfflineMigrationCommandLine.ParseApply(args);
                bool completed = false;
                await RunReadOnlyCommandWithSignalsAsync(async callerToken =>
                {
                    completed = await ApplyWithinBudgetAsync(options, () => configuration is null ? OfflineMigrationApplyEvidence.CreateOwned()
                        : configuration.CreateApplyProducer(), Console.Out, callerToken, configuration?.Clock).ConfigureAwait(false);
                }).ConfigureAwait(false);
                return completed ? 0 : 1;
            }
            catch (OfflineMigrationSourceFingerprintException fingerprint)
            {
                WriteFingerprintFailure(fingerprint, Console.Out);
                return 1;
            }
            catch (OperationCanceledException)
            {
                WriteJson(new
                {
                    status = "failed",
                    code = "schema_offline_apply_operation_cancelled"
                });
                return 1;
            }
            catch (Exception error)
            {
                string code = error is InvalidOperationException
                    && (error.Message.StartsWith("offline_", StringComparison.Ordinal)
                        || error.Message.StartsWith("schema_", StringComparison.Ordinal)
                        || error.Message.StartsWith("current_", StringComparison.Ordinal))
                    ? error.Message.Split(':', 2)[0] : "schema_offline_apply_failed";
                WriteJson(new
                {
                    status = "failed",
                    code
                });
                return 1;
            }
        }

        if (args.Length > 0 && args[0] == "verify")
        {
            try
            {
                OfflineMigrationVerifyCommandOptions options = OfflineMigrationCommandLine.ParseVerify(args);
                await RunReadOnlyCommandWithSignalsAsync(callerToken => VerifyWithinBudgetAsync(
                    options, () => configuration is null ? OfflineMigrationVerifyEvidence.CreateOwned()
                        : configuration.CreateVerifyProducer(), Console.Out, callerToken, configuration?.Clock)).ConfigureAwait(false);
                return 0;
            }
            catch (OfflineMigrationSourceFingerprintException fingerprint)
            {
                WriteFingerprintFailure(fingerprint, Console.Out);
                return 1;
            }
            catch (OperationCanceledException)
            {
                WriteJson(new
                {
                    status = "failed",
                    code = "schema_offline_verify_operation_cancelled"
                });
                return 1;
            }
            catch (Exception error)
            {
                string code = error is InvalidOperationException
                    && (error.Message.StartsWith("current_", StringComparison.Ordinal)
                        || error.Message.StartsWith("schema_", StringComparison.Ordinal)
                        || error.Message.StartsWith("offline_", StringComparison.Ordinal))
                    ? error.Message.Split(':', 2)[0] : "schema_offline_verify_failed";
                WriteJson(new
                {
                    status = "failed",
                    code
                });
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
            using IDisposable storageScope = ContentAssetCutoverBackfillContext.Push(
                ResolvePublicAssetRoot(parsed));
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

    // Explicit compiled process entry. Selectors are held by the original invocation
    // owner, not added to CLI JSON or inferred from a plan/current database. The returned
    // same-process configuration retains the actual backup invocation for apply/verify.
    internal static async Task<OfflineMigrationHostOwnedConfiguration> RunOriginalArticlePlanAsync(
        string[] args, ArticlePreservationProducerInputs inputs,
        OwnedCurrentSchemaTarget target, OwnedRetainedMigrationTool tool,
        PgArticlePreservationMediaConfiguration media, PgArticlePreservationRecoveryConfiguration recovery,
        ImmutableArray<OfflineMigrationApplyOperation> otherProviderOwners, TimeSpan maximumBackupAge,
        OfflineMigrationShellBackupDrillOwnedInputs backupInputs, TimeProvider? timeProvider = null)
    {
        OfflineMigrationPlanCommandOptions options = OfflineMigrationCommandLine.ParsePlan(args);
        OfflineMigrationHostOwnedConfiguration? configured = null;
        await RunReadOnlyCommandWithSignalsAsync(callerToken => WritePlanWithinBudgetAsync(options,
            async (bound, token) =>
            {
                configured = await OfflineMigrationHostOwnedConfiguration.CreateOriginalArticlePreservationAsync(
                    bound, inputs, target, tool, media, recovery, otherProviderOwners, maximumBackupAge,
                    backupInputs, token, timeProvider).ConfigureAwait(false);
                return configured.CreatePlanningEvidence();
            }, callerToken, timeProvider)).ConfigureAwait(false);
        return configured ?? throw new InvalidOperationException("offline_article_original_host_configuration_missing");
    }

    internal static Task WritePlanWithinBudgetAsync(
        OfflineMigrationPlanCommandOptions options,
        Func<IOfflineMigrationPlanningEvidence> createEvidence,
        CancellationToken callerToken,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(createEvidence);
        return WritePlanWithinBudgetAsync(options,
            (_, _) => Task.FromResult(createEvidence()), callerToken, timeProvider);
    }

    internal static async Task WritePlanWithinBudgetAsync(
        OfflineMigrationPlanCommandOptions options,
        Func<OfflineMigrationPlanCommandOptions, CancellationToken, Task<IOfflineMigrationPlanningEvidence>> createEvidence,
        CancellationToken callerToken,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(createEvidence);
        if (options.TimeoutSeconds is <= 0 or > (int.MaxValue / 1000))
        {
            throw new InvalidOperationException("schema_plan_timeout_invalid");
        }
        TimeProvider clock = timeProvider ?? TimeProvider.System;
        var invocationDeadline = new OfflineMigrationOperationDeadline(clock, options.TimeoutSeconds);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(checked(options.TimeoutSeconds * 1000)), clock);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(callerToken, deadline.Token);
        operation.Token.ThrowIfCancellationRequested();
        OfflineMigrationPlanCommandOptions invocation = options with
        {
            OperationDeadline = invocationDeadline
        };
        // Compiled owner composition may read retained inputs and publish article inputs.
        // It is part of this original operation, not a fresh per-stage timeout or a CLI plugin.
        IOfflineMigrationPlanningEvidence evidence = await createEvidence(invocation, operation.Token).ConfigureAwait(false);
        operation.Token.ThrowIfCancellationRequested();
        _ = invocationDeadline.RemainingWholeSeconds(operation.Token);
        await WritePlanAsync(invocation, evidence, operation.Token).ConfigureAwait(false);
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

    internal static async Task<bool> ApplyWithinBudgetAsync(
        OfflineMigrationApplyCommandOptions options, Func<IOfflineMigrationApplyProducer> createProducer,
        TextWriter output, CancellationToken callerToken, TimeProvider? timeProvider = null)
    {
        if (options.TimeoutSeconds is <= 0 or > int.MaxValue / 1000
            || options.CleanupTimeoutSeconds is <= 0 or > int.MaxValue / 1000)
        {
            throw new InvalidOperationException("schema_apply_explicit_budgets_invalid");
        }
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(checked(options.TimeoutSeconds * 1000)),
            timeProvider ?? TimeProvider.System);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(callerToken, deadline.Token);
        operation.Token.ThrowIfCancellationRequested();
        // Existing evidence names are refused before connecting/writing. Final no-overwrite
        // publication remains authoritative if another writer races this read-only check.
        foreach (string path in new[] { options.OutputPath, options.CheckpointOutputPath })
        {
            if (File.Exists(path) || Directory.Exists(path) || new FileInfo(path).LinkTarget is not null)
            {
                throw new InvalidOperationException("offline_apply_output_already_exists");
            }
        }
        IOfflineMigrationApplyProducer producer = createProducer();
        operation.Token.ThrowIfCancellationRequested();
        OfflineMigrationApplyResult result = await producer.ApplyAsync(options, operation.Token).ConfigureAwait(false);
        ValidateApplyOutcome(options, result);
        // Apply is NOT current-schema verification. Preserve a terminal failure/recovery
        // result as such and never replace it with a synthetic successful receipt.
        CurrentSchemaArtifactReference? checkpoint = null;
        CurrentSchemaArtifactReference published;
        try
        {
            operation.Token.ThrowIfCancellationRequested();
            if (result.Checkpoint is { } actual)
            {
                checkpoint = await OfflineMigrationArtifactPublisher.PublishAsync(options.CheckpointOutputPath,
                    JsonSerializer.SerializeToUtf8Bytes(actual), operation.Token).ConfigureAwait(false);
            }
            published = await OfflineMigrationArtifactPublisher.PublishAsync(options.OutputPath,
                JsonSerializer.SerializeToUtf8Bytes(result), operation.Token).ConfigureAwait(false);
        }
        catch
        {
            // The database may already contain committed units. Keep any checkpoint
            // artifact, do not delete/compensate them or report a harmless pre-write cancel.
            throw new InvalidOperationException(checkpoint is null ? "offline_apply_terminal_artifacts_unpublished"
                : "offline_apply_checkpoint_published_apply_unpublished");
        }
        bool completed = result.Status is OfflineMigrationApplyStatus.Completed or OfflineMigrationApplyStatus.NoOpVerified;
        try
        {
            await output.WriteLineAsync(JsonSerializer.Serialize(new
            {
                status = completed ? "completed" : "failed",
                outcome = result.Status.ToString(),
                apply = published,
                checkpoint
            }).AsMemory(), operation.Token).ConfigureAwait(false);
            await output.FlushAsync(operation.Token).ConfigureAwait(false);
        }
        catch
        {
            throw new InvalidOperationException("offline_apply_artifacts_published_response_failed");
        }
        return completed;
    }

    internal static void ValidateApplyOutcome(OfflineMigrationApplyCommandOptions options, OfflineMigrationApplyResult result)
    {
        if (!Enum.IsDefined(result.Status) || result.Plan != options.Plan || result.Database != options.Database
            || result.StepProofs.IsDefault || result.Codes.IsDefault
            || result.Codes.Any(code => string.IsNullOrEmpty(code) || !code.StartsWith("offline_apply_", StringComparison.Ordinal)
                || code.Any(value => value is not (>= 'a' and <= 'z') and not (>= '0' and <= '9') and not '_')))
        {
            throw new InvalidOperationException("offline_apply_native_outcome_changed");
        }
        OfflineMigrationPlanValidation.RequireDigest(result.PlanContentDigest, "offline_apply_native_outcome_changed");
        if ((result.Status is OfflineMigrationApplyStatus.Completed or OfflineMigrationApplyStatus.NoOpVerified)
            && (result.Checkpoint is null || result.Codes.Length != 0))
        {
            throw new InvalidOperationException("offline_apply_native_outcome_changed");
        }
        if (result.Checkpoint is { } checkpoint)
        {
            if (checkpoint.InvocationId != options.InvocationId || checkpoint.Sequence <= 0 || checkpoint.JournalHead is null
                || checkpoint.JournalHead.Reference != "offline-apply/v1/" + checkpoint.JournalHead.EntryDigest)
            {
                throw new InvalidOperationException("offline_apply_native_checkpoint_changed");
            }
            OfflineMigrationPlanValidation.RequireDigest(checkpoint.JournalHead.EntryDigest, "offline_apply_native_checkpoint_changed");
        }
    }

    internal static async Task VerifyWithinBudgetAsync(
        OfflineMigrationVerifyCommandOptions options,
        Func<IOfflineMigrationVerifiedReceiptProducer> createProducer,
        TextWriter output, CancellationToken callerToken, TimeProvider? timeProvider = null)
    {
        if (options.TimeoutSeconds is <= 0 or > int.MaxValue / 1000)
        {
            throw new InvalidOperationException("schema_verify_timeout_invalid");
        }
        OfflineMigrationCurrentSchemaIssuer.ValidateRequest(options.Request);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(checked(options.TimeoutSeconds * 1000)),
            timeProvider ?? TimeProvider.System);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(callerToken, deadline.Token);
        operation.Token.ThrowIfCancellationRequested();
        IOfflineMigrationVerifiedReceiptProducer producer = createProducer();
        operation.Token.ThrowIfCancellationRequested();
        OfflineMigrationCurrentSchemaIssuedArtifact issued = await producer.IssueAsync(options, operation.Token).ConfigureAwait(false);
        operation.Token.ThrowIfCancellationRequested();
        // The returned ReadOnlyMemory may still alias a producer-owned mutable array.
        // Validate and publish one private snapshot, not two separately observed views.
        byte[] receiptBytes = issued.Bytes.ToArray();
        CurrentSchemaReceiptCodec.ValidateIntegrity(issued.Receipt);
        if (issued.Receipt.Status != CurrentSchemaReceiptStatus.VerifiedCurrent
            || issued.Receipt.Database != options.Request.Database || issued.Receipt.Plan != options.Request.Plan
            || issued.Receipt.Apply != options.Request.Apply
            || !issued.Receipt.Checkpoints.SequenceEqual(options.Request.Checkpoints)
            || !receiptBytes.AsSpan().SequenceEqual(CurrentSchemaReceiptCodec.Serialize(issued.Receipt))
            || Convert.ToHexStringLower(SHA256.HashData(receiptBytes)) != issued.Reference.Sha256)
        {
            throw new InvalidOperationException("current_verify_producer_artifact_changed");
        }
        CurrentSchemaArtifactReference published = await OfflineMigrationArtifactPublisher.PublishAsync(
            options.OutputPath, receiptBytes, operation.Token).ConfigureAwait(false);
        // Publication is irreversible within this invocation. Keep the artifact if the
        // bounded response fails, and distinguish that failure from an unissued receipt.
        // Await the actual token-aware writer rather than abandoning a timed wait.
        try
        {
            await output.WriteLineAsync(JsonSerializer.Serialize(new
            {
                status = "ok",
                receipt = published
            }).AsMemory(),
                operation.Token).ConfigureAwait(false);
            await output.FlushAsync(operation.Token).ConfigureAwait(false);
        }
        catch
        {
            throw new InvalidOperationException("current_verify_receipt_published_response_failed");
        }
    }

    internal static async Task<string> ReadRequiredConnectionStringAsync(string environmentFilePath, CancellationToken cancellationToken)
    {
        string[] lines = await File.ReadAllLinesAsync(environmentFilePath, cancellationToken).ConfigureAwait(false);
        string? value = ParseEnvironmentLines(lines).GetValueOrDefault("ConnectionStrings__DefaultConnection");
        if (string.IsNullOrWhiteSpace(value))
            throw new InvalidOperationException("schema_connection_string_missing");
        return value;
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
        await output.WriteLineAsync(JsonSerializer.Serialize(new
        {
            status = "ok",
            capture = evidence
        })
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
        _ = await OfflineMigrationArtifactPublisher.PublishAsync(Path.GetFullPath(options.PlanOutputPath),
            OfflineMigrationPlanCodec.Serialize(verified.Plan), cancellationToken).ConfigureAwait(false);
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

    private static string? ResolvePublicAssetRoot(OfflineMigrationCommandOptions parsed)
    {
        Dictionary<string, string> fileValues = parsed.EnvironmentFilePath is null
            ? new Dictionary<string, string>(StringComparer.Ordinal)
            : ReadEnvironmentFile(parsed.EnvironmentFilePath);

        string? explicitRoot = FirstNonEmpty(
            fileValues.GetValueOrDefault("FSUSBLOG_PUBLIC_ASSET_ROOT"),
            fileValues.GetValueOrDefault("ReleaseStorage__PublicAssetRoot"),
            Environment.GetEnvironmentVariable("FSUSBLOG_PUBLIC_ASSET_ROOT"),
            Environment.GetEnvironmentVariable("ReleaseStorage__PublicAssetRoot"));
        if (!string.IsNullOrWhiteSpace(explicitRoot))
        {
            return explicitRoot;
        }

        string? sharedRoot = FirstNonEmpty(
            fileValues.GetValueOrDefault("FSUSBLOG_SHARED_STORAGE_ROOT"),
            fileValues.GetValueOrDefault("ReleaseStorage__SharedRoot"),
            Environment.GetEnvironmentVariable("FSUSBLOG_SHARED_STORAGE_ROOT"),
            Environment.GetEnvironmentVariable("ReleaseStorage__SharedRoot"));
        return string.IsNullOrWhiteSpace(sharedRoot)
            ? null
            : Path.Combine(sharedRoot, "assets", "public");
    }

    private static string? FirstNonEmpty(params string?[] values)
        => values.FirstOrDefault(static value => !string.IsNullOrWhiteSpace(value));

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

    internal static void WriteFingerprintFailure(OfflineMigrationSourceFingerprintException failure, TextWriter output)
    {
        ArgumentNullException.ThrowIfNull(failure);
        ArgumentNullException.ThrowIfNull(output);
        // Serialize only the owner's closed redacted fields, never the exception object,
        // message text, inner exception or arbitrary historical/catalog observations.
        output.WriteLine(JsonSerializer.Serialize(new
        {
            status = "failed",
            code = failure.Code,
            differences = failure.Differences,
            ambiguousBaselineIdSha256s = failure.AmbiguousBaselineIdSha256s
        }));
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
