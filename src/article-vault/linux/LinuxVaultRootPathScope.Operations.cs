using System.Security.Cryptography;

using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Linux;

public sealed partial class LinuxVaultRootPathScope
{
    /// <summary>
    /// Opens an actual root-relative directory read-only, including previously unknown source
    /// directories. The caller enumerates through this issued descriptor and revalidates at use.
    /// Control-tree discovery is excluded; discovered names are not admitted article identities.
    /// </summary>
    public SafeFileHandle OpenDirectoryForEnumeration(string relativeDirectoryPath)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            RevalidateRoot();
            VerifyEnumerationPath(relativeDirectoryPath);
            RequireDescriptorCapacity();
            SafeFileHandle descriptor = LinuxVaultPathNative.OpenRelative(_rootDescriptor,
                relativeDirectoryPath, directory: true, directoryMetadataProbe: true);
            try
            {
                _issued.Add(descriptor, new(relativeDirectoryPath, relativeDirectoryPath, true,
                    LinuxVaultPathNative.Identify(descriptor), Enumeration: true));
                RevalidateForUse(descriptor);
                return descriptor;
            }
            catch
            {
                _issued.Remove(descriptor);
                descriptor.Dispose();
                throw;
            }
        }
    }

    /// <summary>
    /// Binds an operation to one registered source leaf and actual old-byte/metadata guards. This
    /// boundary can create a private new temporary file; it cannot conditionally replace/remove
    /// a source, prove external-writer exclusion, admit metadata or commit a synchronized base.
    /// </summary>
    public LinuxVaultMutationBoundary OpenMutationBoundary(
        ArticleVaultMaterializationInstruction instruction,
        VaultFileMetadataObservation? expectedOldMetadata)
    {
        ArgumentNullException.ThrowIfNull(instruction);
        lock (_gate)
        {
            ThrowIfDisposed();
            RequireInstructionBinding(instruction);
            SafeFileHandle parent = OpenOwnedParentMetadata(instruction.PathProjection.RelativePath);
            var boundary = new LinuxVaultMutationBoundary(this, instruction, expectedOldMetadata, parent);
            try
            {
                if (!ArticleVaultPathStructureValidator.ValidateRelativePath(boundary.TemporaryRelativePath).IsValid)
                {
                    throw new LinuxVaultWatcherException("linux_vault_mutation_temporary_path_invalid");
                }

                boundary.RevalidateExpectedOld();
                return boundary;
            }
            catch
            {
                boundary.Dispose();
                throw;
            }
        }
    }

    internal SafeFileHandle CreateOperationTemporary(LinuxVaultMutationBoundary boundary, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            cancellationToken.ThrowIfCancellationRequested();
            RequireInstructionBinding(boundary.Instruction);
            boundary.RevalidateExpectedOld(cancellationToken);
            RevalidateForUse(boundary.ParentDescriptor);
            RequireDescriptorCapacity(required: 2);
            SafeFileHandle descriptor = LinuxVaultPathNative.CreateTemporary(boundary.ParentDescriptor,
                boundary.TemporaryLeaf);
            try
            {
                _issued.Add(descriptor, new(boundary.Instruction.PathProjection.RelativePath,
                    boundary.TemporaryRelativePath, false, LinuxVaultPathNative.Identify(descriptor)));
                RevalidateForUse(descriptor);
                boundary.RevalidateExpectedOld(cancellationToken);
                return descriptor;
            }
            catch
            {
                _issued.Remove(descriptor);
                descriptor.Dispose();
                // Never unlink by a possibly replaced name. Preserve the exact temporary path
                // for the canonical operation/recovery owner if creation became uncertain.
                throw;
            }
        }
    }

    internal void RevalidateOperationOld(LinuxVaultMutationBoundary boundary, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ThrowIfDisposed();
            cancellationToken.ThrowIfCancellationRequested();
            RequireInstructionBinding(boundary.Instruction);
            RevalidateForUse(boundary.ParentDescriptor);
            SafeFileHandle source;
            try
            {
                source = OpenSourceFile(boundary.Instruction.PathProjection.RelativePath);
            }
            catch (LinuxVaultWatcherException exception) when (
                exception.ReasonCode == "linux_vault_descriptor_path_missing"
                && boundary.Instruction.ExpectedOldSource is null && boundary.ExpectedOldMetadata is null)
            {
                return;
            }

            using (source)
            {
                if (boundary.Instruction.ExpectedOldSource is not { } expected || boundary.ExpectedOldMetadata is null)
                {
                    throw new LinuxVaultWatcherException("linux_vault_mutation_expected_old_missing");
                }

                LinuxVaultPathNative.SourceState before = LinuxVaultPathNative.ObserveSource(source);
                if (before.Metadata != boundary.ExpectedOldMetadata || before.Metadata.ByteLength != expected.ByteLength)
                {
                    throw new LinuxVaultWatcherException("linux_vault_mutation_old_metadata_changed");
                }

                byte[] bytes = new byte[checked((int)before.Metadata.ByteLength)];
                try
                {
                    int offset = 0;
                    while (offset < bytes.Length)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        RevalidateForUse(source);
                        int count = RandomAccess.Read(source, bytes.AsSpan(offset, Math.Min(65536, bytes.Length - offset)), offset);
                        if (count == 0)
                        {
                            throw new LinuxVaultWatcherException("linux_vault_mutation_old_source_short_read");
                        }

                        offset += count;
                    }

                    if (RandomAccess.Read(source, new byte[1], bytes.Length) != 0
                        || before != LinuxVaultPathNative.ObserveSource(source)
                        || !ArticleVaultManifestValidator.ValidateSourceBytes(expected, bytes).IsValid)
                    {
                        throw new LinuxVaultWatcherException("linux_vault_mutation_old_bytes_or_metadata_changed");
                    }

                    RevalidateForUse(source);
                    RevalidateForUse(boundary.ParentDescriptor);
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(bytes);
                }
            }
        }
    }

    private void RequireInstructionBinding(ArticleVaultMaterializationInstruction instruction)
    {
        if (instruction.Schema != ArticleVaultMaterializationInstructionCodec.Schema
            || instruction.SchemaVersion != ArticleVaultMaterializationInstructionCodec.Version
            || instruction.PathProjection is null || !Enum.IsDefined(instruction.Action)
            || instruction.ContentSha256 != ArticleVaultMaterializationInstructionCodec.ComputeContentSha256(instruction)
            || instruction.SiteIdentity != Scope.SiteIdentity || instruction.VaultIdentity != Scope.VaultIdentity
            || instruction.DeviceIdentity != Scope.DeviceIdentity || instruction.AgentIdentity != Scope.AgentIdentity
            || instruction.RootManifestSha256 != Scope.RootManifestSha256
            || !IsOperationIdentity(instruction.OperationIdentity)
            || !IsOperationIdentity(instruction.GroupIdentity)
            || !IsOperationIdentity(instruction.JournalIdentity)
            || !ArticleVaultAgentProtocol.IsDigest(instruction.PlanSha256)
            || !ArticleVaultAgentProtocol.IsDigest(instruction.ServerResultSha256)
            || !ArticleVaultAgentProtocol.IsDigest(instruction.BaseBeforeSha256)
            || string.IsNullOrWhiteSpace(instruction.PlanReference) || instruction.PlanReference.Length > 1024
            || string.IsNullOrWhiteSpace(instruction.ServerResultReference) || instruction.ServerResultReference.Length > 1024)
        {
            throw new LinuxVaultWatcherException("linux_vault_mutation_instruction_binding_invalid");
        }

        VaultPathStructuralAnalysis path = ArticleVaultPathStructureValidator.Analyze(_root.Manifest, Scope,
            instruction.PathProjection.RelativePath, []);
        if (path.Classification != VaultPathStructuralClass.ManifestSourceProjection
            || path.PortableArticleIdentity != instruction.PortableArticleIdentity
            || instruction.PathProjection.ProjectionSha256 != ArticleVaultManifestCodec.ComputeProjectionSha256(path.RelativePath)
            || (instruction.Action switch
            {
                VaultMaterializationSourceAction.Create => instruction.ExpectedOldSource is not null || instruction.NewSource is null,
                VaultMaterializationSourceAction.Update => instruction.ExpectedOldSource is null || instruction.NewSource is null
                    || instruction.ExpectedOldSource == instruction.NewSource,
                VaultMaterializationSourceAction.Remove => instruction.ExpectedOldSource is null || instruction.NewSource is not null,
                VaultMaterializationSourceAction.VerifyUnchanged => instruction.ExpectedOldSource != instruction.NewSource,
                _ => true
            }))
        {
            throw new LinuxVaultWatcherException("linux_vault_mutation_source_or_action_invalid");
        }
    }

    // Reuse the original public scope validator's opaque identity syntax. This checks shape only;
    // it neither maps an operation to an agent nor constructs another native scope.
    private bool IsOperationIdentity(string identity)
        => ArticleVaultPathStructureValidator.ValidateScope(_root.Manifest,
            Scope with
            {
                AgentIdentity = identity
            }).IsValid;

    private void VerifyEnumerationPath(string relativeDirectoryPath)
    {
        if (relativeDirectoryPath != ".")
        {
            if (!ArticleVaultPathStructureValidator.ValidateRelativePath(relativeDirectoryPath).IsValid
                || relativeDirectoryPath.Split('/')[0].Equals(".fsus", StringComparison.OrdinalIgnoreCase))
            {
                throw new LinuxVaultWatcherException("linux_vault_enumeration_directory_invalid");
            }

            VerifyPath(relativeDirectoryPath);
            VerifyDirectorySemantics(relativeDirectoryPath + "/probe");
        }

        LinuxVaultPathNative.RequireOrdinalDirectorySemantics(_rootDescriptor, relativeDirectoryPath);
    }

    private void RequireDescriptorCapacity(int required = 1)
    {
        foreach (SafeFileHandle closed in _issued.Keys.Where(static handle => handle.IsClosed).ToArray())
        {
            _issued.Remove(closed);
        }

        if (_issued.Count > MaximumIssuedDescriptors - required)
        {
            throw new LinuxVaultWatcherException("linux_vault_descriptor_limit_exceeded");
        }
    }
}

