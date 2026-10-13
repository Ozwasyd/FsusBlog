using System.Collections.Immutable;
using System.Text.Json.Serialization;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Observations;

/// <summary>
/// Carries a native read observation and separate provisional bytes. It is not a completed snapshot
/// or a synchronization capability; serializing this observation never includes the source body.
/// </summary>
public sealed class LinuxVaultSnapshotReadResult
{
    internal LinuxVaultSnapshotReadResult(VaultPathStructuralScope scope, string relativePath,
        VaultSnapshotAssessment? assessment, string reasonCode, byte[]? candidateBytes)
    {
        Scope = scope;
        RelativePath = relativePath;
        Assessment = assessment;
        ReasonCode = reasonCode;
        CandidateBytes = candidateBytes?.ToImmutableArray() ?? [];
    }

    public VaultPathStructuralScope Scope
    {
        get;
    }

    public string RelativePath
    {
        get;
    }

    public VaultSnapshotAssessment? Assessment
    {
        get;
    }

    public string ReasonCode
    {
        get;
    }

    /// <summary>Provisional original bytes, available only after consistent native samples and a completion fact.</summary>
    [JsonIgnore]
    public ImmutableArray<byte> CandidateBytes
    {
        get;
    }

    public bool RequiresRetry => Assessment?.State != VaultSnapshotAssessmentState.StableCandidate;

    public bool RequiresNativeCompletionVerification => true;

    public bool CanAdmitSynchronization => false;

    /// <summary>Retains exact native denial in observation batches; an unreadable leaf is never inferred removed.</summary>
    public VaultFilesystemObservation ToFilesystemObservation()
        => new(RelativePath, true, Assessment, Assessment is null ? ReasonCode : null);
}

/// <summary>
/// Reads bounded original bytes only through the existing #2109 root-bound descriptor API. The
/// caller owns the root scope; each read owns and closes its issued source handles. No watcher,
/// arbitrary absolute-path API, mutation, base commit or native completion receipt is introduced.
/// </summary>
public sealed class LinuxVaultSnapshotReader
{
    private const int ReadChunkBytes = 64 * 1024;
    private readonly LinuxVaultRootPathScope _scope;
    private readonly ArticleVaultRootManifest _manifest;

    public LinuxVaultSnapshotReader(LinuxVaultRootPathScope scope, ArticleVaultRootManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(manifest);
        _scope = scope;
        _manifest = ArticleVaultManifestCodec.DeserializeRoot(ArticleVaultManifestCodec.Serialize(manifest));
        ArticleVaultValidationResult binding = ArticleVaultPathStructureValidator.ValidateScope(_manifest, scope.Scope);
        if (!binding.IsValid)
        {
            throw new InvalidDataException(binding.ReasonCode);
        }
    }

    /// <summary>
    /// Revalidates native path identity before and after each sample and compares descriptor
    /// metadata/content across two separate opens. A close/rename fact is only a completion
    /// candidate: it is caller-supplied and cannot establish no concurrent writer or native admission.
    /// Without it, equal samples remain incomplete and return no provisional body bytes.
    /// </summary>
    public LinuxVaultSnapshotReadResult Read(string relativePath, IReadOnlyList<string> observedPaths,
        LinuxVaultRawFact? completionFact = null, CancellationToken cancellationToken = default)
        => ReadBounded(relativePath, observedPaths, completionFact, ArticleVaultSnapshotAssessor.MaxSourceBytes, cancellationToken);

