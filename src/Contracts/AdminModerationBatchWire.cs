namespace FsusBlog.V2.Contracts;

public sealed record AdminModerationBatchItem(int ArticleId, long CommentId, long CommentVersion, string ClaimToken,
    long ClaimGeneration, long ClaimVersion, int ExpectedStatus);

public sealed record AdminModerationBatchDecision(int Decision, string Reason, IReadOnlyList<AdminModerationBatchItem> Rows);

public sealed record AdminModerationBatchReceipt(long BatchId, int Count);

public static partial class Wire
{
    public static byte[] EncodeAdminModerationBatchTargets(IReadOnlyList<AdminModerationClaimRequest> targets)
    {
        var writer = new Writer();
        writer.I32(BatchCount(targets.Count));
        var seen = new HashSet<(int, long)>();
        foreach (var target in targets)
        {
            BatchTarget(seen, target.ArticleId, target.CommentId);
            writer.I32(target.ArticleId);
            writer.I64(target.CommentId);
        }
        return Aeds.Encode(FrameType.AdminModerationBatchTargets, writer.Written);
    }

    public static IReadOnlyList<AdminModerationClaimRequest> DecodeAdminModerationBatchTargets(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AdminModerationBatchTargets));
        var targets = new AdminModerationClaimRequest[BatchCount(reader.I32())];
        var seen = new HashSet<(int, long)>();
        for (var i = 0; i < targets.Length; i++)
        {
            var target = new AdminModerationClaimRequest(reader.I32(), reader.I64());
            BatchTarget(seen, target.ArticleId, target.CommentId);
            targets[i] = target;
        }
        reader.Finish();
        return targets;
    }

    public static byte[] EncodeAdminModerationBatchClaims(IReadOnlyList<AdminModerationClaim> claims)
    {
        var writer = new Writer();
        writer.I32(BatchCount(claims.Count));
        var seen = new HashSet<(int, long)>();
        foreach (var claim in claims)
        {
            BatchTarget(seen, claim.ArticleId, claim.CommentId);
            Validate(claim);
            WriteBatchClaim(writer, claim.ArticleId, claim.CommentId, claim.CommentVersion, claim.ClaimToken,
                claim.ClaimGeneration, claim.ClaimVersion);
            writer.I64(claim.ExpiresAt);
        }
        return Aeds.Encode(FrameType.AdminModerationBatchClaims, writer.Written);
    }

    public static IReadOnlyList<AdminModerationClaim> DecodeAdminModerationBatchClaims(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AdminModerationBatchClaims));
        var claims = new AdminModerationClaim[BatchCount(reader.I32())];
        var seen = new HashSet<(int, long)>();
        for (var i = 0; i < claims.Length; i++)
        {
            var claim = new AdminModerationClaim(reader.I32(), reader.I64(), reader.I64(),
                reader.Text(WireLimits.AdminModerationClaimTokenBytes), reader.I64(), reader.I64(), reader.I64());
            BatchTarget(seen, claim.ArticleId, claim.CommentId);
            Validate(claim);
            claims[i] = claim;
        }
        reader.Finish();
        return claims;
    }

    public static byte[] EncodeAdminModerationBatchDecision(AdminModerationBatchDecision value)
    {
        ValidateBatchDecision(value.Decision, value.Reason);
        var writer = new Writer();
        writer.I32(value.Decision);
        writer.Text(value.Reason, WireLimits.AdminModerationReasonBytes);
        writer.I32(BatchCount(value.Rows.Count));
        var seen = new HashSet<(int, long)>();
        foreach (var row in value.Rows)
        {
            BatchDecisionTarget(seen, row);
            WriteBatchClaim(writer, row.ArticleId, row.CommentId, row.CommentVersion, row.ClaimToken,
                row.ClaimGeneration, row.ClaimVersion);
            writer.I32(row.ExpectedStatus);
        }
        return Aeds.Encode(FrameType.AdminModerationBatchDecision, writer.Written);
    }

    public static AdminModerationBatchDecision DecodeAdminModerationBatchDecision(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AdminModerationBatchDecision));
        var decision = reader.I32();
        var reason = reader.Text(WireLimits.AdminModerationReasonBytes);
        ValidateBatchDecision(decision, reason);
        var rows = new AdminModerationBatchItem[BatchCount(reader.I32())];
        var seen = new HashSet<(int, long)>();
        for (var i = 0; i < rows.Length; i++)
        {
            var row = new AdminModerationBatchItem(reader.I32(), reader.I64(), reader.I64(),
                reader.Text(WireLimits.AdminModerationClaimTokenBytes), reader.I64(), reader.I64(), reader.I32());
            BatchDecisionTarget(seen, row);
            rows[i] = row;
        }
        reader.Finish();
        return new(decision, reason, rows);
    }

    public static byte[] EncodeAdminModerationBatchReceipt(AdminModerationBatchReceipt value)
    {
        var writer = new Writer();
        writer.I64(BatchId(value.BatchId));
        writer.I32(BatchCount(value.Count));
        return Aeds.Encode(FrameType.AdminModerationBatchReceipt, writer.Written);
    }

    public static AdminModerationBatchReceipt DecodeAdminModerationBatchReceipt(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.AdminModerationBatchReceipt));
        var result = new AdminModerationBatchReceipt(BatchId(reader.I64()), BatchCount(reader.I32()));
        reader.Finish();
        return result;
    }

    private static void WriteBatchClaim(Writer writer, int article, long comment, long commentVersion, string token,
        long generation, long version)
    {
        writer.I32(article);
        writer.I64(comment);
        writer.I64(commentVersion);
        writer.Text(token, WireLimits.AdminModerationClaimTokenBytes);
        writer.I64(generation);
        writer.I64(version);
    }

    private static void BatchDecisionTarget(HashSet<(int, long)> seen, AdminModerationBatchItem row)
    {
        BatchTarget(seen, row.ArticleId, row.CommentId);
        if (row.ExpectedStatus != 0) throw new ProtocolException("Invalid pending comment status for moderation batch.");
        ValidateClaim(row.CommentVersion, row.ClaimGeneration, row.ClaimVersion, row.ClaimToken);
    }

    private static void BatchTarget(HashSet<(int, long)> seen, int article, long comment)
    {
        if (article <= 0 || comment <= 0 || !seen.Add((article, comment)))
            throw new ProtocolException("Invalid or duplicate moderation batch target.");
    }

    private static void ValidateBatchDecision(int decision, string reason)
    {
        if (decision is not (1 or 2) || reason.Length == 0 || reason != reason.Trim() || reason.Any(char.IsControl))
            throw new ProtocolException("Invalid comment moderation batch decision.");
    }

    private static int BatchCount(int count) => count is >= WireLimits.AdminModerationBatchMinimum and <= WireLimits.AdminModerationBatchCount
        ? count : throw new ProtocolException("Invalid comment moderation batch size.");

    private static long BatchId(long id) => id > 0 ? id : throw new ProtocolException("Invalid comment moderation batch receipt.");
}
