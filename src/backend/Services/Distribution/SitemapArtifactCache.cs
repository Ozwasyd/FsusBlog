using System.Collections.Frozen;
using System.Diagnostics;
using System.Text;

using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Services.Distribution;

public sealed class SitemapArtifactCache(PublicAotInvalidationTracker generation)
{
    private static readonly SitemapArtifactGenerationSnapshot s_empty = new(
        FrozenDictionary<long, SitemapArtifactSet>.Empty,
        0);
    private readonly SemaphoreSlim _buildGate = new(1, 1);
    private SitemapArtifactGenerationSnapshot _current = s_empty;
    private long _buildCount;

    internal async Task<SitemapArtifactSet> GetOrBuildAsync(
        Func<CancellationToken, Task<SitemapArtifactBuildResult>> build,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(build);
        long startedAt = Stopwatch.GetTimestamp();
        while (true)
        {
            long expectedGeneration = generation.GetSitemapGeneration();
            SitemapArtifactGenerationSnapshot snapshot = Volatile.Read(ref _current);
            if (snapshot.Artifacts.TryGetValue(expectedGeneration, out SitemapArtifactSet? cached))
            {
                FsusObservability.RecordSitemapBuild(
                    cacheHit: true,
                    cached.ResidentBytes,
                    allocationBytes: 0,
                    FsusObservability.GetElapsed(startedAt));
                return cached;
            }

            await _buildGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                expectedGeneration = generation.GetSitemapGeneration();
                snapshot = Volatile.Read(ref _current);
                if (snapshot.Artifacts.TryGetValue(expectedGeneration, out cached))
                {
                    FsusObservability.RecordSitemapBuild(
                        cacheHit: true,
                        cached.ResidentBytes,
                        allocationBytes: 0,
                        FsusObservability.GetElapsed(startedAt));
                    return cached;
                }

                _ = Interlocked.Increment(ref _buildCount);
                SitemapArtifactBuildResult built = await build(cancellationToken).ConfigureAwait(false);
                if (generation.GetSitemapGeneration() != expectedGeneration)
                {
                    continue;
                }

                SitemapArtifactSet artifact = built.Artifact with
                {
                    Generation = expectedGeneration,
                    ResidentBytes = CalculateResidentBytes(built.Artifact)
                };
                var published = new SitemapArtifactGenerationSnapshot(
                    new Dictionary<long, SitemapArtifactSet>
                    {
                        [expectedGeneration] = artifact
                    }.ToFrozenDictionary(),
                    artifact.ResidentBytes);
                Volatile.Write(ref _current, published);

                if (generation.GetSitemapGeneration() != expectedGeneration)
                {
                    _ = Interlocked.CompareExchange(ref _current, s_empty, published);
                    continue;
                }

                FsusObservability.RecordSitemapBuild(
                    cacheHit: false,
                    artifact.ResidentBytes,
                    built.AllocationBytes,
                    FsusObservability.GetElapsed(startedAt));
                return artifact;
            }
            finally
            {
                _buildGate.Release();
            }
        }
    }

    internal SitemapArtifactCacheSnapshot Snapshot()
    {
        SitemapArtifactGenerationSnapshot snapshot = Volatile.Read(ref _current);
        return new(
            snapshot.Artifacts.Keys.SingleOrDefault(),
            snapshot.Artifacts.Count,
            snapshot.ResidentBytes,
            Interlocked.Read(ref _buildCount));
    }

    private static long CalculateResidentBytes(SitemapArtifactSet artifact)
        => Encoding.UTF8.GetByteCount(artifact.RootDocument)
            + artifact.PageDocuments.Sum(Encoding.UTF8.GetByteCount);

    private sealed record SitemapArtifactGenerationSnapshot(
        IReadOnlyDictionary<long, SitemapArtifactSet> Artifacts,
        long ResidentBytes);
}

internal sealed record SitemapArtifactSet(
    string RootDocument,
    IReadOnlyList<string> PageDocuments,
    long Generation = 0,
    long ResidentBytes = 0);

internal sealed record SitemapArtifactBuildResult(
    SitemapArtifactSet Artifact,
    long AllocationBytes);

internal sealed record SitemapArtifactCacheSnapshot(
    long Generation,
    int ArtifactCount,
    long ResidentBytes,
    long BuildCount);
