using System.Diagnostics;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;

using SqlSugar;

namespace FsusBlog.Server.Services.Moderation;

public sealed class AntiSpamModerationService(
    ISqlSugarClient db,
    IConfiguration configuration,
    AuditLogChannel auditLogChannel,
    ILogger<AntiSpamModerationService> logger,
    IModerationRuntimeStateService? runtimeState = null) : IAntiSpamModerationService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<AntiSpamModerationResult?> ScoreCommentAsync(
        AntiSpamCommentModerationContext context,
        CancellationToken cancellationToken = default)
    {
        ModerationModelRuntimeSnapshot? runtimeModel = runtimeState?.CurrentModel;
        bool enabled = runtimeState?.IsModelEnabled ?? configuration.GetValue<bool>("Moderation:AntiSpamModel:Enabled");
        if (!enabled)
        {
            return null;
        }

        AntiSpamModerationRequest request = BuildRequest(context, runtimeModel);
        AntiSpamModerationResult result;
        Stopwatch stopwatch = Stopwatch.StartNew();
        try
        {
            Result<FsusAntiSpamModelRuntimeSnapshot> runtimeResult = ResolveRuntime(runtimeModel);
            if (runtimeResult.IsFailure)
            {
                result = BuildUnavailableResult(
                    runtimeResult.Error.Message,
                    AntiSpamModerationStatuses.Unavailable,
                    runtimeModel,
                    stopwatch.Elapsed);
            }
            else
            {
                AntiSpamModerationResult scored = runtimeResult.Value!.Score(request);
                result = scored with
                {
                    Latency = stopwatch.Elapsed,
                    Metadata = MergeMetadata(request.Metadata, scored.Metadata)
                };
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "built-in anti-spam model failed open | CommentId: {CommentId}", context.CommentId);
            result = BuildUnavailableResult(
                "fsus_antispam_runtime_error",
                AntiSpamModerationStatuses.Error,
                runtimeModel,
                stopwatch.Elapsed);
        }
        finally
        {
            stopwatch.Stop();
        }

        try
        {
            await PersistSignalAsync(context.CommentId, result, cancellationToken).ConfigureAwait(false);
            WriteAudit(context.CommentId, result);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "anti-spam moderation signal persistence failed open | CommentId: {CommentId}", context.CommentId);
        }

        return result;
    }

    public static void ValidateModelRequestJson(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        ValidateModelRequestDocument(document.RootElement);
    }

    public static void ValidateModelRequestJson(ReadOnlyMemory<byte> json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        ValidateModelRequestDocument(document.RootElement);
    }

    private Result<FsusAntiSpamModelRuntimeSnapshot> ResolveRuntime(ModerationModelRuntimeSnapshot? runtimeModel)
    {
        if (runtimeModel?.BuiltInRuntime is { } runtime)
        {
            return Result<FsusAntiSpamModelRuntimeSnapshot>.Success(runtime);
        }

        return FsusAntiSpamModelRuntimeLoader.TryLoad(
            configuration["Moderation:AntiSpamModel:RuntimePath"],
            new FsusAntiSpamModelRuntimeLoadOptions(
                configuration.GetValue<bool?>("Moderation:AntiSpamModel:RequireSignature") ?? true,
                configuration["Moderation:AntiSpamModel:TrustedSigningKey"],
                configuration["Moderation:AntiSpamModel:RuntimeChannel"] ?? "stable"));
    }

    private AntiSpamModerationRequest BuildRequest(
        AntiSpamCommentModerationContext context,
        ModerationModelRuntimeSnapshot? runtimeModel)
    {
        int maxChars = Math.Clamp(configuration.GetValue<int?>("Moderation:AntiSpamModel:MaxContentChars") ?? 2_000, 1, 20_000);
        string content = context.Content.Length <= maxChars ? context.Content : context.Content[..maxChars];
        var metadata = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["source"] = "fsusblog",
            ["comment_id"] = context.CommentId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["article_id"] = context.ArticleId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["region_policy_version"] = context.RegionPolicyVersion ?? string.Empty
        };
        AddMetadata(metadata, "author_mode", context.AuthorMode);
        AddMetadata(metadata, "anonymous_display_language", context.AnonymousDisplayLanguage);
        AddMetadata(metadata, "moderation_subject_hash", context.ModerationSubjectHash);
        AddMetadata(metadata, "anonymous_nullifier_hash", context.AnonymousNullifierHash);
        AddMetadata(metadata, "anonymous_scope", context.AnonymousScope);
        AddMetadata(metadata, "rate_class", context.RateClass);
        AddMetadata(metadata, "requires_moderation", context.RequiresModeration);
        AddMetadata(metadata, "anonymous_comments_enabled", context.AnonymousCommentsEnabled);
        AddMetadata(metadata, "zk_anonymous_enabled", context.ZkAnonymousEnabled);

        return new AntiSpamModerationRequest(
            $"comment:{context.CommentId.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            content,
            "comment",
            configuration["Moderation:AntiSpamModel:Locale"] ?? "zh-CN",
            context.SubmittedAtUtc,
            context.RegionHint,
            runtimeModel?.ThresholdProfile ?? configuration["Moderation:AntiSpamModel:ThresholdProfile"] ?? "default",
            metadata);
    }

    private static void ValidateModelRequestDocument(JsonElement root)
    {
        RejectForbiddenIdentityFields(root, "$");
        if (root.TryGetProperty("metadata", out JsonElement metadata) && metadata.ValueKind == JsonValueKind.Object)
        {
            HashSet<string> allowed = AntiSpamModerationContract.AllowedRequestMetadataFields
                .Select(NormalizeMetadataKey)
                .ToHashSet(StringComparer.Ordinal);
            foreach (JsonProperty property in metadata.EnumerateObject())
            {
                string normalizedName = NormalizeMetadataKey(property.Name);
                if (!allowed.Contains(normalizedName))
                {
                    throw new InvalidOperationException($"model request metadata contains unsupported field: {property.Name}");
                }
            }
        }
    }

    private static void RejectForbiddenIdentityFields(JsonElement element, string path)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (JsonProperty property in element.EnumerateObject())
                {
                    if (IsForbiddenIdentityField(property.Name))
                    {
                        throw new InvalidOperationException($"model request contains forbidden identity field: {property.Name}");
                    }

                    RejectForbiddenIdentityFields(property.Value, $"{path}.{property.Name}");
                }

                break;
            case JsonValueKind.Array:
                int index = 0;
                foreach (JsonElement item in element.EnumerateArray())
                {
                    RejectForbiddenIdentityFields(item, $"{path}[{index.ToString(System.Globalization.CultureInfo.InvariantCulture)}]");
                    index++;
                }

                break;
        }
    }

    private static bool IsForbiddenIdentityField(string key)
    {
        string normalized = NormalizeMetadataKey(key);
        return AntiSpamModerationContract.ForbiddenIdentityFields
            .Select(NormalizeMetadataKey)
            .Contains(normalized, StringComparer.Ordinal);
    }

    private static void AddMetadata(IDictionary<string, string> metadata, string key, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value))
        {
            metadata[key] = value.Trim();
        }
    }

    private static void AddMetadata(IDictionary<string, string> metadata, string key, bool? value)
    {
        if (value.HasValue)
        {
            metadata[key] = value.Value ? "true" : "false";
        }
    }

    private static IReadOnlyDictionary<string, string> MergeMetadata(
        IReadOnlyDictionary<string, string> requestMetadata,
        IReadOnlyDictionary<string, string> resultMetadata)
    {
        var merged = new Dictionary<string, string>(requestMetadata, StringComparer.Ordinal);
        foreach ((string key, string value) in resultMetadata)
        {
            string normalizedKey = NormalizeMetadataKey(key);
            if (normalizedKey.Length == 0
                || AntiSpamModerationContract.ForbiddenFinalActionFields.Contains(normalizedKey, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!string.IsNullOrWhiteSpace(value))
            {
                merged[normalizedKey] = value.Trim();
            }
        }

        return merged;
    }

    private async Task PersistSignalAsync(long commentId, AntiSpamModerationResult result, CancellationToken cancellationToken)
    {
        var signal = new CommentModerationSignal
        {
            CommentId = commentId,
            Provider = Normalize(result.Provider, 64),
            Model = Normalize(result.Model, 128),
            ContractVersion = Normalize(result.ContractVersion, 64),
            Label = Normalize(result.Label, 64),
            Severity = Normalize(result.Severity, 32),
            Confidence = Math.Clamp(result.Confidence, 0d, 1d),
            PrimaryReason = TextHelpers.NormalizeNullable(result.PrimaryReason, 128),
            NeedsSecondRound = result.NeedsSecondRound,
            RiskCategories = result.Categories.Count == 0 ? null : string.Join(',', result.Categories.Select(static item => item.Id).Distinct(StringComparer.Ordinal)),
            EvidenceJson = result.Evidence.Count == 0 ? null : JsonSerializer.Serialize(result.Evidence, JsonOptions),
            RawReason = TextHelpers.NormalizeNullable(result.RawReason, 4_096),
            LatencyMs = Math.Max(0, RoundingHelper.RoundToInt(result.Latency.TotalMilliseconds)),
            Status = Normalize(result.Status, 32),
            ErrorCode = TextHelpers.NormalizeNullable(result.ErrorCode, 64),
            ThresholdProfile = TextHelpers.NormalizeNullable(result.ThresholdProfile, 128),
            MetadataJson = result.Metadata.Count == 0 ? null : JsonSerializer.Serialize(result.Metadata, JsonOptions),
            CreatedAtUtc = DateTime.UtcNow
        };

        await db.Insertable(signal).ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
    }

    private void WriteAudit(long commentId, AntiSpamModerationResult result)
    {
        string eventInfo = result.Status switch
        {
            AntiSpamModerationStatuses.Ok => "model_moderation_scored",
            AntiSpamModerationStatuses.Timeout => "model_moderation_timeout",
            AntiSpamModerationStatuses.Unavailable => "model_moderation_unavailable",
            AntiSpamModerationStatuses.ContractInvalid => "model_moderation_contract_invalid",
            _ => "model_moderation_error"
        };
        string context = JsonSerializer.Serialize(new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["comment_id"] = commentId,
            ["provider"] = result.Provider,
            ["model"] = result.Model,
            ["contract_version"] = result.ContractVersion,
            ["label"] = result.Label,
            ["confidence"] = result.Confidence,
            ["status"] = result.Status,
            ["error_code"] = result.ErrorCode
        });
        auditLogChannel.TryWrite(new AuditRecord(
            AuditSourceCatalog.Comment,
            AuditTypeCatalog.Business,
            DateTime.UtcNow,
            eventInfo,
            Encoding.UTF8.GetBytes(context),
            Action: eventInfo,
            Outcome: result.Status == AntiSpamModerationStatuses.Ok ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Failure,
            Severity: result.Status == AntiSpamModerationStatuses.Ok ? AuditSeverityCatalog.Info : AuditSeverityCatalog.Warning,
            ActorType: AuditActorTypeCatalog.System,
            TargetType: "comment",
            TargetId: commentId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ReasonCode: result.ErrorCode,
            ContextJson: context));
    }

    private AntiSpamModerationResult BuildUnavailableResult(
        string errorCode,
        string status,
        ModerationModelRuntimeSnapshot? runtimeModel,
        TimeSpan latency)
        => new(
            false,
            AntiSpamModerationProviders.BuiltIn,
            runtimeModel?.ModelProfile ?? "unavailable",
            runtimeModel?.ContractVersion
                ?? configuration["Moderation:AntiSpamModel:ContractVersion"]
                ?? AntiSpamModerationContract.DefaultVersion,
            "suspicious",
            0d,
            "medium",
            null,
            false,
            [],
            [],
            errorCode,
            latency,
            status,
            errorCode,
            runtimeModel?.ThresholdProfile ?? configuration["Moderation:AntiSpamModel:ThresholdProfile"] ?? "default",
            new Dictionary<string, string>(StringComparer.Ordinal));

    private static string Normalize(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string NormalizeMetadataKey(string key)
        => TextHelpers.NormalizeModeToken(key) ?? string.Empty;
}
