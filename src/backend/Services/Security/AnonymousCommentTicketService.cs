using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Shared.Contracts.Validation;

namespace FsusBlog.Server.Services.Security;

public static class AnonymousCommentTicketStatuses
{
    public const string Issued = "issued";
    public const string ValidationFailed = "validation_failed";
    public const string RootExpired = "root_expired";
    public const string ProofInvalid = "proof_invalid";
    public const string NullifierBlocked = "nullifier_blocked";
    public const string ScopeLimitExceeded = "scope_limit_exceeded";
}

public sealed record AnonymousCommentTicketPayload(
    int ArticleId,
    string Scope,
    long? ParentId,
    long? RootId,
    long? ReplyToCommentId,
    string NullifierHash,
    long CredentialEpoch,
    string CredentialLevel,
    string ReputationBucket,
    long ExpiresAtUnixMs);

public sealed record AnonymousCommentTicketIssueResult(
    bool Issued,
    string Status,
    string PublicMessage,
    AnonymousCommentTicketResponseCoreModel Response)
{
    public static AnonymousCommentTicketIssueResult Success(AnonymousCommentTicketResponseCoreModel response)
        => new(true, AnonymousCommentTicketStatuses.Issued, "anonymous_comment_ticket_issued", response);

    public static AnonymousCommentTicketIssueResult Failure(string status)
        => new(false, status, "anonymous_comment_ticket_denied", default);
}

public interface IAnonymousCommentTicketService
{
    Task<AnonymousCommentTicketIssueResult> IssueAsync(
        AnonymousCommentTicketRequestCoreModel request,
        CancellationToken cancellationToken = default);

    Task<CacheReadResult<AnonymousCommentTicketPayload>> ConsumeTicketAsync(
        byte[] ticket,
        CancellationToken cancellationToken = default);
}

