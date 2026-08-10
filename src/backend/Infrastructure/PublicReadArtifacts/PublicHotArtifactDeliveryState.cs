using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Cache;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

// The channel is deliberately not a delivery log.  This record is the durable
// recovery contract and is kept in one Redis Cluster slot so every transition is
// compare-and-set atomic.
public enum PublicHotArtifactObligationState
{
    Pending, Processing, Published, FailedRetryable, FailedTerminal
}
public enum PublicHotArtifactFailureKind
{
    None, ProjectorTransient, PublishTransient, RevocationTransient, Cancelled, Terminal
}
public enum PublicHotArtifactAttemptStage
{
    Projector, Publish, RevocationCompletion, Completion
}

public sealed record PublicHotArtifactAttemptEvidence(
    int AttemptNumber, PublicHotArtifactAttemptStage Stage, PublicHotArtifactFailureKind FailureKind,
    DateTimeOffset RecordedAt, string Detail);

public sealed record PublicHotArtifactObligation(
    string ObligationId, long TargetGeneration, PublicHotArtifactDirtyReason DirtyReasons,
    IReadOnlyList<int> ArticleIds, bool RequiresFullRebuild, IReadOnlyDictionary<int, long> ExpectedReleaseIds,
    int AttemptNumber, PublicHotArtifactObligationState State, PublicHotArtifactFailureKind LastFailureKind,
    DateTimeOffset NextEligibleAt, IReadOnlyList<PublicHotArtifactAttemptEvidence> Attempts,
    long PublishedGeneration = 0)
{
    public bool Recovered => AttemptNumber > 1;
    public bool IsTerminal => State == PublicHotArtifactObligationState.FailedTerminal;
}

public static class PublicHotArtifactFailureRegistry
{
    public static PublicHotArtifactFailureKind Classify(PublicHotArtifactAttemptStage stage, Exception exception)
        => exception is OperationCanceledException ? PublicHotArtifactFailureKind.Cancelled
         : exception is ArgumentException or InvalidDataException ? PublicHotArtifactFailureKind.Terminal
         : stage switch
         {
             PublicHotArtifactAttemptStage.Projector => PublicHotArtifactFailureKind.ProjectorTransient,
             PublicHotArtifactAttemptStage.Publish => PublicHotArtifactFailureKind.PublishTransient,
             PublicHotArtifactAttemptStage.RevocationCompletion => PublicHotArtifactFailureKind.RevocationTransient,
             _ => PublicHotArtifactFailureKind.Terminal
         };

    public static bool IsRetryable(PublicHotArtifactFailureKind kind)
        => kind is PublicHotArtifactFailureKind.ProjectorTransient
            or PublicHotArtifactFailureKind.PublishTransient
            or PublicHotArtifactFailureKind.RevocationTransient
            or PublicHotArtifactFailureKind.Cancelled;
}

public interface IPublicHotArtifactDeliveryStateStore
{
    Task<long> MarkDirtyAsync(PublicHotArtifactDeliveryClass deliveryClass, CancellationToken cancellationToken);
    Task<long> GetPendingGenerationAsync(CancellationToken cancellationToken);
    Task CompleteAsync(long generation, CancellationToken cancellationToken);
}

public interface IPublicHotArtifactObligationStore
{
    Task<PublicHotArtifactObligation> MergeAsync(PublicHotArtifactUpdate update, CancellationToken cancellationToken);
    Task<PublicHotArtifactObligation?> ClaimEligibleAsync(DateTimeOffset now, CancellationToken cancellationToken);
    Task RecoverInterruptedAsync(DateTimeOffset now, CancellationToken cancellationToken);
    Task<bool> CompletePublishedAsync(string obligationId, int attemptNumber, long publishedGeneration, CancellationToken cancellationToken);
    Task RecordStageSuccessAsync(string obligationId, int attemptNumber, PublicHotArtifactAttemptStage stage, DateTimeOffset now, CancellationToken cancellationToken);
    Task<PublicHotArtifactObligation> RecordFailureAsync(string obligationId, int attemptNumber, PublicHotArtifactAttemptStage stage, Exception exception, DateTimeOffset now, int maximumAttempts, CancellationToken cancellationToken);
    Task<PublicHotArtifactObligation?> GetActiveAsync(CancellationToken cancellationToken);
    Task<bool> HasTerminalFailureAsync(CancellationToken cancellationToken);
}

