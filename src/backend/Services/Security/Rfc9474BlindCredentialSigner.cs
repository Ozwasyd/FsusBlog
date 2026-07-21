using System.Security.Cryptography;

using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Validation;

using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Engines;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Math;
using Org.BouncyCastle.Security;

namespace FsusBlog.Server.Services.Security;

/// <summary>
/// The only private-key operation permitted for current anonymous credential issuance.
/// The client performs RFC 9474 Prepare/Blind/Finalize; this boundary only performs
/// BlindSign on a fixed-width RSA representative.
/// </summary>
public interface IRfc9474BlindCredentialSigner
{
    bool IsConfigured
    {
        get;
    }
    string KeyId
    {
        get;
    }
    string PublicKeyHash
    {
        get;
    }
    byte[] SubjectPublicKeyInfo
    {
        get;
    }
    int ModulusBytes
    {
        get;
    }

    ValueTask<Result<byte[]>> BlindSignAsync(
        ReadOnlyMemory<byte> blindedMessage,
        CancellationToken cancellationToken = default);
}

public sealed class UnavailableRfc9474BlindCredentialSigner(IConfiguration configuration)
    : IRfc9474BlindCredentialSigner
{
    public bool IsConfigured => false;
    public string KeyId => ResolveKeyId(configuration);
    public string PublicKeyHash => string.Empty;
    public byte[] SubjectPublicKeyInfo => [];
    public int ModulusBytes => Rfc9474BlindCredentialProfile.ModulusBytes;

    public ValueTask<Result<byte[]>> BlindSignAsync(
        ReadOnlyMemory<byte> blindedMessage,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(Result<byte[]>.Failure(
            ErrorCode.InfraFailure,
            "anonymous_credential_blind_issuer_unavailable"));
    }

    internal static string ResolveKeyId(IConfiguration configuration)
    {
        string keyId = (configuration["AnonymousCredentialIssuer:BlindRsa:KeyId"] ?? string.Empty).Trim();
        if (keyId.Length is 0 or > Rfc9474BlindCredentialProfile.MaxKeyIdBytes ||
            string.Equals(keyId, "CHANGE_ME_BLIND_RSA_KEY_ID", StringComparison.Ordinal))
        {
            return string.Empty;
        }

        return keyId;
    }
}

public sealed class ProductionRfc9474BlindCredentialSigner : IRfc9474BlindCredentialSigner, IDisposable
{
    private readonly RsaPrivateCrtKeyParameters? _privateKey;
    private readonly RsaKeyParameters? _publicKey;
    private readonly SemaphoreSlim _signatureSlots;
    private readonly int _timeoutMs;
    private byte[] _subjectPublicKeyInfo = [];

