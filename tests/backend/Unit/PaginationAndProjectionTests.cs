using System.Reflection;
using System.Runtime.CompilerServices;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// CursorPolicy
// ──────────────────────────────────────────────────────────────────────────────

public class CursorPolicyTests
{
    [Fact]
    public void NormalizeLimit_NullUsesDefault()
    {
        var p = new CursorPolicy(10, 1, 100);
        Assert.Equal(10, p.NormalizeLimit(null));
    }

    [Fact]
    public void NormalizeLimit_BelowMin_ClampsToMin()
    {
        var p = new CursorPolicy(10, 5, 100);
        Assert.Equal(5, p.NormalizeLimit(2));
    }

    [Fact]
    public void NormalizeLimit_AboveMax_ClampsToMax()
    {
        var p = new CursorPolicy(10, 1, 50);
        Assert.Equal(50, p.NormalizeLimit(200));
    }

    [Fact]
    public void NormalizeLimit_WithinRange_IsPreserved()
    {
        var p = new CursorPolicy(10, 1, 100);
        Assert.Equal(42, p.NormalizeLimit(42));
    }

    [Fact]
    public void CommentCursorPolicies_Threads_HasExpectedDefaults()
    {
        Assert.Equal(10, CommentCursorPolicies.Threads.DefaultLimit);
        Assert.Equal(50, CommentCursorPolicies.Threads.MaxLimit);
    }

    [Fact]
    public void CommentCursorPolicies_Replies_HasExpectedDefaults()
    {
        Assert.Equal(20, CommentCursorPolicies.Replies.DefaultLimit);
        Assert.Equal(100, CommentCursorPolicies.Replies.MaxLimit);
    }

    [Fact]
    public void CommentCursorPolicyResolver_AppliesTenantOverrideAndClamps()
    {
        IConfiguration config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["CommentCursorPolicies:Threads:DefaultLimit"] = "12",
                ["CommentCursorPolicies:Threads:MinLimit"] = "4",
                ["CommentCursorPolicies:Threads:MaxLimit"] = "40",
                ["CommentCursorPolicies:Tenants:tenant-main:Threads:DefaultLimit"] = "1000",
                ["CommentCursorPolicies:Tenants:tenant-main:Threads:MaxLimit"] = "25"
            })
            .Build();
        var resolver = new ConfigurationCommentCursorPolicyResolver(config);

        CursorPolicy global = resolver.Resolve(CommentCursorPolicyKind.Threads);
        CursorPolicy tenant = resolver.Resolve(CommentCursorPolicyKind.Threads, "Tenant-Main");

        Assert.Equal(12, global.DefaultLimit);
        Assert.Equal(40, global.MaxLimit);
        Assert.Equal(25, tenant.DefaultLimit);
        Assert.Equal(25, tenant.MaxLimit);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Int64CursorCodec
// ──────────────────────────────────────────────────────────────────────────────

public class Int64CursorCodecTests
{
    private readonly Int64CursorCodec _codec = Int64CursorCodec.Instance;

    [Theory]
    [InlineData("123", true, 123L)]
    [InlineData("1", true, 1L)]
    [InlineData("0", false, 0L)]
    [InlineData("-1", false, 0L)]
    [InlineData("abc", false, 0L)]
    [InlineData("", false, 0L)]
    public void TryParse_Various(string raw, bool expectedOk, long expectedValue)
    {
        bool ok = _codec.TryParse(raw, out long value);
        Assert.Equal(expectedOk, ok);
        if (expectedOk)
        {
            Assert.Equal(expectedValue, value);
        }
    }

