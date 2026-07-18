using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;

using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed record AuditLegalHold(
    string HoldId,
    string Action,
    string Purpose,
    string ApprovalReference,
    DateTimeOffset ApprovedAtUtc,
    DateTimeOffset ExpiresAtUtc);

public sealed class AuditLegalHoldRegistry(TimeProvider timeProvider)
{
    public static readonly TimeSpan MaximumHoldDuration = TimeSpan.FromDays(30);
    private readonly Dictionary<string, AuditLegalHold> _holds = new(StringComparer.Ordinal);
    private readonly object _sync = new();

    public AuditLegalHold Approve(
        string holdId,
        string action,
        string purpose,
        string approvalReference,
        DateTimeOffset expiresAtUtc)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(holdId);
        ArgumentException.ThrowIfNullOrWhiteSpace(purpose);
        ArgumentException.ThrowIfNullOrWhiteSpace(approvalReference);
        AuditRetentionPolicy policy = AuditRetentionCatalog.GetRequired(action);
        if (!policy.LegalHoldAllowed)
        {
            throw new InvalidOperationException("audit_legal_hold_not_allowed");
        }

        DateTimeOffset now = timeProvider.GetUtcNow().ToUniversalTime();
        DateTimeOffset expires = expiresAtUtc.ToUniversalTime();
        if (expires <= now || expires - now > MaximumHoldDuration)
        {
            throw new ArgumentOutOfRangeException(nameof(expiresAtUtc), "Legal hold must have a future expiry within 30 days.");
        }

        var hold = new AuditLegalHold(
            holdId.Trim(),
            policy.Action,
            purpose.Trim(),
            approvalReference.Trim(),
            now,
            expires);
        lock (_sync)
        {
            if (!_holds.TryAdd(hold.HoldId, hold))
            {
                throw new InvalidOperationException("audit_legal_hold_duplicate");
            }
        }
        return hold;
    }

    public bool IsHeld(string action, DateTimeOffset atUtc)
    {
        DateTimeOffset at = atUtc.ToUniversalTime();
        lock (_sync)
        {
            return _holds.Values.Any(hold =>
                StringComparer.Ordinal.Equals(hold.Action, action)
                && hold.ApprovedAtUtc <= at
                && hold.ExpiresAtUtc > at);
        }
    }
}

public interface IAuditRetentionEpochKeyStore
{
    ValueTask<byte[]> CreateAsync(string keyDomain, string epochId, CancellationToken cancellationToken);
    ValueTask<byte[]?> TryReadAsync(string keyDomain, string epochId, CancellationToken cancellationToken);
    ValueTask<bool> DestroyAsync(string keyDomain, string epochId, CancellationToken cancellationToken);
}

public sealed class LocalAuditRetentionEpochKeyStore : IAuditRetentionEpochKeyStore
{
    private readonly string _rootPath;

    public LocalAuditRetentionEpochKeyStore(IConfiguration configuration)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        _rootPath = Path.GetFullPath(Path.Combine(dataRoot, "audit-retention", "epoch-keys"));
        Directory.CreateDirectory(_rootPath);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(_rootPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }

    public async ValueTask<byte[]> CreateAsync(
        string keyDomain,
        string epochId,
        CancellationToken cancellationToken)
    {
        string path = ResolvePath(keyDomain, epochId);
        byte[] key = RandomNumberGenerator.GetBytes(32);
        try
        {
            await using var stream = new FileStream(path, PrivateCreateNewOptions());
            await stream.WriteAsync(key, cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            stream.Flush(flushToDisk: true);
            return key;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(key);
            throw;
        }
    }

    public async ValueTask<byte[]?> TryReadAsync(
        string keyDomain,
        string epochId,
        CancellationToken cancellationToken)
    {
        string path = ResolvePath(keyDomain, epochId);
        if (!File.Exists(path))
        {
            return null;
        }
        byte[] key = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
        if (key.Length != 32)
        {
            CryptographicOperations.ZeroMemory(key);
            throw new InvalidDataException("audit_retention_epoch_key_invalid");
        }
        return key;
    }

    public ValueTask<bool> DestroyAsync(
        string keyDomain,
        string epochId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string path = ResolvePath(keyDomain, epochId);
        if (!File.Exists(path))
        {
            return ValueTask.FromResult(false);
        }
        File.Delete(path);
        return ValueTask.FromResult(true);
    }

    private string ResolvePath(string keyDomain, string epochId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(keyDomain);
        ArgumentException.ThrowIfNullOrWhiteSpace(epochId);
        string identity = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{keyDomain}\n{epochId}")));
        return Path.Combine(_rootPath, $"dek-{identity}.bin");
    }

    private static FileStreamOptions PrivateCreateNewOptions()
    {
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            Options = FileOptions.WriteThrough
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }
        return options;
    }
}

