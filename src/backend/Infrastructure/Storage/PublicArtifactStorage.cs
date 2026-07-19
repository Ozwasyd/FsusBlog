using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure.Storage;

public enum PublicArtifactKind
{
    PublicAotDocument,
    HydrationSidecar,
    ArticleDetailAeds
}

public readonly record struct PublicArtifactKey(
    PublicArtifactKind Kind,
    string RouteKey,
    string PathKey,
    string FrontendAssetVersion,
    string ContentVersion)
{
    public static PublicArtifactKey PublicAotDocument(
        string routeKey,
        string cacheKey,
        string frontendAssetVersion,
        string rendererVersion)
        => new(PublicArtifactKind.PublicAotDocument, routeKey, cacheKey, frontendAssetVersion, rendererVersion);

    public static PublicArtifactKey HydrationSidecar(
        string routeKey,
        string sha256Hex,
        string frontendAssetVersion)
        => new(PublicArtifactKind.HydrationSidecar, routeKey, sha256Hex, frontendAssetVersion, sha256Hex);

    public static PublicArtifactKey ArticleDetail(int articleId)
        => new(
            PublicArtifactKind.ArticleDetailAeds,
            $"article:{articleId}",
            articleId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "frontend-independent",
            "aeds-v2");
}

public sealed record PublicArtifactDescriptor(
    PublicArtifactKey Key,
    string MediaType,
    string Sha256Hex,
    long Bytes);

public sealed record PublicArtifactReadResult(
    PublicArtifactDescriptor Descriptor,
    ReadOnlyMemory<byte> Content);

public interface IPublicArtifactStorage
{
    Task<PublicArtifactDescriptor> WriteAsync(
        PublicArtifactKey key,
        string mediaType,
        ReadOnlyMemory<byte> content,
        CancellationToken cancellationToken = default);

    Task<PublicArtifactReadResult?> TryReadAsync(
        PublicArtifactKey key,
        string expectedMediaType,
        string? expectedSha256Hex = null,
        CancellationToken cancellationToken = default);

    bool IsValid(
        PublicArtifactKey key,
        string expectedMediaType,
        string? expectedSha256Hex = null);

    Task RemoveAsync(PublicArtifactKey key, CancellationToken cancellationToken = default);
}

public sealed class LocalPublicArtifactStorage : IPublicArtifactStorage
{
    public const string AedsMediaType = "application/vnd.fsusblog.aeds";
    public const string HtmlMediaType = "text/html; charset=utf-8";

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _contentRoot;
    private readonly string _webRoot;
    private readonly ILogger<LocalPublicArtifactStorage> _logger;

    public LocalPublicArtifactStorage(
        IWebHostEnvironment env,
        ILogger<LocalPublicArtifactStorage>? logger = null)
    {
        ArgumentNullException.ThrowIfNull(env);
        _contentRoot = Path.GetFullPath(env.ContentRootPath);
        _webRoot = Path.GetFullPath(string.IsNullOrWhiteSpace(env.WebRootPath)
            ? Path.Combine(env.ContentRootPath, "wwwroot")
            : env.WebRootPath);
        Directory.CreateDirectory(_webRoot);
        _logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<LocalPublicArtifactStorage>.Instance;
    }

    public async Task<PublicArtifactDescriptor> WriteAsync(
        PublicArtifactKey key,
        string mediaType,
        ReadOnlyMemory<byte> content,
        CancellationToken cancellationToken = default)
    {
        ValidateKey(key);
        ValidateMediaType(mediaType);
        if (content.IsEmpty)
        {
            throw new ArgumentException("Public artifact content must not be empty.", nameof(content));
        }

        string targetPath = ResolvePath(key);
        string metadataPath = GetMetadataPath(targetPath);
        string directory = Path.GetDirectoryName(targetPath)!;
        Directory.CreateDirectory(directory);

        string sha256Hex = Convert.ToHexStringLower(SHA256.HashData(content.Span));
        var descriptor = new PublicArtifactDescriptor(key, mediaType, sha256Hex, content.Length);
        byte[] metadata = JsonSerializer.SerializeToUtf8Bytes(descriptor, s_jsonOptions);
        string token = Guid.NewGuid().ToString("N");
        string contentTemp = Path.Combine(directory, $"{Path.GetFileName(targetPath)}.{token}.tmp");
        string metadataTemp = Path.Combine(directory, $"{Path.GetFileName(metadataPath)}.{token}.tmp");
        try
        {
            await File.WriteAllBytesAsync(contentTemp, content, cancellationToken).ConfigureAwait(false);
            await File.WriteAllBytesAsync(metadataTemp, metadata, cancellationToken).ConfigureAwait(false);
            File.Move(contentTemp, targetPath, overwrite: true);
            File.Move(metadataTemp, metadataPath, overwrite: true);
            return descriptor;
        }
        finally
        {
            File.Delete(contentTemp);
            File.Delete(metadataTemp);
        }
    }

    public async Task<PublicArtifactReadResult?> TryReadAsync(
        PublicArtifactKey key,
        string expectedMediaType,
        string? expectedSha256Hex = null,
        CancellationToken cancellationToken = default)
    {
        ValidateKey(key);
        ValidateMediaType(expectedMediaType);
        string targetPath = ResolvePath(key);
        if (!File.Exists(targetPath))
        {
            return null;
        }

        try
        {
            byte[] content = await File.ReadAllBytesAsync(targetPath, cancellationToken).ConfigureAwait(false);
            return ValidateRead(key, expectedMediaType, expectedSha256Hex, targetPath, content);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _logger.LogWarning(ex, "public_artifact_read_failed {Kind} {RouteKey}", key.Kind, key.RouteKey);
            return null;
        }
    }

