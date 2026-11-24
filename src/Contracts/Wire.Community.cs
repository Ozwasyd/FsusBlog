using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using static FsusBlog.V2.Contracts.WireLimits;

namespace FsusBlog.V2.Contracts;

public sealed record AuthorAppealInput(string? Reason, string? Challenge);
public sealed record AdminAppealInput(string? Decision, string? Reason);
public sealed record AdminAppealResult(bool Success, string Code, long? AppealId);
public sealed record AuthorAppealRow(int Article, long Comment, string Body, int Status, int Appeal, string? DecisionReason,
    bool Editable);
public sealed record AdminAppealRow(long Appeal, int Article, long Comment, string Body, string Reason);

internal sealed record CommentAuthorChallengeRequest(string? Purpose, string? CapabilitySecret);
internal sealed record CommentAuthorDeleteRequest(string? Challenge, string? CapabilitySecret);
public sealed record CommentAuthorEditRequest(
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] long ExpectedVersion, string Content, string Challenge);
public sealed record CommentAuthorChallenge(bool Issued, string Challenge, DateTime ExpiresAtUtc, string? FailureCode, long CurrentVersion);
public sealed record CommentAuthorMutation(bool Success, string Code, long CurrentVersion, int ModerationStatus, DateTime? EditedAtUtc);

internal sealed record CommentReportPayload(string? ReasonCode, string? Detail, string? ScopedCredential);
public sealed record CommentReportRequest(string ReasonCode, string? Detail);
public sealed record CommentReportResult(bool Success, string Code, long ReportId, bool Duplicate);

public sealed record AdminCommentRevision(long Version, string Content, string ContentSha256,
    string Operation, DateTime CreatedAtUtc, string ActorMode = "public");
public sealed record AdminCommentTimeline(long CommentId, int ArticleId, short ProjectedStatus, short CurrentStatus,
    bool Consistent, bool Deleted, IReadOnlyList<AdminCommentTimelineEvent> Events);
public sealed record AdminCommentTimelineEvent(long Id, long CommentId, string EventType, short? PreviousStatus, short NextStatus,
    string ActorType, string? ReasonCode, DateTime OccurredAtUtc, string TransitionSource, long? CommentVersion,
    Guid? AdminPrincipal, string? DatabaseRole, long? AppealId);

public sealed record SitePasskeyRow(long CreatedAt, long? LastUsedAt, bool BackupEligible, bool BackedUp, bool Current);
public sealed record SitePasskeyManagedRow(string Reference, long Revision, string Name, SitePasskeyRow Metadata);
public sealed record SitePasskeyRename(string Reference, long ExpectedRevision, string Name);
public sealed record SitePasskeyRemove(string Reference, long ExpectedRevision);
public sealed record SiteSessionRow(string Id, long ExpiresAt, bool Current, int Method, bool Mfa);
public sealed record SiteSessionList(IReadOnlyList<SiteSessionRow> Sessions, bool HasMore);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(AuthorAppealInput))]
[JsonSerializable(typeof(AdminAppealInput))]
[JsonSerializable(typeof(AdminAppealResult))]
[JsonSerializable(typeof(CommentAuthorChallengeRequest))]
[JsonSerializable(typeof(CommentAuthorDeleteRequest))]
[JsonSerializable(typeof(CommentAuthorEditRequest))]
[JsonSerializable(typeof(CommentAuthorChallenge))]
[JsonSerializable(typeof(CommentAuthorMutation))]
[JsonSerializable(typeof(CommentReportPayload))]
[JsonSerializable(typeof(CommentReportResult))]
internal partial class CommentWireJson : JsonSerializerContext;

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(List<AdminCommentRevision>))]
[JsonSerializable(typeof(AdminCommentTimeline))]
internal partial class AdminCommentRevisionJson : JsonSerializerContext;

