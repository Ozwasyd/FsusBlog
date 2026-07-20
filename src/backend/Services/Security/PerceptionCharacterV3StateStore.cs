using StackExchange.Redis;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Security;

public sealed record PerceptionCharacterV3StateRecord(
    string ChallengeId, string EnvelopeId, string Action, string RouteKey, string SubjectHash, string DeviceBindingHash,
    string ClientIpBindingHash, string PolicyVersion, string MediaHash, string Representation, long IssuedAtUnixMs,
    long ExpiresAtUnixMs, string TokenKeyVersion, string AnswerKeyVersion, string TokenHash);

public enum PerceptionCharacterV3TransitionKind
{
    Success, Retryable, Rejected, ReissueRequired, Unavailable
}
public sealed record PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind Kind, string InternalReason, int Attempts);
public sealed class PerceptionCharacterV3StoreUnavailableException(Exception inner) : Exception("PerceptionCharacterV3 state store is unavailable.", inner);

public interface IPerceptionCharacterV3StateStore
{
    Task<bool> CreateAsync(PerceptionCharacterV3StateRecord record, CancellationToken cancellationToken);
    Task<PerceptionCharacterV3StateRecord?> ReadAsync(string challengeId, CancellationToken cancellationToken);
    Task<PerceptionCharacterV3Transition> VerifyAsync(PerceptionCharacterV3StateRecord expected, bool answerMatches, long nowUnixMs, CancellationToken cancellationToken);
    Task<PerceptionCharacterV3Transition> RevokeAsync(PerceptionCharacterV3StateRecord expected, long nowUnixMs, CancellationToken cancellationToken);
}

public sealed class RedisPerceptionCharacterV3StateStore(IConnectionMultiplexer redis, IRuntimeKeyScope keyScope) : IPerceptionCharacterV3StateStore
{
    private const string TransitionScript = """
local key=KEYS[1]
if redis.call('EXISTS',key)==0 then return {-1,0} end
local attempts=tonumber(redis.call('HGET',key,'attempts') or '0')
local fields={'envelopeId','action','routeKey','subjectHash','deviceHash','ipHash','policyVersion','mediaHash','representation','tokenHash'}
for i,name in ipairs(fields) do if redis.call('HGET',key,name)~=ARGV[i+3] then return {-2,attempts} end end
local status=redis.call('HGET',key,'status')
if status~='active' then
  if status=='expired' or status=='revoked' then return {3,attempts} end
  return {2,attempts}
end
local now=tonumber(ARGV[2]); local expires=tonumber(redis.call('HGET',key,'expiresAt'))
if now>=expires then redis.call('HSET',key,'status','expired'); return {3,attempts} end
if ARGV[1]=='revoke' then redis.call('HSET',key,'status','revoked'); return {4,attempts} end
attempts=redis.call('HINCRBY',key,'attempts',1)
if ARGV[3]=='1' then redis.call('HSET',key,'status','consumed'); return {0,attempts} end
if attempts>=2 then redis.call('HSET',key,'status','exhausted'); return {2,attempts} end
return {1,attempts}
""";

