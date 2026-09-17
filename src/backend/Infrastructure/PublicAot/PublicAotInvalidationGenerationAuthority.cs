using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Storage;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

/// <summary>Durable, scope-bound source of truth for Public AOT invalidation coordinates.</summary>
public interface IPublicAotInvalidationGenerationAuthority
{
    Task<PublicAotInvalidationGenerationState> LoadAsync(CancellationToken cancellationToken);
    Task<PublicAotInvalidationGenerationState> MarkAsync(
        string kind,
        string key,
        string? mutationId,
        CancellationToken cancellationToken);
    Task<PublicAotInvalidationGenerationState> CompactAsync(
        IReadOnlySet<string> artifactKeys,
        IReadOnlySet<string> prefixKeys,
        CancellationToken cancellationToken);
}

public sealed class PublicAotInvalidationGenerationStartupValidator(
    PublicAotInvalidationTracker tracker) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
        => tracker.InitializeAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed record PublicAotInvalidationGenerationState(
    string RuntimeScope,
    long AllGeneration,
    IReadOnlyDictionary<string, long> KeyGenerations,
    IReadOnlyDictionary<string, long> PrefixGenerations,
    string LastMutationId,
    DateTimeOffset UpdatedAt,
    string ContentDigest)
{
    public long Current(string key, string prefix)
        => Math.Max(
            KeyGenerations.GetValueOrDefault(PublicAotInvalidationGenerationStateCodec.AllCoordinate),
            Math.Max(
                KeyGenerations.GetValueOrDefault(key),
                PrefixGenerations.GetValueOrDefault(prefix)));
}

/// <summary>Only for focused unit tests; production registration always uses Redis.</summary>
public sealed class InMemoryPublicAotInvalidationGenerationAuthority : IPublicAotInvalidationGenerationAuthority
{
    private readonly object _gate = new();
    private PublicAotInvalidationGenerationState _state =
        PublicAotInvalidationGenerationStateCodec.CreateEmpty("test");

    internal PublicAotInvalidationGenerationState Current
    {
        get
        {
            lock (_gate)
                return _state;
        }
    }

    public Task<PublicAotInvalidationGenerationState> LoadAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
            return Task.FromResult(_state);
    }

    public Task<PublicAotInvalidationGenerationState> MarkAsync(
        string kind,
        string key,
        string? mutationId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            _state = PublicAotInvalidationGenerationStateCodec.Mutate(
                _state,
                kind,
                key,
                mutationId);
            return Task.FromResult(_state);
        }
    }

    public Task<PublicAotInvalidationGenerationState> CompactAsync(
        IReadOnlySet<string> artifactKeys,
        IReadOnlySet<string> prefixKeys,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_gate)
        {
            _state = PublicAotInvalidationGenerationStateCodec.Compact(_state, artifactKeys, prefixKeys);
            return Task.FromResult(_state);
        }
    }
}

public interface IPublicAotInvalidationGenerationBootstrapGuard
{
    void PrepareInitialBootstrap();
    void RecordInitialized(PublicAotInvalidationGenerationState state);
}

