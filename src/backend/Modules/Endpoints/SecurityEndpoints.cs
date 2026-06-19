using System.Globalization;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static class SecurityEndpoints
{
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";

    public static IEndpointRouteBuilder MapSecurityEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(BinaryBridgeInternalRequest.SecurityPrefix)
            .WithTags("Security")
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .AddEndpointFilter<BinaryBridgeInternalOnlyFilter>();

        group.MapGet("/overview", (
            ISecurityAdminPolicyService policy,
            CrawlerDetectorService detector,
            ICrawlerRangeSyncService crawlerSync) =>
        {
            return Results.Ok(JsonApiResponse<SecurityOverviewResponse>.Ok(
                policy.BuildSecurityOverview(detector.GetRangeStatus(), crawlerSync.GetStatus())));
        });

        group.MapGet("/anti-crawler/overview", (
            ISecurityAdminPolicyService policy,
            CrawlerDetectorService detector,
            ICrawlerRangeSyncService crawlerSync) =>
        {
            return Results.Ok(JsonApiResponse<AntiCrawlerOverviewResponse>.Ok(
                policy.BuildAntiCrawlerOverview(detector.GetRangeStatus(), crawlerSync.GetStatus())));
        });

        group.MapGet("/risk-control/overview", async (
            ISecurityAdminPolicyService policy,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<AntiCrawlerRiskEventResponse> events = policy.ListRiskEvents(null, null, 200);
            IReadOnlyList<SecurityRiskSnapshotResponse> snapshots = policy.ListRiskSnapshots(50);
            SecurityChallengeMetricsResponse challengeMetrics = await BuildSecurityChallengeMetricsAsync(db, null, cancellationToken);
            var response = new RiskControlConsoleResponse(
                policy.CurrentRiskPolicyV2,
                BuildRiskOverview(events, snapshots),
                BuildRiskEventAggregate(events),
                challengeMetrics,
                events.Take(50).ToArray(),
                snapshots.Take(25).ToArray());
            return Results.Ok(JsonApiResponse<RiskControlConsoleResponse>.Ok(response));
        });

        group.MapGet("/challenges/overview", async (
            string? kind,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
        {
            SecurityChallengeMetricsResponse response = await BuildSecurityChallengeMetricsAsync(db, kind, cancellationToken);
            return Results.Ok(JsonApiResponse<SecurityChallengeMetricsResponse>.Ok(response));
        });

        group.MapGet("/policies/overview", async (
            ISecurityAdminPolicyService policy,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<SecurityPolicyVersionSummaryResponse> versions = await BuildPolicyVersionsAsync(db, policy, cancellationToken);
            var response = new SecurityPolicyConsoleResponse(
                policy.CurrentRiskPolicyV2,
                policy.Current,
                policy.CurrentPow,
                versions);
            return Results.Ok(JsonApiResponse<SecurityPolicyConsoleResponse>.Ok(response));
        });

        group.MapGet("/anti-crawler/options", (IAntiCrawlerPolicyProvider policy) =>
            Results.Ok(JsonApiResponse<AntiCrawlerPolicySnapshot>.Ok(policy.Current)));

        group.MapPut("/anti-crawler/options", async (
            AntiCrawlerOptionsUpdateRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerPolicySnapshot snapshot = policy.UpdateAntiCrawlerOptions(request, ResolveActor(context));
            await policySnapshots.ActivateAsync(
                SecurityPolicyIds.AntiCrawler,
                snapshot.Options.Mode,
                snapshot,
                ResolveAdminPrincipalId(context),
                snapshot.Reason,
                cancellationToken);
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.anti_crawler.options_updated",
                "管理员更新反爬虫运行策略",
                "anti_crawler_options",
                snapshot.SnapshotId,
                snapshot.Reason,
                snapshot,
                cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerPolicySnapshot>.Ok(snapshot));
        }).RequireRateLimiting("fixed_ip");

        group.MapPost("/anti-crawler/options/rollback", async (
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            SecurityPolicyRollbackResult<AntiCrawlerPolicySnapshot> rollback = await policySnapshots.RollbackAsync<AntiCrawlerPolicySnapshot>(
                SecurityPolicyIds.AntiCrawler,
                targetVersion: null,
                ResolveAdminPrincipalId(context),
                "rollback",
                cancellationToken);
            AntiCrawlerPolicySnapshot snapshot;
            if (rollback.Success && rollback.Document is not null)
            {
                snapshot = rollback.Document;
                policy.ApplyAntiCrawlerPolicySnapshot(snapshot);
            }
            else
            {
                snapshot = policy.RollbackAntiCrawlerOptions(ResolveActor(context));
                await policySnapshots.ActivateAsync(
                    SecurityPolicyIds.AntiCrawler,
                    snapshot.Options.Mode,
                    snapshot,
                    ResolveAdminPrincipalId(context),
                    "rollback",
                    cancellationToken);
            }
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.anti_crawler.options_rolled_back",
                "管理员回滚反爬虫运行策略",
                "anti_crawler_options",
                snapshot.SnapshotId,
                "rollback",
                snapshot,
                cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerPolicySnapshot>.Ok(snapshot));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/crawler-ranges/status", (ICrawlerRangeSyncService crawlerSync) =>
            Results.Ok(JsonApiResponse<CrawlerRangesAdminStatus>.Ok(crawlerSync.GetStatus())));

        group.MapPost("/anti-crawler/crawler-ranges/sync", async (
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ICrawlerRangeSyncService crawlerSync,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            CrawlerRangeSyncResponse response = await crawlerSync.SynchronizeOnceAsync(cancellationToken);
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.anti_crawler.crawler_ranges_synced",
                "管理员手动同步搜索引擎 CIDR",
                "crawler_ranges",
                response.Status.Source,
                response.Outcome,
                response,
                cancellationToken);
            return Results.Ok(JsonApiResponse<CrawlerRangeSyncResponse>.Ok(response));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/events", (
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRiskEventResponse>>.Ok(
                policy.ListRiskEvents(source, reason, limit ?? 100)));
        });

        group.MapGet("/anti-crawler/risk-events", (
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRiskEventResponse>>.Ok(
                policy.ListRiskEvents(source, reason, limit ?? 100)));
        });

        group.MapGet("/risk/events", (
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRiskEventResponse>>.Ok(
                policy.ListRiskEvents(source, reason, limit ?? 100)));
        });

        group.MapGet("/risk/snapshots", (int? limit, ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<SecurityRiskSnapshotResponse>>.Ok(policy.ListRiskSnapshots(limit ?? 100))));

        group.MapPost("/risk/{dimension}/reset", async (
            string dimension,
            SecurityRiskResetRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityRiskScoreReader riskScoreReader,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            if (!string.Equals(dimension, "ip", StringComparison.OrdinalIgnoreCase)
                || string.IsNullOrWhiteSpace(request.Subject))
            {
                return Results.BadRequest(JsonApiResponse<SecurityRiskResetResponse>.Fail("risk_dimension_invalid"));
            }

            string subject = request.Subject.Trim();
            await riskScoreReader.ResetRiskAsync(new SecurityRiskSubject(subject), cancellationToken);
            var response = new SecurityRiskResetResponse(subject, true, DateTimeOffset.UtcNow);
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.risk.reset",
                "管理员重置安全风险分",
                $"security_risk:{dimension}",
                subject,
                request.Reason,
                response,
                cancellationToken);
            return Results.Ok(JsonApiResponse<SecurityRiskResetResponse>.Ok(response));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/rules", (ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRuleResponse>>.Ok(policy.ListRules())));

        group.MapPost("/anti-crawler/rules", async (
            AntiCrawlerRuleRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerRuleResponse rule = policy.AddRule(request, ResolveActor(context));
            await RecordSecurityAuditAsync(auditEvents, "admin.security.anti_crawler.rule_created", "管理员新增反爬虫规则", "anti_crawler_rule", rule.Id, request.Notes, rule, cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerRuleResponse>.Ok(rule));
        }).RequireRateLimiting("fixed_ip");

        group.MapPut("/anti-crawler/rules/{id}", async (
            string id,
            AntiCrawlerRuleRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerRuleResponse? rule = policy.UpdateRule(id, request, ResolveActor(context));
            if (rule is null)
            {
                return Results.NotFound(JsonApiResponse<AntiCrawlerRuleResponse>.Fail("anti_crawler_rule_not_found"));
            }

            await RecordSecurityAuditAsync(auditEvents, "admin.security.anti_crawler.rule_updated", "管理员更新反爬虫规则", "anti_crawler_rule", rule.Id, request.Notes, rule, cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerRuleResponse>.Ok(rule));
        }).RequireRateLimiting("fixed_ip");

        group.MapDelete("/anti-crawler/rules/{id}", async (
            string id,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool deleted = policy.DeleteRule(id);
            await RecordSecurityAuditAsync(auditEvents, "admin.security.anti_crawler.rule_deleted", "管理员删除反爬虫规则", "anti_crawler_rule", id, deleted ? "deleted" : "not_found", new { deleted }, cancellationToken);
            return deleted
                ? Results.Ok(JsonApiResponse<object>.Ok(new { deleted }))
                : Results.NotFound(JsonApiResponse<object>.Fail("anti_crawler_rule_not_found"));
        }).RequireRateLimiting("fixed_ip");

        MapListEndpoints(group, "allowlist", "allow");
        MapListEndpoints(group, "blocklist", "block");

        group.MapPost("/anti-crawler/simulate", (
            AntiCrawlerSimulationRequest request,
            ISecurityAdminPolicyService policy) =>
        {
            return Results.Ok(JsonApiResponse<AntiCrawlerSimulationResult>.Ok(policy.Simulate(request)));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/pow/overview", (ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<PowOverviewResponse>.Ok(policy.BuildPowOverview())));

        group.MapGet("/pow/options", (IPowPolicyProvider policy) =>
            Results.Ok(JsonApiResponse<PowPolicySnapshot>.Ok(policy.CurrentPow)));

        group.MapPut("/pow/options", async (
            PowOptionsUpdateRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            PowPolicySnapshot snapshot = policy.UpdatePowOptions(request, ResolveActor(context));
            await policySnapshots.ActivateAsync(
                SecurityPolicyIds.Pow,
                snapshot.Options.Mode,
                snapshot,
                ResolveAdminPrincipalId(context),
                snapshot.Reason,
                cancellationToken);
            await RecordSecurityAuditAsync(
                auditEvents,
                "admin.security.pow.options_updated",
                "管理员更新 PoW 运行策略",
                "pow_options",
                snapshot.SnapshotId,
                snapshot.Reason,
                snapshot,
                cancellationToken);
            return Results.Ok(JsonApiResponse<PowPolicySnapshot>.Ok(snapshot));
        }).RequireRateLimiting("fixed_ip");

        group.MapPost("/pow/options/rollback", async (
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            SecurityPolicyRollbackResult<PowPolicySnapshot> rollback = await policySnapshots.RollbackAsync<PowPolicySnapshot>(
                SecurityPolicyIds.Pow,
                targetVersion: null,
                ResolveAdminPrincipalId(context),
                "rollback",
                cancellationToken);
            PowPolicySnapshot snapshot;
            if (rollback.Success && rollback.Document is not null)
            {
                snapshot = rollback.Document;
                policy.ApplyPowPolicySnapshot(snapshot);
            }
            else
            {
                snapshot = policy.RollbackPowOptions(ResolveActor(context));
                await policySnapshots.ActivateAsync(
                    SecurityPolicyIds.Pow,
                    snapshot.Options.Mode,
                    snapshot,
                    ResolveAdminPrincipalId(context),
                    "rollback",
                    cancellationToken);
            }
            await RecordSecurityAuditAsync(auditEvents, "admin.security.pow.options_rolled_back", "管理员回滚 PoW 运行策略", "pow_options", snapshot.SnapshotId, "rollback", snapshot, cancellationToken);
            return Results.Ok(JsonApiResponse<PowPolicySnapshot>.Ok(snapshot));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/pow/events", (int? limit, ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerRiskEventResponse>>.Ok(
                policy.ListRiskEvents(SecurityRiskSources.Pow, null, limit ?? 100))));

        group.MapPost("/pow/simulate", (AntiCrawlerSimulationRequest request, ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<AntiCrawlerSimulationResult>.Ok(policy.Simulate(request))))
            .RequireRateLimiting("fixed_ip");

        return app;
    }

    private static void MapListEndpoints(RouteGroupBuilder group, string routeName, string listType)
    {
        group.MapGet($"/anti-crawler/{routeName}", (ISecurityAdminPolicyService policy) =>
            Results.Ok(JsonApiResponse<IReadOnlyList<AntiCrawlerListEntryResponse>>.Ok(policy.ListEntries(listType))));

        group.MapPost($"/anti-crawler/{routeName}", async (
            AntiCrawlerListEntryRequest request,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerListEntryResponse entry = policy.AddEntry(listType, request, ResolveActor(context));
            await RecordSecurityAuditAsync(auditEvents, $"admin.security.anti_crawler.{listType}list_created", $"管理员新增反爬虫{listType}list", $"anti_crawler_{listType}list", entry.Id, request.Reason, entry, cancellationToken);
            return Results.Ok(JsonApiResponse<AntiCrawlerListEntryResponse>.Ok(entry));
        }).RequireRateLimiting("fixed_ip");

        group.MapDelete($"/anti-crawler/{routeName}/{{id}}", async (
            string id,
            HttpContext context,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool deleted = policy.DeleteEntry(listType, id);
            await RecordSecurityAuditAsync(auditEvents, $"admin.security.anti_crawler.{listType}list_deleted", $"管理员删除反爬虫{listType}list", $"anti_crawler_{listType}list", id, deleted ? "deleted" : "not_found", new { deleted }, cancellationToken);
            return deleted
                ? Results.Ok(JsonApiResponse<object>.Ok(new { deleted }))
                : Results.NotFound(JsonApiResponse<object>.Fail("anti_crawler_list_entry_not_found"));
        }).RequireRateLimiting("fixed_ip");
    }

    private static async Task<SecurityChallengeMetricsResponse> BuildSecurityChallengeMetricsAsync(
        ISqlSugarClient db,
        string? kind,
        CancellationToken cancellationToken)
    {
        string? normalizedKind = NormalizeNullable(kind);
        DateTimeOffset windowStartedAt = DateTimeOffset.UtcNow.AddDays(-1);
        DateTime windowStartedUtc = windowStartedAt.UtcDateTime;
        List<SecurityChallenge> challenges = await db.Queryable<SecurityChallenge>()
            .Where(item => item.CreatedAtUtc >= windowStartedUtc)
            .WhereIF(normalizedKind is not null, item => item.Kind == normalizedKind)
            .OrderBy(item => item.CreatedAtUtc, OrderByType.Desc)
            .Take(2000)
            .ToListAsync(cancellationToken);
        List<SecurityChallengeAttempt> attempts = await db.Queryable<SecurityChallengeAttempt>()
            .Where(item => item.AttemptedAtUtc >= windowStartedUtc)
            .OrderBy(item => item.AttemptedAtUtc, OrderByType.Desc)
            .Take(2000)
            .ToListAsync(cancellationToken);

        Dictionary<string, SecurityChallenge> challengeById = challenges
            .GroupBy(static item => item.ChallengeId, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.First(), StringComparer.Ordinal);
        List<(SecurityChallengeAttempt Attempt, SecurityChallenge? Challenge)> scopedAttempts = attempts
            .Select(item => (Attempt: item, Challenge: challengeById.GetValueOrDefault(item.ChallengeId)))
            .Where(item => normalizedKind is null || string.Equals(item.Challenge?.Kind, normalizedKind, StringComparison.Ordinal))
            .ToList();
        int verified = CountOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Verified);
        int failed = CountOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Failed);
        int replayed = CountOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Replayed);
        int expired = CountOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Expired);
        int revoked = CountOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Revoked);
        int totalAttempts = scopedAttempts.Count;
        IReadOnlyList<SecurityChallengeKindBreakdownResponse> breakdown = BuildChallengeKindBreakdown(challenges, scopedAttempts);
        IReadOnlyList<SecurityChallengeAttemptSummaryResponse> recentAttempts = scopedAttempts
            .OrderByDescending(static item => item.Attempt.AttemptedAtUtc)
            .Take(25)
            .Select(static item => new SecurityChallengeAttemptSummaryResponse(
                item.Attempt.AttemptId,
                item.Attempt.ChallengeId,
                NormalizeDisplayValue(item.Challenge?.Kind),
                item.Attempt.Outcome,
                item.Attempt.Reason,
                NormalizeDisplayValue(item.Challenge?.Action),
                NormalizeDisplayValue(item.Challenge?.RouteKey),
                new DateTimeOffset(DateTime.SpecifyKind(item.Attempt.AttemptedAtUtc, DateTimeKind.Utc))))
            .ToArray();

        return new SecurityChallengeMetricsResponse(
            normalizedKind,
            windowStartedAt,
            challenges.Count,
            totalAttempts,
            verified,
            failed,
            replayed,
            expired,
            revoked,
            Rate(verified, totalAttempts),
            Rate(failed + replayed + expired + revoked, totalAttempts),
            breakdown,
            recentAttempts);
    }

    private static IReadOnlyList<SecurityChallengeKindBreakdownResponse> BuildChallengeKindBreakdown(
        IReadOnlyList<SecurityChallenge> challenges,
        IReadOnlyList<(SecurityChallengeAttempt Attempt, SecurityChallenge? Challenge)> attempts)
        => challenges
            .GroupBy(static item => NormalizeDisplayValue(item.Kind), StringComparer.Ordinal)
            .Select(group =>
            {
                int issued = group.Count();
                List<(SecurityChallengeAttempt Attempt, SecurityChallenge? Challenge)> kindAttempts = attempts
                    .Where(item => string.Equals(NormalizeDisplayValue(item.Challenge?.Kind), group.Key, StringComparison.Ordinal))
                    .ToList();
                int verified = CountOutcomes(kindAttempts, SecurityChallengeAttemptOutcomes.Verified);
                int failed = kindAttempts.Count - verified;
                return new SecurityChallengeKindBreakdownResponse(
                    group.Key,
                    issued,
                    kindAttempts.Count,
                    verified,
                    failed,
                    Rate(verified, kindAttempts.Count),
                    Rate(failed, kindAttempts.Count));
            })
            .OrderByDescending(static item => item.TotalIssued)
            .ThenBy(static item => item.Kind, StringComparer.Ordinal)
            .ToArray();

    private static IReadOnlyList<SecurityRiskEventAggregateResponse> BuildRiskEventAggregate(
        IReadOnlyList<AntiCrawlerRiskEventResponse> events)
        => events
            .GroupBy(static item => new { item.Source, item.Reason })
            .Select(static group => new SecurityRiskEventAggregateResponse(
                group.Key.Source,
                group.Key.Reason,
                group.Count(),
                group.Sum(static item => item.ScoreDelta),
                group.Max(static item => item.TotalScore),
                group.Max(static item => item.OccurredAtUtc)))
            .OrderByDescending(static item => item.Count)
            .ThenByDescending(static item => item.LastOccurredAtUtc)
            .Take(20)
            .ToArray();

    private static SecurityRiskOverviewResponse BuildRiskOverview(
        IReadOnlyList<AntiCrawlerRiskEventResponse> events,
        IReadOnlyList<SecurityRiskSnapshotResponse> snapshots)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        DateTimeOffset lastHour = now.AddHours(-1);
        DateTimeOffset lastDay = now.AddDays(-1);
        string topReason = events
            .GroupBy(static item => item.Reason)
            .OrderByDescending(static group => group.Count())
            .Select(static group => group.Key)
            .FirstOrDefault() ?? "none";
        string topSource = events
            .GroupBy(static item => item.Source)
            .OrderByDescending(static group => group.Count())
            .Select(static group => group.Key)
            .FirstOrDefault() ?? "none";
        return new SecurityRiskOverviewResponse(
            events.Count(item => item.OccurredAtUtc >= lastHour),
            events.Count(item => item.OccurredAtUtc >= lastDay),
            snapshots.Count,
            snapshots.Count(static item => item.Score >= 100),
            topReason,
            topSource);
    }

    private static async Task<IReadOnlyList<SecurityPolicyVersionSummaryResponse>> BuildPolicyVersionsAsync(
        ISqlSugarClient db,
        ISecurityAdminPolicyService policy,
        CancellationToken cancellationToken)
    {
        List<SecurityPolicySnapshot> rows = await db.Queryable<SecurityPolicySnapshot>()
            .OrderBy(static item => item.PolicyId)
            .OrderBy(static item => item.Version, OrderByType.Desc)
            .Take(100)
            .ToListAsync(cancellationToken);
        List<SecurityPolicyVersionSummaryResponse> versions = rows
            .Select(static item => new SecurityPolicyVersionSummaryResponse(
                item.PolicyId,
                item.Version,
                item.Mode,
                item.ActivatedAtUtc is not null && item.RevokedAtUtc is null,
                item.IsLastKnownGood,
                item.RollbackOfVersion,
                item.CreatedByAdminId,
                ToDateTimeOffset(item.CreatedAtUtc),
                ToNullableDateTimeOffset(item.ActivatedAtUtc),
                ToNullableDateTimeOffset(item.RevokedAtUtc),
                item.Reason))
            .ToList();
        versions.Insert(0, new SecurityPolicyVersionSummaryResponse(
            "risk-control",
            0,
            policy.CurrentRiskPolicyV2.GlobalMode,
            true,
            true,
            null,
            null,
            policy.CurrentRiskPolicyV2.UpdatedAtUtc,
            policy.CurrentRiskPolicyV2.UpdatedAtUtc,
            null,
            policy.CurrentRiskPolicyV2.PolicyVersion));
        return versions;
    }

    private static int CountOutcomes(
        IEnumerable<(SecurityChallengeAttempt Attempt, SecurityChallenge? Challenge)> attempts,
        string outcome)
        => attempts.Count(item => string.Equals(item.Attempt.Outcome, outcome, StringComparison.Ordinal));

    private static double Rate(int numerator, int denominator)
        => denominator <= 0 ? 0 : Math.Round((double)numerator / denominator, 4, MidpointRounding.AwayFromZero);

    private static string? NormalizeNullable(string? value)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length == 0 ? null : normalized;
    }

    private static string NormalizeDisplayValue(string? value)
    {
        string normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
        return normalized.Length == 0 ? "unknown" : normalized;
    }

    private static DateTimeOffset ToDateTimeOffset(DateTime value)
        => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private static DateTimeOffset? ToNullableDateTimeOffset(DateTime? value)
        => value.HasValue ? ToDateTimeOffset(value.Value) : null;

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(HttpContext context, IAdminPrincipalService adminPrincipals)
    {
        if (!context.User.TryGetAdminPrincipalId(out long adminPrincipalId) ||
            string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            return Results.Unauthorized();
        }

        string adminSessionId = context.User.GetAdminSessionId()!;
        string proofToken = context.Request.Headers.TryGetValue(MfaProofHeader, out var values)
            ? values.ToString().Trim()
            : string.Empty;
        if (string.IsNullOrWhiteSpace(proofToken) ||
            !await adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                adminPrincipalId,
                adminSessionId,
                AdminSensitiveAction,
                proofToken,
                context.RequestAborted))
        {
            return Results.Json(JsonApiResponse<object>.Fail("MFA_PROOF_REQUIRED"), statusCode: StatusCodes.Status428PreconditionRequired);
        }

        return null;
    }

    private static Task RecordSecurityAuditAsync(
        IAuditEventService auditEvents,
        string action,
        string eventInfo,
        string targetType,
        string targetId,
        string? reasonCode,
        object payload,
        CancellationToken cancellationToken)
        => auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            action,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Warning,
            eventInfo,
            TargetType: targetType,
            TargetId: targetId,
            ReasonCode: reasonCode,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["payload"] = payload
            }), cancellationToken);

    private static string ResolveActor(HttpContext context)
        => context.GetUserId().ToString(CultureInfo.InvariantCulture);

    private static long? ResolveAdminPrincipalId(HttpContext context)
        => context.User.TryGetAdminPrincipalId(out long adminPrincipalId) ? adminPrincipalId : null;
}
