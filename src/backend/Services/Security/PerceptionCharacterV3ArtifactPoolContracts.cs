using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Services.Security;

public sealed record PerceptionCharacterV3PoolManifest(
    string Schema,
    string GenerationId,
    string ContractDigest,
    string KeyVersion,
    string PackFile,
    string PackSha256,
    IReadOnlyList<PerceptionCharacterV3PoolManifestEntry> Entries);

public sealed record PerceptionCharacterV3PoolManifestEntry(
    string EntryId,
    string Representation,
    string MediaType,
    long Offset,
    int Length,
    string NonceBase64,
    string CiphertextSha256);

internal sealed record PerceptionCharacterV3PoolPlaintext(
    string Schema,
    string EntryId,
    string GenerationId,
    string Representation,
    string MediaType,
    byte[] Artifact,
    string ArtifactHash,
    byte[] Answer,
    string ContractDigest,
    string CreatedBy);

public sealed class PerceptionCharacterV3ArtifactLease : IAsyncDisposable
{
    private byte[] _answer;

    public PerceptionCharacterV3ArtifactLease(
        string entryId,
        string generationId,
        PerceptionCharacterV3Representation representation,
        string mediaType,
        byte[] artifact,
        string artifactHash,
        byte[] answer)
    {
        EntryId = entryId;
        GenerationId = generationId;
        Representation = representation;
        MediaType = mediaType;
        Artifact = artifact;
        ArtifactHash = artifactHash;
        _answer = answer;
    }

    public string EntryId
    {
        get;
    }
    public string GenerationId
    {
        get;
    }
    public PerceptionCharacterV3Representation Representation
    {
        get;
    }
    public string MediaType
    {
        get;
    }
    public byte[] Artifact
    {
        get;
    }
    public string ArtifactHash
    {
        get;
    }
    public ReadOnlySpan<byte> AnswerBytes => _answer;

    public ValueTask DisposeAsync()
    {
        CryptographicOperations.ZeroMemory(_answer);
        _answer = [];
        return ValueTask.CompletedTask;
    }
}

public interface IPerceptionCharacterV3ArtifactPool
{
    string ActiveGenerationId
    {
        get;
    }
    Task InitializeAsync(CancellationToken cancellationToken);
    Task<PerceptionCharacterV3ArtifactLease?> LeaseAsync(
        PerceptionCharacterV3Representation representation,
        CancellationToken cancellationToken);
}

public sealed class PerceptionCharacterV3ArtifactPoolOptions
{
    private static readonly HashSet<string> s_testDigests =
    [
        "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
        "2e89abf78a47d7b0b46df24de5e23022c97087537089442013eca82ab863684d"
    ];
    public const string SectionName = "Security:PerceptionCharacterV3:Pool";
    public string RootPath { get; init; } = string.Empty;
    public string ActiveGeneration { get; init; } = string.Empty;
    public string KeyCurrent { get; init; } = string.Empty;
    public Dictionary<string, string> Keys { get; init; } = new(StringComparer.Ordinal);
    internal bool AllowTestVectors
    {
        get; init;
    }

    public static PerceptionCharacterV3ArtifactPoolOptions FromConfiguration(
        IConfiguration configuration,
        IHostEnvironment environment)
    {
        IConfigurationSection section = configuration.GetSection(SectionName);
        var options = new PerceptionCharacterV3ArtifactPoolOptions
        {
            RootPath = section["RootPath"] ?? string.Empty,
            ActiveGeneration = section["ActiveGeneration"] ?? string.Empty,
            KeyCurrent = section["KeyCurrent"] ?? string.Empty,
            Keys = section.GetSection("Keys").GetChildren().ToDictionary(
                child => child.Key,
                child => child.Value ?? string.Empty,
                StringComparer.Ordinal),
            AllowTestVectors = environment.IsEnvironment("Test") &&
                configuration.GetValue("Security:PerceptionCharacterV3:AllowTestVectors", false)
        };
        options.Validate(environment.ContentRootPath);
        options.ValidateConfigurationSeparation(configuration);
        return options;
    }

    public string ResolveRoot(string contentRoot)
        => Path.GetFullPath(Path.IsPathRooted(RootPath) ? RootPath : Path.Combine(contentRoot, RootPath));

    public byte[] CurrentKey()
    {
        if (!Keys.TryGetValue(KeyCurrent, out string? encoded))
            throw new InvalidOperationException("PerceptionCharacterV3 pool current key is unknown.");
        try
        {
            byte[] key = encoded.Length == 64 && encoded.All(Uri.IsHexDigit)
                ? Convert.FromHexString(encoded)
                : Convert.FromBase64String(encoded);
            if (key.Length != 32)
                throw new InvalidOperationException("PerceptionCharacterV3 pool key must be exactly 256 bits.");
            if (!AllowTestVectors && s_testDigests.Contains(Convert.ToHexStringLower(SHA256.HashData(key))))
                throw new InvalidOperationException("PerceptionCharacterV3 pool key is a checked-in test vector.");
            return key;
        }
        catch (FormatException ex)
        {
            throw new InvalidOperationException("PerceptionCharacterV3 pool key encoding is invalid.", ex);
        }
    }

