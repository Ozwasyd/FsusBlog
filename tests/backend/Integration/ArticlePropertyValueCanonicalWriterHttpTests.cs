using System.Net;
using System.Net.Http.Headers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

public sealed partial class ArticlePropertyValueCanonicalWriterIntegrationTests
{
    [Fact]
    public async Task Http_AllEightValuesCommitAndReplayThroughOriginalWriter_RejectCasScopeMalformedAndRevokedSqlPermission()
    {
        using Seed data = await SeedAsync();
        var definitions = new List<ArticlePropertyDefinition>();
        foreach (ArticlePropertyValueType type in Enum.GetValues<ArticlePropertyValueType>())
        {
            definitions.Add(await DefineAsync(data, type));
        }
        var context = new HttpContextAccessor();
        using EndpointSecurityTestServer server = PropertyHttpServer(data, context);
        using HttpClient client = server.CreateClient();
        ArticlePropertyValueMutationCommand command = Command(data, await RevisionAsync(data.Db, data.ArticleId), 0,
            definitions.Select(definition => Change(definition, definition.ValueType switch
            {
                ArticlePropertyValueType.Text => new ArticlePropertyTextValue(new string('x', 16384)),
                ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(decimal.MaxValue),
                ArticlePropertyValueType.Date => new ArticlePropertyDateValue(DateTime.SpecifyKind(DateTime.MaxValue, DateTimeKind.Utc)),
                _ => Value(definition)
            })).ToArray());
        string path = $"/api/binary/author/articles/{data.ArticleId}/properties";
        byte[] payload = PodBinaryCodec.EncodeArticlePropertyValueMutationCommand(command);
        WriteState before = await StateAsync(data);
        using HttpResponseMessage deniedRead = await SendPropertyAsync(client, HttpMethod.Get, path, null, null, authenticated: false);
        Assert.Equal(HttpStatusCode.Unauthorized, deniedRead.StatusCode);
        using HttpResponseMessage deniedWrite = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, payload, authenticated: false);
        Assert.Equal(HttpStatusCode.Unauthorized, deniedWrite.StatusCode);
        using HttpResponseMessage noPow = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, payload, pow: false);
        Assert.Equal(HttpStatusCode.Unauthorized, noPow.StatusCode);
        await AssertUnchangedAsync(data, before);

        ArticlePropertyValueMutationReceipt applied;
        using (HttpResponseMessage response = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, payload))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
            var decoded = await PropertyFrameAsync(response, AedsFrameType.ArticlePropertyValueMutationReceipt);
            Assert.True(PodBinaryCodec.TryDecodeArticlePropertyValueMutationReceipt(decoded, out applied!));
        }
        Assert.Equal(command.RequestId, applied.RequestId);
        Assert.Equal(data.AdminId, applied.ActorAdminPrincipalId);
        ArticlePropertyValueReadModel current = await ReadAsync(data);
        Assert.Equal(current.Current!.SnapshotId, applied.AfterSnapshotId);
        Assert.Equal(8, current.Current.Snapshot.Values.Count);
        WriteState committed = await StateAsync(data);
        using (HttpResponseMessage response = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, payload))
        {
            Assert.True(PodBinaryCodec.TryDecodeArticlePropertyValueMutationReceipt(
                await PropertyFrameAsync(response, AedsFrameType.ArticlePropertyValueMutationReceipt), out var replay));
            Assert.Equal(applied with
            {
                IdempotencyReplay = true
            }, replay);
        }
        await AssertUnchangedAsync(data, committed);
        foreach (ArticlePropertyValueMutationCommand invalid in new[]
        {
            command with { RequestId = Guid.CreateVersion7() },
            command with { SiteScope = "foreign-site" },
            command with { DefinitionOwnerUserId = data.AdminId + 1 },
            command with { Changes = [Change(definitions[0], new ArticlePropertyTextValue("changed"))] }
        })
        {
            using HttpResponseMessage response = await SendPropertyAsync(client, HttpMethod.Post, path,
                AedsFrameType.ArticlePropertyValueMutationCommand, PodBinaryCodec.EncodeArticlePropertyValueMutationCommand(invalid));
            Assert.Contains(response.StatusCode, new[] { HttpStatusCode.Conflict, HttpStatusCode.BadRequest, HttpStatusCode.NotFound });
            await AssertUnchangedAsync(data, committed);
        }
        foreach (byte[] malformed in new[] { payload[..^1], new byte[] { 255 }.Concat(payload[1..]).ToArray(), payload.Concat(new byte[] { 0 }).ToArray() })
        {
            using HttpResponseMessage response = await SendPropertyAsync(client, HttpMethod.Post, path,
                AedsFrameType.ArticlePropertyValueMutationCommand, malformed);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        }
        var reference = definitions.Single(definition => definition.ValueType == ArticlePropertyValueType.ArticleReference);
        ArticlePropertyValueMutationCommand nonemptyReference = Command(data, current.ArticleRevisionId, current.PropertyRevision,
            [Change(reference, new ArticlePropertyArticleReferenceValue([data.ArticleId + 1L]), ArticlePropertyValueChangeKind.Update)]);
        using (HttpResponseMessage unavailable = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, PodBinaryCodec.EncodeArticlePropertyValueMutationCommand(nonemptyReference)))
        {
            Assert.Equal(HttpStatusCode.BadRequest, unavailable.StatusCode);
        }
        await AssertUnchangedAsync(data, committed);
        ArticlePropertyValueMutationCommand lowerBounds = Command(data, current.ArticleRevisionId, current.PropertyRevision,
            definitions.Select(definition => Change(definition, definition.ValueType switch
            {
                ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(decimal.MinValue),
                ArticlePropertyValueType.Date => new ArticlePropertyDateValue(DateTime.SpecifyKind(DateTime.MinValue, DateTimeKind.Utc)),
                ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue([]),
                _ => Value(definition)
            }, ArticlePropertyValueChangeKind.Update)).ToArray());
        using (HttpResponseMessage lower = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, PodBinaryCodec.EncodeArticlePropertyValueMutationCommand(lowerBounds)))
        {
            Assert.Equal(HttpStatusCode.OK, lower.StatusCode);
        }
        ArticlePropertyValueReadModel lowerRead = await ReadAsync(data);
        Assert.Equal(decimal.MinValue, Assert.IsType<ArticlePropertyNumberValue>(lowerRead.Current!.Snapshot.Values
            .Single(value => value.DefinitionId == definitions.Single(definition => definition.ValueType == ArticlePropertyValueType.Number).DefinitionId).Value).Number);
        Assert.Equal(0, Assert.IsType<ArticlePropertyDateValue>(lowerRead.Current.Snapshot.Values
            .Single(value => value.DefinitionId == definitions.Single(definition => definition.ValueType == ArticlePropertyValueType.Date).DefinitionId).Value).Utc.Ticks);
        committed = await StateAsync(data);
        await data.Db.Updateable<AdminPrincipal>().SetColumns(row => new AdminPrincipal { IsRoot = false, Permissions = "" })
            .Where(row => row.Id == data.AdminId).ExecuteCommandAsync();
        using HttpResponseMessage revoked = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, payload);
        Assert.Equal(HttpStatusCode.NotFound, revoked.StatusCode);
        await AssertUnchangedAsync(data, committed);
    }

    [Fact]
    public async Task Http_DefinitionFiveCommandsReturnOriginalPersistedReceipts_AndSqlPermissionsOverrideHostClaims()
    {
        using Seed data = await SeedAsync();
        using EndpointSecurityTestServer server = PropertyHttpServer(data, new HttpContextAccessor());
        using HttpClient client = server.CreateClient();
        Guid definitionId = Guid.CreateVersion7();
        var settings = new ArticlePropertyDefinitionSettings(0, 0, false, new(0, 0, 0), null,
            new(null, null, null, null, null, null, null, null), [], null, null, false, false, false, 1, 0);
        var create = new ArticlePropertyDefinitionCreateRequest(Guid.CreateVersion7(), null, "primary-site", definitionId,
            0, "http-property", [new("en", "HTTP property")], settings);
        string root = "/api/binary/author/property-definitions";
        async Task<ArticlePropertyDefinitionMutationReceipt> Apply(HttpMethod method, string path, AedsFrameType frame, byte[] body)
        {
            using HttpResponseMessage response = await SendPropertyAsync(client, method, path, frame, body);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.True(PodBinaryCodec.TryDecodeArticlePropertyDefinitionMutationReceipt(
                await PropertyFrameAsync(response, AedsFrameType.ArticlePropertyDefinitionMutationReceipt), out var receipt));
            Assert.Equal(data.AdminId, receipt.ActorAdminPrincipalId);
            Assert.Equal(definitionId, receipt.DefinitionId);
            ArticlePropertyDefinitionVerificationResult verified = await data.Definitions.VerifyAsync(data.Actor, s_owner, definitionId);
            Assert.True(verified.Valid, string.Join(',', verified.Violations.Select(row => row.Code)));
            return receipt;
        }
        ArticlePropertyDefinitionMutationReceipt first = await Apply(HttpMethod.Post, root,
            AedsFrameType.ArticlePropertyDefinitionCreateRequest, PodBinaryCodec.EncodeArticlePropertyDefinitionCreateRequest(create));
        Assert.Equal(1, first.OwnerRevision);
        ArticlePropertyDefinitionMutationReceipt replay = await Apply(HttpMethod.Post, root,
            AedsFrameType.ArticlePropertyDefinitionCreateRequest, PodBinaryCodec.EncodeArticlePropertyDefinitionCreateRequest(create));
        Assert.Equal(PodBinaryCodec.EncodeArticlePropertyDefinitionMutationReceipt(first with
        {
            IsIdempotentReplay = true
        }),
            PodBinaryCodec.EncodeArticlePropertyDefinitionMutationReceipt(replay));
        string target = root + "/" + definitionId;
        var update = new ArticlePropertyDefinitionUpdateRequest(Guid.CreateVersion7(), null, "primary-site", definitionId, 1, 1, settings);
        _ = await Apply(HttpMethod.Put, target, AedsFrameType.ArticlePropertyDefinitionUpdateRequest,
            PodBinaryCodec.EncodeArticlePropertyDefinitionUpdateRequest(update));
        _ = await Apply(HttpMethod.Post, target + "/rename", AedsFrameType.ArticlePropertyDefinitionRenameRequest,
            PodBinaryCodec.EncodeArticlePropertyDefinitionRenameRequest(new(Guid.CreateVersion7(), null, "primary-site", definitionId,
                2, 2, [new("en", "Renamed HTTP property")])));
        _ = await Apply(HttpMethod.Post, target + "/deprecate", AedsFrameType.ArticlePropertyDefinitionDeprecateRequest,
            PodBinaryCodec.EncodeArticlePropertyDefinitionDeprecateRequest(new(Guid.CreateVersion7(), null, "primary-site", definitionId, 3, 3)));
        ArticlePropertyDefinitionMutationReceipt deleted = await Apply(HttpMethod.Delete, target,
            AedsFrameType.ArticlePropertyDefinitionDeleteRequest,
            PodBinaryCodec.EncodeArticlePropertyDefinitionDeleteRequest(new(Guid.CreateVersion7(), null, "primary-site", definitionId, 4, 4)));
        Assert.Equal(5, deleted.OwnerRevision);
        Assert.Equal(2, deleted.Status);
        await data.Db.Updateable<AdminPrincipal>().SetColumns(row => new AdminPrincipal
        {
            IsRoot = false,
            Permissions = AdminPermissions.ArticleWrite
        }).Where(row => row.Id == data.AdminId).ExecuteCommandAsync();
        using HttpResponseMessage denied = await SendPropertyAsync(client, HttpMethod.Post, root,
            AedsFrameType.ArticlePropertyDefinitionCreateRequest, PodBinaryCodec.EncodeArticlePropertyDefinitionCreateRequest(create));
        Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
    }

    [Fact]
    public async Task Http_PrivateArticleAndStoredReceiptTamper_RefuseWithoutNewWrites()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueMutationCommand command = Command(data, await RevisionAsync(data.Db, data.ArticleId), 0,
            [Change(definition, new ArticlePropertyTextValue("private field"))]);
        string path = $"/api/binary/author/articles/{data.ArticleId}/properties";
        long stranger = await data.Db.Insertable(new AdminPrincipal
        {
            Handle = "other-property-editor",
            Status = AdminPrincipalStatus.Active,
            IsRoot = false,
            Permissions = AdminPermissions.ArticleWrite
        }).ExecuteReturnBigIdentityAsync();
        WriteState before = await StateAsync(data);
        using (EndpointSecurityTestServer otherServer = PropertyHttpServer(data, new HttpContextAccessor(), stranger))
        using (HttpClient other = otherServer.CreateClient())
        {
            using HttpResponseMessage deniedRead = await SendPropertyAsync(other, HttpMethod.Get, path, null, null);
            Assert.Equal(HttpStatusCode.NotFound, deniedRead.StatusCode);
            using HttpResponseMessage deniedWrite = await SendPropertyAsync(other, HttpMethod.Post, path,
                AedsFrameType.ArticlePropertyValueMutationCommand, PodBinaryCodec.EncodeArticlePropertyValueMutationCommand(command));
            Assert.Equal(HttpStatusCode.NotFound, deniedWrite.StatusCode);
        }
        await AssertUnchangedAsync(data, before);
        using EndpointSecurityTestServer server = PropertyHttpServer(data, new HttpContextAccessor());
        using HttpClient client = server.CreateClient();
        using (HttpResponseMessage applied = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, PodBinaryCodec.EncodeArticlePropertyValueMutationCommand(command)))
        {
            Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        }
        WriteState committed = await StateAsync(data);
        Assert.Equal(1, await data.Db.Ado.ExecuteCommandAsync(
            "UPDATE article_property_value_receipt SET audit_record_hash = @Hash WHERE request_id = @Request;",
            new SugarParameter("@Hash", new string('0', 64)), new SugarParameter("@Request", command.RequestId)));
        using HttpResponseMessage corruptedReplay = await SendPropertyAsync(client, HttpMethod.Post, path,
            AedsFrameType.ArticlePropertyValueMutationCommand, PodBinaryCodec.EncodeArticlePropertyValueMutationCommand(command));
        Assert.Equal(HttpStatusCode.InternalServerError, corruptedReplay.StatusCode);
        await AssertUnchangedAsync(data, committed);
    }

    private static EndpointSecurityTestServer PropertyHttpServer(Seed data, IHttpContextAccessor context, long? principalOverride = null)
        => EndpointSecurityTestServer.Create(new EndpointSecurityTestServerOptions
        {
            MapAuthoringEndpoints = true,
            AdminPrincipalId = principalOverride ?? data.AdminId,
            ConfigureServices = services =>
            {
                Composition host = Compose(data.Db, principalOverride ?? data.AdminId, "host", hostContext: context);
                services.RemoveAll<IHttpContextAccessor>();
                services.AddSingleton(context);
                services.AddSingleton<ISqlSugarClient>(data.Db);
                services.AddSingleton<IArticlePropertyDefinitionStore>(host.Store);
                services.AddSingleton<IArticlePropertyValueAuthority>(host.Service);
            }
        });

    private static async Task<HttpResponseMessage> SendPropertyAsync(HttpClient client, HttpMethod method, string path,
        AedsFrameType? frame, byte[]? payload, bool authenticated = true, bool pow = true)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        if (frame is { } type)
        {
            request.Content = new ByteArrayContent(new AedsEncoder().Encode(type, payload!));
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        }
        if (authenticated)
        {
            EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.All);
        }
        if (pow)
        {
            EndpointSecurityTestServer.AddPowProof(request);
        }
        return await client.SendAsync(request);
    }

    private static async Task<ReadOnlyMemory<byte>> PropertyFrameAsync(HttpResponseMessage response, AedsFrameType type)
    {
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        var decoded = new AedsEncoder().TryDecode(await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(type, decoded.Value.FrameType);
        return decoded.Value.Payload;
    }
}
