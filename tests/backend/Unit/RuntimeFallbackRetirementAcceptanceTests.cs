using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Subscriptions;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeFallbackRetirementAcceptanceTests
{
    [Fact]
    public void A3_1_UploadCleanupHasNoLegacySessionRootSweep()
    {
        string runtime = RuntimeMetadataInspection.DescribeType(typeof(FileService));
        MethodInfo cleanup = typeof(FileService).GetMethod("CleanupExpiredSessionsAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        MethodBase[] directCalls = ReadCalledMethods(AsyncMoveNext(cleanup)).ToArray();

        Assert.DoesNotContain("CleanupLegacySessionRootSweepAsync", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain(directCalls, static method =>
            method.DeclaringType == typeof(Directory) && method.Name == nameof(Directory.EnumerateDirectories));
        Assert.Contains(directCalls, static method => method.Name == "EnumerateExpiredExpirationBuckets");
    }

    [Fact]
    public void A3_2_SubscriptionRuntimeUsesOnlyCurrentHmacIdentity()
    {
        const string NormalizedEmail = "reader@example.com";
        const string Pepper = "runtime-fallback-retirement-test-pepper-32-bytes-minimum";
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [SiteSubscriptionIdentity.EmailHashPepperConfigurationKey] = Pepper
            })
            .Build();
        string endpointRuntime = RuntimeMetadataInspection.DescribeType(typeof(SubscriptionEndpoints));
        string hash = SiteSubscriptionIdentity.HashEmail(NormalizedEmail, configuration);
        string expected = Convert.ToHexStringLower(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(Pepper),
            Encoding.UTF8.GetBytes(NormalizedEmail)));
        string legacy = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(NormalizedEmail)));

        Assert.Equal("hmac-v1", SiteSubscriptionIdentity.CurrentHashVersion);
        Assert.Equal(expected, hash);
        Assert.NotEqual(legacy, hash);
        Assert.DoesNotContain("LegacySha256EmailHash", endpointRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("legacy_email_hash", endpointRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("sha256-legacy", endpointRuntime, StringComparison.Ordinal);

        ISchemaMigrationDescriptor migration = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static descriptor => descriptor.MigrationId == "20260709-post-site-subscription-hmac-finalize");
        string fingerprint = string.Join('\n', migration.Steps.Select(static step => step.Fingerprint));
        Assert.Contains("ALTER COLUMN hash_version SET DEFAULT 'hmac-v1'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("WHERE hash_version = 'sha256-legacy'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("SELECT COUNT(*)", fingerprint, StringComparison.Ordinal);
    }

    [Fact]
    public void A3_3_ArticleReadersHaveNoLegacyContentColumnFallback()
    {
        (Type Type, bool UsesQueryableBody)[] readers =
        [
            (typeof(ArticleService), false),
            (typeof(PublicHotArtifactProjector), true),
            (typeof(ArticleDetailAedsArtifactMaintenanceService), false)
        ];

        foreach ((Type type, bool usesQueryableBody) in readers)
        {
            string runtime = RuntimeMetadataInspection.DescribeType(type);
            Assert.DoesNotContain("LegacyArticleContentColumnExistsAsync", runtime, StringComparison.Ordinal);
            Assert.DoesNotContain("s_legacyArticleContentColumnState", runtime, StringComparison.Ordinal);
            Assert.DoesNotContain("a.content", runtime, StringComparison.Ordinal);
            if (usesQueryableBody)
            {
                Assert.Contains("ArticleBody", runtime, StringComparison.Ordinal);
                Assert.Contains("MarkdownContent", runtime, StringComparison.Ordinal);
            }
            else
            {
                Assert.Contains("article_body", runtime, StringComparison.Ordinal);
                Assert.Contains("markdown_content", runtime, StringComparison.Ordinal);
            }
        }
    }

    [Fact]
    public void A3_4_LegacyPlainCookieSwitchCannotRestoreFallback()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AuthCookies:AllowLegacyPlainCookieRead"] = "true"
            })
            .Build();
        var service = new AuthCookieService(configuration, new FakeWebHostEnvironment(Environments.Production));
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = string.Join("; ",
        [
            "AccessToken=plain-access",
            "RefreshToken=plain-refresh",
            "SessionId=plain-session",
            "AdminAccessToken=plain-admin"
        ]);

        Assert.Null(service.ReadAccessToken(context));
        Assert.Null(service.ReadRefreshToken(context));
        Assert.Null(service.ReadSessionId(context));
        Assert.False(service.TryReadAdminAccessToken(context, out _));

        string cookieRuntime = RuntimeMetadataInspection.DescribeType(typeof(AuthCookieService));
        string validatorRuntime = RuntimeMetadataInspection.DescribeType(typeof(ProductionStartupValidator));
        Assert.DoesNotContain("AllowLegacyPlainCookieRead", cookieRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("ShouldAllowLegacyPlainCookieRead", cookieRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("allowPlainFallback", cookieRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("AllowLegacyPlainCookieRead", validatorRuntime, StringComparison.Ordinal);
    }

    [Fact]
    public void A3_7_PublicAotAcceptsOnlyCanonicalHexSidecarHash()
    {
        string path = Path.Combine(Path.GetTempPath(), $"fsus-sidecar-{Guid.NewGuid():N}.bin");
        byte[] payload = [1, 2, 3, 4];
        File.WriteAllBytes(path, payload);
        try
        {
            MethodInfo validate = typeof(PublicAotFileShellCache).GetMethod(
                "IsHydrationSidecarHashValid",
                BindingFlags.NonPublic | BindingFlags.Static)!;
            string canonical = Convert.ToHexStringLower(SHA256.HashData(payload));
            string legacy = Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlEncode(SHA256.HashData(payload));
            var canonicalReference = new PublicAotHydrationSidecarReference("/payload", canonical, "payload");
            var legacyReference = new PublicAotHydrationSidecarReference("/payload", legacy, "payload");

            Assert.True((bool)validate.Invoke(null, [path, canonicalReference])!);
            Assert.False((bool)validate.Invoke(null, [path, legacyReference])!);
            string runtime = RuntimeMetadataInspection.DescribeMethods(typeof(PublicAotFileShellCache), "IsHydrationSidecarHashValid");
            Assert.DoesNotContain("MatchesLegacyBase64UrlPayloadHash", runtime, StringComparison.Ordinal);
            Assert.DoesNotContain("Base64Url", runtime, StringComparison.Ordinal);
            Assert.Contains("MatchesHash", runtime, StringComparison.Ordinal);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void A3_8_LegacyArtifactClearIsOneTimeMigrationNotAdminRuntimeAction()
    {
        ISchemaMigrationDescriptor migration = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static descriptor => descriptor.MigrationId == "20260709-post-clear-legacy-public-artifacts");
        Assert.Contains(migration.Steps, static step => step is ClearLegacyPublicArtifactsStep);

        string runner = RuntimeMetadataInspection.DescribeMethods(typeof(SchemaMigrationRunner), "ExecuteStepAsync");
        string actionMethod = RuntimeMetadataInspection.DescribeMethods(typeof(AdminOperationsService), nameof(AdminOperationsService.RunCacheActionAsync));
        Assert.Contains("ClearLegacyPublicArtifactsStep", runner, StringComparison.Ordinal);
        Assert.Contains("ClearLegacyPublicArtifactsAsync", runner, StringComparison.Ordinal);
        Assert.DoesNotContain("clear-legacy-public-artifacts", actionMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("ClearLegacyPublicArtifactsAsync", actionMethod, StringComparison.Ordinal);
    }

    [Fact]
    public void MilestoneManifest_RecordsCodeRetirementWithoutInventingExternalVerification()
    {
        IConfiguration manifest = new ConfigurationBuilder()
            .SetBasePath(BackendTestPaths.FromRoot("tests", "backend"))
            .AddJsonFile("issue-1013-runtime-fallback-milestones.json", optional: false, reloadOnChange: false)
            .Build();

        Assert.Equal("fsusblog.issue-1013.runtime-fallback-milestones.v1", manifest["schema"]);
        Assert.Equal("implementation-only-not-verified", manifest["status"]);
        IConfigurationSection[] items = manifest.GetSection("items").GetChildren().ToArray();
        Assert.Equal(6, items.Length);
        Assert.All(items, item =>
        {
            Assert.Equal("retired", item["codeState"]);
            Assert.Equal("deferred-unverified", item["milestoneEvidence:status"]);
            Assert.Null(item["milestoneEvidence:verificationRunId"]);
        });
    }

    private static MethodInfo AsyncMoveNext(MethodInfo method)
    {
        AsyncStateMachineAttribute stateMachine = method.GetCustomAttribute<AsyncStateMachineAttribute>()
            ?? throw new InvalidOperationException($"Async state machine missing: {method.Name}");
        return stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)!;
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
                continue;
            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(BitConverter.ToInt32(il, offset + 1));
            }
            catch (ArgumentException)
            {
            }
            if (called is not null)
                yield return called;
        }
    }

    private sealed class FakeWebHostEnvironment(string environmentName) : IWebHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;
        public string ApplicationName { get; set; } = "RuntimeFallbackRetirementTests";
        public string WebRootPath { get; set; } = string.Empty;
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = string.Empty;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
