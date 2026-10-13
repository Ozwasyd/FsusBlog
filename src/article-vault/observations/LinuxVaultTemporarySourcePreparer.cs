using System.Collections.Immutable;
using System.Security.Cryptography;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Observations;

/// <summary>Describes completed preparation stages only; none means the source was replaced or synchronized.</summary>
public enum LinuxVaultTemporaryPreparationStage
{
    NotCreated,
    Created,
    BytesWritten,
    SourceFlushed,
    DirectoryFlushed,
    ReadbackVerified
}

/// <summary>Privacy-safe diagnostic for one operation-owned temporary, including interrupted preparations.</summary>
public sealed class LinuxVaultTemporarySourcePreparation
{
    internal LinuxVaultTemporarySourcePreparation(VaultPathStructuralScope scope,
        ArticleVaultMaterializationInstruction instruction, string? temporaryRelativePath,
        LinuxVaultTemporaryPreparationStage stage, VaultFileMetadataObservation? temporaryMetadata, string reasonCode)
    {
        Scope = scope;
        InstructionSha256 = instruction.ContentSha256;
        OperationIdentity = instruction.OperationIdentity;
        JournalIdentity = instruction.JournalIdentity;
        TemporaryRelativePath = temporaryRelativePath;
        Stage = stage;
        TemporaryMetadata = temporaryMetadata;
        DesiredSource = instruction.NewSource;
        ReasonCode = reasonCode;
        RequiredCapabilities = ["native_external_writer_exclusion", "native_conditional_source_commit",
            "accepted_complete_metadata", "native_final_source_reopen_and_verification", "materialization_base_receipt_transaction"];
        ContentSha256 = ArticleVaultLocalPreparationDigestCodec.ComputeTemporarySha256(scope, instruction,
            temporaryRelativePath, stage.ToString(), temporaryMetadata, reasonCode, RequiredCapabilities);
    }

    public VaultPathStructuralScope Scope
    {
        get;
    }
    public string InstructionSha256
    {
        get;
    }
    public string OperationIdentity
    {
        get;
    }
    public string JournalIdentity
    {
        get;
    }
    public string? TemporaryRelativePath
    {
        get;
    }
    public LinuxVaultTemporaryPreparationStage Stage
    {
        get;
    }
    public VaultFileMetadataObservation? TemporaryMetadata
    {
        get;
    }
    public VaultSourceByteIdentity? DesiredSource
    {
        get;
    }
    public string ReasonCode
    {
        get;
    }
    public ImmutableArray<string> RequiredCapabilities
    {
        get;
    }
    public string ContentSha256
    {
        get;
    }
    public bool TemporaryReadbackVerified => Stage == LinuxVaultTemporaryPreparationStage.ReadbackVerified;
    public bool TemporaryArtifactMayExist => TemporaryRelativePath is not null;
    public bool CanExecuteConditionalReplacement => false;
    public bool CanCommitBase => false;
}

/// <summary>
/// Consumes the actual #2109 operation boundary to create, write, fsync and read back an O_EXCL
/// private temporary. It never renames, removes, writes controls/journal or updates a base. Artifacts
/// remain named for the canonical recovery owner; there is no unsafe name-based cleanup.
/// </summary>
public sealed class LinuxVaultTemporarySourcePreparer
{
    private const int ChunkBytes = 64 * 1024;
    private readonly LinuxVaultRootPathScope _scope;

    public LinuxVaultTemporarySourcePreparer(LinuxVaultRootPathScope scope)
    {
        ArgumentNullException.ThrowIfNull(scope);
        _scope = scope;
    }

    /// <summary>Checks exact desired original bytes before any native creation; this is not accepted-result authority.</summary>
    public static ArticleVaultValidationResult ValidateDesiredBytes(ArticleVaultMaterializationInstruction instruction,
        ReadOnlySpan<byte> desiredBytes)
    {
        ArgumentNullException.ThrowIfNull(instruction);
        if (desiredBytes.Length is 0 or > ArticleVaultSnapshotAssessor.MaxSourceBytes
            || instruction.Action is not (VaultMaterializationSourceAction.Create or VaultMaterializationSourceAction.Update)
            || instruction.Schema != ArticleVaultMaterializationInstructionCodec.Schema
            || instruction.SchemaVersion != ArticleVaultMaterializationInstructionCodec.Version)
        {
            return ArticleVaultValidationResult.Invalid("vault_temporary_source_or_action_invalid");
        }

        return ArticleVaultMaterializationInstructionCodec.VerifyBytes(instruction, desiredBytes);
    }

