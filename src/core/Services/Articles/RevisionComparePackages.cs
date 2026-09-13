using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed class RevisionCompareSnapshot
{
    private RevisionCompareSnapshot(
        RevisionCompareSnapshotKind kind,
        RevisionCompareSnapshotState state,
        string? reference,
        int schemaVersion,
        ImmutableArray<byte> payload,
        string? payloadDigest)
    {
        Kind = kind;
        State = state;
        Reference = reference;
        SchemaVersion = schemaVersion;
        Payload = payload;
        PayloadDigest = payloadDigest;
    }

    public RevisionCompareSnapshotKind Kind
    {
        get;
    }

    public RevisionCompareSnapshotState State
    {
        get;
    }

    public string? Reference
    {
        get;
    }

    public int SchemaVersion
    {
        get;
    }

    public ImmutableArray<byte> Payload
    {
        get;
    }

    public string? PayloadDigest
    {
        get;
    }

    public static RevisionCompareSnapshot Present(
        RevisionCompareSnapshotKind kind,
        string reference,
        int schemaVersion,
        ReadOnlySpan<byte> payload)
    {
        if (string.IsNullOrWhiteSpace(reference) || schemaVersion <= 0 || payload.IsEmpty)
        {
            throw new RevisionCompareContractException("revision_compare_snapshot_invalid");
        }

        ImmutableArray<byte> bytes = [.. payload];
        return new RevisionCompareSnapshot(
            kind,
            RevisionCompareSnapshotState.Present,
            reference,
            schemaVersion,
            bytes,
            RevisionCompareCanonical.Sha256(bytes.AsSpan()));
    }

    public static RevisionCompareSnapshot NotApplicable(RevisionCompareSnapshotKind kind)
        => new(kind, RevisionCompareSnapshotState.NotApplicable, null, 0, [], null);

    public static RevisionCompareSnapshot Missing(RevisionCompareSnapshotKind kind)
        => new(kind, RevisionCompareSnapshotState.Missing, null, 0, [], null);
}

public sealed class RevisionComparePackage
{
    internal RevisionComparePackage(
        int articleId,
        RevisionCompareSourceKind sourceKind,
        string sourceIdentity,
        long? revisionId,
        int? revisionNo,
        long? serverRevision,
        string? documentEpoch,
        ImmutableArray<byte> rawMarkdown,
        string sourceDigest,
        ImmutableArray<RevisionCompareMetadataValue> metadata,
        ImmutableArray<RevisionCompareSnapshot> snapshots,
        string packageDigest)
    {
        ArticleId = articleId;
        SourceKind = sourceKind;
        SourceIdentity = sourceIdentity;
        RevisionId = revisionId;
        RevisionNo = revisionNo;
        ServerRevision = serverRevision;
        DocumentEpoch = documentEpoch;
        RawMarkdown = rawMarkdown;
        SourceDigest = sourceDigest;
        Metadata = metadata;
        Snapshots = snapshots;
        PackageDigest = packageDigest;
    }

    public int ArticleId
    {
        get;
    }

    public RevisionCompareSourceKind SourceKind
    {
        get;
    }

    public string SourceIdentity
    {
        get;
    }

    public long? RevisionId
    {
        get;
    }

    public int? RevisionNo
    {
        get;
    }

    public long? ServerRevision
    {
        get;
    }

    public string? DocumentEpoch
    {
        get;
    }

    public ImmutableArray<byte> RawMarkdown
    {
        get;
    }

    public string SourceDigest
    {
        get;
    }

    public ImmutableArray<RevisionCompareMetadataValue> Metadata
    {
        get;
    }

    public ImmutableArray<RevisionCompareSnapshot> Snapshots
    {
        get;
    }

    public string PackageDigest
    {
        get;
    }
}
