using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Shared.Contracts.Security;

using StackExchange.Redis;

namespace FsusBlog.Server.Services.Security;

public sealed class RedisPerceptionCharacterV3ArtifactPool : IPerceptionCharacterV3ArtifactPool
{
    private const string LeaseScript = """
        if redis.call('EXISTS', KEYS[1]) == 1 then return -2 end
        if redis.call('SET', KEYS[2], 'burned', 'NX') then return 1 end
        return 0
        """;
    private readonly IConnectionMultiplexer _redis;
    private readonly IRuntimeKeyScope _keyScope;
    private readonly PerceptionCharacterV3ArtifactPoolOptions _options;
    private readonly string _generationRoot;
    private readonly byte[] _key;
    private readonly Func<bool>? _discardLeaseReply;
    private PerceptionCharacterV3PoolManifest? _manifest;
    private string _packPath = string.Empty;

    public RedisPerceptionCharacterV3ArtifactPool(
        IConnectionMultiplexer redis,
        IRuntimeKeyScope keyScope,
        IConfiguration configuration,
        IHostEnvironment environment,
        IPerceptionCharacterV3KeyRing keyRing)
        : this(
            redis,
            keyScope,
            PerceptionCharacterV3ArtifactPoolOptions.FromConfiguration(configuration, environment),
            environment.ContentRootPath,
            null,
            keyRing)
    {
    }

    internal RedisPerceptionCharacterV3ArtifactPool(
        IConnectionMultiplexer redis,
        IRuntimeKeyScope keyScope,
        PerceptionCharacterV3ArtifactPoolOptions options,
        string contentRoot,
        Func<bool>? discardLeaseReply = null,
        IPerceptionCharacterV3KeyRing? keyRing = null)
    {
        _redis = redis;
        _keyScope = keyScope;
        _options = options;
        _generationRoot = Path.Combine(_options.ResolveRoot(contentRoot), _options.ActiveGeneration);
        _key = _options.CurrentKey();
        _discardLeaseReply = discardLeaseReply;
        if (keyRing is not null)
            ValidateDedicatedKey(keyRing);
    }

    public string ActiveGenerationId => _options.ActiveGeneration;