    public ProductionRfc9474BlindCredentialSigner(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        IConfigurationSection section = configuration.GetSection("AnonymousCredentialIssuer:BlindRsa");
        KeyId = UnavailableRfc9474BlindCredentialSigner.ResolveKeyId(configuration);
        _timeoutMs = Math.Clamp(section.GetValue("TimeoutMs", 2_000), 100, 30_000);
        int maxConcurrent = Math.Clamp(
            section.GetValue("MaxConcurrentSignatures", 2),
            1,
            Math.Max(1, Environment.ProcessorCount));
        _signatureSlots = new SemaphoreSlim(maxConcurrent, maxConcurrent);

        if (!section.GetValue("Enabled", false) ||
            !string.Equals(
                (section["Profile"] ?? string.Empty).Trim(),
                Rfc9474BlindCredentialProfile.SchemeId,
                StringComparison.Ordinal) ||
            KeyId.Length == 0)
        {
            return;
        }

        string privateKeyPath = ValidatePrivateKeyPath(section["PrivateKeyPath"]);
        byte[] privateKeyDer = [];
        RSAParameters parameters = default;
        try
        {
            using RSA rsa = RSA.Create();
            privateKeyDer = File.ReadAllBytes(privateKeyPath);
            rsa.ImportPkcs8PrivateKey(privateKeyDer, out int bytesRead);
            if (bytesRead != privateKeyDer.Length)
            {
                return;
            }
            if (rsa.KeySize != Rfc9474BlindCredentialProfile.ModulusBits)
            {
                return;
            }

            parameters = rsa.ExportParameters(includePrivateParameters: true);
            if (!HasRequiredParameters(parameters) ||
                !parameters.Exponent!.AsSpan().SequenceEqual(new byte[] { 0x01, 0x00, 0x01 }))
            {
                return;
            }

            _privateKey = ToPrivateKey(parameters);
            _publicKey = new RsaKeyParameters(
                isPrivate: false,
                new BigInteger(1, parameters.Modulus),
                new BigInteger(1, parameters.Exponent));
            _subjectPublicKeyInfo = rsa.ExportSubjectPublicKeyInfo();
            PublicKeyHash = Convert.ToHexStringLower(SHA256.HashData(_subjectPublicKeyInfo));

            string configuredHash = NormalizeSha256(section["PublicKeyHash"]);
            if (!string.Equals(PublicKeyHash, configuredHash, StringComparison.Ordinal))
            {
                _privateKey = null;
                _publicKey = null;
                CryptographicOperations.ZeroMemory(_subjectPublicKeyInfo);
                _subjectPublicKeyInfo = [];
                PublicKeyHash = string.Empty;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or CryptographicException or ArgumentException)
        {
            _privateKey = null;
            _publicKey = null;
            CryptographicOperations.ZeroMemory(_subjectPublicKeyInfo);
            _subjectPublicKeyInfo = [];
            PublicKeyHash = string.Empty;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(privateKeyDer);
            ClearPrivateParameters(parameters);
        }
    }

    public bool IsConfigured =>
        _privateKey is not null &&
        _publicKey is not null &&
        KeyId.Length > 0 &&
        PublicKeyHash.Length == 64 &&
        _subjectPublicKeyInfo.Length > 0;

    public string KeyId
    {
        get;
    }
    public string PublicKeyHash { get; private set; } = string.Empty;
    public byte[] SubjectPublicKeyInfo => [.. _subjectPublicKeyInfo];
    public int ModulusBytes => Rfc9474BlindCredentialProfile.ModulusBytes;

    public async ValueTask<Result<byte[]>> BlindSignAsync(
        ReadOnlyMemory<byte> blindedMessage,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsConfigured ||
            blindedMessage.Length != ModulusBytes ||
            IsZero(blindedMessage.Span))
        {
            return Result<byte[]>.Failure(
                ErrorCode.InfraFailure,
                "anonymous_credential_blind_issuer_unavailable");
        }

        if (!await _signatureSlots.WaitAsync(
                TimeSpan.FromMilliseconds(_timeoutMs),
                cancellationToken).ConfigureAwait(false))
        {
            return Result<byte[]>.Failure(
                ErrorCode.InfraFailure,
                "anonymous_credential_blind_issuer_unavailable");
        }

        try
        {
            byte[]? input = null;
            byte[]? raw = null;
            byte[]? signature = null;
            byte[]? recoveredRaw = null;
            byte[]? recovered = null;
            try
            {
                input = blindedMessage.ToArray();
                var engine = new RsaBlindedEngine();
                engine.Init(
                    forEncryption: true,
                    new ParametersWithRandom(_privateKey!, new SecureRandom()));
                raw = engine.ProcessBlock(input, 0, input.Length);
                signature = LeftPad(raw, ModulusBytes);

                // RFC 9474 BlindSign requires a fault check. Re-apply the public
                // operation and compare the exact blinded representative.
                var verifier = new RsaEngine();
                verifier.Init(forEncryption: true, _publicKey!);
                recoveredRaw = verifier.ProcessBlock(signature, 0, signature.Length);
                recovered = LeftPad(recoveredRaw, ModulusBytes);
                if (!CryptographicOperations.FixedTimeEquals(input, recovered))
                {
                    return Result<byte[]>.Failure(
                        ErrorCode.InfraFailure,
                        "anonymous_credential_blind_issuer_unavailable");
                }

                // Return a distinct buffer so every private-operation temporary
                // can be cleared by the single cleanup boundary below.
                return Result<byte[]>.Success([.. signature]);
            }
            catch (CryptoException)
            {
                return Result<byte[]>.Failure(
                    ErrorCode.InfraFailure,
                    "anonymous_credential_blind_issuer_unavailable");
            }
            finally
            {
                Zero(input);
                Zero(raw);
                Zero(signature);
                Zero(recoveredRaw);
                Zero(recovered);
            }
        }
        finally
        {
            _signatureSlots.Release();
        }
    }

