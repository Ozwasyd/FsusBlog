using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
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
    IHttpClientFactory httpClientFactory,
    AuditLogChannel auditLogChannel,
    ILogger<AntiSpamModerationService> logger,
    IModerationRuntimeStateService? runtimeState = null) : IAntiSpamModerationService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const string HttpJsonAllowedHostsKey = "Moderation:AntiSpamModel:Providers:http-json:AllowedHosts";
    public const long MaxHttpJsonProviderResponseBytes = 256 * 1024;
    private static readonly TimeSpan DnsCacheTtl = TimeSpan.FromMinutes(5);
    private static readonly ConcurrentDictionary<HttpJsonEndpointCacheKey, EndpointCacheEntry> EndpointValidationCache = new();
    private static readonly ConcurrentDictionary<string, DnsCacheEntry> DnsValidationCache = new(StringComparer.OrdinalIgnoreCase);

    private static readonly HashSet<string> AllowedCategories = new(StringComparer.Ordinal)
    {
        "advertising",
        "contact_lead",
        "scam",
        "spam_repeat",
        "malicious_link",
        "html_risk",
        "pornographic",
        "sexual_explicit",
        "sexual_suggestion",
        "political_sensitive",
        "public_order_risk",
        "national_security_risk",
        "hate_speech",
        "terrorism_extremism",
        "gambling",
        "violence_extreme",
        "child_safety",
        "harassment"
    };

    private static readonly HashSet<string> AllowedLabels = new(StringComparer.Ordinal)
    {
        "clean",
        "suspicious",
        "risky",
        "blocked_candidate"
    };

    private static readonly HashSet<string> AllowedSeverity = new(StringComparer.Ordinal)
    {
        "low",
        "medium",
        "high",
        "critical"
    };

    private static readonly HashSet<string> AllowedProviderStatuses = new(StringComparer.Ordinal)
    {
        "scored",
        "unsupported_language",
        "too_long",
        "empty",
        "provider_error",
        "model_unavailable",
        "contract_mismatch"
    };

    private static readonly string[] ForbiddenProviderMetadataKeys =
    [
        "user_id",
        "userid",
        "user_name",
        "username",
        "public_handle",
        "account_id",
        "credential_commitment",
        "credential_secret",
        "credential_witness",
        "proof",
        "raw_nullifier",
        "nullifier_hash",
        "anonymous_nullifier_hash",
        "ip",
        "ip_hash",
        "raw_ip",
        "device_fingerprint",
        "device_fp",
        "fingerprint",
        "authorization",
        "cookie"
    ];

    private static readonly FrozenSet<string> AllowedRequestMetadataFieldSet = AntiSpamModerationContract.AllowedRequestMetadataFields
        .Select(NormalizeMetadataKey)
        .ToFrozenSet(StringComparer.Ordinal);
    private static readonly FrozenSet<string> ForbiddenIdentityFieldSet = AntiSpamModerationContract.ForbiddenIdentityFields
        .Concat(ForbiddenProviderMetadataKeys)
        .Select(NormalizeMetadataKey)
        .ToFrozenSet(StringComparer.Ordinal);

    public async Task<AntiSpamModerationResult?> ScoreCommentAsync(AntiSpamCommentModerationContext context, CancellationToken cancellationToken = default)
    {
        ModerationModelRuntimeSnapshot? runtimeModel = runtimeState?.CurrentModel;
        bool enabled = runtimeState?.IsModelEnabled ?? configuration.GetValue<bool>("Moderation:AntiSpamModel:Enabled");
        if (!enabled)
        {
            return null;
        }

        string provider = NormalizeProvider(runtimeModel?.Provider ?? configuration["Moderation:AntiSpamModel:Provider"]);
        if (provider == AntiSpamModerationProviders.None)
        {
            return null;
        }

        int timeoutMs = Math.Clamp(runtimeModel?.TimeoutMs ?? configuration.GetValue<int?>("Moderation:AntiSpamModel:TimeoutMs") ?? 800, 100, 10_000);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(timeoutMs));
        AntiSpamModerationResult result;
        try
        {
            result = await ScoreWithProviderAsync(provider, context, runtimeModel, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            result = BuildUnavailableResult(provider, "model_timeout", AntiSpamModerationStatuses.Timeout, TimeSpan.FromMilliseconds(timeoutMs), runtimeModel);
        }
        catch (Exception ex) when (runtimeModel?.FailOpen ?? configuration.GetValue<bool?>("Moderation:AntiSpamModel:FailOpen") ?? true)
        {
            logger.LogWarning(ex, "anti-spam moderation provider failed open | Provider: {Provider} | CommentId: {CommentId}", provider, context.CommentId);
            result = BuildUnavailableResult(provider, "model_provider_error", AntiSpamModerationStatuses.Error, TimeSpan.Zero, runtimeModel);
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

    private async Task<AntiSpamModerationResult> ScoreWithProviderAsync(
        string provider,
        AntiSpamCommentModerationContext context,
        ModerationModelRuntimeSnapshot? runtimeModel,
        CancellationToken cancellationToken)
    {
        AntiSpamModerationRequest request = BuildRequest(context, runtimeModel);
        AntiSpamModerationResult result = provider switch
        {
            AntiSpamModerationProviders.Mock => ScoreMock(request),
            AntiSpamModerationProviders.HttpJson => await ScoreHttpJsonAsync(request, runtimeModel, cancellationToken).ConfigureAwait(false),
            AntiSpamModerationProviders.FsusCli => BuildUnavailableResult(provider, "fsus_cli_provider_not_configured", AntiSpamModerationStatuses.Unavailable, TimeSpan.Zero, runtimeModel),
            _ => BuildUnavailableResult(provider, "model_provider_unknown", AntiSpamModerationStatuses.Unavailable, TimeSpan.Zero, runtimeModel)
        };
        return result with { Metadata = MergeMetadata(request.Metadata, result.Metadata) };
    }

    private AntiSpamModerationRequest BuildRequest(AntiSpamCommentModerationContext context, ModerationModelRuntimeSnapshot? runtimeModel)
    {
        int maxChars = Math.Clamp(configuration.GetValue<int?>("Moderation:AntiSpamModel:MaxContentChars") ?? 2_000, 1, 20_000);
        string content = context.Content.Length <= maxChars ? context.Content : context.Content[..maxChars];
        var metadata = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["source"] = "fsusblog",
            ["comment_id"] = context.CommentId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["region_policy_version"] = context.RegionPolicyVersion ?? string.Empty
        };
        AddMetadata(metadata, "author_mode", context.AuthorMode);
        AddMetadata(metadata, "anonymous_display_language", context.AnonymousDisplayLanguage);
        AddMetadata(metadata, "moderation_subject_hash", context.ModerationSubjectHash);
        AddMetadata(metadata, "credential_level", context.CredentialLevel);
        AddMetadata(metadata, "reputation_bucket", context.ReputationBucket);
        AddMetadata(metadata, "account_age_bucket", context.AccountAgeBucket);
        AddMetadata(metadata, "anonymous_comments_enabled", context.AnonymousCommentsEnabled);
        AddMetadata(metadata, "zk_anonymous_enabled", context.ZkAnonymousEnabled);

        return new AntiSpamModerationRequest(
            $"comment:{context.CommentId.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            content,
            "comment",
            configuration["Moderation:AntiSpamModel:Locale"] ?? "zh-CN",
            context.SubmittedAtUtc,
            context.RegionHint,
            runtimeModel?.ThresholdProfile ?? configuration["Moderation:AntiSpamModel:ThresholdProfile"],
            metadata);
    }

    public static void ValidateProviderRequestJson(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        ValidateProviderRequestDocument(document.RootElement);
    }

    public static void ValidateProviderRequestJson(ReadOnlyMemory<byte> json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        ValidateProviderRequestDocument(document.RootElement);
    }

    private static void ValidateProviderRequestDocument(JsonElement root)
    {
        RejectForbiddenIdentityFields(root, "$");
        if (root.TryGetProperty("metadata", out JsonElement metadata) && metadata.ValueKind == JsonValueKind.Object)
        {
            foreach (JsonProperty property in metadata.EnumerateObject())
            {
                string normalizedName = NormalizeMetadataKey(property.Name);
                if (!AllowedRequestMetadataFieldSet.Contains(normalizedName))
                {
                    throw new InvalidOperationException($"provider request metadata contains unsupported field: {property.Name}");
                }
            }
        }
    }

    private HttpJsonProviderRuntime ResolveHttpJsonProviderRuntime(ModerationModelRuntimeSnapshot? runtimeModel)
    {
        bool allowExternal = runtimeModel?.ExternalProviderAllowed ?? configuration.GetValue<bool>("Moderation:AntiSpamModel:AllowExternalProvider");
        bool reviewed = runtimeModel?.ExternalProviderReviewed ?? configuration.GetValue<bool>("Moderation:AntiSpamModel:ExternalProviderReviewed");
        string? endpoint = configuration["Moderation:AntiSpamModel:Providers:http-json:Endpoint"];
        string? allowedHosts = configuration[HttpJsonAllowedHostsKey];
        _ = TryBuildAllowedProviderHostSet(allowedHosts, out FrozenSet<string>? allowedHostSet);
        string contractVersion = ResolveContractVersion(runtimeModel);
        string runtimeVersion = runtimeModel?.ConfigChecksum
            ?? string.Join(
                '|',
                NormalizeProvider(runtimeModel?.Provider ?? configuration["Moderation:AntiSpamModel:Provider"]),
                runtimeModel?.ModelProfile ?? configuration["Moderation:AntiSpamModel:ModelProfile"],
                runtimeModel?.ThresholdProfile ?? configuration["Moderation:AntiSpamModel:ThresholdProfile"],
                contractVersion,
                runtimeModel?.TimeoutMs.ToString(System.Globalization.CultureInfo.InvariantCulture)
                    ?? Math.Clamp(configuration.GetValue<int?>("Moderation:AntiSpamModel:TimeoutMs") ?? 800, 100, 10_000).ToString(System.Globalization.CultureInfo.InvariantCulture),
                allowExternal.ToString(System.Globalization.CultureInfo.InvariantCulture),
                reviewed.ToString(System.Globalization.CultureInfo.InvariantCulture));

        return new HttpJsonProviderRuntime(
            allowExternal,
            reviewed,
            endpoint,
            allowedHosts,
            allowedHostSet,
            contractVersion,
            runtimeVersion);
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
                        throw new InvalidOperationException($"provider request contains forbidden identity field: {property.Name}");
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
        return ForbiddenIdentityFieldSet.Contains(normalized);
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
        foreach ((string key, string value) in SanitizeProviderMetadata(resultMetadata))
        {
            if (!string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(value))
            {
                merged[key] = value;
            }
        }

        return merged;
    }

    private AntiSpamModerationResult ScoreMock(AntiSpamModerationRequest request)
    {
        bool risky = request.Content.Contains("model_spam", StringComparison.OrdinalIgnoreCase)
            || request.Content.Contains("spam", StringComparison.OrdinalIgnoreCase)
            || request.Content.Contains("广告", StringComparison.OrdinalIgnoreCase);
        string label = risky ? "risky" : "clean";
        double confidence = risky ? 0.92d : 0.97d;
        string severity = risky ? "high" : "low";
        AntiSpamModerationCategorySignal[] categories = risky
            ? [new AntiSpamModerationCategorySignal("spam_repeat", confidence, severity, "show_category_only")]
            : [];

        return new AntiSpamModerationResult(
            true,
            AntiSpamModerationProviders.Mock,
            "fsusblog-mock-moderation",
            ResolveContractVersion(),
            label,
            confidence,
            severity,
            risky ? "spam_repeat" : null,
            risky,
            categories,
            [],
            risky ? "mock risk signal" : "mock clean signal",
            TimeSpan.Zero,
            AntiSpamModerationStatuses.Ok,
            null,
            request.ThresholdProfile,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["mode"] = "score-only"
            });
    }

    private async Task<AntiSpamModerationResult> ScoreHttpJsonAsync(
        AntiSpamModerationRequest request,
        ModerationModelRuntimeSnapshot? runtimeModel,
        CancellationToken cancellationToken)
    {
        HttpJsonProviderRuntime runtime = ResolveHttpJsonProviderRuntime(runtimeModel);
        if (!runtime.AllowExternal || !runtime.Reviewed)
        {
            return BuildUnavailableResult(AntiSpamModerationProviders.HttpJson, "external_provider_not_reviewed", AntiSpamModerationStatuses.Unavailable, TimeSpan.Zero, runtimeModel);
        }

        if (string.IsNullOrWhiteSpace(runtime.Endpoint))
        {
            return BuildUnavailableResult(AntiSpamModerationProviders.HttpJson, "http_endpoint_missing", AntiSpamModerationStatuses.Unavailable, TimeSpan.Zero, runtimeModel);
        }

        AntiSpamProviderEndpointValidation validatedEndpoint = await GetOrValidateHttpJsonEndpointAsync(
            runtime,
            cancellationToken).ConfigureAwait(false);
        if (!validatedEndpoint.Allowed)
        {
            return BuildUnavailableResult(AntiSpamModerationProviders.HttpJson, $"http_endpoint_{validatedEndpoint.Reason}", AntiSpamModerationStatuses.Unavailable, TimeSpan.Zero, runtimeModel);
        }

        var payload = new
        {
            contract_version = runtime.ContractVersion,
            request_id = request.RequestId,
            content_type = request.ContentType,
            text = request.Content,
            language = request.Locale,
            region_hint = request.RegionHint,
            threshold_profile = request.ThresholdProfile,
            max_evidence_items = 8,
            metadata = request.Metadata
        };
        byte[] requestBytes = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions);
        ValidateProviderRequestJson(requestBytes);
        Stopwatch stopwatch = Stopwatch.StartNew();
        using HttpClient client = httpClientFactory.CreateClient(nameof(AntiSpamModerationService));
        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, validatedEndpoint.Uri!)
        {
            Content = new ByteArrayContent(requestBytes)
        };
        httpRequest.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json")
        {
            CharSet = "utf-8"
        };
        using HttpResponseMessage response = await client.SendAsync(
            httpRequest,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            stopwatch.Stop();
            return BuildUnavailableResult(AntiSpamModerationProviders.HttpJson, $"http_{(int)response.StatusCode}", AntiSpamModerationStatuses.Unavailable, stopwatch.Elapsed, runtimeModel);
        }

        AntiSpamProviderResponseValidation responseValidation = ValidateHttpJsonProviderResponseHeaders(response);
        if (!responseValidation.Allowed)
        {
            stopwatch.Stop();
            return BuildUnavailableResult(AntiSpamModerationProviders.HttpJson, responseValidation.Reason, AntiSpamModerationStatuses.Unavailable, stopwatch.Elapsed, runtimeModel);
        }

        try
        {
            string json = await ReadProviderResponseJsonAsync(response.Content, cancellationToken).ConfigureAwait(false);
            stopwatch.Stop();
            return ValidateProviderResultJson(json, runtime.ContractVersion, AntiSpamModerationProviders.HttpJson, stopwatch.Elapsed);
        }
        catch (ProviderResponseTooLargeException ex)
        {
            stopwatch.Stop();
            logger.LogWarning(ex, "anti-spam provider response exceeded byte limit");
            return BuildUnavailableResult(AntiSpamModerationProviders.HttpJson, "provider_response_too_large", AntiSpamModerationStatuses.Unavailable, stopwatch.Elapsed, runtimeModel);
        }
        catch (InvalidOperationException ex)
        {
            stopwatch.Stop();
            logger.LogWarning(ex, "anti-spam provider contract invalid");
            return BuildUnavailableResult(AntiSpamModerationProviders.HttpJson, "provider_contract_invalid", AntiSpamModerationStatuses.ContractInvalid, stopwatch.Elapsed, runtimeModel);
        }
    }

    public static SocketsHttpHandler CreateHttpJsonProviderHandler()
        => new()
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
            ConnectTimeout = TimeSpan.FromSeconds(5),
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            ConnectCallback = ConnectToValidatedProviderEndpointAsync
        };

    private static async ValueTask<Stream> ConnectToValidatedProviderEndpointAsync(
        SocketsHttpConnectionContext context,
        CancellationToken cancellationToken)
    {
        IPAddress[] addresses;
        if (IPAddress.TryParse(context.DnsEndPoint.Host, out IPAddress? literalAddress))
        {
            addresses = [literalAddress];
        }
        else
        {
            addresses = await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, cancellationToken).ConfigureAwait(false);
        }

        var uriBuilder = new UriBuilder(Uri.UriSchemeHttps, context.DnsEndPoint.Host, context.DnsEndPoint.Port);
        AntiSpamProviderEndpointValidation validation = ValidateHttpJsonProviderResolvedAddresses(uriBuilder.Uri, addresses);
        if (!validation.Allowed)
        {
            throw new HttpRequestException($"anti-spam provider endpoint rejected at connect time: {validation.Reason}");
        }

        IPAddress address = addresses.First(static item => !IsPrivateOrReservedProviderAddress(item));
        var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp)
        {
            NoDelay = true
        };

        try
        {
            await socket.ConnectAsync(address, context.DnsEndPoint.Port, cancellationToken).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    internal static async Task<string> ReadProviderResponseJsonAsync(HttpContent content, CancellationToken cancellationToken)
    {
        await using Stream stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var buffer = new MemoryStream(capacity: (int)Math.Min(MaxHttpJsonProviderResponseBytes, 8192));
        byte[] chunk = new byte[8192];
        while (true)
        {
            int read = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            if (buffer.Length + read > MaxHttpJsonProviderResponseBytes)
            {
                throw new ProviderResponseTooLargeException();
            }

            buffer.Write(chunk, 0, read);
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    public static AntiSpamProviderEndpointValidation ValidateHttpJsonProviderEndpointConfiguration(string? endpoint, string? allowedHosts)
    {
        _ = TryBuildAllowedProviderHostSet(allowedHosts, out FrozenSet<string>? hostSet);
        return ValidateHttpJsonProviderEndpointConfiguration(endpoint, hostSet);
    }

    private static AntiSpamProviderEndpointValidation ValidateHttpJsonProviderEndpointConfiguration(
        string? endpoint,
        FrozenSet<string>? hostSet)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out Uri? uri) || string.IsNullOrWhiteSpace(uri.Host))
        {
            return AntiSpamProviderEndpointValidation.Deny("absolute_https_endpoint_required");
        }

        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                ? AntiSpamProviderEndpointValidation.Deny("https_required")
                : AntiSpamProviderEndpointValidation.Deny("absolute_https_endpoint_required");
        }

        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            return AntiSpamProviderEndpointValidation.Deny("endpoint_userinfo_not_allowed");
        }

        if (hostSet is null)
        {
            return AntiSpamProviderEndpointValidation.Deny("host_allowlist_missing");
        }

        string host = NormalizeProviderHost(uri.Host);
        if (!hostSet.Contains(host))
        {
            return AntiSpamProviderEndpointValidation.Deny("host_not_allowlisted", uri);
        }

        if (IPAddress.TryParse(host, out IPAddress? literalAddress) && IsPrivateOrReservedProviderAddress(literalAddress))
        {
            return AntiSpamProviderEndpointValidation.Deny("private_or_reserved_address", uri);
        }

        return AntiSpamProviderEndpointValidation.Allow(uri);
    }

    private static async Task<AntiSpamProviderEndpointValidation> ValidateHttpJsonEndpointAsync(
        string endpoint,
        string? allowedHosts,
        CancellationToken cancellationToken)
        => await ValidateHttpJsonEndpointAsync(endpoint, allowedHosts, allowedHostSet: null, cancellationToken).ConfigureAwait(false);

    private async Task<AntiSpamProviderEndpointValidation> GetOrValidateHttpJsonEndpointAsync(
        HttpJsonProviderRuntime runtime,
        CancellationToken cancellationToken)
    {
        var key = new HttpJsonEndpointCacheKey(
            runtime.Endpoint ?? string.Empty,
            runtime.AllowedHosts ?? string.Empty,
            runtime.RuntimeVersion);
        if (EndpointValidationCache.TryGetValue(key, out EndpointCacheEntry? cachedEndpoint)
            && cachedEndpoint.ExpiresAtUtc > DateTimeOffset.UtcNow)
        {
            return cachedEndpoint.Validation;
        }

        AntiSpamProviderEndpointValidation validation = await ValidateHttpJsonEndpointAsync(
            runtime.Endpoint ?? string.Empty,
            runtime.AllowedHosts,
            runtime.AllowedHostSet,
            cancellationToken).ConfigureAwait(false);
        DateTimeOffset expiresAtUtc = validation.Uri is { } uri && !IPAddress.TryParse(uri.Host, out _)
            ? DateTimeOffset.UtcNow.Add(DnsCacheTtl)
            : DateTimeOffset.MaxValue;
        EndpointValidationCache[key] = new EndpointCacheEntry(validation, expiresAtUtc);
        return validation;
    }

    private static async Task<AntiSpamProviderEndpointValidation> ValidateHttpJsonEndpointAsync(
        string endpoint,
        string? allowedHosts,
        FrozenSet<string>? allowedHostSet,
        CancellationToken cancellationToken)
    {
        _ = allowedHosts;
        AntiSpamProviderEndpointValidation configurationValidation = ValidateHttpJsonProviderEndpointConfiguration(endpoint, allowedHostSet);
        if (!configurationValidation.Allowed || configurationValidation.Uri is not { } uri)
        {
            return configurationValidation;
        }

        if (IPAddress.TryParse(uri.Host, out _))
        {
            return configurationValidation;
        }

        string dnsCacheKey = NormalizeProviderHost(uri.IdnHost);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        if (DnsValidationCache.TryGetValue(dnsCacheKey, out DnsCacheEntry? cachedDns)
            && cachedDns.ExpiresAtUtc > now)
        {
            return cachedDns.Validation.Allowed
                ? configurationValidation
                : AntiSpamProviderEndpointValidation.Deny(cachedDns.Validation.Reason, uri);
        }

        IPAddress[] addresses;
        try
        {
            addresses = await Dns.GetHostAddressesAsync(uri.IdnHost, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return AntiSpamProviderEndpointValidation.Deny("dns_resolution_failed", uri);
        }

        if (addresses.Length == 0)
        {
            return AntiSpamProviderEndpointValidation.Deny("dns_resolution_failed", uri);
        }

        AntiSpamProviderEndpointValidation addressValidation = ValidateHttpJsonProviderResolvedAddresses(uri, addresses);
        DnsValidationCache[dnsCacheKey] = new DnsCacheEntry(addressValidation, now.Add(DnsCacheTtl));
        return addressValidation.Allowed ? configurationValidation : addressValidation;
    }

    public static AntiSpamProviderEndpointValidation ValidateHttpJsonProviderResolvedAddresses(
        Uri uri,
        IReadOnlyCollection<IPAddress> addresses)
    {
        if (addresses.Count == 0)
        {
            return AntiSpamProviderEndpointValidation.Deny("dns_resolution_failed", uri);
        }

        return addresses.Any(IsPrivateOrReservedProviderAddress)
            ? AntiSpamProviderEndpointValidation.Deny("private_or_reserved_address", uri)
            : AntiSpamProviderEndpointValidation.Allow(uri);
    }

    public static AntiSpamProviderResponseValidation ValidateHttpJsonProviderResponseHeaders(HttpResponseMessage response)
    {
        MediaTypeHeaderValue? contentType = response.Content.Headers.ContentType;
        if (contentType is null || !IsJsonMediaType(contentType.MediaType))
        {
            return AntiSpamProviderResponseValidation.Deny("provider_content_type_invalid");
        }

        long? contentLength = response.Content.Headers.ContentLength;
        if (contentLength > MaxHttpJsonProviderResponseBytes)
        {
            return AntiSpamProviderResponseValidation.Deny("provider_response_too_large");
        }

        return AntiSpamProviderResponseValidation.Allow();
    }

    private static bool IsJsonMediaType(string? mediaType)
        => string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase)
            || (mediaType?.EndsWith("+json", StringComparison.OrdinalIgnoreCase) ?? false);

    private static bool TryBuildAllowedProviderHostSet(string? allowedHosts, out FrozenSet<string>? hostSet)
    {
        hostSet = null;
        if (string.IsNullOrWhiteSpace(allowedHosts))
        {
            return false;
        }

        string[] hosts = allowedHosts
            .Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(NormalizeProviderHost)
            .Where(static host => host.Length > 0 && host != "*")
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (hosts.Length == 0)
        {
            return false;
        }

        hostSet = hosts.ToFrozenSet(StringComparer.OrdinalIgnoreCase);
        return true;
    }

    private static string NormalizeProviderHost(string host)
        => host.Trim().TrimEnd('.').ToLowerInvariant();

    private static bool IsPrivateOrReservedProviderAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (IPAddress.IsLoopback(address)
            || IPAddress.Any.Equals(address)
            || IPAddress.None.Equals(address)
            || IPAddress.IPv6Any.Equals(address)
            || IPAddress.IPv6None.Equals(address))
        {
            return true;
        }

        byte[] bytes = address.GetAddressBytes();
        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            byte first = bytes[0];
            byte second = bytes[1];
            return first == 0
                || first == 10
                || first == 127
                || (first == 100 && second is >= 64 and <= 127)
                || (first == 169 && second == 254)
                || (first == 172 && second is >= 16 and <= 31)
                || (first == 192 && second == 168)
                || (first == 192 && second == 0)
                || (first == 192 && second == 2)
                || (first == 198 && second is 18 or 19)
                || (first == 198 && second == 51 && bytes[2] == 100)
                || (first == 203 && second == 0 && bytes[2] == 113)
                || first >= 224;
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            return address.Equals(IPAddress.IPv6Loopback)
                || bytes[0] == 0
                || (bytes[0] & 0xfe) == 0xfc
                || (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80)
                || bytes[0] == 0xff;
        }

        return true;
    }

    public sealed record AntiSpamProviderEndpointValidation(bool Allowed, string Reason, Uri? Uri)
    {
        public static AntiSpamProviderEndpointValidation Allow(Uri uri)
            => new(true, "ok", uri);

        public static AntiSpamProviderEndpointValidation Deny(string reason, Uri? uri = null)
            => new(false, reason, uri);
    }

    public sealed record AntiSpamProviderResponseValidation(bool Allowed, string Reason)
    {
        public static AntiSpamProviderResponseValidation Allow()
            => new(true, "ok");

        public static AntiSpamProviderResponseValidation Deny(string reason)
            => new(false, reason);
    }

    private sealed class ProviderResponseTooLargeException()
        : InvalidOperationException("anti-spam provider response exceeded the configured byte limit");

    private sealed record HttpJsonProviderRuntime(
        bool AllowExternal,
        bool Reviewed,
        string? Endpoint,
        string? AllowedHosts,
        FrozenSet<string>? AllowedHostSet,
        string ContractVersion,
        string RuntimeVersion);

    private readonly record struct HttpJsonEndpointCacheKey(
        string Endpoint,
        string AllowedHosts,
        string RuntimeVersion);

    private sealed record EndpointCacheEntry(
        AntiSpamProviderEndpointValidation Validation,
        DateTimeOffset ExpiresAtUtc);

    private sealed record DnsCacheEntry(
        AntiSpamProviderEndpointValidation Validation,
        DateTimeOffset ExpiresAtUtc);

    public static AntiSpamModerationResult ValidateProviderResultJson(
        string json,
        string expectedContractVersion,
        string fallbackProvider,
        TimeSpan latency)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;
        foreach (string forbidden in AntiSpamModerationContract.ForbiddenFinalActionFields)
        {
            if (root.TryGetProperty(forbidden, out _))
            {
                throw new InvalidOperationException($"provider response contains forbidden final action field: {forbidden}");
            }
        }

        ProviderResultDto? dto = JsonSerializer.Deserialize<ProviderResultDto>(json, JsonOptions);
        if (dto is null)
        {
            throw new InvalidOperationException("provider response is empty");
        }

        if (!string.Equals(dto.ContractVersion, expectedContractVersion, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("provider contract version mismatch");
        }

        if (!AllowedProviderStatuses.Contains(dto.Status ?? string.Empty)
            || !AllowedLabels.Contains(dto.Label ?? string.Empty)
            || !AllowedSeverity.Contains(dto.Severity ?? string.Empty)
            || dto.Confidence is < 0d or > 1d)
        {
            throw new InvalidOperationException("provider response label, severity, or confidence is invalid");
        }

        AntiSpamModerationCategorySignal[] categories = [.. (dto.Categories ?? [])
            .Select(static item => new AntiSpamModerationCategorySignal(item.Id ?? string.Empty, item.Confidence, item.Severity ?? string.Empty, item.EvidencePolicy ?? string.Empty))];
        if (categories.Any(static item => !AllowedCategories.Contains(item.Id)
            || !AllowedSeverity.Contains(item.Severity)
            || item.Confidence is < 0d or > 1d
            || item.EvidencePolicy is not ("show_full" or "show_category_only" or "redact")))
        {
            throw new InvalidOperationException("provider response category signal is invalid");
        }

        AntiSpamModerationEvidence[] evidence = [.. (dto.Evidence ?? [])
            .Select(static item => new AntiSpamModerationEvidence(item.Category ?? string.Empty, item.Policy ?? string.Empty, item.Value))];
        if (evidence.Any(static item => !AllowedCategories.Contains(item.Category)
            || item.Policy is not ("show_full" or "show_category_only" or "redact")))
        {
            throw new InvalidOperationException("provider response evidence is invalid");
        }

        return new AntiSpamModerationResult(
            true,
            string.IsNullOrWhiteSpace(dto.ProviderId) ? fallbackProvider : dto.ProviderId!,
            string.IsNullOrWhiteSpace(dto.ModelProfile) ? "unknown" : dto.ModelProfile!,
            dto.ContractVersion!,
            dto.Label!,
            dto.Confidence,
            dto.Severity!,
            dto.PrimaryReason,
            dto.NeedsSecondRound,
            categories,
            evidence,
            dto.PrimaryReason,
            latency,
            AntiSpamModerationStatuses.Ok,
            null,
            dto.ThresholdProfile,
            SanitizeProviderMetadata(dto.Metadata ?? new Dictionary<string, string>(StringComparer.Ordinal)));
    }

    private static IReadOnlyDictionary<string, string> SanitizeProviderMetadata(IReadOnlyDictionary<string, string> metadata)
    {
        if (metadata.Count == 0)
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }

        var sanitized = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach ((string key, string value) in metadata)
        {
            string normalizedKey = NormalizeMetadataKey(key);
            if (string.IsNullOrWhiteSpace(normalizedKey) || IsForbiddenProviderMetadataKey(normalizedKey))
            {
                continue;
            }

            if (!string.IsNullOrWhiteSpace(value))
            {
                sanitized[normalizedKey] = value.Trim();
            }
        }

        return sanitized;
    }

    private static bool IsForbiddenProviderMetadataKey(string normalizedKey)
        => ForbiddenProviderMetadataKeys.Any(forbidden =>
            string.Equals(normalizedKey, forbidden, StringComparison.Ordinal)
            || normalizedKey.Contains(forbidden, StringComparison.Ordinal));

    private static string NormalizeMetadataKey(string key)
        => key.Trim().ToLowerInvariant().Replace('-', '_');

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
            PrimaryReason = NormalizeNullable(result.PrimaryReason, 128),
            NeedsSecondRound = result.NeedsSecondRound,
            RiskCategories = result.Categories.Count == 0 ? null : string.Join(',', result.Categories.Select(static item => item.Id).Distinct(StringComparer.Ordinal)),
            EvidenceJson = result.Evidence.Count == 0 ? null : JsonSerializer.Serialize(result.Evidence, JsonOptions),
            RawReason = NormalizeNullable(result.RawReason, 4_096),
            LatencyMs = Math.Max(0, RoundingHelper.RoundToInt(result.Latency.TotalMilliseconds)),
            Status = Normalize(result.Status, 32),
            ErrorCode = NormalizeNullable(result.ErrorCode, 64),
            ThresholdProfile = NormalizeNullable(result.ThresholdProfile, 128),
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
        string provider,
        string errorCode,
        string status,
        TimeSpan latency,
        ModerationModelRuntimeSnapshot? runtimeModel = null)
        => new(
            false,
            provider,
            "unavailable",
            ResolveContractVersion(runtimeModel),
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
            runtimeModel?.ThresholdProfile ?? configuration["Moderation:AntiSpamModel:ThresholdProfile"],
            new Dictionary<string, string>(StringComparer.Ordinal));

    private string ResolveContractVersion(ModerationModelRuntimeSnapshot? runtimeModel = null)
        => runtimeModel?.ContractVersion
            ?? configuration["Moderation:AntiSpamModel:ContractVersion"]
            ?? AntiSpamModerationContract.DefaultVersion;

    private static string NormalizeProvider(string? provider)
        => (provider ?? AntiSpamModerationProviders.None).Trim().ToLowerInvariant() switch
        {
            "" => AntiSpamModerationProviders.None,
            "mock" => AntiSpamModerationProviders.Mock,
            "http" or "http-json" => AntiSpamModerationProviders.HttpJson,
            "cli" or "fsus-cli" or "cli-json" => AntiSpamModerationProviders.FsusCli,
            "none" or "disabled" => AntiSpamModerationProviders.None,
            var value => value
        };

    private static string Normalize(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static string? NormalizeNullable(string? value, int maxLength)
    {
        string normalized = Normalize(value, maxLength);
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private sealed class ProviderResultDto
    {
        [JsonPropertyName("contract_version")]
        public string? ContractVersion { get; set; }

        [JsonPropertyName("provider_id")]
        public string? ProviderId { get; set; }

        [JsonPropertyName("model_profile")]
        public string? ModelProfile { get; set; }

        [JsonPropertyName("threshold_profile")]
        public string? ThresholdProfile { get; set; }

        [JsonPropertyName("status")]
        public string? Status { get; set; }

        [JsonPropertyName("label")]
        public string? Label { get; set; }

        [JsonPropertyName("confidence")]
        public double Confidence { get; set; }

        [JsonPropertyName("severity")]
        public string? Severity { get; set; }

        [JsonPropertyName("primary_reason")]
        public string? PrimaryReason { get; set; }

        [JsonPropertyName("needs_second_round")]
        public bool NeedsSecondRound { get; set; }

        [JsonPropertyName("categories")]
        public ProviderCategoryDto[]? Categories { get; set; }

        [JsonPropertyName("evidence")]
        public ProviderEvidenceDto[]? Evidence { get; set; }

        [JsonPropertyName("metadata")]
        public Dictionary<string, string>? Metadata { get; set; }
    }

    private sealed class ProviderCategoryDto
    {
        [JsonPropertyName("id")]
        public string? Id { get; set; }

        [JsonPropertyName("confidence")]
        public double Confidence { get; set; }

        [JsonPropertyName("severity")]
        public string? Severity { get; set; }

        [JsonPropertyName("evidence_policy")]
        public string? EvidencePolicy { get; set; }
    }

    private sealed class ProviderEvidenceDto
    {
        [JsonPropertyName("category")]
        public string? Category { get; set; }

        [JsonPropertyName("policy")]
        public string? Policy { get; set; }

        [JsonPropertyName("value")]
        public string? Value { get; set; }
    }
}