    private void ValidateDedicatedKey(IPerceptionCharacterV3KeyRing keyRing)
    {
        if (!keyRing.TryGetTokenKey(keyRing.CurrentTokenVersion, out byte[] tokenKey) ||
            !keyRing.TryGetAnswerKey(keyRing.CurrentAnswerVersion, out byte[] answerKey) ||
            CryptographicOperations.FixedTimeEquals(_key, tokenKey) ||
            CryptographicOperations.FixedTimeEquals(_key, answerKey))
            throw new InvalidOperationException("PerceptionCharacterV3 pool key must be independent from token and answer keys.");
    }

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string manifestPath = Path.Combine(_generationRoot, "manifest.json");
        PerceptionCharacterV3PoolManifest manifest = PerceptionCharacterV3PoolCodec.ReadManifest(manifestPath);
        ValidateManifest(manifest);
        _packPath = Path.GetFullPath(Path.Combine(_generationRoot, manifest.PackFile));
        if (!_packPath.StartsWith(Path.GetFullPath(_generationRoot) + Path.DirectorySeparatorChar, StringComparison.Ordinal) ||
            !File.Exists(_packPath))
            throw new InvalidOperationException("PerceptionCharacterV3 packfile is missing or escapes its generation root.");
        string packDigest = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(_packPath)));
        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(packDigest),
                Encoding.ASCII.GetBytes(manifest.PackSha256)))
            throw new InvalidOperationException("PerceptionCharacterV3 packfile digest mismatch.");
        ValidateRecords(manifest);
        try
        {
            if (await _redis.GetDatabase().KeyExistsAsync(RevocationKey(manifest.GenerationId)).ConfigureAwait(false))
                throw new InvalidOperationException("PerceptionCharacterV3 active pool generation is revoked.");
        }
        catch (RedisException ex)
        {
            throw new PerceptionCharacterV3StoreUnavailableException(ex);
        }
        _manifest = manifest;
    }

    public async Task<PerceptionCharacterV3ArtifactLease?> LeaseAsync(
        PerceptionCharacterV3Representation representation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PerceptionCharacterV3PoolManifest manifest = _manifest
            ?? throw new InvalidOperationException("PerceptionCharacterV3 artifact pool is not initialized.");
        string name = representation == PerceptionCharacterV3Representation.Visual ? "visual" : "audio";
        PerceptionCharacterV3PoolManifestEntry[] candidates = manifest.Entries
            .Where(entry => entry.Representation == name)
            .ToArray();
        if (candidates.Length == 0)
            return null;
        int start = RandomNumberGenerator.GetInt32(candidates.Length);
        IDatabase database = _redis.GetDatabase();
        for (int index = 0; index < candidates.Length; index++)
        {
            PerceptionCharacterV3PoolManifestEntry entry = candidates[(start + index) % candidates.Length];
            cancellationToken.ThrowIfCancellationRequested();
            RedisResult result;
            try
            {
                result = await database.ScriptEvaluateAsync(
                    LeaseScript,
                    [RevocationKey(manifest.GenerationId), EntryKey(manifest.GenerationId, entry.EntryId)],
                    []).ConfigureAwait(false);
                if (_discardLeaseReply?.Invoke() == true)
                    throw new DiscardedLeaseReplyException();
            }
            catch (Exception ex) when (ex is RedisException or DiscardedLeaseReplyException)
            {
                throw new PerceptionCharacterV3StoreUnavailableException(ex);
            }
            int outcome = (int)(long)result;
            if (outcome == -2)
                throw new InvalidOperationException("PerceptionCharacterV3 active pool generation is revoked.");
            if (outcome == 1)
                return ReadLease(manifest, entry);
        }
        return null;
    }

    private PerceptionCharacterV3ArtifactLease ReadLease(
        PerceptionCharacterV3PoolManifest manifest,
        PerceptionCharacterV3PoolManifestEntry entry)
    {
        byte[] record = new byte[entry.Length];
        using (FileStream stream = new(_packPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            stream.Position = entry.Offset;
            stream.ReadExactly(record);
        }
        string recordDigest = Convert.ToHexStringLower(SHA256.HashData(record));
        if (!string.Equals(recordDigest, entry.CiphertextSha256, StringComparison.Ordinal))
            throw new InvalidOperationException("PerceptionCharacterV3 pool record digest mismatch.");
        PerceptionCharacterV3PoolPlaintext plaintext;
        try
        {
            plaintext = PerceptionCharacterV3PoolCodec.OpenRecord(
                manifest.GenerationId,
                manifest.ContractDigest,
                entry,
                record,
                _key);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(record);
        }
        bool handedOff = false;
        try
        {
            ValidatePlaintext(manifest, entry, plaintext);
            var lease = new PerceptionCharacterV3ArtifactLease(
                entry.EntryId,
                manifest.GenerationId,
                entry.Representation == "visual"
                    ? PerceptionCharacterV3Representation.Visual
                    : PerceptionCharacterV3Representation.Audio,
                entry.MediaType,
                plaintext.Artifact,
                plaintext.ArtifactHash,
                plaintext.Answer);
            handedOff = true;
            return lease;
        }
        finally
        {
            if (!handedOff)
                CryptographicOperations.ZeroMemory(plaintext.Answer);
        }
    }

    private void ValidateManifest(PerceptionCharacterV3PoolManifest manifest)
    {
        if (manifest.Schema != "fsusblog.security.perception-character-v3.pool-manifest.v1" ||
            manifest.GenerationId != _options.ActiveGeneration ||
            manifest.KeyVersion != _options.KeyCurrent ||
            manifest.ContractDigest != PerceptionCharacterV3PoolCodec.CanonicalContractDigest() ||
            manifest.Entries.Count == 0 ||
            manifest.Entries.Select(entry => entry.EntryId).Distinct(StringComparer.Ordinal).Count() != manifest.Entries.Count)
            throw new InvalidOperationException("PerceptionCharacterV3 pool manifest contract is invalid.");
    }

    private void ValidateRecords(PerceptionCharacterV3PoolManifest manifest)
    {
        long packLength = new FileInfo(_packPath).Length;
        long previousEnd = 0;
        foreach (PerceptionCharacterV3PoolManifestEntry entry in manifest.Entries.OrderBy(entry => entry.Offset))
        {
            if (!Guid.TryParseExact(entry.EntryId, "D", out _) ||
                entry.Offset != previousEnd || entry.Length <= 16 || entry.Length > 64 * 1024 || entry.Offset + entry.Length > packLength ||
                entry.Representation is not ("visual" or "audio") ||
                entry.MediaType != (entry.Representation == "visual"
                    ? PerceptionCharacterV3Contracts.VisualMediaType
                    : PerceptionCharacterV3Contracts.AudioMediaType))
                throw new InvalidOperationException("PerceptionCharacterV3 pool index is invalid.");
            previousEnd = entry.Offset + entry.Length;
            _ = ReadLeaseForValidation(manifest, entry);
        }
        if (previousEnd != packLength)
            throw new InvalidOperationException("PerceptionCharacterV3 pool index does not cover the pack exactly.");
    }

    private bool ReadLeaseForValidation(
        PerceptionCharacterV3PoolManifest manifest,
        PerceptionCharacterV3PoolManifestEntry entry)
    {
        byte[] record = new byte[entry.Length];
        using FileStream stream = new(_packPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        stream.Position = entry.Offset;
        stream.ReadExactly(record);
        try
        {
            if (Convert.ToHexStringLower(SHA256.HashData(record)) != entry.CiphertextSha256)
                throw new InvalidOperationException("PerceptionCharacterV3 pool record digest mismatch.");
            PerceptionCharacterV3PoolPlaintext plaintext = PerceptionCharacterV3PoolCodec.OpenRecord(
                manifest.GenerationId,
                manifest.ContractDigest,
                entry,
                record,
                _key);
            try
            {
                ValidatePlaintext(manifest, entry, plaintext);
                return true;
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext.Answer);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(record);
        }
    }

    private static void ValidatePlaintext(
        PerceptionCharacterV3PoolManifest manifest,
        PerceptionCharacterV3PoolManifestEntry entry,
        PerceptionCharacterV3PoolPlaintext plaintext)
    {
        byte[] artifact = plaintext.Artifact;
        var payload = new PerceptionCharacterV3IssuePayload(
            PerceptionCharacterV3Contracts.Algorithm,
            Guid.CreateVersion7().ToString("D"),
            Guid.CreateVersion7().ToString("D"),
            entry.Representation == "visual" ? PerceptionCharacterV3Representation.Visual : PerceptionCharacterV3Representation.Audio,
            entry.MediaType,
            artifact,
            entry.Representation == "visual" ? (ushort)PerceptionCharacterV3Contracts.PhysicalWidth : (ushort)0,
            entry.Representation == "visual" ? (ushort)PerceptionCharacterV3Contracts.PhysicalHeight : (ushort)0,
            entry.Representation == "visual" ? (ushort)PerceptionCharacterV3Contracts.DisplayWidth : (ushort)0,
            entry.Representation == "visual" ? (ushort)PerceptionCharacterV3Contracts.DisplayHeight : (ushort)0,
            2, "pool-validation", 1, 2, "opaque");
        if (plaintext.Schema != "fsusblog.security.perception-character-v3.pool-entry.v1" ||
            plaintext.EntryId != entry.EntryId || plaintext.GenerationId != manifest.GenerationId ||
            plaintext.ContractDigest != manifest.ContractDigest || plaintext.Representation != entry.Representation ||
            plaintext.MediaType != entry.MediaType ||
            plaintext.Answer.Length != PerceptionCharacterV3CanonicalContract.Value.Answer.Length ||
            plaintext.Answer.Any(value => !PerceptionCharacterV3CanonicalContract.Value.Answer.Alphabet.Contains((char)value)) ||
            Convert.ToHexStringLower(SHA256.HashData(artifact)) != plaintext.ArtifactHash ||
            !PerceptionCharacterV3Contracts.ValidateIssue(payload).IsValid)
            throw new InvalidOperationException("PerceptionCharacterV3 pool entry contract is invalid.");
    }

    private RedisKey EntryKey(string generationId, string entryId)
        => _keyScope.PrefixKey($"security:perception-v3-pool:{generationId}:entry:{entryId}");

    private RedisKey RevocationKey(string generationId)
        => _keyScope.PrefixKey($"security:perception-v3-pool:{generationId}:revoked");

    private sealed class DiscardedLeaseReplyException : Exception;
}