/// <summary>
/// Persists a release-scoped witness after the first successful Redis bootstrap.
/// Redis state is still the sole generation authority; the witness only prevents
/// a missing/evicted Redis key from being mistaken for a safe generation-zero
/// deployment. Retained release roots are checked for an earlier witness.
/// </summary>
public sealed class FilePublicAotInvalidationGenerationBootstrapGuard :
    IPublicAotInvalidationGenerationBootstrapGuard
{
    internal const string MissingStateAfterInitializationError =
        "public-aot-invalidation-generation-state-missing-after-initialization";
    private const string WitnessDirectoryName = ".generation-authority";
    private const string WitnessSchema = "fsusblog.public-aot-invalidation-bootstrap.v1";
    private const string InitializingPhase = "initializing";
    private const string InitializedPhase = "initialized";
    private readonly object _gate = new();
    private readonly string _currentAotRoot;
    private readonly string? _releaseDerivedBase;
    private readonly string _runtimeScope;
    private readonly string _witnessFileName;
    private bool _initializedObserved;

    public FilePublicAotInvalidationGenerationBootstrapGuard(
        IWebHostEnvironment environment,
        IConfiguration configuration,
        IRuntimeKeyScope runtimeKeyScope)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(runtimeKeyScope);

        _runtimeScope = NormalizeScope(runtimeKeyScope.ScopeToken);
        string? releaseDerivedBase = configuration["FSUSBLOG_RELEASE_DERIVED_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT");
        string? releaseId = configuration["FSUSBLOG_RELEASE_ID"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID");
        if (!string.IsNullOrWhiteSpace(releaseDerivedBase) || !string.IsNullOrWhiteSpace(releaseId))
        {
            if (string.IsNullOrWhiteSpace(releaseDerivedBase) || string.IsNullOrWhiteSpace(releaseId))
            {
                throw new InvalidOperationException(
                    "Public AOT generation bootstrap requires both FSUSBLOG_RELEASE_DERIVED_ROOT and FSUSBLOG_RELEASE_ID.");
            }

            _releaseDerivedBase = Path.TrimEndingDirectorySeparator(Path.GetFullPath(releaseDerivedBase));
            _currentAotRoot = ReleaseStorageLayout.BuildReleaseDerivedPath(
                _releaseDerivedBase,
                releaseId,
                "public-aot");
        }
        else
        {
            if (environment.IsProduction())
            {
                throw new InvalidOperationException(
                    "Production Public AOT generation bootstrap requires release-derived storage.");
            }

            _currentAotRoot = PublicAotFileShellCache.ResolveCacheRootForTests(
                environment,
                releaseDerivedRoot: null,
                releaseId: null);
        }

        _witnessFileName = string.Concat(
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_runtimeScope))),
            ".json");
    }

    internal FilePublicAotInvalidationGenerationBootstrapGuard(
        string currentAotRoot,
        string? releaseDerivedBase,
        string runtimeScope)
    {
        _currentAotRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(currentAotRoot));
        _releaseDerivedBase = string.IsNullOrWhiteSpace(releaseDerivedBase)
            ? null
            : Path.TrimEndingDirectorySeparator(Path.GetFullPath(releaseDerivedBase));
        _runtimeScope = NormalizeScope(runtimeScope);
        _witnessFileName = string.Concat(
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_runtimeScope))),
            ".json");
    }

    public void PrepareInitialBootstrap()
    {
        lock (_gate)
        {
            if (_initializedObserved)
            {
                throw new InvalidOperationException(MissingStateAfterInitializationError);
            }

            PublicAotInvalidationBootstrapWitness? current = ReadCurrentWitness();
            if (current is not null)
            {
                if (string.Equals(current.Phase, InitializedPhase, StringComparison.Ordinal))
                {
                    _initializedObserved = true;
                    throw new InvalidOperationException(MissingStateAfterInitializationError);
                }

                if (string.Equals(current.Phase, InitializingPhase, StringComparison.Ordinal))
                {
                    if (HasRetainedPublicAotArtifactEvidence())
                    {
                        throw new InvalidOperationException(
                            "public-aot-invalidation-generation-bootstrap-refused-existing-artifacts");
                    }

                    return;
                }

                throw InvalidWitness();
            }

            if (ReadRetainedWitnesses().Any())
            {
                _initializedObserved = true;
                throw new InvalidOperationException(MissingStateAfterInitializationError);
            }

            if (HasRetainedPublicAotArtifactEvidence())
            {
                throw new InvalidOperationException(
                    "public-aot-invalidation-generation-bootstrap-refused-existing-artifacts");
            }

            Directory.CreateDirectory(GetWitnessDirectory(_currentAotRoot));
            PublicAotInvalidationBootstrapWitness initializing = SealWitness(
                InitializingPhase,
                DateTimeOffset.UtcNow);
            try
            {
                WriteNewWitness(GetCurrentWitnessPath(), initializing);
            }
            catch (IOException exception)
            {
                PublicAotInvalidationBootstrapWitness raced = ReadCurrentWitness()
                    ?? throw new InvalidOperationException(
                        "public-aot-invalidation-generation-bootstrap-witness-create-failed",
                        exception);
                if (!string.Equals(raced.Phase, InitializingPhase, StringComparison.Ordinal))
                {
                    _initializedObserved = true;
                    throw new InvalidOperationException(MissingStateAfterInitializationError);
                }
            }
        }
    }

    public void RecordInitialized(PublicAotInvalidationGenerationState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        PublicAotInvalidationGenerationStateCodec.Validate(state);
        if (!string.Equals(state.RuntimeScope, _runtimeScope, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "public-aot-invalidation-generation-bootstrap-scope-invalid");
        }

        lock (_gate)
        {
            if (_initializedObserved)
            {
                return;
            }

            PublicAotInvalidationBootstrapWitness? current = ReadCurrentWitness();
            if (current is not null
                && string.Equals(current.Phase, InitializedPhase, StringComparison.Ordinal))
            {
                _initializedObserved = true;
                return;
            }

            Directory.CreateDirectory(GetWitnessDirectory(_currentAotRoot));
            PublicAotInvalidationBootstrapWitness initialized = SealWitness(
                InitializedPhase,
                DateTimeOffset.UtcNow);
            WriteWitnessAtomically(GetCurrentWitnessPath(), initialized);
            _initializedObserved = true;
        }
    }

    private PublicAotInvalidationBootstrapWitness? ReadCurrentWitness()
        => ReadWitness(GetCurrentWitnessPath());

    private IEnumerable<PublicAotInvalidationBootstrapWitness> ReadRetainedWitnesses()
    {
        if (_releaseDerivedBase is null || !Directory.Exists(_releaseDerivedBase))
        {
            yield break;
        }

        string currentPath = Path.GetFullPath(GetCurrentWitnessPath());
        foreach (string releaseRoot in Directory.EnumerateDirectories(_releaseDerivedBase))
        {
            string candidatePath = Path.Combine(
                releaseRoot,
                "public-aot",
                WitnessDirectoryName,
                _witnessFileName);
            if (string.Equals(
                Path.GetFullPath(candidatePath),
                currentPath,
                PathComparison))
            {
                continue;
            }

            PublicAotInvalidationBootstrapWitness? witness = ReadWitness(candidatePath);
            if (witness is not null)
            {
                yield return witness;
            }
        }
    }

    private bool HasRetainedPublicAotArtifactEvidence()
    {
        foreach (string aotRoot in EnumerateAotRoots())
        {
            if (!Directory.Exists(aotRoot))
            {
                continue;
            }

            string witnessRoot = Path.TrimEndingDirectorySeparator(
                Path.GetFullPath(GetWitnessDirectory(aotRoot))) + Path.DirectorySeparatorChar;
            foreach (string file in Directory.EnumerateFiles(aotRoot, "*", SearchOption.AllDirectories))
            {
                if (!Path.GetFullPath(file).StartsWith(witnessRoot, PathComparison))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private IEnumerable<string> EnumerateAotRoots()
    {
        yield return _currentAotRoot;
        if (_releaseDerivedBase is null || !Directory.Exists(_releaseDerivedBase))
        {
            yield break;
        }

        foreach (string releaseRoot in Directory.EnumerateDirectories(_releaseDerivedBase))
        {
            string candidate = Path.Combine(releaseRoot, "public-aot");
            if (!string.Equals(Path.GetFullPath(candidate), Path.GetFullPath(_currentAotRoot), PathComparison))
            {
                yield return candidate;
            }
        }
    }

    private PublicAotInvalidationBootstrapWitness? ReadWitness(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        PublicAotInvalidationBootstrapWitness? witness;
        try
        {
            witness = JsonSerializer.Deserialize<PublicAotInvalidationBootstrapWitness>(
                File.ReadAllBytes(path));
        }
        catch (Exception exception) when (exception is IOException or JsonException)
        {
            throw new InvalidOperationException(
                "public-aot-invalidation-generation-bootstrap-witness-invalid",
                exception);
        }

        if (witness is null
            || !string.Equals(witness.Schema, WitnessSchema, StringComparison.Ordinal)
            || !string.Equals(witness.RuntimeScope, _runtimeScope, StringComparison.Ordinal)
            || (witness.Phase != InitializingPhase && witness.Phase != InitializedPhase)
            || witness.CreatedAt == default
            || !string.Equals(
                witness.ContentDigest,
                DigestWitness(
                    witness.Schema,
                    witness.RuntimeScope,
                    witness.Phase,
                    witness.CreatedAt),
                StringComparison.Ordinal))
        {
            throw InvalidWitness();
        }

        return witness;
    }

    private PublicAotInvalidationBootstrapWitness SealWitness(
        string phase,
        DateTimeOffset createdAt)
        => new(
            WitnessSchema,
            _runtimeScope,
            phase,
            createdAt,
            DigestWitness(WitnessSchema, _runtimeScope, phase, createdAt));

    private static string DigestWitness(
        string schema,
        string runtimeScope,
        string phase,
        DateTimeOffset createdAt)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
            string.Join(
                '\n',
                schema,
                runtimeScope,
                phase,
                createdAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)))));

    private static void WriteNewWitness(
        string path,
        PublicAotInvalidationBootstrapWitness witness)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(witness);
        using var stream = new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.Read,
            bufferSize: 4096,
            FileOptions.WriteThrough);
        stream.Write(payload);
        stream.Flush(flushToDisk: true);
    }

    private static void WriteWitnessAtomically(
        string path,
        PublicAotInvalidationBootstrapWitness witness)
    {
        string directory = Path.GetDirectoryName(path)!;
        string temporaryPath = Path.Combine(
            directory,
            string.Concat(Path.GetFileName(path), ".", Guid.NewGuid().ToString("N"), ".tmp"));
        try
        {
            byte[] payload = JsonSerializer.SerializeToUtf8Bytes(witness);
            using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 4096,
                FileOptions.WriteThrough))
            {
                stream.Write(payload);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temporaryPath, path, overwrite: true);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }

    private string GetCurrentWitnessPath()
        => Path.Combine(GetWitnessDirectory(_currentAotRoot), _witnessFileName);

    private static string GetWitnessDirectory(string aotRoot)
        => Path.Combine(aotRoot, WitnessDirectoryName);

    private static string NormalizeScope(string scope)
        => string.IsNullOrWhiteSpace(scope) ? "default" : scope;

    private static InvalidOperationException InvalidWitness()
        => new("public-aot-invalidation-generation-bootstrap-witness-invalid");

    private static StringComparison PathComparison
        => OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

    private sealed record PublicAotInvalidationBootstrapWitness(
        string Schema,
        string RuntimeScope,
        string Phase,
        DateTimeOffset CreatedAt,
        string ContentDigest);
}

