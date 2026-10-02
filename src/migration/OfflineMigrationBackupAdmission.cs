using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

using Microsoft.Win32.SafeHandles;

using FsusBlog.Contracts.Migration;

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

/// <summary>
/// Consume the original owned drill's terminal output and actual retained bytes. This class
/// does not decrypt, restore, sign evidence, or turn an arbitrary report into an invocation.
/// The production factory must supply the original invocation owner, not a caller delegate.
/// </summary>
internal sealed class OfflineMigrationBackupAdmission(IOfflineMigrationBackupDrillProducer producer)
    : IOfflineMigrationOwnedBackupAdmission
{
    private static readonly string[] RequiredChecks =
    [
        "site-backup-package:authenticated-unpacked", "database-restored-source:verified",
        "postgres-restore:ok", "uploads-recoverable:verified", "dataProtectionKeyRing-recoverable:verified",
        "configRedacted-recoverable:verified", "aotCache-recoverable:verified", "searchIndex-recoverable:verified",
        "owned-postgres-container-removed:verified", "owned-pre-migration-resources-terminal:verified"
    ];

    public async Task<OfflineMigrationBackupObservation> ReadAndVerifyAsync(
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

    private async Task<OfflineMigrationBackupObservation> ReadOwnedAsync(
        OfflineMigrationPlanCommandOptions options, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (options.ExpectedDatabase.Provider != CurrentSchemaProviderKind.PostgreSql)
        {
            throw Failure("provider_capture_capability_missing");
        }
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
        Require(RequiredChecks.All(check => checks.Contains(check, StringComparer.Ordinal))
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
        return backup;
    }

    private static async Task<JsonDocument> ReadJsonArtifactAsync(JsonElement output, string prefix, string expectedPath,
        CancellationToken cancellationToken)
    {
        Require(Text(output, prefix + "Reference") == expectedPath, "artifact_reference_mismatch");
        await using FileStream input = OpenRegularFile(expectedPath, out ArtifactIdentity identity);
        using var retained = new MemoryStream();
        await input.CopyToAsync(retained, cancellationToken).ConfigureAwait(false);
        RequireUnchanged(input, expectedPath, identity);
        byte[] bytes = retained.ToArray();
        Require(Convert.ToHexStringLower(SHA256.HashData(bytes)) == Digest(output, prefix + "Sha256"), "artifact_bytes_changed");
        return Parse(bytes);
    }

    private static async Task<string> HashRegularFileAsync(string path, CancellationToken cancellationToken)
    {
        await using FileStream input = OpenRegularFile(path, out ArtifactIdentity identity);
        string digest = Convert.ToHexStringLower(await SHA256.HashDataAsync(input, cancellationToken).ConfigureAwait(false));
        RequireUnchanged(input, path, identity);
        return digest;
    }

    private static FileStream OpenRegularFile(string path, out ArtifactIdentity identity)
    {
        RequireDirectoryChain(Path.GetDirectoryName(path)!);
        Require(OperatingSystem.IsLinux(), "regular_artifact_required");
        identity = ReadIdentity(-100, path, 0x100); // AT_FDCWD, AT_SYMLINK_NOFOLLOW.
        // O_NONBLOCK avoids blocking in open if a file was replaced by a FIFO; no-follow
        // rejects a replacement symlink. Verify the actual FD before reading any bytes.
        int descriptor = NativeMethods.Open(path, 0x800 | 0x20000 | 0x80000);
        Require(descriptor >= 0, "regular_artifact_required");
        var handle = new SafeFileHandle((IntPtr)descriptor, ownsHandle: true);
        try
        {
            Require(ReadIdentity(descriptor, string.Empty, 0x1100) == identity, "artifact_identity_changed");
            return new FileStream(handle, FileAccess.Read, 64 * 1024, isAsync: false);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void RequireUnchanged(FileStream input, string path, ArtifactIdentity identity)
    {
        Require(ReadIdentity(input.SafeFileHandle.DangerousGetHandle().ToInt32(), string.Empty, 0x1100) == identity
            && ReadIdentity(-100, path, 0x100) == identity, "artifact_identity_changed");
    }

    private static ArtifactIdentity ReadIdentity(int descriptor, string path, int flags)
    {
        const uint mask = 0x7df;
        Require(NativeMethods.Statx(descriptor, path, flags, mask, out NativeStatx status) == 0
            && (status.Mask & mask) == mask && (status.Mode & 0xf000) == 0x8000, "regular_artifact_required");
        // Empty logs are valid. The encrypted package and native JSON validity are checked
        // by their respective owners; do not inherit dump-only size/link-count restrictions.
        return new(status.DeviceMajor, status.DeviceMinor, status.Inode, status.Links, status.Size,
            status.Mode, status.Uid, status.Gid, status.ChangedSeconds, status.ChangedNanoseconds,
            status.ModifiedSeconds, status.ModifiedNanoseconds);
    }

    private readonly record struct ArtifactIdentity(uint DeviceMajor, uint DeviceMinor, ulong Inode, uint Links,
        ulong Size, ushort Mode, uint Uid, uint Gid, long ChangedSeconds, uint ChangedNanoseconds,
        long ModifiedSeconds, uint ModifiedNanoseconds);

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct NativeStatx
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(16)] public uint Links;
        [FieldOffset(20)] public uint Uid;
        [FieldOffset(24)] public uint Gid;
        [FieldOffset(28)] public ushort Mode;
        [FieldOffset(32)] public ulong Inode;
        [FieldOffset(40)] public ulong Size;
        [FieldOffset(96)] public long ChangedSeconds;
        [FieldOffset(104)] public uint ChangedNanoseconds;
        [FieldOffset(112)] public long ModifiedSeconds;
        [FieldOffset(120)] public uint ModifiedNanoseconds;
        [FieldOffset(136)] public uint DeviceMajor;
        [FieldOffset(140)] public uint DeviceMinor;
    }

    private static class NativeMethods
    {
        [DllImport("libc", EntryPoint = "open", SetLastError = true)]
        internal static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

        [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
        internal static extern int Statx(int descriptor, [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
            int flags, uint mask, out NativeStatx status);
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
            foreach (JsonElement item in value.EnumerateArray()) RejectDuplicateProperties(item);
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
        if (!condition) throw Failure(code);
    }

    private static InvalidOperationException Failure(string code) => new("offline_backup_owned_" + code);
}
