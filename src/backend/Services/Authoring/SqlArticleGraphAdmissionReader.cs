using System.Data.Common;
using System.Transactions;

using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.ArticleEmbeds;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

internal sealed record ArticleGraphCurrentArticleReadRequest(
    AuthorArticlePinOwner Owner,
    Guid RequestId,
    string ArticleIdentity,
    string RevisionIdentity);

internal sealed record ArticleGraphCurrentArticleAdmission(
    Guid ReadId,
    ArticleRelationRevisionCoordinate Source,
    AuthorArticlePinArticleFact Article,
    AuthorArticlePinPermissionSnapshot Permission);

/// <summary>
/// Zero-write admission of one persisted current root. The authenticated host supplies Owner;
/// editor/actor/site binding and graph expansion remain integration responsibilities (#2474).
/// SourceEpoch identifies the durable source incarnation and never supplies a runtime DocumentEpoch.
/// Admission requires PostgreSQL READ COMMITTED statement snapshots, in autocommit or a caller-owned transaction.
/// Active ambient and fixed-snapshot contexts are unavailable; the caller's transaction is never changed.
/// The original connection and transaction references must survive every read; auto-open/close is permitted.
/// Provider decisions are captured by fixed index only after the exact zero/one count is checked;
/// count/entry rereads and the original digest must agree with the owned immutable copy.
/// </summary>
public sealed class SqlArticleGraphAdmissionReader(
    ISqlSugarClient db,
    ArticleRelationSourceCoordinateAuthority coordinates,
    IAuthorArticlePinPermissionProjectionProvider permissions,
    IAuthorArticlePinArticleProjectionSource articles)
{
    private readonly record struct CurrentReadContext(
        System.Data.IDbConnection Connection,
        System.Data.IDbTransaction? Transaction);

    internal async Task<ArticleGraphCurrentArticleAdmission?> ReadCurrentAsync(
        ArticleGraphCurrentArticleReadRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            AuthorArticlePinContract.ValidateOwner(request.Owner);
            AuthorArticlePinContract.ValidateRequestId(request.RequestId);
            if (!ArticleEmbedTargetCodec.IsPortableArticleIdentity(request.ArticleIdentity)
                || !IsRevisionIdentity(request.RevisionIdentity)
                || Transaction.Current is not null)
            {
                return null;
            }
            var context = new CurrentReadContext(db.Ado.Connection, db.Ado.Transaction);

            // Authenticate live context before even resolving the portable identity.
            AuthorArticlePinPermissionSnapshot? preflight = await ReadPermissionAsync(request, [], context, cancellationToken)
                .ConfigureAwait(false);
            if (preflight is null)
            {
                return null;
            }
            ArticleRelationArticleCoordinate? binding = await coordinates.FindArticleAsync(
                db, request.ArticleIdentity, cancellationToken).ConfigureAwait(false);
            if (binding is null || binding.ArticleId <= 0 || binding.ArticleIdentity != request.ArticleIdentity
                || !await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            IReadOnlyList<int> articleIds = Array.AsReadOnly(new[] { binding.ArticleId });
            AuthorArticlePinPermissionSnapshot? permission = await ReadPermissionAsync(request, articleIds, context, cancellationToken)
                .ConfigureAwait(false);
            if (permission is null || !SameContext(preflight, permission))
            {
                return null;
            }

            // Metadata is read only after BOTH projection and opening authority succeed.
            AuthorArticlePinArticleFact? article = await ReadArticleAsync(binding.ArticleId, articleIds, context, cancellationToken)
                .ConfigureAwait(false);
            if (article is null)
            {
                return null;
            }
            ArticleRelationRevisionCoordinate? source = await coordinates.ReadRevisionAsync(
                db, article.ArticleId, article.CurrentRevisionId, cancellationToken).ConfigureAwait(false);
            if (source is null || source.ArticleId != article.ArticleId
                || source.RevisionId != article.CurrentRevisionId || source.RevisionNo != article.RevisionNo
                || source.ArticleIdentity != request.ArticleIdentity || source.RevisionIdentity != request.RevisionIdentity
                || source.SourceEpoch == Guid.Empty
                || !await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
            {
                return null;
            }

            // Fresh source reads detect drift; the old permission snapshot is never a validation provider.
            ArticleRelationRevisionCoordinate? currentSource = await coordinates.ReadRevisionAsync(
                db, article.ArticleId, article.CurrentRevisionId, cancellationToken).ConfigureAwait(false);
            if (currentSource != source
                || !await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            AuthorArticlePinArticleFact? currentArticle = await ReadArticleAsync(binding.ArticleId, articleIds, context, cancellationToken)
                .ConfigureAwait(false);
            if (currentArticle != article)
            {
                return null;
            }
            AuthorArticlePinPermissionSnapshot? currentPermission = await ReadPermissionAsync(request, articleIds, context, cancellationToken)
                .ConfigureAwait(false);
            if (currentPermission is null || !SamePermission(permission, currentPermission)
                || !HasFreshTransactionContext(context))
            {
                return null;
            }
            cancellationToken.ThrowIfCancellationRequested();
            return new(Guid.CreateVersion7(), source, currentArticle, currentPermission);
        }
        catch (Exception)
        {
            // A failed source has the same content-free outcome as missing/denied sources.
            // Preserve caller cancellation even if a dependency reports it as a driver failure.
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
    }

    internal async Task<ArticleGraphCurrentArticleAdmission?> RevalidateCurrentAsync(
        ArticleGraphCurrentArticleReadRequest request,
        ArticleGraphCurrentArticleAdmission admission,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticleGraphCurrentArticleAdmission? current = await ReadCurrentAsync(request, cancellationToken).ConfigureAwait(false);
        try
        {
            // Input digests/seals alone grant no authority; compare against actual fresh reads.
            return current is not null && admission.ReadId != Guid.Empty
                && current.Source == admission.Source && current.Article == admission.Article
                && SamePermission(current.Permission, admission.Permission)
                ? current
                : null;
        }
        catch (Exception)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
    }

    private async Task<AuthorArticlePinPermissionSnapshot?> ReadPermissionAsync(
        ArticleGraphCurrentArticleReadRequest request,
        IReadOnlyList<int> articleIds,
        CurrentReadContext context,
        CancellationToken cancellationToken)
    {
        if (!IsSameReadContext(context))
        {
            return null;
        }
        AuthorArticlePinPermissionSnapshot snapshot = await permissions.ResolveAsync(
            new(request.Owner, request.RequestId, articleIds), cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // Never enumerate a provider-owned collection, including in the digest authority.
        // This reader requests only an empty preflight or one root decision.
        int count = articleIds.Count;
        IReadOnlyList<AuthorArticlePinPermissionDecision> supplied = snapshot.Decisions;
        if (count is < 0 or > 1 || supplied is null || supplied.Count != count)
        {
            return null;
        }
        AuthorArticlePinPermissionDecision[] decisions = count == 0 ? [] : [supplied[0]];
        snapshot = snapshot with
        {
            Decisions = Array.AsReadOnly(decisions)
        };
        if (supplied.Count != count
            || snapshot.Status != AuthorArticlePinPermissionSnapshotStatus.Current || snapshot.Owner != request.Owner
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.PermissionRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.SiteRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.SessionRevision))
        {
            return null;
        }
        if (count == 1)
        {
            AuthorArticlePinPermissionDecision decision = decisions[0];
            if (decision is null || decision.ArticleId != articleIds[0] || !decision.CanProject || !decision.CanOpen
                || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(decision.PermissionReference))
            {
                return null;
            }
        }
        // Verify the ORIGINAL digest, then reject observed same-count entry replacement.
        // Finite rereads are not an atomic provider revision or host usage fence.
        if (snapshot.ContentDigest != AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot)
            || count == 1 && supplied[0] != decisions[0] || supplied.Count != count)
        {
            return null;
        }
        return await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false) ? snapshot : null;
    }

    private async Task<AuthorArticlePinArticleFact?> ReadArticleAsync(
        int articleId,
        IReadOnlyList<int> articleIds,
        CurrentReadContext context,
        CancellationToken cancellationToken)
    {
        if (!await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        IReadOnlyList<AuthorArticlePinArticleFact> facts = await articles.ReadCurrentBatchAsync(articleIds, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (facts.Count != 1
            || !await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        AuthorArticlePinArticleFact fact = facts[0];
        return fact.ArticleId == articleId && fact.Exists && !fact.IsDeleted
            && Enum.IsDefined(fact.Status) && fact.Status != ArticleStatus.Deleted
            && fact.Title is not null && fact.CurrentRevisionId > 0 && fact.RevisionNo > 0
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(fact.ArticleVersionReference)
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(fact.RevisionVersionReference)
            && fact.ContentDigest == AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact)
            ? fact
            : null;
    }

    private async Task<bool> HasFreshStatementSnapshotsAsync(CurrentReadContext context, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!HasFreshTransactionContext(context))
        {
            return false;
        }

        // Ado.Transaction alone cannot see an already-enlisted ambient connector or a native
        // transaction started directly on the borrowed connection. Observe the actual server
        // isolation as well; repeated SELECTs in a fixed snapshot are never fresh validation.
        string isolation;
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT current_setting('transaction_isolation');").ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return false;
            }
            isolation = reader.GetString(0);
        }
        cancellationToken.ThrowIfCancellationRequested();
        return isolation == "read committed" && HasFreshTransactionContext(context);
    }

    private bool HasFreshTransactionContext(CurrentReadContext context)
    {
        if (!IsSameReadContext(context)
            || db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL
            || context.Connection is not NpgsqlConnection)
        {
            return false;
        }
        return context.Transaction is null
            || (context.Transaction is NpgsqlTransaction transaction
                && ReferenceEquals(transaction.Connection, context.Connection)
                && transaction.IsolationLevel == System.Data.IsolationLevel.ReadCommitted);
    }

    private bool IsSameReadContext(CurrentReadContext context)
        => Transaction.Current is null
            && ReferenceEquals(db.Ado.Connection, context.Connection)
            && ReferenceEquals(db.Ado.Transaction, context.Transaction);

    private static bool IsRevisionIdentity(string identity)
        => identity is not null && identity.StartsWith("revision:", StringComparison.Ordinal)
            && Guid.TryParseExact(identity["revision:".Length..], "D", out Guid value)
            && value != Guid.Empty && identity == $"revision:{value:D}";

    private static bool SameContext(AuthorArticlePinPermissionSnapshot first, AuthorArticlePinPermissionSnapshot second)
        => first.Owner == second.Owner && first.PermissionRevision == second.PermissionRevision
            && first.SiteRevision == second.SiteRevision && first.SessionRevision == second.SessionRevision;

    private static bool SamePermission(AuthorArticlePinPermissionSnapshot first, AuthorArticlePinPermissionSnapshot second)
        => SameContext(first, second) && first.Status == second.Status && first.ReasonCode == second.ReasonCode
            && first.ContentDigest == second.ContentDigest
            && second.ContentDigest == AuthorArticlePinProjectionContract.ComputePermissionDigest(second)
            && first.Decisions.SequenceEqual(second.Decisions);
}
