using System.Buffers;
using System.Net;
using System.Net.Http.Headers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.AuthoringPreferences;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class WritingAidPreferenceEndpointTests
{
    internal const string Route = "/api/binary/author/preferences/writing-aids";
    internal static WritingAidPreferenceOwner Owner { get; } = new("admin:17", "primary-site");

    [Fact]
    public async Task Read_EncodesDomainDefaultsWithoutInitialization()
    {
        IWritingAidPreferenceReader reader = Substitute.For<IWritingAidPreferenceReader>();
        WritingAidPreferenceSnapshot snapshot = Snapshot(0, WritingAidPreferenceContract.Defaults);
        reader.GetWritingAidPreferenceAsync(Owner, Arg.Any<CancellationToken>())
            .Returns(new WritingAidPreferenceResult(WritingAidPreferenceOutcome.Success, snapshot));
        using EndpointSecurityTestServer server = CreateServer(reader);
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = Request(HttpMethod.Get);
        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(snapshot, await ReadSnapshotAsync(response));
        await reader.Received(1).GetWritingAidPreferenceAsync(Owner, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Read_ClientCoordinatesCannotOverrideVerifiedAdminAndSite()
    {
        IWritingAidPreferenceReader reader = Substitute.For<IWritingAidPreferenceReader>();
        WritingAidPreferenceSnapshot snapshot = Snapshot(0, WritingAidPreferenceContract.Defaults);
        reader.GetWritingAidPreferenceAsync(Owner, Arg.Any<CancellationToken>())
            .Returns(new WritingAidPreferenceResult(WritingAidPreferenceOutcome.Success, snapshot));
        using EndpointSecurityTestServer server = CreateServer(reader);
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = Request(HttpMethod.Get,
            suffix: "?userScope=account:17&siteScope=other-site");
        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(snapshot, await ReadSnapshotAsync(response));
        await reader.Received(1).GetWritingAidPreferenceAsync(Owner, Arg.Any<CancellationToken>());
        Assert.Single(reader.ReceivedCalls());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Read_RefusesAnonymousOrAccountPrincipalBeforeDomainRead(bool account)
    {
        IWritingAidPreferenceReader reader = Substitute.For<IWritingAidPreferenceReader>();
        using EndpointSecurityTestServer server = CreateServer(reader);
        using HttpClient client = server.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, Route);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        if (account)
        {
            EndpointSecurityTestServer.AddAnonymousAccount(request);
        }
        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(account ? HttpStatusCode.Forbidden : HttpStatusCode.Unauthorized, response.StatusCode);
        _ = await EndpointSecurityTestServer.ReadErrorAsync(response);
        Assert.Empty(reader.ReceivedCalls());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    public async Task Read_PreservesEveryIndependentBooleanCombination(int mask)
    {
        IWritingAidPreferenceReader reader = Substitute.For<IWritingAidPreferenceReader>();
        WritingAidPreferenceSnapshot snapshot = Snapshot(29, Values(mask));
        reader.GetWritingAidPreferenceAsync(Owner, Arg.Any<CancellationToken>())
            .Returns(new WritingAidPreferenceResult(WritingAidPreferenceOutcome.Success, snapshot));
        using EndpointSecurityTestServer server = CreateServer(reader);
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = Request(HttpMethod.Get);
        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(snapshot, await ReadSnapshotAsync(response));
    }

    [Theory]
    [InlineData(WritingAidPreferenceOutcome.Invalid, HttpStatusCode.BadRequest, "writing_aid_preference_request_invalid")]
    [InlineData(WritingAidPreferenceOutcome.Corrupt, HttpStatusCode.InternalServerError, "writing_aid_preference_integrity_failed")]
    [InlineData(WritingAidPreferenceOutcome.Unavailable, HttpStatusCode.ServiceUnavailable, "writing_aid_preference_unavailable")]
    public async Task Read_UsesUnifiedDomainErrors(
        WritingAidPreferenceOutcome outcome, HttpStatusCode status, string reason)
    {
        IWritingAidPreferenceReader reader = Substitute.For<IWritingAidPreferenceReader>();
        reader.GetWritingAidPreferenceAsync(Owner, Arg.Any<CancellationToken>())
            .Returns(new WritingAidPreferenceResult(outcome));
        using EndpointSecurityTestServer server = CreateServer(reader);
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = Request(HttpMethod.Get);
        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(status, response.StatusCode);
        Assert.Equal(reason, (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    public async Task Update_RefusesMissingDeviceAuthorityWithoutDispatchOrReceipt(int mask)
    {
        IWritingAidPreferenceReader reader = Substitute.For<IWritingAidPreferenceReader>();
        IWritingAidPreferenceCommand command = Substitute.For<IWritingAidPreferenceCommand>();
        IWritingAidPreferenceInitializationCommand initialization = Substitute.For<IWritingAidPreferenceInitializationCommand>();
        using EndpointSecurityTestServer server = CreateServer(reader, command, initialization);
        using HttpClient client = server.CreateClient();
        var update = new WritingAidPreferenceUpdate(17, Guid.NewGuid(), Values(mask));
        using HttpRequestMessage request = Request(HttpMethod.Put, update);
        using HttpResponseMessage response = await client.SendAsync(request);

        await AssertDeviceRefusalAsync(response);
        Assert.Empty(reader.ReceivedCalls());
        Assert.Empty(command.ReceivedCalls());
        Assert.Empty(initialization.ReceivedCalls());
    }

    [Fact]
    public async Task Initialize_RefusesMissingDeviceAuthorityWithoutDispatchOrReceipt()
    {
        IWritingAidPreferenceReader reader = Substitute.For<IWritingAidPreferenceReader>();
        IWritingAidPreferenceCommand command = Substitute.For<IWritingAidPreferenceCommand>();
        IWritingAidPreferenceInitializationCommand initialization = Substitute.For<IWritingAidPreferenceInitializationCommand>();
        using EndpointSecurityTestServer server = CreateServer(reader, command, initialization);
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = Request(HttpMethod.Post,
            new(0, Guid.NewGuid(), WritingAidPreferenceContract.Defaults), "/initialize");
        using HttpResponseMessage response = await client.SendAsync(request);

        await AssertDeviceRefusalAsync(response);
        Assert.Empty(command.ReceivedCalls());
        Assert.Empty(initialization.ReceivedCalls());
    }

    [Theory]
    [InlineData(1, 0)]
    [InlineData(0, 1)]
    public async Task Initialize_RejectsNondefaultOrNonzeroRevision(long revision, int mask)
    {
        using EndpointSecurityTestServer server = CreateServer(Substitute.For<IWritingAidPreferenceReader>());
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = Request(HttpMethod.Post,
            new(revision, Guid.NewGuid(), Values(mask)), "/initialize");
        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("writing_aid_preference_request_invalid",
            (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
    }

    [Theory]
    [InlineData("json")]
    [InlineData("wrong-frame")]
    [InlineData("trailing-payload")]
    [InlineData("invalid-boolean")]
    public async Task Update_RejectsInvalidTransportBeforeDeviceRefusal(string fault)
    {
        using EndpointSecurityTestServer server = CreateServer(Substitute.For<IWritingAidPreferenceReader>());
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage request = Request(HttpMethod.Put,
            new(0, Guid.NewGuid(), WritingAidPreferenceContract.Defaults));
        byte[] bytes = await request.Content!.ReadAsByteArrayAsync();
        var decoded = new AedsEncoder().TryDecode(bytes);
        Assert.True(decoded.IsSuccess);
        byte[] payload = decoded.Value.Payload.ToArray();
        if (fault == "trailing-payload")
        {
            payload = [.. payload, 0];
        }
        if (fault == "invalid-boolean")
        {
            payload[12] = 2;
        }
        request.Content.Dispose();
        request.Content = new ByteArrayContent(fault == "json" ? "{}"u8.ToArray()
            : new AedsEncoder().Encode(fault == "wrong-frame" ? AedsFrameType.WritingAidPreferenceSnapshotResponse
                : AedsFrameType.WritingAidPreferenceUpdateRequest, payload));
        request.Content.Headers.ContentType = new(fault == "json" ? "application/json" : "application/octet-stream");
        using HttpResponseMessage response = await client.SendAsync(request);

        // The original middleware rejects JSON before the POD binder with its
        // canonical 415/InfraFailure mapping; malformed AEDS reaches validation.
        Assert.Equal(fault == "json" ? HttpStatusCode.UnsupportedMediaType : HttpStatusCode.BadRequest,
            response.StatusCode);
        Assert.Equal(fault == "json" ? ErrorCode.InfraFailure : ErrorCode.Validation,
            (await EndpointSecurityTestServer.ReadErrorAsync(response)).Code);
    }

    internal static EndpointSecurityTestServer CreateServer(
        IWritingAidPreferenceReader reader, IWritingAidPreferenceCommand? command = null,
        IWritingAidPreferenceInitializationCommand? initialization = null)
    {
        return EndpointSecurityTestServer.Create(new()
        {
            ConfigureServices = services =>
            {
                services.AddSingleton(reader);
                services.AddSingleton<IStartupFilter>(new WritingAidPreferenceRouteStartupFilter());
                if (command is not null)
                {
                    services.AddSingleton(command);
                }
                if (initialization is not null)
                {
                    services.AddSingleton(initialization);
                }
            }
        });
    }

    private sealed class WritingAidPreferenceRouteStartupFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
            => app =>
            {
                next(app);
                // WebApplication exposes its global route builder during original
                // host configuration. Add the group before the pipeline is built;
                // adding it after StartAsync leaves it outside the captured sources.
                if (!app.Properties.TryGetValue("__GlobalEndpointRouteBuilder", out object? builder)
                    || builder is not IEndpointRouteBuilder routes)
                {
                    throw new InvalidOperationException("Original host global route builder is unavailable.");
                }
                AuthoringEndpoints.MapWritingAidPreferenceRoutes(routes.MapGroup("/api/binary/author"));
            };
    }

    internal static HttpRequestMessage Request(HttpMethod method, WritingAidPreferenceUpdate? update = null, string suffix = "")
    {
        var request = new HttpRequestMessage(method, Route + suffix);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.ArticleWrite);
        if (update is not null)
        {
            var payload = new ArrayBufferWriter<byte>();
            PodBinaryCodec.WriteWritingAidPreferenceUpdateRequest(update, payload);
            request.Content = new ByteArrayContent(new AedsEncoder().Encode(
                AedsFrameType.WritingAidPreferenceUpdateRequest, payload.WrittenSpan));
            request.Content.Headers.ContentType = new("application/octet-stream");
            EndpointSecurityTestServer.AddPowProof(request);
        }
        return request;
    }

    internal static async Task<WritingAidPreferenceSnapshot> ReadSnapshotAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Assert.True(response.Headers.CacheControl?.NoStore);
        var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.WritingAidPreferenceSnapshotResponse, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeWritingAidPreferenceSnapshot(decoded.Value.Payload, Owner, out var snapshot));
        return snapshot!;
    }

    internal static async Task AssertDeviceRefusalAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        ErrorDetail error = await EndpointSecurityTestServer.ReadErrorAsync(response);
        Assert.Equal(ErrorCode.InfraFailure, error.Code);
        Assert.Equal("writing_aid_preference_device_authority_unavailable", error.Message);
    }

    private static WritingAidPreferenceValues Values(int mask)
        => new(1, (mask & 1) != 0, (mask & 2) != 0, (mask & 4) != 0);

    private static WritingAidPreferenceSnapshot Snapshot(long revision, WritingAidPreferenceValues values)
        => new(Owner, revision, values, WritingAidPreferenceValidator.ComputeDigest(Owner, revision, values));
}