public sealed class RedisPublicAotInvalidationGenerationAuthority :
    IPublicAotInvalidationGenerationAuthority
{
    internal const string StateKey = "public-aot:invalidation-generation:v1";
    private const int MaxCompareAndSetAttempts = 1024;
    private static readonly LuaScript s_compareAndSet = LuaScript.Prepare(
        "local current = redis.call('GET', @key); " +
        "if current ~= @expected then return 0; end; " +
        "redis.call('SET', @key, @replacement); return 1;");
    private readonly IRedisOperationExecutor _redisOperations;
    private readonly RedisKey _key;
    private readonly string _runtimeScope;
    private readonly IPublicAotInvalidationGenerationBootstrapGuard _bootstrapGuard;

    public RedisPublicAotInvalidationGenerationAuthority(
        IRedisOperationExecutor redisOperations,
        IRuntimeKeyScope runtimeKeyScope,
        IPublicAotInvalidationGenerationBootstrapGuard bootstrapGuard)
    {
        ArgumentNullException.ThrowIfNull(redisOperations);
        ArgumentNullException.ThrowIfNull(runtimeKeyScope);
        ArgumentNullException.ThrowIfNull(bootstrapGuard);
        _redisOperations = redisOperations;
        _key = runtimeKeyScope.PrefixKey(StateKey);
        _runtimeScope = string.IsNullOrWhiteSpace(runtimeKeyScope.ScopeToken)
            ? "default"
            : runtimeKeyScope.ScopeToken;
        _bootstrapGuard = bootstrapGuard;
    }

    public Task<PublicAotInvalidationGenerationState> LoadAsync(CancellationToken cancellationToken)
        => _redisOperations.ExecuteAsync(
            RedisOperationPort.PublicAotGeneration,
            LoadCoreAsync,
            cancellationToken);

    private async Task<PublicAotInvalidationGenerationState> LoadCoreAsync(
        IConnectionMultiplexer redis,
        CancellationToken cancellationToken)
    {
        IDatabase database = redis.GetDatabase();
        RedisValue payload = await database
            .StringGetAsync(_key, CommandFlags.DemandMaster)
            .WaitAsync(cancellationToken)
            .ConfigureAwait(false);
        if (payload.IsNullOrEmpty)
        {
            try
            {
                _bootstrapGuard.PrepareInitialBootstrap();
            }
            catch (InvalidOperationException exception) when (string.Equals(
                exception.Message,
                FilePublicAotInvalidationGenerationBootstrapGuard.MissingStateAfterInitializationError,
                StringComparison.Ordinal))
            {
                payload = await database
                    .StringGetAsync(_key, CommandFlags.DemandMaster)
                    .WaitAsync(cancellationToken)
                    .ConfigureAwait(false);
                if (payload.IsNullOrEmpty)
                {
                    throw;
                }
            }

            if (payload.IsNullOrEmpty)
            {
                PublicAotInvalidationGenerationState initial =
                    PublicAotInvalidationGenerationStateCodec.CreateEmpty(_runtimeScope);
                _ = await database
                    .StringSetAsync(
                        _key,
                        PublicAotInvalidationGenerationStateCodec.Serialize(initial),
                        expiry: null,
                        when: When.NotExists,
                        flags: CommandFlags.DemandMaster)
                    .WaitAsync(cancellationToken)
                    .ConfigureAwait(false);
                payload = await database
                    .StringGetAsync(_key, CommandFlags.DemandMaster)
                    .WaitAsync(cancellationToken)
                    .ConfigureAwait(false);
            }
            if (payload.IsNullOrEmpty)
            {
                throw new InvalidOperationException(
                    "public-aot-invalidation-generation-bootstrap-store-missing");
            }
        }

        PublicAotInvalidationGenerationState state =
            PublicAotInvalidationGenerationStateCodec.Deserialize((string)payload!);
        if (!string.Equals(state.RuntimeScope, _runtimeScope, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "public-aot-invalidation-generation-scope-invalid");
        }

        _bootstrapGuard.RecordInitialized(state);
        return state;
    }

    public Task<PublicAotInvalidationGenerationState> MarkAsync(
        string kind,
        string key,
        string? mutationId,
        CancellationToken cancellationToken)
        => CompareAndSetAsync(current =>
            PublicAotInvalidationGenerationStateCodec.Mutate(
                current,
                kind,
                key,
                mutationId), cancellationToken);

    public Task<PublicAotInvalidationGenerationState> CompactAsync(
        IReadOnlySet<string> artifactKeys,
        IReadOnlySet<string> prefixKeys,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(artifactKeys);
        ArgumentNullException.ThrowIfNull(prefixKeys);
        return CompareAndSetAsync(current =>
            PublicAotInvalidationGenerationStateCodec.Compact(
                current,
                artifactKeys,
                prefixKeys), cancellationToken);
    }

    private Task<PublicAotInvalidationGenerationState> CompareAndSetAsync(
        Func<PublicAotInvalidationGenerationState, PublicAotInvalidationGenerationState> mutation,
        CancellationToken cancellationToken)
        => _redisOperations.ExecuteAsync(
            RedisOperationPort.PublicAotGeneration,
            async (redis, token) =>
            {
                IDatabase database = redis.GetDatabase();
                for (int attempt = 0; attempt < MaxCompareAndSetAttempts; attempt++)
                {
                    token.ThrowIfCancellationRequested();
                    PublicAotInvalidationGenerationState current = await LoadFromDatabaseAsync(database, token)
                        .ConfigureAwait(false);
                    PublicAotInvalidationGenerationState next = mutation(current);
                    RedisResult result = await database
                        .ScriptEvaluateAsync(
                            s_compareAndSet,
                            new
                            {
                                key = _key,
                                expected = PublicAotInvalidationGenerationStateCodec.Serialize(current),
                                replacement = PublicAotInvalidationGenerationStateCodec.Serialize(next)
                            },
                            CommandFlags.DemandMaster)
                        .WaitAsync(token)
                        .ConfigureAwait(false);
                    if ((long)result == 1)
                    {
                        return next;
                    }

                    if ((attempt & 15) == 15)
                    {
                        await Task.Yield();
                    }
                }

                throw new InvalidOperationException(
                    "public-aot-invalidation-generation-cas-failed");
            },
            cancellationToken);

    private async Task<PublicAotInvalidationGenerationState> LoadFromDatabaseAsync(
        IDatabase database,
        CancellationToken cancellationToken)
    {
        RedisValue payload = await database
            .StringGetAsync(_key, CommandFlags.DemandMaster)
            .WaitAsync(cancellationToken)
            .ConfigureAwait(false);
        if (payload.IsNullOrEmpty)
        {
            _bootstrapGuard.PrepareInitialBootstrap();
            PublicAotInvalidationGenerationState initial =
                PublicAotInvalidationGenerationStateCodec.CreateEmpty(_runtimeScope);
            _ = await database
                .StringSetAsync(
                    _key,
                    PublicAotInvalidationGenerationStateCodec.Serialize(initial),
                    expiry: null,
                    when: When.NotExists,
                    flags: CommandFlags.DemandMaster)
                .WaitAsync(cancellationToken)
                .ConfigureAwait(false);
            payload = await database
                .StringGetAsync(_key, CommandFlags.DemandMaster)
                .WaitAsync(cancellationToken)
                .ConfigureAwait(false);
            if (payload.IsNullOrEmpty)
            {
                throw new InvalidOperationException(
                    "public-aot-invalidation-generation-bootstrap-store-missing");
            }
        }

        PublicAotInvalidationGenerationState state =
            PublicAotInvalidationGenerationStateCodec.Deserialize((string)payload!);
        if (!string.Equals(state.RuntimeScope, _runtimeScope, StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "public-aot-invalidation-generation-scope-invalid");
        }
        _bootstrapGuard.RecordInitialized(state);
        return state;
    }
}

