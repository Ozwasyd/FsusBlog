using System.Reflection;

using Fido2NetLib;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorizationAccessControlHardeningTests
{
    [Fact]
    public void ApplicationPipeline_RegistersAntiforgeryAndCsrfOriginGuard()
    {
        string dataRoot = Path.Combine(Path.GetTempPath(), $"fsus-foundation-{Guid.NewGuid():N}");
        try
        {
            IConfiguration configuration = ValidFoundationConfiguration(dataRoot);
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddFsusApiFoundation(configuration);
            using ServiceProvider provider = services.BuildServiceProvider();
            AntiforgeryOptions antiforgery = provider.GetRequiredService<IOptions<AntiforgeryOptions>>().Value;
            Assert.Equal("X-Fsus-Csrf-Token", antiforgery.HeaderName);

            string[] stages = [.. WebApplicationCompositionExtensions.EndpointPipelineStageIds];
            Assert.Contains("antiforgery", stages);
            Assert.Contains("csrf-origin-guard", stages);
            Assert.True(Array.IndexOf(stages, "cors") < Array.IndexOf(stages, "csrf-origin-guard"));
            Assert.True(Array.IndexOf(stages, "csrf-origin-guard") < Array.IndexOf(stages, "authorization"));
        }
        finally
        {
            if (Directory.Exists(dataRoot))
            {
                Directory.Delete(dataRoot, recursive: true);
            }
        }
    }

    [Fact]
    public void LocalAuthFixture_RuntimeRequiresDevelopmentSecretAndLoopbackAndFailsClosedInProduction()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(LocalAuthFixtureEndpoints));
        Assert.Contains("IsDevelopment", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("RequireLocalFixtureSecret", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("RequireLoopbackCaller", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("IPAddress.IsLoopback", runtimeShape, StringComparison.Ordinal);

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["fsus:allowLocalAuthFixture"] = "true"
            })
            .Build();

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, enforceProductionRules: true);
        Assert.Contains(errors, static error => error.Contains("fsus:allowLocalAuthFixture", StringComparison.Ordinal));
    }

    [Fact]
    public void AccountProfilePreferenceFixture_IsDevelopmentSecretLoopbackOnly_AndFailsClosedInProduction()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(
            typeof(LocalAccountProfilePreferenceFixtureEndpoints));
        Assert.Contains("IsDevelopment", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("RequireSecret", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("RequireLoopback", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("IPAddress.IsLoopback", runtimeShape, StringComparison.Ordinal);

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["fsus:allowAccountProfilePreferenceFixture"] = "true"
            })
            .Build();

        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(
            configuration,
            enforceProductionRules: true);
        Assert.Contains(errors, static error => error.Contains(
            "fsus:allowAccountProfilePreferenceFixture",
            StringComparison.Ordinal));
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task UploadSessionOperations_UseOwnerBoundAccessWithoutEndpointPrevalidation()
    {
        FieldInfo uploadTokenHeader = typeof(BinaryEndpoints).GetField(
            "UploadTokenHeader",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        Assert.Equal("X-Fsus-Upload-Token", uploadTokenHeader.GetRawConstantValue());
        Assert.NotNull(typeof(UploadInitDto).GetProperty(nameof(UploadInitDto.UploadToken)));
        Type uploadSessionRecord = typeof(UploadInitRequestDto).Assembly.GetType("FsusBlog.Server.Models.Dtos.UploadSessionRecord")!;
        Assert.NotNull(uploadSessionRecord.GetProperty("OwnerAdminPrincipalId"));
        Assert.NotNull(uploadSessionRecord.GetProperty("UploadTokenSha256"));
        Assert.Null(uploadSessionRecord.GetProperty("UploadToken"));

        string fileService = RuntimeMetadataInspection.DescribeMethods(
            typeof(FileService),
            "CreateUploadSessionToken",
            "LoadAuthorizedSessionAsync");
        Assert.Contains("CreateUploadSessionToken", fileService, StringComparison.Ordinal);
        Assert.Contains("LoadAuthorizedSessionAsync", fileService, StringComparison.Ordinal);

        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint part = EndpointContractApplication.Find(app, "/api/binary/upload/{uploadId}/part", HttpMethods.Put);
        RouteEndpoint complete = EndpointContractApplication.Find(app, "/api/binary/upload/{uploadId}/complete", HttpMethods.Post);
        Assert.All(new[] { part, complete }, endpoint =>
            Assert.DoesNotContain(endpoint.Metadata, static metadata =>
                metadata is IAntiforgeryMetadata { RequiresValidation: false }));

        string partHandler = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            nameof(BinaryEndpoints.HandleUploadPartAsync));
        string completeHandler = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(BinaryEndpoints),
            "CreateUploadAccess",
            "CompleteUploadAsync");
        Assert.Contains("CreateUploadAccess", partHandler, StringComparison.Ordinal);
        Assert.Contains("CreateUploadAccess", completeHandler, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PublicNavigationSnapshot_IsRateLimitedAndLengthBound()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        await using WebApplication app = builder.Build();
        app.MapPublicAotEndpoints();
        RouteEndpoint endpoint = EndpointContractApplication.Find(
            app,
            "/api/public/navigation-snapshot.aeds",
            HttpMethods.Get);
        Assert.Equal(
            "public_read",
            Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);

        var source = new DefaultHttpContext();
        Assert.True(PublicAotEndpoints.TryCreateNavigationSnapshotTargetContext(
            source,
            "/",
            out DefaultHttpContext validTarget,
            out string validError,
            new PublicAotRouteIdentity(new PublicAotRouteRegistry())));
        Assert.Equal(PathString.FromUriComponent("/"), validTarget.Request.Path);
        Assert.Empty(validError);

        Assert.False(PublicAotEndpoints.TryCreateNavigationSnapshotTargetContext(
            source,
            new string('x', 513),
            out _,
            out string rawLengthError,
            new PublicAotRouteIdentity(new PublicAotRouteRegistry())));
        Assert.Equal("public_navigation_snapshot_path_invalid", rawLengthError);

        string paddedOverLimit = string.Concat(' ', new string('/', 512), ' ');
        Assert.False(PublicAotEndpoints.TryCreateNavigationSnapshotTargetContext(
            source,
            paddedOverLimit,
            out _,
            out string normalizedLengthError,
            new PublicAotRouteIdentity(new PublicAotRouteRegistry())));
        Assert.Equal("public_navigation_snapshot_path_invalid", normalizedLengthError);
    }

    [Fact]
    public async Task NotificationStreamDrill_RequiresSignedTimestampedNonce()
    {
        const string Secret = "notification-drill-secret";
        const string Body = "{\"count\":1}";
        string timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture);
        const string Nonce = "0123456789abcdef";
        Type endpoints = typeof(NotificationStreamDrillEndpoints);
        string timestampHeader = GetPrivateConstant<string>(endpoints, "DrillTimestampHeader");
        string nonceHeader = GetPrivateConstant<string>(endpoints, "DrillNonceHeader");
        string signatureHeader = GetPrivateConstant<string>(endpoints, "DrillSignatureHeader");
        string secretHeader = GetPrivateConstant<string>(endpoints, "DrillSecretHeader");
        MethodInfo computeSignature = endpoints.GetMethod(
            "ComputeDrillSignature",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        string signature = (string)computeSignature.Invoke(null, [Secret, timestamp, Nonce, Body])!;
        var context = new DefaultHttpContext();
        context.Request.Headers[secretHeader] = Secret;
        context.Request.Headers[timestampHeader] = timestamp;
        context.Request.Headers[nonceHeader] = Nonce;
        context.Request.Headers[signatureHeader] = signature;
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.TryAcquireLeaseAsync(
                CachePolicyId.NotificationStreamDrillNonce,
                Arg.Any<string>(),
                "1",
                TimeSpan.FromSeconds(60),
                Arg.Any<CancellationToken>())
            .Returns(true);

        MethodInfo validate = endpoints.GetMethod(
            "ValidateSignedDrillRequestAsync",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        bool accepted = await (Task<bool>)validate.Invoke(
            null,
            [context, cache, Secret, Body, CancellationToken.None])!;

        Assert.True(accepted);
        await cache.Received(1).TryAcquireLeaseAsync(
            CachePolicyId.NotificationStreamDrillNonce,
            $"{timestamp}:{Nonce}",
            "1",
            TimeSpan.FromSeconds(60),
            CancellationToken.None);

        context.Request.Headers[signatureHeader] = "invalid";
        Assert.False(await (Task<bool>)validate.Invoke(
            null,
            [context, cache, Secret, Body, CancellationToken.None])!);

        string publish = RuntimeMetadataInspection.DescribeMethods(endpoints, "PublishAsync");
        Assert.Contains("ReadRequestBodyAsync", publish, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadFromJsonAsync", publish, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminSessionRevoke_VerifiesSessionOwnershipBeforeMutation()
    {
        IReadOnlyList<string> references = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferencesInOrderContaining(
                typeof(BinaryEndpoints),
                nameof(IAdminPrincipalService.EnsureAdminSessionBelongsToPrincipalAsync),
                nameof(IAdminPrincipalService.RevokeAdminSessionAsync));
        int ownershipCheck = FindReference(references, nameof(IAdminPrincipalService.EnsureAdminSessionBelongsToPrincipalAsync));
        int revokeMutation = FindReference(references, nameof(IAdminPrincipalService.RevokeAdminSessionAsync));
        Assert.True(ownershipCheck < revokeMutation);

        MethodInfo ownershipContract = typeof(IAdminPrincipalService).GetMethod(
            nameof(IAdminPrincipalService.EnsureAdminSessionBelongsToPrincipalAsync))!;
        Assert.Equal(typeof(Task<bool>), ownershipContract.ReturnType);
    }

    [Fact]
    public void DistributionFeeds_VaryByEncodingCountryAndRegion()
    {
        const string Expected = "Accept-Encoding, CF-IPCountry, X-Fsus-Region";
        Assert.Equal(Expected, GetPrivateConstant<string>(typeof(DistributionEndpoints), "DistributionVaryHeader"));
        var context = new DefaultHttpContext();
        MethodInfo buildResult = typeof(DistributionEndpoints).GetMethod(
            "BuildCachedTextResult",
            BindingFlags.Static | BindingFlags.NonPublic)!;

        IResult result = (IResult)buildResult.Invoke(null, [context, "body", "text/plain"])!;

        Assert.NotNull(result);
        Assert.Equal(Expected, context.Response.Headers.Vary.ToString());
        Assert.Equal("public, max-age=60, stale-while-revalidate=300", context.Response.Headers.CacheControl.ToString());
    }

    [Fact]
    public async Task AdminSensitiveStepUp_RequiresTrustedOriginAndShortSingleUseProof()
    {
        foreach (Type endpointType in new[] { typeof(BinaryEndpoints), typeof(AuthoringEndpoints), typeof(SecurityEndpoints) })
        {
            string stepUp = RuntimeMetadataInspection.DescribeMethods(
                endpointType,
                "RequireAdminSensitiveStepUpAsync");
            Assert.Contains("TrustedRequestOrigin.RequireTrustedOriginOrReferer", stepUp, StringComparison.Ordinal);
        }

        TimeSpan proofTtl = (TimeSpan)typeof(AdminPrincipalService)
            .GetField("s_stepUpProofTtl", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetValue(null)!;
        Assert.Equal(TimeSpan.FromSeconds(45), proofTtl);
        Assert.NotEqual(TimeSpan.FromMinutes(5), proofTtl);

        IReadOnlyList<string> completionReferences = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferencesInOrderContaining(
                typeof(AdminPrincipalService),
                "s_stepUpProofTtl",
                nameof(AdminPrincipalService.CreateAdminStepUpProofTokenAsync));
        Assert.True(
            FindReference(completionReferences, "s_stepUpProofTtl") <
            FindReference(completionReferences, nameof(AdminPrincipalService.CreateAdminStepUpProofTokenAsync)));

        string consume = RuntimeMetadataInspection.DescribeMethods(
            typeof(AdminPrincipalService),
            nameof(AdminPrincipalService.ValidateAndConsumeAdminStepUpProofTokenAsync));
        Assert.Contains("ICacheOneTimeStore.ConsumeOnceAsync", consume, StringComparison.Ordinal);
        ICacheOneTimeStore proofCache = Substitute.For<ICacheOneTimeStore>();
        ICacheStringWriter proofWriter = Substitute.For<ICacheStringWriter>();
        proofCache.ConsumeOnceAsync(
                CachePolicyId.SecurityMfaProof,
                Arg.Any<string>(),
                CancellationToken.None)
            .Returns(true);
        var principalService = new AdminPrincipalService(
            Substitute.For<IFido2>(),
            Substitute.For<ISqlSugarClient>(),
            proofWriter,
            proofCache,
            Substitute.For<IJwtHelper>(),
            new ConfigurationBuilder().Build(),
            NullLogger<AdminPrincipalService>.Instance,
            Substitute.For<IAdminAuditLogChannel>());

        Assert.True(await principalService.ValidateAndConsumeAdminStepUpProofTokenAsync(
            42,
            "admin-session",
            AdminSensitiveStepUpMetadata.DefaultAction,
            "single-use-proof",
            CancellationToken.None));
        await proofCache.Received(1).ConsumeOnceAsync(
            CachePolicyId.SecurityMfaProof,
            Arg.Any<string>(),
            CancellationToken.None);
    }

    [Fact]
    public void FileDeletePath_UsesCanonicalPrefixAndRejectsWindowsSeparators()
    {
        Assert.Equal(
            "/uploads/illustration/",
            GetPrivateConstant<string>(typeof(BinaryEndpoints), "CanonicalIllustrationUploadPrefix"));
        MethodInfo normalize = typeof(BinaryEndpoints).GetMethod(
            "TryNormalizeImageDeletePath",
            BindingFlags.Static | BindingFlags.NonPublic)!;

        AssertNormalized(normalize, "/uploads/illustration/example.webp", "/uploads/illustration/example.webp");
        AssertNormalized(normalize, "https://example.test/uploads/illustration/example.webp", "/uploads/illustration/example.webp");
        AssertRejected(normalize, "/uploads/illustration\\example.webp");
        AssertRejected(normalize, "/uploads/illustration/example:alternate.webp");
        AssertRejected(normalize, "/uploads/avatar/example.webp");
        AssertRejected(normalize, "/uploads/illustration/../secret.txt");
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task ArticleDeleteRestoreMutationEndpoints_AreRateLimitedAndStepUpProtected()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        AssertArticleMutationProtected(
            EndpointContractApplication.Find(app, "/api/binary/admin/article/{id:int}", HttpMethods.Delete),
            nameof(IArticleEndpointService.DeleteAsync));
        AssertArticleMutationProtected(
            EndpointContractApplication.Find(app, "/api/binary/admin/article/restore/{id:int}", HttpMethods.Put),
            nameof(IArticleEndpointService.RestoreAsync));
        AssertArticleMutationProtected(
            EndpointContractApplication.Find(app, "/api/binary/admin/article/permanent/{id:int}", HttpMethods.Delete),
            nameof(IArticleEndpointService.PermanentlyDeleteArticleAsync));
    }

    private static void AssertArticleMutationProtected(RouteEndpoint endpoint, string mutationMethod)
    {
        Assert.Equal(
            "fixed_ip",
            Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        AdminSensitiveStepUpMetadata stepUp = Assert.IsType<AdminSensitiveStepUpMetadata>(
            endpoint.Metadata.GetMetadata<AdminSensitiveStepUpMetadata>());
        Assert.Equal(AdminSensitiveStepUpMetadata.DefaultAction, stepUp.Action);
        Assert.Equal(AdminSensitiveStepUpMetadata.DefaultProofHeader, stepUp.ProofHeader);

        string handler = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(BinaryEndpoints),
            mutationMethod,
            "RequireAdminSensitiveStepUpAsync");
        Assert.Contains(mutationMethod, handler, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", handler, StringComparison.Ordinal);
    }

    private static IConfiguration ValidFoundationConfiguration(string dataRoot)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASPNETCORE_ENVIRONMENT"] = "Development",
                ["CORS_ALLOWED_HOSTS"] = "https://example.test",
                ["FSUSBLOG_DATA_ROOT"] = dataRoot,
                ["ConnectionStrings:Redis"] = "127.0.0.1:6379,abortConnect=false",
                ["ConnectionStrings:DefaultConnection"] = "Host=127.0.0.1;Database=fsusblog_foundation_test;Username=test;Password=test",
                ["Jwt:SecretKey"] = new string('s', 64),
                ["Jwt:Issuer"] = "fsus-tests",
                ["Jwt:Audience"] = "fsus-tests"
            })
            .Build();

    private static T GetPrivateConstant<T>(Type type, string fieldName)
        => (T)type.GetField(fieldName, BindingFlags.Static | BindingFlags.NonPublic)!.GetRawConstantValue()!;

    private static int FindReference(IReadOnlyList<string> references, string memberName)
    {
        int index = references.ToList().FindIndex(reference => reference.Contains(memberName, StringComparison.Ordinal));
        Assert.True(index >= 0, $"Missing runtime member reference '{memberName}'.");
        return index;
    }

    private static void AssertNormalized(MethodInfo normalize, string input, string expected)
    {
        object?[] arguments = [input, string.Empty, null];
        Assert.True((bool)normalize.Invoke(null, arguments)!);
        Assert.Equal(expected, arguments[1]);
        Assert.Null(arguments[2]);
    }

    private static void AssertRejected(MethodInfo normalize, string input)
    {
        object?[] arguments = [input, string.Empty, null];
        Assert.False((bool)normalize.Invoke(null, arguments)!);
        Assert.Equal(string.Empty, arguments[1]);
        Assert.False(string.IsNullOrWhiteSpace(Assert.IsType<string>(arguments[2])));
    }
}
