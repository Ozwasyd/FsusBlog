using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
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
    private const string BinaryPrefix = "/api/binary/admin/security";
    private const int DefaultRiskListLimit = 100;
    private const int MaxRiskListLimit = 1000;
    private static readonly JsonSerializerOptions s_auditPayloadJsonOptions = new(JsonSerializerDefaults.Web);

    public static IEndpointRouteBuilder MapSecurityEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(BinaryPrefix)
            .WithTags("Security")
            .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapGet("/overview", (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy,
            CrawlerDetectorService detector,
            ICrawlerRangeSyncService crawlerSync) =>
        {
            return Ok(context, aeds, policy.BuildSecurityOverview(detector.GetRangeStatus(), crawlerSync.GetStatus()));
        });

        group.MapGet("/anti-crawler/overview", (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy,
            CrawlerDetectorService detector,
            ICrawlerRangeSyncService crawlerSync) =>
        {
            return Ok(context, aeds, policy.BuildAntiCrawlerOverview(detector.GetRangeStatus(), crawlerSync.GetStatus()));
        });

        group.MapGet("/risk-control/overview", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<AntiCrawlerRiskEventResponse> events = policy.ListRiskEvents(null, null, 200);
            IReadOnlyList<SecurityRiskSnapshotResponse> snapshots = policy.ListRiskSnapshots(50);
            SecurityChallengeMetricsResponse challengeMetrics = await BuildSecurityChallengeMetricsAsync(db, null, cancellationToken);
            var response = new RiskControlConsoleResponse(
                policy.CurrentRiskPolicy,
                BuildRiskOverview(events, snapshots),
                BuildRiskEventAggregate(events),
                challengeMetrics,
                events.Take(50).ToArray(),
                snapshots.Take(25).ToArray());
            return Ok(context, aeds, response);
        });

        group.MapPost("/risk-control/simulate", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityRiskScoreReader riskScoreReader,
            ISecurityAdminPolicyService policy,
            IRiskDecisionService riskDecisionService,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<RiskControlSimulationRequest>(
                context,
                aeds,
                "risk_control_simulation_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            RiskControlSimulationRequest request = parsed.Value!;
            string? validationError = ValidateRiskControlSimulationRequest(request);
            if (validationError is not null)
            {
                await RecordSecurityAuditAsync(
                    context,
                    auditEvents,
                    "admin.security.risk_control.simulation_rejected",
                    "管理员提交的 RiskControl 模拟参数无效",
                    "risk_control_simulation",
                    TextHelpers.TrimOrNull(request.Subject) ?? "invalid",
                    validationError,
                    request,
                    cancellationToken);
                return AedsJsonResults.BadRequest(aeds, validationError);
            }

            RiskControlSimulationResponse response = await BuildRiskControlSimulationAsync(
                request,
                context,
                riskScoreReader,
                policy,
                riskDecisionService,
                cancellationToken);
            await RecordSecurityAuditAsync(
                context,
                auditEvents,
                "admin.security.risk_control.simulated",
                "管理员模拟 RiskControl 决策",
                "risk_control_simulation",
                response.Subject,
                response.Decision,
                response,
                cancellationToken);
            return Ok(context, aeds, response);
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/risk-control/options", (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy) =>
            Ok(context, aeds, policy.CurrentRiskPolicy));

        group.MapPut("/risk-control/options", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<RiskControlPolicyUpdateRequest>(
                context,
                aeds,
                "risk_control_policy_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            RiskControlPolicyUpdateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            SecurityRiskPolicy snapshot = policy.UpdateRiskControlPolicy(request, ResolveActor(context));
            await policySnapshots.ActivateAsync(
                SecurityPolicyIds.RiskControl,
                snapshot.GlobalMode,
                snapshot,
                ResolveAdminPrincipalId(context),
                request.Reason,
                cancellationToken);
            await RecordSecurityAuditAsync(
                context,
                auditEvents,
                "admin.security.risk_control.options_updated",
                "管理员更新 RiskControl 运行策略",
                "risk_control_options",
                snapshot.SnapshotId,
                request.Reason,
                snapshot,
                cancellationToken);
            return Ok(context, aeds, snapshot);
        })
        .WithAdminSensitiveStepUp()
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/risk-control/options/rollback", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            SecurityPolicyRollbackResult<SecurityRiskPolicy> rollback = await policySnapshots.RollbackAsync<SecurityRiskPolicy>(
                SecurityPolicyIds.RiskControl,
                targetVersion: null,
                ResolveAdminPrincipalId(context),
                "rollback",
                cancellationToken);
            SecurityRiskPolicy snapshot;
            if (rollback.Success && rollback.Document is not null)
            {
                snapshot = rollback.Document;
                policy.ApplyRiskControlPolicySnapshot(snapshot);
            }
            else
            {
                snapshot = policy.RollbackRiskControlPolicy(ResolveActor(context));
                await policySnapshots.ActivateAsync(
                    SecurityPolicyIds.RiskControl,
                    snapshot.GlobalMode,
                    snapshot,
                    ResolveAdminPrincipalId(context),
                    "rollback",
                    cancellationToken);
            }

            await RecordSecurityAuditAsync(
                context,
                auditEvents,
                "admin.security.risk_control.options_rolled_back",
                "管理员回滚 RiskControl 运行策略",
                "risk_control_options",
                snapshot.SnapshotId,
                "rollback",
                snapshot,
                cancellationToken);
            return Ok(context, aeds, snapshot);
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/challenges/overview", async (
            HttpContext context,
            IAedsEncoder aeds,
            string? kind,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
        {
            SecurityChallengeMetricsResponse response = await BuildSecurityChallengeMetricsAsync(db, kind, cancellationToken);
            return Ok(context, aeds, response);
        });

        group.MapGet("/policies/overview", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
        {
            IReadOnlyList<SecurityPolicyVersionSummaryResponse> versions = await BuildPolicyVersionsAsync(db, policy, cancellationToken);
            var response = new SecurityPolicyConsoleResponse(
                policy.CurrentRiskPolicy,
                policy.Current,
                policy.CurrentPow,
                versions);
            return Ok(context, aeds, response);
        });

        group.MapGet("/perception-v2/overview", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy,
            ISqlSugarClient db,
            CancellationToken cancellationToken) =>
        {
            PerceptionSealedV2MetricsResponse metrics = await BuildPerceptionSealedV2MetricsAsync(db, cancellationToken);
            var response = new PerceptionSealedV2ConsoleResponse(
                policy.CurrentPerceptionSealedV2,
                metrics,
                policy.CurrentRiskPolicy);
            return Ok(context, aeds, response);
        });

        group.MapGet("/perception-v2/options", (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy) =>
            Ok(context, aeds, policy.CurrentPerceptionSealedV2));

        group.MapPut("/perception-v2/options", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<PerceptionSealedV2PolicyUpdateRequest>(
                context,
                aeds,
                "perception_v2_policy_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            PerceptionSealedV2PolicyUpdateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            PerceptionSealedV2PolicySnapshot snapshot = policy.UpdatePerceptionSealedV2Policy(request, ResolveActor(context));
            await policySnapshots.ActivateAsync(
                SecurityPolicyIds.PerceptionSealedV2,
                snapshot.Options.Enabled ? SecuritySystemModes.Enforce : SecuritySystemModes.Disabled,
                snapshot,
                ResolveAdminPrincipalId(context),
                snapshot.Reason,
                cancellationToken);
            await RecordSecurityAuditAsync(
                context,
                auditEvents,
                "admin.security.perception_v2.options_updated",
                "管理员更新 perception-sealed@v2 策略",
                "perception_v2_options",
                snapshot.SnapshotId,
                snapshot.Reason,
                snapshot,
                cancellationToken);
            return Ok(context, aeds, snapshot);
        }).RequireRateLimiting("fixed_ip");

        group.MapPost("/perception-v2/options/rollback", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            SecurityPolicyRollbackResult<PerceptionSealedV2PolicySnapshot> rollback =
                await policySnapshots.RollbackAsync<PerceptionSealedV2PolicySnapshot>(
                    SecurityPolicyIds.PerceptionSealedV2,
                    targetVersion: null,
                    ResolveAdminPrincipalId(context),
                    "rollback",
                    cancellationToken);
            PerceptionSealedV2PolicySnapshot snapshot;
            if (rollback.Success && rollback.Document is not null)
            {
                snapshot = rollback.Document;
                policy.ApplyPerceptionSealedV2PolicySnapshot(snapshot);
            }
            else
            {
                snapshot = policy.RollbackPerceptionSealedV2Policy(ResolveActor(context));
                await policySnapshots.ActivateAsync(
                    SecurityPolicyIds.PerceptionSealedV2,
                    snapshot.Options.Enabled ? SecuritySystemModes.Enforce : SecuritySystemModes.Disabled,
                    snapshot,
                    ResolveAdminPrincipalId(context),
                    "rollback",
                    cancellationToken);
            }

            await RecordSecurityAuditAsync(
                context,
                auditEvents,
                "admin.security.perception_v2.options_rolled_back",
                "管理员回滚 perception-sealed@v2 策略",
                "perception_v2_options",
                snapshot.SnapshotId,
                "rollback",
                snapshot,
                cancellationToken);
            return Ok(context, aeds, snapshot);
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/options", (
            HttpContext context,
            IAedsEncoder aeds,
            IAntiCrawlerPolicyProvider policy) =>
            Ok(context, aeds, policy.Current));

        group.MapPut("/anti-crawler/options", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AntiCrawlerOptionsUpdateRequest>(
                context,
                aeds,
                "anti_crawler_options_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AntiCrawlerOptionsUpdateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerPolicySnapshot snapshot;
            try
            {
                snapshot = policy.UpdateAntiCrawlerOptions(request, ResolveActor(context));
            }
            catch (ArgumentException ex)
            {
                return AedsJsonResults.BadRequest(aeds, ex.Message);
            }

            await policySnapshots.ActivateAsync(
                SecurityPolicyIds.AntiCrawler,
                snapshot.Options.Mode,
                snapshot,
                ResolveAdminPrincipalId(context),
                snapshot.Reason,
                cancellationToken);
            await RecordSecurityAuditAsync(
                context,
                auditEvents,
                "admin.security.anti_crawler.options_updated",
                "管理员更新反爬虫运行策略",
                "anti_crawler_options",
                snapshot.SnapshotId,
                snapshot.Reason,
                snapshot,
                cancellationToken);
            return Ok(context, aeds, snapshot);
        }).RequireRateLimiting("fixed_ip");

        group.MapPost("/anti-crawler/options/rollback", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                context,
                auditEvents,
                "admin.security.anti_crawler.options_rolled_back",
                "管理员回滚反爬虫运行策略",
                "anti_crawler_options",
                snapshot.SnapshotId,
                "rollback",
                snapshot,
                cancellationToken);
            return Ok(context, aeds, snapshot);
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/crawler-ranges/status", (
            HttpContext context,
            IAedsEncoder aeds,
            ICrawlerRangeSyncService crawlerSync) =>
            Ok(context, aeds, crawlerSync.GetStatus()));

        group.MapPost("/anti-crawler/crawler-ranges/sync", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ICrawlerRangeSyncService crawlerSync,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            CrawlerRangeSyncResponse response = await crawlerSync.SynchronizeOnceAsync(cancellationToken);
            await RecordSecurityAuditAsync(
                context,
                auditEvents,
                "admin.security.anti_crawler.crawler_ranges_synced",
                "管理员手动同步搜索引擎 CIDR",
                "crawler_ranges",
                response.Status.Source,
                response.Outcome,
                response,
                cancellationToken);
            return Ok(context, aeds, response);
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/events", (
            HttpContext context,
            IAedsEncoder aeds,
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Ok(context, aeds, policy.ListRiskEvents(source, reason, ClampRiskListLimit(limit)));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/risk-events", (
            HttpContext context,
            IAedsEncoder aeds,
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Ok(context, aeds, policy.ListRiskEvents(source, reason, ClampRiskListLimit(limit)));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/risk/events", (
            HttpContext context,
            IAedsEncoder aeds,
            string? source,
            string? reason,
            int? limit,
            ISecurityAdminPolicyService policy) =>
        {
            return Ok(context, aeds, policy.ListRiskEvents(source, reason, ClampRiskListLimit(limit)));
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/risk/snapshots", (
            HttpContext context,
            IAedsEncoder aeds,
            int? limit,
            ISecurityAdminPolicyService policy) =>
            Ok(context, aeds, policy.ListRiskSnapshots(ClampRiskListLimit(limit))))
            .RequireRateLimiting("fixed_ip");

        group.MapPost("/risk/{dimension}/reset", async (
            string dimension,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityRiskScoreReader riskScoreReader,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<SecurityRiskResetRequest>(
                context,
                aeds,
                "security_risk_reset_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            SecurityRiskResetRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            if (!string.Equals(dimension, "ip", StringComparison.OrdinalIgnoreCase)
                || string.IsNullOrWhiteSpace(request.Subject))
            {
                return AedsJsonResults.BadRequest(aeds, "risk_dimension_invalid");
            }

            string subject = request.Subject.Trim();
            await riskScoreReader.ResetRiskAsync(new SecurityRiskSubject(subject), cancellationToken);
            var response = new SecurityRiskResetResponse(subject, true, DateTimeOffset.UtcNow);
            await RecordSecurityAuditAsync(
                context,
                auditEvents,
                "admin.security.risk.reset",
                "管理员重置安全风险分",
                $"security_risk:{dimension}",
                subject,
                request.Reason,
                response,
                cancellationToken);
            return Ok(context, aeds, response);
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/anti-crawler/rules", (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy) =>
            Ok(context, aeds, policy.ListRules()));

        group.MapPost("/anti-crawler/rules", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AntiCrawlerRuleRequest>(
                context,
                aeds,
                "anti_crawler_rule_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AntiCrawlerRuleRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerRuleResponse rule = policy.AddRule(request, ResolveActor(context));
            await RecordSecurityAuditAsync(context, auditEvents, "admin.security.anti_crawler.rule_created", "管理员新增反爬虫规则", "anti_crawler_rule", rule.Id, request.Notes, rule, cancellationToken);
            return Ok(context, aeds, rule);
        }).RequireRateLimiting("fixed_ip");

        group.MapPut("/anti-crawler/rules/{id}", async (
            string id,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AntiCrawlerRuleRequest>(
                context,
                aeds,
                "anti_crawler_rule_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AntiCrawlerRuleRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerRuleResponse? rule = policy.UpdateRule(id, request, ResolveActor(context));
            if (rule is null)
            {
                return AedsJsonResults.NotFound(aeds, "anti_crawler_rule_not_found");
            }

            await RecordSecurityAuditAsync(context, auditEvents, "admin.security.anti_crawler.rule_updated", "管理员更新反爬虫规则", "anti_crawler_rule", rule.Id, request.Notes, rule, cancellationToken);
            return Ok(context, aeds, rule);
        }).RequireRateLimiting("fixed_ip");

        group.MapDelete("/anti-crawler/rules/{id}", async (
            string id,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool deleted = policy.DeleteRule(id);
            await RecordSecurityAuditAsync(context, auditEvents, "admin.security.anti_crawler.rule_deleted", "管理员删除反爬虫规则", "anti_crawler_rule", id, deleted ? "deleted" : "not_found", new
            {
                deleted
            }, cancellationToken);
            return deleted
                ? Ok(context, aeds, new
                {
                    deleted
                })
                : AedsJsonResults.NotFound(aeds, "anti_crawler_rule_not_found");
        }).RequireRateLimiting("fixed_ip");

        MapListEndpoints(group, "allowlist", "allow");
        MapListEndpoints(group, "blocklist", "block");

        group.MapPost("/anti-crawler/simulate", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy) =>
        {
            var parsed = await ReadRequestAsync<AntiCrawlerSimulationRequest>(
                context,
                aeds,
                "anti_crawler_simulation_request_invalid",
                context.RequestAborted);
            return parsed.IsSuccess
                ? Ok(context, aeds, policy.Simulate(parsed.Value!))
                : parsed.ToErrorResult(aeds);
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/pow/overview", (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy) =>
            Ok(context, aeds, policy.BuildPowOverview()));

        group.MapGet("/pow/options", (
            HttpContext context,
            IAedsEncoder aeds,
            IPowPolicyProvider policy) =>
            Ok(context, aeds, policy.CurrentPow));

        group.MapPut("/pow/options", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<PowOptionsUpdateRequest>(
                context,
                aeds,
                "pow_options_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            PowOptionsUpdateRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
                context,
                auditEvents,
                "admin.security.pow.options_updated",
                "管理员更新 PoW 运行策略",
                "pow_options",
                snapshot.SnapshotId,
                snapshot.Reason,
                snapshot,
                cancellationToken);
            return Ok(context, aeds, snapshot);
        }).RequireRateLimiting("fixed_ip");

        group.MapPost("/pow/options/rollback", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            ISecurityPolicySnapshotService policySnapshots,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
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
            await RecordSecurityAuditAsync(context, auditEvents, "admin.security.pow.options_rolled_back", "管理员回滚 PoW 运行策略", "pow_options", snapshot.SnapshotId, "rollback", snapshot, cancellationToken);
            return Ok(context, aeds, snapshot);
        }).RequireRateLimiting("fixed_ip");

        group.MapGet("/pow/events", (
            HttpContext context,
            IAedsEncoder aeds,
            int? limit,
            ISecurityAdminPolicyService policy) =>
            Ok(context, aeds, policy.ListRiskEvents(SecurityRiskSources.Pow, null, ClampRiskListLimit(limit))))
            .RequireRateLimiting("fixed_ip");

        group.MapPost("/pow/simulate", async (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy) =>
        {
            var parsed = await ReadRequestAsync<AntiCrawlerSimulationRequest>(
                context,
                aeds,
                "anti_crawler_simulation_request_invalid",
                context.RequestAborted);
            return parsed.IsSuccess
                ? Ok(context, aeds, policy.Simulate(parsed.Value!))
                : parsed.ToErrorResult(aeds);
        })
            .RequireRateLimiting("fixed_ip");

        return app;
    }

    internal static async Task<RiskControlSimulationResponse> BuildRiskControlSimulationAsync(
        RiskControlSimulationRequest request,
        HttpContext context,
        ISecurityRiskScoreReader riskScoreReader,
        ISecurityRiskPolicyProvider riskPolicyProvider,
        IRiskDecisionService riskDecisionService,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(riskScoreReader);
        ArgumentNullException.ThrowIfNull(riskPolicyProvider);
        ArgumentNullException.ThrowIfNull(riskDecisionService);

        string actionName = TextHelpers.TrimOrNull(request.Action) ?? RiskActionNames.CommentCreate;
        if (!RiskActionRegistry.Default.TryGet(actionName, out RiskAction action))
        {
            throw new ArgumentException("risk_action_unknown", nameof(request));
        }

        string routeKey = TextHelpers.TrimOrNull(request.RouteKey) ?? action.DefaultRouteKey ?? string.Empty;
        if (routeKey.Length == 0)
        {
            throw new ArgumentException("risk_route_key_required", nameof(request));
        }

        string clientIp = TextHelpers.TrimOrNull(request.ClientIp) ?? context.GetClientIp();
        string subject = TextHelpers.TrimOrNull(request.Subject) ?? clientIp;
        if (subject.Length == 0)
        {
            throw new ArgumentException("risk_subject_required", nameof(request));
        }

        int riskScore = request.RiskScore.HasValue
            ? request.RiskScore.Value
            : await riskScoreReader.GetRiskScoreAsync(new SecurityRiskSubject(subject), cancellationToken);
        RiskControlContext riskContext = BuildSimulationRiskContext(request, actionName, routeKey, subject, clientIp, context);
        RiskDecision decision = riskDecisionService.Decide(
            riskContext,
            riskPolicyProvider.CurrentRiskPolicy,
            riskScore);

        return new RiskControlSimulationResponse(
            decision.RiskScore,
            decision.EffectiveRiskScore,
            ToDecisionWireValue(decision.Kind),
            decision.Kind.ToString(),
            decision.Reasons,
            decision.RequiredChallenges,
            decision.PolicyVersion,
            decision.ActionName,
            decision.RouteKey,
            subject,
            clientIp,
            riskContext.Actor.Status,
            riskContext.Actor.IdentityKind,
            decision.EscalationLevel,
            Simulated: true);
    }

    private static string? ValidateRiskControlSimulationRequest(RiskControlSimulationRequest request)
    {
        string actionName = TextHelpers.TrimOrNull(request.Action) ?? RiskActionNames.CommentCreate;
        if (!RiskActionRegistry.Default.TryGet(actionName, out RiskAction action))
        {
            return "risk_action_unknown";
        }

        string routeKey = TextHelpers.TrimOrNull(request.RouteKey) ?? action.DefaultRouteKey ?? string.Empty;
        return routeKey.Length == 0 ? "risk_route_key_required" : null;
    }

    private static IResult Ok(HttpContext context, IAedsEncoder aeds, object? value)
    {
        if (!TryResolveRoute(context.Request.Method, ResolveRemainingPath(context), out SecurityAedsRoute route))
        {
            return AedsJsonResults.NotFound(aeds, "security_binary_route_not_found");
        }

        return value is null
            ? AedsJsonResults.OkNull(aeds, route.ResponseFrame)
            : AedsJsonResults.Ok(aeds, route.ResponseFrame, value);
    }

    private static async Task<AedsJsonRequest<T>> ReadRequestAsync<T>(
        HttpContext context,
        IAedsEncoder aeds,
        string invalidMessage,
        CancellationToken cancellationToken)
    {
        if (!TryResolveRoute(context.Request.Method, ResolveRemainingPath(context), out SecurityAedsRoute route)
            || route.RequestFrame is null)
        {
            return AedsJsonRequest<T>.Failure(ErrorDetail.Create(ErrorCode.Validation, "security_binary_body_not_allowed"));
        }

        return await AedsJsonResults.ReadAsync<T>(
            context,
            aeds,
            route.RequestFrame.Value,
            AedsJsonResults.MaxSecurityFrameBytes,
            invalidMessage,
            cancellationToken);
    }

    private static PathString ResolveRemainingPath(HttpContext context)
    {
        return context.Request.Path.StartsWithSegments(BinaryPrefix, StringComparison.OrdinalIgnoreCase, out PathString remaining)
            ? remaining
            : context.Request.Path;
    }

    internal static bool TryResolveRoute(string method, PathString remaining, out SecurityAedsRoute route)
    {
        string[] segments = (remaining.Value ?? string.Empty).Split('/', StringSplitOptions.RemoveEmptyEntries);
        route = default;

        if (HttpMethods.IsGet(method) && segments is ["overview"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["risk-control", "overview"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["risk-control", "options"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsPut(method) && segments is ["risk-control", "options"])
            return Found(AedsFrameType.SecurityOverview, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsPost(method) && segments is ["risk-control", "options", "rollback"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsPost(method) && segments is ["risk-control", "simulate"])
            return Found(AedsFrameType.SecurityOverview, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["challenges", "overview"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["policies", "overview"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["perception-v2", "overview"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["perception-v2", "options"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsPut(method) && segments is ["perception-v2", "options"])
            return Found(AedsFrameType.SecurityOverview, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsPost(method) && segments is ["perception-v2", "options", "rollback"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "overview"])
            return Found(null, AedsFrameType.AntiCrawlerOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "options"])
            return Found(null, AedsFrameType.AntiCrawlerPolicySnapshot, out route);
        if (HttpMethods.IsPut(method) && segments is ["anti-crawler", "options"])
            return Found(AedsFrameType.AntiCrawlerOptionsUpdateRequest, AedsFrameType.AntiCrawlerPolicySnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "options", "rollback"])
            return Found(null, AedsFrameType.AntiCrawlerPolicySnapshot, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "crawler-ranges", "status"])
            return Found(null, AedsFrameType.CrawlerRangesAdminStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "crawler-ranges", "sync"])
            return Found(null, AedsFrameType.CrawlerRangeSyncResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "events"])
            return Found(null, AedsFrameType.SecurityRiskEventList, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "risk-events"])
            return Found(null, AedsFrameType.SecurityRiskEventList, out route);
        if (HttpMethods.IsGet(method) && segments is ["risk", "events"])
            return Found(null, AedsFrameType.SecurityRiskEventList, out route);
        if (HttpMethods.IsGet(method) && segments is ["risk", "snapshots"])
            return Found(null, AedsFrameType.SecurityRiskSnapshotList, out route);
        if (HttpMethods.IsPost(method) && segments is ["risk", _, "reset"])
            return Found(AedsFrameType.SecurityRiskResetRequest, AedsFrameType.SecurityRiskResetResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "rules"])
            return Found(null, AedsFrameType.AntiCrawlerRuleList, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "rules"])
            return Found(AedsFrameType.AntiCrawlerRuleRequest, AedsFrameType.AntiCrawlerRuleResponse, out route);
        if (HttpMethods.IsPut(method) && segments is ["anti-crawler", "rules", _])
            return Found(AedsFrameType.AntiCrawlerRuleRequest, AedsFrameType.AntiCrawlerRuleResponse, out route);
        if (HttpMethods.IsDelete(method) && segments is ["anti-crawler", "rules", _])
            return Found(null, AedsFrameType.AntiCrawlerRuleDeleteResponse, out route);

        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "allowlist" or "blocklist"])
            return Found(null, AedsFrameType.AntiCrawlerListEntryList, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "allowlist" or "blocklist"])
            return Found(AedsFrameType.AntiCrawlerListEntryRequest, AedsFrameType.AntiCrawlerListEntryResponse, out route);
        if (HttpMethods.IsDelete(method) && segments is ["anti-crawler", "allowlist" or "blocklist", _])
            return Found(null, AedsFrameType.AntiCrawlerListEntryDeleteResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "simulate"])
            return Found(AedsFrameType.AntiCrawlerSimulationRequest, AedsFrameType.AntiCrawlerSimulationResult, out route);

        if (HttpMethods.IsGet(method) && segments is ["pow", "overview"])
            return Found(null, AedsFrameType.PowOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["pow", "options"])
            return Found(null, AedsFrameType.PowPolicySnapshot, out route);
        if (HttpMethods.IsPut(method) && segments is ["pow", "options"])
            return Found(AedsFrameType.PowOptionsUpdateRequest, AedsFrameType.PowPolicySnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["pow", "options", "rollback"])
            return Found(null, AedsFrameType.PowPolicySnapshot, out route);
        if (HttpMethods.IsGet(method) && segments is ["pow", "events"])
            return Found(null, AedsFrameType.SecurityRiskEventList, out route);
        if (HttpMethods.IsPost(method) && segments is ["pow", "simulate"])
            return Found(AedsFrameType.AntiCrawlerSimulationRequest, AedsFrameType.AntiCrawlerSimulationResult, out route);

        return false;
    }

    private static bool Found(AedsFrameType? requestFrame, AedsFrameType responseFrame, out SecurityAedsRoute route)
    {
        route = new SecurityAedsRoute(requestFrame, responseFrame);
        return true;
    }

    internal readonly record struct SecurityAedsRoute(AedsFrameType? RequestFrame, AedsFrameType ResponseFrame);

    private static void MapListEndpoints(RouteGroupBuilder group, string routeName, string listType)
    {
        group.MapGet($"/anti-crawler/{routeName}", (
            HttpContext context,
            IAedsEncoder aeds,
            ISecurityAdminPolicyService policy) =>
            Ok(context, aeds, policy.ListEntries(listType)));

        group.MapPost($"/anti-crawler/{routeName}", async (
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadRequestAsync<AntiCrawlerListEntryRequest>(
                context,
                aeds,
                "anti_crawler_list_entry_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AntiCrawlerListEntryRequest request = parsed.Value!;
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            AntiCrawlerListEntryResponse entry = policy.AddEntry(listType, request, ResolveActor(context));
            await RecordSecurityAuditAsync(context, auditEvents, $"admin.security.anti_crawler.{listType}list_created", $"管理员新增反爬虫{listType}list", $"anti_crawler_{listType}list", entry.Id, request.Reason, entry, cancellationToken);
            return Ok(context, aeds, entry);
        }).RequireRateLimiting("fixed_ip");

        group.MapDelete($"/anti-crawler/{routeName}/{{id}}", async (
            string id,
            HttpContext context,
            IAedsEncoder aeds,
            IAdminPrincipalService adminPrincipals,
            ISecurityAdminPolicyService policy,
            IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, aeds);
            if (stepUp is not null)
            {
                return stepUp;
            }

            bool deleted = policy.DeleteEntry(listType, id);
            await RecordSecurityAuditAsync(context, auditEvents, $"admin.security.anti_crawler.{listType}list_deleted", $"管理员删除反爬虫{listType}list", $"anti_crawler_{listType}list", id, deleted ? "deleted" : "not_found", new
            {
                deleted
            }, cancellationToken);
            return deleted
                ? Ok(context, aeds, new
                {
                    deleted
                })
                : AedsJsonResults.NotFound(aeds, "anti_crawler_list_entry_not_found");
        }).RequireRateLimiting("fixed_ip");
    }

    private static RiskControlContext BuildSimulationRiskContext(
        RiskControlSimulationRequest request,
        string actionName,
        string routeKey,
        string subject,
        string clientIp,
        HttpContext context)
    {
        string userAgent = TextHelpers.TrimOrNull(request.UserAgent) ?? context.GetUserAgent();
        string actorStatus = TextHelpers.TrimOrNull(request.ActorStatus) ?? RiskControlActorStatuses.Anonymous;
        string identityKind = TextHelpers.TrimOrNull(request.IdentityKind) ?? ResolveDefaultIdentityKind(actorStatus);
        var actor = actorStatus switch
        {
            RiskControlActorStatuses.AdminPrincipal => new RiskControlActorContext(
                RiskControlActorStatuses.AdminPrincipal,
                AnonymousIdentityRuntime.AdminPrincipalKind,
                subject,
                null,
                null,
                subject,
                null),
            RiskControlActorStatuses.Authenticated => new RiskControlActorContext(
                RiskControlActorStatuses.Authenticated,
                identityKind,
                subject,
                NormalizeHashSubject(subject),
                null,
                null,
                null),
            _ => new RiskControlActorContext(
                RiskControlActorStatuses.Anonymous,
                RiskControlIdentityKinds.Anonymous,
                null,
                null,
                null,
                null,
                null)
        };

        return new RiskControlContext(
            actionName,
            routeKey,
            RiskControlContextStatuses.Resolved,
            clientIp,
            userAgent,
            string.IsNullOrWhiteSpace(userAgent) ? RiskControlContextStatuses.Missing : RiskControlContextStatuses.Present,
            actor,
            BuildDeviceFingerprintContext(request.DeviceFingerprint),
            BuildRegionContext(request.Region),
            request.VerifiedCrawler == true,
            request.SocialPreviewBot == true);
    }

    private static RiskControlDeviceFingerprintContext BuildDeviceFingerprintContext(string? deviceFingerprint)
    {
        string? value = TextHelpers.TrimOrNull(deviceFingerprint);
        if (value is null)
        {
            return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Missing, 0, null, "missing");
        }

        if (value.Length is < 8 or > 128)
        {
            return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Invalid, value.Length, null, "invalid_length");
        }

        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (!(char.IsLetterOrDigit(ch) || ch is '-' or '_' or '.' or ':'))
            {
                return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Invalid, value.Length, null, "invalid_charset");
            }
        }

        string hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
        return new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Present, value.Length, hash, null);
    }

    private static RiskControlRegionContext BuildRegionContext(string? region)
    {
        string? value = TextHelpers.TrimOrNull(region);
        if (value is null)
        {
            return new RiskControlRegionContext(RiskControlContextStatuses.Missing, "UNKNOWN", null, "missing");
        }

        string normalized = value.Trim().ToUpperInvariant() switch
        {
            "CN" or "MAINLAND" => "CN-MAINLAND",
            "HK" => "CN-HK",
            "MO" => "CN-MO",
            "TW" => "CN-TW",
            var other => other
        };
        for (int i = 0; i < normalized.Length; i++)
        {
            char ch = normalized[i];
            if (!(char.IsLetterOrDigit(ch) || ch is '-' or '_'))
            {
                return new RiskControlRegionContext(RiskControlContextStatuses.Invalid, "UNKNOWN", "simulator", "invalid_region");
            }
        }

        return new RiskControlRegionContext(RiskControlContextStatuses.Present, normalized, "simulator", null);
    }

    private static string ResolveDefaultIdentityKind(string actorStatus)
        => actorStatus switch
        {
            RiskControlActorStatuses.AdminPrincipal => AnonymousIdentityRuntime.AdminPrincipalKind,
            RiskControlActorStatuses.Authenticated => RiskControlIdentityKinds.LegacyUser,
            _ => RiskControlIdentityKinds.Anonymous
        };

    private static string ToDecisionWireValue(RiskDecisionKind kind)
        => kind switch
        {
            RiskDecisionKind.Allow => "allow",
            RiskDecisionKind.Challenge => "challenge",
            RiskDecisionKind.StepUp => "step_up",
            RiskDecisionKind.QueueForModeration => "queue_for_moderation",
            RiskDecisionKind.Throttle => "throttle",
            RiskDecisionKind.Block => "block",
            _ => "unknown"
        };

    private static async Task<PerceptionSealedV2MetricsResponse> BuildPerceptionSealedV2MetricsAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        DateTimeOffset windowStartedAt = DateTimeOffset.UtcNow.AddDays(-1);
        DateTime windowStartedUtc = windowStartedAt.UtcDateTime;
        List<SecurityChallenge> challenges = await db.Queryable<SecurityChallenge>()
            .Where(item => item.CreatedAtUtc >= windowStartedUtc)
            .Where(item => item.Kind == "perceptionLocalizationV2"
                || item.Kind == "perceptionMicroInteractionV2")
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
        List<(SecurityChallengeAttempt Attempt, SecurityChallenge Challenge)> scopedAttempts = attempts
            .Select(item => (Attempt: item, Challenge: challengeById.GetValueOrDefault(item.ChallengeId)))
            .Where(static item => item.Challenge is not null)
            .Select(static item => (item.Attempt, item.Challenge!))
            .ToList();

        int verified = CountPerceptionOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Verified);
        int failed = CountPerceptionOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Failed);
        int replayed = CountPerceptionOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Replayed);
        int terminalFailures = failed
            + replayed
            + CountPerceptionOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Expired)
            + CountPerceptionOutcomes(scopedAttempts, SecurityChallengeAttemptOutcomes.Revoked);
        double[] solveDurations = SolveDurations(scopedAttempts);
        int[] payloadBytes = challenges.Select(EstimatePayloadBytes).Where(static value => value > 0).Order().ToArray();
        IReadOnlyList<PerceptionSealedV2TaskKindMetricResponse> taskKindDistribution = BuildPerceptionTaskKindDistribution(challenges, scopedAttempts);
        IReadOnlyList<SecurityChallengeAttemptSummaryResponse> recentAttempts = scopedAttempts
            .OrderByDescending(static item => item.Attempt.AttemptedAtUtc)
            .Take(25)
            .Select(static item => new SecurityChallengeAttemptSummaryResponse(
                item.Attempt.AttemptId,
                item.Attempt.ChallengeId,
                item.Challenge.Kind,
                item.Attempt.Outcome,
                item.Attempt.Reason,
                NormalizeDisplayValue(item.Challenge.Action),
                NormalizeDisplayValue(item.Challenge.RouteKey),
                new DateTimeOffset(DateTime.SpecifyKind(item.Attempt.AttemptedAtUtc, DateTimeKind.Utc))))
            .ToArray();

        return new PerceptionSealedV2MetricsResponse(
            windowStartedAt,
            challenges.Count,
            verified,
            failed,
            replayed,
            Rate(verified, scopedAttempts.Count),
            Rate(terminalFailures, scopedAttempts.Count),
            Average(solveDurations),
            Percentile(solveDurations, 0.95),
            (int)Math.Round(Average(payloadBytes.Select(static value => (double)value).ToArray()), MidpointRounding.AwayFromZero),
            Percentile(payloadBytes, 0.95),
            taskKindDistribution,
            recentAttempts);
    }

    private static IReadOnlyList<PerceptionSealedV2TaskKindMetricResponse> BuildPerceptionTaskKindDistribution(
        IReadOnlyList<SecurityChallenge> challenges,
        IReadOnlyList<(SecurityChallengeAttempt Attempt, SecurityChallenge Challenge)> attempts)
        => challenges
            .GroupBy(static item => new { TaskKind = ToPerceptionTaskKind(item.Kind), ChallengeKind = item.Kind })
            .Select(group =>
            {
                List<(SecurityChallengeAttempt Attempt, SecurityChallenge Challenge)> kindAttempts = attempts
                    .Where(item => string.Equals(item.Challenge.Kind, group.Key.ChallengeKind, StringComparison.Ordinal))
                    .ToList();
                int verified = CountPerceptionOutcomes(kindAttempts, SecurityChallengeAttemptOutcomes.Verified);
                int failed = CountPerceptionOutcomes(kindAttempts, SecurityChallengeAttemptOutcomes.Failed);
                int replayed = CountPerceptionOutcomes(kindAttempts, SecurityChallengeAttemptOutcomes.Replayed);
                double[] solveDurations = SolveDurations(kindAttempts);
                int[] payloadBytes = group.Select(EstimatePayloadBytes).Where(static value => value > 0).ToArray();
                return new PerceptionSealedV2TaskKindMetricResponse(
                    group.Key.TaskKind,
                    group.Key.ChallengeKind,
                    group.Count(),
                    verified,
                    failed,
                    replayed,
                    Rate(verified, kindAttempts.Count),
                    Rate(failed + replayed, kindAttempts.Count),
                    Average(solveDurations),
                    (int)Math.Round(Average(payloadBytes.Select(static value => (double)value).ToArray()), MidpointRounding.AwayFromZero));
            })
            .OrderByDescending(static item => item.Issued)
            .ThenBy(static item => item.TaskKind, StringComparer.Ordinal)
            .ToArray();

    private static int CountPerceptionOutcomes(
        IEnumerable<(SecurityChallengeAttempt Attempt, SecurityChallenge Challenge)> attempts,
        string outcome)
        => attempts.Count(item => string.Equals(item.Attempt.Outcome, outcome, StringComparison.Ordinal));

    private static double[] SolveDurations(
        IEnumerable<(SecurityChallengeAttempt Attempt, SecurityChallenge Challenge)> attempts)
        => attempts
            .Select(static item => EstimateSolveDurationMs(item.Attempt))
            .Where(static value => value > 0)
            .Order()
            .ToArray();

    private static double EstimateSolveDurationMs(SecurityChallengeAttempt attempt)
    {
        string reason = attempt.Reason ?? string.Empty;
        const string Marker = "solve_duration_ms:";
        int markerIndex = reason.IndexOf(Marker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex < 0)
        {
            return 0;
        }

        string tail = reason[(markerIndex + Marker.Length)..];
        int separatorIndex = tail.IndexOfAny([';', ',', ' ']);
        string number = separatorIndex >= 0 ? tail[..separatorIndex] : tail;
        return double.TryParse(number, NumberStyles.Float, CultureInfo.InvariantCulture, out double value) && double.IsFinite(value)
            ? value
            : 0;
    }

    private static int EstimatePayloadBytes(SecurityChallenge challenge)
        => string.IsNullOrWhiteSpace(challenge.PayloadHash)
            ? 0
            : Encoding.UTF8.GetByteCount(challenge.PayloadHash);

    private static double Average(IReadOnlyList<double> values)
        => values.Count == 0 ? 0 : Math.Round(values.Average(), 2, MidpointRounding.AwayFromZero);

    private static int Percentile(IReadOnlyList<int> values, double percentile)
    {
        if (values.Count == 0)
        {
            return 0;
        }

        int index = PercentileIndex(values.Count, percentile);
        return values.Order().ElementAt(index);
    }

    private static double Percentile(IReadOnlyList<double> values, double percentile)
    {
        if (values.Count == 0)
        {
            return 0;
        }

        int index = PercentileIndex(values.Count, percentile);
        return Math.Round(values.Order().ElementAt(index), 2, MidpointRounding.AwayFromZero);
    }

    private static int PercentileIndex(int count, double percentile)
        => Math.Clamp((int)Math.Ceiling(count * Math.Clamp(percentile, 0d, 1d)) - 1, 0, count - 1);

    private static string ToPerceptionTaskKind(string kind)
        => kind switch
        {
            "perceptionLocalizationV2" => "localization",
            "perceptionMicroInteractionV2" => "microInteraction",
            _ => "unknown"
        };

    private static async Task<SecurityChallengeMetricsResponse> BuildSecurityChallengeMetricsAsync(
        ISqlSugarClient db,
        string? kind,
        CancellationToken cancellationToken)
    {
        string? normalizedKind = TextHelpers.TrimOrNull(kind);
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
        if (!versions.Any(static item => string.Equals(item.PolicyId, SecurityPolicyIds.RiskControl, StringComparison.Ordinal)))
        {
            versions.Insert(0, new SecurityPolicyVersionSummaryResponse(
                SecurityPolicyIds.RiskControl,
                0,
                policy.CurrentRiskPolicy.GlobalMode,
                true,
                true,
                null,
                null,
                policy.CurrentRiskPolicy.UpdatedAtUtc,
                policy.CurrentRiskPolicy.UpdatedAtUtc,
                null,
                policy.CurrentRiskPolicy.PolicyVersion));
        }

        return versions;
    }

    private static int CountOutcomes(
        IEnumerable<(SecurityChallengeAttempt Attempt, SecurityChallenge? Challenge)> attempts,
        string outcome)
        => attempts.Count(item => string.Equals(item.Attempt.Outcome, outcome, StringComparison.Ordinal));

    private static double Rate(int numerator, int denominator)
        => denominator <= 0 ? 0 : Math.Round((double)numerator / denominator, 4, MidpointRounding.AwayFromZero);

    private static string? NormalizeHashSubject(string? value)
    {
        string normalized = TextHelpers.TrimOrNull(value) ?? string.Empty;
        if (normalized.Length != 64)
        {
            return null;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            char c = normalized[i];
            if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F')))
            {
                return null;
            }
        }

        return normalized.ToLowerInvariant();
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

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(
        HttpContext context,
        IAdminPrincipalService adminPrincipals,
        IAedsEncoder aeds)
    {
        if (!context.User.TryGetAdminPrincipalId(out long adminPrincipalId) ||
            string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            return AedsJsonResults.Unauthorized(aeds);
        }

        string adminSessionId = context.User.GetAdminSessionId()!;
        if (!TrustedRequestOrigin.RequireTrustedOriginOrReferer(context))
        {
            return AedsJsonResults.Error(aeds, ApiErrorTransportMappingId.Default403Forbidden, "ORIGIN_NOT_ALLOWED");
        }

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
            return AedsJsonResults.PreconditionRequired(aeds, "MFA_PROOF_REQUIRED");
        }

        return null;
    }

    private static Task RecordSecurityAuditAsync(
        HttpContext context,
        IAuditEventService auditEvents,
        string action,
        string eventInfo,
        string targetType,
        string targetId,
        string? reasonCode,
        object payload,
        CancellationToken cancellationToken)
    {
        long adminPrincipalId = ResolveAdminPrincipalId(context);
        string actor = FormatAdminActor(adminPrincipalId);
        return auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            action,
            AuditOutcomeCatalog.Success,
            AuditSeverityCatalog.Warning,
            eventInfo,
            ActorType: AuditActorTypeCatalog.Admin,
            ActorId: adminPrincipalId.ToString(CultureInfo.InvariantCulture),
            ActorRole: actor,
            TargetType: targetType,
            TargetId: targetId,
            ReasonCode: reasonCode,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["payload"] = NormalizeSecurityAuditPayload(payload),
                ["actor"] = actor,
                ["adminPrincipalId"] = adminPrincipalId
            },
            IsHighValue: true), cancellationToken);
    }

    internal static object? NormalizeSecurityAuditPayload(object? payload)
    {
        return payload switch
        {
            null => null,
            string or bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal or DateTime or DateTimeOffset => payload,
            JsonElement jsonElement => NormalizeJsonElement(jsonElement),
            IReadOnlyDictionary<string, object?> dictionary => dictionary.ToDictionary(
                static item => item.Key,
                static item => NormalizeSecurityAuditPayload(item.Value),
                StringComparer.Ordinal),
            System.Collections.IDictionary dictionary => NormalizeDictionaryPayload(dictionary),
            System.Collections.IEnumerable enumerable => NormalizeEnumerablePayload(enumerable),
            _ => NormalizeJsonElement(JsonSerializer.SerializeToElement(payload, s_auditPayloadJsonOptions))
        };
    }

    private static Dictionary<string, object?> NormalizeDictionaryPayload(System.Collections.IDictionary dictionary)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry entry in dictionary)
        {
            if (entry.Key is null)
            {
                continue;
            }

            string key = Convert.ToString(entry.Key, CultureInfo.InvariantCulture) ?? string.Empty;
            result[key] = NormalizeSecurityAuditPayload(entry.Value);
        }

        return result;
    }

    private static List<object?> NormalizeEnumerablePayload(System.Collections.IEnumerable enumerable)
    {
        var result = new List<object?>();
        foreach (object? item in enumerable)
        {
            result.Add(NormalizeSecurityAuditPayload(item));
        }

        return result;
    }

    private static object? NormalizeJsonElement(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => element.EnumerateObject().ToDictionary(
                static property => property.Name,
                static property => NormalizeJsonElement(property.Value),
                StringComparer.Ordinal),
            JsonValueKind.Array => element.EnumerateArray()
                .Select(static item => NormalizeJsonElement(item))
                .ToList(),
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Number when element.TryGetInt32(out int intValue) => intValue,
            JsonValueKind.Number when element.TryGetInt64(out long longValue) => longValue,
            JsonValueKind.Number when element.TryGetDouble(out double doubleValue) => doubleValue,
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            _ => element.ToString()
        };
    }

    private static string ResolveActor(HttpContext context)
        => FormatAdminActor(ResolveAdminPrincipalId(context));

    private static int ClampRiskListLimit(int? limit)
        => Math.Clamp(limit ?? DefaultRiskListLimit, 1, MaxRiskListLimit);

    private static long ResolveAdminPrincipalId(HttpContext context)
    {
        if (context.User.IsAdminPrincipal() &&
            context.User.TryGetAdminPrincipalId(out long adminPrincipalId))
        {
            return adminPrincipalId;
        }

        throw new UnauthorizedAccessException("admin_principal_missing");
    }

    private static string FormatAdminActor(long adminPrincipalId)
        => string.Concat("admin:", adminPrincipalId.ToString(CultureInfo.InvariantCulture));
}
