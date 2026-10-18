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
/// Caller cancellation is observed after collection getters and before refusal; later getters
/// are not evaluated after the first refusal, and unrelated dependency cancellation remains unavailable.
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
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }
            var context = new CurrentReadContext(db.Ado.Connection, db.Ado.Transaction);
            cancellationToken.ThrowIfCancellationRequested();

            // Authenticate live context before even resolving the portable identity.
            AuthorArticlePinPermissionSnapshot? preflight = await ReadPermissionAsync(request, [], context, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (preflight is null)
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }
            ArticleRelationArticleCoordinate? binding = await coordinates.FindArticleAsync(
                db, request.ArticleIdentity, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (binding is null || binding.ArticleId <= 0 || binding.ArticleIdentity != request.ArticleIdentity
                || !await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }
            IReadOnlyList<int> articleIds = Array.AsReadOnly(new[] { binding.ArticleId });
            AuthorArticlePinPermissionSnapshot? permission = await ReadPermissionAsync(request, articleIds, context, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (permission is null || !SameContext(preflight, permission))
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }

            // Metadata is read only after BOTH projection and opening authority succeed.
            AuthorArticlePinArticleFact? article = await ReadArticleAsync(binding.ArticleId, articleIds, context, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (article is null)
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }
            ArticleRelationRevisionCoordinate? source = await coordinates.ReadRevisionAsync(
                db, article.ArticleId, article.CurrentRevisionId, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (source is null || source.ArticleId != article.ArticleId
                || source.RevisionId != article.CurrentRevisionId || source.RevisionNo != article.RevisionNo
                || source.ArticleIdentity != request.ArticleIdentity || source.RevisionIdentity != request.RevisionIdentity
                || source.SourceEpoch == Guid.Empty
                || !await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }

            // Fresh source reads detect drift; the old permission snapshot is never a validation provider.
            ArticleRelationRevisionCoordinate? currentSource = await coordinates.ReadRevisionAsync(
                db, article.ArticleId, article.CurrentRevisionId, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (currentSource != source
                || !await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }
            AuthorArticlePinArticleFact? currentArticle = await ReadArticleAsync(binding.ArticleId, articleIds, context, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (currentArticle != article)
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }
            AuthorArticlePinPermissionSnapshot? currentPermission = await ReadPermissionAsync(request, articleIds, context, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (currentPermission is null || !SamePermission(permission, currentPermission)
                || !HasFreshTransactionContext(context))
            {
                cancellationToken.ThrowIfCancellationRequested();
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
            bool matches = current is not null && admission.ReadId != Guid.Empty
                && current.Source == admission.Source && current.Article == admission.Article
                && SamePermission(current.Permission, admission.Permission);
            cancellationToken.ThrowIfCancellationRequested();
            return matches ? current : null;
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
        bool sameReadContext = IsSameReadContext(context);
        cancellationToken.ThrowIfCancellationRequested();
        if (!sameReadContext)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
        AuthorArticlePinPermissionSnapshot snapshot = await permissions.ResolveAsync(
            new(request.Owner, request.RequestId, articleIds), cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // Never enumerate a provider-owned collection, including in the digest authority.
        // This reader requests only an empty preflight or one root decision.
        int count = articleIds.Count;
        cancellationToken.ThrowIfCancellationRequested();
        IReadOnlyList<AuthorArticlePinPermissionDecision> supplied = snapshot.Decisions;
        if (count is < 0 or > 1 || supplied is null)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
        int suppliedCount = supplied.Count;
        cancellationToken.ThrowIfCancellationRequested();
        if (suppliedCount != count)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
        AuthorArticlePinPermissionDecision[] decisions = count == 0 ? [] : [supplied[0]];
        cancellationToken.ThrowIfCancellationRequested();
        snapshot = snapshot with
        {
            Decisions = Array.AsReadOnly(decisions)
        };
        int capturedCount = supplied.Count;
        cancellationToken.ThrowIfCancellationRequested();
        if (capturedCount != count
            || snapshot.Status != AuthorArticlePinPermissionSnapshotStatus.Current || snapshot.Owner != request.Owner
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.PermissionRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.SiteRevision)
            || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(snapshot.SessionRevision))
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
        if (count == 1)
        {
            AuthorArticlePinPermissionDecision decision = decisions[0];
            if (decision is null || decision.ArticleId != articleIds[0] || !decision.CanProject || !decision.CanOpen
                || !AuthorArticlePinProjectionContract.IsRequiredRevisionReference(decision.PermissionReference))
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }
        }
        // Verify the ORIGINAL digest, then reject observed same-count entry replacement.
        // Finite rereads are not an atomic provider revision or host usage fence.
        if (snapshot.ContentDigest != AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot))
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
        if (count == 1)
        {
            AuthorArticlePinPermissionDecision currentDecision = supplied[0];
            cancellationToken.ThrowIfCancellationRequested();
            if (currentDecision != decisions[0])
            {
                cancellationToken.ThrowIfCancellationRequested();
                return null;
            }
        }
        int verifiedCount = supplied.Count;
        cancellationToken.ThrowIfCancellationRequested();
        if (verifiedCount != count)
        {
            cancellationToken.ThrowIfCancellationRequested();
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
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
        IReadOnlyList<AuthorArticlePinArticleFact> facts = await articles.ReadCurrentBatchAsync(articleIds, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        int count = facts.Count;
        cancellationToken.ThrowIfCancellationRequested();
        if (count != 1
            || !await HasFreshStatementSnapshotsAsync(context, cancellationToken).ConfigureAwait(false))
        {
            cancellationToken.ThrowIfCancellationRequested();
            return null;
        }
        AuthorArticlePinArticleFact fact = facts[0];
        cancellationToken.ThrowIfCancellationRequested();
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
        bool freshContext = HasFreshTransactionContext(context);
        cancellationToken.ThrowIfCancellationRequested();
        if (!freshContext)
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
            bool hasRow = await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (!hasRow)
            {
                return false;
            }
            isolation = reader.GetString(0);
        }
        cancellationToken.ThrowIfCancellationRequested();
        bool fresh = isolation == "read committed" && HasFreshTransactionContext(context);
        cancellationToken.ThrowIfCancellationRequested();
        return fresh;
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
