using System.Data.Common;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Data;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed record CommentModerationQueueStoreItem(
    long CommentId,
    int AppealPriority,
    int RiskScore,
    DateTime WaitingSinceUtc,
    int ModerationStatus,
    string CommentRowVersion,
    long? ClaimOwnerAdminPrincipalId,
    string? ClaimState,
    DateTime? ClaimClaimedAtUtc,
    DateTime? ClaimLeaseExpiresAtUtc,
    DateTime? ClaimProcessSlaDueAtUtc,
    string? ClaimNote,
    string? ClaimEscalationStatus,
    int? ClaimGeneration,
    string? ClaimRowVersion);

public sealed record CommentModerationQueueStorePage(
    IReadOnlyList<CommentModerationQueueStoreItem> Items,
    string? NextCursor);

public sealed class CommentModerationQueueStore(
    ISqlSugarClient db,
    CommentModerationQueueService domain,
    TimeProvider timeProvider)
{
    internal const string ListSql = """
        WITH report_priority AS (
            SELECT
                comment_id,
                MAX(risk_score)::integer AS risk_score,
                MIN(created_at_utc) AS first_reported_at_utc
            FROM comment_report
            WHERE status IN ('open', 'reviewing')
            GROUP BY comment_id
        ),
        appeal_priority AS (
            SELECT
                comment_id,
                MIN(created_at_utc) AS first_appealed_at_utc
            FROM comment_author_appeal
            WHERE status = 'pending'
            GROUP BY comment_id
        ),
        appeal_queue AS (
            SELECT
                c.id AS comment_id,
                2::integer AS appeal_priority,
                COALESCE(report.risk_score, 0)::integer AS risk_score,
                LEAST(
                    c.create_time,
                    COALESCE(report.first_reported_at_utc, c.create_time),
                    COALESCE(appeal.first_appealed_at_utc, c.create_time)) AS waiting_since_utc,
                c.moderation_status,
                c.xmin::text AS comment_row_version,
                claim.owner_admin_principal_id,
                claim.state AS claim_state,
                claim.claimed_at_utc,
                claim.lease_expires_at_utc,
                claim.process_sla_due_at_utc,
                claim.note AS claim_note,
                claim.escalation_status,
                claim.claim_generation,
                claim.xmin::text AS claim_row_version
            FROM comment c
            INNER JOIN appeal_priority appeal ON appeal.comment_id = c.id
            LEFT JOIN report_priority report ON report.comment_id = c.id
            LEFT JOIN comment_moderation_queue_claim claim ON claim.comment_id = c.id
            WHERE c.is_deleted = false
              AND ((@HasCursor = false)
                   OR 2 < @AppealPriority
                   OR (2 = @AppealPriority AND COALESCE(report.risk_score, 0) < @RiskScore)
                   OR (2 = @AppealPriority AND COALESCE(report.risk_score, 0) = @RiskScore
                       AND LEAST(c.create_time, COALESCE(report.first_reported_at_utc, c.create_time), appeal.first_appealed_at_utc) > @WaitingSinceUtc)
                   OR (2 = @AppealPriority AND COALESCE(report.risk_score, 0) = @RiskScore
                       AND LEAST(c.create_time, COALESCE(report.first_reported_at_utc, c.create_time), appeal.first_appealed_at_utc) = @WaitingSinceUtc
                       AND c.id > @CommentId))
            ORDER BY risk_score DESC, waiting_since_utc, comment_id
            LIMIT @Limit
        ),
        report_queue AS (
            SELECT
                c.id AS comment_id,
                1::integer AS appeal_priority,
                report.risk_score,
                LEAST(c.create_time, report.first_reported_at_utc) AS waiting_since_utc,
                c.moderation_status,
                c.xmin::text AS comment_row_version,
                claim.owner_admin_principal_id,
                claim.state AS claim_state,
                claim.claimed_at_utc,
                claim.lease_expires_at_utc,
                claim.process_sla_due_at_utc,
                claim.note AS claim_note,
                claim.escalation_status,
                claim.claim_generation,
                claim.xmin::text AS claim_row_version
            FROM report_priority report
            INNER JOIN comment c ON c.id = report.comment_id
            LEFT JOIN appeal_priority appeal ON appeal.comment_id = c.id
            LEFT JOIN comment_moderation_queue_claim claim ON claim.comment_id = c.id
            WHERE c.is_deleted = false
              AND appeal.comment_id IS NULL
              AND ((@HasCursor = false)
                   OR 1 < @AppealPriority
                   OR (1 = @AppealPriority AND report.risk_score < @RiskScore)
                   OR (1 = @AppealPriority AND report.risk_score = @RiskScore
                       AND LEAST(c.create_time, report.first_reported_at_utc) > @WaitingSinceUtc)
                   OR (1 = @AppealPriority AND report.risk_score = @RiskScore
                       AND LEAST(c.create_time, report.first_reported_at_utc) = @WaitingSinceUtc
                       AND c.id > @CommentId))
            ORDER BY risk_score DESC, waiting_since_utc, comment_id
            LIMIT @Limit
        ),
        ordinary_queue AS (
            SELECT
                c.id AS comment_id,
                0::integer AS appeal_priority,
                0::integer AS risk_score,
                c.create_time AS waiting_since_utc,
                c.moderation_status,
                c.xmin::text AS comment_row_version,
                claim.owner_admin_principal_id,
                claim.state AS claim_state,
                claim.claimed_at_utc,
                claim.lease_expires_at_utc,
                claim.process_sla_due_at_utc,
                claim.note AS claim_note,
                claim.escalation_status,
                claim.claim_generation,
                claim.xmin::text AS claim_row_version
            FROM comment c
            LEFT JOIN comment_moderation_queue_claim claim ON claim.comment_id = c.id
            WHERE c.is_deleted = false
              AND (c.moderation_status = @PendingStatus OR c.moderation_reason = @BorderlineReviewReason)
              AND NOT EXISTS (SELECT 1 FROM report_priority report WHERE report.comment_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM appeal_priority appeal WHERE appeal.comment_id = c.id)
              AND ((@HasCursor = false)
                   OR 0 < @AppealPriority
                   OR (0 = @AppealPriority AND 0 < @RiskScore)
                   OR (0 = @AppealPriority AND 0 = @RiskScore AND c.create_time > @WaitingSinceUtc)
                   OR (0 = @AppealPriority AND 0 = @RiskScore AND c.create_time = @WaitingSinceUtc AND c.id > @CommentId))
            ORDER BY waiting_since_utc, comment_id
            LIMIT @Limit
        )
        SELECT *
        FROM (
            SELECT * FROM appeal_queue
            UNION ALL
            SELECT * FROM report_queue
            UNION ALL
            SELECT * FROM ordinary_queue
        ) queue
        ORDER BY appeal_priority DESC, risk_score DESC, waiting_since_utc, comment_id
        LIMIT @Limit;
        """;

    internal const string ClaimSql = """
        WITH eligible_comment AS (
            SELECT c.id
            FROM comment c
            WHERE c.id = @CommentId
              AND c.is_deleted = false
        )
        INSERT INTO comment_moderation_queue_claim (
            comment_id, owner_admin_principal_id, claim_token_hash, state,
            claimed_at_utc, lease_expires_at_utc, renewed_at_utc, released_at_utc,
            process_sla_due_at_utc, note, escalation_status, claim_generation)
        SELECT
            @CommentId, @OwnerAdminPrincipalId, @ClaimTokenHash, 'active',
            @NowUtc, @LeaseExpiresAtUtc, NULL, NULL,
            @ProcessSlaDueAtUtc, @Note, @EscalationStatus, 1
        FROM eligible_comment
        ON CONFLICT (comment_id) DO UPDATE SET
            owner_admin_principal_id = EXCLUDED.owner_admin_principal_id,
            claim_token_hash = EXCLUDED.claim_token_hash,
            state = 'active',
            claimed_at_utc = EXCLUDED.claimed_at_utc,
            lease_expires_at_utc = EXCLUDED.lease_expires_at_utc,
            renewed_at_utc = NULL,
            released_at_utc = NULL,
            process_sla_due_at_utc = EXCLUDED.process_sla_due_at_utc,
            note = EXCLUDED.note,
            escalation_status = EXCLUDED.escalation_status,
            claim_generation = comment_moderation_queue_claim.claim_generation + 1
        WHERE comment_moderation_queue_claim.state IN ('released', 'expired')
           OR (comment_moderation_queue_claim.state = 'active'
               AND comment_moderation_queue_claim.lease_expires_at_utc <= @NowUtc)
        RETURNING *, xmin::text AS row_version;
        """;

    internal const string RenewSql = """
        UPDATE comment_moderation_queue_claim
        SET renewed_at_utc = @NowUtc,
            lease_expires_at_utc = @LeaseExpiresAtUtc
        WHERE comment_id = @CommentId
          AND owner_admin_principal_id = @OwnerAdminPrincipalId
          AND claim_token_hash = @ClaimTokenHash
          AND state = 'active'
          AND lease_expires_at_utc > @NowUtc
          AND claim_generation = @ClaimGeneration
          AND xmin::text = @RowVersion
        RETURNING *, xmin::text AS row_version;
        """;

    internal const string FinishSql = """
        UPDATE comment_moderation_queue_claim
        SET state = @NextState,
            released_at_utc = @NowUtc,
            lease_expires_at_utc = @NowUtc
        WHERE comment_id = @CommentId
          AND owner_admin_principal_id = @OwnerAdminPrincipalId
          AND claim_token_hash = @ClaimTokenHash
          AND state = 'active'
          AND lease_expires_at_utc > @NowUtc
          AND claim_generation = @ClaimGeneration
          AND xmin::text = @RowVersion
        RETURNING *, xmin::text AS row_version;
        """;

    internal const string RecoverExpiredSql = """
        UPDATE comment_moderation_queue_claim
        SET state = 'expired',
            released_at_utc = @NowUtc
        WHERE state = 'active'
          AND lease_expires_at_utc <= @NowUtc;
        """;

    public async Task<CommentModerationQueueStorePage> ListAsync(
        string? encodedCursor,
        int limit,
        CancellationToken cancellationToken = default,
        string borderlineReviewReason = "model_policy:model_risk_borderline_review")
    {
        CommentModerationQueueCursor? cursor = null;
        if (encodedCursor is not null
            && !CommentModerationQueueService.TryDecodeCursor(encodedCursor, out cursor))
        {
            throw new ArgumentException("Invalid moderation queue cursor.", nameof(encodedCursor));
        }

        int boundedLimit = Math.Clamp(limit, 1, 100);
        await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            ListSql,
            new SugarParameter("@PendingStatus", 0),
            new SugarParameter("@HasCursor", cursor is not null),
            new SugarParameter("@AppealPriority", cursor?.AppealPriority ?? 0),
            new SugarParameter("@RiskScore", cursor?.RiskScore ?? 0),
            new SugarParameter("@WaitingSinceUtc", cursor is null ? DateTime.UnixEpoch : new DateTime(cursor.CreatedAtUtcTicks, DateTimeKind.Utc)),
            new SugarParameter("@CommentId", cursor?.CommentId ?? 0),
            new SugarParameter("@BorderlineReviewReason", borderlineReviewReason),
            new SugarParameter("@Limit", boundedLimit + 1));

        var items = new List<CommentModerationQueueStoreItem>(boundedLimit + 1);
        while (await reader.ReadAsync(cancellationToken))
        {
            items.Add(ReadQueueItem(reader));
        }

        bool hasMore = items.Count > boundedLimit;
        if (hasMore)
        {
            items.RemoveAt(items.Count - 1);
        }

        string? nextCursor = hasMore
            ? CommentModerationQueueService.EncodeCursor(new CommentModerationQueueCandidate(
                items[^1].CommentId,
                items[^1].AppealPriority,
                items[^1].RiskScore,
                items[^1].WaitingSinceUtc))
            : null;
        return new(items, nextCursor);
    }

    public async Task<CommentModerationClaimCommandResult> ClaimAsync(
        long commentId,
        long ownerAdminPrincipalId,
        TimeSpan lease,
        TimeSpan processSla,
        string? note = null,
        string escalationStatus = CommentModerationEscalationStatuses.None,
        CancellationToken cancellationToken = default)
    {
        CommentModerationClaimCommandResult proposed = domain.Claim(
            null,
            commentId,
            ownerAdminPrincipalId,
            lease,
            processSla,
            note,
            escalationStatus);
        if (!proposed.Success)
        {
            return proposed;
        }

        CommentModerationQueueClaim values = proposed.Claim!;
        CommentModerationQueueClaim? claimed = await ReadSingleClaimAsync(
            ClaimSql,
            cancellationToken,
            new SugarParameter("@CommentId", commentId),
            new SugarParameter("@OwnerAdminPrincipalId", ownerAdminPrincipalId),
            new SugarParameter("@ClaimTokenHash", values.ClaimTokenHash),
            new SugarParameter("@NowUtc", values.ClaimedAtUtc),
            new SugarParameter("@LeaseExpiresAtUtc", values.LeaseExpiresAtUtc),
            new SugarParameter("@ProcessSlaDueAtUtc", values.ProcessSlaDueAtUtc),
            new SugarParameter("@Note", values.Note),
            new SugarParameter("@EscalationStatus", values.EscalationStatus));

        if (claimed is null)
        {
            return new(false, "comment_moderation_claim_conflict");
        }

        string? commentRowVersion = await ReadCommentRowVersionAsync(commentId, cancellationToken);
        return commentRowVersion is null
            ? new(false, "comment_moderation_claim_conflict")
            : new(true, "ok", claimed, proposed.ClaimToken, commentRowVersion);
    }

    public Task<CommentModerationClaimCommandResult> RenewAsync(
        long commentId,
        long ownerAdminPrincipalId,
        string claimToken,
        int expectedClaimGeneration,
        string expectedRowVersion,
        TimeSpan lease,
        CancellationToken cancellationToken = default)
    {
        if (lease < CommentModerationQueueService.MinimumLease
            || lease > CommentModerationQueueService.MaximumLease)
        {
            return Task.FromResult(new CommentModerationClaimCommandResult(false, "comment_moderation_claim_invalid"));
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        return ExecuteCasAsync(
            RenewSql,
            commentId,
            ownerAdminPrincipalId,
            claimToken,
            expectedClaimGeneration,
            expectedRowVersion,
            now,
            cancellationToken,
            new SugarParameter("@LeaseExpiresAtUtc", now.Add(lease)));
    }

    public Task<CommentModerationClaimCommandResult> ReleaseAsync(
        long commentId,
        long ownerAdminPrincipalId,
        string claimToken,
        int expectedClaimGeneration,
        string expectedRowVersion,
        CancellationToken cancellationToken = default)
        => FinishAsync(
            CommentModerationClaimStates.Released,
            commentId,
            ownerAdminPrincipalId,
            claimToken,
            expectedClaimGeneration,
            expectedRowVersion,
            cancellationToken);

    public Task<CommentModerationClaimCommandResult> CompleteAsync(
        long commentId,
        long ownerAdminPrincipalId,
        string claimToken,
        int expectedClaimGeneration,
        string expectedRowVersion,
        CancellationToken cancellationToken = default)
        => FinishAsync(
            CommentModerationClaimStates.Completed,
            commentId,
            ownerAdminPrincipalId,
            claimToken,
            expectedClaimGeneration,
            expectedRowVersion,
            cancellationToken);

    public Task<int> RecoverExpiredAsync(CancellationToken cancellationToken = default)
        => db.Ado.ExecuteCommandAsync(
            RecoverExpiredSql,
            new SugarParameter("@NowUtc", timeProvider.GetUtcNow().UtcDateTime));

    private Task<CommentModerationClaimCommandResult> FinishAsync(
        string nextState,
        long commentId,
        long ownerAdminPrincipalId,
        string claimToken,
        int expectedClaimGeneration,
        string expectedRowVersion,
        CancellationToken cancellationToken)
        => ExecuteCasAsync(
            FinishSql,
            commentId,
            ownerAdminPrincipalId,
            claimToken,
            expectedClaimGeneration,
            expectedRowVersion,
            timeProvider.GetUtcNow().UtcDateTime,
            cancellationToken,
            new SugarParameter("@NextState", nextState));

    private async Task<CommentModerationClaimCommandResult> ExecuteCasAsync(
        string sql,
        long commentId,
        long ownerAdminPrincipalId,
        string claimToken,
        int expectedClaimGeneration,
        string expectedRowVersion,
        DateTime now,
        CancellationToken cancellationToken,
        params SugarParameter[] additionalParameters)
    {
        if (commentId <= 0
            || ownerAdminPrincipalId <= 0
            || expectedClaimGeneration <= 0
            || string.IsNullOrWhiteSpace(expectedRowVersion)
            || !IsValidToken(claimToken))
        {
            return new(false, "comment_moderation_claim_invalid");
        }

        SugarParameter[] parameters =
        [
            new("@CommentId", commentId),
            new("@OwnerAdminPrincipalId", ownerAdminPrincipalId),
            new("@ClaimTokenHash", HashToken(claimToken)),
            new("@ClaimGeneration", expectedClaimGeneration),
            new("@RowVersion", expectedRowVersion),
            new("@NowUtc", now),
            .. additionalParameters
        ];
        CommentModerationQueueClaim? claim = await ReadSingleClaimAsync(sql, cancellationToken, parameters);
        return claim is null
            ? new(false, "comment_moderation_claim_conflict")
            : new(true, "ok", claim);
    }

    private async Task<CommentModerationQueueClaim?> ReadSingleClaimAsync(
        string sql,
        CancellationToken cancellationToken,
        params SugarParameter[] parameters)
    {
        await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters);
        return await reader.ReadAsync(cancellationToken) ? ReadClaim(reader) : null;
    }

    private async Task<string?> ReadCommentRowVersionAsync(long commentId, CancellationToken cancellationToken)
    {
        await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT xmin::text AS row_version FROM comment WHERE id = @CommentId AND is_deleted = false;",
            new SugarParameter("@CommentId", commentId));
        return await reader.ReadAsync(cancellationToken) ? reader.ReadString("row_version") : null;
    }

    private static CommentModerationQueueStoreItem ReadQueueItem(DbDataReader reader)
        => new(
            reader.ReadInt64("comment_id"),
            reader.ReadInt32("appeal_priority"),
            reader.ReadInt32("risk_score"),
            AsUtc(reader.ReadDateTime("waiting_since_utc")),
            reader.ReadInt32("moderation_status"),
            reader.ReadString("comment_row_version"),
            reader.IsNull("owner_admin_principal_id") ? null : reader.ReadInt64("owner_admin_principal_id"),
            reader.IsNull("claim_state") ? null : reader.ReadString("claim_state"),
            reader.IsNull("claimed_at_utc") ? null : AsUtc(reader.ReadDateTime("claimed_at_utc")),
            reader.IsNull("lease_expires_at_utc") ? null : AsUtc(reader.ReadDateTime("lease_expires_at_utc")),
            reader.IsNull("process_sla_due_at_utc") ? null : AsUtc(reader.ReadDateTime("process_sla_due_at_utc")),
            reader.IsNull("claim_note") ? null : reader.ReadString("claim_note"),
            reader.IsNull("escalation_status") ? null : reader.ReadString("escalation_status"),
            reader.IsNull("claim_generation") ? null : reader.ReadInt32("claim_generation"),
            reader.IsNull("claim_row_version") ? null : reader.ReadString("claim_row_version"));

    private static CommentModerationQueueClaim ReadClaim(DbDataReader reader)
        => new()
        {
            CommentId = reader.ReadInt64("comment_id"),
            OwnerAdminPrincipalId = reader.ReadInt64("owner_admin_principal_id"),
            ClaimTokenHash = reader.ReadString("claim_token_hash"),
            State = reader.ReadString("state"),
            ClaimedAtUtc = AsUtc(reader.ReadDateTime("claimed_at_utc")),
            LeaseExpiresAtUtc = AsUtc(reader.ReadDateTime("lease_expires_at_utc")),
            RenewedAtUtc = reader.IsNull("renewed_at_utc") ? null : AsUtc(reader.ReadDateTime("renewed_at_utc")),
            ReleasedAtUtc = reader.IsNull("released_at_utc") ? null : AsUtc(reader.ReadDateTime("released_at_utc")),
            ProcessSlaDueAtUtc = AsUtc(reader.ReadDateTime("process_sla_due_at_utc")),
            Note = reader.IsNull("note") ? null : reader.ReadString("note"),
            EscalationStatus = reader.ReadString("escalation_status"),
            ClaimGeneration = reader.ReadInt32("claim_generation"),
            RowVersion = reader.ReadString("row_version")
        };

    private static bool IsValidToken(string? value)
        => value is { Length: >= 32 and <= 128 }
            && value.All(static character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');

    private static string HashToken(string token)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static DateTime AsUtc(DateTime value)
        => value.Kind == DateTimeKind.Utc ? value : DateTime.SpecifyKind(value, DateTimeKind.Utc);
}
