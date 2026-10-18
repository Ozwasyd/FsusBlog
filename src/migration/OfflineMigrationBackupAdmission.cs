using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Migration;

// This is the original backup owner's invocation boundary, not a JSON/plugin interface.
// RunAsync must invoke the original --migration-evidence producer with this fresh root
// and nonce, one remaining deadline, original package authentication and pre-migration
// recoverability checks. A historical source must not need the current Server to start.
// It must drain the actual producer, owned children and pipes before returning; cancellation
// and unverified cleanup are failures, never a successful result with ExitCode zero.
// An external report or --inspect-only output cannot implement this port.
internal interface IOfflineMigrationBackupDrillProducer
{
    Task<OfflineMigrationBackupDrillTerminal> RunAsync(
        OfflineMigrationPlanCommandOptions options, string privateRoot, string invocation,
        CancellationToken cancellationToken);
}

internal sealed record OfflineMigrationBackupDrillTerminal(int ExitCode, ReadOnlyMemory<byte> StandardOutput);

// The Host creates this once with the same clock/budget as its cancellation timer.
// Remaining time is never reset when a later package/restore stage is entered. This
// ephemeral ledger is not part of any artifact and is not an evidence authority.
internal sealed class OfflineMigrationOperationDeadline
{
    private readonly TimeProvider _clock;
    private readonly long _startedAt;
    private readonly TimeSpan _total;

    internal OfflineMigrationOperationDeadline(TimeProvider clock, int timeoutSeconds)
    {
        if (timeoutSeconds is <= 0 or > int.MaxValue / 1000)
        {
            throw new InvalidOperationException("schema_plan_timeout_invalid");
        }
        _clock = clock;
        _startedAt = clock.GetTimestamp();
        _total = TimeSpan.FromSeconds(timeoutSeconds);
    }

    internal int RemainingWholeSeconds(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        TimeSpan elapsed = _clock.GetElapsedTime(_startedAt);
        TimeSpan remaining = _total - elapsed;
        if (elapsed < TimeSpan.Zero || remaining < TimeSpan.FromSeconds(1))
        {
            // The original shell accepts only whole seconds. Rounding up would extend
            // its operation beyond the original deadline; insufficient time is refusal.
            throw new InvalidOperationException("offline_backup_owned_remaining_budget_unrepresentable");
        }
        return checked((int)(remaining.Ticks / TimeSpan.TicksPerSecond));
    }
}

