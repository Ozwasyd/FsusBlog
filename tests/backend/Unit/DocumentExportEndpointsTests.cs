using System.Collections.Immutable;
using System.Security.Claims;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport.Jobs;

using NSubstitute;
using NSubstitute.ExceptionExtensions;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Endpoint adapter controls; these substitutes do not qualify real jobs or output storage.</summary>
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
            .Returns(new DocumentExportJobActor(99, 7, "admin-session"));

        IResult result = await BinaryEndpoints.HandleDocumentExportStatusAsync(
            context, jobs, binding, new AedsEncoder(), default);
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
        context.RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider();
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

    private static DocumentExportJobActor Actor() => new(42, 7, "admin-session");

    private static IDocumentExportEndpointBinding Binding()
    {
        IDocumentExportEndpointBinding binding = Substitute.For<IDocumentExportEndpointBinding>();
        binding.ResolveActorAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(Actor());
        binding.ReadTaskIdAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns("task");
        return binding;
    }

    private static HttpContext AuthenticatedContext()
        => new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", "admin_principal"),
                new Claim("admin_id", "42"),
                new Claim("admin_sid", "admin-session"),
                new Claim("sid", "anonymous-session-must-not-be-used")
            ], "fixture-admin"))
        };

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