    public async Task<bool> CreateAsync(PerceptionCharacterV3StateRecord r, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            IDatabase db = redis.GetDatabase();
            RedisKey key = Key(r.ChallengeId);
            await db.HashSetAsync(key,
            [
                new("status", "active"), new("attempts", 0), new("envelopeId", r.EnvelopeId), new("action", r.Action), new("routeKey", r.RouteKey),
                new("subjectHash", r.SubjectHash), new("deviceHash", r.DeviceBindingHash), new("ipHash", r.ClientIpBindingHash), new("policyVersion", r.PolicyVersion),
                new("mediaHash", r.MediaHash), new("representation", r.Representation), new("issuedAt", r.IssuedAtUnixMs), new("expiresAt", r.ExpiresAtUnixMs),
                new("tokenKeyVersion", r.TokenKeyVersion), new("answerKeyVersion", r.AnswerKeyVersion), new("tokenHash", r.TokenHash)
            ], CommandFlags.DemandMaster).ConfigureAwait(false);
            TimeSpan ttl = TimeSpan.FromMilliseconds(Math.Max(1000, r.ExpiresAtUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000));
            return await db.KeyExpireAsync(key, ttl, CommandFlags.DemandMaster).ConfigureAwait(false);
        }
        catch (RedisException) { return false; }
    }

    public async Task<PerceptionCharacterV3StateRecord?> ReadAsync(string challengeId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            HashEntry[] e = await redis.GetDatabase().HashGetAllAsync(Key(challengeId), CommandFlags.DemandMaster).ConfigureAwait(false);
            if (e.Length == 0)
                return null;
            var d = e.ToDictionary(x => x.Name.ToString(), x => x.Value.ToString(), StringComparer.Ordinal);
            return new(challengeId, d["envelopeId"], d["action"], d["routeKey"], d["subjectHash"], d["deviceHash"], d["ipHash"], d["policyVersion"], d["mediaHash"], d["representation"], long.Parse(d["issuedAt"], System.Globalization.CultureInfo.InvariantCulture), long.Parse(d["expiresAt"], System.Globalization.CultureInfo.InvariantCulture), d["tokenKeyVersion"], d["answerKeyVersion"], d["tokenHash"]);
        }
        catch (Exception ex) when (ex is RedisException or KeyNotFoundException or FormatException) { throw new PerceptionCharacterV3StoreUnavailableException(ex); }
    }

    public Task<PerceptionCharacterV3Transition> VerifyAsync(PerceptionCharacterV3StateRecord expected, bool answerMatches, long nowUnixMs, CancellationToken cancellationToken)
        => TransitionAsync(expected, "verify", answerMatches, nowUnixMs, cancellationToken);
    public Task<PerceptionCharacterV3Transition> RevokeAsync(PerceptionCharacterV3StateRecord expected, long nowUnixMs, CancellationToken cancellationToken)
        => TransitionAsync(expected, "revoke", false, nowUnixMs, cancellationToken);
    private async Task<PerceptionCharacterV3Transition> TransitionAsync(PerceptionCharacterV3StateRecord x, string operation, bool correct, long now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        try
        {
            RedisResult result = await redis.GetDatabase().ScriptEvaluateAsync(TransitionScript, [Key(x.ChallengeId)],
                [operation, now, correct ? "1" : "0", x.EnvelopeId, x.Action, x.RouteKey, x.SubjectHash, x.DeviceBindingHash, x.ClientIpBindingHash, x.PolicyVersion, x.MediaHash, x.Representation, x.TokenHash], CommandFlags.DemandMaster).ConfigureAwait(false);
            RedisResult[] values = (RedisResult[])result!;
            int code = (int)(long)values[0];
            int attempts = (int)(long)values[1];
            return code switch
            {
                0 => new(PerceptionCharacterV3TransitionKind.Success, "consumed", attempts),
                1 => new(PerceptionCharacterV3TransitionKind.Retryable, "answer_mismatch", attempts),
                4 => new(PerceptionCharacterV3TransitionKind.ReissueRequired, "revoked_now", attempts),
                3 => new(PerceptionCharacterV3TransitionKind.ReissueRequired, "expired_or_revoked", attempts),
                -2 => new(PerceptionCharacterV3TransitionKind.Rejected, "binding_mismatch", attempts),
                _ => new(PerceptionCharacterV3TransitionKind.Rejected, "terminal_or_missing", attempts)
            };
        }
        catch (RedisException) { return new(PerceptionCharacterV3TransitionKind.Unavailable, "redis_unavailable", 0); }
    }
    private RedisKey Key(string id) => keyScope.PrefixKey($"security:perception-v3:{id}");
}

public sealed record PerceptionCharacterV3DeviceAuthorityResult(bool Succeeded, string Binding, string Reason)
{
    public static PerceptionCharacterV3DeviceAuthorityResult Success(string binding) => new(true, binding, "ok");
    public static PerceptionCharacterV3DeviceAuthorityResult Failed(string reason) => new(false, string.Empty, reason);
}

public interface IPerceptionCharacterV3DeviceAuthority
{
    Task<PerceptionCharacterV3DeviceAuthorityResult> ResolveAsync(HttpContext context, string clientIpHash, CancellationToken cancellationToken);
}

public sealed class RedisPerceptionCharacterV3DeviceAuthority(IConnectionMultiplexer redis, IRuntimeKeyScope keyScope) : IPerceptionCharacterV3DeviceAuthority
{
    internal const string CookieName = "__Host-Fsus-Perception-Device";
    private static readonly TimeSpan s_lifetime = TimeSpan.FromDays(30);

