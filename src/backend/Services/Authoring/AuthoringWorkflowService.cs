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

public sealed partial class AuthoringWorkflowService(
    ISqlSugarClient db,
    IArticleService articleService,
    IContentFilterService contentFilter,
    IBlacklistService blacklistService,
    ICacheInvalidationDispatcher cacheInvalidationDispatcher,
    IMessageRealtimePublisher messageRealtimePublisher,
    IMessageCommandService messageCommandService,
    AuditLogChannel auditLogChannel,
    IConfiguration configuration,
    ILogger<AuthoringWorkflowService> logger)
{
    private const int MaxDraftKeyLength = 96;
    private const int PreviewLength = 24_000;
    private const int WarningOverrideReasonLength = 180;
    private const string ModelRiskBorderlineReviewReason = "model_policy:model_risk_borderline_review";
    private static readonly JsonSerializerOptions DraftRightsJsonOptions = new(JsonSerializerDefaults.Web);
    private static int assetArticleReferenceStoreEnsured;

}