public sealed class PublicAotInvalidationGenerationCompactionWorker(
    IPublicAotInvalidationGenerationAuthority authority,
    IRedisOperationExecutor redisOperations,
    ILogger<PublicAotInvalidationGenerationCompactionWorker> logger) : BackgroundService
{
    private static readonly TimeSpan s_interval = TimeSpan.FromMinutes(15);

    internal async Task<PublicAotInvalidationGenerationState> CompactOnceAsync(
        CancellationToken cancellationToken)
    {
        PublicAotInvalidationGenerationState state = await authority
            .LoadAsync(cancellationToken)
            .ConfigureAwait(false);
        HashSet<string> artifactKeys = await redisOperations.ExecuteAsync(
                RedisOperationPort.PublicAotShellMaintenance,
                async (redis, token) =>
                {
                    IDatabase database = redis.GetDatabase();
                    if (!await database
                        .KeyExistsAsync(
                            PublicAotCacheRegistry.GlobalRegistryKey,
                            CommandFlags.DemandMaster)
                        .WaitAsync(token)
                        .ConfigureAwait(false))
                    {
                        throw new InvalidOperationException(
                            "public-aot-invalidation-generation-compaction-registry-missing");
                    }

                    var keys = new HashSet<string>(StringComparer.Ordinal);
                    await foreach (RedisValue registered in database
                        .SetScanAsync(
                            PublicAotCacheRegistry.GlobalRegistryKey,
                            pageSize: 256,
                            flags: CommandFlags.DemandMaster)
                        .WithCancellation(token)
                        .ConfigureAwait(false))
                    {
                        if (!registered.IsNullOrEmpty
                            && TryRemoveInvalidationVersion((string)registered!, out string artifactKey))
                        {
                            keys.Add(artifactKey);
                        }
                    }
                    return keys;
                },
                cancellationToken)
            .ConfigureAwait(false);

        var prefixKeys = state.PrefixGenerations.Keys
            .Where(prefix => artifactKeys.Any(key =>
                key.StartsWith(prefix, StringComparison.Ordinal)))
            .ToHashSet(StringComparer.Ordinal);
        return await authority
            .CompactAsync(artifactKeys, prefixKeys, cancellationToken)
            .ConfigureAwait(false);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                _ = await CompactOnceAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                logger.LogError(
                    exception,
                    "public-aot-invalidation-generation-compaction-failed");
            }

            await Task.Delay(s_interval, stoppingToken).ConfigureAwait(false);
        }
    }

    internal static bool TryRemoveInvalidationVersion(
        string cacheKey,
        out string artifactKey)
    {
        artifactKey = string.Empty;
        int suffix = cacheKey.LastIndexOf(":iv:", StringComparison.Ordinal);
        if (suffix <= 0
            || !long.TryParse(
                cacheKey.AsSpan(suffix + 4),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out long generation)
            || generation < 0)
        {
            return false;
        }

        artifactKey = cacheKey[..suffix];
        return true;
    }
}