/// <summary>
/// Process-owned namespace preparation. A valid sealed instruction is not accepted-result,
/// protected-lease, complete-metadata or external-writer-exclusion authority. No final replacement
/// API is provided until the native owner can satisfy those conditions without a check/write race.
/// </summary>
public sealed class LinuxVaultMutationBoundary : IDisposable
{
    private readonly LinuxVaultRootPathScope _scope;
    private readonly object _gate = new();
    private SafeFileHandle? _temporary;
    private bool _disposed;

    internal LinuxVaultMutationBoundary(LinuxVaultRootPathScope scope,
        ArticleVaultMaterializationInstruction instruction, VaultFileMetadataObservation? expectedOldMetadata,
        SafeFileHandle parentDescriptor)
    {
        _scope = scope;
        Instruction = instruction;
        ExpectedOldMetadata = expectedOldMetadata;
        ParentDescriptor = parentDescriptor;
        string nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        TemporaryLeaf = $".fsus-operation-{instruction.ContentSha256}-{nonce}.tmp";
        int separator = instruction.PathProjection.RelativePath.LastIndexOf('/');
        TemporaryRelativePath = separator < 0 ? TemporaryLeaf
            : instruction.PathProjection.RelativePath[..(separator + 1)] + TemporaryLeaf;
    }