public sealed class AnonymousCommentTicketService(
    IUnifiedCache cache,
    IAnonymousCredentialRootService rootService,
    IZkAnonymousProofService proofService,
    ICommentAnonymousNullifierService nullifierService,
    IAnonymousCommentPolicyService policyService,
    IConfiguration configuration,
    TimeProvider timeProvider) : IAnonymousCommentTicketService
{
    private const int TicketBytes = 32;
    private const int MinHashBytes = 16;
    private const int MaxHashBytes = 64;
    private const int MaxProofBytes = AnonymousPrivacyContract.MaxGroth16ProofBytes;
    private const int MaxPublicInputsBytes = AnonymousPrivacyContract.MaxAnonymousTicketPublicInputsBytes;
    private const int MaxScopeChars = AnonymousPrivacyContract.MaxScopeBytes;
    private const string ActionContext = "comment.create";
    private const string DefaultCredentialLevel = "strong_anonymous";
    private const string DefaultReputationBucket = "unrated";
    private const string ModerationPepperKey = "Moderation:Pepper";
    private static readonly TimeSpan DefaultTicketTtl = TimeSpan.FromSeconds(120);
    private readonly byte[] _moderationSubjectHashKey = CreateModerationSubjectHashKey(configuration);

    public const int MaxRequestFrameBytes = 32 * 1024;

    public async Task<AnonymousCommentTicketIssueResult> IssueAsync(
        AnonymousCommentTicketRequestCoreModel request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        string scope = NormalizeScope(request.Scope, request.ArticleId);
        if (!PassesCheapValidation(request, scope))
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.ValidationFailed);
        }

        Result<AnonymousCredentialRootSnapshotCoreModel> rootResult = await rootService.GetCurrentSnapshotAsync(cancellationToken);
        if (rootResult.IsFailure || !RootMatchesRequest(rootResult.Value, request))
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.RootExpired);
        }

        AnonymousCredentialRootSnapshotCoreModel root = rootResult.Value;
        string nullifierHash = Convert.ToHexStringLower(request.NullifierHash);
        string credentialCommitment = Convert.ToHexStringLower(request.CredentialCommitment);
        string credentialRoot = Convert.ToHexStringLower(request.CredentialRoot);
        string revocationRoot = Convert.ToHexStringLower(request.RevocationRoot);
        string issuerPublicKeyHash = root.IssuerPublicKeyHash;
        string credentialLevel = NormalizeRequiredToken(request.CredentialLevel, DefaultCredentialLevel, 32);
        string reputationBucket = NormalizeRequiredToken(request.ReputationBucket, DefaultReputationBucket, 64);
        AnonymousCommentPolicySnapshot policy = await policyService.GetCurrentAsync(cancellationToken);
        string policyHash = AnonymousCommentPolicySnapshotHash.Resolve(policy);
        if (!IsHexHash(credentialCommitment, minLength: 32, maxLength: 128) ||
            !IsHexHash(issuerPublicKeyHash, minLength: 32, maxLength: 128) ||
            !IsHexHash(policyHash, minLength: 64, maxLength: 64) ||
            !string.Equals(issuerPublicKeyHash, root.IssuerPublicKeyHash, StringComparison.OrdinalIgnoreCase))
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.ValidationFailed);
        }

        var proofRequest = new ZkProofVerificationRequest(
            ActionContext,
            scope,
            request.CircuitId.Trim(),
            request.VerifyingKeyHash.Trim(),
            request.PublicInputLayoutVersion,
            request.CredentialEpoch,
            nullifierHash,
            credentialCommitment,
            credentialRoot,
            credentialLevel,
            reputationBucket,
            policyHash,
            [.. request.Groth16Proof],
            revocationRoot,
            issuerPublicKeyHash);
        if (!PublicInputsMatchProofRequest(request.PublicInputs, proofRequest))
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.ValidationFailed);
        }

        ZkProofVerificationResult proof = await proofService.VerifyCommentProofAsync(proofRequest, cancellationToken);
        if (!proof.Verified)
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.ProofInvalid);
        }

        NullifierReservationResult precheck = await nullifierService.PrecheckAsync(nullifierHash, scope, cancellationToken);
        if (!precheck.Allowed)
        {
            string status = string.Equals(precheck.Status, "blocked", StringComparison.Ordinal)
                ? AnonymousCommentTicketStatuses.NullifierBlocked
                : AnonymousCommentTicketStatuses.ScopeLimitExceeded;
            return AnonymousCommentTicketIssueResult.Failure(status);
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        TimeSpan ttl = ResolveTicketTtl();
        DateTimeOffset expiresAt = now.Add(ttl);
        byte[] ticket = RandomNumberGenerator.GetBytes(TicketBytes);
        string ticketHash = HashTicket(ticket);
        credentialLevel = string.IsNullOrWhiteSpace(credentialLevel) ? DefaultCredentialLevel : credentialLevel;
        var payload = new AnonymousCommentTicketPayload(
            request.ArticleId,
            scope,
            TryParseOptionalCommentId(request.ParentId, out long? parentId) ? parentId : null,
            TryParseOptionalCommentId(request.RootId, out long? rootId) ? rootId : null,
            TryParseOptionalCommentId(request.ReplyToCommentId, out long? replyToCommentId) ? replyToCommentId : null,
            nullifierHash,
            request.CredentialEpoch,
            credentialLevel,
            reputationBucket,
            expiresAt.ToUnixTimeMilliseconds());
        await cache.SetRawAsync(
            CachePolicyId.AnonymousCommentTicket,
            ticketHash,
            AnonymousCommentTicketPayloadCodec.Encode(payload),
            ttl,
            cancellationToken);

        byte[] moderationSubjectHash = CreateModerationSubjectHash(nullifierHash, _moderationSubjectHashKey);
        var response = new AnonymousCommentTicketResponseCoreModel(
            request.CredentialEpoch,
            expiresAt.ToUnixTimeMilliseconds(),
            credentialLevel,
            ticket,
            moderationSubjectHash);
        return AnonymousCommentTicketIssueResult.Success(response);
    }

    public Task<CacheReadResult<AnonymousCommentTicketPayload>> ConsumeTicketAsync(
        byte[] ticket,
        CancellationToken cancellationToken = default)
    {
        if (ticket is null || ticket.Length != TicketBytes)
        {
            return Task.FromResult(new CacheReadResult<AnonymousCommentTicketPayload>(false, default));
        }

        return cache.ConsumeOnceAndGetAsync(
            CachePolicyId.AnonymousCommentTicket,
            HashTicket(ticket),
            AnonymousCommentTicketPayloadCodec.TryDecode,
            cancellationToken);
    }

    public static string HashTicket(byte[] ticket)
        => Convert.ToHexStringLower(SHA256.HashData(ticket ?? []));

    public static byte[] CreateModerationSubjectHash(string nullifierHash, IConfiguration configuration)
        => CreateModerationSubjectHash(nullifierHash, CreateModerationSubjectHashKey(configuration));

    private static byte[] CreateModerationSubjectHash(string nullifierHash, byte[] key)
        => HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(nullifierHash));

    private static byte[] CreateModerationSubjectHashKey(IConfiguration configuration)
    {
        string? pepper = configuration[ModerationPepperKey];
        if (string.IsNullOrWhiteSpace(pepper) || pepper.Trim().Length < 32)
        {
            throw new InvalidOperationException("Moderation:Pepper must be configured with at least 32 characters.");
        }

        return Encoding.UTF8.GetBytes(pepper.Trim());
    }

    private static bool PassesCheapValidation(AnonymousCommentTicketRequestCoreModel request, string scope)
    {
        if (request.ArticleId <= 0 ||
            request.CredentialEpoch <= 0 ||
            request.CircuitNumericId == 0 ||
            request.PublicInputLayoutVersion == 0 ||
            request.PublicInputLayoutVersion != AnonymousPrivacyContract.PublicInputLayoutVersion ||
            !string.Equals(request.ActionContext, AnonymousPrivacyContract.CommentCreateActionContext, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(request.CircuitId) ||
            !string.Equals(request.CircuitId, AnonymousPrivacyContract.CircuitId, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(request.VerifyingKeyHash) ||
            !string.Equals(scope, $"article:{request.ArticleId}", StringComparison.Ordinal) ||
            request.Groth16Proof is null ||
            request.Groth16Proof.Length is 0 or > MaxProofBytes ||
            request.PublicInputs is null ||
            request.PublicInputs.Length is 0 or > MaxPublicInputsBytes ||
            request.NullifierHash is null ||
            request.NullifierHash.Length is < MinHashBytes or > MaxHashBytes ||
            request.CredentialCommitment is null ||
            request.CredentialCommitment.Length is < MinHashBytes or > MaxHashBytes ||
            request.CredentialRoot is null ||
            request.CredentialRoot.Length is < MinHashBytes or > MaxHashBytes ||
            request.RevocationRoot is null ||
            request.RevocationRoot.Length is < MinHashBytes or > MaxHashBytes ||
            string.IsNullOrWhiteSpace(request.CredentialLevel) ||
            string.IsNullOrWhiteSpace(request.ReputationBucket) ||
            !TryParseOptionalCommentId(request.ParentId, out _) ||
            !TryParseOptionalCommentId(request.RootId, out _) ||
            !TryParseOptionalCommentId(request.ReplyToCommentId, out _))
        {
            return false;
        }

        return IsScope(scope);
    }

    private bool RootMatchesRequest(AnonymousCredentialRootSnapshotCoreModel root, AnonymousCommentTicketRequestCoreModel request)
        => root.ZkAnonymousEnabled &&
            root.VerifierConfigured &&
            root.CredentialEpoch == request.CredentialEpoch &&
            root.CircuitNumericId == request.CircuitNumericId &&
            root.PublicInputLayoutVersion == request.PublicInputLayoutVersion &&
            string.Equals(root.CircuitId, request.CircuitId, StringComparison.Ordinal) &&
            string.Equals(root.VerifyingKeyHash, request.VerifyingKeyHash, StringComparison.Ordinal) &&
            root.CredentialRoot.AsSpan().SequenceEqual(request.CredentialRoot) &&
            root.RevocationRoot.AsSpan().SequenceEqual(request.RevocationRoot) &&
            root.RootGraceExpiresAtUnixMs > timeProvider.GetUtcNow().ToUnixTimeMilliseconds();

    private static string NormalizeScope(string? value, int articleId)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length == 0 ? $"article:{articleId}" : normalized;
    }

    private static bool PublicInputsMatchProofRequest(byte[] publicInputs, ZkProofVerificationRequest proofRequest)
    {
        ReadOnlyMemory<byte> expected = NativeGroth16PublicInputCodec.Encode(new ProductionZkProofBackendRequest(
            proofRequest.ActionContext,
            proofRequest.Scope,
            proofRequest.CircuitId,
            proofRequest.VerifyingKeyHash,
            proofRequest.PublicInputLayoutVersion,
            proofRequest.CredentialEpoch,
            proofRequest.NullifierHash,
            proofRequest.CredentialCommitment,
            proofRequest.CredentialRoot,
            proofRequest.CredentialLevel,
            proofRequest.ReputationBucket,
            proofRequest.PolicyHash,
            proofRequest.Proof,
            proofRequest.RevocationRoot,
            proofRequest.IssuerPublicKeyHash));
        return expected.Span.SequenceEqual(publicInputs);
    }

    private static string NormalizeRequiredToken(string? value, string fallback, int maxLength)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private TimeSpan ResolveTicketTtl()
    {
        int seconds = configuration.GetValue("AnonymousIdentity:AnonymousCommentTicketTtlSeconds", (int)DefaultTicketTtl.TotalSeconds);
        return TimeSpan.FromSeconds(Math.Clamp(seconds, 15, 600));
    }

    private static bool IsScope(string value)
        => value.Length is > 0 and <= MaxScopeChars &&
            value.All(static ch => char.IsLetterOrDigit(ch) || ch is ':' or '-' or '_' or '.');

    private static bool TryParseOptionalCommentId(string? raw, out long? value)
    {
        value = null;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return true;
        }

        if (long.TryParse(raw, out long parsed) && parsed > 0)
        {
            value = parsed;
            return true;
        }

        return false;
    }

    private static bool IsHexHash(string value, int minLength, int maxLength)
    {
        if (value.Length < minLength || value.Length > maxLength)
        {
            return false;
        }

        return HexText.IsHex(value.AsSpan());
    }
}

