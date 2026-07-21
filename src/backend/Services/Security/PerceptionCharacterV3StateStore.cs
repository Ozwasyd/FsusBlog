using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;

using StackExchange.Redis;

namespace FsusBlog.Server.Services.Security;

public sealed record PerceptionCharacterV3StateRecord(
    string ChallengeId, string EnvelopeId, string Action, string RouteKey, string SubjectHash, string DeviceBindingHash,
    string DeviceAuthorityHash, string ClientIpBindingHash, string PolicyVersion, string MediaHash, string Representation, long IssuedAtUnixMs,
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
    Task<PerceptionCharacterV3Transition> ReplaceAsync(PerceptionCharacterV3StateRecord expected, PerceptionCharacterV3StateRecord replacement, long nowUnixMs, CancellationToken cancellationToken);
    Task<PerceptionCharacterV3StateRecord?> ReadAsync(string challengeId, CancellationToken cancellationToken);
    Task<PerceptionCharacterV3Transition> VerifyAsync(PerceptionCharacterV3StateRecord expected, bool answerMatches, long nowUnixMs, CancellationToken cancellationToken);
    Task<PerceptionCharacterV3Transition> RevokeAsync(PerceptionCharacterV3StateRecord expected, long nowUnixMs, CancellationToken cancellationToken);
}

internal enum PerceptionCharacterV3RedisFaultPoint
{
    CreateReply,
    ReplaceReply,
    TransitionReply,
    OperationReadback,
    OperationSettlement
}

public sealed class RedisPerceptionCharacterV3StateStore : IPerceptionCharacterV3StateStore
{
    private const string CreateScript = """
if redis.call('EXISTS',KEYS[1])~=0 or redis.call('EXISTS',KEYS[2])~=0 then return 0 end
for i=3,#ARGV,2 do redis.call('HSET',KEYS[1],ARGV[i],ARGV[i+1]) end
redis.call('PEXPIREAT',KEYS[1],ARGV[1])
redis.call('SET',KEYS[2],ARGV[2], 'PXAT',ARGV[1])
return 1
""";

    private const string CreateReadbackScript = """
if redis.call('EXISTS',KEYS[1])==0 or redis.call('PTTL',KEYS[1])<=0 or redis.call('PTTL',KEYS[2])<=0 then return 0 end
if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end
for i=2,#ARGV,2 do if redis.call('HGET',KEYS[1],ARGV[i])~=ARGV[i+1] then return 0 end end
return 1
""";

    private const string TransitionScript = """
local key=KEYS[1]
if redis.call('EXISTS',key)==0 then return {-1,0} end
local attempts=tonumber(redis.call('HGET',key,'attempts') or '0')
local previous=redis.call('HGET',key,'lastOperationId')
if previous==ARGV[4] then return {tonumber(redis.call('HGET',key,'lastOperationCode')),tonumber(redis.call('HGET',key,'lastOperationAttempts'))} end
if previous and redis.call('HGET',key,'lastOperationSettled')~='1' then return {-3,attempts} end
local fields={'envelopeId','action','routeKey','subjectHash','deviceHash','deviceAuthorityHash','ipHash','policyVersion','mediaHash','representation','tokenHash'}
for i,name in ipairs(fields) do if redis.call('HGET',key,name)~=ARGV[i+4] then return {-2,attempts} end end
local status=redis.call('HGET',key,'status')
if status~='active' then
  if status=='expired' or status=='revoked' then return {3,attempts} end
  return {2,attempts}
end
if redis.call('GET',KEYS[2])~=ARGV[16] then return {-4,attempts} end
local function changed(code,newAttempts,newStatus)
  redis.call('HSET',key,'status',newStatus,'lastOperationId',ARGV[4],'lastOperationCode',code,'lastOperationAttempts',newAttempts,'lastOperationSettled','0')
  if newStatus~='active' and redis.call('GET',KEYS[2])==ARGV[16] then redis.call('DEL',KEYS[2]) end
  return {code,newAttempts}
end
local now=tonumber(ARGV[2]); local expires=tonumber(redis.call('HGET',key,'expiresAt'))
if now>=expires then return changed(7,attempts,'expired') end
if ARGV[1]=='revoke' then return changed(4,attempts,'revoked') end
attempts=redis.call('HINCRBY',key,'attempts',1)
if ARGV[3]=='1' then return changed(0,attempts,'consumed') end
if attempts>=2 then return changed(6,attempts,'exhausted') end
return changed(1,attempts,'active')
""";

