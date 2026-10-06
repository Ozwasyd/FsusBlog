using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Services;

public sealed partial class SearchIndexService : ISearchProjectionEvidenceReader
{
    private static readonly UTF8Encoding s_strictUtf8 = new(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);

    public async Task<SearchProjectionEvidence> ReadAsync(
        int articleId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (articleId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(articleId));
        }

        string root = ResolveSearchRoot();
        string manifestPath = Path.Combine(root, SearchManifestFileName);
        SearchIndexManifest manifest = ReadManifest(manifestPath)
            ?? throw new InvalidDataException("search projection manifest is missing or invalid");
        SearchShardManifest core = manifest.Shards.SingleOrDefault(
                static shard => shard.Role == SearchShardRole.Core)
            ?? throw new InvalidDataException("search projection core shard is missing");
        string artifactPath = ResolvePublishedArtifactPath(root, core.FullUrl);
        byte[] artifact = await File.ReadAllBytesAsync(artifactPath, cancellationToken).ConfigureAwait(false);
        string artifactDigest = Convert.ToHexStringLower(SHA256.HashData(artifact));
        if (!string.Equals(artifactDigest, core.FullSha256, StringComparison.Ordinal))
        {
            throw new InvalidDataException("search projection core shard digest mismatch");
        }

        SearchProjectionDocumentEvidence? document = ReadDocumentEvidence(artifact, articleId);
        if (document is null)
        {
            return new SearchProjectionEvidence(
                manifest.CurrentVersion,
                manifest.GeneratedAt,
                $"sha256:{artifactDigest}",
                false,
                articleId,
                0,
                0,
                0,
                0,
                Digest(string.Empty),
                Digest(FormattableString.Invariant(
                    $"{manifest.CurrentVersion}|{articleId}|absent|{artifactDigest}")));
        }

        return new SearchProjectionEvidence(
            manifest.CurrentVersion,
            manifest.GeneratedAt,
            $"sha256:{artifactDigest}",
            true,
            articleId,
            document.RevisionId,
            document.RevisionNo,
            document.PublicationId,
            document.PublicationNo,
            Digest(document.Title),
            Digest(FormattableString.Invariant(
                $"{manifest.CurrentVersion}|{articleId}|{document.RevisionId}|{document.RevisionNo}|{document.PublicationId}|{document.PublicationNo}|{document.Title}|{artifactDigest}")));
    }

    private static SearchProjectionDocumentEvidence? ReadDocumentEvidence(
        ReadOnlySpan<byte> artifact,
        int articleId)
    {
        if (artifact.Length < HeaderSize
            || BinaryPrimitives.ReadUInt32LittleEndian(artifact) != ShardMagic
            || BinaryPrimitives.ReadUInt32LittleEndian(artifact[4..]) != SearchShardVersion
            || (SearchShardRole)BinaryPrimitives.ReadUInt32LittleEndian(artifact[8..])
                != SearchShardRole.Core)
        {
            throw new InvalidDataException("search projection core shard header is invalid");
        }

        uint documentCountValue = BinaryPrimitives.ReadUInt32LittleEndian(artifact[20..]);
        uint documentOffsetValue = BinaryPrimitives.ReadUInt32LittleEndian(artifact[40..]);
        uint stringPoolOffsetValue = BinaryPrimitives.ReadUInt32LittleEndian(artifact[56..]);
        if (documentCountValue > int.MaxValue
            || documentOffsetValue > int.MaxValue
            || stringPoolOffsetValue > int.MaxValue)
        {
            throw new InvalidDataException("search projection core shard bounds are invalid");
        }
        int documentCount = (int)documentCountValue;
        int documentOffset = (int)documentOffsetValue;
        int stringPoolOffset = (int)stringPoolOffsetValue;
        if (documentCount < 0
            || documentOffset < HeaderSize
            || stringPoolOffset < documentOffset
            || stringPoolOffset > artifact.Length
            || documentOffset > artifact.Length
            || documentCount > (artifact.Length - documentOffset) / DocMetadataSize
            || stringPoolOffset < documentOffset + documentCount * DocMetadataSize)
        {
            throw new InvalidDataException("search projection core shard bounds are invalid");
        }

        SearchProjectionDocumentEvidence? found = null;
        for (int index = 0; index < documentCount; index++)
        {
            ReadOnlySpan<byte> metadata = artifact.Slice(
                documentOffset + index * DocMetadataSize,
                DocMetadataSize);
            if (BinaryPrimitives.ReadUInt32LittleEndian(metadata) != (uint)articleId)
            {
                continue;
            }

            uint titleOffset = BinaryPrimitives.ReadUInt32LittleEndian(metadata[32..]);
            int titleLength = BinaryPrimitives.ReadUInt16LittleEndian(metadata[36..]);
            int titleStart = checked(stringPoolOffset + (int)titleOffset);
            if (titleStart < stringPoolOffset || titleStart > artifact.Length - titleLength)
            {
                throw new InvalidDataException("search projection title bounds are invalid");
            }

            if (found is not null)
            {
                throw new InvalidDataException("search projection article record is duplicated");
            }
            found = new SearchProjectionDocumentEvidence(
                s_strictUtf8.GetString(artifact.Slice(titleStart, titleLength)),
                BinaryPrimitives.ReadInt64LittleEndian(metadata[52..]),
                checked((int)BinaryPrimitives.ReadUInt32LittleEndian(metadata[60..])),
                BinaryPrimitives.ReadInt64LittleEndian(metadata[64..]),
                checked((int)BinaryPrimitives.ReadUInt32LittleEndian(metadata[72..])));
        }

        return found;
    }

    internal static SearchProjectionDocumentTestEvidence? ReadDocumentEvidenceForTests(
        byte[] artifact,
        int articleId)
    {
        SearchProjectionDocumentEvidence? evidence = ReadDocumentEvidence(artifact, articleId);
        return evidence is null
            ? null
            : new SearchProjectionDocumentTestEvidence(
                evidence.Title,
                evidence.RevisionId,
                evidence.RevisionNo,
                evidence.PublicationId,
                evidence.PublicationNo);
    }

    private static string Digest(string value)
        => "sha256:" + Convert.ToHexStringLower(
            SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private sealed record SearchProjectionDocumentEvidence(
        string Title,
        long RevisionId,
        int RevisionNo,
        long PublicationId,
        int PublicationNo);

    internal sealed record SearchProjectionDocumentTestEvidence(
        string Title,
        long RevisionId,
        int RevisionNo,
        long PublicationId,
        int PublicationNo);
}
