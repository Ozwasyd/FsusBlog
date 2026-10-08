namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// Closed private at-rest AES-256-GCM layout: version magic, 12-byte nonce, 16-byte tag,
/// then ciphertext of exactly the declared plaintext length. This is not a transport or native grant.
/// The authorized snapshot owner supplies a fresh nonce and an existing independent recovery key.
/// </summary>
public static class ArticleVaultRecoveryBackupEnvelope
{
    public const string KeyDomain = "article-vault-recovery";
    public const int NonceOffset = 8;
    public const int NonceBytes = 12;
    public const int TagOffset = NonceOffset + NonceBytes;
    public const int TagBytes = 16;
    public const int CiphertextOffset = TagOffset + TagBytes;
    public static ReadOnlySpan<byte> Magic => "FSAVRB01"u8;

    /// <summary>Checks the one bounded layout before a key read or plaintext allocation.</summary>
    public static ArticleVaultValidationResult Validate(
        ArticleVaultRecoveryBackupReceipt receipt, ReadOnlySpan<byte> envelope)
    {
        ArticleVaultValidationResult structure = ArticleVaultRecoveryStorageVerifier.ValidateBackup(receipt);
        if (!structure.IsValid)
        {
            return structure;
        }
        return receipt.CiphertextBytes == receipt.PlaintextBytes + CiphertextOffset
            && envelope.Length == receipt.CiphertextBytes
            && envelope[..NonceOffset].SequenceEqual(Magic)
            && ArticleVaultManifestCodec.ComputeSha256(envelope) == receipt.CiphertextSha256
                ? ArticleVaultValidationResult.Valid()
                : ArticleVaultValidationResult.Invalid("article_vault_recovery_protection_envelope_invalid");
    }

    /// <summary>
    /// Authenticates all frozen scope, policy, key and plaintext fields. Ciphertext/self hashes are
    /// excluded to avoid a circular tag/hash dependency; envelope hash and receipt seal are checked separately.
    /// ProtectionKey.ContentSha256 names the exact 32-byte key returned by the canonical key store.
    /// </summary>
    public static byte[] BuildAssociatedData(ArticleVaultRecoveryBackupReceipt receipt)
    {
        ArticleVaultValidationResult structure = ArticleVaultRecoveryStorageVerifier.ValidateBackup(receipt);
        if (!structure.IsValid)
        {
            throw new InvalidDataException(structure.ReasonCode);
        }
        return ArticleVaultManifestCodec.SerializeCanonical(new
        {
            Domain = "fsusblog.article-vault.recovery-backup-aead.v1",
            receipt.Schema,
            receipt.SchemaVersion,
            receipt.BackupIdentity,
            receipt.Binding,
            receipt.Policy,
            receipt.CreatedAtUnixMs,
            receipt.PlaintextBytes,
            receipt.PlaintextSha256,
            receipt.CiphertextBytes,
            receipt.ProtectionDomainIdentity,
            receipt.ProtectionKey
        });
    }
}
