using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Authenticates recovery bytes with the application's existing independent-domain key facility.
/// Reads only the exact existing recovery key; never creates, derives, rotates or destroys a key.
/// Success proves AEAD/plaintext identity only, not snapshot origin, authorization or native recovery.
/// Trusted composition and the snapshot/key lifecycle owners remain responsible for custody and expiry.
/// </summary>
public sealed class ArticleVaultRecoveryBackupProtectionAuthority(
    IAuditRetentionEpochKeyStore keyStore, TimeProvider timeProvider) : IArticleVaultRecoveryBackupProtectionAuthority
{
    public async Task VerifyAsync(ArticleVaultRecoveryBackupReceipt receipt, ReadOnlyMemory<byte> ciphertext,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Require(ArticleVaultRecoveryBackupEnvelope.Validate(receipt, ciphertext.Span));
        RequireLive(receipt);
        byte[] envelope = ciphertext.ToArray();
        Require(ArticleVaultRecoveryBackupEnvelope.Validate(receipt, envelope));
        byte[]? key = null;
        byte[]? plaintext = null;
        try
        {
            // This is the same canonical read capability used by other independent delivery domains.
            // There is no missing-key fallback and no path/configuration supplied by the receipt.
            try
            {
                key = await keyStore.TryReadAsync(ArticleVaultRecoveryBackupEnvelope.KeyDomain,
                    receipt.ProtectionKey.Identity, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception)
            {
                // Canonical key-provider failures release neither physical paths nor secret details.
                throw Rejected("key_unavailable");
            }
            cancellationToken.ThrowIfCancellationRequested();
            RequireLive(receipt);
            if (key is null || key.Length != 32)
            {
                throw Rejected("key_unavailable");
            }
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(key),
                Convert.FromHexString(receipt.ProtectionKey.ContentSha256)))
            {
                throw Rejected("key_identity_drift");
            }

            plaintext = new byte[checked((int)receipt.PlaintextBytes)];
            byte[] associatedData = ArticleVaultRecoveryBackupEnvelope.BuildAssociatedData(receipt);
            using var aes = new AesGcm(key, ArticleVaultRecoveryBackupEnvelope.TagBytes);
            aes.Decrypt(envelope.AsSpan(ArticleVaultRecoveryBackupEnvelope.NonceOffset, ArticleVaultRecoveryBackupEnvelope.NonceBytes),
                envelope.AsSpan(ArticleVaultRecoveryBackupEnvelope.CiphertextOffset),
                envelope.AsSpan(ArticleVaultRecoveryBackupEnvelope.TagOffset, ArticleVaultRecoveryBackupEnvelope.TagBytes),
                plaintext, associatedData);
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(plaintext),
                Convert.FromHexString(receipt.PlaintextSha256)))
            {
                throw Rejected("plaintext_identity_drift");
            }
            cancellationToken.ThrowIfCancellationRequested();
            RequireLive(receipt);
        }
        catch (CryptographicException)
        {
            throw Rejected("authentication_failed");
        }
        finally
        {
            if (key is not null)
            {
                CryptographicOperations.ZeroMemory(key);
            }
            if (plaintext is not null)
            {
                CryptographicOperations.ZeroMemory(plaintext);
            }
        }
    }

    private void RequireLive(ArticleVaultRecoveryBackupReceipt receipt)
    {
        long now = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (receipt.CreatedAtUnixMs > now || receipt.Policy.DeleteAfterUnixMs <= now)
        {
            throw Rejected("expired_or_future");
        }
    }

    private static void Require(ArticleVaultValidationResult result)
    {
        if (!result.IsValid)
        {
            throw new ArticleVaultExecutionRejectedException(result.ReasonCode!);
        }
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason)
        => new("article_vault_recovery_protection_" + reason);
}
