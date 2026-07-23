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
    private const string InitializeInventoryScript = """
        if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
        local visual = 0
        local audio = 0
        local visualTotal = 0
        local audioTotal = 0
        for index = 2, #KEYS do
            if ARGV[index - 1] == 'visual' then visualTotal = visualTotal + 1 else audioTotal = audioTotal + 1 end
            if redis.call('EXISTS', KEYS[index]) == 0 then
                if ARGV[index - 1] == 'visual' then visual = visual + 1 else audio = audio + 1 end
            end
        end
        redis.call('HSET', KEYS[1],
            'visual-ready', visual, 'audio-ready', audio, 'total-ready', visual + audio,
            'visual-leased', visualTotal - visual, 'audio-leased', audioTotal - audio)
        return 1
        """;
    private const string BudgetedLeaseScript = """
        if redis.call('EXISTS', KEYS[1]) == 1 then return -2 end
        if redis.call('EXISTS', KEYS[11]) == 1 then return -11 end
        if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
        local now = tonumber(ARGV[3])
        local bytes = tonumber(ARGV[2])
        local rolling = redis.call('ZRANGEBYSCORE', KEYS[5], now - 3600000, '+inf')
        redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now - 3600001)
        local rollingBytes = 0
        for _, member in ipairs(rolling) do
            local separator = string.find(member, ':')
            rollingBytes = rollingBytes + tonumber(string.sub(member, 1, separator - 1))
        end
        if tonumber(redis.call('GET', KEYS[4]) or '0') >= tonumber(ARGV[4]) then return -3 end
        if #rolling >= tonumber(ARGV[5]) then return -4 end
        if tonumber(redis.call('GET', KEYS[6]) or '0') + bytes > tonumber(ARGV[6]) then return -5 end
        if rollingBytes + bytes > tonumber(ARGV[7]) then return -6 end
        if tonumber(redis.call('GET', KEYS[7]) or '0') >= tonumber(ARGV[8]) then return -7 end
        if tonumber(redis.call('GET', KEYS[8]) or '0') >= tonumber(ARGV[9]) then return -8 end
        if tonumber(redis.call('GET', KEYS[9]) or '0') >= tonumber(ARGV[10]) then return -9 end
        if tonumber(redis.call('GET', KEYS[10]) or '0') >= tonumber(ARGV[11]) then return -10 end
        if not redis.call('SET', KEYS[2], 'burned', 'NX') then return 0 end
        redis.call('HINCRBY', KEYS[3], ARGV[1] .. '-ready', -1)
        redis.call('HINCRBY', KEYS[3], ARGV[1] .. '-leased', 1)
        redis.call('HINCRBY', KEYS[3], 'total-ready', -1)
        local minuteKeys = { KEYS[4], KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10] }
        local increments = { 1, bytes, 1, 1, 1, 1 }
        for index, key in ipairs(minuteKeys) do
            redis.call('INCRBY', key, increments[index])
            redis.call('PEXPIRE', key, 120000)
        end
        redis.call('ZADD', KEYS[5], now, tostring(bytes) .. ':' .. ARGV[12])
        redis.call('PEXPIRE', KEYS[5], 3700000)
        redis.call('SET', KEYS[11], ARGV[12], 'PX', 3700000)
        return 1
        """;
    private readonly IConnectionMultiplexer _redis;
    private readonly IRuntimeKeyScope _keyScope;
    private readonly PerceptionCharacterV3ArtifactPoolOptions _options;
    private readonly string _generationRoot;
    private readonly byte[] _key;
    private readonly Func<bool>? _discardLeaseReply;
    private PerceptionCharacterV3PoolManifest? _manifest;
    private PerceptionCharacterV3PoolIdentity? _identity;
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
        string manifestDigest = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(manifestPath)));
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
        _identity = new(
            manifest.GenerationId,
            manifestDigest,
            manifest.ContractDigest,
            packDigest);
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
        await InitializeInventoryAsync(manifest).ConfigureAwait(false);
    }

    public Task<PerceptionCharacterV3PoolIdentity> GetIdentityAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(_identity
            ?? throw new InvalidOperationException("PerceptionCharacterV3 artifact pool is not initialized."));
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

    public async Task<PerceptionCharacterV3PoolInventory> GetInventoryAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PerceptionCharacterV3PoolManifest manifest = _manifest
            ?? throw new InvalidOperationException("PerceptionCharacterV3 artifact pool is not initialized.");
        try
        {
            IDatabase database = _redis.GetDatabase();
            Task<RedisValue[]> valuesTask = database.HashGetAsync(
                InventoryKey(manifest.GenerationId),
                ["visual-ready", "audio-ready", "total-ready", "visual-leased", "audio-leased"]);
            Task<bool> revokedTask = database.KeyExistsAsync(RevocationKey(manifest.GenerationId));
            await Task.WhenAll(valuesTask, revokedTask).ConfigureAwait(false);
            RedisValue[] values = await valuesTask.ConfigureAwait(false);
            if (values.Any(static value => value.IsNull))
                throw new PerceptionCharacterV3StoreUnavailableException(
                    new InvalidOperationException("PerceptionCharacterV3 inventory is not initialized."));
            return new(
                manifest.GenerationId,
                (int)values[0],
                (int)values[1],
                (int)values[2],
                (int)values[3],
                (int)values[4],
                await revokedTask.ConfigureAwait(false),
                false,
                true);
        }
        catch (RedisException ex)
        {
            throw new PerceptionCharacterV3StoreUnavailableException(ex);
        }
    }

    public async Task<PerceptionCharacterV3PoolLeaseResult> LeaseBudgetedAsync(
        PerceptionCharacterV3Representation representation,
        PerceptionCharacterV3LeaseBudget budget,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(budget);
        cancellationToken.ThrowIfCancellationRequested();
        PerceptionCharacterV3PoolManifest manifest = _manifest
            ?? throw new InvalidOperationException("PerceptionCharacterV3 artifact pool is not initialized.");
        string name = representation == PerceptionCharacterV3Representation.Visual ? "visual" : "audio";
        PerceptionCharacterV3PoolManifestEntry[] candidates = manifest.Entries
            .Where(entry => entry.Representation == name)
            .ToArray();
        if (candidates.Length == 0)
            return PerceptionCharacterV3PoolLeaseResult.Failed(PerceptionCharacterV3PoolLeaseOutcome.Empty);
        int start = RandomNumberGenerator.GetInt32(candidates.Length);
        IDatabase database = _redis.GetDatabase();
        string operationToken = StableKeyToken(budget.OperationId);
        for (int index = 0; index < candidates.Length; index++)
        {
            PerceptionCharacterV3PoolManifestEntry entry = candidates[(start + index) % candidates.Length];
            RedisResult result;
            try
            {
                result = await database.ScriptEvaluateAsync(
                    BudgetedLeaseScript,
                    [
                        RevocationKey(manifest.GenerationId),
                        EntryKey(manifest.GenerationId, entry.EntryId),
                        InventoryKey(manifest.GenerationId),
                        MinuteKey(manifest.GenerationId, "lease", budget.NowUnixMs),
                        RollingHourKey(manifest.GenerationId),
                        MinuteKey(manifest.GenerationId, "bytes", budget.NowUnixMs),
                        MinuteDimensionKey(manifest.GenerationId, "ip", budget.IpPrefixHash, budget.NowUnixMs),
                        MinuteDimensionKey(manifest.GenerationId, "device", budget.DeviceHash, budget.NowUnixMs),
                        MinuteDimensionKey(manifest.GenerationId, "subject", budget.SubjectHash, budget.NowUnixMs),
                        MinuteDimensionKey(manifest.GenerationId, "action", budget.ActionClass, budget.NowUnixMs),
                        OperationKey(manifest.GenerationId, operationToken)
                    ],
                    [
                        name,
                        entry.ArtifactBytes,
                        budget.NowUnixMs,
                        budget.LeasePerMinute,
                        budget.LeaseRollingHour,
                        budget.EgressBytesPerMinute,
                        budget.EgressBytesRollingHour,
                        budget.IpPrefixPerMinute,
                        budget.DevicePerMinute,
                        budget.SubjectPerMinute,
                        budget.ActionPerMinute,
                        operationToken + ":" + entry.EntryId
                    ]).ConfigureAwait(false);
                if (_discardLeaseReply?.Invoke() == true)
                    throw new DiscardedLeaseReplyException();
            }
            catch (Exception ex) when (ex is RedisException or DiscardedLeaseReplyException)
            {
                throw new PerceptionCharacterV3StoreUnavailableException(ex);
            }
            int outcome = (int)(long)result;
            if (outcome == 1)
                return PerceptionCharacterV3PoolLeaseResult.Success(ReadLease(manifest, entry));
            if (outcome == 0)
                continue;
            return PerceptionCharacterV3PoolLeaseResult.Failed(MapOutcome(outcome));
        }
        return PerceptionCharacterV3PoolLeaseResult.Failed(PerceptionCharacterV3PoolLeaseOutcome.Empty);
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
                entry.ArtifactBytes <= 0 ||
                entry.ArtifactBytes > (entry.Representation == "visual"
                    ? PerceptionCharacterV3Contracts.MaxVisualMediaBytes
                    : PerceptionCharacterV3Contracts.MaxAudioMediaBytes) ||
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
            plaintext.Artifact.Length != entry.ArtifactBytes ||
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

    private async Task InitializeInventoryAsync(PerceptionCharacterV3PoolManifest manifest)
    {
        RedisKey[] keys = new RedisKey[manifest.Entries.Count + 1];
        keys[0] = InventoryKey(manifest.GenerationId);
        RedisValue[] representations = new RedisValue[manifest.Entries.Count];
        for (int index = 0; index < manifest.Entries.Count; index++)
        {
            keys[index + 1] = EntryKey(manifest.GenerationId, manifest.Entries[index].EntryId);
            representations[index] = manifest.Entries[index].Representation;
        }
        try
        {
            await _redis.GetDatabase().ScriptEvaluateAsync(
                InitializeInventoryScript,
                keys,
                representations).ConfigureAwait(false);
        }
        catch (RedisException ex)
        {
            throw new PerceptionCharacterV3StoreUnavailableException(ex);
        }
    }

    private RedisKey InventoryKey(string generationId)
        => _keyScope.PrefixKey($"security:perception-v3-pool:{generationId}:inventory");

    private RedisKey RollingHourKey(string generationId)
        => _keyScope.PrefixKey($"security:perception-v3-pool:{generationId}:budget:rolling-hour");

    private RedisKey MinuteKey(string generationId, string dimension, long nowUnixMs)
        => _keyScope.PrefixKey($"security:perception-v3-pool:{generationId}:budget:{dimension}:minute:{nowUnixMs / 60_000}");

    private RedisKey MinuteDimensionKey(string generationId, string dimension, string value, long nowUnixMs)
        => _keyScope.PrefixKey($"security:perception-v3-pool:{generationId}:quota:{dimension}:{value}:minute:{nowUnixMs / 60_000}");

    private RedisKey OperationKey(string generationId, string operationToken)
        => _keyScope.PrefixKey(
            $"security:perception-v3-pool:{generationId}:budget:operation:{operationToken}");

    private static string StableKeyToken(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static PerceptionCharacterV3PoolLeaseOutcome MapOutcome(int outcome)
        => outcome switch
        {
            -2 => PerceptionCharacterV3PoolLeaseOutcome.Revoked,
            -3 => PerceptionCharacterV3PoolLeaseOutcome.LeaseBudgetExhausted,
            -4 => PerceptionCharacterV3PoolLeaseOutcome.LeaseBudgetExhausted,
            -5 => PerceptionCharacterV3PoolLeaseOutcome.EgressBudgetExhausted,
            -6 => PerceptionCharacterV3PoolLeaseOutcome.EgressBudgetExhausted,
            -7 => PerceptionCharacterV3PoolLeaseOutcome.IpPrefixQuotaExhausted,
            -8 => PerceptionCharacterV3PoolLeaseOutcome.DeviceQuotaExhausted,
            -9 => PerceptionCharacterV3PoolLeaseOutcome.SubjectQuotaExhausted,
            -10 => PerceptionCharacterV3PoolLeaseOutcome.ActionQuotaExhausted,
            -11 => PerceptionCharacterV3PoolLeaseOutcome.AlreadyAccounted,
            _ => PerceptionCharacterV3PoolLeaseOutcome.Unavailable
        };

    private sealed class DiscardedLeaseReplyException : Exception;
}
