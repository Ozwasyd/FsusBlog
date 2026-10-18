using System.Globalization;
using System.Net;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.AspNetCore.Http;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

public sealed partial class ArticlePropertyValueCanonicalWriterIntegrationTests
{
    [Fact]
    public async Task Http_HistoryUsesExactSnapshotWithoutReadingCorruptCurrentFactsOrWritingAnyRows()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveHistoricalHttpValueAsync(data, definition, "selected historical value");
        ArticlePropertyValueReadModel current = await SaveHistoricalHttpValueAsync(data, definition, "unselected current value");
        await data.Db.Ado.ExecuteCommandAsync("UPDATE article_property_value_entry SET text_value = @Corrupt WHERE factset_id = @Factset;",
            new SugarParameter("@Corrupt", "unselected corrupted value"), new SugarParameter("@Factset", current.Current!.FactsetId));
        WriteState before = await StateAsync(data);
        using EndpointSecurityTestServer server = PropertyHttpServer(data, new HttpContextAccessor());
        using HttpClient client = server.CreateClient();
        using HttpResponseMessage response = await SendPropertyAsync(client, HttpMethod.Get,
            HistoricalPropertyPath(data.ArticleId, historical.ArticleRevisionId), null, null);
        ArticlePropertyValueHistoricalReadResponse read = await HistoricalPropertyResponseAsync(response);
        Assert.Null(read.PublicationId);
        Assert.Equal(historical.ArticleRevisionId, read.ArticleRevisionId);
        Assert.Equal(historical.Current!.SnapshotId, read.Snapshot.SnapshotId);
        Assert.Equal(historical.Current.Snapshot.ContentDigest, read.Snapshot.Snapshot.ContentDigest);
        Assert.Equal("selected historical value", Assert.IsType<ArticlePropertyTextValue>(Assert.Single(read.Snapshot.Snapshot.Values).Value).Text);
        Assert.DoesNotContain(read.Snapshot.Snapshot.Values, value => value.Value is ArticlePropertyTextValue text
            && text.Text.Contains("unselected", StringComparison.Ordinal));
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
        await AssertUnchangedAsync(data, before);
    }

    [Fact]
    public async Task Http_HistoryOldPublicationSurvivesRepublish_AbsentPublicationMeansOnlySqlNull()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel first = await SaveHistoricalHttpValueAsync(data, definition, "old publication value");
        Assert.True(await data.Service.UpdateAsync(data.ArticleId, Write(data, "published body", ArticleStatus.Published, first.ArticleRevisionId)));
        ArticlePropertyValueReadModel published = await ReadAsync(data);
        long oldPublication = published.Current!.Snapshot.Coordinates.PublicationId!.Value;
        Assert.True(await data.Service.UpdateAsync(data.ArticleId, Write(data, "draft body", ArticleStatus.Draft, published.ArticleRevisionId)));
        ArticlePropertyValueReadModel second = await SaveHistoricalHttpValueAsync(data, definition, "new publication value");
        Assert.True(await data.Service.UpdateAsync(data.ArticleId, Write(data, "republished body", ArticleStatus.Published, second.ArticleRevisionId)));
        ArticlePropertyValueReadModel current = await ReadAsync(data);
        long newPublication = current.Current!.Snapshot.Coordinates.PublicationId!.Value;
        Assert.NotEqual(oldPublication, newPublication);
        using EndpointSecurityTestServer server = PropertyHttpServer(data, new HttpContextAccessor());
        using HttpClient client = server.CreateClient();
        WriteState before = await StateAsync(data);
        using (HttpResponseMessage response = await SendPropertyAsync(client, HttpMethod.Get,
            HistoricalPropertyPath(data.ArticleId, published.ArticleRevisionId, oldPublication), null, null))
        {
            ArticlePropertyValueHistoricalReadResponse read = await HistoricalPropertyResponseAsync(response);
            Assert.Equal(oldPublication, read.PublicationId);
            Assert.Equal(published.Current.SnapshotId, read.Snapshot.SnapshotId);
            Assert.Equal("old publication value", Assert.IsType<ArticlePropertyTextValue>(Assert.Single(read.Snapshot.Snapshot.Values).Value).Text);
        }
        foreach (string path in new[]
        {
            HistoricalPropertyPath(data.ArticleId, published.ArticleRevisionId),
            HistoricalPropertyPath(data.ArticleId, published.ArticleRevisionId, newPublication),
            HistoricalPropertyPath(data.ArticleId, current.ArticleRevisionId, oldPublication),
            HistoricalPropertyPath(data.ArticleId, long.MaxValue),
            HistoricalPropertyPath(data.ArticleId, current.ArticleRevisionId, long.MaxValue)
        })
        {
            using HttpResponseMessage response = await SendPropertyAsync(client, HttpMethod.Get, path, null, null);
            Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
            await AssertHistoricalPropertyErrorAsync(response);
        }
        using (HttpResponseMessage response = await SendPropertyAsync(client, HttpMethod.Get,
            HistoricalPropertyPath(data.ArticleId, first.ArticleRevisionId), null, null))
        {
            Assert.Null((await HistoricalPropertyResponseAsync(response)).PublicationId);
        }
        await AssertUnchangedAsync(data, before);
    }

    [Fact]
    public async Task Http_HistoryUsesLiveSqlPermissionsAndPrivateArticleAdmission_NotHistoricalOrClientGrants()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveHistoricalHttpValueAsync(data, definition, "private historical value");
        _ = await SaveHistoricalHttpValueAsync(data, definition, "new value");
        string path = HistoricalPropertyPath(data.ArticleId, historical.ArticleRevisionId);
        WriteState before = await StateAsync(data);
        using EndpointSecurityTestServer server = PropertyHttpServer(data, new HttpContextAccessor());
        using HttpClient client = server.CreateClient();
        using (HttpResponseMessage anonymous = await SendPropertyAsync(client, HttpMethod.Get, path, null, null, authenticated: false))
        {
            Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
            await AssertHistoricalPropertyErrorAsync(anonymous);
        }
        long stranger = await data.Db.Insertable(new AdminPrincipal
        {
            Handle = "historical-other-editor",
            Status = AdminPrincipalStatus.Active,
            IsRoot = false,
            Permissions = AdminPermissions.ArticleWrite
        }).ExecuteReturnBigIdentityAsync();
        using (EndpointSecurityTestServer otherServer = PropertyHttpServer(data, new HttpContextAccessor(), stranger))
        using (HttpClient other = otherServer.CreateClient())
        using (HttpResponseMessage denied = await SendPropertyAsync(other, HttpMethod.Get, path, null, null))
        {
            Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
            await AssertHistoricalPropertyErrorAsync(denied);
        }
        await data.Db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET isroot = false, permissions = @Permission WHERE id = @Actor;",
            new SugarParameter("@Permission", AdminPermissions.ArticleWrite), new SugarParameter("@Actor", data.AdminId));
        using (HttpResponseMessage owned = await SendPropertyAsync(client, HttpMethod.Get, path, null, null))
        {
            Assert.Equal(historical.Current!.SnapshotId, (await HistoricalPropertyResponseAsync(owned)).Snapshot.SnapshotId);
        }
        foreach (string permission in new[] { AdminPermissions.SystemConfig, string.Empty })
        {
            await data.Db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET permissions = @Permission WHERE id = @Actor;",
                new SugarParameter("@Permission", permission), new SugarParameter("@Actor", data.AdminId));
            var queries = new List<string>();
            data.Db.Aop.OnLogExecuting = (sql, _) => queries.Add(sql);
            using HttpResponseMessage denied = await SendPropertyAsync(client, HttpMethod.Get, path, null, null);
            Assert.Equal(HttpStatusCode.NotFound, denied.StatusCode);
            await AssertHistoricalPropertyErrorAsync(denied);
            Assert.DoesNotContain(queries, sql => sql.Contains("article_property_value_snapshot", StringComparison.Ordinal));
            data.Db.Aop.OnLogExecuting = null;
        }
        await AssertUnchangedAsync(data, before);
    }

    [Fact]
    public async Task Http_HistoryRejectsMalformedSelectorsForeignOwnersAndSelectedSnapshotTamper()
    {
        using Seed data = await SeedAsync();
        ArticlePropertyDefinition definition = await DefineAsync(data, ArticlePropertyValueType.Text);
        ArticlePropertyValueReadModel historical = await SaveHistoricalHttpValueAsync(data, definition, "historical protected value");
        _ = await SaveHistoricalHttpValueAsync(data, definition, "new protected value");
        string path = HistoricalPropertyPath(data.ArticleId, historical.ArticleRevisionId);
        using EndpointSecurityTestServer server = PropertyHttpServer(data, new HttpContextAccessor());
        using HttpClient client = server.CreateClient();
        WriteState before = await StateAsync(data);
        foreach (string suffix in new[] { "?publicationId=", "?publicationId=null", "?publicationId=latest", "?publicationId=0",
            "?publicationId=-1", "?publicationId=9223372036854775808", "?publicationId=1&publicationId=2",
            "?siteScope=other-site", "?draftId=1", "?ownerUserId=0", "?ownerUserId=1&ownerUserId=2" })
        {
            using HttpResponseMessage malformed = await SendPropertyAsync(client, HttpMethod.Get, path + suffix, null, null);
            Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);
            await AssertHistoricalPropertyErrorAsync(malformed);
        }
        using (HttpResponseMessage foreign = await SendPropertyAsync(client, HttpMethod.Get,
            path + "?ownerUserId=" + (data.AdminId + 1).ToString(CultureInfo.InvariantCulture), null, null))
        {
            Assert.Equal(HttpStatusCode.NotFound, foreign.StatusCode);
            await AssertHistoricalPropertyErrorAsync(foreign);
        }
        await AssertUnchangedAsync(data, before);
        Assert.Equal(1, await data.Db.Ado.ExecuteCommandAsync(
            "UPDATE sys_audit_log SET record_mac = @Mac WHERE target_id = @Audit;",
            new SugarParameter("@Mac", new string('0', 64)), new SugarParameter("@Audit", historical.Current!.AuditReference.ToString("N"))));
        using HttpResponseMessage tampered = await SendPropertyAsync(client, HttpMethod.Get, path, null, null);
        Assert.Equal(HttpStatusCode.InternalServerError, tampered.StatusCode);
        await AssertHistoricalPropertyErrorAsync(tampered);
        await AssertUnchangedAsync(data, before);
    }

    private static async Task<ArticlePropertyValueReadModel> SaveHistoricalHttpValueAsync(Seed data,
        ArticlePropertyDefinition definition, string value)
    {
        ArticlePropertyValueReadModel current = await ReadAsync(data);
        _ = await data.Writer.MutateAsync(data.AdminId, Command(data, current.ArticleRevisionId, current.PropertyRevision,
            [Change(definition, new ArticlePropertyTextValue(value), current.PropertyRevision == 0
                ? ArticlePropertyValueChangeKind.Create : ArticlePropertyValueChangeKind.Update)]));
        return await ReadAsync(data);
    }

    private static string HistoricalPropertyPath(int articleId, long revisionId, long? publicationId = null)
        => $"/api/binary/author/articles/{articleId}/properties/history/{revisionId}"
            + (publicationId is null ? string.Empty : "?publicationId=" + publicationId.Value.ToString(CultureInfo.InvariantCulture));

    private static async Task<ArticlePropertyValueHistoricalReadResponse> HistoricalPropertyResponseAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(PodBinaryCodec.TryDecodeArticlePropertyValueHistoricalReadResponse(
            await PropertyFrameAsync(response, AedsFrameType.ArticlePropertyValueHistoricalReadResponse), out var read));
        return read;
    }

    private static async Task AssertHistoricalPropertyErrorAsync(HttpResponseMessage response)
    {
        byte[] bytes = await response.Content.ReadAsByteArrayAsync();
        var decoded = new AedsEncoder().TryDecode(bytes);
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        string body = Encoding.UTF8.GetString(bytes);
        Assert.DoesNotContain("historical protected value", body, StringComparison.Ordinal);
        Assert.DoesNotContain("new protected value", body, StringComparison.Ordinal);
    }
}
