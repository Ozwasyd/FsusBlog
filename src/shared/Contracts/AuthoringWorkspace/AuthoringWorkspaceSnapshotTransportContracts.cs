using FsusBlog.Contracts.AuthoringWorkspace;

namespace FsusBlog.Shared.Contracts.AuthoringWorkspace;

/// <summary>Closed mutation command. The authenticated server supplies user and site scope.</summary>
public sealed record AuthoringWorkspaceSnapshotRequest(
    string Action, long ExpectedRevision, string SourceDigest,
    AuthoringWorkspaceSnapshotLayout? Layout, string? ResetConfirmationDigest);

/// <summary>Typed projection of the canonical store receipt; digest validation remains with its authority.</summary>
public sealed record AuthoringWorkspaceSnapshotTransportReceipt(
    string Schema, string Action, string Status, string? Reason,
    AuthoringWorkspaceSnapshotScope Scope, string WorkspaceId, string SourceDigest,
    long RevisionBefore, long RevisionAfter, int TabCount, int ByteCount,
    string InputDigest, string? SnapshotDigest, string ContentDigest);

/// <summary>Complete typed result of the single workspace authority, without embedded serialized payloads.</summary>
public sealed record AuthoringWorkspaceSnapshotResponse(
    string Status, long Revision, AuthoringWorkspaceSnapshot? Snapshot,
    AuthoringWorkspaceSnapshotTransportReceipt Receipt);
