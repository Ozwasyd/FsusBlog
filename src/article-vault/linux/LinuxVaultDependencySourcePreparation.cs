using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>
/// Consumes the root owner's actual old-byte/metadata boundary for accepted dependency source.
/// Source bytes must come from the canonical accepted-source transport. This preparation does
/// not establish transport authorization, a protected lease or final replacement admission.
/// </summary>
public sealed class LinuxVaultDependencySourcePreparation : IDisposable
{
    private readonly LinuxVaultMutationBoundary _boundary;

    private LinuxVaultDependencySourcePreparation(LinuxVaultMutationBoundary boundary)
    {
        _boundary = boundary;
    }

    public ArticleVaultMaterializationInstruction Instruction => _boundary.Instruction;
    public bool CanExecuteConditionalReplacement => false;
    public bool CanCommitBase => false;

    /// <summary>
    /// Checks accepted source bytes before opening the root-bound preparation. Remove actions
    /// require no bytes; all other actions require the exact instruction's byte identity.
    /// Nothing is written, removed or renamed and no temporary artifact is created here.
    /// </summary>
    public static LinuxVaultDependencySourcePreparation Prepare(
        LinuxVaultRootPathScope root,
        ArticleVaultMaterializationInstruction instruction,
        ReadOnlySpan<byte> acceptedBytes,
        VaultFileMetadataObservation? expectedOldMetadata,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(root);
        ArgumentNullException.ThrowIfNull(instruction);
        cancellationToken.ThrowIfCancellationRequested();
        if (instruction.Action == VaultMaterializationSourceAction.Remove)
        {
            if (!acceptedBytes.IsEmpty || instruction.NewSource is not null)
            {
                throw new LinuxVaultWatcherException("linux_vault_dependency_removal_source_unexpected");
            }
        }
        else
        {
            ArticleVaultValidationResult bytes = ArticleVaultMaterializationInstructionCodec.VerifyBytes(instruction, acceptedBytes);
            if (!bytes.IsValid)
            {
                throw new LinuxVaultWatcherException(bytes.ReasonCode!);
            }
        }
        LinuxVaultMutationBoundary boundary = root.OpenMutationBoundary(instruction, expectedOldMetadata);
        try
        {
            boundary.RevalidateExpectedOld(cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            return new(boundary);
        }
        catch
        {
            boundary.Dispose();
            throw;
        }
    }

    /// <summary>Rechecks the actual root-owned old source at use; it still cannot replace or commit a base.</summary>
    public void RevalidateExpectedOld(CancellationToken cancellationToken = default)
        => _boundary.RevalidateExpectedOld(cancellationToken);

    public void Dispose() => _boundary.Dispose();
}
