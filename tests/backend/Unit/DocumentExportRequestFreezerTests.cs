using System.Collections.Immutable;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Controlled source/permission composition only; no HTTP, native, storage or receipt qualification.</summary>
public sealed class DocumentExportRequestFreezerTests
{
    [Fact]
    public async Task RepeatedExactAdmission_KeepsCanonicalIdsAndDigests()
    {
        var fixture = new Fixture();
        (DocumentExportTask firstTask, DocumentExportFrozenInput firstInput) = await fixture.FreezeAsync();
        (DocumentExportTask secondTask, DocumentExportFrozenInput secondInput) = await fixture.FreezeAsync();
        Assert.Equal(firstTask, secondTask);
        Assert.Equal(firstInput.InputId, secondInput.InputId);
        Assert.Equal(firstInput.ContentDigest, secondInput.ContentDigest);
        Assert.Equal(4, fixture.PermissionCalls);
        Assert.Equal(2, fixture.ReadCalls);
    }

    [Fact]
    public async Task CompleteFacts_CreateOwnedQueuedTaskThroughClosedCatalog()
    {
        var fixture = new Fixture();
        byte[] markdown = fixture.Facts.MarkdownUtf8.ToArray();
        fixture.Facts = Seal(fixture.Facts with
        {
            MarkdownUtf8 = ImmutableCollectionsMarshal.AsImmutableArray(markdown)
        });
        (DocumentExportTask task, DocumentExportFrozenInput input) = await fixture.FreezeAsync();
        markdown[0] ^= 1;

        DocumentExportContractValidator.Validate(task, input);
        Assert.Equal(DocumentExportTaskStatus.Queued, task.Status);
        Assert.Equal(fixture.Request.RequestId, task.RequestId);
        Assert.Equal(fixture.Request.IdempotencyKey, task.IdempotencyKey);
        Assert.Equal(fixture.Facts.Coordinate, input.Coordinate);
        Assert.Equal(fixture.Facts.SourceDigest, input.SourceDigest);
        Assert.Equal(input.ContentDigest, task.InputDigest);
        Assert.NotEqual(fixture.OriginalInput.InputId, input.InputId);
        Assert.Equal(2, fixture.PermissionCalls);
        Assert.Equal(1, fixture.ReadCalls);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("coordinate")]
    [InlineData("seal")]
    public async Task PersistedOwnerCoordinateOrSealDrift_IsRejected(string field)
    {
        var fixture = new Fixture();
        fixture.Facts = field switch
        {
            "owner" => Seal(fixture.Facts with { UserId = fixture.Actor.UserId + 1 }),
            "site" => Seal(fixture.Facts with { SiteScope = "https://other.example" }),
            "coordinate" => Seal(fixture.Facts with
            {
                Coordinate = fixture.Facts.Coordinate with
                {
                    SourceVersion = fixture.Facts.Coordinate.SourceVersion + 1
                }
            }),
            _ => fixture.Facts with { ContentDigest = "sha256:" + new string('0', 64) }
        };
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(fixture.FreezeAsync);
        Assert.Equal(1, fixture.PermissionCalls);
        Assert.Equal(1, fixture.ReadCalls);
    }

    [Fact]
    public async Task RevokedPermissionBeforeReturn_RejectsFrozenAdmission()
    {
        var fixture = new Fixture { RevokeBeforeReturn = true };
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(fixture.FreezeAsync);
        Assert.Equal(2, fixture.PermissionCalls);
        Assert.Equal(1, fixture.ReadCalls);
    }

