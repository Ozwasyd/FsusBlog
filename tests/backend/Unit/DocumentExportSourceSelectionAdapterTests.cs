using System.Buffers;
using System.Buffers.Binary;
using System.Security.Claims;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportSourceSelectionAdapterTests
{
    [Theory]
    [InlineData(1, 9007199254740993L)]
    [InlineData(2, long.MaxValue)]
    [InlineData(3, 9007199254740995L)]
    public async Task ExactRequest_ReadsOneBoundedFrameAndBindsActualActor(int kind, long version)
    {
        using var fixture = new AdmissionFixture(Source(kind, version));
        DocumentExportBoundSource expected = fixture.BoundSource;
        fixture.Catalog.ReadBoundAsync(fixture.Actor, fixture.Coordinate, default).Returns(call =>
        {
            Assert.Equal(1, fixture.Pool.Returns);
            return Task.FromResult(expected);
        });
        fixture.Context.Response.Headers.CacheControl = "private, no-store";
        DocumentExportSourceSelectionAdmission admission = await fixture.Adapter.ReadAsync(fixture.Context, default);
        Assert.Equal("private, no-store", fixture.Context.Response.Headers.CacheControl.ToString());
        Assert.Same(fixture.Actor, admission.Actor);
        Assert.Equal(fixture.Request, admission.Request);
        Assert.Same(expected, admission.BoundSource);
        Assert.Equal(version, admission.Request.Source.SourceVersion);
        Assert.Equal(version, admission.BoundSource.Choice.Coordinate.SourceVersion);
        Assert.NotEqual(admission.Request.Source.RevisionId, version);
        await fixture.Binding.Received(1).ResolveActorAsync(fixture.Context, default);
        await fixture.RequestContext.Received(1).ReadFrameAsync(fixture.Context, fixture.Encoder,
            AedsFrameType.DocumentExportRequest, default, PodBinaryCodec.MaximumDocumentExportRequestFrameBytes);
        await fixture.Catalog.Received(1).ReadBoundAsync(fixture.Actor, fixture.Coordinate, default);
        Assert.Single(fixture.Catalog.ReceivedCalls());
        Assert.Equal(1, fixture.Pool.Rents);
        Assert.Equal(1, fixture.Pool.Returns);
        Assert.DoesNotContain(fixture.Binding.ReceivedCalls(), call => call.GetMethodInfo().Name == "FreezeRequestAsync");
    }

    [Fact]
    public async Task ActualBinding_ResolvesAuthenticatedSessionSiteAndOwner()
    {
        using var fixture = new AdmissionFixture();
        fixture.Context.User = new ClaimsPrincipal(new ClaimsIdentity(
        [
            new Claim("identity_kind", "admin_principal"),
            new Claim("admin_id", "7"),
            new Claim("admin_sid", fixture.Actor.SessionId),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ], "test"));
        var binding = new DocumentExportEndpointBinding(Substitute.For<IDocumentExportRequestFreezer>(), fixture.RequestContext);
        var adapter = new DocumentExportSourceSelectionAdapter(binding, fixture.RequestContext, fixture.Catalog);
        DocumentExportSourceSelectionAdmission admission = await adapter.ReadAsync(fixture.Context, default);
        Assert.Equal(fixture.Actor, admission.Actor);
        await fixture.Catalog.Received(1).ReadBoundAsync(fixture.Actor, fixture.Coordinate, default);
    }

    [Fact]
    public async Task ActorDenied_DoesNotReadBodyOrCatalog()
    {
        using var fixture = new AdmissionFixture();
        var binding = new DocumentExportEndpointBinding(Substitute.For<IDocumentExportRequestFreezer>(), fixture.RequestContext);
        var adapter = new DocumentExportSourceSelectionAdapter(binding, fixture.RequestContext, fixture.Catalog);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => adapter.ReadAsync(fixture.Context, default));
        Assert.Empty(fixture.RequestContext.ReceivedCalls());
        Assert.Empty(fixture.Catalog.ReceivedCalls());
    }

    [Theory]
    [InlineData("frame")]
    [InlineData("truncated")]
    [InlineData("trailing")]
    [InlineData("future")]
    [InlineData("content-type")]
    [InlineData("oversized")]
    public async Task InvalidBody_RejectsOriginalCodecAndFrameFailures(string failure)
    {
        using var fixture = new AdmissionFixture();
        byte[] payload = PodBinaryCodec.EncodeDocumentExportRequest(fixture.Request);
        if (failure == "truncated")
        {
            payload = payload[..^1];
        }
        if (failure == "trailing")
        {
            payload = [.. payload, 0];
        }
        if (failure == "future")
        {
            BinaryPrimitives.WriteInt32LittleEndian(payload, 2);
        }
        fixture.SetBody(fixture.Encoder.Encode(failure == "frame"
            ? AedsFrameType.DocumentExportTaskRequest : AedsFrameType.DocumentExportRequest, payload));
        if (failure == "content-type")
        {
            fixture.Context.Request.ContentType = "application/json";
        }
        if (failure == "oversized")
        {
            fixture.Context.Request.ContentLength = PodBinaryCodec.MaximumDocumentExportRequestFrameBytes + 1;
        }
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => fixture.Adapter.ReadAsync(fixture.Context, default));
        Assert.Empty(fixture.Catalog.ReceivedCalls());
        Assert.Single(fixture.RequestContext.ReceivedCalls());
        Assert.Equal(fixture.Pool.Rents, fixture.Pool.Returns);
    }

    [Theory]
    [InlineData("article-range")]
    [InlineData("draft-padding")]
    [InlineData("draft-length")]
    public async Task CatalogCoordinate_RejectsBeforeCatalogRead(string failure)
    {
        DocumentExportSourceCoreModel source = failure switch
        {
            "article-range" => Source(2, 9) with { ArticleId = (long)int.MaxValue + 1 },
            "draft-padding" => Source(1, 9) with { DraftKey = " owned " },
            _ => Source(1, 9) with { DraftKey = new string('a', 97) }
        };
        using var fixture = new AdmissionFixture(source);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => fixture.Adapter.ReadAsync(fixture.Context, default));
        Assert.Empty(fixture.Catalog.ReceivedCalls());
        Assert.Equal(1, fixture.Pool.Returns);
    }

    [Theory]
    [InlineData("kind")]
    [InlineData("article")]
    [InlineData("draft")]
    [InlineData("revision")]
    [InlineData("publication")]
    [InlineData("version")]
    public async Task ReturnedCoordinate_RejectsEverySourceIdentityMismatch(string field)
    {
        using var fixture = new AdmissionFixture(Source(3, 9007199254740993L));
        DocumentExportArticleCoordinate different = field switch
        {
            "kind" => fixture.Coordinate with { Kind = DocumentExportCoordinateKind.Revision },
            "article" => fixture.Coordinate with { ArticleId = 43 },
            "draft" => fixture.Coordinate with { DraftKey = "other" },
            "revision" => fixture.Coordinate with { RevisionId = 18 },
            "publication" => fixture.Coordinate with { PublicationId = 10 },
            _ => fixture.Coordinate with { SourceVersion = 9007199254740992L }
        };
        fixture.Catalog.ReadBoundAsync(fixture.Actor, fixture.Coordinate, default).Returns(fixture.BoundSource with
        {
            Choice = fixture.BoundSource.Choice with
            {
                Coordinate = different
            }
        });
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => fixture.Adapter.ReadAsync(fixture.Context, default));
        Assert.Equal(1, fixture.Pool.Returns);
    }

    [Theory]
    [InlineData("entry")]
    [InlineData("actor")]
    [InlineData("body")]
    public async Task CancellationBeforeCatalog_StopsTheNextAuthority(string stage)
    {
        using var fixture = new AdmissionFixture();
        using var cancellation = new CancellationTokenSource();
        CancellationToken token = cancellation.Token;
        fixture.Binding.ResolveActorAsync(fixture.Context, token).Returns(call =>
        {
            if (stage == "actor")
            {
                cancellation.Cancel();
            }
            return Task.FromResult(fixture.Actor);
        });
        fixture.ReadFrame = _ =>
        {
            var lease = new BinaryRequestBufferLease(fixture.Pool, 1);
            cancellation.Cancel();
            return Task.FromResult(BinaryRequestPayload.Success(lease, AedsFrameType.DocumentExportRequest));
        };
        if (stage == "entry")
        {
            cancellation.Cancel();
        }
        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Adapter.ReadAsync(fixture.Context, token));
        Assert.Equal(token, error.CancellationToken);
        Assert.Empty(fixture.Catalog.ReceivedCalls());
        Assert.Equal(stage == "entry" ? 0 : 1, fixture.Binding.ReceivedCalls().Count());
        Assert.Equal(stage == "body" ? 1 : 0, fixture.RequestContext.ReceivedCalls().Count());
        Assert.Equal(fixture.Pool.Rents, fixture.Pool.Returns);
    }

    [Fact]
    public async Task CancellationDuringCatalogAwait_RejectsReturnedSource()
    {
        using var fixture = new AdmissionFixture();
        using var cancellation = new CancellationTokenSource();
        var completion = new TaskCompletionSource<DocumentExportBoundSource>(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Catalog.ReadBoundAsync(fixture.Actor, fixture.Coordinate, cancellation.Token).Returns(call =>
        {
            entered.SetResult();
            return completion.Task;
        });
        Task<DocumentExportSourceSelectionAdmission> pending = fixture.Adapter.ReadAsync(fixture.Context, cancellation.Token);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Single(fixture.Catalog.ReceivedCalls());
        Assert.False(pending.IsCompleted);
        Assert.Equal(1, fixture.Pool.Returns);
        cancellation.Cancel();
        completion.SetResult(fixture.BoundSource);
        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Equal(cancellation.Token, error.CancellationToken);
    }

    [Fact]
    public async Task CatalogCancellation_PropagatesOriginalToken()
    {
        using var fixture = new AdmissionFixture();
        using var cancellation = new CancellationTokenSource();
        fixture.Catalog.ReadBoundAsync(fixture.Actor, fixture.Coordinate, cancellation.Token).Returns(call =>
        {
            cancellation.Cancel();
            return Task.FromCanceled<DocumentExportBoundSource>(cancellation.Token);
        });
        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Adapter.ReadAsync(fixture.Context, cancellation.Token));
        Assert.Equal(cancellation.Token, error.CancellationToken);
        Assert.Equal(1, fixture.Pool.Returns);
    }

    [Theory]
    [InlineData("denied")]
    [InlineData("capacity")]
    public async Task KnownCatalogRefusals_MapToUnifiedJobDenial(string refusal)
    {
        using var fixture = new AdmissionFixture();
        Exception expected = refusal == "denied" ? new DocumentExportSourceDeniedException() : new DocumentExportSourceCapacityException();
        fixture.Catalog.ReadBoundAsync(fixture.Actor, fixture.Coordinate, default)
            .Returns(Task.FromException<DocumentExportBoundSource>(expected));
        DocumentExportJobDeniedException error = await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() =>
            fixture.Adapter.ReadAsync(fixture.Context, default));
        Assert.Equal(new DocumentExportJobDeniedException().Message, error.Message);
        Assert.Null(error.InnerException);
        Assert.Equal(1, fixture.Pool.Returns);
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("body")]
    [InlineData("catalog")]
    public async Task UnexpectedFailures_PropagateOriginalException(string stage)
    {
        using var fixture = new AdmissionFixture();
        var expected = new IOException("original-owner-failure");
        if (stage == "actor")
        {
            fixture.Binding.ResolveActorAsync(fixture.Context, default).Returns(Task.FromException<DocumentExportJobActor>(expected));
        }
        else if (stage == "body")
        {
            fixture.ReadFrame = _ => Task.FromException<BinaryRequestPayload>(expected);
        }
        else
        {
            fixture.Catalog.ReadBoundAsync(fixture.Actor, fixture.Coordinate, default)
                .Returns(Task.FromException<DocumentExportBoundSource>(expected));
        }
        Assert.Same(expected, await Assert.ThrowsAsync<IOException>(() => fixture.Adapter.ReadAsync(fixture.Context, default)));
        Assert.Equal(fixture.Pool.Rents, fixture.Pool.Returns);
    }

    private static DocumentExportSourceCoreModel Source(int kind, long version)
        => new(kind, 42, kind == 1 ? "精确草稿-🌍" : null, kind == 1 ? null : 17, kind == 3 ? 9 : null, version);

    private sealed class AdmissionFixture : IDisposable
    {
        private readonly ServiceProvider _services;

        internal AdmissionFixture(DocumentExportSourceCoreModel? source = null)
        {
            IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SITE_BASEURL"] = "https://example.test/"
            }).Build();
            _services = new ServiceCollection().AddSingleton<IAedsEncoder>(Encoder).AddSingleton(configuration).BuildServiceProvider();
            Context.RequestServices = _services;
            Request = DocumentExportBinaryCodecTests.Request() with
            {
                Source = source ?? Source(2, 9007199254740993L)
            };
            Coordinate = new((DocumentExportCoordinateKind)Request.Source.Kind, Request.Source.ArticleId, Request.Source.DraftKey,
                Request.Source.RevisionId, Request.Source.PublicationId, Request.Source.SourceVersion);
            BoundSource = new(new(new string('a', 64), "private label", Coordinate), "private fingerprint", null, null, null, null, null);
            Binding.ResolveActorAsync(Context, Arg.Any<CancellationToken>()).Returns(Actor);
            var binder = new BinaryRequestBinder(Pool);
            ReadFrame = token => binder.ReadFrameAsync(Context, Encoder, AedsFrameType.DocumentExportRequest, token,
                PodBinaryCodec.MaximumDocumentExportRequestFrameBytes);
            RequestContext.ReadFrameAsync(Context, Encoder, AedsFrameType.DocumentExportRequest,
                Arg.Any<CancellationToken>(), PodBinaryCodec.MaximumDocumentExportRequestFrameBytes).Returns(call =>
                    ReadFrame(call.Arg<CancellationToken>()));
            Catalog.ReadBoundAsync(Actor, Coordinate, Arg.Any<CancellationToken>()).Returns(BoundSource);
            Adapter = new(Binding, RequestContext, Catalog);
            SetBody(Encoder.Encode(AedsFrameType.DocumentExportRequest, PodBinaryCodec.EncodeDocumentExportRequest(Request)));
        }

        internal DocumentExportJobActor Actor { get; } = new(7, "https://example.test", "actual-session");
        internal DefaultHttpContext Context { get; } = new();
        internal AedsEncoder Encoder { get; } = new();
        internal IDocumentExportEndpointBinding Binding { get; } = Substitute.For<IDocumentExportEndpointBinding>();
        internal IBinaryEndpointRequestContext RequestContext { get; } = Substitute.For<IBinaryEndpointRequestContext>();
        internal IDocumentExportSourceCatalog Catalog { get; } = Substitute.For<IDocumentExportSourceCatalog>();
        internal RecordingPool Pool { get; } = new();
        internal DocumentExportRequestCoreModel Request
        {
            get;
        }
        internal DocumentExportArticleCoordinate Coordinate
        {
            get;
        }
        internal DocumentExportBoundSource BoundSource
        {
            get;
        }
        internal DocumentExportSourceSelectionAdapter Adapter
        {
            get;
        }
        internal Func<CancellationToken, Task<BinaryRequestPayload>> ReadFrame
        {
            get; set;
        }

        internal void SetBody(byte[] frame)
        {
            Context.Request.Body.Dispose();
            Context.Request.Body = new MemoryStream(frame);
            Context.Request.ContentType = "application/octet-stream";
            Context.Request.ContentLength = frame.Length;
        }

        public void Dispose()
        {
            Context.Request.Body.Dispose();
            _services.Dispose();
        }
    }

    private sealed class RecordingPool : ArrayPool<byte>
    {
        internal int Rents
        {
            get; private set;
        }
        internal int Returns
        {
            get; private set;
        }

        public override byte[] Rent(int minimumLength)
        {
            Rents++;
            return new byte[minimumLength];
        }

        public override void Return(byte[] array, bool clearArray = false)
        {
            Returns++;
            Array.Fill(array, (byte)0xff);
        }
    }
}
