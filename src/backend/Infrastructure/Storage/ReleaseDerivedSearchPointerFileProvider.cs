using System.Diagnostics.CodeAnalysis;
using System.Text.Json;

using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Storage;

/// <summary>
/// Serves release-derived search mutable aliases from the generation named by
/// <c>current.json</c> so a request cannot observe a lagging compatibility copy.
/// </summary>
internal sealed class ReleaseDerivedSearchPointerFileProvider : IFileProvider, IDisposable
{
    private const string SearchKind = "search";
    private const string PointerFileName = "current.json";
    private const string GenerationsDirectoryName = "generations";
    private static readonly HashSet<string> s_pointerResolvedFileNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "index.manifest.aeds",
        "index.bin"
    };

    private readonly PhysicalFileProvider _inner;

    public ReleaseDerivedSearchPointerFileProvider(string root)
    {
        _inner = new PhysicalFileProvider(root);
    }

    public IDirectoryContents GetDirectoryContents(string subpath)
        => _inner.GetDirectoryContents(subpath);

    public IChangeToken Watch(string filter)
    {
        if (!TryParseSearchPointerFile(filter, out string? releaseId, out _))
        {
            return _inner.Watch(filter);
        }

        return new CompositeChangeToken(
        [
            _inner.Watch(filter),
            _inner.Watch(Combine(releaseId, SearchKind, PointerFileName))
        ]);
    }

    public IFileInfo GetFileInfo(string subpath)
    {
        if (!TryParseSearchPointerFile(subpath, out string? releaseId, out string? fileName))
        {
            return _inner.GetFileInfo(subpath);
        }

        string? generation = TryReadCurrentGeneration(releaseId);
        if (generation is null)
        {
            return _inner.GetFileInfo(subpath);
        }

        IFileInfo generationFile = _inner.GetFileInfo(
            Combine(releaseId, SearchKind, GenerationsDirectoryName, generation, fileName));
        return generationFile.Exists ? generationFile : _inner.GetFileInfo(subpath);
    }

    public void Dispose() => _inner.Dispose();

    internal static bool TryParseSearchPointerFile(
        string? subpath,
        [NotNullWhen(true)] out string? releaseId,
        [NotNullWhen(true)] out string? fileName)
    {
        releaseId = null;
        fileName = null;
        if (string.IsNullOrWhiteSpace(subpath))
        {
            return false;
        }

        string normalized = subpath.Replace('\\', '/').Trim('/');
        string[] segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length != 3
            || !string.Equals(segments[1], SearchKind, StringComparison.Ordinal)
            || !s_pointerResolvedFileNames.Contains(segments[2])
            || !IsSafeReleaseId(segments[0]))
        {
            return false;
        }

        releaseId = segments[0];
        fileName = segments[2];
        return true;
    }

    private string? TryReadCurrentGeneration(string releaseId)
    {
        IFileInfo pointer = _inner.GetFileInfo(Combine(releaseId, SearchKind, PointerFileName));
        if (!pointer.Exists || pointer.IsDirectory)
        {
            return null;
        }

        try
        {
            using Stream stream = pointer.CreateReadStream();
            using JsonDocument document = JsonDocument.Parse(stream);
            if (!document.RootElement.TryGetProperty("Generation", out JsonElement generationElement))
            {
                return null;
            }

            string? generation = generationElement.GetString();
            return IsSafeGeneration(generation) ? generation : null;
        }
        catch (JsonException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    private static bool IsSafeReleaseId(string candidate)
        => candidate.Length is >= 6 and <= 128
            && char.IsAsciiLetterOrDigit(candidate[0])
            && candidate.All(static character => char.IsAsciiLetterOrDigit(character)
                || character is '.' or '_' or '-');

    private static bool IsSafeGeneration(string? generation)
        => !string.IsNullOrWhiteSpace(generation)
            && generation.Length <= 128
            && char.IsAsciiLetterOrDigit(generation[0])
            && generation.All(static character => char.IsAsciiLetterOrDigit(character)
                || character is '.' or '_' or '-');

    private static string Combine(params string[] segments)
        => string.Join('/', segments);
}