internal static class PublicAotInvalidationGenerationStateCodec
{
    internal const string AllCoordinate = "__all__";
    internal const string SitemapCoordinate = "__sitemap__";

    public static PublicAotInvalidationGenerationState CreateEmpty(string scope)
        => Seal(
            scope,
            0,
            new Dictionary<string, long>(StringComparer.Ordinal),
            new Dictionary<string, long>(StringComparer.Ordinal),
            "bootstrap",
            DateTimeOffset.UtcNow);

    internal static PublicAotInvalidationGenerationState SealForTests(
        string scope,
        long all,
        IReadOnlyDictionary<string, long> keys,
        IReadOnlyDictionary<string, long> prefixes,
        string mutationId = "test-mutation")
        => Seal(
            scope,
            all,
            keys,
            prefixes,
            mutationId,
            DateTimeOffset.UtcNow);

    public static PublicAotInvalidationGenerationState Mutate(
        PublicAotInvalidationGenerationState current,
        string kind,
        string key,
        string? mutationId = null)
    {
        Validate(current);
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new InvalidOperationException(
                "public-aot-invalidation-generation-coordinate-invalid");
        }

        bool extendsCurrentMutation = !string.IsNullOrWhiteSpace(mutationId)
            && string.Equals(current.LastMutationId, mutationId, StringComparison.Ordinal);
        long generation = extendsCurrentMutation
            ? current.AllGeneration
            : checked(current.AllGeneration + 1);
        var keys = new Dictionary<string, long>(
            current.KeyGenerations,
            StringComparer.Ordinal);
        var prefixes = new Dictionary<string, long>(
            current.PrefixGenerations,
            StringComparer.Ordinal);
        switch (kind)
        {
            case "all" when string.Equals(key, AllCoordinate, StringComparison.Ordinal):
                keys[AllCoordinate] = generation;
                break;
            case "key" when !string.Equals(key, AllCoordinate, StringComparison.Ordinal):
                keys[key] = generation;
                break;
            case "prefix" when !string.Equals(key, AllCoordinate, StringComparison.Ordinal):
                prefixes[key] = generation;
                break;
            default:
                throw new InvalidOperationException(
                    "public-aot-invalidation-generation-kind-invalid");
        }

