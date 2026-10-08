using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultRecoveryBackupProtectionAuthorityTests
{
    private const long Now = 1_800_000_000_000;
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task ActualAeadVerifier_ReadsOnlyExactExistingDomainKeyAndClearsReturnedKey()
    {
        Fixture fixture = Create();
        await fixture.Authority.VerifyAsync(fixture.Receipt, fixture.Envelope);
        Assert.Equal((ArticleVaultRecoveryBackupEnvelope.KeyDomain, "controlled-existing-key"), Assert.Single(fixture.Keys.Reads));
        Assert.NotNull(fixture.Keys.ReturnedKey);
        Assert.All(fixture.Keys.ReturnedKey!, value => Assert.Equal(0, value));
        Assert.Equal(0, fixture.Keys.Writes);
    }

    [Fact]
    public async Task AuthenticatedEnvelopeWithWrongPlaintextDeclaration_RefusesAfterActualDecryption()
    {
        Fixture fixture = Create(wrongPlaintextHash: true);
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            fixture.Authority.VerifyAsync(fixture.Receipt, fixture.Envelope));
        Assert.Equal("article_vault_recovery_protection_plaintext_identity_drift", error.ReasonCode);
        Assert.All(fixture.Keys.ReturnedKey!, value => Assert.Equal(0, value));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    [InlineData(9)]
    [InlineData(10)]
    [InlineData(11)]
    public async Task CallerResealedCiphertextOrScope_DoesNotGrantAuthentication(int mutation)
    {
        Fixture fixture = Create();
        ArticleVaultRecoveryBackupReceipt receipt = fixture.Receipt;
        byte[] bytes = fixture.Envelope.ToArray();
        switch (mutation)
        {
            case 0:
                bytes[ArticleVaultRecoveryBackupEnvelope.CiphertextOffset] ^= 1;
                break;
            case 1:
                bytes[ArticleVaultRecoveryBackupEnvelope.NonceOffset] ^= 1;
                break;
            case 2:
                bytes[ArticleVaultRecoveryBackupEnvelope.TagOffset] ^= 1;
                break;
            case 3:
                receipt = receipt with
                {
                    Binding = receipt.Binding with
                    {
                        SiteIdentity = "other-site"
                    }
                };
                break;
            case 4:
                receipt = receipt with
                {
                    Policy = receipt.Policy with
                    {
                        DeleteAfterUnixMs = Now + 900
                    }
                };
                break;
            case 5:
                receipt = receipt with
                {
                    PlaintextSha256 = Digest
                };
                break;
            case 6:
                receipt = receipt with
                {
                    ProtectionKey = receipt.ProtectionKey with
                    {
                        ContentSha256 = Digest
                    }
                };
                break;
            case 7:
                receipt = receipt with
                {
                    ProtectionKey = receipt.ProtectionKey with
                    {
                        Identity = "other-key"
                    }
                };
                break;
            case 8:
                receipt = receipt with
                {
                    Binding = receipt.Binding with
                    {
                        NativeSnapshot = new("other-snapshot", Digest)
                    }
                };
                break;
            case 9:
                bytes = bytes[..^1];
                break;
            case 10:
                bytes[0] ^= 1;
                break;
            case 11:
                bytes = [.. bytes, 0];
                break;
        }
        // Recompute caller-controllable digest fields. Only actual AEAD/key/plaintext checks
        // can reject a syntactically valid resealed substitution.
        receipt = Seal(receipt with
        {
            CiphertextBytes = bytes.Length,
            CiphertextSha256 = ArticleVaultManifestCodec.ComputeSha256(bytes)
        });
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Authority.VerifyAsync(receipt, bytes));
        Assert.Equal(0, fixture.Keys.Writes);
        if (fixture.Keys.ReturnedKey is not null)
        {
            Assert.All(fixture.Keys.ReturnedKey, value => Assert.Equal(0, value));
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public async Task MissingInvalidOrUnavailableKey_RefusesWithoutSecretDetails(int failure)
    {
        Fixture fixture = Create();
        fixture.Keys.Failure = failure + 1;
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            fixture.Authority.VerifyAsync(fixture.Receipt, fixture.Envelope));
        Assert.Equal("article_vault_recovery_protection_key_unavailable", error.ReasonCode);
        Assert.DoesNotContain("private-path", error.Message, StringComparison.Ordinal);
        Assert.Equal(0, fixture.Keys.Writes);
        if (fixture.Keys.ReturnedKey is not null)
        {
            Assert.All(fixture.Keys.ReturnedKey, value => Assert.Equal(0, value));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExpiredOrFutureBackup_RefusesBeforeKeyRead(bool future)
    {
        Fixture fixture = Create();
        fixture.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(future ? Now - 1 : Now + 1_000);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Authority.VerifyAsync(fixture.Receipt, fixture.Envelope));
        Assert.Empty(fixture.Keys.Reads);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExpiryOrCancellationDuringActualKeyRead_RefusesAndClearsKey(bool cancel)
    {
        Fixture fixture = Create();
        using var cancellation = new CancellationTokenSource();
        fixture.Keys.AfterRead = () =>
        {
            if (cancel)
            {
                cancellation.Cancel();
            }
            else
            {
                fixture.Clock.Now = DateTimeOffset.FromUnixTimeMilliseconds(Now + 1_000);
            }
        };
        if (cancel)
        {
            await Assert.ThrowsAsync<OperationCanceledException>(() => fixture.Authority.VerifyAsync(fixture.Receipt,
                fixture.Envelope, cancellation.Token));
        }
        else
        {
            await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Authority.VerifyAsync(fixture.Receipt, fixture.Envelope));
        }
        Assert.All(fixture.Keys.ReturnedKey!, value => Assert.Equal(0, value));
        Assert.Equal(0, fixture.Keys.Writes);
    }

    [Fact]
    public void CompiledAuthority_HasNoKeyCreationFallbackOrWriter()
    {
        Type owner = typeof(ArticleVaultRecoveryBackupProtectionAuthority);
        RuntimeMetadataInspection.RuntimeMemberSite[] references = new[] { owner }
            .Concat(owner.GetNestedTypes(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic))
            .SelectMany(static type => RuntimeMetadataInspection.ReadMemberSites(type)).ToArray();
        Assert.Contains(references, static site => site.Member.DeclaringType == typeof(IAuditRetentionEpochKeyStore)
            && site.Member.Name == nameof(IAuditRetentionEpochKeyStore.TryReadAsync));
        Assert.Contains(references, static site => site.Member.DeclaringType == typeof(AesGcm) && site.Member.Name == nameof(AesGcm.Decrypt));
        Assert.DoesNotContain(references, static site =>
        {
            Type? declaring = site.Member as Type ?? site.Member.DeclaringType;
            string name = declaring?.FullName ?? string.Empty;
            return name.StartsWith("System.IO.", StringComparison.Ordinal) && !typeof(Exception).IsAssignableFrom(declaring!)
                || name.StartsWith("System.Net.", StringComparison.Ordinal)
                || name.Contains("DataProtection", StringComparison.Ordinal)
                || site.Member.Name is "CreateAsync" or "DestroyAsync" or "AppendAsync" or "StageAsync" or "Encrypt";
        });
    }

    private static Fixture Create(bool wrongPlaintextHash = false)
    {
        // Fixed public algorithm fixture bytes only. No existing secret/key is read, created,
        // provisioned or registered. This verifies the actual cryptographic provider over a
        // controlled key read, not production custody, native capture or execution admission.
        byte[] key = Enumerable.Range(0, 32).Select(static value => (byte)value).ToArray();
        byte[] plaintext = "controlled private backup\n"u8.ToArray();
        byte[] envelope = new byte[ArticleVaultRecoveryBackupEnvelope.CiphertextOffset + plaintext.Length];
        ArticleVaultRecoveryBackupEnvelope.Magic.CopyTo(envelope);
        Enumerable.Range(0, 12).Select(static value => (byte)value).ToArray().CopyTo(envelope, ArticleVaultRecoveryBackupEnvelope.NonceOffset);
        var reference = new VaultRecoveryReference("controlled-ref", Digest);
        ArticleVaultRecoveryBackupReceipt receipt = new(ArticleVaultRecoveryStorageVerifier.BackupSchema, 1, "controlled-backup",
            new(reference, reference, reference, reference, "site-one", "vault-one", "device-one", "article-one", Digest, Digest, reference),
            new(1024, Now + 1_000, true, "private-source", "owned-encrypted-backup-expiry-v1"), Now, plaintext.Length,
            wrongPlaintextHash ? Digest : ArticleVaultManifestCodec.ComputeSha256(plaintext), envelope.Length, Digest, ArticleVaultRecoveryBackupEnvelope.KeyDomain,
            new("controlled-existing-key", ArticleVaultManifestCodec.ComputeSha256(key)), string.Empty);
        receipt = Seal(receipt);
        using (var aes = new AesGcm(key, ArticleVaultRecoveryBackupEnvelope.TagBytes))
        {
            aes.Encrypt(envelope.AsSpan(ArticleVaultRecoveryBackupEnvelope.NonceOffset, ArticleVaultRecoveryBackupEnvelope.NonceBytes), plaintext,
                envelope.AsSpan(ArticleVaultRecoveryBackupEnvelope.CiphertextOffset),
                envelope.AsSpan(ArticleVaultRecoveryBackupEnvelope.TagOffset, ArticleVaultRecoveryBackupEnvelope.TagBytes),
                ArticleVaultRecoveryBackupEnvelope.BuildAssociatedData(receipt));
        }
        receipt = Seal(receipt with
        {
            CiphertextSha256 = ArticleVaultManifestCodec.ComputeSha256(envelope)
        });
        var keys = new DiagnosticExistingKeyStore(key);
        var clock = new DiagnosticClock(DateTimeOffset.FromUnixTimeMilliseconds(Now));
        return new(receipt, envelope, keys, clock, new(keys, clock));
    }

    private static ArticleVaultRecoveryBackupReceipt Seal(ArticleVaultRecoveryBackupReceipt receipt)
        => receipt with
        {
            ContentSha256 = ArticleVaultRecoveryStorageVerifier.ComputeContentSha256(receipt)
        };

    private sealed record Fixture(ArticleVaultRecoveryBackupReceipt Receipt, byte[] Envelope,
        DiagnosticExistingKeyStore Keys, DiagnosticClock Clock, ArticleVaultRecoveryBackupProtectionAuthority Authority);

    private sealed class DiagnosticClock(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class DiagnosticExistingKeyStore(byte[] key) : IAuditRetentionEpochKeyStore
    {
        public List<(string Domain, string Identity)> Reads { get; } = [];
        public int Writes
        {
            get; private set;
        }
        public int Failure
        {
            get; set;
        }
        public byte[]? ReturnedKey
        {
            get; private set;
        }
        public Action? AfterRead
        {
            get; set;
        }

        public ValueTask<byte[]?> TryReadAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Reads.Add((keyDomain, epochId));
            if (Failure == 3)
            {
                throw new IOException("private-path must not escape");
            }
            ReturnedKey = Failure == 1 || epochId != "controlled-existing-key" ? null : Failure == 2 ? new byte[16] : key.ToArray();
            AfterRead?.Invoke();
            return ValueTask.FromResult(ReturnedKey);
        }

        public ValueTask<byte[]> CreateAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
        {
            Writes++;
            throw new InvalidOperationException("fixture forbids key creation");
        }

        public ValueTask<bool> DestroyAsync(string keyDomain, string epochId, CancellationToken cancellationToken)
        {
            Writes++;
            throw new InvalidOperationException("fixture forbids key destruction");
        }
    }
}