    public void Dispose()
    {
        CryptographicOperations.ZeroMemory(_subjectPublicKeyInfo);
        _subjectPublicKeyInfo = [];
        _signatureSlots.Dispose();
    }

    private static string ValidatePrivateKeyPath(string? configuredPath)
    {
        if (string.IsNullOrWhiteSpace(configuredPath))
        {
            return string.Empty;
        }

        string path = Path.GetFullPath(configuredPath.Trim());
        if (!string.Equals(Path.GetExtension(path), ".der", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "AnonymousCredentialIssuer:BlindRsa:PrivateKeyPath must reference a PKCS#8 DER file.");
        }
        string[] segments = path.Split(
            [Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar],
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (segments.Any(static segment =>
                string.Equals(segment, "wwwroot", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(segment, "uploads", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(segment, "backups", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException(
                "AnonymousCredentialIssuer:BlindRsa:PrivateKeyPath is outside the permitted secret boundary.");
        }

        if (!OperatingSystem.IsWindows() && File.Exists(path))
        {
            UnixFileMode mode = File.GetUnixFileMode(path);
            const UnixFileMode Permitted = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            if ((mode & ~Permitted) != 0)
            {
                throw new InvalidOperationException(
                    "AnonymousCredentialIssuer:BlindRsa:PrivateKeyPath must use permissions no broader than 0600.");
            }
        }

        return path;
    }

    private static bool HasRequiredParameters(RSAParameters value) =>
        value.Modulus is { Length: Rfc9474BlindCredentialProfile.ModulusBytes } &&
        value.Exponent is { Length: > 0 } &&
        value.D is { Length: > 0 } &&
        value.P is { Length: > 0 } &&
        value.Q is { Length: > 0 } &&
        value.DP is { Length: > 0 } &&
        value.DQ is { Length: > 0 } &&
        value.InverseQ is { Length: > 0 };

    private static RsaPrivateCrtKeyParameters ToPrivateKey(RSAParameters value) =>
        new(
            new BigInteger(1, value.Modulus),
            new BigInteger(1, value.Exponent),
            new BigInteger(1, value.D),
            new BigInteger(1, value.P),
            new BigInteger(1, value.Q),
            new BigInteger(1, value.DP),
            new BigInteger(1, value.DQ),
            new BigInteger(1, value.InverseQ));

    private static void ClearPrivateParameters(RSAParameters value)
    {
        Zero(value.D);
        Zero(value.P);
        Zero(value.Q);
        Zero(value.DP);
        Zero(value.DQ);
        Zero(value.InverseQ);
    }

    private static void Zero(byte[]? value)
    {
        if (value is not null)
        {
            CryptographicOperations.ZeroMemory(value);
        }
    }

    private static string NormalizeSha256(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            normalized = normalized["sha256:".Length..];
        }

        return normalized.Length == 64 &&
            normalized.All(static character => Uri.IsHexDigit(character))
            ? normalized.ToLowerInvariant()
            : string.Empty;
    }

    private static byte[] LeftPad(ReadOnlySpan<byte> value, int length)
    {
        if (value.Length > length)
        {
            throw new CryptoException("RSA representative exceeds modulus width.");
        }

        byte[] output = new byte[length];
        value.CopyTo(output.AsSpan(length - value.Length));
        return output;
    }

    private static bool IsZero(ReadOnlySpan<byte> value)
    {
        int aggregate = 0;
        foreach (byte current in value)
        {
            aggregate |= current;
        }
        return aggregate == 0;
    }
}