        if (extendsCurrentMutation
            && current.KeyGenerations.Count == keys.Count
            && current.PrefixGenerations.Count == prefixes.Count
            && current.KeyGenerations.All(pair => keys.GetValueOrDefault(pair.Key) == pair.Value)
            && current.PrefixGenerations.All(pair => prefixes.GetValueOrDefault(pair.Key) == pair.Value))
        {
            return current;
        }

        return Seal(
            current.RuntimeScope,
            generation,
            keys,
            prefixes,
            string.IsNullOrWhiteSpace(mutationId)
                ? Guid.NewGuid().ToString("N")
                : mutationId,
            NextUpdatedAt(current.UpdatedAt));
    }

    public static PublicAotInvalidationGenerationState Compact(
        PublicAotInvalidationGenerationState current,
        IReadOnlySet<string> artifactKeys,
        IReadOnlySet<string> prefixKeys)
    {
        Validate(current);
        var keys = current.KeyGenerations
            .Where(pair =>
                string.Equals(pair.Key, AllCoordinate, StringComparison.Ordinal)
                || string.Equals(pair.Key, SitemapCoordinate, StringComparison.Ordinal)
                || artifactKeys.Contains(pair.Key))
            .ToDictionary(
                static pair => pair.Key,
                static pair => pair.Value,
                StringComparer.Ordinal);
        var prefixes = current.PrefixGenerations
            .Where(pair => prefixKeys.Contains(pair.Key))
            .ToDictionary(
                static pair => pair.Key,
                static pair => pair.Value,
                StringComparer.Ordinal);
        return Seal(
            current.RuntimeScope,
            current.AllGeneration,
            keys,
            prefixes,
            current.LastMutationId,
            current.UpdatedAt);
    }

    public static string Serialize(PublicAotInvalidationGenerationState state)
        => JsonSerializer.Serialize(state);

    public static PublicAotInvalidationGenerationState Deserialize(string payload)
    {
        PublicAotInvalidationGenerationState? state;
        try
        {
            state = JsonSerializer.Deserialize<PublicAotInvalidationGenerationState>(payload);
        }
        catch (JsonException exception)
        {
            throw new InvalidOperationException(
                "public-aot-invalidation-generation-store-invalid",
                exception);
        }

        if (state is null)
        {
            throw new InvalidOperationException(
                "public-aot-invalidation-generation-store-invalid");
        }

        Validate(state);
        return state;
    }

    private static PublicAotInvalidationGenerationState Seal(
        string scope,
        long all,
        IReadOnlyDictionary<string, long> keys,
        IReadOnlyDictionary<string, long> prefixes,
        string mutationId,
        DateTimeOffset updatedAt)
    {
        string digest = Digest(
            scope,
            all,
            keys,
            prefixes,
            mutationId,
            updatedAt);
        return new PublicAotInvalidationGenerationState(
            scope,
            all,
            keys,
            prefixes,
            mutationId,
            updatedAt,
            digest);
    }

    internal static void Validate(PublicAotInvalidationGenerationState state)
    {
        if (string.IsNullOrWhiteSpace(state.RuntimeScope)
            || state.AllGeneration < 0
            || state.KeyGenerations is null
            || state.PrefixGenerations is null
            || string.IsNullOrWhiteSpace(state.LastMutationId)
            || state.UpdatedAt == default
            || !CoordinatesAreValid(
                state.KeyGenerations,
                state.AllGeneration,
                allowAllCoordinate: true)
            || !CoordinatesAreValid(
                state.PrefixGenerations,
                state.AllGeneration,
                allowAllCoordinate: false)
            || state.PrefixGenerations.ContainsKey(SitemapCoordinate)
            || (state.AllGeneration == 0
                && (state.KeyGenerations.Count != 0
                    || state.PrefixGenerations.Count != 0
                    || !string.Equals(
                        state.LastMutationId,
                        "bootstrap",
                        StringComparison.Ordinal)))
            || !string.Equals(
                state.ContentDigest,
                Digest(
                    state.RuntimeScope,
                    state.AllGeneration,
                    state.KeyGenerations,
                    state.PrefixGenerations,
                    state.LastMutationId,
                    state.UpdatedAt),
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "public-aot-invalidation-generation-store-invalid");
        }
    }

    private static bool CoordinatesAreValid(
        IReadOnlyDictionary<string, long> coordinates,
        long allGeneration,
        bool allowAllCoordinate)
        => coordinates.All(pair =>
            !string.IsNullOrWhiteSpace(pair.Key)
            && (allowAllCoordinate
                || !string.Equals(pair.Key, AllCoordinate, StringComparison.Ordinal))
            && pair.Value > 0
            && pair.Value <= allGeneration);

    private static DateTimeOffset NextUpdatedAt(DateTimeOffset current)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return now > current ? now : current.AddTicks(1);
    }

    private static string Digest(
        string scope,
        long all,
        IReadOnlyDictionary<string, long> keys,
        IReadOnlyDictionary<string, long> prefixes,
        string mutationId,
        DateTimeOffset updatedAt)
    {
        string canonical = string.Join(
            '\n',
            new[]
            {
                scope,
                all.ToString(CultureInfo.InvariantCulture),
                mutationId,
                updatedAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)
            }
            .Concat(keys
                .OrderBy(static pair => pair.Key, StringComparer.Ordinal)
                .Select(static pair => string.Concat(
                    "k:",
                    pair.Key,
                    ":",
                    pair.Value.ToString(CultureInfo.InvariantCulture))))
            .Concat(prefixes
                .OrderBy(static pair => pair.Key, StringComparer.Ordinal)
                .Select(static pair => string.Concat(
                    "p:",
                    pair.Key,
                    ":",
                    pair.Value.ToString(CultureInfo.InvariantCulture)))));
        return Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }
}