    private void Validate(string contentRoot)
    {
        if (string.IsNullOrWhiteSpace(RootPath) || string.IsNullOrWhiteSpace(ActiveGeneration) ||
            string.IsNullOrWhiteSpace(KeyCurrent) || !Keys.ContainsKey(KeyCurrent))
            throw new InvalidOperationException("PerceptionCharacterV3 active pool configuration is incomplete.");
        string root = ResolveRoot(contentRoot);
        string generationRoot = Path.GetFullPath(Path.Combine(root, ActiveGeneration));
        if (!generationRoot.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new InvalidOperationException("PerceptionCharacterV3 pool generation escapes its owned root.");
        _ = CurrentKey();
    }

    private void ValidateConfigurationSeparation(IConfiguration configuration)
    {
        byte[] poolKey = CurrentKey();
        foreach ((string setting, string? value) in configuration.AsEnumerable())
        {
            if (setting.StartsWith(SectionName + ":", StringComparison.Ordinal) ||
                string.IsNullOrWhiteSpace(value) || !TryDecodeCandidate(value, out byte[] candidate))
                continue;
            try
            {
                if (CryptographicOperations.FixedTimeEquals(poolKey, candidate))
                    throw new InvalidOperationException($"PerceptionCharacterV3 pool key must be independent from {setting}.");
            }
            finally
            {
                CryptographicOperations.ZeroMemory(candidate);
            }
        }
    }

    private static bool TryDecodeCandidate(string value, out byte[] candidate)
    {
        string trimmed = value.Trim();
        try
        {
            candidate = trimmed.Length == 64 && trimmed.All(Uri.IsHexDigit)
                ? Convert.FromHexString(trimmed)
                : Convert.FromBase64String(trimmed);
        }
        catch (FormatException)
        {
            candidate = Encoding.UTF8.GetBytes(trimmed);
        }
        if (candidate.Length == 32)
            return true;
        CryptographicOperations.ZeroMemory(candidate);
        candidate = [];
        return false;
    }
}

internal static class PerceptionCharacterV3PoolCodec
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);

    public static PerceptionCharacterV3PoolManifest ReadManifest(string path)
        => JsonSerializer.Deserialize<PerceptionCharacterV3PoolManifest>(File.ReadAllBytes(path), s_json)
           ?? throw new InvalidOperationException("PerceptionCharacterV3 pool manifest is invalid.");

    public static PerceptionCharacterV3PoolPlaintext OpenRecord(
        string generationId,
        string contractDigest,
        PerceptionCharacterV3PoolManifestEntry entry,
        ReadOnlySpan<byte> ciphertextAndTag,
        ReadOnlySpan<byte> key)
    {
        if (ciphertextAndTag.Length <= 16)
            throw new InvalidOperationException("PerceptionCharacterV3 pool record is truncated.");
        byte[] nonce = Convert.FromBase64String(entry.NonceBase64);
        if (nonce.Length != 12)
            throw new InvalidOperationException("PerceptionCharacterV3 pool nonce is invalid.");
        byte[] plaintext = new byte[ciphertextAndTag.Length - 16];
        try
        {
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(
                nonce,
                ciphertextAndTag[..^16],
                ciphertextAndTag[^16..],
                plaintext,
                Aad(generationId, contractDigest, entry));
            return DecodePlaintext(plaintext);
        }
        catch (CryptographicException ex)
        {
            throw new InvalidOperationException("PerceptionCharacterV3 pool record authentication failed.", ex);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
            CryptographicOperations.ZeroMemory(nonce);
        }
    }

    public static byte[] Aad(
        string generationId,
        string contractDigest,
        PerceptionCharacterV3PoolManifestEntry entry)
        => Encoding.UTF8.GetBytes(string.Join('\0',
            generationId,
            entry.EntryId,
            contractDigest,
            entry.Representation,
            entry.MediaType));

    public static string CanonicalContractDigest()
    {
        using Stream stream = typeof(PerceptionCharacterV3CanonicalContract).Assembly
            .GetManifestResourceStream("FsusBlog.PerceptionCharacterV3.Contract.json")
            ?? throw new InvalidOperationException("Canonical PerceptionCharacterV3 contract resource is missing.");
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    private static PerceptionCharacterV3PoolPlaintext DecodePlaintext(ReadOnlySpan<byte> plaintext)
    {
        if (!TryDecodeLp(plaintext, 10, out byte[][] fields) || fields[6].Length != 32 ||
            fields[7].Length != PerceptionCharacterV3CanonicalContract.Value.Answer.Length || fields[8].Length != 32)
            throw new InvalidOperationException("PerceptionCharacterV3 pool plaintext fields are invalid.");
        return new(
            Text(fields[0]),
            Text(fields[1]),
            Text(fields[2]),
            Text(fields[3]),
            Text(fields[4]),
            fields[5],
            Convert.ToHexStringLower(fields[6]),
            fields[7],
            Convert.ToHexStringLower(fields[8]),
            Text(fields[9]));
    }

    private static bool TryDecodeLp(ReadOnlySpan<byte> bytes, int expected, out byte[][] fields)
    {
        fields = [];
        if (bytes.Length < 2 || BinaryPrimitives.ReadUInt16BigEndian(bytes) != expected)
            return false;
        var decoded = new byte[expected][];
        int offset = 2;
        for (int index = 0; index < expected; index++)
        {
            if (offset > bytes.Length - 4)
                return false;
            uint length = BinaryPrimitives.ReadUInt32BigEndian(bytes[offset..]);
            offset += 4;
            if (length > int.MaxValue || offset > bytes.Length - (int)length)
                return false;
            decoded[index] = bytes.Slice(offset, (int)length).ToArray();
            offset += (int)length;
        }
        if (offset != bytes.Length)
            return false;
        fields = decoded;
        return true;
    }

    private static string Text(byte[] value)
        => new UTF8Encoding(false, true).GetString(value);
}
