using System.Collections.Immutable;
using System.Security.Claims;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;

using Microsoft.Extensions.Configuration;

using NSubstitute;
using NSubstitute.ExceptionExtensions;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Endpoint controls including the real durable service. Identity/freezing and
/// frame writers remain controlled adapters, not wire or production qualification.
/// </summary>
public sealed class DocumentExportEndpointsTests
{
    [Fact]
    public async Task AnonymousRequest_PerformsZeroJobOrFreezeWrites()
    {
        var context = new DefaultHttpContext();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        IDocumentExportEndpointBinding binding = Substitute.For<IDocumentExportEndpointBinding>();

        IResult result = await BinaryEndpoints.HandleDocumentExportRequestAsync(
            context, jobs, binding, new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);

        Assert.Empty(jobs.ReceivedCalls());
        Assert.Empty(binding.ReceivedCalls());
    }

    [Fact]
    public async Task Cancel_UsesAdminSessionAndActualAuthorityResponse()
    {
        HttpContext context = AuthenticatedContext();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        IDocumentExportEndpointBinding binding = Binding();
        jobs.CancelAsync(Actor(), "task", Arg.Any<CancellationToken>())
            .ThrowsAsync(new DocumentExportJobDeniedException());

        IResult result = await BinaryEndpoints.HandleDocumentExportCancelAsync(
            context, jobs, binding, new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);

        await jobs.Received(1).CancelAsync(Actor(), "task", Arg.Any<CancellationToken>());
        await jobs.DidNotReceive().CreateAsync(Arg.Any<DocumentExportJobActor>(), default!, default!, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task MismatchedAuthenticatedActor_PerformsZeroJobCalls()
    {
        HttpContext context = AuthenticatedContext();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        IDocumentExportEndpointBinding binding = Binding();
        binding.ResolveActorAsync(context, Arg.Any<CancellationToken>())
            .Returns(new DocumentExportJobActor(99, Actor().SiteScope, "admin-session"));

        IResult result = await BinaryEndpoints.HandleDocumentExportStatusAsync(
            context, jobs, binding, new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);

        Assert.Empty(jobs.ReceivedCalls());
    }

    [Theory]
    [InlineData("")]
    [InlineData("7")]
    [InlineData(" https://export.example/site")]
    [InlineData("https://export.example/site/")]
    [InlineData("https://export.example/Site")]
    [InlineData("https://other.example/site")]
    public async Task NonCanonicalOrOtherConfiguredScope_PerformsZeroJobOrFreezeWrites(string scope)
    {
        HttpContext context = AuthenticatedContext();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        IDocumentExportEndpointBinding binding = Binding();
        binding.ResolveActorAsync(context, Arg.Any<CancellationToken>()).Returns(Actor() with
        {
            SiteScope = scope
        });
        IResult result = await BinaryEndpoints.HandleDocumentExportRequestAsync(
            context, jobs, binding, new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);
        Assert.Empty(jobs.ReceivedCalls());
        await binding.DidNotReceive().FreezeDecodedRequestAsync(Arg.Any<HttpContext>(),
            Arg.Any<DocumentExportJobActor>(), Arg.Any<DocumentExportRequestCoreModel>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData("input")]
    [InlineData("task")]
    [InlineData("other-site")]
    public async Task LegacySchemaOrOtherFrozenScope_IsRejectedBeforeJobAdmission(string mutation)
    {
        HttpContext context = AuthenticatedContext();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        IDocumentExportEndpointBinding binding = Binding();
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidInput() with
        {
            UserId = Actor().UserId,
            SiteScope = mutation == "other-site" ? "https://other.example/site" : Actor().SiteScope,
            Schema = mutation == "input" ? "fsusblog.document-export-frozen-input.v2" : DocumentExportContractCatalog.InputSchema
        });
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            Schema = mutation == "task" ? "fsusblog.document-export-task.v2" : DocumentExportContractCatalog.TaskSchema
        });
        ConfigureSelection(context, binding);
        binding.FreezeDecodedRequestAsync(context, Actor(), Arg.Any<DocumentExportRequestCoreModel>(), Arg.Any<CancellationToken>()).Returns((task, input));
        IResult result = await BinaryEndpoints.HandleDocumentExportRequestAsync(
            context, jobs, binding, new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);
        Assert.Empty(jobs.ReceivedCalls());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CanonicalDecoderRefusesNumericSiteMemberWithoutAnyJobWrite(bool keepScope)
    {
        HttpContext context = AuthenticatedContext();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        IDocumentExportEndpointBinding binding = Binding();
        DocumentExportFrozenInput canonical = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidInput() with
        {
            UserId = Actor().UserId,
            SiteScope = Actor().SiteScope
        });
        JsonObject value = JsonNode.Parse(DocumentExportDigest.Serialize(canonical))!.AsObject();
        value["siteId"] = 7;
        if (!keepScope)
        {
            value.Remove("siteScope");
        }
        // Exercise the sole contract codec in the controlled frozen-input port;
        // this does not add a JSON HTTP route or a second parser.
        ConfigureSelection(context, binding);
        binding.FreezeDecodedRequestAsync(context, Actor(), Arg.Any<DocumentExportRequestCoreModel>(), Arg.Any<CancellationToken>()).Returns(_ =>
        {
            DocumentExportFrozenInput input = DocumentExportDigest.Deserialize<DocumentExportFrozenInput>(
                Encoding.UTF8.GetBytes(value.ToJsonString()));
            return (DocumentExportContractTests.ValidTask(input), input);
        });
        IResult result = await BinaryEndpoints.HandleDocumentExportRequestAsync(
            context, jobs, binding, new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);
        Assert.Empty(jobs.ReceivedCalls());
        await binding.Received(1).FreezeDecodedRequestAsync(context, Actor(), Arg.Any<DocumentExportRequestCoreModel>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task MissingConfiguredAuthority_PerformsZeroJobWrites()
    {
        HttpContext context = AuthenticatedContext();
        context.RequestServices = new ServiceCollection().BuildServiceProvider();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        IResult result = await BinaryEndpoints.HandleDocumentExportStatusAsync(
            context, jobs, Binding(), new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);
        Assert.Empty(jobs.ReceivedCalls());
    }

    [Theory]
    [InlineData("?offset=0&limit=1000")]
    [InlineData("?offset=-1&limit=20")]
    [InlineData("?offset=0&limit=0")]
    public async Task InvalidPageBounds_DoNotQueryJobs(string query)
    {
        HttpContext context = AuthenticatedContext();
        context.Request.QueryString = new QueryString(query);
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();

        IResult result = await BinaryEndpoints.HandleDocumentExportListAsync(
            context, jobs, Binding(), new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);

        Assert.Empty(jobs.ReceivedCalls());
    }

    [Fact]
    public async Task RangeRequest_DoesNotIssueOrConsumeGrant()
    {
        HttpContext context = AuthenticatedContext();
        context.Request.Headers.Range = "bytes=0-1";
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();

        IResult result = await BinaryEndpoints.HandleDocumentExportDownloadAsync(
            context, jobs, Binding(), new AedsEncoder(), default);
        await AssertDeniedAsync(context, result);

        Assert.Empty(jobs.ReceivedCalls());
    }

    [Fact]
    public async Task Download_ConsumesCanonicalGrantWithoutExposingTokenAndPreservesMime()
    {
        HttpContext context = AuthenticatedContext();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        jobs.GrantAsync(Actor(), "task", Arg.Any<CancellationToken>())
            .Returns(new DocumentExportDownloadGrant("private-grant-fixture", DateTimeOffset.UtcNow.AddMinutes(1)));
        jobs.DownloadAsync(Actor(), "private-grant-fixture", false, Arg.Any<CancellationToken>())
            .Returns(new DocumentExportDownload([1, 2, 3], 3,
                ImmutableDictionary<string, string>.Empty
                    .Add("Content-Type", "application/pdf")
                    .Add("Content-Disposition", "attachment; filename=export.pdf")
                    .Add("Cross-Origin-Resource-Policy", "same-origin")));
        await using var body = new MemoryStream();
        context.Response.Body = body;

        IResult result = await BinaryEndpoints.HandleDocumentExportDownloadAsync(
            context, jobs, Binding(), new AedsEncoder(), default);
        await result.ExecuteAsync(context);

        Assert.Equal(new byte[] { 1, 2, 3 }, body.ToArray());
        Assert.Equal("application/pdf", context.Response.ContentType);
        Assert.Equal("no-store", context.Response.Headers.CacheControl);
        Assert.Equal("nosniff", context.Response.Headers["X-Content-Type-Options"]);
        Assert.Equal("none", context.Response.Headers["Accept-Ranges"]);
        Assert.DoesNotContain(context.Response.Headers, header => header.Value.ToString().Contains("private-grant-fixture", StringComparison.Ordinal));
        await jobs.Received(1).DownloadAsync(Actor(), "private-grant-fixture", false, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CancelledBeforeAdmission_PerformsZeroWrites()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        IDocumentExportJobs jobs = Substitute.For<IDocumentExportJobs>();
        IDocumentExportEndpointBinding binding = Binding();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => BinaryEndpoints.HandleDocumentExportRequestAsync(
            AuthenticatedContext(), jobs, binding, new AedsEncoder(), cancellation.Token));

        Assert.Empty(jobs.ReceivedCalls());
        Assert.Empty(binding.ReceivedCalls());
    }

    [Theory]
    [Trait("Platform", "Unix")]
    [InlineData("self-contained-html")]
    [InlineData("pdf")]
    [InlineData("docx")]
    [InlineData("epub")]
    public async Task DurableAdmission_IdempotencyAndRestartUseTheOriginalFrozenTask(string format)
    {
        using var fixture = new DurableFixture(format);
        await BinaryEndpoints.HandleDocumentExportRequestAsync(AuthenticatedContext(fixture.Binding, fixture.Task),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        DocumentExportJobSnapshot original = Assert.IsType<DocumentExportJobSnapshot>(fixture.LastSnapshot);
        Assert.Equal(DocumentExportTaskStatus.Queued, original.Task.Status);
        Assert.Null(original.Output);

        fixture.Task = DocumentExportContractValidator.Seal(fixture.Task with
        {
            TaskId = "response-loss-retry",
            RequestId = "response-loss-retry-request"
        });
        await BinaryEndpoints.HandleDocumentExportRequestAsync(AuthenticatedContext(fixture.Binding, fixture.Task),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        Assert.Equal(original.Task.TaskId, fixture.LastSnapshot!.Task.TaskId);
        Assert.Single(await fixture.Service().ListAsync(Actor(), default));

        await BinaryEndpoints.HandleDocumentExportStatusAsync(AuthenticatedContext(),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        Assert.Equal(original.Task, fixture.LastSnapshot!.Task);
        Assert.Equal(original.Version, fixture.LastSnapshot.Version);
        Assert.Equal(fixture.Input.ContentDigest, fixture.LastSnapshot!.Task.InputDigest);
        Assert.Equal(fixture.Input.Coordinate, fixture.LastSnapshot.Task.Coordinate);
        Assert.NotEmpty(File.ReadAllBytes(fixture.StatePath));
        Assert.DoesNotContain("private-endpoint-source", System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(fixture.StatePath)));
    }

    [Fact]
    [Trait("Platform", "Unix")]
    public async Task DurableList_ReturnsOnlyTheRequestedPageAndHidesRevokedJobs()
    {
        using var fixture = new DurableFixture();
        for (int index = 0; index < 5; index++)
        {
            fixture.Task = DocumentExportContractValidator.Seal(fixture.Task with
            {
                TaskId = $"page-task-{index}",
                RequestId = $"page-request-{index}",
                IdempotencyKey = $"page-key-{index}"
            });
            await BinaryEndpoints.HandleDocumentExportRequestAsync(AuthenticatedContext(fixture.Binding, fixture.Task),
                fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        }
        HttpContext context = AuthenticatedContext();
        context.Request.QueryString = new QueryString("?offset=1&limit=2");
        await BinaryEndpoints.HandleDocumentExportListAsync(context,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        ImmutableArray<DocumentExportJobSnapshot> expected = await fixture.Service().ListAsync(Actor(), default);
        Assert.Equal(expected.Skip(1).Take(2).Select(snapshot => snapshot.Task.TaskId),
            fixture.LastPage.Select(snapshot => snapshot.Task.TaskId));
        Assert.Equal(2, fixture.LastPage.Length);
        Assert.True(fixture.LastPageHasMore);
        context.Request.QueryString = new QueryString("?offset=3&limit=2");
        await BinaryEndpoints.HandleDocumentExportListAsync(context,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        Assert.Equal(2, fixture.LastPage.Length);
        Assert.False(fixture.LastPageHasMore);

        fixture.Authorization.Allowed = false;
        await BinaryEndpoints.HandleDocumentExportListAsync(context,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        Assert.Empty(fixture.LastPage);
        Assert.False(fixture.LastPageHasMore);
    }

    [Fact]
    [Trait("Platform", "Unix")]
    public async Task DurableAdmission_DeniedPermissionCreatesNoJobStore()
    {
        using var fixture = new DurableFixture();
        fixture.Authorization.Allowed = false;
        HttpContext resultContext = AuthenticatedContext(fixture.Binding, fixture.Task);
        IResult result = await BinaryEndpoints.HandleDocumentExportRequestAsync(resultContext,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        await AssertDeniedAsync(resultContext, result);
        Assert.False(Directory.Exists(fixture.JobRoot));
        Assert.Null(fixture.LastSnapshot);
        Assert.Equal(1, fixture.Authorization.Calls);
        await fixture.Binding.Received(1).FreezeDecodedRequestAsync(resultContext, Actor(),
            Arg.Any<DocumentExportRequestCoreModel>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    [Trait("Platform", "Unix")]
    public async Task DurableRevocation_UniformlyDeniesStatusCancelAndDownloadWithoutChangingState()
    {
        using var fixture = new DurableFixture();
        await BinaryEndpoints.HandleDocumentExportRequestAsync(AuthenticatedContext(fixture.Binding, fixture.Task),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        byte[] before = File.ReadAllBytes(fixture.StatePath);
        fixture.Authorization.Allowed = false;
        HttpContext statusContext = AuthenticatedContext();
        IResult status = await BinaryEndpoints.HandleDocumentExportStatusAsync(statusContext,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        await AssertDeniedAsync(statusContext, status);
        HttpContext cancelContext = AuthenticatedContext();
        IResult cancel = await BinaryEndpoints.HandleDocumentExportCancelAsync(cancelContext,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        await AssertDeniedAsync(cancelContext, cancel);
        HttpContext downloadContext = AuthenticatedContext();
        IResult download = await BinaryEndpoints.HandleDocumentExportDownloadAsync(downloadContext,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        await AssertDeniedAsync(downloadContext, download);
        Assert.Equal(before, File.ReadAllBytes(fixture.StatePath));
    }

    [Fact]
    [Trait("Platform", "Unix")]
    public async Task DurableCancelAndDelete_ReturnActualPersistedStateAndDenyRetryOrDownload()
    {
        using var fixture = new DurableFixture();
        await BinaryEndpoints.HandleDocumentExportRequestAsync(AuthenticatedContext(fixture.Binding, fixture.Task),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        await BinaryEndpoints.HandleDocumentExportCancelAsync(AuthenticatedContext(),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        Assert.Equal(DocumentExportTaskStatus.Cancelled, fixture.LastSnapshot!.Task.Status);
        await BinaryEndpoints.HandleDocumentExportDeleteAsync(AuthenticatedContext(),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        DocumentExportJobSnapshot persisted = await fixture.Service().GetAsync(Actor(), fixture.Task.TaskId, default);
        Assert.Equal(persisted.Task, fixture.LastSnapshot!.Task);
        Assert.Equal(persisted.Version, fixture.LastSnapshot.Version);
        Assert.Null(fixture.LastSnapshot!.Output);
        HttpContext retryContext = AuthenticatedContext();
        IResult retry = await BinaryEndpoints.HandleDocumentExportRetryAsync(retryContext,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        await AssertDeniedAsync(retryContext, retry);
        HttpContext downloadContext = AuthenticatedContext();
        IResult download = await BinaryEndpoints.HandleDocumentExportDownloadAsync(downloadContext,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        await AssertDeniedAsync(downloadContext, download);
    }

    [Fact]
    [Trait("Platform", "Unix")]
    public async Task DurableExpiry_ReturnsActualExpiredProjectionAndDeniesDownload()
    {
        using var fixture = new DurableFixture();
        await BinaryEndpoints.HandleDocumentExportRequestAsync(AuthenticatedContext(fixture.Binding, fixture.Task),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        fixture.Time.Now = fixture.LastSnapshot!.ExpiresAt.AddSeconds(1);
        await BinaryEndpoints.HandleDocumentExportStatusAsync(AuthenticatedContext(),
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        Assert.Equal(DocumentExportTaskStatus.Expired, fixture.LastSnapshot!.Task.Status);
        Assert.Equal("expired", fixture.LastSnapshot.Reason);
        Assert.Null(fixture.LastSnapshot.Output);
        HttpContext downloadContext = AuthenticatedContext();
        IResult download = await BinaryEndpoints.HandleDocumentExportDownloadAsync(downloadContext,
            fixture.Service(), fixture.Binding, new AedsEncoder(), default);
        await AssertDeniedAsync(downloadContext, download);
    }

    [Fact]
    [Trait("Platform", "Unix")]
    public async Task DurableSnapshot_ProjectsCanonicalDigestsThroughClosedPayloadWithoutResealing()
    {
        using var fixture = new DurableFixture();
        await fixture.Service().CreateAsync(Actor(), fixture.Task, fixture.Input, default);
        DocumentExportJobSnapshot persisted = await fixture.Service().GetAsync(Actor(), fixture.Task.TaskId, default);
        var projected = DocumentExportEndpointBinding.Project(persisted);
        byte[] payload = PodBinaryCodec.EncodeDocumentExportJobResponse(projected);
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportJobResponse(payload, out var decoded));
        Assert.Equal(fixture.Input.ContentDigest, decoded.InputDigest);
        Assert.Equal(persisted.Task.ContentDigest, decoded.TaskDigest);
        Assert.StartsWith("sha256:", decoded.TaskDigest);
        Assert.Equal((int)DocumentExportTaskStatus.Queued, decoded.Status);
        Assert.Null(decoded.Output);
        Assert.DoesNotContain("private-endpoint-source", Encoding.UTF8.GetString(payload));
        Assert.DoesNotContain(Actor().SiteScope, Encoding.UTF8.GetString(payload));
        Assert.DoesNotContain(Actor().SessionId, Encoding.UTF8.GetString(payload));
        Assert.Equal(payload, PodBinaryCodec.EncodeDocumentExportJobResponse(decoded));
    }

    private sealed class DurableTime : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class DurableAuthorization : IDocumentExportJobAuthorization
    {
        public bool Allowed { get; set; } = true;
        public int Calls
        {
            get; private set;
        }

        public ValueTask<bool> IsAllowedAsync(DocumentExportJobActor actor, DocumentExportArticleCoordinate coordinate,
            DocumentExportJobOperation operation, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Calls++;
            return ValueTask.FromResult(Allowed && actor == Actor());
        }
    }

    private sealed class DurableFixture : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), $"fsusblog-endpoint-jobs-{Guid.NewGuid():N}");
        private readonly Microsoft.AspNetCore.DataProtection.EphemeralDataProtectionProvider _protection = new();
        private readonly ReleaseStorageLayout _layout;
        public DurableAuthorization Authorization { get; } = new();
        public DurableTime Time { get; } = new();
        public IDocumentExportEndpointBinding Binding { get; } = Substitute.For<IDocumentExportEndpointBinding>();
        public DocumentExportTask Task
        {
            get; set;
        }
        public DocumentExportFrozenInput Input
        {
            get;
        }
        public DocumentExportJobSnapshot? LastSnapshot
        {
            get; private set;
        }
        public ImmutableArray<DocumentExportJobSnapshot> LastPage { get; private set; } = [];
        public bool LastPageHasMore
        {
            get; private set;
        }
        public string JobRoot => Path.Combine(_layout.Paths.PrivateAssetRoot, "document-export");
        public string StatePath => Path.Combine(JobRoot, "state.bin");

        public DurableFixture(string format = "self-contained-html")
        {
            _layout = new ReleaseStorageLayout(Path.Combine(_root, "shared"), Path.Combine(_root, "derived"),
                Path.Combine(_root, "assets"), Path.Combine(_root, "instances"), "20261008060000-0123456789ab",
                "blue", "endpoint-tests", Path.Combine(_root, "webroot"));
            Directory.CreateDirectory(_layout.Paths.PrivateAssetRoot);
            Directory.CreateDirectory(_layout.Paths.UploadCommitRoot);
            DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(format);
            Input = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidInput("# private-endpoint-source") with
            {
                UserId = Actor().UserId,
                SiteScope = Actor().SiteScope,
                RendererId = provider.RendererId,
                RendererVersion = provider.RendererVersion
            });
            Task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(Input) with
            {
                FormatId = format,
                ProviderId = provider.ProviderId,
                ProviderVersion = provider.ProviderVersion
            });
            string taskId = Task.TaskId;
            Binding.ResolveActorAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(Actor());
            Binding.FreezeDecodedRequestAsync(Arg.Any<HttpContext>(), Actor(),
                Arg.Any<DocumentExportRequestCoreModel>(), Arg.Any<CancellationToken>())
                .Returns(_ => (Task, Input));
            Binding.ReadTaskIdAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(taskId);
            Binding.WriteSnapshot(Arg.Any<DocumentExportJobSnapshot>(), Arg.Any<IAedsEncoder>()).Returns(call =>
            {
                LastSnapshot = call.Arg<DocumentExportJobSnapshot>();
                // Keep this handler fixture independent of Shared frame registration;
                // record the real projection without claiming a wire receipt.
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "Controlled job writer unavailable"),
                    call.Arg<IAedsEncoder>());
            });
            Binding.WritePage(Arg.Any<ImmutableArray<DocumentExportJobSnapshot>>(), Arg.Any<int>(), Arg.Any<int>(), Arg.Any<bool>(),
                Arg.Any<IAedsEncoder>()).Returns(call =>
            {
                LastPage = call.Arg<ImmutableArray<DocumentExportJobSnapshot>>();
                LastPageHasMore = call.Arg<bool>();
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "Controlled job writer unavailable"),
                    call.Arg<IAedsEncoder>());
            });
        }

        public DocumentExportJobService Service() => new(_layout, _protection, Authorization, Time);

        public void Dispose()
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
    }

    private static DocumentExportJobActor Actor() => new(42, "https://export.example/site", "admin-session");

    private static IDocumentExportEndpointBinding Binding()
    {
        IDocumentExportEndpointBinding binding = Substitute.For<IDocumentExportEndpointBinding>();
        binding.ResolveActorAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(Actor());
        binding.ReadTaskIdAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns("task");
        return binding;
    }

    private static HttpContext AuthenticatedContext(IDocumentExportEndpointBinding? binding = null, DocumentExportTask? task = null)
    {
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().AddLogging()
                .AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(
                    new Dictionary<string, string?> { ["SITE_BASEURL"] = $" {Actor().SiteScope}/ " }).Build())
                .BuildServiceProvider(),
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", "admin_principal"),
                new Claim("admin_id", "42"),
                new Claim("admin_sid", "admin-session"),
                new Claim("sid", "anonymous-session-must-not-be-used")
            ], "fixture-admin"))
        };
        if (binding is not null)
        {
            ConfigureSelection(context, binding, task);
        }
        return context;
    }

    private static void ConfigureSelection(HttpContext context, IDocumentExportEndpointBinding binding,
        DocumentExportTask? task = null)
    {
        task ??= DocumentExportContractTests.ValidTask(DocumentExportContractTests.ValidInput());
        var request = new DocumentExportRequestCoreModel(task.RequestId, task.IdempotencyKey,
            new((int)task.Coordinate.Kind, task.Coordinate.ArticleId, task.Coordinate.DraftKey,
                task.Coordinate.RevisionId, task.Coordinate.PublicationId, task.Coordinate.SourceVersion),
            task.FormatId, task.LayoutProfile, task.ThemeProfile, task.Locale);
        var encoder = new AedsEncoder();
        var requests = Substitute.For<IBinaryEndpointRequestContext>();
        requests.ReadFrameAsync(context, encoder, AedsFrameType.DocumentExportRequest,
            Arg.Any<CancellationToken>(), PodBinaryCodec.MaximumDocumentExportRequestFrameBytes)
            .Returns(BinaryRequestPayload.Success(PodBinaryCodec.EncodeDocumentExportRequest(request),
                AedsFrameType.DocumentExportRequest));
        var catalog = Substitute.For<IDocumentExportSourceCatalog>();
        catalog.ReadBoundAsync(Actor(), task.Coordinate, Arg.Any<CancellationToken>())
            .Returns(new DocumentExportBoundSource(new("controlled-choice", "controlled-label", task.Coordinate),
                "controlled-fingerprint", null, null, null, null, null));
        IConfiguration configuration = context.RequestServices.GetRequiredService<IConfiguration>();
        context.RequestServices = new ServiceCollection().AddLogging()
            .AddSingleton(configuration).AddSingleton<IAedsEncoder>(encoder)
            .AddScoped(_ => new DocumentExportSourceSelectionAdapter(binding, requests, catalog))
            .BuildServiceProvider();
    }

    private static async Task AssertDeniedAsync(HttpContext context, IResult result)
    {
        await using var body = new MemoryStream();
        context.Response.Body = body;
        await result.ExecuteAsync(context);
        Assert.Equal(404, context.Response.StatusCode);
        Assert.Equal("no-store", context.Response.Headers.CacheControl);
        Assert.NotEmpty(body.ToArray());
    }
}