public static partial class Wire
{
    public const int CommentAppealPageSize = 24;
    public const int CommentAppealFrameBytes = 7000;
    public const long MaxCommentReportId = (1L << 53) - 1;
    private const long MaxAccountRenameUnixMs = 8_640_000_000_000_000L;
    private const long MaxCommentAuthorVersion = 9_007_199_254_740_991L;

    public static bool ValidAdminHandle(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > AdminHandleBytes || value[0] is < 'a' or > 'z') return false;
        for (var i = 1; i < value.Length; i++)
            if (value[i] is not ((>= 'a' and <= 'z') or (>= '0' and <= '9') or '_' or '.' or '-')) return false;
        return true;
    }

    public static bool ValidSiteDisplayName(string? value)
    {
        if (string.IsNullOrEmpty(value) || value != value.Trim()) return false;
        var runes = 0;
        foreach (var rune in value.EnumerateRunes())
            if (Rune.IsControl(rune) || ++runes > SiteDisplayNameChars) return false;
        return runes > 0 && Encoding.UTF8.GetByteCount(value) <= PublicCommentHandleBytes;
    }

    internal static void Validate(SiteDisplayNameState value)
    {
        if (value?.DisplayName is null || value.DisplayName.Length > 0 && !ValidSiteDisplayName(value.DisplayName))
            throw new ProtocolException("Invalid site display name state.");
    }

    internal static void Validate(SiteDisplayNameCommand value)
    {
        if (value is null || !ValidSiteDisplayName(value.DisplayName))
            throw new ProtocolException("Invalid site display name command.");
    }

    internal static void Validate(AdminHandleCommand value)
    {
        if (value is null || value.IdempotencyKey == Guid.Empty ||
            !ValidAdminHandle(value.ExpectedHandle) || !ValidAdminHandle(value.NewHandle) ||
            string.Equals(value.ExpectedHandle, value.NewHandle, StringComparison.Ordinal))
            throw new ProtocolException("Invalid administrator handle rename command.");
    }

    internal static void Validate(AdminHandleReceipt value)
    {
        if (value is null || !ValidAdminHandle(value.Handle) || value.HappenedAtUnixMs is <= 0 or > MaxAccountRenameUnixMs)
            throw new ProtocolException("Invalid administrator handle rename receipt.");
    }

    private static T? ReadCommentJson<T>(ReadOnlySpan<byte> payload, JsonTypeInfo<T> type) where T : class
    {
        try { return JsonSerializer.Deserialize(payload, type); }
        catch (JsonException) { return null; }
    }

    private static byte[] WriteCommentJson<T>(FrameType frame, T value, JsonTypeInfo<T> type) =>
        Aeds.Encode(frame, JsonSerializer.SerializeToUtf8Bytes(value, type));

    private static bool ValidCommentProof(string proof) => proof.Length == 43 && IsBase64Url(proof);

    public static AuthorAppealInput DecodeAuthorAppeal(ReadOnlySpan<byte> frame)
    {
        var request = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentAuthorAppealRequest),
            CommentWireJson.Default.AuthorAppealInput);
        return request is { Reason: not null, Challenge: { } proof } && ValidCommentProof(proof)
            ? request : throw new ProtocolException("Invalid author appeal.");
    }

    public static AdminAppealInput DecodeAdminAppeal(ReadOnlySpan<byte> frame)
    {
        var request = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentAppealDecisionRequest),
            CommentWireJson.Default.AdminAppealInput);
        return request is { Reason: not null, Decision: "granted" or "denied" }
            ? request : throw new ProtocolException("Invalid administrator appeal decision.");
    }

    public static byte[] EncodeAdminAppealResult(long id) =>
        WriteCommentJson(FrameType.CommentAppealDecisionResult, new(true, "ok", id), CommentWireJson.Default.AdminAppealResult);

    public static byte[] EncodeAuthorAppeals(IReadOnlyList<AuthorAppealRow> rows, bool more) =>
        EncodeFrame(FrameType.CommentAuthorAppeals, writer => writer.Bool(more).Items(rows,
            static (w, row) => w.I32(row.Article).I64(row.Comment).Text(row.Body, 4096).I32(row.Status).I32(row.Appeal)
                .Text(row.DecisionReason ?? "", 4000).Bool(row.Editable)));

    public static byte[] EncodeAdminCommentAppeals(IReadOnlyList<AdminAppealRow> rows, bool more) =>
        EncodeFrame(FrameType.AdminCommentAppeals, writer => writer.Bool(more).Items(rows,
            static (w, row) => w.I64(row.Appeal).I32(row.Article).I64(row.Comment).Text(row.Body, 4096).Text(row.Reason, 4000)));

    public static void ValidateCommentAuthorChallengeRequest(ReadOnlySpan<byte> frame) =>
        ReadCommentAuthorChallengePurpose(frame, allowAppeal: false);

    public static string ReadCommentAuthorChallengePurpose(ReadOnlySpan<byte> frame, bool allowAppeal, bool allowEdit = false)
    {
        var request = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentManagementChallengeRequest),
            CommentWireJson.Default.CommentAuthorChallengeRequest);
        if (request is { Purpose: "delete", CapabilitySecret: null }) return "delete";
        if (allowAppeal && request is { Purpose: "appeal", CapabilitySecret: null }) return "appeal";
        if (allowEdit && request is { Purpose: "edit", CapabilitySecret: null }) return "edit";
        throw new ProtocolException("Invalid comment author challenge request.");
    }

    public static CommentAuthorEditRequest DecodeCommentAuthorEditRequest(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > CommentAuthorEditFrameBytes)
            throw new ProtocolException("Comment edit request exceeds its frame limit.");
        var request = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentAuthorEditRequest),
            CommentWireJson.Default.CommentAuthorEditRequest);
        return request is { ExpectedVersion: > 0 and < MaxCommentAuthorVersion, Content.Length: > 0, Challenge: { } proof } &&
            ValidCommentProof(proof) ? request : throw new ProtocolException("Invalid comment author edit request.");
    }

    internal static void Validate(CommentAuthorEditDetail value)
    {
        if (value is not { ArticleId: > 0, Publication: > 0, CurrentVersion: > 0 and < MaxCommentAuthorVersion, Body.Length: > 0 })
            throw new ProtocolException("Invalid comment author edit detail.");
    }

    public static string ReadCommentAuthorDeleteRequest(ReadOnlySpan<byte> frame)
    {
        var request = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentAuthorStatusRequest),
            CommentWireJson.Default.CommentAuthorDeleteRequest);
        return request is { Challenge: { } proof, CapabilitySecret: "" } && ValidCommentProof(proof)
            ? proof : throw new ProtocolException("Invalid comment author delete request.");
    }

    public static byte[] EncodeCommentAuthorChallenge(CommentAuthorChallenge value) =>
        WriteCommentJson(FrameType.CommentManagementChallengeResponse, value, CommentWireJson.Default.CommentAuthorChallenge);

    public static byte[] EncodeCommentAuthorMutation(CommentAuthorMutation value) =>
        WriteCommentJson(FrameType.CommentAuthorMutationResult, value, CommentWireJson.Default.CommentAuthorMutation);

    public static long[] DecodeCommentAuthorEligibilityRequest(ReadOnlySpan<byte> frame)
    {
        var ids = DecodeFrame(FrameType.CommentAuthorEligibilityRequest, frame, static (ref Reader reader) =>
            reader.Items(1, CommentAuthorBatchSize, static () => new ProtocolException("Invalid comment eligibility count."),
                static (ref Reader r) => r.I64()));
        if (ids.Any(id => id <= 0) || ids.Distinct().Count() != ids.Length)
            throw new ProtocolException("Invalid comment eligibility coordinates.");
        return ids;
    }

    public static byte[] EncodeCommentAuthorEligibility(IReadOnlyList<long> ids)
    {
        if (ids.Count > CommentAuthorBatchSize) throw new ProtocolException("Invalid comment eligibility count.");
        return EncodeFrame(FrameType.CommentAuthorEligibility, writer => writer.Items(ids, static (w, id) => w.I64(id)));
    }

    public static CommentReportRequest DecodeCommentReportRequest(ReadOnlySpan<byte> frame)
    {
        if (frame.Length > CommentReportFrameBytes) throw Invalid();
        var value = ReadCommentJson(Aeds.Decode(frame, FrameType.CommentReportRequest),
            CommentWireJson.Default.CommentReportPayload);
        var reason = value?.ReasonCode?.Trim().ToLowerInvariant();
        if (value is not { ScopedCredential: null } ||
            reason is not ("spam" or "harassment" or "hate" or "privacy" or "illegal" or "misinformation" or "other"))
            throw Invalid();
        var detail = value.Detail?.Trim();
        if (detail is { Length: > CommentReportDetailChars } ||
            detail?.Any(ch => char.IsControl(ch) && ch is not ('\t' or '\r' or '\n')) is true) throw Invalid();
        return new(reason, detail is { Length: > 0 } ? detail : null);

        static ProtocolException Invalid() => new("Invalid signed-in comment report.");
    }

    public static byte[] EncodeCommentReportResult(CommentReportResult value)
    {
        if (!value.Success || value.ReportId is <= 0 or > MaxCommentReportId ||
            value.Code != (value.Duplicate ? "comment_report_duplicate" : "ok"))
            throw new ProtocolException("Invalid comment report receipt.");
        return WriteCommentJson(FrameType.CommentReportResult, value, CommentWireJson.Default.CommentReportResult);
    }

    public static byte[] EncodeAdminCommentRevisions(List<AdminCommentRevision> revisions) =>
        WriteCommentJson(FrameType.CommentRevisionList, revisions, AdminCommentRevisionJson.Default.ListAdminCommentRevision);

    public static byte[] EncodeAdminCommentTimeline(AdminCommentTimeline timeline) =>
        WriteCommentJson(FrameType.CommentModerationTimeline, timeline, AdminCommentRevisionJson.Default.AdminCommentTimeline);

    internal static void Validate(PublicCommentEligibility eligibility)
    {
        if (eligibility.ArticleId <= 0 || eligibility.Publication <= 0 || string.IsNullOrWhiteSpace(eligibility.DisplayName))
            throw new ProtocolException("Invalid public comment eligibility response");
    }

    internal static void Validate(PublicCommentSubmission submission) => ValidatePublicCommentCoordinates(submission.ArticleId,
        submission.Publication, submission.IdempotencyKey, submission.ExplicitPublic, submission.DisplayName);

    internal static void Validate(PublicCommentReply reply)
    {
        if (reply.ParentId <= 0) throw new ProtocolException("Invalid authenticated public comment reply target");
        ValidatePublicCommentCoordinates(reply.ArticleId, reply.Publication, reply.IdempotencyKey, reply.ExplicitPublic, reply.DisplayName);
    }

    private static void ValidatePublicCommentCoordinates(int article, long publication, Guid id, bool explicitPublic, string display)
    {
        if (article <= 0 || publication <= 0 || id == Guid.Empty || !explicitPublic || string.IsNullOrWhiteSpace(display))
            throw new ProtocolException("Invalid authenticated public comment coordinates");
    }

    internal static void Validate(PublicCommentSubmissionResult result)
    {
        if (result.ArticleId <= 0 || result.CommentId <= 0 || result.ModerationStatus is < 0 or > 3)
            throw new ProtocolException("Invalid public comment submission result");
    }

    internal static void Validate(RecoveryKeyOperation value)
    {
        if (value.Operation is not (1 or 2)) throw new ProtocolException("Invalid recovery key operation.");
    }

    internal static void Validate(RecoveryKeyIssued value)
    {
        if (!IsRecoveryKey(value.Key) || value.Version <= 0 || value.CreatedAt <= 0)
            throw new ProtocolException("Invalid recovery key receipt.");
    }

    internal static void Validate(RecoveryKeyStatus value) { }

    internal static void Validate(RecoveryKeyVerify value)
    {
        if (!IsRecoveryKey(value.Key)) throw new ProtocolException("Invalid recovery key.");
    }

    private static bool IsRecoveryKey(string key) =>
        key.Length == RecoveryKeyBytes && key.StartsWith("frk_", StringComparison.Ordinal) &&
        key[4..36].All(char.IsAsciiHexDigitLower) && key[36] == '_' && IsBase64Url(key[37..]);

    public static bool IsRootCommentPowLifetime(int seconds) => seconds is >= RootCommentPowMinSeconds and <= PowChallengeSeconds;

    internal static void Validate(AdminRootCommentPowPolicy value)
    {
        if (value.Generation < 1 || !IsLowerHex(value.Digest, RootCommentPowDigestBytes) || !IsRootCommentPowLifetime(value.ProofSeconds) ||
            (value.Generation == 1 ? value.ProofSeconds != PowChallengeSeconds || value.PreviousSeconds != 0
                : !IsRootCommentPowLifetime(value.PreviousSeconds) || value.PreviousSeconds == value.ProofSeconds))
            throw new ProtocolException("Invalid root comment proof policy.");
    }

    internal static void Validate(AdminRootCommentPowCommand value)
    {
        if (value.ExpectedGeneration < 1 || !IsLowerHex(value.ExpectedDigest, RootCommentPowDigestBytes) || !IsRootCommentPowLifetime(value.ProofSeconds))
            throw new ProtocolException("Invalid root comment proof policy command.");
    }

    public static byte[] EncodeSitePasskeys(IReadOnlyList<SitePasskeyRow> rows)
    {
        if (rows.Count is < 1 or > SitePasskeyListSize) throw new ProtocolException("Invalid site Passkey list.");
        return EncodeFrame(FrameType.SitePasskeys, writer =>
        {
            writer.I32(rows.Count);
            for (var index = 0; index < rows.Count; index++) WriteSitePasskeyRow(writer, rows[index], current: index == 0);
        });
    }

    public static byte[] EncodeSitePasskeyManagement(IReadOnlyList<SitePasskeyManagedRow> rows)
    {
        if (rows.Count is < 1 or > SitePasskeyListSize) throw new ProtocolException("Invalid site Passkey list.");
        return EncodeFrame(FrameType.SitePasskeyManagement, writer =>
        {
            writer.I32(rows.Count);
            var references = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < rows.Count; index++)
            {
                var row = rows[index];
                if (!ValidSitePasskeyReference(row.Reference) || !references.Add(row.Reference) || row.Revision < 0 ||
                    (row.Revision == 0 ? row.Name.Length != 0 : !ValidSitePasskeyName(row.Name) || row.Name != row.Name.Trim() || row.Name.Any(char.IsControl)))
                    throw new ProtocolException("Invalid managed site Passkey row.");
                writer.FixedBytes(Convert.FromHexString(row.Reference)).I64(row.Revision).Text(row.Name, SitePasskeyNameBytes);
                WriteSitePasskeyRow(writer, row.Metadata, current: index == 0);
            }
        });
    }

    public static byte[] EncodeSitePasskeyRename(SitePasskeyRename value) =>
        EncodeRecord(FrameType.SitePasskeyRename, value, ValidateSitePasskeyRename, static (writer, record) =>
            writer.FixedBytes(Convert.FromHexString(record.Reference)).I64(record.ExpectedRevision).Text(record.Name, SitePasskeyNameBytes));

    public static SitePasskeyRename DecodeSitePasskeyRename(ReadOnlySpan<byte> frame) =>
        DecodeRecord<SitePasskeyRename>(FrameType.SitePasskeyRename, frame, static (ref Reader reader) =>
            new(Convert.ToHexStringLower(reader.FixedBytes(SitePasskeyReferenceBytes)), reader.I64(), reader.Text(SitePasskeyNameBytes)),
            ValidateSitePasskeyRename);

    public static byte[] EncodeSitePasskeyRemove(SitePasskeyRemove value)
    {
        if (!ValidSitePasskeyReference(value.Reference) || value.ExpectedRevision < 0)
            throw new ProtocolException("Invalid site Passkey removal.");
        return EncodeFrame(FrameType.SitePasskeyRemove,
            writer => writer.FixedBytes(Convert.FromHexString(value.Reference)).I64(value.ExpectedRevision));
    }

    public static SitePasskeyRemove DecodeSitePasskeyRemove(ReadOnlySpan<byte> frame)
    {
        var value = DecodeFrame(FrameType.SitePasskeyRemove, frame, static (ref Reader reader) =>
            new SitePasskeyRemove(Convert.ToHexStringLower(reader.FixedBytes(SitePasskeyReferenceBytes)), reader.I64()));
        return value.ExpectedRevision >= 0 ? value : throw new ProtocolException("Invalid site Passkey removal.");
    }

    public static bool ValidSitePasskeyReference(string? value) =>
        value is not null && IsLowerHex(value, SitePasskeyReferenceBytes * 2);

    private static bool ValidSitePasskeyName(string value) =>
        value.Length <= SitePasskeyNameChars && !string.IsNullOrWhiteSpace(value);

    private static void ValidateSitePasskeyRename(SitePasskeyRename value)
    {
        if (!ValidSitePasskeyReference(value.Reference) || value.ExpectedRevision < 0 || !ValidSitePasskeyName(value.Name))
            throw new ProtocolException("Invalid site Passkey rename.");
    }

    private static void WriteSitePasskeyRow(Writer writer, SitePasskeyRow row, bool current)
    {
        if (row.CreatedAt <= 0 || !IsValidUnixMs(row.CreatedAt) ||
            row.LastUsedAt is { } used && (used <= 0 || !IsValidUnixMs(used)) ||
            (row.BackedUp && !row.BackupEligible) || row.Current != current)
            throw new ProtocolException("Invalid site Passkey row.");
        writer.I64(row.CreatedAt).I64(row.LastUsedAt ?? 0).Bool(row.BackupEligible).Bool(row.BackedUp).Bool(row.Current);
    }

    public static byte[] EncodeSiteSessions(SiteSessionList value)
    {
        if (value.Sessions.Count is < 1 or > SiteSessionListSize || !value.Sessions[0].Current ||
            value.Sessions.Skip(1).Any(row => row.Current)) throw new ProtocolException("Invalid site session list.");
        return EncodeFrame(FrameType.SiteSessionList, writer => writer.Bool(value.HasMore).Items(value.Sessions, static (w, row) =>
        {
            if (!ValidSiteSessionId(row.Id) || row.ExpiresAt <= 0 || row.Method is < 1 or > 2 || (row.Method == 1 && row.Mfa))
                throw new ProtocolException("Invalid site session row.");
            w.Text(row.Id, SiteSessionIdBytes).I64(row.ExpiresAt).Bool(row.Current).I32(row.Method).Bool(row.Mfa);
        }));
    }

    public static bool ValidSiteSessionId(string? value) => value is not null && IsLowerHex(value, SiteSessionIdBytes);

    internal static void Validate(SubscriptionPreferenceRequest request)
    {
        if (string.IsNullOrEmpty(request.Email) || request.Email.Length > SubscriptionEmailBytes ||
            !request.Email.All(c => c is >= '!' and <= '~') ||
            request.Channel is not (WireLayouts.SubscriptionRssChannel or WireLayouts.SubscriptionEmailChannel))
            throw new ProtocolException("Invalid subscription preference request");
    }
}