    [Fact]
    public async Task CancelledAdmission_ReadsNoSourceOrPermission()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => fixture.Freezer.FreezeAsync(
            new DefaultHttpContext(), fixture.Actor, fixture.Request, cancellation.Token));
        Assert.Equal(0, fixture.PermissionCalls);
        Assert.Equal(0, fixture.ReadCalls);
    }

    [Fact]
    public async Task OversizedSource_IsRejectedBeforeFrozenAdmission()
    {
        var fixture = new Fixture();
        fixture.Facts = Seal(fixture.Facts with
        {
            MarkdownUtf8 = new byte[checked((int)DocumentExportJobPolicy.MaximumInputBytes + 1)].ToImmutableArray()
        });
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(fixture.FreezeAsync);
        Assert.Equal(1, fixture.PermissionCalls);
    }

    [Fact]
    public void MissingRealAuthority_RegistersNoTransportOrJobs()
    {
        var services = new ServiceCollection();
        Assert.Throws<InvalidOperationException>(() => services.AddDocumentExportTransport());
        Assert.Empty(services);
    }

    [Fact]
    public void ExplicitComposition_UsesSoleJobImplementationAndRejectsDuplicates()
    {
        var services = new ServiceCollection();
        services.AddScoped(_ => Substitute.For<IDocumentExportFrozenSourceReader>());
        services.AddScoped(_ => Substitute.For<IDocumentExportJobAuthorization>());
        services.AddDocumentExportTransport();
        Assert.Equal(typeof(DocumentExportJobService), Assert.Single(services,
            descriptor => descriptor.ServiceType == typeof(DocumentExportJobService)).ImplementationType);
        Assert.Equal(typeof(DocumentExportRequestFreezer), Assert.Single(services,
            descriptor => descriptor.ServiceType == typeof(IDocumentExportRequestFreezer)).ImplementationType);
        int count = services.Count;
        Assert.Throws<InvalidOperationException>(() => services.AddDocumentExportTransport());
        Assert.Equal(count, services.Count);
    }

    [Fact]
    public void MissingRouteAuthorities_MapsNoExportEndpoints()
    {
        using ServiceProvider provider = new ServiceCollection().BuildServiceProvider();
        var routes = new ControlledRoutes(provider);
        Assert.Throws<InvalidOperationException>(() => routes.MapDocumentExportEndpoints());
        Assert.Empty(routes.DataSources);
    }

    private static DocumentExportFrozenSourceFacts Seal(DocumentExportFrozenSourceFacts facts)
        => facts with
        {
            ContentDigest = DocumentExportDigest.Compute(facts with
            {
                ContentDigest = string.Empty
            })
        };

    private sealed class Fixture
    {
        internal DocumentExportFrozenInput OriginalInput { get; } = DocumentExportContractTests.ValidInput();
        internal DocumentExportFrozenSourceFacts Facts
        {
            get; set;
        }
        internal DocumentExportJobActor Actor
        {
            get;
        }
        internal DocumentExportRequestCoreModel Request
        {
            get;
        }
        internal DocumentExportRequestFreezer Freezer
        {
            get;
        }
        internal int PermissionCalls
        {
            get; private set;
        }
        internal int ReadCalls
        {
            get; private set;
        }
        internal bool RevokeBeforeReturn
        {
            get; init;
        }

        internal Fixture()
        {
            DocumentExportFrozenInput input = OriginalInput;
            Facts = Seal(new(input.UserId, input.SiteScope, input.Coordinate, input.MarkdownUtf8,
                input.SourceDigest, input.MetadataDigest, input.PropertyDigest, input.AssetManifestDigest,
                input.FontManifestDigest, input.RendererId, input.RendererVersion, input.RendererDigest,
                input.Assets, input.FrozenEmbeds, string.Empty));
            Actor = new(input.UserId, input.SiteScope, "controlled-session");
            Request = new("controlled-request", "controlled-idempotency",
                new((int)input.Coordinate.Kind, input.Coordinate.ArticleId, input.Coordinate.DraftKey,
                    input.Coordinate.RevisionId, input.Coordinate.PublicationId, input.Coordinate.SourceVersion),
                "self-contained-html", input.LayoutProfile, input.ThemeProfile, input.Locale);
            var reader = Substitute.For<IDocumentExportFrozenSourceReader>();
            reader.ReadAsync(Actor, input.Coordinate, Arg.Any<CancellationToken>()).Returns(_ =>
            {
                ReadCalls++;
                return Task.FromResult<DocumentExportFrozenSourceFacts?>(Facts);
            });
            var authorization = Substitute.For<IDocumentExportJobAuthorization>();
            authorization.IsAllowedAsync(Actor, input.Coordinate, DocumentExportJobOperation.Create,
                Arg.Any<CancellationToken>()).Returns(_ =>
                {
                    PermissionCalls++;
                    return ValueTask.FromResult(!(RevokeBeforeReturn && PermissionCalls > 1));
                });
            Freezer = new(reader, authorization);
        }

        internal Task<(DocumentExportTask Task, DocumentExportFrozenInput Input)> FreezeAsync()
            => Freezer.FreezeAsync(new DefaultHttpContext(), Actor, Request, default);
    }

    private sealed class ControlledRoutes(IServiceProvider provider) : IEndpointRouteBuilder
    {
        public IServiceProvider ServiceProvider => provider;
        public ICollection<EndpointDataSource> DataSources { get; } = [];
        public IApplicationBuilder CreateApplicationBuilder() => new ApplicationBuilder(provider);
    }
}
