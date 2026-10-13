using System.Collections.Immutable;
using System.Security.Cryptography;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>Actual candidate bytes and supplied canonical inputs; neither is persisted authority.</summary>
public sealed record ArticleVaultPackageManifestSnapshot(
    ReadOnlyMemory<byte> CandidateBytes,
    ArticlePackageManifestCandidateInput Input);

/// <summary>Three explicit finite package projections alongside the original Vault metadata inputs.</summary>
public sealed record ArticleVaultPackagePropertyMetadataInput(
    ArticleVaultPropertyMetadataInput Metadata,
    ArticleVaultPackageManifestSnapshot Base,
    ArticleVaultPackageManifestSnapshot Local,
    ArticleVaultPackageManifestSnapshot Server);

/// <summary>Frozen property proposal with finite package provenance; complete metadata is absent.</summary>
public sealed class ArticleVaultPackagePropertyMetadataCandidate
{
    internal ArticleVaultPackagePropertyMetadataCandidate(ArticleVaultPropertyMetadataCandidate properties,
        ImmutableArray<string> packageSemanticDigests, string contentSha256)
    {
        Properties = properties;
        PackageSemanticDigests = packageSemanticDigests;
        ContentSha256 = contentSha256;
    }

    public ArticleVaultPropertyMetadataCandidate Properties
    {
        get;
    }
    public ImmutableArray<string> PackageSemanticDigests
    {
        get;
    }
    public string ContentSha256
    {
        get;
    }
    public bool SourceHold => true;
    public bool CanExecute => false;
    public bool CanCommitBase => false;
}

public sealed record ArticleVaultPackagePropertyMetadataResult(
    ArticleVaultPackagePropertyMetadataCandidate? Candidate,
    ImmutableArray<ArticlePackageIdentity> OverlappingDefinitions,
    string? ReasonCode);

/// <summary>
/// Binds the sole package owner's finite codec/plan to original Vault bytes and typed proposals.
/// It does not map taxonomy, slug, lifecycle, rights, archive or full portable metadata, select a
/// title/summary winner, read stores, execute an import or substitute a serialized authority grant.
/// </summary>
public static class ArticleVaultPackagePropertyMetadataBridge
{
    public const string DigestDomain = "fsusblog.article-vault.package-property-proposal.v1";

    public static ArticleVaultPackagePropertyMetadataResult Build(ArticleVaultPackagePropertyMetadataInput? input)
    {
        ArticleVaultValidationResult read = ReadCurrent(input, out var owned, out var digests);
        if (!read.IsValid)
        {
            return new(null, [], read.ReasonCode);
        }
        ArticleVaultPropertyMetadataResult properties = ArticleVaultPropertyMetadataMerge.Build(owned);
        if (properties.Candidate is null)
        {
            return new(null, properties.OverlappingDefinitions, properties.ReasonCode);
        }
        var unsealed = new ArticleVaultPackagePropertyMetadataCandidate(properties.Candidate, digests, string.Empty);
        return new(new(properties.Candidate, digests, ComputeContentSha256(unsealed)), [], null);
    }

    /// <summary>Reparses actual bytes and rebinds supplied canonical inputs before independent property verification.</summary>
    public static ArticleVaultValidationResult VerifyCurrentCandidate(ArticleVaultPackagePropertyMetadataInput? input,
        ArticleVaultPackagePropertyMetadataCandidate? candidate)
    {
        ArticleVaultValidationResult read = ReadCurrent(input, out var owned, out var digests);
        if (!read.IsValid)
        {
            return read;
        }
        if (candidate is null || candidate.PackageSemanticDigests.IsDefault
            || !candidate.PackageSemanticDigests.SequenceEqual(digests))
        {
            return Invalid("candidate_package_provenance_mismatch");
        }
        ArticleVaultValidationResult properties = ArticleVaultPropertyMetadataMerge.VerifyCurrentCandidate(owned, candidate.Properties);
        if (!properties.IsValid)
        {
            return properties;
        }
        return candidate.ContentSha256 == ComputeContentSha256(candidate)
            ? ArticleVaultValidationResult.Valid() : Invalid("candidate_digest_mismatch");
    }

    public static ArticleVaultValidationResult RequireExecutionAdmission(ArticleVaultPackagePropertyMetadataInput? input,
        ArticleVaultPackagePropertyMetadataCandidate? candidate)
    {
        ArticleVaultValidationResult validity = VerifyCurrentCandidate(input, candidate);
        return !validity.IsValid ? validity : Invalid("source_hold_and_complete_metadata_authority_missing");
    }

    public static string ComputeContentSha256(ArticleVaultPackagePropertyMetadataCandidate candidate)
        => ArticleVaultExecutionIntegrity.Digest(new
        {
            Domain = DigestDomain,
            PropertyProposal = candidate.Properties.ContentSha256,
            candidate.PackageSemanticDigests
        });

