using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed record AuditKeyDestructionEvidence(
    int Version,
    string TrustDomain,
    string KeyDomainHash,
    string EpochHash,
    DateTimeOffset DestroyedAtUtc,
    int RecordCount,
    string MerkleRootHash,
    string CheckpointDigest,
    string SigningKeyId,
    int SigningKeyVersion,
    string Algorithm,
    string SignatureBase64Url);

public sealed record AuditRetentionErasureResult(
    AuditDetachedCheckpointEnvelope Anchor,
    IReadOnlyList<AuditKeyDestructionEvidence> DestructionEvidence);

public sealed class AuditRetentionErasureService(
    IConfiguration configuration,
    IAuditRetentionEpochKeyStore keyStore,
    TimeProvider timeProvider)
{
    public const string EvidenceTrustDomain = "fsusblog.audit.retention-key-destruction.v1";
    private const int EvidenceVersion = 1;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<AuditRetentionErasureResult> AnchorAndDestroyKeysAsync(
        IReadOnlyList<AuditLog> rows,
        CancellationToken cancellationToken)
    {
        if (rows.Count == 0)
        {
            throw new ArgumentException("Audit retention erasure batch cannot be empty.", nameof(rows));
        }

        AuditRetentionPolicy policy = AuditRetentionCatalog.GetRequired(rows[0].Action);
        if (rows.Any(row => !StringComparer.Ordinal.Equals(row.Action, policy.Action)))
        {
            throw new InvalidOperationException("audit_retention_mixed_action_batch");
        }

        AuditDetachedCheckpointRuntimeOptions options = configuration
            .GetSection(AuditDetachedCheckpointRuntimeOptions.SectionName)
            .Get<AuditDetachedCheckpointRuntimeOptions>() ?? new AuditDetachedCheckpointRuntimeOptions();
        var configurationErrors = new List<string>();
        AuditDetachedCheckpointRuntimeConfiguration.Validate(configuration, enforceProductionRules: false, configurationErrors);
        if (!options.Enabled || configurationErrors.Count > 0)
        {
            throw new InvalidOperationException("audit_retention_checkpoint_signing_unavailable");
        }

        AuditCheckpointKeyRegistry registry = AuditDetachedCheckpointRuntimeConfiguration.LoadKeyRegistry(options);
        AuditCheckpointRecordSet recordSet = AuditCheckpointRecordSetBuilder.Build(
            rows.OrderBy(static row => row.Id),
            verifyAdjacentChainLinks: false);
        string checkpointRoot = AuditDetachedCheckpointRuntimeConfiguration.ResolveRootPath(configuration, options);
        string actionPartition = Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes(policy.Action)));
        string anchorRoot = Path.Combine(checkpointRoot, "retention-anchors", actionPartition);
        var transport = new LocalFileAuditCheckpointTransport(anchorRoot);
        IReadOnlyList<AuditDetachedCheckpointEnvelope> existing = await transport.ImportAsync(cancellationToken)
            .ConfigureAwait(false);
        var signing = new AuditCheckpointSigningService(registry);
        AuditDetachedCheckpointService.ValidateEnvelopeChain(existing, signing);
        AuditDetachedCheckpointEnvelope? previous = existing.Count == 0 ? null : existing[^1];
        var manifest = new AuditDetachedCheckpointManifest(
            AuditDetachedCheckpointConstants.ManifestVersion,
            AuditDetachedCheckpointConstants.TrustDomain,
            (previous?.Manifest.Sequence ?? 0) + 1,
            previous?.CheckpointDigest,
            recordSet.FromRecordId,
            recordSet.ToRecordId,
            recordSet.RecordCount,
            recordSet.MerkleRootHash,
            recordSet.AuditHeadHash,
            timeProvider.GetUtcNow().ToUniversalTime());
        AuditDetachedCheckpointEnvelope anchor = signing.Sign(manifest);
        await transport.ExportAsync(anchor, cancellationToken).ConfigureAwait(false);

        var evidence = new List<AuditKeyDestructionEvidence>();
        foreach (AuditRetentionEnvelope envelope in rows
                     .Select(static row => AuditRetentionPayloadProtector.TryReadEnvelope(row, out AuditRetentionEnvelope value) ? value : null)
                     .Where(static value => value is not null)
                     .Cast<AuditRetentionEnvelope>()
                     .DistinctBy(static value => string.Concat(value.KeyDomain, "\n", value.EpochId), StringComparer.Ordinal))
        {
            bool destroyed = await keyStore.DestroyAsync(envelope.KeyDomain, envelope.EpochId, cancellationToken)
                .ConfigureAwait(false);
            if (!destroyed)
            {
                throw new InvalidOperationException("audit_retention_epoch_key_missing_before_erasure");
            }

            AuditKeyDestructionEvidence item = SignEvidence(
                registry,
                envelope.KeyDomain,
                envelope.EpochId,
                anchor,
                recordSet);
            await WriteEvidenceAsync(anchorRoot, item, cancellationToken).ConfigureAwait(false);
            evidence.Add(item);
        }

        return new AuditRetentionErasureResult(anchor, evidence);
    }

    public static bool VerifyEvidence(
        AuditKeyDestructionEvidence evidence,
        AuditCheckpointKeyRegistry publicRegistry)
    {
        if (evidence.Version != EvidenceVersion
            || !StringComparer.Ordinal.Equals(evidence.TrustDomain, EvidenceTrustDomain)
            || !publicRegistry.TryGet(evidence.SigningKeyId, out AuditCheckpointKeyRecord? key)
            || key.Version != evidence.SigningKeyVersion
            || !StringComparer.Ordinal.Equals(key.Algorithm, evidence.Algorithm))
        {
            return false;
        }
        try
        {
            using ECDsa verifier = ECDsa.Create();
            verifier.ImportSubjectPublicKeyInfo(
                WebEncoders.Base64UrlDecode(key.PublicKeySubjectPublicKeyInfoBase64Url),
                out _);
            return verifier.VerifyData(
                BuildEvidenceBytes(evidence),
                WebEncoders.Base64UrlDecode(evidence.SignatureBase64Url),
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException or ArgumentException)
        {
            return false;
        }
    }

    private AuditKeyDestructionEvidence SignEvidence(
        AuditCheckpointKeyRegistry registry,
        string keyDomain,
        string epochId,
        AuditDetachedCheckpointEnvelope anchor,
        AuditCheckpointRecordSet recordSet)
    {
        if (!registry.TryGetCurrent(out AuditCheckpointKeyRecord? key)
            || string.IsNullOrWhiteSpace(key.PrivateKeyPkcs8Base64Url))
        {
            throw new InvalidOperationException("audit_retention_evidence_signing_key_missing");
        }

        var unsigned = new AuditKeyDestructionEvidence(
            EvidenceVersion,
            EvidenceTrustDomain,
            HashText(keyDomain),
            HashText(epochId),
            timeProvider.GetUtcNow().ToUniversalTime(),
            recordSet.RecordCount,
            recordSet.MerkleRootHash,
            anchor.CheckpointDigest,
            key.KeyId,
            key.Version,
            key.Algorithm,
            SignatureBase64Url: string.Empty);
        using ECDsa signer = ECDsa.Create();
        signer.ImportPkcs8PrivateKey(WebEncoders.Base64UrlDecode(key.PrivateKeyPkcs8Base64Url), out _);
        byte[] signature = signer.SignData(
            BuildEvidenceBytes(unsigned),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return unsigned with
        {
            SignatureBase64Url = WebEncoders.Base64UrlEncode(signature)
        };
    }

    private static byte[] BuildEvidenceBytes(AuditKeyDestructionEvidence evidence)
    {
        string canonical = string.Join('\n',
            EvidenceTrustDomain,
            evidence.Version.ToString(CultureInfo.InvariantCulture),
            evidence.KeyDomainHash,
            evidence.EpochHash,
            evidence.DestroyedAtUtc.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
            evidence.RecordCount.ToString(CultureInfo.InvariantCulture),
            evidence.MerkleRootHash,
            evidence.CheckpointDigest,
            evidence.SigningKeyId,
            evidence.SigningKeyVersion.ToString(CultureInfo.InvariantCulture),
            evidence.Algorithm,
            string.Empty);
        return Encoding.UTF8.GetBytes(canonical);
    }

    private static async Task WriteEvidenceAsync(
        string anchorRoot,
        AuditKeyDestructionEvidence evidence,
        CancellationToken cancellationToken)
    {
        string digest = Convert.ToHexStringLower(SHA256.HashData(BuildEvidenceBytes(evidence)));
        string path = Path.Combine(anchorRoot, $"key-destruction-{digest}.json");
        Directory.CreateDirectory(anchorRoot);
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(evidence, JsonOptions);
        await using var stream = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.Read,
            Options = FileOptions.WriteThrough
        });
        await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        stream.Flush(flushToDisk: true);
    }

    private static string HashText(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