internal static class AnonymousCommentTicketPayloadCodec
{
    private const byte Version = 2;
    private const byte LegacyVersion = 1;
    private const int FixedBytes = 1 + 4 + 1 + 8 + 8 + 8 + 8 + 8;
    private const int LegacyFixedBytes = 1 + 4 + 8 + 8;

    public static byte[] Encode(AnonymousCommentTicketPayload payload)
    {
        byte[] scope = Encoding.UTF8.GetBytes(payload.Scope);
        byte[] nullifier = Encoding.UTF8.GetBytes(payload.NullifierHash);
        byte[] credentialLevel = Encoding.UTF8.GetBytes(payload.CredentialLevel);
        byte[] reputationBucket = Encoding.UTF8.GetBytes(payload.ReputationBucket);
        byte[] buffer = new byte[FixedBytes + EncodedLength(scope) + EncodedLength(nullifier) + EncodedLength(credentialLevel) + EncodedLength(reputationBucket)];
        int offset = 0;
        buffer[offset++] = Version;
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(offset, 4), payload.ArticleId);
        offset += 4;
        byte replyFlags = 0;
        if (payload.ParentId.HasValue)
        {
            replyFlags |= 1;
        }

        if (payload.RootId.HasValue)
        {
            replyFlags |= 1 << 1;
        }

