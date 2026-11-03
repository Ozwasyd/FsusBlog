using System.Buffers.Binary;
using System.Security.Claims;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;
using FsusBlog.Shared.Contracts.DocumentExport;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real original AEDS/binder/actor/route seams with a controlled catalog; not PostgreSQL, live PoW or native qualification.</summary>
public sealed class DocumentExportSourceOptionsEndpointsTests
{
    [Fact]
    public async Task Capture_ReadsOneActualFrameAndReturnsOnlyPersistedChoices()
    {
        using var fixture = new Fixture();
        DocumentExportSourceSelector[] selectors =
        [
            new(1, 17, "actual-draft", null, null),
            new(2, 17, null, long.MaxValue, null),
            new(3, 17, null, 9007199254740993L, long.MaxValue)
        ];
        fixture.SetBody(PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new(selectors)));
        DocumentExportSourceChoicesResponse response = await fixture.ExecuteResponseAsync();
        Assert.Single(fixture.Requests.ReceivedCalls());
        Assert.Single(fixture.Catalog.ReceivedCalls());
        await fixture.Catalog.Received(1).CaptureAsync(fixture.Actor,
            Arg.Is<IReadOnlyList<DocumentExportSourceRequest>>(sources => sources.Count == 3
                && sources[0] == new DocumentExportSourceRequest(DocumentExportCoordinateKind.Draft, 17, "actual-draft")
                && sources[1].RevisionId == long.MaxValue && sources[2].PublicationId == long.MaxValue), default);
        Assert.Equal(fixture.Choices[0].ChoiceId, response.Choices[0].ChoiceId);
        Assert.Equal(fixture.Choices[0].Coordinate.SourceVersion, response.Choices[0].Coordinate.SourceVersion);
        Assert.Equal("原始标题 Ω", response.Choices[0].Label);
        Assert.Empty(fixture.Freezer.ReceivedCalls());
    }

    [Fact]
    public async Task Revisions_UsesOnlyTheOriginalCaptureRevisionsOperation()
    {
        using var fixture = new Fixture(true);
        await fixture.ExecuteResponseAsync();
        await fixture.Catalog.Received(1).CaptureRevisionsAsync(fixture.Actor, 17, default);
        await fixture.Catalog.DidNotReceive().CaptureAsync(Arg.Any<DocumentExportJobActor>(),
            Arg.Any<IReadOnlyList<DocumentExportSourceRequest>>(), Arg.Any<CancellationToken>());
        Assert.Single(fixture.Requests.ReceivedCalls());
    }

    [Theory]
    [InlineData("anonymous")]
    [InlineData("owner")]
    [InlineData("session")]
    [InlineData("site")]
    [InlineData("configuration")]
    public async Task IdentityMismatch_IsDeniedBeforeBodyOrCatalog(string mutation)
    {
        using var fixture = new Fixture();
        IDocumentExportEndpointBinding binding = fixture.Binding;
        if (mutation == "anonymous")
        {
            fixture.Context.User = new ClaimsPrincipal();
        }
        else if (mutation == "configuration")
        {
            fixture.Context.RequestServices = new ServiceCollection().BuildServiceProvider();
        }
        else
        {
            binding = Substitute.For<IDocumentExportEndpointBinding>();
            DocumentExportJobActor different = mutation switch
            {
                "owner" => fixture.Actor with { UserId = 99 },
                "site" => fixture.Actor with { SiteScope = "https://other.example" },
                _ => fixture.Actor with { SessionId = "other-session" }
            };
            binding.ResolveActorAsync(fixture.Context, default).Returns(different);
        }
        await fixture.AssertDeniedAsync(binding);
        Assert.Empty(fixture.Requests.ReceivedCalls());
        Assert.Empty(fixture.Catalog.ReceivedCalls());
        Assert.Equal(0, fixture.Context.Request.Body.Position);
    }

    [Theory]
    [InlineData("truncated")]
    [InlineData("trailing")]
    [InlineData("duplicate")]
    [InlineData("wrong-kind")]
    [InlineData("wrong-frame")]
    [InlineData("oversized")]
    public async Task MalformedOrWrongFrame_IsDeniedBeforeCapture(string mutation)
    {
        using var fixture = new Fixture();
        byte[] payload = PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([new(1, 17, "draft", null, null)]));
        if (mutation == "truncated")
        {
            payload = payload[..^1];
        }
        else if (mutation == "trailing")
        {
            payload = [.. payload, 0];
        }
        else if (mutation == "duplicate")
        {
            payload = [.. payload, .. payload[8..]];
            BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(4), 2);
        }
        else if (mutation == "wrong-kind")
        {
            BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(8), 99);
        }
        else if (mutation == "oversized")
        {
            payload = new byte[DocumentExportSourceOptionsLimits.CapturePayloadBytes + 1];
        }
        fixture.SetBody(payload, mutation == "wrong-frame" ? AedsFrameType.DocumentExportTaskRequest : null);
        await fixture.AssertDeniedAsync();
        Assert.Single(fixture.Requests.ReceivedCalls());
        Assert.Empty(fixture.Catalog.ReceivedCalls());
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task CatalogRefusal_IsUniformAndDoesNotUseBoundSource(bool revisions, bool capacity)
    {
        using var fixture = new Fixture(revisions);
        fixture.Failure = capacity ? new DocumentExportSourceCapacityException() : new DocumentExportSourceDeniedException();
        await fixture.AssertDeniedAsync();
        Assert.Single(fixture.Catalog.ReceivedCalls());
        Assert.Empty(fixture.Freezer.ReceivedCalls());
    }

    [Theory]
    [InlineData(false, "before")]
    [InlineData(false, "body")]
    [InlineData(false, "capture")]
    [InlineData(true, "before")]
    [InlineData(true, "body")]
    [InlineData(true, "capture")]
    public async Task Cancellation_PropagatesAtOriginalBoundaries(bool revisions, string stage)
    {
        using var fixture = new Fixture(revisions);
        using var cancellation = new CancellationTokenSource();
        if (stage == "before")
        {
            cancellation.Cancel();
        }
        else if (stage == "body")
        {
            fixture.AfterRead = cancellation.Cancel;
        }
        else
        {
            fixture.AfterCapture = cancellation.Cancel;
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ExecuteAsync(cancellationToken: cancellation.Token));
        Assert.Equal(stage == "capture" ? 1 : 0, fixture.Catalog.ReceivedCalls().Count());
        Assert.Equal(stage == "before" ? 0 : 1, fixture.Requests.ReceivedCalls().Count());
        Assert.Equal(0, fixture.Output.Length);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnrelatedCatalogFailure_Propagates(bool revisions)
    {
        using var fixture = new Fixture(revisions);
        fixture.Failure = new InvalidOperationException("controlled catalog failure");
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ExecuteAsync());
        Assert.Equal(0, fixture.Output.Length);
    }

    [Theory]
    [InlineData("count")]
    [InlineData("id")]
    [InlineData("version")]
    [InlineData("label")]
    [InlineData("mixed")]
    [InlineData("duplicate")]
    public async Task InvalidReturnedChoices_AreDeniedBeforeResponseExecution(string mutation)
    {
        using var fixture = new Fixture();
        DocumentExportSourceChoice original = fixture.Choices[0];
        fixture.Choices = mutation switch
        {
            "count" => Enumerable.Repeat(original, 51).ToArray(),
            "id" => [original with { ChoiceId = new string('A', 64) }],
            "version" => [original with { Coordinate = original.Coordinate with { SourceVersion = 0 } }],
            "label" => [original with { Label = new string('a', 257) }],
            "mixed" => [original with { Coordinate = original.Coordinate with { RevisionId = 1 } }],
            _ => [original, original]
        };
        await fixture.AssertDeniedAsync();
        Assert.Single(fixture.Catalog.ReceivedCalls());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EmptyAndRepeatedCapture_KeepTheCatalogResult(bool revisions)
    {
        using var fixture = new Fixture(revisions);
        fixture.Choices = [];
        if (!revisions)
        {
            fixture.SetBody(PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([])));
        }
        Assert.Empty((await fixture.ExecuteResponseAsync()).Choices);
        fixture.Context.Request.Body.Position = 0;
        fixture.Output.SetLength(0);
        Assert.Empty((await fixture.ExecuteResponseAsync()).Choices);
        Assert.Equal(2, fixture.Catalog.ReceivedCalls().Count());
        Assert.Equal(2, fixture.Requests.ReceivedCalls().Count());
    }

    [Fact]
    public void OnlyPostMappingsRetainOriginalWriteAndPowPolicies()
    {
        using var fixture = new Fixture();
        var services = new ServiceCollection().AddLogging();
        services.AddScoped(_ => fixture.Catalog);
        services.AddScoped<IDocumentExportEndpointBinding>(_ => fixture.Binding);
        services.AddScoped(_ => fixture.Requests);
        services.AddScoped(_ => fixture.Freezer);
        services.AddScoped(_ => Substitute.For<IDocumentExportFrozenSourceReader>());
        services.AddScoped(_ => Substitute.For<IDocumentExportJobAuthorization>());
        services.AddScoped(_ => Substitute.For<IDocumentExportJobs>());
        services.AddScoped(_ => new DocumentExportSourceSelectionAdapter(fixture.Binding, fixture.Requests, fixture.Catalog));
        services.AddSingleton<IAedsEncoder>(fixture.Encoder);
        using ServiceProvider provider = services.BuildServiceProvider();
        var routes = new ControlledRoutes(provider);
        routes.MapDocumentExportEndpoints();
        Endpoint[] endpoints = [.. routes.DataSources.SelectMany(source => source.Endpoints)
            .Where(endpoint => endpoint is RouteEndpoint route && route.RoutePattern.RawText!.Contains("/sources/", StringComparison.Ordinal))];
        Assert.Equal(2, endpoints.Length);
        foreach (Endpoint endpoint in endpoints)
        {
            Assert.Equal(new[] { "POST" }, endpoint.Metadata.GetRequiredMetadata<HttpMethodMetadata>().HttpMethods);
            Assert.Contains(endpoint.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>(),
                metadata => metadata.FilterType == typeof(RequiresPowFilter));
            AuthorizationPolicy policy = Assert.Single(endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>());
            Assert.Contains(policy.Requirements.OfType<ClaimsAuthorizationRequirement>(),
                requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType
                    && requirement.AllowedValues!.Contains(AdminPermissions.ArticleWrite));
        }
    }

    private sealed class ControlledRoutes(IServiceProvider services) : IEndpointRouteBuilder
    {
        public IServiceProvider ServiceProvider => services;
        public ICollection<EndpointDataSource> DataSources { get; } = [];
        public IApplicationBuilder CreateApplicationBuilder() => new ApplicationBuilder(services);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly bool _revisions;
        private readonly ServiceProvider _services;
        internal HttpContext Context { get; } = new DefaultHttpContext();
        internal AedsEncoder Encoder { get; } = new();
        internal MemoryStream Output { get; } = new();
        internal IDocumentExportSourceCatalog Catalog { get; } = Substitute.For<IDocumentExportSourceCatalog>();
        internal IBinaryEndpointRequestContext Requests { get; } = Substitute.For<IBinaryEndpointRequestContext>();
        internal IDocumentExportRequestFreezer Freezer { get; } = Substitute.For<IDocumentExportRequestFreezer>();
        internal DocumentExportEndpointBinding Binding
        {
            get;
        }
        internal DocumentExportJobActor Actor { get; } = new(42, "https://export.example/site", "current-session");
        internal IReadOnlyList<DocumentExportSourceChoice> Choices
        {
            get; set;
        } =
            [new(new string('a', 64), "原始标题 Ω", new(DocumentExportCoordinateKind.Draft, 17, "actual-draft", null, null, 9007199254740993L))];
        internal Exception? Failure
        {
            get; set;
        }
        internal Action? AfterRead
        {
            get; set;
        }
        internal Action? AfterCapture
        {
            get; set;
        }

        internal Fixture(bool revisions = false)
        {
            _revisions = revisions;
            _services = new ServiceCollection().AddLogging().AddSingleton<IAedsEncoder>(Encoder)
                .AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(
                    new Dictionary<string, string?> { ["SITE_BASEURL"] = Actor.SiteScope }).Build()).BuildServiceProvider();
            Context.RequestServices = _services;
            Context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new("identity_kind", "admin_principal"), new("admin_id", "42"),
                new("admin_sid", Actor.SessionId), new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
            ], "controlled-admin"));
            Context.Response.Body = Output;
            Binding = new(Freezer, Requests);
            SetBody(revisions ? PodBinaryCodec.EncodeDocumentExportRevisionChoicesRequest(new(17))
                : PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([new(1, 17, "actual-draft", null, null)])));
            var binder = new BinaryRequestBinder();
            AedsFrameType expected = revisions ? AedsFrameType.DocumentExportRevisionChoicesRequest : AedsFrameType.DocumentExportSourceCaptureRequest;
            int budget = revisions ? DocumentExportSourceOptionsLimits.RevisionChoicesFrameBytes : DocumentExportSourceOptionsLimits.CaptureFrameBytes;
            Requests.ReadFrameAsync(Context, Encoder, expected, Arg.Any<CancellationToken>(), budget).Returns(async call =>
            {
                BinaryRequestPayload payload = await binder.ReadFrameAsync(Context, Encoder, expected, call.Arg<CancellationToken>(), budget);
                AfterRead?.Invoke();
                return payload;
            });
            Catalog.CaptureAsync(Actor, Arg.Any<IReadOnlyList<DocumentExportSourceRequest>>(), Arg.Any<CancellationToken>())
                .Returns(_ => Capture());
            Catalog.CaptureRevisionsAsync(Actor, 17, Arg.Any<CancellationToken>()).Returns(_ => Capture());
        }

        private Task<IReadOnlyList<DocumentExportSourceChoice>> Capture()
        {
            Assert.Equal(Context.Request.ContentLength, Context.Request.Body.Position);
            AfterCapture?.Invoke();
            return Failure is null ? Task.FromResult(Choices) : Task.FromException<IReadOnlyList<DocumentExportSourceChoice>>(Failure);
        }

        internal void SetBody(byte[] payload, AedsFrameType? frame = null)
        {
            Context.Request.Body.Dispose();
            byte[] bytes = Encoder.Encode(frame ?? (_revisions ? AedsFrameType.DocumentExportRevisionChoicesRequest
                : AedsFrameType.DocumentExportSourceCaptureRequest), payload).ToArray();
            Context.Request.Body = new MemoryStream(bytes);
            Context.Request.ContentLength = bytes.Length;
            Context.Request.ContentType = "application/octet-stream";
        }

        internal Task<IResult> ExecuteAsync(IDocumentExportEndpointBinding? binding = null, CancellationToken cancellationToken = default)
            => _revisions ? BinaryEndpoints.HandleDocumentExportSourceRevisionsAsync(Context, Catalog, binding ?? Binding, Requests, Encoder, cancellationToken)
                : BinaryEndpoints.HandleDocumentExportSourcesCaptureAsync(Context, Catalog, binding ?? Binding, Requests, Encoder, cancellationToken);

        internal async Task<DocumentExportSourceChoicesResponse> ExecuteResponseAsync()
        {
            IResult result = await ExecuteAsync();
            await result.ExecuteAsync(Context);
            Assert.Equal(200, Context.Response.StatusCode);
            Assert.Equal("no-store", Context.Response.Headers.CacheControl);
            var frame = Encoder.TryDecode(Output.ToArray());
            Assert.True(frame.IsSuccess);
            Assert.Equal(AedsFrameType.DocumentExportSourceChoicesResponse, frame.Value.FrameType);
            Assert.True(PodBinaryCodec.TryDecodeDocumentExportSourceChoicesResponse(frame.Value.Payload, out var response));
            Assert.DoesNotContain("current-session", System.Text.Encoding.UTF8.GetString(Output.ToArray()));
            Assert.Empty(Freezer.ReceivedCalls());
            return response;
        }

        internal async Task AssertDeniedAsync(IDocumentExportEndpointBinding? binding = null)
        {
            IResult result = await ExecuteAsync(binding);
            await result.ExecuteAsync(Context);
            Assert.Equal(404, Context.Response.StatusCode);
            Assert.Equal("no-store", Context.Response.Headers.CacheControl);
            var frame = Encoder.TryDecode(Output.ToArray());
            Assert.True(frame.IsSuccess);
            Assert.Equal(AedsFrameType.ApiError, frame.Value.FrameType);
            Assert.DoesNotContain("document_export_source_catalog_full", System.Text.Encoding.UTF8.GetString(Output.ToArray()));
            Assert.DoesNotContain("current-session", System.Text.Encoding.UTF8.GetString(Output.ToArray()));
        }

        public void Dispose()
        {
            Context.Request.Body.Dispose();
            Output.Dispose();
            _services.Dispose();
        }
    }
}
