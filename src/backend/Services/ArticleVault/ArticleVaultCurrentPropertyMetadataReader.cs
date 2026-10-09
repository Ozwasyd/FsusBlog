using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>A current-read-bound pure proposal; complete metadata and execution authorities remain separate.</summary>
public sealed class ArticleVaultCurrentPropertyMetadataProposal
{
    internal ArticleVaultCurrentPropertyMetadataProposal(
        ArticleVaultPropertyMetadataCandidate candidate, ArticleVaultCurrentPropertyInput observed)
    {
        Candidate = candidate;
        Observed = observed;
    }

    public ArticleVaultPropertyMetadataCandidate Candidate
    {
        get;
    }
    public ArticleVaultCurrentPropertyInput Observed
    {
        get;
    }
    public bool SourceHold => true;
    public bool CanExecute => false;
    public bool CanCommitBase => false;
}

public sealed record ArticleVaultCurrentPropertyMetadataResult(
    ArticleVaultCurrentPropertyMetadataProposal? Proposal,
    ImmutableArray<ArticlePackageIdentity> OverlappingDefinitions,
    string? ReasonCode);

/// <summary>
/// Replaces asserted server rows/bytes with original authorized reads before invoking the sole typed
/// merge and independent verifier. Supplied base/local rows and three full V1 manifests retain their
/// original gates; this reader cannot manufacture historical facts or map distinct site namespaces.
/// </summary>
public sealed class ArticleVaultCurrentPropertyMetadataReader(ArticleVaultCurrentPropertyInputReader current)
{
    public async Task<ArticleVaultCurrentPropertyMetadataResult> ReadAndBuildAsync(
        ArticleVaultPropertyMetadataInput input,
        ArticleVaultConflictReviewContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(context);
        cancellationToken.ThrowIfCancellationRequested();
        if (input.Source?.Binding is null || input.Base?.Snapshot is null
            || input.Local?.Snapshot is null || input.Server?.Bindings is null)
        {
            return Refuse("input_missing");
        }
        ReadOnlyMemory<byte>[] metadata = [input.BaseMetadataBytes, input.LocalMetadataBytes, input.ServerMetadataBytes];
        ReadOnlyMemory<byte>[] source = [input.Source.BaseBytes, input.Source.LocalBytes, input.Source.ServerBytes];
        if (metadata.Any(static bytes => bytes.Length > ArticlePackageManifestCandidateCodec.MaxJsonBytes)
            || source.Any(static bytes => bytes.Length > ArticlePackageSourceBytes.MaximumByteLength))
        {
            return Refuse("input_byte_budget_exceeded");
        }

        // Hold byte buffers and nested original plan inputs before the first asynchronous read.
        ArticleVaultSourceAdmissionInput heldSource = ArticleVaultOperationCodec.Deserialize<ArticleVaultSourceAdmissionInput>(
            ArticleVaultOperationCodec.Serialize(input.Source));
        ArticleVaultPropertyMetadataInput held = input with
        {
            Source = heldSource,
            BaseMetadataBytes = metadata[0].ToArray(),
            LocalMetadataBytes = metadata[1].ToArray(),
            ServerMetadataBytes = metadata[2].ToArray()
        };
        foreach (ReadOnlyMemory<byte> bytes in new[] { held.BaseMetadataBytes, held.LocalMetadataBytes, held.ServerMetadataBytes })
        {
            try
            {
                _ = ArticleVaultManifestCodec.DeserializeMetadata(bytes.Span);
            }
            catch (InvalidDataException)
            {
                return Refuse("full_metadata_bytes_invalid");
            }
        }
        VaultConflictBinding binding = held.Source.Binding;
        var reference = new ArticleVaultCurrentSourceReference(binding.PlanCandidateIdentity, binding.PlanSha256,
            binding.GroupIdentity, binding.OperationIdentity);
        ArticleVaultCurrentPropertyInput before = await current.ReadAsync(reference, context,
            held.Server.Bindings, cancellationToken).ConfigureAwait(false);
        ArticleVaultPropertyMetadataInput rebound = Rebind(held, before);
        ArticleVaultPropertyMetadataResult built = ArticleVaultPropertyMetadataMerge.Build(rebound);
        if (built.Candidate is null)
        {
            return new(null, built.OverlappingDefinitions, built.ReasonCode);
        }
        ArticleVaultValidationResult verified = ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(rebound, built.Candidate);
        if (!verified.IsValid)
        {
            return new(null, [], verified.ReasonCode);
        }

        ArticleVaultCurrentPropertyInput after = await current.ReadAsync(reference, context,
            held.Server.Bindings, cancellationToken).ConfigureAwait(false);
        if (!SameCurrent(before, after))
        {
            return Refuse("current_read_changed");
        }
        verified = ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(Rebind(held, after), built.Candidate);
        cancellationToken.ThrowIfCancellationRequested();
        return verified.IsValid ? new(new(built.Candidate, after), [], null) : new(null, [], verified.ReasonCode);
    }

    private static ArticleVaultPropertyMetadataInput Rebind(
        ArticleVaultPropertyMetadataInput held, ArticleVaultCurrentPropertyInput actual)
        => held with
        {
            Source = held.Source with
            {
                ServerBytes = actual.Server.Package.RawMarkdown.ToArray()
            },
            Server = new(actual.Properties.Source.Snapshot, held.Server.Bindings)
        };

    private static bool SameCurrent(ArticleVaultCurrentPropertyInput before, ArticleVaultCurrentPropertyInput after)
        => before.Server.Package.PackageDigest == after.Server.Package.PackageDigest
            && before.Server.PermissionSnapshotSha256 == after.Server.PermissionSnapshotSha256
            && before.Server.Observations.SequenceEqual(after.Server.Observations)
            && before.Properties.Source.SnapshotId == after.Properties.Source.SnapshotId
            && before.Properties.Source.FactsetId == after.Properties.Source.FactsetId
            && before.Properties.Source.AuditReference == after.Properties.Source.AuditReference
            && before.Properties.Source.AuditChainId == after.Properties.Source.AuditChainId
            && before.Properties.Source.AuditRecordHash == after.Properties.Source.AuditRecordHash
            && before.Properties.Component.ComponentDigest == after.Properties.Component.ComponentDigest
            && before.Properties.Definitions.SequenceEqual(after.Properties.Definitions)
            && before.Properties.Reconciliation.SequenceEqual(after.Properties.Reconciliation);

    private static ArticleVaultCurrentPropertyMetadataResult Refuse(string reason)
        => new(null, [], "article_vault_current_property_metadata_" + reason);
}
