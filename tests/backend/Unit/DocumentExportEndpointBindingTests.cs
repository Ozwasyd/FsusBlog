using System.Buffers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportEndpointBindingTests
{
    [Fact]
    public async Task AnonymousActor_RejectsWithoutFreezingOrReadingFrames()
    {
        var freezer = Substitute.For<IDocumentExportRequestFreezer>();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        var binding = new DocumentExportEndpointBinding(freezer, requestContext);
        var context = new DefaultHttpContext { RequestServices = new ServiceCollection().BuildServiceProvider() };
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => binding.ResolveActorAsync(context, default));
        Assert.Empty(freezer.ReceivedCalls());
        Assert.Empty(requestContext.ReceivedCalls());
    }

    [Fact]
    public async Task CancelledActor_RejectsBeforeAnyAuthorityRead()
    {
        var freezer = Substitute.For<IDocumentExportRequestFreezer>();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        var binding = new DocumentExportEndpointBinding(freezer, requestContext);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => binding.ResolveActorAsync(new DefaultHttpContext(), cancellation.Token));
        Assert.Empty(freezer.ReceivedCalls());
        Assert.Empty(requestContext.ReceivedCalls());
    }

    [Theory]
    [InlineData("UserLoginRequest")]
    [InlineData("999")]
    [InlineData("documentexportrequest")]
    [InlineData("DocumentExportRequest ")]
    public void FrameResolver_RejectsOtherFamiliesNumericAliasesAndNormalization(string name)
        => Assert.Throws<InvalidDataException>(() => DocumentExportEndpointBinding.RequireRegisteredFrame(name));

    [Theory]
    [InlineData("DocumentExportRequest", AedsFrameType.DocumentExportRequest)]
    [InlineData("DocumentExportTaskRequest", AedsFrameType.DocumentExportTaskRequest)]
    [InlineData("DocumentExportJobResponse", AedsFrameType.DocumentExportJobResponse)]
    [InlineData("DocumentExportPageResponse", AedsFrameType.DocumentExportPageResponse)]
    public void FrameResolver_ConsumesOnlyTheExactSharedRegistrationOrRefuses(string name, AedsFrameType expected)
    {
        Assert.Equal(expected, DocumentExportEndpointBinding.RequireRegisteredFrame(name));
    }

    [Fact]
    public void FrozenAdmission_PreservesOriginalAuthorityAndSealedBytes()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        DocumentExportRequestCoreModel request = Request(task);
        DocumentExportEndpointBinding.RequireFrozenRequestMatch(request,
            new(input.UserId, input.SiteScope, "existing-session"), task, input);
        Assert.Equal(input.ContentDigest, task.InputDigest);
        Assert.Equal(DocumentExportDigest.Compute(task with
        {
            ContentDigest = string.Empty
        }), task.ContentDigest);
    }

    [Theory]
    [InlineData("request")]
    [InlineData("idempotency")]
    [InlineData("coordinate")]
    [InlineData("format")]
    [InlineData("layout")]
    [InlineData("theme")]
    [InlineData("locale")]
    [InlineData("owner")]
    [InlineData("site")]
    public void FrozenAdmission_RejectsAnyMismatchWithoutResealing(string field)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        DocumentExportRequestCoreModel request = Request(task);
        var actor = new DocumentExportJobActor(input.UserId, input.SiteScope, "existing-session");
        request = field switch
        {
            "request" => request with { RequestId = "other-request" },
            "idempotency" => request with { IdempotencyKey = "other-key" },
            "coordinate" => request with { Source = request.Source with { SourceVersion = request.Source.SourceVersion + 1 } },
            "format" => request with { FormatId = "pdf" },
            "layout" => request with { LayoutProfile = "other-layout" },
            "theme" => request with { ThemeProfile = "other-theme" },
            "locale" => request with { Locale = "other-locale" },
            _ => request
        };
        actor = field switch
        {
            "owner" => actor with { UserId = actor.UserId + 1 },
            "site" => actor with { SiteScope = "https://other.example" },
            _ => actor
        };
        Assert.Throws<DocumentExportJobDeniedException>(() =>
            DocumentExportEndpointBinding.RequireFrozenRequestMatch(request, actor, task, input));
    }

    [Fact]
    public void FrozenAdmission_RejectsChangedInputDigestRatherThanRepairingIt()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        Assert.Throws<InvalidDataException>(() => DocumentExportEndpointBinding.RequireFrozenRequestMatch(Request(task),
            new(input.UserId, input.SiteScope, "existing-session"), task, input with
            {
                ContentDigest = "sha256:" + new string('0', 64)
            }));
    }

    [Fact]
    public async Task DecodedAdmission_FreezesOnceWithoutReadingFrames()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        DocumentExportRequestCoreModel request = Request(task);
        var actor = new DocumentExportJobActor(input.UserId, input.SiteScope, "existing-session");
        var context = new DefaultHttpContext();
        var freezer = Substitute.For<IDocumentExportRequestFreezer>();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        freezer.FreezeAsync(context, actor, request, default).Returns((task, input));
        IDocumentExportEndpointBinding binding = new DocumentExportEndpointBinding(freezer, requestContext);

        Assert.Equal((task, input), await binding.FreezeDecodedRequestAsync(context, actor, request, default));
        await freezer.Received(1).FreezeAsync(context, actor, request, default);
        Assert.Empty(requestContext.ReceivedCalls());
    }

    [Fact]
    public async Task FrameAdmission_ReadsOnceAndUsesTheDecodedHandoff()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        DocumentExportRequestCoreModel request = Request(task);
        var actor = new DocumentExportJobActor(input.UserId, input.SiteScope, "existing-session");
        var encoder = new AedsEncoder();
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().AddSingleton<IAedsEncoder>(encoder).BuildServiceProvider()
        };
        var bytes = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WriteDocumentExportRequest(request, bytes);
        var freezer = Substitute.For<IDocumentExportRequestFreezer>();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        freezer.FreezeAsync(context, actor, request, default).Returns((task, input));
        requestContext.ReadFrameAsync(context, encoder, AedsFrameType.DocumentExportRequest,
            default, PodBinaryCodec.MaximumDocumentExportRequestFrameBytes)
            .Returns(BinaryRequestPayload.Success(bytes.WrittenMemory, AedsFrameType.DocumentExportRequest));
        var binding = new DocumentExportEndpointBinding(freezer, requestContext);

        Assert.Equal((task, input), await binding.FreezeRequestAsync(context, actor, default));
        await requestContext.Received(1).ReadFrameAsync(context, encoder, AedsFrameType.DocumentExportRequest,
            default, PodBinaryCodec.MaximumDocumentExportRequestFrameBytes);
        await freezer.Received(1).FreezeAsync(context, actor, request, default);
    }

    [Fact]
    public async Task DecodedAdmission_RejectsChangedCoordinateWithoutReadingFrames()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        DocumentExportRequestCoreModel request = Request(task);
        request = request with
        {
            Source = request.Source with
            {
                SourceVersion = request.Source.SourceVersion + 1
            }
        };
        var actor = new DocumentExportJobActor(input.UserId, input.SiteScope, "existing-session");
        var context = new DefaultHttpContext();
        var freezer = Substitute.For<IDocumentExportRequestFreezer>();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        freezer.FreezeAsync(context, actor, request, default).Returns((task, input));
        var binding = new DocumentExportEndpointBinding(freezer, requestContext);

        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() =>
            binding.FreezeDecodedRequestAsync(context, actor, request, default));
        Assert.Empty(requestContext.ReceivedCalls());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DecodedAdmission_PreservesCancellationBeforeAndAfterFreeze(bool cancelAfterFreeze)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        DocumentExportRequestCoreModel request = Request(task);
        var actor = new DocumentExportJobActor(input.UserId, input.SiteScope, "existing-session");
        var context = new DefaultHttpContext();
        var freezer = Substitute.For<IDocumentExportRequestFreezer>();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        using var cancellation = new CancellationTokenSource();
        freezer.FreezeAsync(context, actor, request, cancellation.Token).Returns(_ =>
        {
            cancellation.Cancel();
            return Task.FromResult((task, input));
        });
        if (!cancelAfterFreeze)
        {
            cancellation.Cancel();
        }
        var binding = new DocumentExportEndpointBinding(freezer, requestContext);

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            binding.FreezeDecodedRequestAsync(context, actor, request, cancellation.Token));
        Assert.Equal(cancelAfterFreeze ? 1 : 0, freezer.ReceivedCalls().Count());
        Assert.Empty(requestContext.ReceivedCalls());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DecodedAdmission_MapsOnlyKnownCatalogRefusals(bool capacity)
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        DocumentExportRequestCoreModel request = Request(task);
        var actor = new DocumentExportJobActor(input.UserId, input.SiteScope, "existing-session");
        var context = new DefaultHttpContext();
        var freezer = Substitute.For<IDocumentExportRequestFreezer>();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        Exception refusal = capacity ? new DocumentExportSourceCapacityException() : new DocumentExportSourceDeniedException();
        freezer.FreezeAsync(context, actor, request, default)
            .Returns(Task.FromException<(DocumentExportTask, DocumentExportFrozenInput)>(refusal));
        var binding = new DocumentExportEndpointBinding(freezer, requestContext);

        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() =>
            binding.FreezeDecodedRequestAsync(context, actor, request, default));
        Assert.Empty(requestContext.ReceivedCalls());
    }

    [Fact]
    public async Task DecodedAdmission_PropagatesUnrelatedFailures()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput();
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        DocumentExportRequestCoreModel request = Request(task);
        var actor = new DocumentExportJobActor(input.UserId, input.SiteScope, "existing-session");
        var context = new DefaultHttpContext();
        var freezer = Substitute.For<IDocumentExportRequestFreezer>();
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        var failure = new InvalidOperationException("controlled-unrelated-failure");
        freezer.FreezeAsync(context, actor, request, default)
            .Returns(Task.FromException<(DocumentExportTask, DocumentExportFrozenInput)>(failure));
        var binding = new DocumentExportEndpointBinding(freezer, requestContext);

        Assert.Same(failure, await Assert.ThrowsAsync<InvalidOperationException>(() =>
            binding.FreezeDecodedRequestAsync(context, actor, request, default)));
        Assert.Empty(requestContext.ReceivedCalls());
    }

    private static DocumentExportRequestCoreModel Request(DocumentExportTask task)
        => new(task.RequestId, task.IdempotencyKey,
            new((int)task.Coordinate.Kind, task.Coordinate.ArticleId, task.Coordinate.DraftKey,
                task.Coordinate.RevisionId, task.Coordinate.PublicationId, task.Coordinate.SourceVersion),
            task.FormatId, task.LayoutProfile, task.ThemeProfile, task.Locale);
}