    public ArticleVaultMaterializationInstruction Instruction
    {
        get;
    }
    public string TemporaryRelativePath
    {
        get;
    }
    public bool CanExecuteConditionalReplacement => false;
    public bool CanCommitBase => false;
    public bool RequiresExternalWriterExclusion => true;
    internal VaultFileMetadataObservation? ExpectedOldMetadata
    {
        get;
    }
    internal SafeFileHandle ParentDescriptor
    {
        get;
    }
    internal string TemporaryLeaf
    {
        get;
    }

    /// <summary>
    /// Creates exactly one new O_EXCL private temporary file relative to the owned source parent,
    /// after actual old-byte/metadata checks. The content writer owns the returned body descriptor.
    /// Failed/interrupted creations retain their named artifact; disposal never deletes by name.
    /// </summary>
    public SafeFileHandle CreateTemporarySource(CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_temporary is not null)
            {
                throw new LinuxVaultWatcherException("linux_vault_mutation_temporary_already_created");
            }

            if (Instruction.Action is not (VaultMaterializationSourceAction.Create or VaultMaterializationSourceAction.Update))
            {
                throw new LinuxVaultWatcherException("linux_vault_mutation_temporary_action_invalid");
            }

            _temporary = _scope.CreateOperationTemporary(this, cancellationToken);
            return _temporary;
        }
    }

    /// <summary>Matches actual current old bytes and descriptor metadata; this is not an atomic replace grant.</summary>
    public void RevalidateExpectedOld(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _scope.RevalidateOperationOld(this, cancellationToken);
    }

    /// <summary>Provides only the scoped metadata directory handle for the native owner's flush syscall.</summary>
    public void UseParentMetadata(Action<SafeFileHandle> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _scope.RevalidateForUse(ParentDescriptor);
            operation(ParentDescriptor);
            _scope.RevalidateForUse(ParentDescriptor);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            _temporary?.Dispose();
            ParentDescriptor.Dispose();
        }
    }
}
