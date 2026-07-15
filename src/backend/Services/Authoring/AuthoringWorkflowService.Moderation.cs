using System.Net;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using System.Globalization;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class AuthoringWorkflowService
{
    public async Task<CommentModerationQueueResponse> ListCommentModerationQueueAsync(
        CommentModerationStatus? status = null,
        int limit = 50,
        CancellationToken cancellationToken = default)
    {
        int normalizedLimit = Math.Clamp(limit, 1, 100);
        var query = db.Queryable<Comment, Article, CommentRegionCompliance>((c, a, rc) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.Id == rc.CommentId
            });

        if (BuildCommentModerationQueuePredicate(status))
        {
            query = query.Where((c, a, rc) => !c.IsDeleted
                && (c.ModerationStatus == CommentModerationStatus.Pending
                    || (c.ModerationStatus == CommentModerationStatus.Hidden
                        && c.ModerationReason == ModelRiskBorderlineReviewReason)));
        }
        else
        {
            CommentModerationStatus resolvedStatus = status!.Value;
            query = query.Where((c, a, rc) => c.ModerationStatus == resolvedStatus && !c.IsDeleted);
        }

        List<CommentModerationQueueRow> rows = await query
            .OrderByDescending((c, a, rc) => c.CreateTime)
            .Take(normalizedLimit)
            .Select((c, a, rc) => new CommentModerationQueueRow
            {
                Id = c.Id,
                ArticleId = c.ArticleId,
                ArticleTitle = a.Title,
                UserId = c.UserId,
                AuthorMode = c.AuthorMode,
                PublicHandle = c.PublicHandle,
                AnonymousDisplayName = c.AnonymousDisplayName,
                AnonymousDisplayLanguage = c.AnonymousDisplayLanguage,
                ModerationSubjectHash = c.ModerationSubjectHash,
                AnonymousNullifierHash = c.AnonymousNullifierHash,
                AnonymousScope = c.AnonymousScope,
                CredentialLevel = c.CredentialLevel,
                ReputationBucket = c.ReputationBucket,
                AccountAgeBucket = c.AccountAgeBucket,
                Content = c.Content,
                CreateTime = c.CreateTime,
                Status = c.ModerationStatus,
                Reason = c.ModerationReason,
                ModeratedByAdminPrincipalId = c.ModeratedByAdminPrincipalId,
                ModeratedAt = c.ModeratedAt,
                RegionComplianceId = rc.Id,
                SubmitRegion = rc.SubmitRegion,
                SubmitRegionConfidence = rc.SubmitRegionConfidence,
                BlockedRegions = rc.BlockedRegions,
                RegionPolicyVersion = rc.PolicyVersion,
                RegionDecisionReason = rc.DecisionReason,
                RegionRiskLabels = rc.RiskLabels,
                RegionCanPublish = rc.CanPublish,
                RegionRequiresManualReview = rc.RequiresManualReview,
                RegionHideUntilReviewed = rc.HideUntilReviewed
            })
            .ToListAsync(cancellationToken);
        await LoadAnonymousNullifierSummariesAsync(rows, cancellationToken);
        IReadOnlyDictionary<long, CommentModerationModelSignalResponse> latestSignals = await LoadLatestModelSignalsAsync(rows, cancellationToken);
        foreach (CommentModerationQueueRow row in rows)
        {
            if (latestSignals.TryGetValue(row.Id, out CommentModerationModelSignalResponse? signal))
            {
                row.ModelSignals = [signal];
            }
        }

        CommentModerationQueueCounts counts = await LoadCommentModerationQueueCountsAsync(cancellationToken).ConfigureAwait(false);

        return new CommentModerationQueueResponse(
            rows.Select(ToCommentModerationItem).ToArray(),
            counts.Pending,
            counts.Rejected,
            counts.Hidden);
    }

    private static bool BuildCommentModerationQueuePredicate(CommentModerationStatus? status)
        => !status.HasValue || status.Value == CommentModerationStatus.Pending;

    private async Task<CommentModerationQueueCounts> LoadCommentModerationQueueCountsAsync(CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync("""
            SELECT
                SUM(CASE WHEN moderation_status = @PendingStatus OR moderation_reason = @BorderlineReviewReason THEN 1 ELSE 0 END)::integer AS pending,
                SUM(CASE WHEN moderation_status = @RejectedStatus THEN 1 ELSE 0 END)::integer AS rejected,
                SUM(CASE WHEN moderation_status = @HiddenStatus THEN 1 ELSE 0 END)::integer AS hidden
            FROM comment
            WHERE is_deleted = false;
            """,
            new SugarParameter("@PendingStatus", (int)CommentModerationStatus.Pending),
            new SugarParameter("@RejectedStatus", (int)CommentModerationStatus.Rejected),
            new SugarParameter("@HiddenStatus", (int)CommentModerationStatus.Hidden),
            new SugarParameter("@BorderlineReviewReason", ModelRiskBorderlineReviewReason));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return new CommentModerationQueueCounts(0, 0, 0);
        }

        return new CommentModerationQueueCounts(
            reader.IsNull("pending") ? 0 : reader.ReadInt32("pending"),
            reader.IsNull("rejected") ? 0 : reader.ReadInt32("rejected"),
            reader.IsNull("hidden") ? 0 : reader.ReadInt32("hidden"));
    }

    public async Task<bool> ModerateCommentAsync(long actorAdminPrincipalId, long commentId, CommentModerationRequest request, CancellationToken cancellationToken = default)
    {
        if (commentId <= 0 || !IsValidModerationStatus(request.Status))
        {
            return false;
        }

        CommentModerationStateRow? current = await LoadCommentModerationStateAsync(commentId, cancellationToken);
        if (current is null || !IsAllowedModerationTransition(current.Status, request.Status))
        {
            return false;
        }

        if (request.Status == CommentModerationStatus.Approved && !IsRegionApprovalAllowed(current))
        {
            return false;
        }

        DateTime moderatedAt = DateTime.UtcNow;
        string? normalizedReason = TextHelpers.NormalizeNullable(request.Reason, 256);
        int count = await db.Updateable<Comment>()
            .SetColumns(it => it.ModerationStatus == request.Status)
            .SetColumns(it => it.ModerationReason == normalizedReason)
            .SetColumns(it => it.ModeratedByAdminPrincipalId == actorAdminPrincipalId)
            .SetColumns(it => it.ModeratedAt == moderatedAt)
            .Where(it => it.Id == commentId && !it.IsDeleted && it.ModerationStatus == current.Status)
            .ExecuteCommandAsync(cancellationToken);
        if (count > 0)
        {
            int banned = request.BanUser && ShouldLinkBan(request.Status)
                ? await BanModerationUsersAsync([commentId], request.Reason, cancellationToken)
                : 0;
            await InvalidateModeratedCommentAsync(current, request.Status, cancellationToken);
            await PublishModerationRealtimeAsync(current, request.Status, moderatedAt);
            WriteAudit(
                AuditSourceCatalog.Comment,
                "comment-moderation",
                actorAdminPrincipalId,
                $"comment:{commentId.ToString(System.Globalization.CultureInfo.InvariantCulture)};from={(int)current.Status};to={(int)request.Status};ban={banned}");
        }

        return count > 0;
    }

    public async Task<CommentModerationBulkResponse> ModerateCommentsAsync(
        long actorAdminPrincipalId,
        CommentModerationBulkRequest request,
        CancellationToken cancellationToken = default)
    {
        if (!IsValidModerationStatus(request.Status))
        {
            return new CommentModerationBulkResponse(0, 0);
        }

        long[] ids = [.. (request.CommentIds ?? [])
            .Select(static id => long.TryParse(id, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out long parsed) ? parsed : 0)
            .Where(static id => id > 0)
            .Distinct()
            .Take(100)];
        if (ids.Length == 0)
        {
            return new CommentModerationBulkResponse(0, 0);
        }

        List<CommentModerationStateRow> rows = await LoadCommentModerationStatesAsync(ids, cancellationToken);
        var eligibleRows = new List<CommentModerationStateRow>(rows.Count);
        DateTime moderatedAt = DateTime.UtcNow;
        string? normalizedReason = TextHelpers.NormalizeNullable(request.Reason, 256);
        foreach (CommentModerationStateRow row in rows)
        {
            if (!IsAllowedModerationTransition(row.Status, request.Status))
            {
                continue;
            }

            if (request.Status == CommentModerationStatus.Approved && !IsRegionApprovalAllowed(row))
            {
                continue;
            }

            eligibleRows.Add(row);
        }

        if (eligibleRows.Count == 0)
        {
            return new CommentModerationBulkResponse(0, 0);
        }

        var updatedRows = new List<CommentModerationStateRow>(eligibleRows.Count);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            foreach (CommentModerationStateRow row in eligibleRows)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int affected = await db.Updateable<Comment>()
                    .SetColumns(it => it.ModerationStatus == request.Status)
                    .SetColumns(it => it.ModerationReason == normalizedReason)
                    .SetColumns(it => it.ModeratedByAdminPrincipalId == actorAdminPrincipalId)
                    .SetColumns(it => it.ModeratedAt == moderatedAt)
                    .Where(it => it.Id == row.Id && !it.IsDeleted && it.ModerationStatus == row.Status)
                    .ExecuteCommandAsync(cancellationToken);
                if (affected <= 0)
                {
                    throw new InvalidOperationException("Comment moderation bulk update conflicted.");
                }

                updatedRows.Add(row);
            }
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Comment moderation bulk update failed.", transaction.ErrorException);
        }

        foreach (CommentModerationStateRow row in updatedRows)
        {
            await InvalidateModeratedCommentAsync(row, request.Status, cancellationToken);
            await PublishModerationRealtimeAsync(row, request.Status, moderatedAt);
        }

        int updated = updatedRows.Count;
        long[] updatedIds = [.. updatedRows.Select(static row => row.Id)];
        int banned = updated > 0 && request.BanUsers && ShouldLinkBan(request.Status)
            ? await BanModerationUsersAsync(updatedIds, request.Reason, cancellationToken)
            : 0;

        if (updated > 0)
        {
            string transitions = string.Join(',', updatedRows
                .GroupBy(static row => row.Status)
                .OrderBy(static group => group.Key)
                .Select(group => $"{(int)group.Key}->{(int)request.Status}:{group.Count()}"));
            WriteAudit(
                AuditSourceCatalog.Comment,
                "comment-moderation-bulk",
                actorAdminPrincipalId,
                $"comments:{ids.Length};updated={updated};transitions={transitions};ban={banned}");
        }

        return new CommentModerationBulkResponse(updated, banned);
    }


    private CommentModerationItemResponse ToCommentModerationItem(CommentModerationQueueRow row)
    {
        CommentModerationModelSignalResponse? latestSignal = row.ModelSignals.FirstOrDefault();
        bool isAnonymousActor = IsAnonymousActor(row);
        string authorDisplayName = ResolveModerationAuthorDisplayName(row);
        string? nullifierHash = isAnonymousActor ? TextHelpers.NormalizeNullable(row.AnonymousNullifierHash, 128) : null;
        return new CommentModerationItemResponse(
            row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
            row.ArticleId,
            string.IsNullOrWhiteSpace(row.ArticleTitle) ? "未命名文章" : row.ArticleTitle,
            authorDisplayName,
            row.Content,
            row.CreateTime,
            row.Status,
            row.Reason,
            row.ModeratedByAdminPrincipalId,
            row.ModeratedAt,
            IsModelAutoModerated(row),
            ResolveModerationActor(row),
            [.. DetectCommentHitReasons(row.Content, row.Reason)
                .Concat(ParseCommaList(row.RegionRiskLabels).Select(static label => $"region:{label}"))
                .Concat(row.ModelSignals.SelectMany(static signal => signal.RiskCategories.Select(static category => $"model:{category}")))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(static label => label, StringComparer.OrdinalIgnoreCase)],
            row.SubmitRegion,
            row.RegionComplianceId <= 0 ? null : row.SubmitRegionConfidence,
            RegionLegalModerationService.DeserializeRegions(row.BlockedRegions),
            row.RegionPolicyVersion,
            row.RegionDecisionReason,
            row.RegionComplianceId <= 0 || row.RegionCanPublish,
            row.RegionRequiresManualReview,
            row.RegionHideUntilReviewed,
            row.ModelSignals,
            latestSignal?.Label,
            latestSignal?.Confidence,
            latestSignal?.PrimaryReason,
            latestSignal?.Provider,
            latestSignal is not null && !string.Equals(latestSignal.Status, "ok", StringComparison.Ordinal),
            row.AuthorMode,
            row.AnonymousDisplayLanguage,
            row.ModerationSubjectHash,
            nullifierHash,
            isAnonymousActor ? BuildNullifierStatusLabel(row) : null,
            row.AnonymousScope,
            row.CredentialLevel,
            row.ReputationBucket,
            row.AccountAgeBucket,
            null,
            !string.IsNullOrWhiteSpace(nullifierHash) && row.NullifierKnown && !row.NullifierBlocked,
            false);
    }

    private static bool IsAnonymousActor(CommentModerationQueueRow row)
    {
        string mode = TextHelpers.LowerTrimmed(row.AuthorMode) ?? string.Empty;
        return mode is "" or "anonymous" or "zk_anonymous"
            || !string.IsNullOrWhiteSpace(row.AnonymousNullifierHash)
            || !string.IsNullOrWhiteSpace(row.ModerationSubjectHash);
    }

    private static string ResolveModerationAuthorDisplayName(CommentModerationQueueRow row)
    {
        return ResolveCommentModerationDisplayName(
            row.AuthorMode,
            row.PublicHandle,
            row.AnonymousDisplayName,
            row.AnonymousDisplayLanguage);
    }

    private static string ResolveCommentModerationDisplayName(
        string? authorMode,
        string? publicHandle,
        string? anonymousDisplayName,
        string? anonymousDisplayLanguage)
    {
        string mode = string.IsNullOrWhiteSpace(authorMode)
            ? CommentAuthorModes.Anonymous
            : authorMode.Trim();
        if (string.Equals(mode, CommentAuthorModes.Public, StringComparison.OrdinalIgnoreCase))
        {
            return string.IsNullOrWhiteSpace(publicHandle) ? "未署名用户" : publicHandle.Trim();
        }

        if (!string.IsNullOrWhiteSpace(anonymousDisplayName))
        {
            return anonymousDisplayName.Trim();
        }

        return string.Equals(anonymousDisplayLanguage, "en", StringComparison.OrdinalIgnoreCase)
            ? "Anonymous User"
            : "匿名用户";
    }

    private static string BuildNullifierStatusLabel(CommentModerationQueueRow row)
    {
        if (string.IsNullOrWhiteSpace(row.AnonymousNullifierHash))
        {
            return "Nullifier：未记录";
        }

        if (!row.NullifierKnown)
        {
            return "Nullifier：待同步";
        }

        string status = row.NullifierBlocked ? "已封禁" : "可治理";
        return $"Nullifier：{status} / 使用 {Math.Max(0, row.NullifierUseCount ?? 0)} 次";
    }

    private static bool IsModelAutoModerated(CommentModerationQueueRow row)
        => row.ModeratedByAdminPrincipalId is null
            && row.ModeratedAt.HasValue
            && !string.IsNullOrWhiteSpace(row.Reason)
            && row.Reason.StartsWith("model_policy:", StringComparison.Ordinal);

    private static string ResolveModerationActor(CommentModerationQueueRow row)
    {
        if (IsModelAutoModerated(row))
        {
            return "model";
        }

        return row.ModeratedByAdminPrincipalId.HasValue
            ? $"admin:{row.ModeratedByAdminPrincipalId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture)}"
            : "human-review-pending";
    }

    internal IReadOnlyList<string> DetectCommentHitReasons(string? content, string? storedReason)
    {
        var reasons = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        string value = content ?? string.Empty;
        ContentValidationResult validation = contentFilter.ValidateContent(value);
        if (!validation.IsValid && !string.IsNullOrWhiteSpace(validation.ReasonCode))
        {
            reasons.Add(validation.ReasonCode);
        }

        if (Regex.IsMatch(value, @"<\s*(script|iframe|object|embed)\b|\son[a-z]+\s*=", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
        {
            reasons.Add("html-risk");
        }

        if (Regex.Matches(value, @"https?://|www\.|t\.me/|bit\.ly/", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant).Count >= 3)
        {
            reasons.Add("link-heavy");
        }

        if (Regex.IsMatch(value, @"(.)\1{7,}", RegexOptions.CultureInvariant))
        {
            reasons.Add("spam-repeat");
        }

        string? reason = TextHelpers.NormalizeNullable(storedReason, 64);
        if (string.Equals(reason, "pending_review", StringComparison.OrdinalIgnoreCase))
        {
            reasons.Add("pending-review");
        }
        else if (!string.IsNullOrWhiteSpace(reason))
        {
            reasons.Add($"manual:{reason}");
        }

        return reasons.Count == 0 ? ["manual-review"] : reasons.ToArray();
    }

    private async Task<IReadOnlyDictionary<long, CommentModerationModelSignalResponse>> LoadLatestModelSignalsAsync(
        IReadOnlyList<CommentModerationQueueRow> rows,
        CancellationToken cancellationToken)
    {
        long[] commentIds = [.. rows.Select(static row => row.Id).Where(static id => id > 0).Distinct()];
        if (commentIds.Length == 0)
        {
            return new Dictionary<long, CommentModerationModelSignalResponse>();
        }

        string[] parameterNames = new string[commentIds.Length];
        var parameters = new SugarParameter[commentIds.Length];
        for (int i = 0; i < commentIds.Length; i++)
        {
            string parameterName = string.Concat("@CommentId", i.ToString(CultureInfo.InvariantCulture));
            parameterNames[i] = parameterName;
            parameters[i] = new SugarParameter(parameterName, commentIds[i]);
        }

        string sql = $"""
            SELECT DISTINCT ON (comment_id)
                id,
                comment_id,
                provider,
                model,
                contract_version,
                label,
                severity,
                confidence,
                primary_reason,
                needs_second_round,
                risk_categories,
                evidence_json,
                raw_reason,
                latency_ms,
                status,
                error_code,
                threshold_profile,
                metadata_json,
                created_at_utc
            FROM comment_moderation_signal
            WHERE comment_id IN ({string.Join(", ", parameterNames)})
            ORDER BY comment_id, created_at_utc DESC, id DESC;
            """;

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters);
        var signals = new Dictionary<long, CommentModerationModelSignalResponse>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            CommentModerationSignal signal = ReadCommentModerationSignal(reader);
            signals[signal.CommentId] = ToModelSignalResponse(signal);
        }

        logger.LogDebug("comment-moderation-latest-signals queueRows={QueueRows} loadedSignalRows={LoadedSignalRows}", rows.Count, signals.Count);
        return signals;
    }

    private static CommentModerationSignal ReadCommentModerationSignal(DbDataReader reader)
        => new()
        {
            Id = reader.ReadInt64("id"),
            CommentId = reader.ReadInt64("comment_id"),
            Provider = reader.ReadString("provider"),
            Model = reader.ReadString("model"),
            ContractVersion = reader.ReadString("contract_version"),
            Label = reader.ReadString("label"),
            Severity = reader.ReadString("severity"),
            Confidence = reader.ReadDouble("confidence"),
            PrimaryReason = reader.IsNull("primary_reason") ? null : reader.ReadString("primary_reason"),
            NeedsSecondRound = reader.ReadBoolean("needs_second_round"),
            RiskCategories = reader.IsNull("risk_categories") ? null : reader.ReadString("risk_categories"),
            EvidenceJson = reader.IsNull("evidence_json") ? null : reader.ReadString("evidence_json"),
            RawReason = reader.IsNull("raw_reason") ? null : reader.ReadString("raw_reason"),
            LatencyMs = reader.ReadInt32("latency_ms"),
            Status = reader.ReadString("status"),
            ErrorCode = reader.IsNull("error_code") ? null : reader.ReadString("error_code"),
            ThresholdProfile = reader.IsNull("threshold_profile") ? null : reader.ReadString("threshold_profile"),
            MetadataJson = reader.IsNull("metadata_json") ? null : reader.ReadString("metadata_json"),
            CreatedAtUtc = reader.ReadDateTime("created_at_utc")
        };

    private async Task LoadAnonymousNullifierSummariesAsync(
        IReadOnlyList<CommentModerationQueueRow> rows,
        CancellationToken cancellationToken)
    {
        string[] hashes = [.. rows
            .Select(static row => TextHelpers.NormalizeNullable(row.AnonymousNullifierHash, 128))
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)];
        if (hashes.Length == 0)
        {
            return;
        }

        List<CommentAnonymousNullifier> nullifiers = await db.Queryable<CommentAnonymousNullifier>()
            .Where(item => hashes.Contains(item.NullifierHash))
            .ToListAsync(cancellationToken);
        Dictionary<string, CommentAnonymousNullifier> byKey = nullifiers.ToDictionary(
            static item => BuildNullifierKey(item.NullifierHash, item.Scope),
            static item => item,
            StringComparer.Ordinal);

        foreach (CommentModerationQueueRow row in rows)
        {
            string? hash = TextHelpers.NormalizeNullable(row.AnonymousNullifierHash, 128);
            string? scope = TextHelpers.NormalizeNullable(row.AnonymousScope, 128);
            if (hash is null || scope is null)
            {
                continue;
            }

            if (!byKey.TryGetValue(BuildNullifierKey(hash, scope), out CommentAnonymousNullifier? nullifier))
            {
                continue;
            }

            row.NullifierKnown = true;
            row.NullifierBlocked = nullifier.Blocked;
            row.NullifierUseCount = nullifier.UseCount;
        }
    }

    private static string BuildNullifierKey(string nullifierHash, string scope)
        => string.Concat(nullifierHash.Trim(), "\n", scope.Trim());

    private static CommentModerationModelSignalResponse ToModelSignalResponse(CommentModerationSignal signal)
        => new(
            signal.Provider,
            signal.Model,
            signal.ContractVersion,
            signal.Label,
            Math.Clamp(signal.Confidence, 0d, 1d),
            signal.Severity,
            signal.PrimaryReason,
            signal.NeedsSecondRound,
            ParseCommaList(signal.RiskCategories),
            signal.EvidenceJson,
            signal.RawReason,
            Math.Max(0, signal.LatencyMs),
            signal.Status,
            signal.ErrorCode,
            signal.ThresholdProfile,
            signal.CreatedAtUtc);

    private async Task<int> BanModerationUsersAsync(IEnumerable<long> commentIds, string? reason, CancellationToken cancellationToken)
    {
        long[] ids = [.. commentIds.Where(static id => id > 0).Distinct()];
        if (ids.Length == 0)
        {
            return 0;
        }

        List<int?> userIds = await db.Queryable<Comment>()
            .Where(item => ids.Contains(item.Id) && item.AuthorMode == "public")
            .Select(item => item.UserId)
            .ToListAsync(cancellationToken);
        int[] uniqueUserIds = [.. userIds
            .Where(static id => id is > 0)
            .Select(static id => id.GetValueOrDefault())
            .Distinct()];
        if (uniqueUserIds.Length == 0)
        {
            return 0;
        }

        string effectiveReason = TextHelpers.NormalizeNullable(reason, 256) ?? "评论审核处置";
        var bannedUserIds = new List<int>();
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            List<UserBanCandidate> banTargets = await LoadUserBanCandidatesAsync(uniqueUserIds, cancellationToken);
            foreach (UserBanCandidate target in banTargets)
            {
                if (!await TryBanUserCandidateAsync(target, effectiveReason, cancellationToken))
                {
                    continue;
                }

                bannedUserIds.Add(target.Id);
            }
        });
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Comment moderation user ban failed.", transaction.ErrorException);
        }

        foreach (int userId in bannedUserIds)
        {
            await blacklistService.BanUserAsync(userId, effectiveReason);
        }

        return bannedUserIds.Count;
    }

    private async Task<List<UserBanCandidate>> LoadUserBanCandidatesAsync(int[] userIds, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (userIds.Length == 0)
        {
            return [];
        }

        string[] parameterNames = new string[userIds.Length];
        var parameters = new SugarParameter[userIds.Length];
        for (int i = 0; i < userIds.Length; i++)
        {
            string parameterName = string.Concat("@UserId", i.ToString(CultureInfo.InvariantCulture));
            parameterNames[i] = parameterName;
            parameters[i] = new SugarParameter(parameterName, userIds[i]);
        }

        string sql = $"""
            SELECT id, xmin::text AS row_version
            FROM sys_user
            WHERE id IN ({string.Join(", ", parameterNames)})
              AND status <> 2
              AND deleted_at IS NULL;
            """;
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters);
        var candidates = new List<UserBanCandidate>();
        while (await reader.ReadAsync(cancellationToken))
        {
            candidates.Add(new UserBanCandidate(reader.ReadInt32("id"), reader.ReadString("row_version")));
        }

        return candidates;
    }

    private async Task<bool> TryBanUserCandidateAsync(UserBanCandidate target, string reason, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE sys_user
            SET status = 1,
                banreason = @Reason
            WHERE id = @UserId
              AND status <> 2
              AND deleted_at IS NULL
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@UserId", target.Id),
            new SugarParameter("@Reason", reason),
            new SugarParameter("@RowVersion", target.RowVersion));
        return updated > 0;
    }

    private async Task<CommentModerationStateRow?> LoadCommentModerationStateAsync(long commentId, CancellationToken cancellationToken)
    {
        CommentModerationStateRow? row = await db.Queryable<Comment, Article, Comment, CommentRegionCompliance>((c, a, pc, rc) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.ReplyToCommentId == pc.Id,
                JoinType.Left, c.Id == rc.CommentId
            })
            .Where((c, a, pc, rc) => c.Id == commentId && !c.IsDeleted)
            .Select((c, a, pc, rc) => new CommentModerationStateRow
            {
                Id = c.Id,
                ArticleId = c.ArticleId,
                ArticleTitle = a.Title,
                UserId = c.UserId,
                AuthorMode = c.AuthorMode,
                PublicHandle = c.PublicHandle,
                AnonymousDisplayName = c.AnonymousDisplayName,
                AnonymousDisplayLanguage = c.AnonymousDisplayLanguage,
                AnonymousScope = c.AnonymousScope,
                CredentialLevel = c.CredentialLevel,
                Content = c.Content,
                CreateTime = c.CreateTime,
                ParentId = c.ParentId,
                RootId = c.RootId,
                ReplyToUserId = c.ReplyToUserId,
                ReplyToCommentId = c.ReplyToCommentId,
                ReplyToAuthorMode = pc.AuthorMode,
                ReplyToPublicHandle = pc.PublicHandle,
                ReplyToAnonymousDisplayName = pc.AnonymousDisplayName,
                ReplyToAnonymousDisplayLanguage = pc.AnonymousDisplayLanguage,
                Depth = c.Depth,
                Status = c.ModerationStatus,
                RegionComplianceId = rc.Id,
                RegionCanPublish = rc.CanPublish
            })
            .FirstAsync(cancellationToken);

        return row is null ? null : HydrateCommentModerationDisplayNames(row);
    }

    private async Task<List<CommentModerationStateRow>> LoadCommentModerationStatesAsync(long[] commentIds, CancellationToken cancellationToken)
    {
        if (commentIds.Length == 0)
        {
            return [];
        }

        List<CommentModerationStateRow> rows = await db.Queryable<Comment, Article, Comment, CommentRegionCompliance>((c, a, pc, rc) => new object[]
            {
                JoinType.Left, c.ArticleId == a.Id,
                JoinType.Left, c.ReplyToCommentId == pc.Id,
                JoinType.Left, c.Id == rc.CommentId
            })
            .Where((c, a, pc, rc) => commentIds.Contains(c.Id) && !c.IsDeleted)
            .Select((c, a, pc, rc) => new CommentModerationStateRow
            {
                Id = c.Id,
                ArticleId = c.ArticleId,
                ArticleTitle = a.Title,
                UserId = c.UserId,
                AuthorMode = c.AuthorMode,
                PublicHandle = c.PublicHandle,
                AnonymousDisplayName = c.AnonymousDisplayName,
                AnonymousDisplayLanguage = c.AnonymousDisplayLanguage,
                Content = c.Content,
                CreateTime = c.CreateTime,
                ParentId = c.ParentId,
                RootId = c.RootId,
                ReplyToUserId = c.ReplyToUserId,
                ReplyToCommentId = c.ReplyToCommentId,
                ReplyToAuthorMode = pc.AuthorMode,
                ReplyToPublicHandle = pc.PublicHandle,
                ReplyToAnonymousDisplayName = pc.AnonymousDisplayName,
                ReplyToAnonymousDisplayLanguage = pc.AnonymousDisplayLanguage,
                Depth = c.Depth,
                Status = c.ModerationStatus,
                RegionComplianceId = rc.Id,
                RegionCanPublish = rc.CanPublish
            })
            .ToListAsync(cancellationToken);

        foreach (CommentModerationStateRow row in rows)
        {
            HydrateCommentModerationDisplayNames(row);
        }

        return rows;
    }

    private static CommentModerationStateRow HydrateCommentModerationDisplayNames(CommentModerationStateRow row)
    {
        row.AuthorDisplayName = ResolveCommentModerationDisplayName(
            row.AuthorMode,
            row.PublicHandle,
            row.AnonymousDisplayName,
            row.AnonymousDisplayLanguage);
        row.ReplyToAuthorDisplayName = row.ReplyToCommentId.HasValue
            ? ResolveCommentModerationDisplayName(
                row.ReplyToAuthorMode,
                row.ReplyToPublicHandle,
                row.ReplyToAnonymousDisplayName,
                row.ReplyToAnonymousDisplayLanguage)
            : null;
        return row;
    }

    private async Task InvalidateModeratedCommentAsync(
        CommentModerationStateRow row,
        CommentModerationStatus nextStatus,
        CancellationToken cancellationToken)
    {
        bool publicArticleChanged = row.Status == CommentModerationStatus.Approved || nextStatus == CommentModerationStatus.Approved;
        await cacheInvalidationDispatcher.InvalidateCommentMutationAsync(
            new CommentCacheInvalidationScope(
                ArticleId: row.ArticleId,
                RootId: row.RootId ?? row.Id,
                AccountId: row.UserId,
                PublicArticleChanged: publicArticleChanged,
                UserCommentsChanged: true),
            cancellationToken);
    }

    private async Task PublishModerationRealtimeAsync(CommentModerationStateRow row, CommentModerationStatus nextStatus, DateTime eventTime)
    {
        if (row.Status != CommentModerationStatus.Approved && nextStatus == CommentModerationStatus.Approved)
        {
            await messageRealtimePublisher.PushCommentAddAsync(new CommentAddedNotifyDto
            {
                ArticleId = row.ArticleId,
                Time = eventTime,
                Comment = new CommentPushDto
                {
                    Id = row.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Content = row.Content,
                    CreateTime = row.CreateTime,
                    Author = BuildCommentAuthorView(
                        row.AuthorMode,
                        row.AuthorDisplayName,
                        row.AnonymousDisplayLanguage,
                        null,
                        null),
                    ParentId = row.ParentId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    RootId = (row.RootId ?? row.Id).ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ReplyToAuthor = row.ReplyToCommentId.HasValue
                        ? BuildCommentAuthorView(
                            row.ReplyToAuthorMode,
                            row.ReplyToAuthorDisplayName,
                            row.ReplyToAnonymousDisplayLanguage,
                            null,
                            null)
                        : null,
                    ReplyToCommentId = row.ReplyToCommentId?.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    Depth = Math.Min(2, Math.Max(0, row.Depth)),
                    IsDeleted = false
                }
            });
            await NotifyApprovedReplyAsync(row);
            return;
        }

        if (row.Status == CommentModerationStatus.Approved && nextStatus is CommentModerationStatus.Hidden or CommentModerationStatus.Rejected)
        {
            await messageRealtimePublisher.PushCommentRemoveAsync(row.ArticleId, row.Id, row.RootId ?? row.Id, row.ParentId);
        }
    }

    private static CommentAuthorViewDto BuildCommentAuthorView(
        string? mode,
        string? displayName,
        string? displayLanguage,
        string? scopeLabel,
        string? credentialLevel)
    {
        string normalizedMode = string.IsNullOrWhiteSpace(mode) ? CommentAuthorModes.Anonymous : mode.Trim();
        bool isPublic = string.Equals(normalizedMode, CommentAuthorModes.Public, StringComparison.OrdinalIgnoreCase);
        string resolvedLanguage = string.Equals(displayLanguage, "en", StringComparison.OrdinalIgnoreCase) ? "en" : "zh-CN";
        string fallbackName = isPublic
            ? "未署名用户"
            : (resolvedLanguage == "en" ? "Anonymous User" : "匿名用户");

        return new CommentAuthorViewDto(
            normalizedMode,
            string.IsNullOrWhiteSpace(displayName) ? fallbackName : displayName.Trim(),
            resolvedLanguage,
            null,
            string.IsNullOrWhiteSpace(scopeLabel) ? null : scopeLabel.Trim(),
            string.IsNullOrWhiteSpace(credentialLevel) ? null : credentialLevel.Trim());
    }

    private async Task NotifyApprovedReplyAsync(CommentModerationStateRow row)
    {
        if (!row.ReplyToUserId.HasValue ||
            row.ReplyToUserId.Value <= 0 ||
            (row.UserId.HasValue && row.ReplyToUserId.Value == row.UserId.Value))
        {
            return;
        }

        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                string actor = row.AuthorDisplayName;
                string targetName = string.IsNullOrWhiteSpace(row.ReplyToAuthorDisplayName) ? "您" : row.ReplyToAuthorDisplayName!;
                string snippet = row.Content.Length > 40 ? row.Content[..40] : row.Content;
                await messageCommandService.SendAccountTransactionalNoticeAsync(
                    row.ReplyToUserId.Value,
                    "收到新的评论回复",
                    $"{actor} 回复了 {targetName}：{snippet}");
            },
            logger,
            $"comment-moderation-notify-reply:{row.ReplyToUserId.Value}",
            LogLevel.Warning);
    }

    private static bool ShouldLinkBan(CommentModerationStatus status)
        => status is CommentModerationStatus.Rejected or CommentModerationStatus.Hidden;

    private static bool IsValidModerationStatus(CommentModerationStatus status)
        => status is CommentModerationStatus.Pending
            or CommentModerationStatus.Approved
            or CommentModerationStatus.Rejected
            or CommentModerationStatus.Hidden;

    private static bool IsAllowedModerationTransition(CommentModerationStatus currentStatus, CommentModerationStatus nextStatus)
        => CommentModerationTransitions.IsAllowed(currentStatus, nextStatus);

    private static bool IsRegionApprovalAllowed(CommentModerationStateRow row)
        => row.RegionComplianceId <= 0 || row.RegionCanPublish;


    private sealed record CommentModerationQueueCounts(
        int Pending,
        int Rejected,
        int Hidden);

    private sealed record UserBanCandidate(int Id, string RowVersion);

    private sealed class CommentModerationQueueRow
    {
        public long Id { get; set; }
        public int ArticleId { get; set; }
        public string? ArticleTitle { get; set; }
        public int? UserId { get; set; }
        public string? AuthorMode { get; set; }
        public string? PublicHandle { get; set; }
        public string? AnonymousDisplayName { get; set; }
        public string? AnonymousDisplayLanguage { get; set; }
        public string? ModerationSubjectHash { get; set; }
        public string? AnonymousNullifierHash { get; set; }
        public string? AnonymousScope { get; set; }
        public string? CredentialLevel { get; set; }
        public string? ReputationBucket { get; set; }
        public string? AccountAgeBucket { get; set; }
        public string Content { get; set; } = string.Empty;
        public DateTime CreateTime { get; set; }
        public CommentModerationStatus Status { get; set; }
        public string? Reason { get; set; }
        public long? ModeratedByAdminPrincipalId { get; set; }
        public DateTime? ModeratedAt { get; set; }
        public long RegionComplianceId { get; set; }
        public string? SubmitRegion { get; set; }
        public double SubmitRegionConfidence { get; set; }
        public string? BlockedRegions { get; set; }
        public string? RegionPolicyVersion { get; set; }
        public string? RegionDecisionReason { get; set; }
        public string? RegionRiskLabels { get; set; }
        public bool RegionCanPublish { get; set; }
        public bool RegionRequiresManualReview { get; set; }
        public bool RegionHideUntilReviewed { get; set; }
        public bool NullifierKnown { get; set; }
        public bool NullifierBlocked { get; set; }
        public int? NullifierUseCount { get; set; }
        public IReadOnlyList<CommentModerationModelSignalResponse> ModelSignals { get; set; } = [];
    }

    private sealed class CommentModerationStateRow
    {
        public long Id { get; init; }
        public int ArticleId { get; init; }
        public string? ArticleTitle { get; init; }
        public int? UserId { get; init; }
        public string AuthorDisplayName { get; set; } = "匿名用户";
        public string? AuthorMode { get; set; }
        public string? PublicHandle { get; set; }
        public string? AnonymousDisplayName { get; set; }
        public string? AnonymousDisplayLanguage { get; set; }
        public string? AnonymousScope { get; set; }
        public string? CredentialLevel { get; set; }
        public string Content { get; init; } = string.Empty;
        public DateTime CreateTime { get; init; }
        public long? ParentId { get; init; }
        public long? RootId { get; init; }
        public int? ReplyToUserId { get; init; }
        public string? ReplyToAuthorDisplayName { get; set; }
        public string? ReplyToAuthorMode { get; set; }
        public string? ReplyToPublicHandle { get; set; }
        public string? ReplyToAnonymousDisplayName { get; set; }
        public string? ReplyToAnonymousDisplayLanguage { get; set; }
        public long? ReplyToCommentId { get; init; }
        public int Depth { get; init; }
        public CommentModerationStatus Status { get; init; }
        public long RegionComplianceId { get; init; }
        public bool RegionCanPublish { get; init; }
    }

}
