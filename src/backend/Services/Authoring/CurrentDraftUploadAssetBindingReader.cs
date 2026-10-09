using System.Globalization;
using System.Security.Claims;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Current Writer coordinates supplied by its original context reader. ContentDigest is the
/// opaque canonical JSON digest; SourceSha256 separately identifies the exact markdown bytes.
/// ContextDigest retains the original context reader's complete scope/session binding.
/// These digests grant no permission and do not prove persistence.
/// </summary>
public sealed record CurrentDraftUploadAssetContext(
    string RequestId,
    int? ArticleId,
    string DocumentId,
    string DraftId,
    long DocumentEpoch,
    long SourceRevision,
    string? DraftRevision,
    string ContextDigest,
    string ContentDigest,
    string SourceSha256);

/// <summary>DraftKey is the real server key, independently supplied by the draft owner.</summary>
public sealed record CurrentDraftUploadAssetReference(
    string DraftKey,
    int? ArticleId,
    long? ServerRevision,
    AssetId AssetId,
    CurrentDraftUploadAssetContext Context);

public enum CurrentDraftUploadAssetReadStatus
{
    Available,
    Unavailable,
    Unconfirmed
}

/// <summary>
/// Request-time read facts, not a reference receipt, permission grant or atomic read lease.
/// The original upload observation and exact draft ledger edge retain their identities.
/// </summary>
public sealed record CurrentDraftUploadAssetObservation(
    CurrentDraftUploadAssetReference Reference,
    long OwnerAdminPrincipalId,
    ServerDraftResponse SavedDraft,
    VaultSourceByteIdentity Source,
    UploadAssetObservation Upload,
    AssetReference DraftReference);

public sealed record CurrentDraftUploadAssetReadResult(
    CurrentDraftUploadAssetReadStatus Status,
    string? ReasonCode,
    CurrentDraftUploadAssetObservation? Observation);