    [Fact]
    public void Format_ReturnsStringRepresentation()
    {
        Assert.Equal("9999", _codec.Format(9999L));
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CursorPagination.Slice
// ──────────────────────────────────────────────────────────────────────────────

public class CursorPaginationSliceTests
{
    [Fact]
    public void Slice_ExactCount_HasMoreFalse()
    {
        var rows = new[] { 1L, 2L, 3L };
        var result = CursorPagination.Slice(rows, 3, x => x);

        Assert.Equal(3, result.Data.Count);
        Assert.False(result.HasMore);
        Assert.Null(result.NextCursor);
    }

    [Fact]
    public void Slice_MoreThanLimit_TruncatesAndSetsNextCursor()
    {
        var rows = new[] { 10L, 20L, 30L, 40L };
        var result = CursorPagination.Slice(rows, 3, x => x);

        Assert.Equal(3, result.Data.Count);
        Assert.True(result.HasMore);
        Assert.Equal(30L, result.NextCursor);
    }

    [Fact]
    public void Slice_Empty_ReturnsEmpty()
    {
        var result = CursorPagination.Slice(Array.Empty<int>(), 10, x => (long)x);
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    [Fact]
    public void Map_TransformsItems()
    {
        var envelope = new CursorEnvelope<long, int> { Data = [1, 2, 3], NextCursor = 3L, HasMore = true };
        var mapped = CursorPagination.Map(envelope, x => x * 2);

        Assert.Equal([2, 4, 6], mapped.Data);
        Assert.Equal(3L, mapped.NextCursor);
        Assert.True(mapped.HasMore);
    }

    [Fact]
    public void SliceMapToResponse_MapsInOneWindowAndEncodesCursor()
    {
        var rows = new[] { 10L, 20L, 30L, 40L };
        var response = CursorPagination.SliceMapToResponse(rows, 3, x => x, x => x.ToString(), Int64CursorCodec.Instance);

        Assert.Equal(["10", "20", "30"], response.Data);
        Assert.Equal("30", response.NextCursor);
        Assert.True(response.HasMore);
    }

    [Fact]
    public async Task MapAsync_TransformsItems()
    {
        var envelope = new CursorEnvelope<long, int> { Data = [5, 10], NextCursor = 10L, HasMore = false };
        var mapped = await CursorPagination.MapAsync(envelope, x => Task.FromResult(x.ToString()));

        Assert.Equal(["5", "10"], mapped.Data);
    }

    [Fact]
    public void ToResponse_EncodesNextCursor()
    {
        var codec = Int64CursorCodec.Instance;
        var envelope = new CursorEnvelope<long, string>
        {
            Data = ["a", "b"],
            NextCursor = 42L,
            HasMore = true
        };
        var response = CursorPagination.ToResponse(envelope, codec);

        Assert.Equal("42", response.NextCursor);
        Assert.True(response.HasMore);
        Assert.Equal(["a", "b"], response.Data);
    }

    [Fact]
    public void ToResponse_NullCursorWhenNoMore()
    {
        var codec = Int64CursorCodec.Instance;
        var envelope = new CursorEnvelope<long, string> { Data = [], NextCursor = null, HasMore = false };
        var response = CursorPagination.ToResponse(envelope, codec);

        Assert.Null(response.NextCursor);
        Assert.False(response.HasMore);
    }

    [Fact]
    public void ToWindow_EncodesNextCursor()
    {
        var codec = Int64CursorCodec.Instance;
        var envelope = new CursorEnvelope<long, int> { Data = [1], NextCursor = 99L, HasMore = true };
        var window = CursorPagination.ToWindow(envelope, codec);

        Assert.Equal("99", window.NextCursor);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CursorInterop
// ──────────────────────────────────────────────────────────────────────────────

public class CursorInteropTests
{
    [Fact]
    public void FromCore_WithNextCursor_EncodesIt()
    {
        var codec = Int64CursorCodec.Instance;
        var source = new CoreCursorResult<int>([1, 2], 55L, true);
        var response = CursorInterop.FromCore(source, x => x * 10, codec);

        Assert.Equal([10, 20], response.Data);
        Assert.Equal("55", response.NextCursor);
        Assert.True(response.HasMore);
    }

    [Fact]
    public void FromCore_NullCursor_NullInResponse()
    {
        var codec = Int64CursorCodec.Instance;
        var source = new CoreCursorResult<string>(["hello"], null, false);
        var response = CursorInterop.FromCore(source, x => x, codec);

        Assert.Null(response.NextCursor);
    }

    [Fact]
    public void ToCore_ParsesNextCursor()
    {
        var codec = Int64CursorCodec.Instance;
        var response = new CursorResponse<string> { Data = ["a"], NextCursor = "77", HasMore = true };
        var core = CursorInterop.ToCore(response, x => x, codec);

        Assert.Equal(77L, core.NextCursor);
        Assert.True(core.HasMore);
    }

    [Fact]
    public void ToCore_InvalidCursor_NullInCore()
    {
        var codec = Int64CursorCodec.Instance;
        var response = new CursorResponse<string> { Data = [], NextCursor = "bad", HasMore = false };
        var core = CursorInterop.ToCore(response, x => x, codec);

        Assert.Null(core.NextCursor);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CommentProjection
// ──────────────────────────────────────────────────────────────────────────────

public class CommentProjectionTests
{
    private static UserCommentReadModel MakeModel(
        long id = 1,
        string content = "hello",
        string title = "T",
        long? rootId = null,
        string? replyTo = null,
        int moderationStatus = 1,
        bool isDeleted = false,
        bool hasBlockedRegions = false)
        => new()
        {
            Id = id,
            Content = content,
            CreateTime = new DateTime(2024, 3, 5, 0, 0, 0, DateTimeKind.Utc),
            ArticleId = 7,
            ArticleTitle = title,
            RootId = rootId,
            Author = new CommentAuthorViewDto("public", "Author", "zh-CN", null, null),
            ReplyToAuthor = replyTo is null ? null : new CommentAuthorViewDto("public", replyTo, "zh-CN", null, null),
            ModerationStatus = moderationStatus,
            IsDeleted = isDeleted,
            HasBlockedRegions = hasBlockedRegions
        };

    [Fact]
    public void ToResponse_MapsAllFields()
    {
        var model = MakeModel(10, "cool comment", "Article A", 99L, "Alice");
        var response = CommentProjection.ToResponse(model);

        Assert.Equal(10L, response.Id);
        Assert.Equal("cool comment", response.Content);
        Assert.Equal(7, response.ArticleId);
        Assert.Equal("Article A", response.ArticleTitle);
        Assert.Equal(99L, response.RootId);
        Assert.Equal("Author", response.Author.DisplayName);
        Assert.Equal("Alice", response.ReplyToAuthor?.DisplayName);
    }

    [Theory]
    [InlineData(0, false, false, "待审核，仅自己可见", "pending", "pending_review", false)]
    [InlineData(1, false, false, "已公开", "public", "approved_public", true)]
    [InlineData(1, false, true, "已公开", "limited", "geo_limited", true)]
    [InlineData(2, false, false, "未通过审核", "rejected", "rejected_by_moderation", false)]
    [InlineData(3, false, false, "已隐藏", "hidden", "hidden_by_moderation", false)]
    [InlineData(1, true, false, "已删除", "deleted", "deleted_by_user_or_admin", false)]
    public void ToResponse_MapsModerationVisibility(
        int status,
        bool isDeleted,
        bool hasBlockedRegions,
        string expectedLabel,
        string expectedState,
        string expectedReason,
        bool expectedVisible)
    {
        var model = MakeModel(
            content: isDeleted ? "评论已删除" : "visible content",
            moderationStatus: status,
            isDeleted: isDeleted,
            hasBlockedRegions: hasBlockedRegions);

        var response = CommentProjection.ToResponse(model);

        Assert.Equal(status, response.ModerationStatus);
        Assert.Equal(expectedLabel, response.ModerationStatusLabel);
        Assert.Equal(expectedState, response.VisibilityState);
        Assert.Equal(expectedReason, response.VisibilityReasonCode);
        Assert.Equal(expectedVisible, response.IsPubliclyVisible);
        Assert.DoesNotContain("internal", response.ModerationStatusLabel, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("rule", response.VisibilityReasonCode, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ToCoreModel_MapsAllFields()
    {
        var model = MakeModel(5, "test", "Post B");
        var core = CommentProjection.ToCoreModel(model);

        Assert.Equal(5L, core.Id);
        Assert.Equal("test", core.Content);
        Assert.Equal("Post B", core.ArticleTitle);
        Assert.Equal(1, core.ModerationStatus);
        Assert.Equal("已公开", core.ModerationStatusLabel);
        Assert.Equal("public", core.VisibilityState);
        Assert.Equal("approved_public", core.VisibilityReasonCode);
        Assert.True(core.IsPubliclyVisible);
    }

    [Fact]
    public void ToCoreModel_WithReply_PreservesReplyInfo()
    {
        var model = MakeModel(3, "reply", "Post C", 2L, "Bob");
        var core = CommentProjection.ToCoreModel(model);

        Assert.Equal(2L, core.RootId);
        Assert.Equal("Bob", core.ReplyToAuthor?.DisplayName);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SystemProjection
// ──────────────────────────────────────────────────────────────────────────────

public class SystemProjectionTests
{
    private static SeoConfigReadModel MakeSeoModel()
        => new()
        {
            Title = "MyBlog",
            Description = "Desc",
            Keywords = "kw",
            Author = "Auth",
            OgImage = "img.jpg",
            BaseUrl = "https://example.com",
            FaviconSvgUrl = "/favicon.svg",
            FaviconIcoUrl = "/favicon.ico",
            FaviconPngUrl = "/favicon.png",
            AppleTouchIconUrl = "/apple-touch-icon.png",
            ManifestName = "MyBlog Manifest",
            ManifestShortName = "MyBlog",
            PwaIcon192Url = "/icon-192.png",
            PwaIcon512Url = "/icon-512.png",
            PwaMaskableIconUrl = "/maskable-512.png",
            ThemeColor = "#111111",
            BackgroundColor = "#ffffff",
            SiteLogoUrl = "/site-logo.svg",
            SiteLogoDarkUrl = "/site-logo-dark.svg",
            SiteWordmarkUrl = "/wordmark.svg",
            AdminLogoUrl = "/admin-logo.svg",
            AdminCollapsedIconUrl = "/admin-icon.svg",
            LoginLogoUrl = "/login-logo.svg",
            LoginIconUrl = "/login-icon.svg"
        };

    [Fact]
    public void ToPublicDto_SeoConfig_MapsAllFields()
    {
        var dto = SystemProjection.ToPublicDto(MakeSeoModel());
        Assert.Equal("MyBlog", dto.Title);
        Assert.Equal("Desc", dto.Description);
        Assert.Equal("https://example.com", dto.BaseUrl);
        Assert.Equal("/favicon.svg", dto.FaviconSvgUrl);
        Assert.Equal("/site-logo.svg", dto.SiteLogoUrl);
    }

    [Fact]
    public void ToAdminDto_SeoConfig_MapsAllFields()
    {
        var dto = SystemProjection.ToAdminDto(MakeSeoModel());
        Assert.Equal("Auth", dto.Author);
        Assert.Equal("img.jpg", dto.OgImage);
        Assert.Equal("/admin-logo.svg", dto.AdminLogoUrl);
        Assert.Equal("/login-logo.svg", dto.LoginLogoUrl);
    }

    [Fact]
    public async Task BinarySystemEndpoints_SeoRoutes_UseMatchingProjectionTypes()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        EndpointContractApplication.AddContractServices(builder);
        await using WebApplication app = builder.Build();
        app.MapBinaryEndpoints();

        MethodInfo publicHandler = FindRouteHandler(app, "/api/binary/system/seo");
        MethodInfo adminHandler = FindRouteHandler(app, "/api/binary/system/admin/seo");
        MethodBase[] publicCalls = ReadCalledMethods(AsyncMoveNext(publicHandler)).ToArray();
        MethodBase[] adminCalls = ReadCalledMethods(AsyncMoveNext(adminHandler)).ToArray();
        MethodInfo publicProjection = typeof(SystemProjection).GetMethod(
            nameof(SystemProjection.ToPublicDto),
            [typeof(SeoConfigReadModel)])!;
        MethodInfo adminProjection = typeof(SystemProjection).GetMethod(
            nameof(SystemProjection.ToAdminDto),
            [typeof(SeoConfigReadModel)])!;

        Assert.Contains(publicProjection, publicCalls);
        Assert.DoesNotContain(adminProjection, publicCalls);
        Assert.Contains(adminProjection, adminCalls);
        Assert.DoesNotContain(publicProjection, adminCalls);
    }

    [Fact]
    public void ToContract_SeoConfig_MapsAllFields()
    {
        var contract = SystemProjection.ToContract(MakeSeoModel());
        Assert.Equal("MyBlog", contract.Title);
        Assert.Equal("kw", contract.Keywords);
        Assert.Equal("/wordmark.svg", contract.SiteWordmarkUrl);
    }

    [Fact]
    public void ToPublicDto_PageContent_MapsSlugAndContent()
    {
        var model = new PageContentReadModel { Slug = "about", Content = "# About" };
        var dto = SystemProjection.ToPublicDto(model);
        Assert.Equal("about", dto.Slug);
        Assert.Equal("# About", dto.Content);
    }

    [Fact]
    public void ToAdminDto_PageContent_MapsSlugAndContent()
    {
        var model = new PageContentReadModel { Slug = "about", Content = "# About" };
        var dto = SystemProjection.ToAdminDto(model);
        Assert.Equal("about", dto.Slug);
    }

    [Fact]
    public void ToContract_PageContent_MapsCorrectly()
    {
        var model = new PageContentReadModel { Slug = "about", Content = "X" };
        var contract = SystemProjection.ToContract(model);
        Assert.Equal("about", contract.Slug);
        Assert.Equal("X", contract.Content);
    }

    private static MethodInfo FindRouteHandler(WebApplication app, string route)
    {
        RouteEndpoint endpoint = Assert.Single(((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>(),
            candidate => string.Equals(
                candidate.RoutePattern.RawText?.TrimStart('/'),
                route.TrimStart('/'),
                StringComparison.Ordinal)
                && candidate.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods
                    .Contains(HttpMethods.Get, StringComparer.Ordinal) == true);
        return endpoint.Metadata.GetMetadata<MethodInfo>()
            ?? throw new InvalidOperationException($"Handler metadata missing for {route}.");
    }

    private static MethodInfo AsyncMoveNext(MethodInfo method)
    {
        AsyncStateMachineAttribute stateMachine = method.GetCustomAttribute<AsyncStateMachineAttribute>()
            ?? throw new InvalidOperationException($"Async state machine missing for {method.Name}.");
        return stateMachine.StateMachineType.GetMethod("MoveNext", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance)!;
    }

    private static IEnumerable<MethodBase> ReadCalledMethods(MethodInfo method)
    {
        byte[] il = method.GetMethodBody()?.GetILAsByteArray() ?? [];
        for (int offset = 0; offset <= il.Length - 5; offset++)
        {
            if (il[offset] is not (0x28 or 0x6F))
                continue;
            MethodBase? called = null;
            try
            {
                called = method.Module.ResolveMethod(BitConverter.ToInt32(il, offset + 1));
            }
            catch (ArgumentException)
            {
            }
            if (called is not null)
                yield return called;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// PodRowMapper
// ──────────────────────────────────────────────────────────────────────────────

public class PodRowMapperTests
{
    // PodRowMapper is pure-forwarding thin adapters over DbDataReader.
    // We verify compilation / basic behavior using the static field mapping:
    [Fact]
    public void PodRowMapper_Int32_Test()
    {
        // just confirm the class has the right static methods by calling them via reflection
        var type = typeof(FsusBlog.Core.Mapping.Readers.PodRowMapper);
        Assert.NotNull(type.GetMethod("Int32"));
        Assert.NotNull(type.GetMethod("Int64"));
        Assert.NotNull(type.GetMethod("DateTime"));
        Assert.NotNull(type.GetMethod("String"));
        Assert.NotNull(type.GetMethod("Bool"));
        Assert.NotNull(type.GetMethod("NullableInt32"));
        Assert.NotNull(type.GetMethod("NullableDateTime"));
        Assert.NotNull(type.GetMethod("Ordinal"));
    }
}
