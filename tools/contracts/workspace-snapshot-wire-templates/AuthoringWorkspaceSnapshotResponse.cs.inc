ArgumentNullException.ThrowIfNull(value.Receipt);
var receipt = value.Receipt;
bool present = value.Status is "current" or "applied";
if (value.Status != receipt.Status || value.Revision != receipt.RevisionAfter
    || present != (value.Snapshot is not null)
    || (!present && (receipt.SnapshotDigest is not null || receipt.TabCount != 0 || receipt.ByteCount != 0))
    || (value.Status == "missing" && (receipt.Action != "read" || value.Revision != 0))
    || (value.Status == "current" && (receipt.Action != "read" || receipt.RevisionBefore != value.Revision))
    || (value.Status == "applied" && (receipt.Action == "read" || value.Revision != receipt.RevisionBefore + 1)))
{
    throw new FormatException("workspace_snapshot_result_binding");
}
if (value.Snapshot is { } snapshot
    && (snapshot.Revision != value.Revision || snapshot.Scope != receipt.Scope
        || snapshot.SourceDigest != receipt.SourceDigest || snapshot.WorkspaceId != receipt.WorkspaceId
        || snapshot.ContentDigest != receipt.SnapshotDigest || snapshot.Layout.Tabs.Length != receipt.TabCount
        || receipt.ByteCount == 0))
{
    throw new FormatException("workspace_snapshot_receipt_binding");
}