    /// <summary>
    /// Takes accepted-source bytes separately without altering their formatting. Only a retained
    /// temporary is prepared; post-replacement reopening and metadata/base commit are still missing.
    /// Cancellation before creation propagates. Cancellation after creation returns the retained
    /// artifact's diagnostic so the operation owner can recover it without deleting another file.
    /// </summary>
    public LinuxVaultTemporarySourcePreparation Prepare(ArticleVaultMaterializationInstruction instruction,
        VaultFileMetadataObservation? expectedOldMetadata, ReadOnlySpan<byte> acceptedSourceBytes,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (acceptedSourceBytes.Length > ArticleVaultSnapshotAssessor.MaxSourceBytes)
        {
            throw new InvalidDataException("vault_temporary_source_bound_exceeded");
        }

        byte[] desired = acceptedSourceBytes.ToArray();
        string? temporaryPath = null;
        VaultFileMetadataObservation? metadata = null;
        LinuxVaultTemporaryPreparationStage stage = LinuxVaultTemporaryPreparationStage.NotCreated;
        try
        {
            ArticleVaultValidationResult validation = ValidateDesiredBytes(instruction, desired);
            if (!validation.IsValid)
            {
                return Result(validation.ReasonCode!);
            }

            using LinuxVaultMutationBoundary boundary = _scope.OpenMutationBoundary(instruction, expectedOldMetadata);
            // Preserve the planned operation-owned name even if creation fails after native O_EXCL.
            // This is a recovery diagnostic, never permission to unlink that name.
            temporaryPath = boundary.TemporaryRelativePath;
            using SafeFileHandle descriptor = boundary.CreateTemporarySource(cancellationToken);
            stage = LinuxVaultTemporaryPreparationStage.Created;
            for (int offset = 0; offset < desired.Length; offset += ChunkBytes)
            {
                cancellationToken.ThrowIfCancellationRequested();
                _scope.RevalidateForUse(descriptor);
                RandomAccess.Write(descriptor, desired.AsSpan(offset, Math.Min(ChunkBytes, desired.Length - offset)), offset);
            }

            stage = LinuxVaultTemporaryPreparationStage.BytesWritten;
            _scope.RevalidateForUse(descriptor);
            boundary.RevalidateExpectedOld(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            RandomAccess.FlushToDisk(descriptor);
            stage = LinuxVaultTemporaryPreparationStage.SourceFlushed;
            _scope.RevalidateForUse(descriptor);
            boundary.UseParentMetadata(parent =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                RandomAccess.FlushToDisk(parent);
            });
            stage = LinuxVaultTemporaryPreparationStage.DirectoryFlushed;
            LinuxVaultSnapshotNative.Observation before = LinuxVaultSnapshotNative.Observe(descriptor);
            if (before.Metadata.ByteLength != desired.Length || before.Links != 1)
            {
                return Result("vault_temporary_readback_kind_size_or_links_changed");
            }

            byte[] readback = new byte[desired.Length];
            try
            {
                int offset = 0;
                while (offset < readback.Length)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    _scope.RevalidateForUse(descriptor);
                    int count = RandomAccess.Read(descriptor,
                        readback.AsSpan(offset, Math.Min(ChunkBytes, readback.Length - offset)), offset);
                    if (count == 0)
                    {
                        return Result("vault_temporary_readback_short_read");
                    }

                    offset += count;
                }

                if (RandomAccess.Read(descriptor, new byte[1], readback.Length) != 0
                    || !desired.AsSpan().SequenceEqual(readback)
                    || !ValidateDesiredBytes(instruction, readback).IsValid
                    || before != LinuxVaultSnapshotNative.Observe(descriptor))
                {
                    return Result("vault_temporary_readback_bytes_or_metadata_changed");
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(readback);
            }

            _scope.RevalidateForUse(descriptor);
            boundary.RevalidateExpectedOld(cancellationToken);
            metadata = before.Metadata;
            stage = LinuxVaultTemporaryPreparationStage.ReadbackVerified;
            return Result("vault_temporary_prepared_conditional_commit_unavailable");
        }
        catch (OperationCanceledException) when (temporaryPath is not null)
        {
            return Result("vault_temporary_preparation_cancelled");
        }
        catch (LinuxVaultWatcherException exception)
        {
            return Result(exception.ReasonCode);
        }
        catch (UnauthorizedAccessException)
        {
            return Result("vault_temporary_preparation_permission_blocked");
        }
        catch (IOException)
        {
            return Result("vault_temporary_preparation_io_or_flush_failed");
        }
        catch (ObjectDisposedException)
        {
            return Result("vault_temporary_preparation_scope_closed");
        }
        catch (PlatformNotSupportedException)
        {
            return Result("vault_temporary_preparation_platform_unsupported");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(desired);
        }

        LinuxVaultTemporarySourcePreparation Result(string reason)
            => new(_scope.Scope, instruction, temporaryPath, stage, metadata, reason);
    }
}