internal sealed class InMemoryPublicHotArtifactDeliveryStateStore : IPublicHotArtifactDeliveryStateStore, IPublicHotArtifactObligationStore
{
    private readonly object _gate = new();
    private long _generation;
    private long _pending;
    private PublicHotArtifactObligation? _active;

    public Task<long> MarkDirtyAsync(
        PublicHotArtifactDeliveryClass deliveryClass,
        CancellationToken ct)
    {
        _ = deliveryClass;
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            long generation = ++_generation;
            _pending = Math.Max(_pending, generation);
            return Task.FromResult(generation);
        }
    }
    public Task<long> GetPendingGenerationAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
            return Task.FromResult(_pending);
    }
    public Task CompleteAsync(long generation, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_pending <= generation)
                _pending = 0;
        }
        return Task.CompletedTask;
    }
    public Task<PublicHotArtifactObligation> MergeAsync(PublicHotArtifactUpdate update, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            long generation = update.DeliveryGeneration > 0 ? update.DeliveryGeneration : ++_generation;
            if (_active is null || _active.State == PublicHotArtifactObligationState.Published)
                _active = New("memory-" + generation, generation, update);
            else
                _active = Merge(_active, generation, update);
            _pending = Math.Max(_pending, _active.TargetGeneration);
            return Task.FromResult(_active);
        }
    }
    public Task<PublicHotArtifactObligation?> ClaimEligibleAsync(DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_active is null || _active.IsTerminal || _active.State == PublicHotArtifactObligationState.Processing || _active.State == PublicHotArtifactObligationState.Published || _active.NextEligibleAt > now)
                return Task.FromResult<PublicHotArtifactObligation?>(null);
            _active = _active with
            {
                State = PublicHotArtifactObligationState.Processing,
                AttemptNumber = _active.AttemptNumber + 1
            };
            return Task.FromResult<PublicHotArtifactObligation?>(_active);
        }
    }
    public Task RecoverInterruptedAsync(DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_active?.State == PublicHotArtifactObligationState.Processing)
                _active = _active with
                {
                    State = PublicHotArtifactObligationState.Pending,
                    NextEligibleAt = now
                };
        }
        return Task.CompletedTask;
    }
    public Task<bool> CompletePublishedAsync(string id, int attempt, long published, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_active is null || _active.ObligationId != id || _active.State != PublicHotArtifactObligationState.Processing || _active.AttemptNumber != attempt)
                return Task.FromResult(false);
            var evidence = _active.Attempts.Append(new PublicHotArtifactAttemptEvidence(attempt, PublicHotArtifactAttemptStage.Completion, PublicHotArtifactFailureKind.None, DateTimeOffset.UtcNow, "published")).ToArray();
            if (_active.TargetGeneration > published)
            {
                _active = _active with
                {
                    State = PublicHotArtifactObligationState.Pending,
                    NextEligibleAt = DateTimeOffset.UtcNow,
                    Attempts = evidence
                };
                return Task.FromResult(false);
            }
            _active = _active with
            {
                State = PublicHotArtifactObligationState.Published,
                PublishedGeneration = published,
                NextEligibleAt = DateTimeOffset.MaxValue,
                Attempts = evidence
            };
            _pending = 0;
            return Task.FromResult(true);
        }
    }
    public Task RecordStageSuccessAsync(string id, int attempt, PublicHotArtifactAttemptStage stage, DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_active is null || _active.ObligationId != id || _active.State != PublicHotArtifactObligationState.Processing || _active.AttemptNumber != attempt)
                throw new InvalidOperationException("public-hot obligation compare-and-set lost");
            _active = _active with
            {
                Attempts = _active.Attempts.Append(new(attempt, stage, PublicHotArtifactFailureKind.None, now, "succeeded")).ToArray()
            };
            return Task.CompletedTask;
        }
    }
    public Task<PublicHotArtifactObligation> RecordFailureAsync(string id, int attempt, PublicHotArtifactAttemptStage stage, Exception ex, DateTimeOffset now, int max, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
        {
            if (_active is null
                || _active.ObligationId != id
                || _active.State != PublicHotArtifactObligationState.Processing
                || _active.AttemptNumber != attempt)
            {
                throw new InvalidOperationException("public-hot obligation compare-and-set lost");
            }
            PublicHotArtifactFailureKind kind = PublicHotArtifactFailureRegistry.Classify(stage, ex);
            bool retry = PublicHotArtifactFailureRegistry.IsRetryable(kind) && attempt < max;
            TimeSpan delay = TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, Math.Max(0, attempt - 1))));
            _active = _active with
            {
                State = retry ? PublicHotArtifactObligationState.FailedRetryable : PublicHotArtifactObligationState.FailedTerminal,
                LastFailureKind = kind,
                NextEligibleAt = retry ? now + delay : DateTimeOffset.MaxValue,
                Attempts = _active.Attempts.Append(new(attempt, stage, kind, now, ex.GetType().Name)).ToArray()
            };
            return Task.FromResult(_active);
        }
    }
    public Task<PublicHotArtifactObligation?> GetActiveAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
            return Task.FromResult(_active);
    }
    public Task<bool> HasTerminalFailureAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        lock (_gate)
            return Task.FromResult(_active?.IsTerminal == true);
    }

    private static PublicHotArtifactObligation New(
        string id,
        long generation,
        PublicHotArtifactUpdate update)
        => new(
            id,
            generation,
            update.DirtyReason,
            update.ArticleId is int articleId ? [articleId] : [],
            update.ArticleId is null,
            update.ExpectedReleaseId is long releaseId
                && update.ArticleId is int expectedArticleId
                    ? new Dictionary<int, long> { { expectedArticleId, releaseId } }
                    : new Dictionary<int, long>(),
            0,
            PublicHotArtifactObligationState.Pending,
            PublicHotArtifactFailureKind.None,
            DateTimeOffset.MinValue,
            []);
    private static PublicHotArtifactObligation Merge(PublicHotArtifactObligation o, long g, PublicHotArtifactUpdate u)
    {
        var articles = o.ArticleIds.ToHashSet();
        if (u.ArticleId is int a)
            articles.Add(a);
        var releases = o.ExpectedReleaseIds.ToDictionary();
        if (u.ArticleId is int id && u.ExpectedReleaseId is long r)
            releases[id] = r;
        return o with
        {
            TargetGeneration = Math.Max(o.TargetGeneration, g),
            DirtyReasons = o.DirtyReasons | u.DirtyReason,
            ArticleIds = articles.Order().ToArray(),
            ExpectedReleaseIds = releases,
            RequiresFullRebuild = o.RequiresFullRebuild || u.ArticleId is null,
            State = o.IsTerminal ? PublicHotArtifactObligationState.Pending : o.State,
            LastFailureKind = o.IsTerminal ? PublicHotArtifactFailureKind.None : o.LastFailureKind,
            NextEligibleAt = o.IsTerminal ? DateTimeOffset.MinValue : o.NextEligibleAt
        };
    }
}