    private const string ReplaceScript = """
local old=KEYS[1]; local replacement=KEYS[2]; local oldIdentity=KEYS[3]; local replacementIdentity=KEYS[4]
if old==replacement or redis.call('EXISTS',replacement)~=0 then return {-4,0} end
if redis.call('EXISTS',old)==0 then return {-1,0} end
local attempts=tonumber(redis.call('HGET',old,'attempts') or '0')
local previous=redis.call('HGET',old,'lastOperationId')
if previous==ARGV[2] then return {tonumber(redis.call('HGET',old,'lastOperationCode')),tonumber(redis.call('HGET',old,'lastOperationAttempts'))} end
if previous and redis.call('HGET',old,'lastOperationSettled')~='1' then return {-3,attempts} end
local fields={'envelopeId','action','routeKey','subjectHash','deviceHash','deviceAuthorityHash','ipHash','policyVersion','mediaHash','representation','tokenHash'}
for i,name in ipairs(fields) do if redis.call('HGET',old,name)~=ARGV[i+3] then return {-2,attempts} end end
local oldStatus=redis.call('HGET',old,'status')
if oldStatus~='active' then
  if oldStatus=='expired' or oldStatus=='revoked' then return {3,attempts} end
  return {2,attempts}
end
if redis.call('GET',oldIdentity)~=ARGV[3] then return {-4,attempts} end
if tonumber(ARGV[1])>=tonumber(redis.call('HGET',old,'expiresAt')) then
  redis.call('HSET',old,'status','expired','lastOperationId',ARGV[2],'lastOperationCode',7,'lastOperationAttempts',attempts,'lastOperationSettled','0')
  if redis.call('GET',oldIdentity)==ARGV[3] then redis.call('DEL',oldIdentity) end
  return {7,attempts}
end
local replacementStart=15
local expiry=ARGV[replacementStart]
local identityOwner=redis.call('GET',replacementIdentity)
if replacementIdentity==oldIdentity then
  if identityOwner~=ARGV[3] then return {-4,attempts} end
elseif identityOwner then return {-4,attempts} end
for i=replacementStart+2,#ARGV,2 do redis.call('HSET',replacement,ARGV[i],ARGV[i+1]) end
redis.call('PEXPIREAT',replacement,expiry)
redis.call('SET',replacementIdentity,ARGV[replacementStart+1],'PXAT',expiry)
if replacementIdentity~=oldIdentity and redis.call('GET',oldIdentity)==ARGV[3] then redis.call('DEL',oldIdentity) end
redis.call('HSET',old,'status','revoked','lastOperationId',ARGV[2],'lastOperationCode',5,'lastOperationAttempts',attempts,'lastOperationSettled','0')
return {5,attempts}
""";

    private const string OperationReadbackScript = """
if redis.call('HGET',KEYS[1],'lastOperationId')~=ARGV[1] then return {-99,0} end
return {tonumber(redis.call('HGET',KEYS[1],'lastOperationCode')),tonumber(redis.call('HGET',KEYS[1],'lastOperationAttempts'))}
""";

    private const string OperationSettlementScript = """
if redis.call('HGET',KEYS[1],'lastOperationId')~=ARGV[1] then return 0 end
redis.call('HSET',KEYS[1],'lastOperationSettled','1')
return 1
""";

    private const string OperationSettlementReadbackScript = """
if redis.call('HGET',KEYS[1],'lastOperationId')==ARGV[1] and redis.call('HGET',KEYS[1],'lastOperationSettled')=='1' then return 1 end
return 0
""";

    private readonly IConnectionMultiplexer _redis;
    private readonly IRuntimeKeyScope _keyScope;
    private readonly Func<PerceptionCharacterV3RedisFaultPoint, bool>? _discardReply;

    public RedisPerceptionCharacterV3StateStore(IConnectionMultiplexer redis, IRuntimeKeyScope keyScope)
        : this(redis, keyScope, null)
    {
    }

    internal RedisPerceptionCharacterV3StateStore(
        IConnectionMultiplexer redis,
        IRuntimeKeyScope keyScope,
        Func<PerceptionCharacterV3RedisFaultPoint, bool>? discardReply)
    {
        _redis = redis;
        _keyScope = keyScope;
        _discardReply = discardReply;
    }