    public async Task<PerceptionCharacterV3DeviceAuthorityResult> ResolveAsync(HttpContext context, string clientIpHash, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string? serverSession = context.User.GetAdminSessionId() ?? context.User.GetSessionId();
        if (!string.IsNullOrWhiteSpace(serverSession))
            return PerceptionCharacterV3DeviceAuthorityResult.Success("session:" + serverSession.Trim());
        try
        {
            IDatabase database = redis.GetDatabase();
            string supplied = context.Request.Cookies[CookieName] ?? string.Empty;
            string deviceId;
            if (supplied.Length > 0)
            {
                if (!Guid.TryParseExact(supplied, "D", out Guid parsed) || parsed.Version != 7 || !await database.KeyExistsAsync(DeviceKey(supplied), CommandFlags.DemandMaster).ConfigureAwait(false))
                    return PerceptionCharacterV3DeviceAuthorityResult.Failed("device_binding_invalid");
                deviceId = supplied;
            }
            else
            {
                RedisKey ipKey = IpKey(clientIpHash);
                RedisValue existing = await database.StringGetAsync(ipKey, CommandFlags.DemandMaster).ConfigureAwait(false);
                if (existing.HasValue)
                    deviceId = existing.ToString();
                else
                {
                    string candidate = Guid.CreateVersion7().ToString("D");
                    bool created = await database.StringSetAsync(ipKey, candidate, s_lifetime, When.NotExists, CommandFlags.DemandMaster).ConfigureAwait(false);
                    deviceId = created ? candidate : (await database.StringGetAsync(ipKey, CommandFlags.DemandMaster).ConfigureAwait(false)).ToString();
                }
                if (!Guid.TryParseExact(deviceId, "D", out Guid parsed) || parsed.Version != 7)
                    return PerceptionCharacterV3DeviceAuthorityResult.Failed("device_binding_unavailable");
                await database.StringSetAsync(DeviceKey(deviceId), "active", s_lifetime, When.Always, CommandFlags.DemandMaster).ConfigureAwait(false);
            }
            _ = database.KeyExpireAsync(DeviceKey(deviceId), s_lifetime, CommandFlags.FireAndForget);
            WriteCookie(context, deviceId);
            return PerceptionCharacterV3DeviceAuthorityResult.Success("anonymous-device:" + deviceId);
        }
        catch (RedisException)
        {
            return PerceptionCharacterV3DeviceAuthorityResult.Failed("device_binding_unavailable");
        }
    }

    private static void WriteCookie(HttpContext context, string deviceId)
        => context.Response.Cookies.Append(CookieName, deviceId, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/",
            MaxAge = s_lifetime,
            IsEssential = true
        });
    private RedisKey DeviceKey(string id) => keyScope.PrefixKey("security:perception-v3-device:" + id);
    private RedisKey IpKey(string ipHash) => keyScope.PrefixKey("security:perception-v3-device-ip:" + ipHash);
}

public interface IPerceptionCharacterV3ResourceGate
{
    bool TryAcquireIssue(string ip, string device, string subject, string action, string identity, long nowUnixMs, out string dimension);
    ValueTask<IAsyncDisposable?> EnterRenderAsync(CancellationToken cancellationToken);
}

public sealed class PerceptionCharacterV3ResourceGate : IPerceptionCharacterV3ResourceGate
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, Window> _windows = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _renders = new(2, 2); private int _queued;
    public bool TryAcquireIssue(string ip, string device, string subject, string action, string identity, long nowUnixMs, out string dimension)
    {
        foreach ((string name, string value, int max) in new[] { ("ip", ip, 12), ("device", device, 10), ("subject", subject, 8), ("action", action, 30), ("challenge", identity, 2) })
            if (!Acquire(name + ":" + value, max, nowUnixMs))
            {
                dimension = name;
                return false;
            }
        dimension = string.Empty;
        return true;
    }
    public async ValueTask<IAsyncDisposable?> EnterRenderAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.Increment(ref _queued) > 8)
        {
            Interlocked.Decrement(ref _queued);
            return null;
        }
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(2));
            await _renders.WaitAsync(timeout.Token);
            return new Lease(_renders);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { return null; }
        finally { Interlocked.Decrement(ref _queued); }
    }
    private bool Acquire(string key, int max, long now)
    {
        Window window = _windows.AddOrUpdate(key, _ => new(now, 1), (_, old) => now - old.Start >= 60_000 ? new(now, 1) : old with { Count = old.Count + 1 });
        return window.Count <= max;
    }
    private sealed record Window(long Start, int Count);
    private sealed class Lease(SemaphoreSlim semaphore) : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            semaphore.Release();
            return ValueTask.CompletedTask;
        }
    }
}
