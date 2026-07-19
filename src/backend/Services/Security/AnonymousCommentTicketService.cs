using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Shared.Contracts.Validation;

namespace FsusBlog.Server.Services.Security;

public static class AnonymousCommentTicketStatuses
{
    public const string Issued = "issued";
    public const string ValidationFailed = "validation_failed";
    public const string PolicyDisabled = "zk_anonymous_disabled";
    public const string RootExpired = "root_expired";
    public const string ProofInvalid = "proof_invalid";
    public const string NullifierBlocked = "nullifier_blocked";
    public const string ScopeLimitExceeded = "scope_limit_exceeded";
    public const string AnonymitySetTooSmall = "anonymity_set_too_small";
}

public sealed record AnonymousCommentTicketPayload(
    int ArticleId,
    string Scope,
    long? ParentId,
    long? RootId,
    long? ReplyToCommentId,
    string NullifierHash,
    string RateClass,
    bool RequiresModeration,
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
    ICacheRawWriter cacheWriter,
    ICacheOneTimeStore oneTimeStore,
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
    private const string ModerationPepperKey = "Moderation:Pepper";
    private static readonly TimeSpan s_defaultTicketTtl = TimeSpan.FromSeconds(120);
    private readonly byte[] _moderationSubjectHashKey = CreateModerationSubjectHashKey(configuration);
    private readonly AnonymitySetPolicy _anonymitySetPolicy = new(configuration);

    public const int MaxRequestFrameBytes = 32 * 1024;

    public async Task<AnonymousCommentTicketIssueResult> IssueAsync(
        AnonymousCommentTicketRequestCoreModel request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        string scope = NormalizeScope(request.Scope);
        if (!PassesCheapValidation(request, scope))
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.ValidationFailed);
        }

        AnonymousCommentPolicySnapshot policy = await policyService.GetCurrentAsync(cancellationToken);
        if (!policy.AnonymousCommentsEnabled || !policy.ZkAnonymousEnabled)
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.PolicyDisabled);
        }

        Result<AnonymousCredentialRootSnapshotCoreModel> rootResult = await rootService.GetCurrentSnapshotAsync(cancellationToken);
        if (rootResult.IsFailure || !RootMatchesRequest(rootResult.Value, request))
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.RootExpired);
        }

        AnonymousCredentialRootSnapshotCoreModel root = rootResult.Value;
        string nullifierHash = Convert.ToHexStringLower(request.NullifierHash);
        string credentialRoot = Convert.ToHexStringLower(request.CredentialRoot);
        string revocationRoot = Convert.ToHexStringLower(request.RevocationRoot);
        string issuerPublicKeyHash = root.IssuerPublicKeyHash;
        string policyHash = AnonymousCommentPolicySnapshotHash.Resolve(policy);
        if (!IsHexHash(issuerPublicKeyHash, minLength: 32, maxLength: 128) ||
            !IsHexHash(policyHash, minLength: 64, maxLength: 64) ||
            !SecurityStringComparisons.FixedTimeEqualsHex(issuerPublicKeyHash, root.IssuerPublicKeyHash))
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.ValidationFailed);
        }

        var proofRequest = new ZkProofVerificationRequest(
            ActionContext,
            scope,
            request.CircuitId.Trim(),
            request.VerifyingKeyHash.Trim(),
            request.PublicInputLayoutVersion,
            nullifierHash,
            credentialRoot,
            policyHash,
            request.IsEligible,
            request.MayComment,
            request.RateClass.Trim().ToLowerInvariant(),
            request.RequiresModeration,
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

        AnonymitySetDecision anonymitySet = _anonymitySetPolicy.Evaluate(
            request.IsEligible,
            request.MayComment,
            request.RateClass,
            request.RequiresModeration,
            root.CircuitMetadata);
        if (!anonymitySet.Allowed)
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.AnonymitySetTooSmall);
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
        long expiresAtUnixMs = Math.Min(
            now.Add(ttl).ToUnixTimeMilliseconds(),
            root.RootGraceExpiresAtUnixMs);
        if (expiresAtUnixMs <= now.ToUnixTimeMilliseconds())
        {
            return AnonymousCommentTicketIssueResult.Failure(AnonymousCommentTicketStatuses.RootExpired);
        }

        DateTimeOffset expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(expiresAtUnixMs);
        TimeSpan effectiveTtl = expiresAt - now;
        byte[] ticket = RandomNumberGenerator.GetBytes(TicketBytes);
        string ticketHash = HashTicket(ticket);
        var payload = new AnonymousCommentTicketPayload(
            request.ArticleId,
            scope,
            TryParseOptionalCommentId(request.ParentId, out long? parentId) ? parentId : null,
            TryParseOptionalCommentId(request.RootId, out long? rootId) ? rootId : null,
            TryParseOptionalCommentId(request.ReplyToCommentId, out long? replyToCommentId) ? replyToCommentId : null,
            nullifierHash,
            anonymitySet.EffectiveRateClass,
            request.RequiresModeration,
            expiresAt.ToUnixTimeMilliseconds());
        await cacheWriter.SetRawAsync(
            CachePolicyId.AnonymousCommentTicket,
            ticketHash,
            AnonymousCommentTicketPayloadCodec.Encode(payload),
            effectiveTtl,
            cancellationToken);

        byte[] moderationSubjectHash = CreateModerationSubjectHash(nullifierHash, _moderationSubjectHashKey);
        var response = new AnonymousCommentTicketResponseCoreModel(
            expiresAt.ToUnixTimeMilliseconds(),
            anonymitySet.EffectiveRateClass,
            request.RequiresModeration,
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

        return oneTimeStore.ConsumeOnceAndGetAsync(
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
        if (!TryParseOptionalCommentId(request.ParentId, out long? parentId) ||
            !TryParseOptionalCommentId(request.RootId, out long? rootId) ||
            !TryParseOptionalCommentId(request.ReplyToCommentId, out long? replyToCommentId) ||
            !AnonymousCommentScopePolicy.TryCreateTicketScope(
                request.ArticleId,
                parentId,
                rootId,
                replyToCommentId,
                out string serverScope) ||
            !string.Equals(scope, serverScope, StringComparison.Ordinal))
        {
            return false;
        }

        if (request.ArticleId <= 0 ||
            request.CircuitNumericId == 0 ||
            request.PublicInputLayoutVersion == 0 ||
            request.PublicInputLayoutVersion != AnonymousPrivacyContract.PublicInputLayoutVersion ||
            !string.Equals(request.ActionContext, AnonymousPrivacyContract.CommentCreateActionContext, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(request.CircuitId) ||
            !string.Equals(request.CircuitId, AnonymousPrivacyContract.CircuitId, StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(request.VerifyingKeyHash) ||
            request.Groth16Proof is null ||
            request.Groth16Proof.Length is 0 or > MaxProofBytes ||
            request.PublicInputs is null ||
            request.PublicInputs.Length is 0 or > MaxPublicInputsBytes ||
            request.NullifierHash is null ||
            request.NullifierHash.Length is < MinHashBytes or > MaxHashBytes ||
            request.CredentialRoot is null ||
            request.CredentialRoot.Length is < MinHashBytes or > MaxHashBytes ||
            request.RevocationRoot is null ||
            request.RevocationRoot.Length is < MinHashBytes or > MaxHashBytes ||
            !request.IsEligible ||
            !request.MayComment ||
            !IsPublicRateClass(request.RateClass))
        {
            return false;
        }

        return IsScope(scope);
    }

    private bool RootMatchesRequest(AnonymousCredentialRootSnapshotCoreModel root, AnonymousCommentTicketRequestCoreModel request)
        => root.ZkAnonymousEnabled &&
            root.VerifierConfigured &&
            root.CircuitNumericId == request.CircuitNumericId &&
            root.PublicInputLayoutVersion == request.PublicInputLayoutVersion &&
            string.Equals(root.CircuitId, request.CircuitId, StringComparison.Ordinal) &&
            string.Equals(root.VerifyingKeyHash, request.VerifyingKeyHash, StringComparison.Ordinal) &&
            root.CredentialRoot.AsSpan().SequenceEqual(request.CredentialRoot) &&
            root.RevocationRoot.AsSpan().SequenceEqual(request.RevocationRoot) &&
            root.RootGraceExpiresAtUnixMs > timeProvider.GetUtcNow().ToUnixTimeMilliseconds();

    private static string NormalizeScope(string? value)
        => string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();

    private static bool PublicInputsMatchProofRequest(byte[] publicInputs, ZkProofVerificationRequest proofRequest)
    {
        ReadOnlyMemory<byte> expected = NativeGroth16PublicInputCodec.Encode(new ProductionZkProofBackendRequest(
            proofRequest.ActionContext,
            proofRequest.Scope,
            proofRequest.CircuitId,
            proofRequest.VerifyingKeyHash,
            proofRequest.PublicInputLayoutVersion,
            proofRequest.NullifierHash,
            proofRequest.CredentialRoot,
            proofRequest.PolicyHash,
            proofRequest.IsEligible,
            proofRequest.MayComment,
            proofRequest.RateClass,
            proofRequest.RequiresModeration,
            proofRequest.Proof,
            proofRequest.RevocationRoot,
            proofRequest.IssuerPublicKeyHash));
        return expected.Span.SequenceEqual(publicInputs);
    }

    private static bool IsPublicRateClass(string? value)
        => string.Equals(value?.Trim(), AnonymousPrivacyContract.CommonRateClass, StringComparison.Ordinal) ||
            string.Equals(value?.Trim(), AnonymousPrivacyContract.UnknownRateClass, StringComparison.Ordinal);

    private TimeSpan ResolveTicketTtl()
    {
        int seconds = configuration.GetValue("AnonymousIdentity:AnonymousCommentTicketTtlSeconds", (int)s_defaultTicketTtl.TotalSeconds);
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
    private const byte Version = 3;
    private const int FixedBytes = 1 + 4 + 1 + 8 + 8 + 8 + 1 + 8;

    public static byte[] Encode(AnonymousCommentTicketPayload payload)
    {
        byte[] scope = Encoding.UTF8.GetBytes(payload.Scope);
        byte[] nullifier = Encoding.UTF8.GetBytes(payload.NullifierHash);
        byte[] rateClass = Encoding.UTF8.GetBytes(payload.RateClass);
        byte[] buffer = new byte[FixedBytes + EncodedLength(scope) + EncodedLength(nullifier) + EncodedLength(rateClass)];
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
        buffer[offset++] = payload.RequiresModeration ? (byte)1 : (byte)0;
        BinaryPrimitives.WriteInt64LittleEndian(buffer.AsSpan(offset, 8), payload.ExpiresAtUnixMs);
        offset += 8;
        WriteBytes(buffer, ref offset, scope);
        WriteBytes(buffer, ref offset, nullifier);
        WriteBytes(buffer, ref offset, rateClass);
        return buffer;
    }

    public static (bool Success, AnonymousCommentTicketPayload? Value) TryDecode(ReadOnlyMemory<byte> bytes)
    {
        ReadOnlySpan<byte> span = bytes.Span;
        if (span.Length < FixedBytes || span[0] != Version)
        {
            return (false, null);
        }

        int offset = 1;
        int articleId = BinaryPrimitives.ReadInt32LittleEndian(span.Slice(offset, 4));
        offset += 4;
        long? parentId = null;
        long? rootId = null;
        long? replyToCommentId = null;
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

        byte requiresModeration = span[offset++];
        if (requiresModeration > 1)
        {
            return (false, null);
        }
        long expiresAt = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(offset, 8));
        offset += 8;
        if (!TryReadString(span, ref offset, out string scope) ||
            !TryReadString(span, ref offset, out string nullifierHash) ||
            !TryReadString(span, ref offset, out string rateClass) ||
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
            rateClass,
            requiresModeration == 1,
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