    public bool IsValid(PublicArtifactKey key, string expectedMediaType, string? expectedSha256Hex = null)
    {
        ValidateKey(key);
        ValidateMediaType(expectedMediaType);
        string targetPath = ResolvePath(key);
        if (!File.Exists(targetPath))
        {
            return false;
        }

        try
        {
            byte[] content = File.ReadAllBytes(targetPath);
            return ValidateRead(key, expectedMediaType, expectedSha256Hex, targetPath, content) is not null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _logger.LogWarning(ex, "public_artifact_validation_failed {Kind} {RouteKey}", key.Kind, key.RouteKey);
            return false;
        }
    }

    public Task RemoveAsync(PublicArtifactKey key, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateKey(key);
        string targetPath = ResolvePath(key);
        File.Delete(targetPath);
        File.Delete(GetMetadataPath(targetPath));
        return Task.CompletedTask;
    }

    internal string ResolvePathForTests(PublicArtifactKey key) => ResolvePath(key);

    private PublicArtifactReadResult? ValidateRead(
        PublicArtifactKey key,
        string expectedMediaType,
        string? expectedSha256Hex,
        string targetPath,
        byte[] content)
    {
        string actualHash = Convert.ToHexStringLower(SHA256.HashData(content));
        if (!string.IsNullOrWhiteSpace(expectedSha256Hex)
            && !string.Equals(actualHash, expectedSha256Hex, StringComparison.Ordinal))
        {
            return null;
        }

        string metadataPath = GetMetadataPath(targetPath);
        if (!File.Exists(metadataPath))
        {
            // Compatibility read for content-addressed sidecars and pre-abstraction artifacts.
            var legacy = new PublicArtifactDescriptor(key, expectedMediaType, actualHash, content.LongLength);
            return new PublicArtifactReadResult(legacy, content);
        }

        PublicArtifactDescriptor? descriptor = JsonSerializer.Deserialize<PublicArtifactDescriptor>(
            File.ReadAllBytes(metadataPath),
            s_jsonOptions);
        if (descriptor is null
            || descriptor.Key != key
            || !string.Equals(descriptor.MediaType, expectedMediaType, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(descriptor.Sha256Hex, actualHash, StringComparison.Ordinal)
            || descriptor.Bytes != content.LongLength)
        {
            return null;
        }

        return new PublicArtifactReadResult(descriptor, content);
    }

    private string ResolvePath(PublicArtifactKey key)
    {
        string candidate = key.Kind switch
        {
            PublicArtifactKind.HydrationSidecar => ResolveHydrationSidecarPath(key.PathKey),
            PublicArtifactKind.ArticleDetailAeds => Path.Combine(_contentRoot, "runtime-cache", "public", "articles", $"{NormalizeArticlePathKey(key.PathKey)}.aeds"),
            PublicArtifactKind.PublicAotDocument => Path.Combine(
                _contentRoot,
                "runtime-cache",
                "public-artifacts",
                "aot-documents",
                StablePathToken(key.FrontendAssetVersion),
                $"{StablePathToken(key.PathKey)}.html"),
            _ => throw new ArgumentOutOfRangeException(nameof(key), key.Kind, "Unknown public artifact kind.")
        };

        string boundary = key.Kind == PublicArtifactKind.HydrationSidecar ? _webRoot : _contentRoot;
        if (!CanonicalPathBoundary.TryResolveCandidate(boundary, candidate, out string canonicalPath))
        {
            throw new InvalidOperationException("public_artifact_path_outside_root");
        }

        return canonicalPath;
    }

    private string ResolveHydrationSidecarPath(string pathKey)
    {
        string normalized = NormalizeShaPathKey(pathKey);
        return Path.Combine(_webRoot, "aot-cache", "payloads", normalized[..2], $"{normalized}.aeds");
    }

    private static string GetMetadataPath(string targetPath) => string.Concat(targetPath, ".artifact.json");

    private static string StablePathToken(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string NormalizeShaPathKey(string value)
        => value.Length == 64 && value.All(static character => char.IsAsciiHexDigit(character))
            ? value.ToLowerInvariant()
            : throw new ArgumentException("Hydration sidecar path key must be a SHA-256 hex digest.", nameof(value));

    private static string NormalizeArticlePathKey(string value)
        => int.TryParse(value, out int articleId) && articleId > 0
            ? articleId.ToString(System.Globalization.CultureInfo.InvariantCulture)
            : throw new ArgumentException("Article artifact path key must be a positive integer.", nameof(value));

    private static void ValidateKey(PublicArtifactKey key)
    {
        if (string.IsNullOrWhiteSpace(key.RouteKey)
            || string.IsNullOrWhiteSpace(key.PathKey)
            || string.IsNullOrWhiteSpace(key.FrontendAssetVersion)
            || string.IsNullOrWhiteSpace(key.ContentVersion))
        {
            throw new ArgumentException("Public artifact key fields must not be empty.", nameof(key));
        }
    }

    private static void ValidateMediaType(string mediaType)
    {
        if (string.IsNullOrWhiteSpace(mediaType))
        {
            throw new ArgumentException("Public artifact media type must not be empty.", nameof(mediaType));
        }
    }
}