/// <summary>
/// Joins the original owner-scoped saved draft read with the original session/native/ledger
/// observer. SaveDraftAsync owns the atomic CAS/reference write; this reader never saves.
/// The host must reread its actual context and withdraw these facts when that context changes.
/// </summary>
public sealed class CurrentDraftUploadAssetBindingReader(
    IAuthoringDraftLifecycle drafts,
    IFileService files)
{
    public async Task<CurrentDraftUploadAssetReadResult> ObserveSavedDraftAsync(
        CurrentDraftUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        Func<CurrentDraftUploadAssetContext> readCurrentContext,
        CancellationToken cancellationToken = default)
        => (await ReadSavedDraftAsync(reference, principal, session, sha256, readCurrentContext,
            false, cancellationToken).ConfigureAwait(false)).Read;

    /// <summary>
    /// Reads original owned bytes with an existing saved-draft edge. Unavailable/unconfirmed
    /// results carry no bytes. This never saves a draft or declares upload/reuse admission.
    /// </summary>
    public Task<(CurrentDraftUploadAssetReadResult Read, ReadOnlyMemory<byte> Bytes)> ReadSavedDraftInputAsync(
        CurrentDraftUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        Func<CurrentDraftUploadAssetContext> readCurrentContext,
        CancellationToken cancellationToken = default)
        => ReadSavedDraftAsync(reference, principal, session, sha256, readCurrentContext, true, cancellationToken);

    private async Task<(CurrentDraftUploadAssetReadResult Read, ReadOnlyMemory<byte> Bytes)> ReadSavedDraftAsync(
        CurrentDraftUploadAssetReference reference,
        ClaimsPrincipal principal,
        UploadSessionAccess session,
        string sha256,
        Func<CurrentDraftUploadAssetContext> readCurrentContext,
        bool includeBytes,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(principal);
        ArgumentNullException.ThrowIfNull(readCurrentContext);
        cancellationToken.ThrowIfCancellationRequested();
        CurrentDraftUploadAssetContext context = reference.Context;
        if (context is null || string.IsNullOrWhiteSpace(context.RequestId)
            || string.IsNullOrWhiteSpace(context.DocumentId) || string.IsNullOrWhiteSpace(context.DraftId)
            || context.DocumentEpoch < 0 || context.SourceRevision < 0 || context.ArticleId != reference.ArticleId
            || !Digest(context.ContextDigest) || !Digest(context.ContentDigest)
            || !Digest(context.SourceSha256) || !Digest(sha256)
            || string.IsNullOrWhiteSpace(reference.DraftKey) || reference.DraftKey.Length > 96
            || reference.DraftKey != reference.DraftKey.Trim()
            || reference.ArticleId is <= 0 || reference.AssetId.Value == Guid.Empty
            || !principal.IsAdminPrincipal() || principal.Identity?.IsAuthenticated != true
            || !principal.TryGetAdminPrincipalId(out long adminId) || adminId <= 0
            || adminId != session.OwnerAdminPrincipalId)
        {
            return (Unavailable("input_or_owner_invalid"), default);
        }
        if (!Current())
        {
            return (Unconfirmed("current_context_changed"), default);
        }
        if (reference.ServerRevision is not > 0 || context.DraftRevision is null)
        {
            return (Unavailable("saved_draft_reference_unavailable"), default);
        }
        if (context.DraftRevision != $"server:{reference.ServerRevision.Value.ToString(CultureInfo.InvariantCulture)}")
        {
            return (Unconfirmed("saved_draft_revision_changed"), default);
        }

        ServerDraftResponse? before = await drafts.GetDraftAsync(adminId, reference.DraftKey, cancellationToken)
            .ConfigureAwait(false);
        if (!Current())
        {
            return (Unconfirmed("current_context_changed"), default);
        }
        if (before is null)
        {
            return (Unavailable("saved_draft_reference_unavailable"), default);
        }
        if (!Matches(before))
        {
            return (Unconfirmed("saved_draft_source_changed"), default);
        }
        // Freeze mutable collections at the read boundary; a reused DTO cannot hide later drift.
        before = before with
        {
            TagIds = Array.AsReadOnly(before.TagIds.ToArray())
        };
        ReadOnlyMemory<byte> bytes = default;
        var first = includeBytes
            ? (await files.ReadCommittedUploadInputAsync(session, sha256, cancellationToken).ConfigureAwait(false))
                .Map(input =>
                {
                    bytes = input.Bytes;
                    return input.Observation;
                })
            : await files.ObserveCommittedUploadAsync(session, sha256, cancellationToken).ConfigureAwait(false);
        if (!Current())
        {
            return (Unconfirmed("current_context_changed"), default);
        }
        if (!first.IsSuccess || first.Value is not { } uploadBefore || Edge(uploadBefore) is null)
        {
            return (Unavailable("upload_or_draft_reference_unavailable"), default);
        }
        uploadBefore = CurrentUploadAssetReferenceBinding.Freeze(uploadBefore);
        var second = await files.ObserveCommittedUploadAsync(session, sha256, cancellationToken).ConfigureAwait(false);
        if (!Current())
        {
            return (Unconfirmed("current_context_changed"), default);
        }
        if (!second.IsSuccess || second.Value is not { } uploadAfter || Edge(uploadAfter) is not { } edge)
        {
            return (Unconfirmed("upload_or_draft_reference_changed"), default);
        }
        uploadAfter = CurrentUploadAssetReferenceBinding.Freeze(uploadAfter);
        ServerDraftResponse? after = await drafts.GetDraftAsync(adminId, reference.DraftKey, cancellationToken)
            .ConfigureAwait(false);
        if (!Current())
        {
            return (Unconfirmed("current_context_changed"), default);
        }
        if (after is null || !Matches(after)
            || (before with
            {
                TagIds = after.TagIds
            }) != after || !before.TagIds.SequenceEqual(after.TagIds)
            || uploadBefore.Asset != uploadAfter.Asset || uploadBefore.PublicUrl != uploadAfter.PublicUrl
            || uploadBefore.AssetVersionSha256 != uploadAfter.AssetVersionSha256
            || uploadBefore.ReferenceLedgerSha256 != uploadAfter.ReferenceLedgerSha256
            || !uploadBefore.References.SequenceEqual(uploadAfter.References))
        {
            return (Unconfirmed("current_facts_changed"), default);
        }
        after = after with
        {
            TagIds = Array.AsReadOnly(after.TagIds.ToArray())
        };
        VaultSourceByteIdentity source = Source(after);
        if (!Current())
        {
            return (Unconfirmed("current_context_changed"), default);
        }
        return (new(CurrentDraftUploadAssetReadStatus.Available, null, new(reference, adminId, after,
            source, uploadAfter, edge)), bytes);

        bool Current()
        {
            cancellationToken.ThrowIfCancellationRequested();
            CurrentDraftUploadAssetContext current = readCurrentContext();
            cancellationToken.ThrowIfCancellationRequested();
            return current == context && principal.Identity?.IsAuthenticated == true && principal.IsAdminPrincipal()
                && principal.TryGetAdminPrincipalId(out long currentAdminId) && currentAdminId == adminId;
        }

        bool Matches(ServerDraftResponse draft)
            => draft.DraftKey == reference.DraftKey && draft.ArticleId == reference.ArticleId
                && draft.ServerRevision == reference.ServerRevision && Source(draft).Sha256 == context.SourceSha256;

        AssetReference? Edge(UploadAssetObservation upload)
            => CurrentUploadAssetReferenceBinding.FindReference(upload, session, reference.AssetId, sha256,
                ContentAssetSourceKinds.Draft,
                string.Concat(adminId.ToString(CultureInfo.InvariantCulture), ":", reference.DraftKey), reference.ArticleId);
    }

    private static VaultSourceByteIdentity Source(ServerDraftResponse draft)
        => ArticleVaultManifestCodec.CaptureSourceBytes(new UTF8Encoding(false, true).GetBytes(draft.Content));

    private static bool Digest(string? value) => value is { Length: 64 }
        && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static CurrentDraftUploadAssetReadResult Unavailable(string reason)
        => new(CurrentDraftUploadAssetReadStatus.Unavailable, reason, null);

    private static CurrentDraftUploadAssetReadResult Unconfirmed(string reason)
        => new(CurrentDraftUploadAssetReadStatus.Unconfirmed, reason, null);
}
