using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface IAnonymousCredentialIssuerService
{
    Task<Result<AnonymousCredentialIssueResponseCoreModel>> IssueAsync(
        int userId,
        AnonymousCredentialIssueRequestCoreModel request,
        string? traceId,
        CancellationToken cancellationToken = default);
}

public interface IAnonymousCredentialIssuanceAuditStore
{
    Task<bool> TryRecordIssuedAsync(
        AnonymousCredentialIssuanceAuditWrite write,
        CancellationToken cancellationToken = default);
}

public readonly record struct AnonymousCredentialIssuanceAuditWrite(
    int UserId,
    long Epoch,
    string RequestHash,
    string Status,
    DateTime CreatedAtUtc,
    string? TraceId);

public static class AnonymousCredentialIssuerLimits
{
    public const int MaxIssueRequestFrameBytes = 16 * 1024;
    public const int MaxBlindedRequestBytes = 8 * 1024;
    public const int MaxClientNonceBytes = 128;
    public const int MaxCircuitIdChars = 96;
    public const int MaxCredentialLevelChars = 32;
}

public sealed class AnonymousCredentialIssuanceAuditStore(ISqlSugarClient db) : IAnonymousCredentialIssuanceAuditStore
{
    public async Task<bool> TryRecordIssuedAsync(
        AnonymousCredentialIssuanceAuditWrite write,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int affected = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO anonymous_credential_issuance_audit
                (user_id, epoch, request_hash, status, created_at_utc, trace_id)
            VALUES
                (@UserId, @Epoch, @RequestHash, @Status, @CreatedAtUtc, @TraceId)
            ON CONFLICT(user_id, epoch) DO NOTHING;
            """,
            new SugarParameter("@UserId", write.UserId),
            new SugarParameter("@Epoch", write.Epoch),
            new SugarParameter("@RequestHash", write.RequestHash),
            new SugarParameter("@Status", write.Status),
            new SugarParameter("@CreatedAtUtc", write.CreatedAtUtc),
            new SugarParameter("@TraceId", write.TraceId));
        return affected > 0;
    }
}

public sealed class AnonymousCredentialIssuerService(
    ISqlSugarClient db,
    IAnonymousCredentialIssuanceAuditStore issuanceAudit,
    IAuditEventService auditEvents,
    IConfiguration configuration) : IAnonymousCredentialIssuerService
{
    private const int UserStatusBanned = 1;
    private const int UserStatusDeleted = 2;
    private const int DefaultEpochDurationMinutes = 1440;
    private const int DefaultCredentialTtlMinutes = 1440;

    public async Task<Result<AnonymousCredentialIssueResponseCoreModel>> IssueAsync(
        int userId,
        AnonymousCredentialIssueRequestCoreModel request,
        string? traceId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (userId <= 0)
        {
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Unauthorized, "anonymous_credential_auth_required");
        }

        AnonymousCredentialIssuerOptions options = ResolveOptions(configuration);
        string circuitId = NormalizeToken(request.CircuitId, AnonymousCredentialIssuerLimits.MaxCircuitIdChars);
        if (circuitId.Length == 0 || request.CircuitNumericId == 0 || request.PublicInputLayoutVersion == 0)
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "validation_failed", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Validation, "anonymous_credential_circuit_required");
        }

        if (request.BlindedRequest is null ||
            request.BlindedRequest.Length == 0 ||
            request.BlindedRequest.Length > options.MaxBlindedRequestBytes ||
            request.ClientNonce is null ||
            request.ClientNonce.Length == 0 ||
            request.ClientNonce.Length > options.MaxClientNonceBytes)
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "validation_failed", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Validation, "anonymous_credential_issue_request_invalid");
        }

        AnonymousCredentialEligibilityRow? account = await db.Queryable<User>()
            .Where(user => user.Id == userId)
            .Select(user => new AnonymousCredentialEligibilityRow
            {
                Id = user.Id,
                Status = user.Status,
                DeletedAt = user.DeletedAt,
                AnonymousCredentialLevel = user.AnonymousCredentialLevel,
                AnonymousCredentialStatus = user.AnonymousCredentialStatus
            })
            .FirstAsync();
        if (account is null || account.DeletedAt.HasValue || account.Status == UserStatusDeleted)
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "account_deleted", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.NotFound, "anonymous_credential_account_unavailable");
        }

        if (account.Status == UserStatusBanned && !options.AllowBannedAccountIssuance)
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "account_banned", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Forbidden, "anonymous_credential_account_banned");
        }

        if (!string.Equals(NormalizeToken(account.AnonymousCredentialStatus, 32), AnonymousCredentialStatuses.Active, StringComparison.Ordinal))
        {
            await RecordIssuanceAuditAsync(userId, request.CredentialEpoch, "credential_disabled", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Forbidden, "anonymous_credential_disabled");
        }

        DateTimeOffset now = DateTimeOffset.UtcNow;
        long epoch = request.CredentialEpoch > 0
            ? request.CredentialEpoch
            : ResolveCurrentEpoch(now, options.EpochDurationMinutes);
        string requestHash = ComputeRequestHash(request, circuitId, epoch);
        bool recorded = await issuanceAudit.TryRecordIssuedAsync(
            new AnonymousCredentialIssuanceAuditWrite(
                userId,
                epoch,
                requestHash,
                AnonymousCredentialIssuanceStatuses.Issued,
                now.UtcDateTime,
                NormalizeTraceId(traceId)),
            cancellationToken);
        if (!recorded)
        {
            await RecordIssuanceAuditAsync(userId, epoch, "rate_limited", traceId, cancellationToken);
            return Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Conflict, "anonymous_credential_issue_rate_limited");
        }

        byte[] issuerResponse = CreateIssuerResponse(requestHash);
        byte[] commitment = CreateCredentialCommitment(requestHash, issuerResponse);
        string credentialLevel = NormalizeToken(account.AnonymousCredentialLevel, AnonymousCredentialIssuerLimits.MaxCredentialLevelChars);
        if (credentialLevel.Length == 0)
        {
            credentialLevel = AnonymousCredentialLevels.Basic;
        }

        await RecordIssuanceAuditAsync(userId, epoch, AnonymousCredentialIssuanceStatuses.Issued, traceId, cancellationToken);

        long expiresAtUnixMs = now.AddMinutes(options.CredentialTtlMinutes).ToUnixTimeMilliseconds();
        var response = new AnonymousCredentialIssueResponseCoreModel(
            epoch,
            expiresAtUnixMs,
            request.CircuitNumericId,
            request.PublicInputLayoutVersion,
            circuitId,
            credentialLevel,
            issuerResponse,
            commitment);
        return Result<AnonymousCredentialIssueResponseCoreModel>.Success(response);
    }

    private Task RecordIssuanceAuditAsync(
        int userId,
        long epoch,
        string status,
        string? traceId,
        CancellationToken cancellationToken)
    {
        string normalizedStatus = NormalizeToken(status, 32);
        return auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Security,
            AuditTypeCatalog.Security,
            AuditActionCatalog.AnonymousCredentialIssued,
            string.Equals(normalizedStatus, AnonymousCredentialIssuanceStatuses.Issued, StringComparison.Ordinal)
                ? AuditOutcomeCatalog.Success
                : AuditOutcomeCatalog.Denied,
            string.Equals(normalizedStatus, AnonymousCredentialIssuanceStatuses.Issued, StringComparison.Ordinal)
                ? AuditSeverityCatalog.Info
                : AuditSeverityCatalog.Warning,
            "匿名凭证签发结果",
            ActorType: AuditActorTypeCatalog.User,
            ActorId: userId.ToString(CultureInfo.InvariantCulture),
            TargetType: "anonymous_credential_issuance",
            TargetId: epoch.ToString(CultureInfo.InvariantCulture),
            ReasonCode: normalizedStatus,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["epoch"] = epoch,
                ["status"] = normalizedStatus
            }),
            cancellationToken);
    }

    private static AnonymousCredentialIssuerOptions ResolveOptions(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection("AnonymousCredentialIssuer");
        return new AnonymousCredentialIssuerOptions(
            section.GetValue("AllowBannedAccountIssuance", false),
            Math.Clamp(section.GetValue("MaxBlindedRequestBytes", AnonymousCredentialIssuerLimits.MaxBlindedRequestBytes), 256, AnonymousCredentialIssuerLimits.MaxIssueRequestFrameBytes),
            Math.Clamp(section.GetValue("MaxClientNonceBytes", AnonymousCredentialIssuerLimits.MaxClientNonceBytes), 16, 1024),
            Math.Clamp(section.GetValue("EpochDurationMinutes", DefaultEpochDurationMinutes), 60, 60 * 24 * 31),
            Math.Clamp(section.GetValue("CredentialTtlMinutes", DefaultCredentialTtlMinutes), 60, 60 * 24 * 31));
    }

    private static long ResolveCurrentEpoch(DateTimeOffset now, int epochDurationMinutes)
    {
        long epochDurationMs = (long)epochDurationMinutes * 60_000L;
        return now.ToUnixTimeMilliseconds() / epochDurationMs;
    }

    private static string ComputeRequestHash(
        AnonymousCredentialIssueRequestCoreModel request,
        string circuitId,
        long epoch)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> numberBuffer = stackalloc byte[16];
        BinaryPrimitives.WriteInt64LittleEndian(numberBuffer[..8], epoch);
        hash.AppendData(numberBuffer[..8]);
        BinaryPrimitives.WriteUInt32LittleEndian(numberBuffer[..4], request.CircuitNumericId);
        hash.AppendData(numberBuffer[..4]);
        BinaryPrimitives.WriteUInt16LittleEndian(numberBuffer[..2], request.PublicInputLayoutVersion);
        hash.AppendData(numberBuffer[..2]);
        AppendUtf8(hash, circuitId);
        AppendUtf8(hash, NormalizeToken(request.CredentialLevel, AnonymousCredentialIssuerLimits.MaxCredentialLevelChars));
        hash.AppendData(request.BlindedRequest);
        hash.AppendData(request.ClientNonce);
        return ToLowerHex(hash.GetHashAndReset());
    }

    private static byte[] CreateIssuerResponse(string requestHash)
    {
        byte[] issuerResponse = new byte[64];
        RandomNumberGenerator.Fill(issuerResponse);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendAscii(hash, requestHash);
        hash.AppendData(issuerResponse.AsSpan(0, 32));
        byte[] binding = hash.GetHashAndReset();
        binding.CopyTo(issuerResponse.AsSpan(32, 32));
        return issuerResponse;
    }

    private static byte[] CreateCredentialCommitment(string requestHash, ReadOnlySpan<byte> issuerResponse)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendAscii(hash, requestHash);
        hash.AppendData(issuerResponse);
        return hash.GetHashAndReset();
    }

    private static void AppendUtf8(IncrementalHash hash, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        hash.AppendData(bytes);
    }

    private static void AppendAscii(IncrementalHash hash, string value)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(value);
        hash.AppendData(bytes);
    }

    private static string NormalizeToken(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant().Replace('-', '_');
        if (normalized.Length <= maxLength)
        {
            return normalized;
        }

        return normalized[..maxLength];
    }

    private static string? NormalizeTraceId(string? traceId)
    {
        string normalized = (traceId ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return null;
        }

        return normalized.Length <= 64 ? normalized : normalized[..64];
    }

    private static string ToLowerHex(byte[] bytes)
        => Convert.ToHexString(bytes).ToLowerInvariant();

    private sealed record AnonymousCredentialIssuerOptions(
        bool AllowBannedAccountIssuance,
        int MaxBlindedRequestBytes,
        int MaxClientNonceBytes,
        int EpochDurationMinutes,
        int CredentialTtlMinutes);

    private sealed class AnonymousCredentialEligibilityRow
    {
        public int Id { get; set; }
        public int Status { get; set; }
        public DateTime? DeletedAt { get; set; }
        public string AnonymousCredentialLevel { get; set; } = AnonymousCredentialLevels.Basic;
        public string AnonymousCredentialStatus { get; set; } = AnonymousCredentialStatuses.Active;
    }
}
