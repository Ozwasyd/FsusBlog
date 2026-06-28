using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FileUploadStorageHardeningContractTests
{
    [Fact]
    public void KestrelRequestBodyLimit_CoversDeclaredUploadLimit()
    {
        string builder = ReadSource("src/backend/Infrastructure/Bootstrap/WebApplicationBuilderCompositionExtensions.cs");

        Assert.Contains("FileService.UploadRequestBodyLimitBytes", builder, StringComparison.Ordinal);
        Assert.DoesNotContain("MaxRequestBodySize = 8 * 1024 * 1024", builder, StringComparison.Ordinal);
    }

    [Fact]
    public void UploadPartEndpoint_RequiresExplicitContentLength()
    {
        string endpoints = ReadSource("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Uploads.cs");
        string part = ExtractBetween(endpoints, "uploadGroup.MapPut(\"/{uploadId}/part\"", "uploadGroup.MapPost(\"/{uploadId}/complete\"");

        Assert.Contains("!httpContext.Request.ContentLength.HasValue", part, StringComparison.Ordinal);
        Assert.Contains("StatusCodes.Status411LengthRequired", part, StringComparison.Ordinal);
        Assert.Contains("Transfer-Encoding", part, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void StaticAssetContentTypes_DoNotServeAvifUploads()
    {
        string source = ReadSource("src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs");
        string provider = ExtractBetween(source, "private static FileExtensionContentTypeProvider CreateStaticFileContentTypeProvider()", "private static void PrepareStaticAssetResponse");
        string staticAssetClassifier = ExtractBetween(source, "private static bool HasStaticAssetExtension", "internal static bool IsImmutableSearchIndexAssetPath");
        string authoring = ReadSource("src/backend/Services/Authoring/AuthoringWorkflowService.cs");
        string uploadAssetUrl = ExtractBetween(authoring, "private static bool IsUploadAssetUrl", "private sealed class AssetReferenceAggregate");

        Assert.Contains("provider.Mappings.Remove(\".avif\")", provider, StringComparison.Ordinal);
        Assert.DoesNotContain(".avif", staticAssetClassifier, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(".avif", uploadAssetUrl, StringComparison.OrdinalIgnoreCase);
    }

    private static string ReadSource(string relativePath, [CallerFilePath] string sourceFilePath = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(endIndex >= 0, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}