public sealed record AuditRetentionEnvelope(
    int Version,
    string KeyDomain,
    string EpochId,
    string NonceBase64Url,
    string TagBase64Url,
    string CiphertextBase64Url);

public sealed class AuditRetentionPayloadProtector(IAuditRetentionEpochKeyStore keyStore)
{
    public const int EnvelopeVersion = 1;
    public const string EncryptedEventInfo = "retention-encrypted";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async ValueTask<AuditRecord> ProtectAsync(AuditRecord record, CancellationToken cancellationToken)
    {
        AuditRetentionPolicy policy = AuditRetentionCatalog.GetRequired(record.Action);
        if (!ContainsSensitivePayload(record))
        {
            return record;
        }

        string epochId = string.Concat(
            record.OccurredAtUtc.ToUniversalTime().ToString("yyyyMMddHHmmssfffffff", System.Globalization.CultureInfo.InvariantCulture),
            "-",
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)));
        byte[] key = await keyStore.CreateAsync(policy.CryptographicEraseKeyDomain, epochId, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            byte[] plaintext = JsonSerializer.SerializeToUtf8Bytes(AuditSensitivePayload.FromRecord(record), JsonOptions);
            byte[] nonce = RandomNumberGenerator.GetBytes(12);
            byte[] ciphertext = new byte[plaintext.Length];
            byte[] tag = new byte[16];
            byte[] associatedData = BuildAssociatedData(record.Action, policy.CryptographicEraseKeyDomain, epochId);
            try
            {
                using var aes = new AesGcm(key, tag.Length);
                aes.Encrypt(nonce, plaintext, ciphertext, tag, associatedData);
                var envelope = new AuditRetentionEnvelope(
                    EnvelopeVersion,
                    policy.CryptographicEraseKeyDomain,
                    epochId,
                    WebEncoders.Base64UrlEncode(nonce),
                    WebEncoders.Base64UrlEncode(tag),
                    WebEncoders.Base64UrlEncode(ciphertext));
                byte[] envelopeBytes = JsonSerializer.SerializeToUtf8Bytes(envelope, JsonOptions);
                return record with
                {
                    ActorId = Pseudonymize(key, "actor", record.ActorId),
                    ActorRole = null,
                    TargetId = Pseudonymize(key, "target", record.TargetId),
                    TraceId = null,
                    RequestPath = null,
                    RequestMethod = null,
                    IpHash = null,
                    UserAgentHash = null,
                    SessionIdHash = null,
                    DeviceFingerprintHash = null,
                    ReasonCode = null,
                    EventInfo = EncryptedEventInfo,
                    ContextJson = null,
                    ContextPayload = envelopeBytes
                };
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
                CryptographicOperations.ZeroMemory(associatedData);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }

    public async ValueTask<AuditLog> TryUnprotectAsync(AuditLog row, CancellationToken cancellationToken)
    {
        if (!StringComparer.Ordinal.Equals(row.EventInfo, EncryptedEventInfo) || row.ContextPayload is not { Length: > 0 })
        {
            return row;
        }
        AuditRetentionEnvelope? envelope = JsonSerializer.Deserialize<AuditRetentionEnvelope>(row.ContextPayload, JsonOptions);
        if (envelope is null || envelope.Version != EnvelopeVersion)
        {
            return row;
        }
        byte[]? key = await keyStore.TryReadAsync(envelope.KeyDomain, envelope.EpochId, cancellationToken)
            .ConfigureAwait(false);
        if (key is null)
        {
            return row;
        }
        try
        {
            byte[] nonce = WebEncoders.Base64UrlDecode(envelope.NonceBase64Url);
            byte[] tag = WebEncoders.Base64UrlDecode(envelope.TagBase64Url);
            byte[] ciphertext = WebEncoders.Base64UrlDecode(envelope.CiphertextBase64Url);
            byte[] plaintext = new byte[ciphertext.Length];
            byte[] associatedData = BuildAssociatedData(row.Action, envelope.KeyDomain, envelope.EpochId);
            try
            {
                using var aes = new AesGcm(key, tag.Length);
                aes.Decrypt(nonce, ciphertext, tag, plaintext, associatedData);
                AuditSensitivePayload payload = JsonSerializer.Deserialize<AuditSensitivePayload>(plaintext, JsonOptions)
                    ?? throw new InvalidDataException("audit_retention_payload_empty");
                return payload.Apply(row);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(plaintext);
                CryptographicOperations.ZeroMemory(associatedData);
            }
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException or JsonException)
        {
            return row;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
        }
    }

    public static bool TryReadEnvelope(AuditLog row, out AuditRetentionEnvelope envelope)
    {
        envelope = null!;
        if (!StringComparer.Ordinal.Equals(row.EventInfo, EncryptedEventInfo) || row.ContextPayload is not { Length: > 0 })
        {
            return false;
        }
        try
        {
            envelope = JsonSerializer.Deserialize<AuditRetentionEnvelope>(row.ContextPayload, JsonOptions)!;
            return envelope is { Version: EnvelopeVersion };
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool ContainsSensitivePayload(AuditRecord record)
        => record.ActorId is not null || record.ActorRole is not null || record.TargetId is not null
            || record.TraceId is not null || record.RequestPath is not null || record.RequestMethod is not null
            || record.IpHash is not null || record.UserAgentHash is not null || record.SessionIdHash is not null
            || record.DeviceFingerprintHash is not null || record.ReasonCode is not null
            || record.ContextJson is not null || record.ContextPayload is { Length: > 0 }
            || !string.IsNullOrWhiteSpace(record.EventInfo);

    private static byte[] BuildAssociatedData(string action, string keyDomain, string epochId)
        => Encoding.UTF8.GetBytes($"fsusblog.audit.retention-envelope.v1\n{action}\n{keyDomain}\n{epochId}");

    private static string? Pseudonymize(byte[] key, string field, string? value)
        => string.IsNullOrWhiteSpace(value)
            ? null
            : Convert.ToHexStringLower(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes($"{field}:{value.Trim()}")));

    private sealed record AuditSensitivePayload(
        string? ActorId,
        string? ActorRole,
        string? TargetId,
        string? TraceId,
        string? RequestPath,
        string? RequestMethod,
        string? IpHash,
        string? UserAgentHash,
        string? SessionIdHash,
        string? DeviceFingerprintHash,
        string? ReasonCode,
        string EventInfo,
        string? ContextJson,
        byte[]? ContextPayload)
    {
        public static AuditSensitivePayload FromRecord(AuditRecord record)
            => new(
                record.ActorId, record.ActorRole, record.TargetId, record.TraceId, record.RequestPath,
                record.RequestMethod, record.IpHash, record.UserAgentHash, record.SessionIdHash,
                record.DeviceFingerprintHash, record.ReasonCode, record.EventInfo, record.ContextJson,
                record.ContextPayload);

        public AuditLog Apply(AuditLog row)
        {
            row.ActorId = ActorId;
            row.ActorRole = ActorRole;
            row.TargetId = TargetId;
            row.TraceId = TraceId;
            row.RequestPath = RequestPath;
            row.RequestMethod = RequestMethod;
            row.IpHash = IpHash;
            row.UserAgentHash = UserAgentHash;
            row.SessionIdHash = SessionIdHash;
            row.DeviceFingerprintHash = DeviceFingerprintHash;
            row.ReasonCode = ReasonCode;
            row.EventInfo = EventInfo;
            row.ContextJson = ContextJson;
            row.ContextPayload = ContextPayload;
            return row;
        }
    }
}