internal static class InterlockedExtensions
{
    public static void Max(ref long target, long value)
    {
        long observed = Volatile.Read(ref target);
        while (observed < value)
        {
            long prior = Interlocked.CompareExchange(ref target, value, observed);
            if (prior == observed)
            {
                return;
            }

            observed = prior;
        }
    }
}

public sealed class RedisPublicHotArtifactDeliveryStateStore(IConnectionMultiplexer redis, IRuntimeKeyScope scope) : IPublicHotArtifactDeliveryStateStore, IPublicHotArtifactObligationStore
{
    private const string Base = "public-hot-read:{delivery}:obligation";
    private readonly IDatabase _db = redis.GetDatabase();
    private readonly JsonSerializerOptions _json = CreateJsonOptions();
    private RedisKey Key(string suffix) => scope.PrefixKey(Base + ":" + suffix);
    private RedisKey LegacyKey(string suffix) => scope.PrefixKey("public-hot-read:{delivery}:" + suffix);
    // Lua owns every state transition; JSON is a single durable schema so a record can be inspected/replayed atomically.
    private static readonly LuaScript s_mergeScript = LuaScript.Prepare("local g=redis.call('INCR',KEYS[1]); local id=redis.call('GET',KEYS[2]); local r; if not id then id=tostring(g); r={obligationId=id,targetGeneration=g,dirtyReasons=tonumber(ARGV[3]),articleIds={},requiresFullRebuild=(ARGV[4]=='1'),expectedReleaseIds={},attemptNumber=0,state=0,lastFailureKind=0,nextEligibleAt=0,attempts={},publishedGeneration=0}; redis.call('SET',KEYS[2],id) else local raw=redis.call('GET',KEYS[3]..id); r=cjson.decode(raw); if r.state==2 then id=tostring(g); r={obligationId=id,targetGeneration=g,dirtyReasons=tonumber(ARGV[3]),articleIds={},requiresFullRebuild=(ARGV[4]=='1'),expectedReleaseIds={},attemptNumber=0,state=0,lastFailureKind=0,nextEligibleAt=0,attempts={},publishedGeneration=0}; redis.call('SET',KEYS[2],id) else r.targetGeneration=math.max(r.targetGeneration,g); r.dirtyReasons=bit.bor(r.dirtyReasons,tonumber(ARGV[3])); if r.state==4 then if redis.call('GET',KEYS[4])==id then redis.call('DEL',KEYS[4]) end; r.state=0; r.lastFailureKind=0; r.nextEligibleAt=0 end; if ARGV[4]=='1' then r.requiresFullRebuild=true end end end; if ARGV[1]~='' then local seen=false; for _,v in ipairs(r.articleIds) do if v==tonumber(ARGV[1]) then seen=true end end; if not seen then table.insert(r.articleIds,tonumber(ARGV[1])) end; if ARGV[2]~='' then r.expectedReleaseIds[ARGV[1]]=tonumber(ARGV[2]) end end; redis.call('SET',KEYS[3]..id,cjson.encode(r)); return cjson.encode(r)");
    private static readonly LuaScript s_claimScript = LuaScript.Prepare("local id=redis.call('GET',KEYS[1]); if not id then return false end; local k=KEYS[2]..id; local r=cjson.decode(redis.call('GET',k)); if (r.state~=0 and r.state~=3) or r.nextEligibleAt>tonumber(ARGV[1]) then return false end; r.state=1; r.attemptNumber=r.attemptNumber+1; redis.call('SET',k,cjson.encode(r)); return cjson.encode(r)");
    private static readonly LuaScript s_recoverScript = LuaScript.Prepare("local id=redis.call('GET',KEYS[1]); if not id then return 0 end; local k=KEYS[2]..id; local r=cjson.decode(redis.call('GET',k)); if r.state==1 then r.state=0;r.nextEligibleAt=tonumber(ARGV[1]);redis.call('SET',k,cjson.encode(r));return 1 end;return 0");
    private static readonly LuaScript s_completeScript = LuaScript.Prepare("local id=redis.call('GET',KEYS[1]); if not id or id~=ARGV[1] then return 0 end; local k=KEYS[2]..id; local r=cjson.decode(redis.call('GET',k)); if r.state~=1 or r.attemptNumber~=tonumber(ARGV[2]) then return 0 end; table.insert(r.attempts,{attemptNumber=tonumber(ARGV[2]),stage=3,failureKind=0,recordedAt=tonumber(ARGV[5]),detail='published'}); if r.targetGeneration>tonumber(ARGV[3]) then r.state=0;r.nextEligibleAt=tonumber(ARGV[4]);redis.call('SET',k,cjson.encode(r));return 0 end; r.state=2;r.publishedGeneration=tonumber(ARGV[3]);r.nextEligibleAt='terminal';redis.call('SET',k,cjson.encode(r));return 1");
    private static readonly LuaScript s_successScript = LuaScript.Prepare("local id=redis.call('GET',KEYS[1]); if not id or id~=ARGV[1] then return 0 end; local k=KEYS[2]..id; local r=cjson.decode(redis.call('GET',k)); if r.state~=1 or r.attemptNumber~=tonumber(ARGV[2]) then return 0 end; table.insert(r.attempts,{attemptNumber=tonumber(ARGV[2]),stage=tonumber(ARGV[3]),failureKind=0,recordedAt=tonumber(ARGV[4]),detail='succeeded'});redis.call('SET',k,cjson.encode(r));return 1");
    private static readonly LuaScript s_failureScript = LuaScript.Prepare("local id=redis.call('GET',KEYS[1]); if not id or id~=ARGV[1] then return false end; local k=KEYS[2]..id; local r=cjson.decode(redis.call('GET',k)); if r.state~=1 or r.attemptNumber~=tonumber(ARGV[2]) then return false end; r.state=tonumber(ARGV[3]);r.lastFailureKind=tonumber(ARGV[4]);r.nextEligibleAt=ARGV[5]=='terminal' and 'terminal' or tonumber(ARGV[5]);table.insert(r.attempts,{attemptNumber=tonumber(ARGV[2]),stage=tonumber(ARGV[6]),failureKind=tonumber(ARGV[4]),recordedAt=tonumber(ARGV[7]),detail=ARGV[8]});redis.call('SET',k,cjson.encode(r));if ARGV[9]=='1' then redis.call('SET',KEYS[3],id) end;return cjson.encode(r)");
    private static readonly LuaScript s_legacyMarkScript = LuaScript.Prepare("local g=redis.call('INCR',KEYS[1]);local p=tonumber(redis.call('GET',KEYS[2]) or '0');if g>p then redis.call('SET',KEYS[2],g) end;return g");
    private static readonly LuaScript s_legacyCompleteScript = LuaScript.Prepare("local p=tonumber(redis.call('GET',KEYS[1]) or '0');if p>0 and p<=tonumber(ARGV[1]) then redis.call('DEL',KEYS[1]);return 1 end;return 0");
    public async Task<long> MarkDirtyAsync(PublicHotArtifactDeliveryClass c, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return (long)await _db.ScriptEvaluateAsync(s_legacyMarkScript.ExecutableScript, new RedisKey[] { LegacyKey("generation"), LegacyKey("pending-generation") }).ConfigureAwait(false);
    }
    public async Task<long> GetPendingGenerationAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        PublicHotArtifactObligation? o = await GetActiveAsync(ct);
        if (o is { State: not PublicHotArtifactObligationState.Published })
            return o.TargetGeneration;
        RedisValue legacy = await _db.StringGetAsync(LegacyKey("pending-generation")).ConfigureAwait(false);
        return legacy.IsNullOrEmpty ? 0 : long.TryParse(legacy.ToString(), out long generation) ? generation : throw new InvalidOperationException("public-hot delivery pending generation is corrupt");
    }
    public async Task CompleteAsync(long generation, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        await _db.ScriptEvaluateAsync(s_legacyCompleteScript.ExecutableScript, new RedisKey[] { LegacyKey("pending-generation") }, new RedisValue[] { generation }).ConfigureAwait(false);
    }
    public async Task<PublicHotArtifactObligation> MergeAsync(PublicHotArtifactUpdate u, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        RedisResult result = await _db.ScriptEvaluateAsync(s_mergeScript.ExecutableScript, new RedisKey[] { Key("generation"), Key("active"), Key("record:"), Key("terminal") }, new RedisValue[] { u.ArticleId?.ToString() ?? "", u.ExpectedReleaseId?.ToString() ?? "", (int)u.DirtyReason, u.ArticleId is null ? "1" : "0" }).ConfigureAwait(false);
        return Deserialize((string)result!);
    }
    public async Task<PublicHotArtifactObligation?> ClaimEligibleAsync(DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        RedisResult r = await _db.ScriptEvaluateAsync(s_claimScript.ExecutableScript, new RedisKey[] { Key("active"), Key("record:") }, new RedisValue[] { now.ToUnixTimeMilliseconds() }).ConfigureAwait(false);
        string? serialized = (string?)r;
        return string.IsNullOrEmpty(serialized) ? null : Deserialize(serialized);
    }
    public async Task RecoverInterruptedAsync(DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        await _db.ScriptEvaluateAsync(s_recoverScript.ExecutableScript, new RedisKey[] { Key("active"), Key("record:") }, new RedisValue[] { now.ToUnixTimeMilliseconds() }).ConfigureAwait(false);
    }
    public async Task<bool> CompletePublishedAsync(string id, int attempt, long gen, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return (long)await _db.ScriptEvaluateAsync(s_completeScript.ExecutableScript, new RedisKey[] { Key("active"), Key("record:") }, new RedisValue[] { id, attempt, gen, now, now }).ConfigureAwait(false) == 1;
    }
    public async Task RecordStageSuccessAsync(string id, int attempt, PublicHotArtifactAttemptStage stage, DateTimeOffset now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        long updated = (long)await _db.ScriptEvaluateAsync(s_successScript.ExecutableScript, new RedisKey[] { Key("active"), Key("record:") }, new RedisValue[] { id, attempt, (int)stage, now.ToUnixTimeMilliseconds() }).ConfigureAwait(false);
        if (updated != 1)
            throw new InvalidOperationException("public-hot obligation compare-and-set lost");
    }
    public async Task<PublicHotArtifactObligation> RecordFailureAsync(string id, int attempt, PublicHotArtifactAttemptStage stage, Exception ex, DateTimeOffset now, int max, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        PublicHotArtifactObligation? current = await GetActiveAsync(ct);
        if (current is null || current.ObligationId != id)
            throw new InvalidOperationException("public-hot obligation is missing");
        PublicHotArtifactFailureKind kind = PublicHotArtifactFailureRegistry.Classify(stage, ex);
        bool retry = PublicHotArtifactFailureRegistry.IsRetryable(kind) && attempt < max;
        DateTimeOffset next = retry ? now + TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, Math.Max(0, attempt - 1)))) : DateTimeOffset.MaxValue;
        PublicHotArtifactObligation updated = current with
        {
            State = retry ? PublicHotArtifactObligationState.FailedRetryable : PublicHotArtifactObligationState.FailedTerminal,
            LastFailureKind = kind,
            NextEligibleAt = next,
            Attempts = current.Attempts.Append(new(attempt, stage, kind, now, ex.GetType().Name)).ToArray()
        };
        RedisResult result = await _db.ScriptEvaluateAsync(s_failureScript.ExecutableScript, new RedisKey[] { Key("active"), Key("record:"), Key("terminal") }, new RedisValue[] { id, attempt, (int)updated.State, (int)kind, updated.IsTerminal ? "terminal" : next.ToUnixTimeMilliseconds(), (int)stage, now.ToUnixTimeMilliseconds(), ex.GetType().Name, updated.IsTerminal ? "1" : "0" }).ConfigureAwait(false);
        string? serialized = (string?)result;
        if (string.IsNullOrEmpty(serialized))
            throw new InvalidOperationException("public-hot obligation compare-and-set lost");
        return Deserialize(serialized);
    }
    public async Task<PublicHotArtifactObligation?> GetActiveAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        RedisValue id = await _db.StringGetAsync(Key("active")).ConfigureAwait(false);
        if (id.IsNullOrEmpty)
            return null;
        RedisValue raw = await _db.StringGetAsync(Key("record:" + id)).ConfigureAwait(false);
        return raw.IsNullOrEmpty ? throw new InvalidOperationException("public-hot obligation record is missing") : Deserialize(raw!);
    }
    public async Task<bool> HasTerminalFailureAsync(CancellationToken ct) => (await GetActiveAsync(ct).ConfigureAwait(false))?.IsTerminal == true;
    private PublicHotArtifactObligation Deserialize(string value)
    {
        // Redis cjson encodes an empty Lua table as an object; normalize the two
        // schema collections before binding the durable record.
        string normalized = value
            .Replace("\"articleIds\":{}", "\"articleIds\":[]", StringComparison.Ordinal)
            .Replace("\"attempts\":{}", "\"attempts\":[]", StringComparison.Ordinal);
        return JsonSerializer.Deserialize<PublicHotArtifactObligation>(normalized, _json)
            ?? throw new InvalidOperationException("public-hot obligation record is corrupt");
    }
    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new UnixMillisecondsDateTimeOffsetConverter());
        return options;
    }

    private sealed class UnixMillisecondsDateTimeOffsetConverter : JsonConverter<DateTimeOffset>
    {
        public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            => reader.TokenType == JsonTokenType.String && reader.GetString() == "terminal"
                ? DateTimeOffset.MaxValue
                : DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64());
        public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
        {
            if (value == DateTimeOffset.MaxValue)
            {
                writer.WriteStringValue("terminal");
                return;
            }

            writer.WriteNumberValue(value.ToUnixTimeMilliseconds());
        }
    }
}
