using System.Text.Json;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AntiSpamModerationServiceTests
{
    [Theory]
    [InlineData("http://moderation.example.com/v1/score", "moderation.example.com", "https_required")]
    [InlineData("file:///etc/passwd", "moderation.example.com", "absolute_https_endpoint_required")]
    [InlineData("https://moderation.example.com/v1/score", "other.example.com", "host_not_allowlisted")]
    [InlineData("https://127.0.0.1/v1/score", "127.0.0.1", "private_or_reserved_address")]
    [InlineData("https://169.254.169.254/latest/meta-data/", "169.254.169.254", "private_or_reserved_address")]
    [InlineData("https://10.0.0.5/v1/score", "10.0.0.5", "private_or_reserved_address")]
    public void ValidateHttpJsonProviderEndpointConfiguration_RejectsUnsafeEndpoint(
        string endpoint,
        string allowedHosts,
        string expectedReason)
    {
        var result = AntiSpamModerationService.ValidateHttpJsonProviderEndpointConfiguration(endpoint, allowedHosts);

        Assert.False(result.Allowed);
        Assert.Equal(expectedReason, result.Reason);
    }

    [Fact]
    public void ValidateHttpJsonProviderEndpointConfiguration_AcceptsHttpsAllowlistedPublicEndpoint()
    {
        var result = AntiSpamModerationService.ValidateHttpJsonProviderEndpointConfiguration(
            "https://8.8.8.8/v1/moderation/score",
            "8.8.8.8;moderation.example.com");

        Assert.True(result.Allowed);
        Assert.Equal("8.8.8.8", result.Uri?.Host);
    }

    [Fact]
    public void ScoreHttpJsonAsync_SourceValidatesEndpointBeforePosting()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Moderation/AntiSpamModerationService.cs");
        string method = source[
            source.IndexOf("private async Task<AntiSpamModerationResult> ScoreHttpJsonAsync", StringComparison.Ordinal)..
            source.IndexOf("public static AntiSpamModerationResult ValidateProviderResultJson", StringComparison.Ordinal)];

        Assert.Contains("ValidateHttpJsonEndpointAsync", method, StringComparison.Ordinal);
        Assert.Contains("validatedEndpoint.Uri!", method, StringComparison.Ordinal);
        Assert.Contains("HttpCompletionOption.ResponseHeadersRead", method, StringComparison.Ordinal);
        Assert.Contains("ValidateHttpJsonProviderResponseHeaders(response)", method, StringComparison.Ordinal);
        Assert.Contains("ReadProviderResponseJsonAsync(response.Content", method, StringComparison.Ordinal);
        Assert.True(
            method.IndexOf("ValidateHttpJsonEndpointAsync", StringComparison.Ordinal) <
            method.IndexOf("SendAsync", StringComparison.Ordinal));
        Assert.DoesNotContain("PostAsJsonAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadAsStringAsync", method, StringComparison.Ordinal);
    }

    [Fact]
    public void ServiceCollection_RegistersDedicatedAntiSpamHttpClientWithoutRedirects()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs");
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Moderation/AntiSpamModerationService.cs");

        Assert.Contains("AddHttpClient(nameof(AntiSpamModerationService))", source, StringComparison.Ordinal);
        Assert.Contains("CreateHttpJsonProviderHandler", source, StringComparison.Ordinal);
        Assert.Contains("AllowAutoRedirect = false", service, StringComparison.Ordinal);
        Assert.Contains("ConnectCallback", service, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateHttpJsonProviderResolvedAddresses_RejectsConnectionTimePrivateAddress()
    {
        var uri = new Uri("https://moderation.example.com/v1/score");

        AntiSpamModerationService.AntiSpamProviderEndpointValidation result =
            AntiSpamModerationService.ValidateHttpJsonProviderResolvedAddresses(
                uri,
                [IPAddress.Parse("10.0.0.5")]);

        Assert.False(result.Allowed);
        Assert.Equal("private_or_reserved_address", result.Reason);
    }

    [Fact]
    public void ValidateHttpJsonProviderResponseHeaders_RejectsOversizedContentLength()
    {
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json")
        };
        response.Content.Headers.ContentLength = AntiSpamModerationService.MaxHttpJsonProviderResponseBytes + 1;

        AntiSpamModerationService.AntiSpamProviderResponseValidation result =
            AntiSpamModerationService.ValidateHttpJsonProviderResponseHeaders(response);

        Assert.False(result.Allowed);
        Assert.Equal("provider_response_too_large", result.Reason);
    }

    [Fact]
    public void ValidateHttpJsonProviderResponseHeaders_RejectsNonJsonContentType()
    {
        using var response = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent([])
        };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue("text/html");

        AntiSpamModerationService.AntiSpamProviderResponseValidation result =
            AntiSpamModerationService.ValidateHttpJsonProviderResponseHeaders(response);

        Assert.False(result.Allowed);
        Assert.Equal("provider_content_type_invalid", result.Reason);
    }

    [Fact]
    public async Task ReadProviderResponseJsonAsync_RejectsChunkedResponseOverByteLimit()
    {
        byte[] oversized = new byte[AntiSpamModerationService.MaxHttpJsonProviderResponseBytes + 1];
        Array.Fill(oversized, (byte)' ');
        using var content = new StreamContent(new MemoryStream(oversized));
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");

        var ex = await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            AntiSpamModerationService.ReadProviderResponseJsonAsync(content, CancellationToken.None));

        Assert.Contains("byte limit", ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ValidateProviderResultJson_RejectsFinalActionFields()
    {
        string json = """
            {
              "contract_version": "fsusblog-moderation-provider-v1",
              "request_id": "comment:1",
              "provider_id": "mock",
              "model_profile": "mock-v1",
              "status": "scored",
              "label": "risky",
              "confidence": 0.9,
              "severity": "high",
              "categories": [],
              "blocked_regions": ["CN-MAINLAND"]
            }
            """;

        Assert.Throws<InvalidOperationException>(() =>
            AntiSpamModerationService.ValidateProviderResultJson(json, "fsusblog-moderation-provider-v1", "mock", TimeSpan.Zero));
    }

    [Fact]
    public void ValidateProviderResultJson_AcceptsRiskSignalOnlyPayload()
    {
        string json = """
            {
              "contract_version": "fsusblog-moderation-provider-v1",
              "request_id": "comment:1",
              "provider_id": "mock",
              "model_profile": "mock-v1",
              "threshold_profile": "default",
              "status": "scored",
              "label": "risky",
              "confidence": 0.91,
              "severity": "high",
              "primary_reason": "spam_repeat",
              "categories": [
                {
                  "id": "spam_repeat",
                  "confidence": 0.91,
                  "severity": "high",
                  "evidence_policy": "show_category_only"
                }
              ],
              "needs_second_round": true,
              "evidence": []
            }
            """;

        var result = AntiSpamModerationService.ValidateProviderResultJson(json, "fsusblog-moderation-provider-v1", "mock", TimeSpan.FromMilliseconds(3));

        Assert.True(result.Available);
        Assert.Equal("mock", result.Provider);
        Assert.Equal("risky", result.Label);
        Assert.Equal("spam_repeat", result.Categories[0].Id);
    }

    [Theory]
    [InlineData("userId")]
    [InlineData("username")]
    [InlineData("email")]
    [InlineData("ip")]
    [InlineData("authorId")]
    [InlineData("replyToUserId")]
    public void ValidateProviderRequestJson_RejectsLegacyIdentityFields(string forbiddenField)
    {
        string json = $$"""
            {
              "contract_version": "fsusblog-moderation-provider-v1",
              "request_id": "comment:1",
              "content_type": "comment",
              "text": "normal comment",
              "metadata": {
                "source": "fsusblog",
                "{{forbiddenField}}": "legacy-value"
              }
            }
            """;

        var ex = Assert.Throws<InvalidOperationException>(() =>
            AntiSpamModerationService.ValidateProviderRequestJson(json));
        Assert.Contains(forbiddenField, ex.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ModerationProviderRequestSchema_DocumentsForbiddenIdentityFields()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "schemas/moderation/model-provider-request.schema.json"));

        Assert.Contains("\"not\"", source, StringComparison.Ordinal);
        Assert.Contains("userId", source, StringComparison.Ordinal);
        Assert.Contains("replyToUserId", source, StringComparison.Ordinal);
        Assert.Contains("anonymous_nullifier_hash", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ModerationProviderManifestSchema_AllowsMainlineAndAuditOnlyButRejectsLegacyProduction()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "schemas/moderation/model-provider-manifest.schema.json"));
        using JsonDocument document = JsonDocument.Parse(source);
        string serialized = document.RootElement.GetRawText();

        Assert.Contains("mainline-release", serialized, StringComparison.Ordinal);
        Assert.Contains("audit-only", serialized, StringComparison.Ordinal);
        Assert.Contains("legacy/python", serialized, StringComparison.Ordinal);
        Assert.Contains("\"not\"", serialized, StringComparison.Ordinal);
    }

    [Fact]
    public void SchemaMigrationRegistry_CreatesCommentModerationSignalTableAndIndexes()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs"));

        Assert.Contains("comment_moderation_signal", source);
        Assert.Contains("idx_comment_moderation_signal_comment_id", source);
        Assert.Contains("idx_comment_moderation_signal_label_confidence", source);
        Assert.Contains("idx_comment_moderation_signal_second_round", source);
        Assert.Contains("BuildCommentModerationSignalMigration()", source);
    }
}