    // A rescan charges both samples against a finite inventory byte budget before allocation.
    internal LinuxVaultSnapshotReadResult ReadBounded(string relativePath, IReadOnlyList<string> observedPaths,
        LinuxVaultRawFact? completionFact, int maximumSourceBytes, CancellationToken cancellationToken)
    {
        if (maximumSourceBytes is < 0 or > ArticleVaultSnapshotAssessor.MaxSourceBytes)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumSourceBytes));
        }

        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            VaultPathStructuralAnalysis path = _scope.AnalyzeProjection(relativePath, observedPaths);
            if (path.Classification != VaultPathStructuralClass.ManifestSourceProjection)
            {
                return Failure(relativePath, path.ReasonCode ?? "vault_snapshot_source_projection_required");
            }

            Sample first = ReadSample(relativePath, maximumSourceBytes, cancellationToken);
            Sample second = ReadSample(relativePath, maximumSourceBytes, cancellationToken);
            if (first.Before != first.After || second.Before != second.After || first.After != second.Before)
            {
                return Failure(relativePath, "vault_snapshot_native_metadata_changed");
            }

            _scope.AnalyzeProjection(relativePath, observedPaths);
            bool completion = IsCompletionCandidate(completionFact, relativePath);
            VaultSnapshotAssessment assessment = ArticleVaultSnapshotAssessor.Assess(_manifest, _scope.Scope,
                relativePath, observedPaths, first.After.Metadata, first.Bytes,
                second.After.Metadata, second.Bytes, completion);
            return new(_scope.Scope, relativePath, assessment, assessment.ReasonCode,
                assessment.State == VaultSnapshotAssessmentState.StableCandidate ? second.Bytes : null);
        }
        catch (LinuxVaultWatcherException exception)
        {
            return Failure(relativePath, exception.ReasonCode);
        }
        catch (UnauthorizedAccessException)
        {
            return Failure(relativePath, "vault_snapshot_permission_blocked");
        }
        catch (IOException)
        {
            return Failure(relativePath, "vault_snapshot_read_incomplete_or_blocked");
        }
        catch (ObjectDisposedException)
        {
            return Failure(relativePath, "vault_snapshot_scope_or_descriptor_closed");
        }
        catch (PlatformNotSupportedException)
        {
            return Failure(relativePath, "vault_snapshot_native_platform_unsupported");
        }
    }

    private Sample ReadSample(string relativePath, int maximumSourceBytes, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using SafeFileHandle descriptor = _scope.OpenSourceFile(relativePath);
        _scope.RevalidateForUse(descriptor);
        LinuxVaultSnapshotNative.Observation before = LinuxVaultSnapshotNative.Observe(descriptor);
        if (before.Metadata.ByteLength > maximumSourceBytes)
        {
            throw new LinuxVaultWatcherException("vault_snapshot_scan_byte_bound_exceeded");
        }

        byte[] bytes = new byte[checked((int)before.Metadata.ByteLength)];
        int offset = 0;
        while (offset < bytes.Length)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _scope.RevalidateForUse(descriptor);
            int count = RandomAccess.Read(descriptor, bytes.AsSpan(offset, Math.Min(ReadChunkBytes, bytes.Length - offset)), offset);
            if (count == 0)
            {
                throw new LinuxVaultWatcherException("vault_snapshot_native_short_read");
            }

            offset += count;
        }

        byte[] probe = new byte[1];
        if (RandomAccess.Read(descriptor, probe, bytes.Length) != 0)
        {
            throw new LinuxVaultWatcherException("vault_snapshot_native_source_grew");
        }

        cancellationToken.ThrowIfCancellationRequested();
        LinuxVaultSnapshotNative.Observation after = LinuxVaultSnapshotNative.Observe(descriptor);
        _scope.RevalidateForUse(descriptor);
        return new(before, after, bytes);
    }

    private bool IsCompletionCandidate(LinuxVaultRawFact? fact, string relativePath)
        => fact is not null && fact.RootManifestSha256 is { Length: 64 } && fact.ContentSha256 is { Length: 64 }
            && LinuxVaultRawFactCodec.Validate(fact)
            && fact.FactClass is LinuxVaultFactClass.ClosedAfterWrite or LinuxVaultFactClass.MovedTo
            && fact.PathDisposition == LinuxVaultPathDisposition.Source && !fact.RescanRequired
            && fact.WatermarkValid && fact.RawNewRelativePath == relativePath
            && fact.SiteIdentity == _scope.Scope.SiteIdentity && fact.VaultIdentity == _scope.Scope.VaultIdentity
            && fact.DeviceIdentity == _scope.Scope.DeviceIdentity && fact.AgentIdentity == _scope.Scope.AgentIdentity
            && fact.RootIdentity == _scope.Scope.RootIdentitySha256
            && fact.RootManifestSha256 == _scope.Scope.RootManifestSha256;

    private LinuxVaultSnapshotReadResult Failure(string relativePath, string reason)
        => new(_scope.Scope, relativePath, null, reason, null);

    private sealed record Sample(LinuxVaultSnapshotNative.Observation Before,
        LinuxVaultSnapshotNative.Observation After, byte[] Bytes);
}