/// <summary>
/// Consume the original owned drill's terminal output and actual retained bytes. This class
/// does not decrypt, restore, sign evidence, or turn an arbitrary report into an invocation.
/// The production factory must supply the original invocation owner, not a caller delegate.
/// </summary>
internal sealed class OfflineMigrationBackupAdmission(IOfflineMigrationBackupDrillProducer producer)
    : IOfflineMigrationOwnedBackupAdmission
{
    private static readonly string[] s_requiredChecks =
    [
        "site-backup-package:authenticated-unpacked", "database-restored-source:verified",
        "postgres-restore:ok", "uploads-recoverable:verified", "dataProtectionKeyRing-recoverable:verified",
        "configRedacted-recoverable:verified", "aotCache-recoverable:verified", "searchIndex-recoverable:verified",
        "owned-postgres-container-removed:verified", "owned-pre-migration-resources-terminal:verified"
    ];

    public async Task<OfflineMigrationBackupObservation> ReadAndVerifyAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken)
        => (await ReadAndVerifyInvocationAsync(options, cancellationToken).ConfigureAwait(false)).Observation;

    internal Task<OfflineMigrationRetainedOwnedBackup> ReadAndRetainAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken)
        => OfflineMigrationRetainedOwnedBackup.CaptureAsync(this, options, cancellationToken);

    internal async Task<OfflineMigrationOwnedBackupInvocation> ReadRetainedInvocationAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (producer is not OfflineMigrationShellBackupDrillProducer original || original.OwnedInputs is null)
        {
            throw Failure("retained_original_bound_producer_required");
        }
        return await ReadAndVerifyInvocationAsync(options, cancellationToken).ConfigureAwait(false);
    }

    private async Task<OfflineMigrationOwnedBackupInvocation> ReadAndVerifyInvocationAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken)
    {
        try
        {
            return await ReadOwnedAsync(options, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException
            or KeyNotFoundException or FormatException)
        {
            // Original cleanup refusals and cancellation retain their categories. File/JSON
            // diagnostics must not publish private paths or values from a malformed report.
            throw Failure("artifact_read_or_format_failed");
        }
    }

    private async Task<OfflineMigrationOwnedBackupInvocation> ReadOwnedAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (options.ExpectedDatabase.Provider != CurrentSchemaProviderKind.PostgreSql)
        {
            throw Failure("provider_capture_capability_missing");
        }
        if (options.OperationDeadline is null)
        {
            throw Failure("operation_deadline_required");
        }
        _ = options.OperationDeadline.RemainingWholeSeconds(cancellationToken);
        string reportPath = Canonical(options.RestoreDrillPath);
        string root = Path.GetDirectoryName(reportPath)!;
        if (reportPath != Path.Combine(root, "backup-restore-drill.json")
            || Canonical(options.BackupManifestPath) != Path.Combine(root, "package-manifest.json")
            || Directory.Exists(root) || File.Exists(root) || new DirectoryInfo(root).LinkTarget is not null)
        {
            throw Failure("fresh_owned_output_paths_required");
        }
        RequireDirectoryChain(Path.GetDirectoryName(root)!);
        string invocation = Guid.NewGuid().ToString("N");
        OfflineMigrationBackupDrillTerminal terminal = await producer.RunAsync(
            options, root, invocation, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (terminal.ExitCode != 0)
        {
            throw Failure("producer_terminal_failed");
        }
        RequireDirectoryChain(root);
        if (!OperatingSystem.IsLinux() || File.GetUnixFileMode(root) !=
            (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute))
        {
            throw Failure("private_output_mode_invalid");
        }

        using JsonDocument outputDocument = Parse(terminal.StandardOutput);
        JsonElement output = outputDocument.RootElement;
        Require(output.GetProperty("version").GetInt32() == 2
            && Text(output, "owner") == "tools/operations/backup-restore-drill.sh"
            && Text(output, "ownerVersion") == "2" && Text(output, "operation") == "migration-evidence"
            && Text(output, "invocation") == invocation && Text(output, "privateRoot") == root
            && output.GetProperty("producerExitCode").GetInt32() == 0, "invocation_binding_invalid");

        string packageDigest = await HashRegularFileAsync(Canonical(options.BackupPackagePath), cancellationToken).ConfigureAwait(false);
        Require(packageDigest == Digest(output, "packageSha256"), "package_bytes_changed");
        using JsonDocument reportDocument = await ReadJsonArtifactAsync(output, "report", reportPath, cancellationToken).ConfigureAwait(false);
        using JsonDocument manifestDocument = await ReadJsonArtifactAsync(output, "manifest", Path.Combine(root, "package-manifest.json"), cancellationToken).ConfigureAwait(false);
        using JsonDocument nativeDocument = await ReadJsonArtifactAsync(output, "nativeRestoredSource", Path.Combine(root, "native-restored-source.json"), cancellationToken).ConfigureAwait(false);
        // Every original retained artifact is checked, including empty logs. No artifact is
        // replaced by a caller path or a synthetic success summary.
        foreach ((string prefix, string name) in new (string, string)[]
        {
            ("drillManifest", "backup-restore-manifest.json"),
            ("stdout", "owned-drill.stdout"), ("stderr", "owned-drill.stderr"),
            ("nativeStderr", $"backup-restore-drill-{invocation}.source-stderr.log")
        })
        {
            string path = Path.Combine(root, name);
            Require(Text(output, prefix + "Reference") == path, "artifact_reference_mismatch");
            Require(await HashRegularFileAsync(path, cancellationToken).ConfigureAwait(false)
                == Digest(output, prefix + "Sha256"), "artifact_bytes_changed");
        }
        foreach (string prefix in new[] { "residue", "backendLog", "backendListenerStart", "backendListenerEnd" })
        {
            Require(output.GetProperty(prefix + "Reference").ValueKind == JsonValueKind.Null
                && output.GetProperty(prefix + "Sha256").ValueKind == JsonValueKind.Null, "runtime_qualification_not_backup_proof");
        }

        JsonElement report = reportDocument.RootElement;
        JsonElement manifest = manifestDocument.RootElement;
        Require(Text(report, "status") == "ok" && Text(report, "mode") == "migration-recoverability"
            && Text(report, "scope") == "pre-migration-backup" && report.GetProperty("baseUrl").ValueKind == JsonValueKind.Null
            && Text(report, "runId") == invocation && report.GetProperty("sourceCleanupVerified").GetBoolean()
            && Digest(report, "packageSha256") == packageDigest
            && Digest(report, "manifestSha256") == Digest(output, "manifestSha256"), "recoverability_report_invalid");
        string[] checks = report.GetProperty("checks").EnumerateArray().Select(value => value.GetString()!).ToArray();
        Require(s_requiredChecks.All(check => checks.Contains(check, StringComparer.Ordinal))
            && report.GetProperty("blockers").GetArrayLength() == 0, "recoverability_checks_missing");
        Require(manifest.GetProperty("version").GetInt32() == 3
            && Text(manifest, "kind") == "fsusblog-site-backup", "snapshot_bound_package_required");
        Require(EqualJson(manifest, output.GetProperty("manifest")), "manifest_projection_changed");
        JsonElement binding = manifest.GetProperty("sourceBinding");
        Require(EqualJson(binding, output.GetProperty("sourceBinding"))
            && EqualJson(binding, report.GetProperty("sourceBinding")), "capture_binding_changed");
        Require(Text(binding, "owner") == "tools/operations/backup-site.sh"
            && Text(binding, "ownerVersion") == "3", "capture_owner_invalid");
        OfflineMigrationBackupCaptureEvidence capture = binding.GetProperty("capture")
            .Deserialize<OfflineMigrationBackupCaptureEvidence>() ?? throw Failure("capture_missing");
        OfflineMigrationPostgreSqlNativeSession.RequireSnapshotId(capture.SnapshotId);
        Require(capture.CapturedAt != default && capture.CapturedAt.Offset == TimeSpan.Zero
            && capture.TimeoutSeconds is > 0 and <= int.MaxValue / 1000
            && capture.ObserverId == capture.Source.ExtractorId
            && capture.ObserverVersion == capture.Source.ExtractorVersion, "capture_metadata_invalid");
        Require(EqualJson(nativeDocument.RootElement, report.GetProperty("restoredSource"))
            && EqualJson(nativeDocument.RootElement, output.GetProperty("restoredSource")), "native_restore_projection_changed");
        OfflineMigrationSourceObservation restored = nativeDocument.RootElement
            .Deserialize<OfflineMigrationSourceObservation>() ?? throw Failure("native_restore_missing");
        OfflineMigrationPlanValidation.ValidateObservation(capture.Source);
        OfflineMigrationPlanValidation.ValidateObservation(restored);
        DateTimeOffset verifiedAt = report.GetProperty("generatedAt").GetDateTimeOffset();
        Require(verifiedAt != default && verifiedAt.Offset == TimeSpan.Zero && verifiedAt >= capture.CapturedAt,
            "restore_verification_time_invalid");
        ImmutableArray<OfflineMigrationFact> digests = manifest.GetProperty("artifactDigests").EnumerateObject()
            .Select(property => new OfflineMigrationFact(property.Name, property.Value.GetString()!)).ToImmutableArray();
        string restoredDumpDigest = Digest(output, "restoredDatabaseDumpSha256");
        Require(restoredDumpDigest == Digest(report, "restoredDatabaseDumpSha256")
            && capture.DatabaseDumpSha256 == Digest(binding, "databaseDumpSha256"), "restored_dump_binding_changed");
        var backup = new OfflineMigrationBackupObservation(new(Canonical(options.BackupPackagePath), packageDigest),
            new(Canonical(options.BackupManifestPath), Digest(output, "manifestSha256")),
            new(reportPath, Digest(output, "reportSha256")), Text(binding, "owner"), Text(binding, "ownerVersion"),
            capture.CapturedAt, verifiedAt, capture.SnapshotId, capture.DatabaseDumpSha256, restoredDumpDigest,
            capture.Source, restored, digests);
        // This is the same production closure used by plan admission, not a second set of
        // relaxed fixture predicates. Current-source freshness is checked by the plan reader.
        OfflineMigrationPlanValidation.ValidateBackup(capture.Source, backup, verifiedAt, TimeSpan.MaxValue);
        cancellationToken.ThrowIfCancellationRequested();
        // These exact references have already passed this actual owned invocation's
        // complete byte and semantic checks. Retention never discovers a latest report
        // or reconstructs successful invocation provenance from a plan observation.
        ImmutableArray<CurrentSchemaArtifactReference> retained =
        [
            backup.Package,
            backup.Manifest,
            backup.RestoreDrill,
            new(Text(output, "nativeRestoredSourceReference"), Digest(output, "nativeRestoredSourceSha256")),
            new(Text(output, "drillManifestReference"), Digest(output, "drillManifestSha256")),
            new(Text(output, "stdoutReference"), Digest(output, "stdoutSha256")),
            new(Text(output, "stderrReference"), Digest(output, "stderrSha256")),
            new(Text(output, "nativeStderrReference"), Digest(output, "nativeStderrSha256"))
        ];
        return new(backup, retained);
    }

    internal static async Task ValidateRetainedArtifactsAsync(
        ImmutableArray<CurrentSchemaArtifactReference> artifacts, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (artifacts.IsDefaultOrEmpty || artifacts.Length != 8
            || artifacts.Any(artifact => artifact is null)
            || artifacts.Select(artifact => artifact.Reference).Distinct(StringComparer.Ordinal).Count() != artifacts.Length)
        {
            throw Failure("retained_artifact_closure_changed");
        }
        try
        {
            foreach (CurrentSchemaArtifactReference artifact in artifacts)
            {
                OfflineMigrationPlanValidation.RequireDigest(artifact.Sha256, "offline_backup_owned_retained_digest_invalid");
                string actual = await HashRegularFileAsync(Canonical(artifact.Reference), cancellationToken).ConfigureAwait(false);
                Require(actual == artifact.Sha256, "retained_artifact_bytes_changed");
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw Failure("retained_artifact_read_failed");
        }
        cancellationToken.ThrowIfCancellationRequested();
    }

    private static async Task<JsonDocument> ReadJsonArtifactAsync(JsonElement output, string prefix, string expectedPath,
        CancellationToken cancellationToken)
    {
        Require(Text(output, prefix + "Reference") == expectedPath, "artifact_reference_mismatch");
        await using FileStream input = OpenRegularFile(expectedPath, cancellationToken);
        var initial = CaptureRegularFileIdentity(expectedPath, input, cancellationToken);
        long length = input.Length;
        Require(length is > 0 and <= int.MaxValue, "json_artifact_representation_invalid");
        byte[] bytes = new byte[checked((int)length)];
        await input.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
        byte[] trailing = new byte[1];
        Require(await input.ReadAsync(trailing, cancellationToken).ConfigureAwait(false) == 0
            && input.Length == length, "artifact_bytes_changed");
        Require(Convert.ToHexStringLower(SHA256.HashData(bytes)) == Digest(output, prefix + "Sha256"), "artifact_bytes_changed");
        ValidateRegularFileUnchanged(expectedPath, input, initial, cancellationToken);
        return Parse(bytes);
    }

    private static async Task<string> HashRegularFileAsync(string path, CancellationToken cancellationToken)
    {
        await using FileStream input = OpenRegularFile(path, cancellationToken);
        var initial = CaptureRegularFileIdentity(path, input, cancellationToken);
        long length = input.Length;
        string digest = Convert.ToHexStringLower(await SHA256.HashDataAsync(input, cancellationToken).ConfigureAwait(false));
        Require(input.Position == length && input.Length == length, "artifact_bytes_changed");
        ValidateRegularFileUnchanged(path, input, initial, cancellationToken);
        return digest;
    }

    internal static OfflineMigrationCurrentSchemaArtifactReader.OriginalRegularFileIdentity CaptureRegularFileIdentity(
        string path, FileStream input, CancellationToken cancellationToken)
    {
        try
        {
            return OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(
                path, input.SafeFileHandle, cancellationToken);
        }
        catch (InvalidOperationException error) when (error.Message.StartsWith("current_verify_", StringComparison.Ordinal))
        {
            throw Failure("artifact_identity_changed");
        }
    }

    internal static void ValidateRegularFileUnchanged(string path, FileStream input,
        OfflineMigrationCurrentSchemaArtifactReader.OriginalRegularFileIdentity initial, CancellationToken cancellationToken)
    {
        // Initial anchoring is not a terminal pathname proof. Reuse the sole owner's
        // complete same-FD metadata and anchored leaf/ancestor observations after all
        // original byte/hash checks; equal bytes at a replacement inode are still drift.
        try
        {
            OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(
                path, input.SafeFileHandle, initial, cancellationToken);
        }
        catch (InvalidOperationException error) when (error.Message.StartsWith("current_verify_", StringComparison.Ordinal))
        {
            throw Failure("artifact_identity_changed");
        }
    }

    private static FileStream OpenRegularFile(string path, CancellationToken cancellationToken)
    {
        // Reuse the sole original openat owner. Each ancestor is opened relative to
        // its already owned directory FD with DIRECTORY|NOFOLLOW; a leaf-only check
        // followed by another full-path open cannot protect an ancestor rename race.
        SafeFileHandle handle;
        try
        {
            handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(path, cancellationToken);
        }
        catch (InvalidOperationException error) when (error.Message.StartsWith("current_verify_", StringComparison.Ordinal))
        {
            throw Failure("regular_artifact_required");
        }
        try
        {
            return new FileStream(handle, FileAccess.Read, 64 * 1024, isAsync: false);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void RequireDirectoryChain(string path)
    {
        for (DirectoryInfo? directory = new(path); directory is not null; directory = directory.Parent)
        {
            Require(directory.Exists && directory.LinkTarget is null, "owned_directory_required");
        }
    }

    private static string Canonical(string path)
    {
        Require(Path.IsPathFullyQualified(path) && Path.GetFullPath(path) == path, "canonical_path_required");
        return path;
    }

    private static JsonDocument Parse(ReadOnlyMemory<byte> bytes)
    {
        JsonDocument document = JsonDocument.Parse(bytes);
        try
        {
            RejectDuplicateProperties(document.RootElement);
            return document;
        }
        catch
        {
            document.Dispose();
            throw;
        }
    }

    private static void RejectDuplicateProperties(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in value.EnumerateObject())
            {
                Require(names.Add(property.Name), "duplicate_json_property");
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in value.EnumerateArray())
                RejectDuplicateProperties(item);
        }
    }

    private static bool EqualJson(JsonElement left, JsonElement right)
        => JsonElement.DeepEquals(left, right);

    private static string Text(JsonElement value, string name)
        => value.GetProperty(name).GetString() ?? throw Failure("required_text_missing");

    private static string Digest(JsonElement value, string name)
    {
        string digest = Text(value, name);
        OfflineMigrationPlanValidation.RequireDigest(digest, "offline_backup_owned_artifact_digest_invalid");
        return digest;
    }

    private static void Require(bool condition, string code)
    {
        if (!condition)
            throw Failure(code);
    }

    private static InvalidOperationException Failure(string code) => new("offline_backup_owned_" + code);
}

// Invocation-owned retained bytes, not a serializable receipt or a second producer.
internal sealed record OfflineMigrationOwnedBackupInvocation(
    OfflineMigrationBackupObservation Observation,
    ImmutableArray<CurrentSchemaArtifactReference> Artifacts);

/// <summary>
/// Retain an actual successful original invocation in this process. The private
/// constructor cannot import a plan's backup or an unsigned report. Revalidation
/// proves the retained byte bindings, not a permanent inode lease or a new restore.
/// </summary>
internal sealed class OfflineMigrationRetainedOwnedBackup
{
    private readonly OfflineMigrationOwnedBackupInvocation _invocation;

    private OfflineMigrationRetainedOwnedBackup(OfflineMigrationOwnedBackupInvocation invocation)
    {
        _invocation = invocation;
    }

    internal OfflineMigrationBackupObservation Observation => _invocation.Observation;

    internal static async Task<OfflineMigrationRetainedOwnedBackup> CaptureAsync(
        OfflineMigrationBackupAdmission admission, OfflineMigrationPlanCommandOptions options,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(admission);
        OfflineMigrationOwnedBackupInvocation invocation = await admission.ReadRetainedInvocationAsync(
            options, cancellationToken).ConfigureAwait(false);
        // Reject drift between the original independent reads and retaining the
        // complete closure; no observation is recreated from those bytes here.
        await OfflineMigrationBackupAdmission.ValidateRetainedArtifactsAsync(invocation.Artifacts,
            cancellationToken).ConfigureAwait(false);
        return new(invocation);
    }

    internal async Task<OfflineMigrationBackupObservation> RevalidateAsync(CancellationToken cancellationToken)
    {
        await OfflineMigrationBackupAdmission.ValidateRetainedArtifactsAsync(_invocation.Artifacts,
            cancellationToken).ConfigureAwait(false);
        OfflineMigrationBackupObservation backup = _invocation.Observation;
        OfflineMigrationPlanValidation.ValidateBackup(backup.SourceAtCapture, backup,
            backup.RestoreVerifiedAt, TimeSpan.MaxValue);
        cancellationToken.ThrowIfCancellationRequested();
        return backup;
    }

    internal async Task<OfflineMigrationBackupObservation> RevalidateForSourceAsync(
        OfflineMigrationSourceObservation actualSource, DateTimeOffset admissionTime, TimeSpan maximumBackupAge,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(actualSource);
        OfflineMigrationBackupObservation backup = await RevalidateAsync(cancellationToken).ConfigureAwait(false);
        // The authority owner must obtain actualSource from the original native
        // observer on its real session, not from the plan. Reuse the production
        // database/content/freshness predicate without moving its age policy.
        OfflineMigrationPlanValidation.ValidateBackup(actualSource, backup, admissionTime, maximumBackupAge);
        cancellationToken.ThrowIfCancellationRequested();
        return backup;
    }
}
