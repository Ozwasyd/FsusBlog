using System.Security.Claims;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Original transport composition controls; controlled sources/jobs do not qualify a database or provider.</summary>
public sealed class DocumentExportSourceSelectionIntegrationTests
{
    [Fact]
    public async Task Request_ReadsOneBodyAndUsesTheOriginalDecodedFenceAndWriter()
    {
        using var fixture = new Fixture();
        IResult result = await fixture.ExecuteAsync();
        await result.ExecuteAsync(fixture.Context);
        Assert.Equal(new[] { "catalog", "freeze", "create" }, fixture.Events);
        Assert.Single(fixture.Requests.ReceivedCalls());
        Assert.Single(fixture.Freezer.ReceivedCalls());
        Assert.Single(fixture.Jobs.ReceivedCalls());
        Assert.Equal("no-store", fixture.Context.Response.Headers.CacheControl);
        var decoded = fixture.Encoder.TryDecode(fixture.Output.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.DocumentExportJobResponse, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportJobResponse(decoded.Value.Payload, out var response));
        Assert.Equal(fixture.Input.Coordinate.SourceVersion, response.Source.SourceVersion);
        Assert.Null(response.Output);
        Assert.DoesNotContain("private-bound-source", Encoding.UTF8.GetString(fixture.Output.ToArray()));
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("session")]
    public async Task ChangedAdapterActor_IsUniformlyDeniedBeforeFreezeOrCreate(string field)
    {
        using var fixture = new Fixture();
        DocumentExportJobActor different = field switch
        {
            "owner" => fixture.Actor with { UserId = fixture.Actor.UserId + 1 },
            "site" => fixture.Actor with { SiteScope = "https://other.example" },
            _ => fixture.Actor with { SessionId = "other-session" }
        };
        var actorBinding = Substitute.For<IDocumentExportEndpointBinding>();
        actorBinding.ResolveActorAsync(fixture.Context, default).Returns(different);
        fixture.SetAdapter(new(actorBinding, fixture.Requests, fixture.Catalog));
        await fixture.AssertDeniedAsync();
        Assert.Empty(fixture.Freezer.ReceivedCalls());
        Assert.Empty(fixture.Jobs.ReceivedCalls());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CatalogRefusal_UsesOriginalNoStoreErrorWithoutFreezeOrCreate(bool capacity)
    {
        using var fixture = new Fixture();
        Exception refusal = capacity ? new DocumentExportSourceCapacityException() : new DocumentExportSourceDeniedException();
        fixture.Catalog.ReadBoundAsync(fixture.Actor, fixture.Input.Coordinate, default)
            .Returns(Task.FromException<DocumentExportBoundSource>(refusal));
        await fixture.AssertDeniedAsync();
        Assert.Empty(fixture.Freezer.ReceivedCalls());
        Assert.Empty(fixture.Jobs.ReceivedCalls());
    }

    [Fact]
    public async Task MismatchedFrozenSource_IsRejectedByOriginalBindingBeforeCreate()
    {
        using var fixture = new Fixture();
        DocumentExportFrozenInput other = DocumentExportContractValidator.Seal(fixture.Input with
        {
            Coordinate = fixture.Input.Coordinate with
            {
                SourceVersion = fixture.Input.Coordinate.SourceVersion + 1
            }
        });
        fixture.Freezer.FreezeAsync(fixture.Context, fixture.Actor,
            Arg.Any<DocumentExportRequestCoreModel>(), default)
            .Returns((DocumentExportContractTests.ValidTask(other), other));
        await fixture.AssertDeniedAsync();
        Assert.Single(fixture.Freezer.ReceivedCalls());
        Assert.Empty(fixture.Jobs.ReceivedCalls());
    }

    [Theory]
    [InlineData("catalog")]
    [InlineData("freeze")]
    public async Task CancellationAfterAdmission_PropagatesWithoutCreate(string stage)
    {
        using var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        if (stage == "catalog")
        {
            fixture.Catalog.ReadBoundAsync(fixture.Actor, fixture.Input.Coordinate, cancellation.Token)
                .Returns(_ =>
                {
                    cancellation.Cancel();
                    return Task.FromResult(fixture.Bound);
                });
        }
        else
        {
            fixture.Freezer.FreezeAsync(fixture.Context, fixture.Actor,
                Arg.Any<DocumentExportRequestCoreModel>(), cancellation.Token)
                .Returns(_ =>
                {
                    cancellation.Cancel();
                    return Task.FromResult((fixture.Task, fixture.Input));
                });
        }
        await Assert.ThrowsAsync<OperationCanceledException>(() => fixture.ExecuteAsync(cancellation.Token));
        Assert.Empty(fixture.Jobs.ReceivedCalls());
        Assert.Equal("no-store", fixture.Context.Response.Headers.CacheControl);
    }

    [Theory]
    [InlineData("catalog-missing")]
    [InlineData("catalog-keyed")]
    [InlineData("context-missing")]
    [InlineData("context-keyed")]
    [InlineData("adapter-existing")]
    public void IncompleteSelectionComposition_LeavesAllRegistrationsUnchanged(string mutation)
    {
        var services = Composition();
        Type removed = mutation.StartsWith("catalog", StringComparison.Ordinal)
            ? typeof(IDocumentExportSourceCatalog) : typeof(IBinaryEndpointRequestContext);
        if (mutation != "adapter-existing")
        {
            services.Remove(services.Single(descriptor => descriptor.ServiceType == removed));
        }
        if (mutation == "catalog-keyed")
        {
            services.AddKeyedScoped<IDocumentExportSourceCatalog>("other", (_, _) => Substitute.For<IDocumentExportSourceCatalog>());
        }
        if (mutation == "context-keyed")
        {
            services.AddKeyedScoped<IBinaryEndpointRequestContext>("other", (_, _) => Substitute.For<IBinaryEndpointRequestContext>());
        }
        if (mutation == "adapter-existing")
        {
            services.AddScoped<DocumentExportSourceSelectionAdapter>();
        }
        ServiceDescriptor[] before = services.ToArray();
        Assert.Throws<InvalidOperationException>(() => services.AddDocumentExportTransport());
        Assert.Equal(before, services.ToArray());
    }

    [Fact]
    public void ScopedSelection_ResolvesTheOriginalBindingWithoutADependencyCycle()
    {
        var services = Composition();
        services.AddDocumentExportTransport();
        Assert.Equal(ServiceLifetime.Scoped, Assert.Single(services,
            descriptor => descriptor.ServiceType == typeof(DocumentExportSourceSelectionAdapter)).Lifetime);
        using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateScopes = true,
            ValidateOnBuild = true
        });
        using IServiceScope first = provider.CreateScope();
        using IServiceScope second = provider.CreateScope();
        DocumentExportSourceSelectionAdapter adapter = first.ServiceProvider.GetRequiredService<DocumentExportSourceSelectionAdapter>();
        Assert.Same(adapter, first.ServiceProvider.GetRequiredService<DocumentExportSourceSelectionAdapter>());
        Assert.NotSame(adapter, second.ServiceProvider.GetRequiredService<DocumentExportSourceSelectionAdapter>());
        Assert.IsType<DocumentExportEndpointBinding>(first.ServiceProvider.GetRequiredService<IDocumentExportEndpointBinding>());
    }

    private static ServiceCollection Composition()
    {
        var services = new ServiceCollection();
        services.AddScoped(_ => Substitute.For<IDocumentExportFrozenSourceReader>());
        services.AddScoped(_ => Substitute.For<IDocumentExportJobAuthorization>());
        services.AddScoped(_ => Substitute.For<IDocumentExportSourceCatalog>());
        services.AddScoped(_ => Substitute.For<IBinaryEndpointRequestContext>());
        services.AddScoped<DocumentExportJobService>(_ => throw new InvalidOperationException("must_not_resolve_job_storage"));
        return services;
    }

    private sealed class Fixture : IDisposable
    {
        private ServiceProvider _services = null!;
        internal DocumentExportJobActor Actor { get; } = new(7, "https://example.test", "controlled-session");
        internal DocumentExportFrozenInput Input
        {
            get;
        } = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidInput() with
        {
            Coordinate = new(DocumentExportCoordinateKind.Publication, 42, null, 101, 202, 9007199254740993L)
        });
        internal DocumentExportTask Task
        {
            get;
        }
        internal DocumentExportBoundSource Bound
        {
            get;
        }
        internal IDocumentExportRequestFreezer Freezer { get; } = Substitute.For<IDocumentExportRequestFreezer>();
        internal IBinaryEndpointRequestContext Requests { get; } = Substitute.For<IBinaryEndpointRequestContext>();
        internal IDocumentExportSourceCatalog Catalog { get; } = Substitute.For<IDocumentExportSourceCatalog>();
        internal IDocumentExportJobs Jobs { get; } = Substitute.For<IDocumentExportJobs>();
        internal DocumentExportEndpointBinding Binding
        {
            get;
        }
        internal AedsEncoder Encoder { get; } = new();
        internal DefaultHttpContext Context
        {
            get;
        }
        internal MemoryStream Output { get; } = new();
        internal List<string> Events { get; } = [];

        internal Fixture()
        {
            Task = DocumentExportContractTests.ValidTask(Input);
            Bound = new(new("private-bound-source-choice", "private-bound-source-label", Input.Coordinate),
                "private-bound-source-fingerprint", null, null, null, null, null);
            Context = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("identity_kind", "admin_principal"),
                    new Claim("admin_id", "7"),
                    new Claim("admin_sid", Actor.SessionId)
                ], "controlled-admin"))
            };
            Context.Response.Body = Output;
            var request = new DocumentExportRequestCoreModel(Task.RequestId, Task.IdempotencyKey,
                new((int)Input.Coordinate.Kind, Input.Coordinate.ArticleId, Input.Coordinate.DraftKey,
                    Input.Coordinate.RevisionId, Input.Coordinate.PublicationId, Input.Coordinate.SourceVersion),
                Task.FormatId, Task.LayoutProfile, Task.ThemeProfile, Task.Locale);
            byte[] frame = Encoder.Encode(AedsFrameType.DocumentExportRequest, PodBinaryCodec.EncodeDocumentExportRequest(request));
            Context.Request.Body = new MemoryStream(frame);
            Context.Request.ContentType = "application/octet-stream";
            Context.Request.ContentLength = frame.Length;
            var reader = new BinaryRequestBinder();
            Requests.ReadFrameAsync(Context, Encoder, AedsFrameType.DocumentExportRequest,
                Arg.Any<CancellationToken>(), PodBinaryCodec.MaximumDocumentExportRequestFrameBytes)
                .Returns(call => reader.ReadFrameAsync(Context, Encoder, AedsFrameType.DocumentExportRequest,
                    call.Arg<CancellationToken>(), PodBinaryCodec.MaximumDocumentExportRequestFrameBytes));
            Catalog.ReadBoundAsync(Arg.Any<DocumentExportJobActor>(), Input.Coordinate, Arg.Any<CancellationToken>()).Returns(_ =>
            {
                Events.Add("catalog");
                return System.Threading.Tasks.Task.FromResult(Bound);
            });
            Freezer.FreezeAsync(Context, Actor, Arg.Any<DocumentExportRequestCoreModel>(), Arg.Any<CancellationToken>())
                .Returns(_ =>
                {
                    Events.Add("freeze");
                    return System.Threading.Tasks.Task.FromResult((Task, Input));
                });
            Jobs.CreateAsync(Actor, Task, Input, Arg.Any<CancellationToken>()).Returns(_ =>
            {
                Events.Add("create");
                DateTimeOffset now = DateTimeOffset.UtcNow;
                return System.Threading.Tasks.Task.FromResult(new DocumentExportJobSnapshot(
                    DocumentExportJobPolicy.SnapshotSchema, Task, now, now.AddMinutes(1), [], null, "", 1));
            });
            Binding = new(Freezer, Requests);
            SetAdapter(new(Binding, Requests, Catalog));
        }

        internal void SetAdapter(DocumentExportSourceSelectionAdapter adapter)
        {
            _services?.Dispose();
            _services = new ServiceCollection().AddLogging()
                .AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(
                    new Dictionary<string, string?> { ["SITE_BASEURL"] = Actor.SiteScope }).Build())
                .AddSingleton<IAedsEncoder>(Encoder).AddScoped(_ => adapter).BuildServiceProvider();
            Context.RequestServices = _services;
        }

        internal Task<IResult> ExecuteAsync(CancellationToken cancellationToken = default)
            => BinaryEndpoints.HandleDocumentExportRequestAsync(Context, Jobs, Binding, Encoder, cancellationToken);

        internal async Task AssertDeniedAsync()
        {
            IResult result = await ExecuteAsync();
            await result.ExecuteAsync(Context);
            Assert.Equal(404, Context.Response.StatusCode);
            Assert.Equal("no-store", Context.Response.Headers.CacheControl);
            Assert.DoesNotContain("private-bound-source", Encoding.UTF8.GetString(Output.ToArray()));
        }

        public void Dispose()
        {
            Context.Request.Body.Dispose();
            Output.Dispose();
            _services.Dispose();
        }
    }
}