    private static ArticleVaultValidationResult ReadCurrent(ArticleVaultPackagePropertyMetadataInput? input,
        out ArticleVaultPropertyMetadataInput? owned, out ImmutableArray<string> digests)
    {
        owned = null;
        digests = [];
        if (input?.Metadata?.Source is null || input.Base?.Input is null
            || input.Local?.Input is null || input.Server?.Input is null)
        {
            return Invalid("input_missing");
        }
        ArticleVaultPropertyMetadataInput metadata = input.Metadata;
        ReadOnlyMemory<byte>[] sourceBytes = [metadata.Source.BaseBytes, metadata.Source.LocalBytes, metadata.Source.ServerBytes];
        ReadOnlyMemory<byte>[] metadataBytes = [metadata.BaseMetadataBytes, metadata.LocalMetadataBytes, metadata.ServerMetadataBytes];
        ArticleVaultPackageManifestSnapshot[] packages = [input.Base, input.Local, input.Server];
        if (sourceBytes.Any(static bytes => bytes.Length > ArticlePackageSourceBytes.MaximumByteLength)
            || metadataBytes.Any(static bytes => bytes.Length > ArticlePackageManifestCandidateCodec.MaxJsonBytes)
            || packages.Any(static slot => slot.CandidateBytes.Length > ArticlePackageManifestCandidateCodec.MaxJsonBytes))
        {
            return Invalid("input_byte_budget_exceeded");
        }
        owned = metadata with
        {
            Source = metadata.Source with
            {
                BaseBytes = sourceBytes[0].ToArray(),
                LocalBytes = sourceBytes[1].ToArray(),
                ServerBytes = sourceBytes[2].ToArray()
            },
            BaseMetadataBytes = metadataBytes[0].ToArray(),
            LocalMetadataBytes = metadataBytes[1].ToArray(),
            ServerMetadataBytes = metadataBytes[2].ToArray()
        };
        ArticleVaultSourceAdmissionResult source = ArticleVaultAdmittedSource.AdmitCurrent(owned.Source);
        if (source.Source is null)
        {
            return ArticleVaultValidationResult.Invalid(source.ReasonCode!);
        }
        sourceBytes = [owned.Source.BaseBytes, owned.Source.LocalBytes, owned.Source.ServerBytes];
        metadataBytes = [owned.BaseMetadataBytes, owned.LocalMetadataBytes, owned.ServerMetadataBytes];
        ArticleVaultPropertySnapshotInput[] typed = [owned.Base, owned.Local, owned.Server];
        var manifestDigests = ImmutableArray.CreateBuilder<string>(3);
        string? slug = null;
        for (int index = 0; index < packages.Length; index++)
        {
            ArticlePackageManifestCandidateResult parsed = ArticlePackageManifestCandidateCodec.TryParseCandidate(
                packages[index].CandidateBytes.Span, out var manifest);
            if (!parsed.IsValid || manifest is null)
            {
                return ArticleVaultValidationResult.Invalid(parsed.ReasonCode!);
            }
            if (manifest.Articles.Count != 1)
            {
                return Invalid("manifest_scope_invalid");
            }
            ArticlePackageManifestCandidateResult bound = ArticlePackageManifestCandidatePlanner.TryBindCandidatePlan(
                manifest, [packages[index].Input], out var plan);
            if (!bound.IsValid || plan is null)
            {
                return ArticleVaultValidationResult.Invalid(bound.ReasonCode!);
            }
            ArticleVaultMetadataManifest current;
            try
            {
                current = ArticleVaultManifestCodec.DeserializeMetadata(metadataBytes[index].Span);
            }
            catch (InvalidDataException)
            {
                return Invalid("metadata_bytes_invalid");
            }
            if (typed[index]?.Snapshot is null)
            {
                return Invalid("input_missing");
            }
            ArticlePackageManifestPlannedArticle projected = plan.Articles[0];
            if (projected.Manifest.PortableArticle.Value != source.Source.Binding.PortableArticleIdentity
                || projected.Manifest.Source.SiteScope != source.Source.Binding.SiteIdentity
                || projected.Manifest.Source.ArticleId != typed[index].Snapshot.Coordinates.ArticleId
                || projected.Manifest.Source.ArticleRevisionId != typed[index].Snapshot.Coordinates.ArticleRevisionId
                || projected.TitleSummary.Title != current.Title || projected.TitleSummary.Summary != current.Summary)
            {
                return Invalid("projection_binding_drift");
            }
            // The finite package schema carries no slug projection; a changed slug cannot hide
            // behind this property's proposal or a canonical source hash.
            if (index > 0 && current.Slug != slug)
            {
                return Invalid("slug_mapping_unavailable");
            }
            slug = current.Slug;
            ArticlePackagePropertyMappingResult mapping = ArticlePackagePropertyMapper.ValidateCandidate(
                typed[index].Snapshot, typed[index].Bindings, projected.Properties);
            if (!mapping.IsValid)
            {
                return ArticleVaultValidationResult.Invalid(mapping.ReasonCode!);
            }
            byte[] raw = projected.CopySourceBytes();
            try
            {
                if (!raw.AsSpan().SequenceEqual(sourceBytes[index].Span))
                {
                    return Invalid("source_bytes_drift");
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(raw);
            }
            manifestDigests.Add(manifest.SemanticDigest);
        }
        digests = manifestDigests.ToImmutable();
        return ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid($"article_vault_package_property_{reason}");
}