        if (payload.ReplyToCommentId.HasValue)
        {
            replyFlags |= 1 << 2;
        }

        buffer[offset++] = replyFlags;
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(offset, 8), payload.ParentId ?? 0);
        offset += 8;
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(offset, 8), payload.RootId ?? 0);
        offset += 8;
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(offset, 8), payload.ReplyToCommentId ?? 0);
        offset += 8;
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(offset, 8), payload.CredentialEpoch);
        offset += 8;
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(offset, 8), payload.ExpiresAtUnixMs);
        offset += 8;
        WriteBytes(buffer, ref offset, scope);
        WriteBytes(buffer, ref offset, nullifier);
        WriteBytes(buffer, ref offset, credentialLevel);
        WriteBytes(buffer, ref offset, reputationBucket);
        return buffer;
    }

    public static (bool Success, AnonymousCommentTicketPayload? Value) TryDecode(ReadOnlyMemory<byte> bytes)
    {
        ReadOnlySpan<byte> span = bytes.Span;
        if (span.Length < LegacyFixedBytes || (span[0] != Version && span[0] != LegacyVersion))
        {
            return (false, null);
        }

        int offset = 1;
        int articleId = BinaryPrimitives.ReadInt32LittleEndian(span.Slice(offset, 4));
        offset += 4;
        long? parentId = null;
        long? rootId = null;
        long? replyToCommentId = null;
        if (span[0] == Version)
        {
            if (span.Length < FixedBytes)
            {
                return (false, null);
            }

            byte replyFlags = span[offset++];
            long rawParentId = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(offset, 8));
            offset += 8;
            long rawRootId = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(offset, 8));
            offset += 8;
            long rawReplyToCommentId = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(offset, 8));
            offset += 8;
            if (!DecodeOptionalId(replyFlags, 0, rawParentId, out parentId) ||
                !DecodeOptionalId(replyFlags, 1, rawRootId, out rootId) ||
                !DecodeOptionalId(replyFlags, 2, rawReplyToCommentId, out replyToCommentId))
            {
                return (false, null);
            }
        }

        long credentialEpoch = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(offset, 8));
        offset += 8;
        long expiresAt = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(offset, 8));
        offset += 8;
        if (!TryReadString(span, ref offset, out string scope) ||
            !TryReadString(span, ref offset, out string nullifierHash) ||
            !TryReadString(span, ref offset, out string credentialLevel) ||
            !TryReadString(span, ref offset, out string reputationBucket) ||
            offset != span.Length)
        {
            return (false, null);
        }

        return (true, new AnonymousCommentTicketPayload(
            articleId,
            scope,
            parentId,
            rootId,
            replyToCommentId,
            nullifierHash,
            credentialEpoch,
            credentialLevel,
            reputationBucket,
            expiresAt));
    }

    private static int EncodedLength(byte[] bytes)
        => 2 + bytes.Length;

    private static void WriteBytes(byte[] buffer, ref int offset, byte[] bytes)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(offset, 2), (ushort)bytes.Length);
        offset += 2;
        bytes.CopyTo(buffer.AsSpan(offset, bytes.Length));
        offset += bytes.Length;
    }

    private static bool DecodeOptionalId(byte flags, int bit, long rawValue, out long? value)
    {
        value = null;
        bool hasValue = (flags & (1 << bit)) != 0;
        if (!hasValue)
        {
            return rawValue == 0;
        }

        if (rawValue <= 0)
        {
            return false;
        }

        value = rawValue;
        return true;
    }

    private static bool TryReadString(ReadOnlySpan<byte> source, ref int offset, out string value)
    {
        value = string.Empty;
        if (offset > source.Length - 2)
        {
            return false;
        }

        int length = BinaryPrimitives.ReadUInt16LittleEndian(source.Slice(offset, 2));
        offset += 2;
        if (length < 0 || offset > source.Length - length)
        {
            return false;
        }

        value = Encoding.UTF8.GetString(source.Slice(offset, length));
        offset += length;
        return true;
    }
}