    public async Task<bool> CreateAsync(PerceptionCharacterV3StateRecord r, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            IDatabase db = _redis.GetDatabase();
            RedisKey key = Key(r.ChallengeId);
            RedisResult result = await db.ScriptEvaluateAsync(CreateScript, [key, ActiveIdentityKey(r)], CreateArguments(r), CommandFlags.DemandMaster).ConfigureAwait(false);
            Discard(PerceptionCharacterV3RedisFaultPoint.CreateReply);
            return (long)result == 1;
        }
        catch (Exception ex) when (ex is RedisException or DiscardedRedisReplyException)
        {
            return await ConfirmCreatedAsync(r).ConfigureAwait(false);
        }
    }

    public Task<PerceptionCharacterV3Transition> ReplaceAsync(PerceptionCharacterV3StateRecord expected, PerceptionCharacterV3StateRecord replacement, long nowUnixMs, CancellationToken cancellationToken)
        => ReplaceCoreAsync(expected, replacement, nowUnixMs, cancellationToken);

    public async Task<PerceptionCharacterV3StateRecord?> ReadAsync(string challengeId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            HashEntry[] e = await _redis.GetDatabase().HashGetAllAsync(Key(challengeId), CommandFlags.DemandMaster).ConfigureAwait(false);
            if (e.Length == 0)
                return null;
            var d = e.ToDictionary(x => x.Name.ToString(), x => x.Value.ToString(), StringComparer.Ordinal);
            return new(challengeId, d["envelopeId"], d["action"], d["routeKey"], d["subjectHash"], d["deviceHash"], d["deviceAuthorityHash"], d["ipHash"], d["policyVersion"], d["mediaHash"], d["representation"], long.Parse(d["issuedAt"], System.Globalization.CultureInfo.InvariantCulture), long.Parse(d["expiresAt"], System.Globalization.CultureInfo.InvariantCulture), d["tokenKeyVersion"], d["answerKeyVersion"], d["tokenHash"]);
        }
        catch (Exception ex) when (ex is RedisException or KeyNotFoundException or FormatException)
        {
            throw new PerceptionCharacterV3StoreUnavailableException(ex);
        }
    }

    public Task<PerceptionCharacterV3Transition> VerifyAsync(PerceptionCharacterV3StateRecord expected, bool answerMatches, long nowUnixMs, CancellationToken cancellationToken)
        => TransitionAsync(expected, "verify", answerMatches, nowUnixMs, cancellationToken);
    public Task<PerceptionCharacterV3Transition> RevokeAsync(PerceptionCharacterV3StateRecord expected, long nowUnixMs, CancellationToken cancellationToken)
        => TransitionAsync(expected, "revoke", false, nowUnixMs, cancellationToken);
    private async Task<PerceptionCharacterV3Transition> TransitionAsync(PerceptionCharacterV3StateRecord x, string operation, bool correct, long now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        string operationId = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16));
        RedisKey key = Key(x.ChallengeId);
        try
        {
            RedisResult result = await EvaluateAfterPendingAsync(
                TransitionScript,
                [key, ActiveIdentityKey(x)],
                [operation, now, correct ? "1" : "0", operationId, x.EnvelopeId, x.Action, x.RouteKey, x.SubjectHash, x.DeviceBindingHash, x.DeviceAuthorityHash, x.ClientIpBindingHash, x.PolicyVersion, x.MediaHash, x.Representation, x.TokenHash, x.ChallengeId],
                ct).ConfigureAwait(false);
            if (_discardReply?.Invoke(PerceptionCharacterV3RedisFaultPoint.TransitionReply) == true)
                throw new OperationReplyLostException(key, operationId);
            return await SettleAndMapAsync(key, operationId, result).ConfigureAwait(false);
        }
        catch (OperationReplyLostException lost)
        {
            return await ReadbackSettleAndMapAsync(lost.Key, lost.OperationId).ConfigureAwait(false);
        }
        catch (RedisException)
        {
            return await ReadbackSettleAndMapAsync(key, operationId).ConfigureAwait(false);
        }
    }

    private async Task<PerceptionCharacterV3Transition> ReplaceCoreAsync(PerceptionCharacterV3StateRecord expected, PerceptionCharacterV3StateRecord replacement, long now, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        string operationId = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16));
        RedisKey oldKey = Key(expected.ChallengeId);
        try
        {
            RedisValue[] replacementArguments = CreateArguments(replacement);
            RedisValue[] arguments = [now, operationId, expected.ChallengeId, expected.EnvelopeId, expected.Action, expected.RouteKey, expected.SubjectHash, expected.DeviceBindingHash, expected.DeviceAuthorityHash, expected.ClientIpBindingHash, expected.PolicyVersion, expected.MediaHash, expected.Representation, expected.TokenHash, .. replacementArguments];
            RedisResult result = await EvaluateAfterPendingAsync(
                ReplaceScript,
                [oldKey, Key(replacement.ChallengeId), ActiveIdentityKey(expected), ActiveIdentityKey(replacement)],
                arguments,
                ct).ConfigureAwait(false);
            if (_discardReply?.Invoke(PerceptionCharacterV3RedisFaultPoint.ReplaceReply) == true)
                throw new OperationReplyLostException(oldKey, operationId);
            return await SettleAndMapAsync(oldKey, operationId, result).ConfigureAwait(false);
        }
        catch (OperationReplyLostException lost)
        {
            return await ReadbackSettleAndMapAsync(lost.Key, lost.OperationId).ConfigureAwait(false);
        }
        catch (RedisException)
        {
            return await ReadbackSettleAndMapAsync(oldKey, operationId).ConfigureAwait(false);
        }
    }

    private async Task<bool> ConfirmCreatedAsync(PerceptionCharacterV3StateRecord record)
    {
        try
        {
            RedisValue[] arguments = [record.ChallengeId, .. StateFieldArguments(record)];
            RedisResult result = await _redis.GetDatabase().ScriptEvaluateAsync(CreateReadbackScript, [Key(record.ChallengeId), ActiveIdentityKey(record)], arguments, CommandFlags.DemandMaster).ConfigureAwait(false);
            return (long)result == 1;
        }
        catch (RedisException)
        {
            return false;
        }
    }

    private async Task<RedisResult> EvaluateAfterPendingAsync(string script, RedisKey[] keys, RedisValue[] arguments, CancellationToken cancellationToken)
    {
        RedisResult result = default!;
        for (int attempt = 0; attempt < 20; attempt++)
        {
            result = await _redis.GetDatabase().ScriptEvaluateAsync(script, keys, arguments, CommandFlags.DemandMaster).ConfigureAwait(false);
            RedisResult[] values = (RedisResult[])result!;
            if ((long)values[0] != -3)
                return result;
            await Task.Delay(TimeSpan.FromMilliseconds(5), cancellationToken).ConfigureAwait(false);
        }
        return result;
    }

    private async Task<PerceptionCharacterV3Transition> ReadbackSettleAndMapAsync(RedisKey key, string operationId)
    {
        try
        {
            Discard(PerceptionCharacterV3RedisFaultPoint.OperationReadback);
            RedisResult result = await _redis.GetDatabase().ScriptEvaluateAsync(OperationReadbackScript, [key], [operationId], CommandFlags.DemandMaster).ConfigureAwait(false);
            return await SettleAndMapAsync(key, operationId, result).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is RedisException or DiscardedRedisReplyException)
        {
            return new(PerceptionCharacterV3TransitionKind.Unavailable, "redis_result_ambiguous", 0);
        }
    }

    private async Task<PerceptionCharacterV3Transition> SettleAndMapAsync(RedisKey key, string operationId, RedisResult result)
    {
        RedisResult[] values = (RedisResult[])result!;
        int code = (int)(long)values[0];
        int attempts = (int)(long)values[1];
        if (code is 0 or 1 or 4 or 5 or 6 or 7)
        {
            try
            {
                RedisResult settled = await _redis.GetDatabase().ScriptEvaluateAsync(OperationSettlementScript, [key], [operationId], CommandFlags.DemandMaster).ConfigureAwait(false);
                Discard(PerceptionCharacterV3RedisFaultPoint.OperationSettlement);
                if ((long)settled != 1)
                    return new(PerceptionCharacterV3TransitionKind.Unavailable, "redis_result_ambiguous", attempts);
            }
            catch (Exception ex) when (ex is RedisException or DiscardedRedisReplyException)
            {
                if (!await ConfirmSettlementAsync(key, operationId).ConfigureAwait(false))
                    return new(PerceptionCharacterV3TransitionKind.Unavailable, "redis_result_ambiguous", attempts);
            }
        }
        return code switch
        {
            0 => new(PerceptionCharacterV3TransitionKind.Success, "consumed", attempts),
            1 => new(PerceptionCharacterV3TransitionKind.Retryable, "answer_mismatch", attempts),
            5 => new(PerceptionCharacterV3TransitionKind.Success, "replaced", attempts),
            4 => new(PerceptionCharacterV3TransitionKind.ReissueRequired, "revoked_now", attempts),
            7 => new(PerceptionCharacterV3TransitionKind.ReissueRequired, "expired_or_revoked", attempts),
            3 => new(PerceptionCharacterV3TransitionKind.ReissueRequired, "expired_or_revoked", attempts),
            6 => new(PerceptionCharacterV3TransitionKind.Rejected, "terminal_or_missing", attempts),
            -3 => new(PerceptionCharacterV3TransitionKind.Unavailable, "ambiguous_operation_pending", attempts),
            -2 => new(PerceptionCharacterV3TransitionKind.Rejected, "binding_mismatch", attempts),
            -4 => new(PerceptionCharacterV3TransitionKind.Rejected, "replacement_conflict", attempts),
            -99 => new(PerceptionCharacterV3TransitionKind.Unavailable, "redis_result_ambiguous", attempts),
            _ => new(PerceptionCharacterV3TransitionKind.Rejected, "terminal_or_missing", attempts)
        };
    }

    private static RedisValue[] CreateArguments(PerceptionCharacterV3StateRecord record)
        => [Math.Max(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1000, record.ExpiresAtUnixMs + 60_000), record.ChallengeId, .. StateFieldArguments(record)];

    private static RedisValue[] StateFieldArguments(PerceptionCharacterV3StateRecord record)
        => ["status", "active", "attempts", 0, "envelopeId", record.EnvelopeId, "action", record.Action, "routeKey", record.RouteKey,
            "subjectHash", record.SubjectHash, "deviceHash", record.DeviceBindingHash, "deviceAuthorityHash", record.DeviceAuthorityHash, "ipHash", record.ClientIpBindingHash, "policyVersion", record.PolicyVersion,
            "mediaHash", record.MediaHash, "representation", record.Representation, "issuedAt", record.IssuedAtUnixMs, "expiresAt", record.ExpiresAtUnixMs,
            "tokenKeyVersion", record.TokenKeyVersion, "answerKeyVersion", record.AnswerKeyVersion, "tokenHash", record.TokenHash];

    private async Task<bool> ConfirmSettlementAsync(RedisKey key, string operationId)
    {
        try
        {
            RedisResult result = await _redis.GetDatabase().ScriptEvaluateAsync(OperationSettlementReadbackScript, [key], [operationId], CommandFlags.DemandMaster).ConfigureAwait(false);
            return (long)result == 1;
        }
        catch (RedisException)
        {
            return false;
        }
    }

    private void Discard(PerceptionCharacterV3RedisFaultPoint point)
    {
        if (_discardReply?.Invoke(point) == true)
            throw new DiscardedRedisReplyException();
    }

    private RedisKey Key(string id) => _keyScope.PrefixKey($"security:perception-v3:{id}");
    private RedisKey ActiveIdentityKey(PerceptionCharacterV3StateRecord record)
    {
        byte[] material = PerceptionCharacterV3Crypto.EncodeLp(
            System.Text.Encoding.UTF8.GetBytes(record.SubjectHash),
            System.Text.Encoding.UTF8.GetBytes(record.DeviceAuthorityHash),
            System.Text.Encoding.UTF8.GetBytes(record.ClientIpBindingHash),
            System.Text.Encoding.UTF8.GetBytes(record.Action),
            System.Text.Encoding.UTF8.GetBytes(record.RouteKey));
        string digest = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(material));
        System.Security.Cryptography.CryptographicOperations.ZeroMemory(material);
        return _keyScope.PrefixKey($"security:perception-v3-active:{digest}");
    }
    private sealed class DiscardedRedisReplyException : Exception;
    private sealed class OperationReplyLostException(RedisKey key, string operationId) : Exception
    {
        public RedisKey Key { get; } = key;
        public string OperationId { get; } = operationId;
    }
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
    private readonly SemaphoreSlim _renders = new(2, 2);
    private int _queued;
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
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        finally
        {
            Interlocked.Decrement(ref _queued);
        }
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
