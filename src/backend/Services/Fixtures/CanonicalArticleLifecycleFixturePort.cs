// fixture-catalog: port canonical-article-lifecycle
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public static class CanonicalArticleLifecycleVariants
{
    public const string Draft = "draft";
    public const string Scheduled = "scheduled";
    public const string Published = "published";
    public const string PublishedScheduledUpdate = "published-scheduled-update";
    public const string Archived = "archived";
    public const string Deleted = "deleted";
    public const string Restore = "restore";
    public const string Rollback = "rollback";
    public const string MultipleRevisions = "multiple-revisions";
    public const string MultiplePublications = "multiple-publications";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        Draft,
        Scheduled,
        Published,
        PublishedScheduledUpdate,
        Archived,
        Deleted,
        Restore,
        Rollback,
        MultipleRevisions,
        MultiplePublications
    };
}

public sealed record CanonicalArticleLifecycleFixtureBinding(
    string RunId,
    string Namespace,
    string ProfileId,
    IReadOnlyList<string> Capabilities,
    long AdminPrincipalId,
    string WriterContractDigest,
    string TemporalContextDigest)
{
    public void Validate()
    {
        if (string.IsNullOrWhiteSpace(RunId))
            throw new CanonicalArticleLifecycleValidationException("run_id_required");
        if (string.IsNullOrWhiteSpace(Namespace))
            throw new CanonicalArticleLifecycleValidationException("namespace_required");
        if (string.IsNullOrWhiteSpace(ProfileId))
            throw new CanonicalArticleLifecycleValidationException("profile_id_required");
        if (Capabilities is null || Capabilities.Count == 0)
            throw new CanonicalArticleLifecycleValidationException("capabilities_required");
        if (AdminPrincipalId <= 0)
            throw new CanonicalArticleLifecycleValidationException("admin_principal_id_invalid");
        if (!string.Equals(
                WriterContractDigest,
                CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest,
                StringComparison.Ordinal))
            throw new CanonicalArticleLifecycleValidationException("writer_contract_digest_mismatch");
        if (!IsDigest(TemporalContextDigest))
            throw new CanonicalArticleLifecycleValidationException("temporal_context_digest_invalid");
    }

    private static bool IsDigest(string value)
        => !string.IsNullOrWhiteSpace(value)
            && ((value.StartsWith("sha256:", StringComparison.Ordinal) && value.Length == 71)
                || value.Length == 64)
            && value.AsSpan(value.StartsWith("sha256:", StringComparison.Ordinal) ? 7 : 0)
                .IndexOfAnyExcept("0123456789abcdefABCDEF") < 0;
}

public sealed record CanonicalArticleLifecyclePlan(
    string SemanticRole,
    string Variant,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    ArticleRightsRequestCoreModel? Rights,
    ArticleResponsibilityDraft? Responsibility,
    DateTime? ScheduledPublishAt = null,
    string? RollbackReason = null,
    long? ExpectedRevisionId = null,
    long? RollbackTargetRevisionId = null);

public sealed record CanonicalArticleLifecycleRequest(
    CanonicalArticleLifecycleFixtureBinding Binding,
    CanonicalArticleLifecyclePlan Plan,
    Guid? RequestId = null);

public sealed record CanonicalArticleLifecycleOperationReceipt(
    string TransitionId,
    string Operation,
    ArticleStatus? BeforeStatus,
    ArticleStatus AfterStatus,
    bool BeforeDeleted,
    bool AfterDeleted,
    long? BeforeRevisionId,
    int? BeforeRevisionNo,
    long AfterRevisionId,
    int AfterRevisionNo,
    long? BeforePublicationId,
    int? BeforePublicationNo,
    long? AfterPublicationId,
    int? AfterPublicationNo,
    long? RightsSnapshotId,
    long? ResponsibilitySnapshotId,
    int? ResponsibilityVersion,
    long? RollbackSourceRevisionId,
    DateTime TransitionedAtUtc,
    DateTime? ScheduledPublishAt,
    string ContentDigest,
    string OutboxEventId,
    string OutboxPayloadDigest,
    string AuditChainId,
    string AuditRecordHash);

public sealed record CanonicalArticleLifecycleReceipt(
    string Schema,
    string WriterContractDigest,
    string TemporalContextDigest,
    string RunId,
    string Namespace,
    string ProfileId,
    string SemanticRole,
    string Variant,
    long AdminPrincipalId,
    int ArticleId,
    IReadOnlyList<CanonicalArticleLifecycleOperationReceipt> Operations,
    IReadOnlyList<long> RevisionIds,
    IReadOnlyList<long> PublicationIds,
    long CurrentRevisionId,
    long? CurrentPublicationId,
    ArticleStatus CurrentStatus,
    bool IsDeleted,
    string ContentDigest,
    string RevisionTimelineDigest,
    string ReceiptDigest);

public sealed record CanonicalArticleLifecycleResult(
    CanonicalArticleLifecycleReceipt Receipt,
    CanonicalArticleLifecycleVerificationResult Verification,
    bool IdempotencyReplay = false);

public interface ICanonicalArticleLifecycleFixturePort
{
    Task<CanonicalArticleLifecycleResult> ExecuteAsync(
        CanonicalArticleLifecycleRequest request,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Completes an existing scheduled fixture only after its injected business clock reaches
    /// the persisted due time. The caller owns clock advancement; this port never advances it.
    /// </summary>
    Task<CanonicalArticleLifecycleResult> PublishScheduledAsync(
        CanonicalArticleLifecycleFixtureBinding binding,
        CanonicalArticleLifecycleReceipt scheduledReceipt,
        CancellationToken cancellationToken = default);
}

public sealed class CanonicalArticleLifecycleValidationException(string code, string? message = null)
    : InvalidOperationException(message ?? code)
{
    public string Code { get; } = code;
}

public sealed class CanonicalArticleLifecycleFixturePort(
    ISqlSugarClient db,
    IConfiguration configuration,
    IArticlePublicationValidator publicationValidator,
    IArticlePublicMutationFence mutationFence,
    TimeProvider? timeProvider = null) : ICanonicalArticleLifecycleFixturePort
{
    public const string Schema = "fsusblog.canonical-article-lifecycle-receipt.v1";
    public const string DefaultWriterContract = ArticleLifecycleTransitionWriter.WriterContract;
    public static string CurrentWriterContractDigest { get; } = ComputeDigest(DefaultWriterContract);
    private const string ExecutionAuditSchema = "fsusblog.canonical-article-lifecycle-execution.v1";
    private const string ExecutionAuditTargetType = "article-canonical-lifecycle-execution";
    internal const string ScheduledRecoveryFailureKey = "canonical_article_lifecycle_scheduled_recovery_failure";
    internal const string ScheduledRecoveryCompletedKey = "canonical_article_lifecycle_scheduled_recovery_completed";
    internal const string ScheduledRecoveryQualifiedKey = "canonical_article_lifecycle_scheduled_recovery_qualified";

    private sealed record ExecutionAuditEnvelope(
        string Schema,
        string RequestHash,
        CanonicalArticleLifecycleReceipt Receipt,
        IReadOnlyList<string> Capabilities);

    public async Task<CanonicalArticleLifecycleResult> ExecuteAsync(
        CanonicalArticleLifecycleRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Binding);
        ArgumentNullException.ThrowIfNull(request.Plan);
        request.Binding.Validate();
        ValidatePlan(request.Plan);

        DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
        DateTime? scheduledAt = request.Plan.ScheduledPublishAt;
        if (request.Plan.Variant is CanonicalArticleLifecycleVariants.Scheduled
            or CanonicalArticleLifecycleVariants.PublishedScheduledUpdate)
        {
            if (!scheduledAt.HasValue || scheduledAt.Value <= now)
            {
                throw new CanonicalArticleLifecycleValidationException(
                    "scheduled_at_must_be_future",
                    "Scheduled fixtures must bind a future business-clock time.");
            }
        }

        string clientMutationId = (request.RequestId ?? DeriveClientMutationId(
            request.Binding.RunId,
            request.Binding.Namespace,
            request.Plan.SemanticRole)).ToString("D");
        string requestHash = ComputeRequestHash(request.Binding, request.Plan);
        ArticleMutationCommand? existingCommand = await LoadMutationCommandAsync(
            request.Binding.AdminPrincipalId,
            clientMutationId,
            cancellationToken).ConfigureAwait(false);
        if (existingCommand is not null)
        {
            return await ReplayAsync(
                existingCommand,
                request,
                clientMutationId,
                requestHash,
                cancellationToken).ConfigureAwait(false);
        }

        bool fenceEstablished = false;
        bool mutationCommitted = false;
        var results = new List<ArticleLifecycleTransitionWriter.Result>();
        CanonicalArticleLifecycleReceipt? receipt = null;
        bool idempotencyReplay = false;
        try
        {
            await mutationFence.BeginPublicMutationFenceAsync(null, cancellationToken).ConfigureAwait(false);
            fenceEstablished = true;
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
                await db.Ado.ExecuteCommandAsync(
                    "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2174));",
                    new SugarParameter(
                        "@Identity",
                        $"canonical-article-lifecycle:{request.Binding.AdminPrincipalId}:{clientMutationId}"))
                    .ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();

                ArticleMutationCommand? concurrentCommand = await LoadMutationCommandAsync(
                    request.Binding.AdminPrincipalId,
                    clientMutationId,
                    cancellationToken).ConfigureAwait(false);
                if (concurrentCommand is not null)
                {
                    CanonicalArticleLifecycleResult replay = await ReplayAsync(
                        concurrentCommand,
                        request,
                        clientMutationId,
                        requestHash,
                        cancellationToken).ConfigureAwait(false);
                    receipt = replay.Receipt;
                    idempotencyReplay = true;
                    return;
                }

                switch (request.Plan.Variant)
                {
                    case CanonicalArticleLifecycleVariants.Draft:
                        results.Add(await CreateAsync(request.Plan, request.Binding, ArticleStatus.Draft, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
                        break;
                    case CanonicalArticleLifecycleVariants.Scheduled:
                        results.Add(await CreateAsync(request.Plan, request.Binding, ArticleStatus.Scheduled, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
                        break;
                    case CanonicalArticleLifecycleVariants.Published:
                        results.Add(await CreateAsync(request.Plan, request.Binding, ArticleStatus.Published, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
                        break;
                    case CanonicalArticleLifecycleVariants.PublishedScheduledUpdate:
                        await ExecutePublishedScheduledUpdateAsync(request.Plan, request.Binding, now, results, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false);
                        break;
                    case CanonicalArticleLifecycleVariants.Archived:
                        await ExecuteArchivedAsync(request.Plan, request.Binding, now, results, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false);
                        break;
                    case CanonicalArticleLifecycleVariants.Deleted:
                        await ExecuteDeletedAsync(request.Plan, request.Binding, now, results, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false);
                        break;
                    case CanonicalArticleLifecycleVariants.Restore:
                        await ExecuteRestoreAsync(request.Plan, request.Binding, now, results, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false);
                        break;
                    case CanonicalArticleLifecycleVariants.Rollback:
                        await ExecuteRollbackAsync(request.Plan, request.Binding, now, results, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false);
                        break;
                    case CanonicalArticleLifecycleVariants.MultipleRevisions:
                        await ExecuteMultipleRevisionsAsync(request.Plan, request.Binding, now, results, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false);
                        break;
                    case CanonicalArticleLifecycleVariants.MultiplePublications:
                        await ExecuteMultiplePublicationsAsync(request.Plan, request.Binding, now, results, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false);
                        break;
                    default:
                        throw new CanonicalArticleLifecycleValidationException("variant_unknown");
                }

                receipt = await BuildReceiptAsync(
                    request.Binding,
                    request.Plan,
                    results,
                    cancellationToken).ConfigureAwait(false);
                CanonicalArticleLifecycleVerificationResult authority = await CanonicalArticleLifecycleVerifier
                    .VerifyAsync(db, configuration, receipt, cancellationToken, timeProvider)
                    .ConfigureAwait(false);
                authority.ThrowIfInvalid();
                await WriteExecutionAuditAsync(
                    request.Binding.AdminPrincipalId,
                    clientMutationId,
                    requestHash,
                    receipt,
                    request.Binding.Capabilities,
                    now,
                    cancellationToken).ConfigureAwait(false);
            }).ConfigureAwait(false);
            if (!transaction.IsSuccess)
            {
                if (transaction.ErrorException is Exception transactionError)
                {
                    throw transactionError;
                }

                throw new InvalidOperationException("canonical_article_lifecycle_transaction_failed");
            }

            if (receipt is null)
            {
                throw new InvalidOperationException("canonical_article_lifecycle_transaction_failed");
            }
            mutationCommitted = true;
        }
        finally
        {
            if (fenceEstablished && !mutationCommitted)
            {
                await mutationFence.RecoverAbortedPublicMutationFenceAsync(
                    null,
                    "canonical-article-lifecycle-fence-aborted",
                    cancellationToken).ConfigureAwait(false);
            }
        }

        CanonicalArticleLifecycleReceipt committedReceipt = receipt
            ?? throw new InvalidOperationException("canonical_article_lifecycle_transaction_failed");
        CanonicalArticleLifecycleVerificationResult verification = await CanonicalArticleLifecycleVerifier
            .VerifyAsync(db, configuration, committedReceipt, cancellationToken, timeProvider)
            .ConfigureAwait(false);
        if (!verification.IsValid)
        {
            throw new InvalidOperationException(
                $"canonical_article_lifecycle_verification_failed:{request.Plan.Variant}:{string.Join(',', verification.Violations)}");
        }
        await mutationFence.CommitPublicMutationFenceAsync(
            null,
            "canonical-article-lifecycle-authority",
            cancellationToken).ConfigureAwait(false);
        return new CanonicalArticleLifecycleResult(committedReceipt, verification, idempotencyReplay);
    }

    public async Task<CanonicalArticleLifecycleResult> PublishScheduledAsync(
        CanonicalArticleLifecycleFixtureBinding binding,
        CanonicalArticleLifecycleReceipt scheduledReceipt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(scheduledReceipt);
        binding.Validate();
        if (scheduledReceipt.RunId != binding.RunId
            || scheduledReceipt.Namespace != binding.Namespace
            || scheduledReceipt.ProfileId != binding.ProfileId
            || scheduledReceipt.AdminPrincipalId != binding.AdminPrincipalId
            || scheduledReceipt.WriterContractDigest != binding.WriterContractDigest
            || scheduledReceipt.TemporalContextDigest != binding.TemporalContextDigest)
        {
            throw new CanonicalArticleLifecycleValidationException("scheduled_receipt_binding_mismatch");
        }
        CanonicalArticleLifecycleOperationReceipt? pending = scheduledReceipt.Operations?.LastOrDefault();
        if (pending is null
            || scheduledReceipt.IsDeleted
            || !(scheduledReceipt.Variant == CanonicalArticleLifecycleVariants.Scheduled
                && pending.Operation == "create" && pending.AfterStatus == ArticleStatus.Scheduled
                || scheduledReceipt.Variant == CanonicalArticleLifecycleVariants.PublishedScheduledUpdate
                && pending.Operation == "scheduled-update" && pending.AfterStatus == ArticleStatus.Published)
            || pending.ScheduledPublishAt is not DateTime dueAt)
        {
            throw new CanonicalArticleLifecycleValidationException("scheduled_receipt_not_pending");
        }
        if ((timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime < dueAt)
        {
            throw new CanonicalArticleLifecycleValidationException("scheduled_publication_not_due");
        }

        bool fenceEstablished = false;
        bool mutationCommitted = false;
        CanonicalArticleLifecycleResult? result = null;
        Exception? primaryFailure = null;
        try
        {
            await mutationFence.BeginPublicMutationFenceAsync(null, cancellationToken).ConfigureAwait(false);
            fenceEstablished = true;
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
                // Serialize with the production transition and re-read the original authority
                // under the same article lock; a stale or altered receipt cannot add facts.
                await db.Ado.GetScalarAsync(
                    "SELECT id FROM article WHERE id = @ArticleId FOR UPDATE;",
                    new SugarParameter("@ArticleId", scheduledReceipt.ArticleId)).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                ArticleMutationCommand? command = await db.Queryable<ArticleMutationCommand>()
                    .Where(item => item.ArticleId == scheduledReceipt.ArticleId
                                && item.AdminPrincipalId == binding.AdminPrincipalId)
                    .FirstAsync(cancellationToken).ConfigureAwait(false);
                if (command is null)
                {
                    throw new CanonicalArticleLifecycleValidationException("scheduled_origin_command_missing");
                }
                ExecutionAuditEnvelope origin = await LoadExecutionAuditAsync(
                    binding.AdminPrincipalId, command.ClientMutationId, cancellationToken).ConfigureAwait(false);
                if (origin.Schema != ExecutionAuditSchema || origin.RequestHash != command.RequestHash
                    || origin.Receipt.ReceiptDigest != scheduledReceipt.ReceiptDigest
                    || origin.Capabilities is null
                    || !origin.Capabilities.Order(StringComparer.Ordinal)
                        .SequenceEqual(binding.Capabilities.Order(StringComparer.Ordinal), StringComparer.Ordinal))
                {
                    throw new CanonicalArticleLifecycleValidationException("scheduled_origin_receipt_mismatch");
                }
                CanonicalArticleLifecycleVerificationResult before = await CanonicalArticleLifecycleVerifier
                    .VerifyAsync(db, configuration, scheduledReceipt, cancellationToken, timeProvider)
                    .ConfigureAwait(false);
                before.ThrowIfInvalid();
                DateTime now = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
                if (now < dueAt)
                {
                    throw new CanonicalArticleLifecycleValidationException("scheduled_publication_not_due");
                }
                ArticleLifecycleTransitionWriter.Result published = await ArticleLifecycleTransitionWriter.PublishScheduledAsync(
                    db,
                    configuration,
                    new ArticleLifecycleTransitionWriter.ScheduledPublishRequest(
                        scheduledReceipt.ArticleId,
                        scheduledReceipt.CurrentRevisionId,
                        now,
                        binding.AdminPrincipalId,
                        scheduledReceipt.SemanticRole),
                    cancellationToken).ConfigureAwait(false);
                CanonicalArticleLifecycleReceipt receipt = await BuildReceiptAsync(
                    binding,
                    scheduledReceipt.SemanticRole,
                    scheduledReceipt.Variant,
                    [.. scheduledReceipt.Operations!, MapOperation(published)],
                    published,
                    cancellationToken).ConfigureAwait(false);
                CanonicalArticleLifecycleVerificationResult verification = await CanonicalArticleLifecycleVerifier
                    .VerifyAsync(db, configuration, receipt, cancellationToken, timeProvider)
                    .ConfigureAwait(false);
                verification.ThrowIfInvalid();
                result = new CanonicalArticleLifecycleResult(receipt, verification);
            }).ConfigureAwait(false);
            if (!transaction.IsSuccess)
            {
                if (transaction.ErrorException is Exception transactionError)
                {
                    ExceptionDispatchInfo.Capture(transactionError).Throw();
                }
                throw new InvalidOperationException("canonical_article_lifecycle_transaction_failed");
            }
            if (result is null)
            {
                throw new InvalidOperationException("canonical_article_lifecycle_transaction_failed");
            }
            mutationCommitted = true;
        }
        catch (Exception exception)
        {
            primaryFailure = exception;
            throw;
        }
        finally
        {
            if (fenceEstablished && !mutationCommitted)
            {
                // Preserve the first refusal/fault and its original classification.
                // The recovery port returning is not proof of durable lease or
                // physical cleanup; a failed recovery remains an explicit obligation.
                if (primaryFailure is not null)
                {
                    primaryFailure.Data[ScheduledRecoveryCompletedKey] = false;
                    primaryFailure.Data[ScheduledRecoveryQualifiedKey] = false;
                }
                try
                {
                    await mutationFence.RecoverAbortedPublicMutationFenceAsync(
                        null,
                        "canonical-article-lifecycle-fence-aborted",
                        cancellationToken).ConfigureAwait(false);
                    if (primaryFailure is not null)
                    {
                        primaryFailure.Data[ScheduledRecoveryCompletedKey] = true;
                    }
                }
                catch (Exception recoveryFailure) when (primaryFailure is not null)
                {
                    primaryFailure.Data[ScheduledRecoveryFailureKey] = recoveryFailure;
                }
            }
        }
        await mutationFence.CommitPublicMutationFenceAsync(
            null,
            "canonical-article-lifecycle-authority",
            cancellationToken).ConfigureAwait(false);
        return result;
    }

    private Task<CanonicalArticleLifecycleReceipt> BuildReceiptAsync(
        CanonicalArticleLifecycleFixtureBinding binding,
        CanonicalArticleLifecyclePlan plan,
        IReadOnlyList<ArticleLifecycleTransitionWriter.Result> results,
        CancellationToken cancellationToken)
    {
        if (results.Count == 0)
        {
            throw new InvalidOperationException("canonical_article_lifecycle_transaction_failed");
        }

        return BuildReceiptAsync(
            binding, plan.SemanticRole, plan.Variant, results.Select(MapOperation).ToArray(), results[^1], cancellationToken);
    }

    private async Task<CanonicalArticleLifecycleReceipt> BuildReceiptAsync(
        CanonicalArticleLifecycleFixtureBinding binding,
        string semanticRole,
        string variant,
        IReadOnlyList<CanonicalArticleLifecycleOperationReceipt> operations,
        ArticleLifecycleTransitionWriter.Result last,
        CancellationToken cancellationToken)
    {
        List<ArticleRevision> revisionRecords = await db.Queryable<ArticleRevision>()
            .Where(item => item.ArticleId == last.ArticleId)
            .OrderBy(item => item.RevisionNo, OrderByType.Asc)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        long[] revisionIds = revisionRecords.Select(item => item.Id).ToArray();
        long[] contentBlockIds = revisionRecords.Select(item => item.ContentBlockId).Distinct().ToArray();
        List<ArticleRevisionContentBlock> revisionBlocks = await db.Queryable<ArticleRevisionContentBlock>()
            .Where(item => contentBlockIds.Contains(item.Id))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        IReadOnlyList<long> publicationIds = await db.Queryable<ArticlePublicationRecord>()
            .Where(item => item.ArticleId == last.ArticleId)
            .OrderBy(item => item.PublicationNo, OrderByType.Asc)
            .Select(item => item.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        string revisionTimelineDigest = ComputeRevisionTimelineDigest(revisionRecords, revisionBlocks);
        return new CanonicalArticleLifecycleReceipt(
            Schema,
            binding.WriterContractDigest,
            binding.TemporalContextDigest,
            binding.RunId,
            binding.Namespace,
            binding.ProfileId,
            semanticRole,
            variant,
            binding.AdminPrincipalId,
            last.ArticleId,
            operations,
            revisionIds,
            publicationIds,
            last.After.RevisionId ?? throw new InvalidOperationException("lifecycle current revision missing"),
            last.After.PublicationId,
            last.After.Status,
            last.After.IsDeleted,
            last.ContentDigest,
            revisionTimelineDigest,
            ComputeReceiptDigest(
                binding.WriterContractDigest,
                binding.TemporalContextDigest,
                binding.RunId,
                binding.Namespace,
                binding.ProfileId,
                semanticRole,
                variant,
                binding.AdminPrincipalId,
                last.ArticleId,
                operations,
                revisionIds,
                publicationIds,
                last.After.RevisionId,
                last.After.PublicationId,
                last.After.Status,
                last.After.IsDeleted,
                last.ContentDigest,
                revisionTimelineDigest));
    }

    private async Task<ArticleMutationCommand?> LoadMutationCommandAsync(
        long adminPrincipalId,
        string clientMutationId,
        CancellationToken cancellationToken)
        => await db.Queryable<ArticleMutationCommand>()
            .Where(item => item.AdminPrincipalId == adminPrincipalId
                        && item.ClientMutationId == clientMutationId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

    private async Task<ExecutionAuditEnvelope> LoadExecutionAuditAsync(
        long adminId,
        string clientMutationId,
        CancellationToken cancellationToken)
    {
        string adminPrincipalId = adminId.ToString(CultureInfo.InvariantCulture);
        AuditLog? executionAudit = await db.Queryable<AuditLog>()
            .ClearFilter()
            .Where(item => item.TargetType == ExecutionAuditTargetType
                        && item.TargetId == clientMutationId
                        && item.ActorId == adminPrincipalId)
            .OrderBy(item => item.Id, OrderByType.Desc)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (executionAudit is null || string.IsNullOrWhiteSpace(executionAudit.ContextJson))
        {
            throw new InvalidOperationException("canonical_article_lifecycle_replay_receipt_missing");
        }

        byte[]? tamperKey = AuditTamperEvidence.ResolveKey(configuration);
        bool auditValid;
        if (tamperKey is not null)
        {
            auditValid = AuditTamperEvidence.Verify(executionAudit, tamperKey);
        }
        else
        {
            AuditRecord unsigned = AuditTamperEvidence.FromLog(executionAudit) with
            {
                RecordHash = null,
                RecordMac = null
            };
            AuditTamperEvidenceResult expected = AuditTamperEvidence.Sign(unsigned, key: null);
            auditValid = AuditTamperEvidence.FixedTimeEqualsHexSha256(
                executionAudit.RecordHash,
                expected.RecordHash);
        }
        if (!auditValid)
        {
            throw new InvalidOperationException("canonical_article_lifecycle_replay_audit_invalid");
        }

        ExecutionAuditEnvelope envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<ExecutionAuditEnvelope>(executionAudit.ContextJson)
                ?? throw new InvalidOperationException("canonical_article_lifecycle_replay_receipt_invalid");
        }
        catch (JsonException exception)
        {
            throw new InvalidOperationException(
                "canonical_article_lifecycle_replay_receipt_invalid",
                exception);
        }
        return envelope;
    }

    private async Task<CanonicalArticleLifecycleResult> ReplayAsync(
        ArticleMutationCommand command,
        CanonicalArticleLifecycleRequest request,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(command.RequestHash, requestHash, StringComparison.Ordinal))
        {
            throw new ArticleMutationContentConflictException();
        }
        ExecutionAuditEnvelope envelope = await LoadExecutionAuditAsync(
            request.Binding.AdminPrincipalId, clientMutationId, cancellationToken).ConfigureAwait(false);

        CanonicalArticleLifecycleReceipt receipt = envelope.Receipt;
        if (!string.Equals(envelope.Schema, ExecutionAuditSchema, StringComparison.Ordinal)
            || !string.Equals(envelope.RequestHash, requestHash, StringComparison.Ordinal)
            || receipt.ArticleId != command.ArticleId
            || receipt.AdminPrincipalId != request.Binding.AdminPrincipalId
            || !string.Equals(receipt.RunId, request.Binding.RunId, StringComparison.Ordinal)
            || !string.Equals(receipt.Namespace, request.Binding.Namespace, StringComparison.Ordinal)
            || !string.Equals(receipt.ProfileId, request.Binding.ProfileId, StringComparison.Ordinal)
            || !string.Equals(receipt.WriterContractDigest, request.Binding.WriterContractDigest, StringComparison.Ordinal)
            || !string.Equals(receipt.TemporalContextDigest, request.Binding.TemporalContextDigest, StringComparison.Ordinal)
            || !string.Equals(receipt.SemanticRole, request.Plan.SemanticRole, StringComparison.Ordinal)
            || !string.Equals(receipt.Variant, request.Plan.Variant, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("canonical_article_lifecycle_replay_binding_mismatch");
        }

        CanonicalArticleLifecycleVerificationResult verification = await CanonicalArticleLifecycleVerifier
            .VerifyAsync(db, configuration, receipt, cancellationToken, timeProvider)
            .ConfigureAwait(false);
        verification.ThrowIfInvalid();
        return new CanonicalArticleLifecycleResult(receipt, verification, IdempotencyReplay: true);
    }

    private async Task WriteExecutionAuditAsync(
        long adminPrincipalId,
        string clientMutationId,
        string requestHash,
        CanonicalArticleLifecycleReceipt receipt,
        IReadOnlyList<string> capabilities,
        DateTime occurredAt,
        CancellationToken cancellationToken)
    {
        string contextJson = JsonSerializer.Serialize(
            new ExecutionAuditEnvelope(ExecutionAuditSchema, requestHash, receipt, capabilities.Order(StringComparer.Ordinal).ToArray()));
        string eventInfo = ComputeDigest(contextJson);
        await AuthoringSignedAuditWriter.InsertAsync(
            db,
            AuditTamperEvidence.ResolveKey(configuration),
            new AuditRecord(
                Source: AuditSourceCatalog.Article,
                Type: AuditTypeCatalog.Business,
                OccurredAtUtc: occurredAt,
                EventInfo: eventInfo,
                ContextPayload: null,
                Action: AdminPermissions.ArticleWrite,
                Outcome: AuditOutcomeCatalog.Success,
                Severity: AuditSeverityCatalog.Info,
                ActorType: AuditActorTypeCatalog.Admin,
                ActorId: adminPrincipalId.ToString(CultureInfo.InvariantCulture),
                ActorRole: "admin",
                TargetType: ExecutionAuditTargetType,
                TargetId: clientMutationId,
                IsHighValue: true,
                ReasonCode: "canonical-lifecycle-execution",
                ContextJson: contextJson),
            cancellationToken).ConfigureAwait(false);
    }

    private static Guid DeriveClientMutationId(string runId, string ns, string semanticRole)
    {
        byte[] hash = SHA256.HashData(
            Encoding.UTF8.GetBytes($"canonical-lifecycle:{runId}:{ns}:{semanticRole}"));
        Span<byte> guidBytes = stackalloc byte[16];
        hash.AsSpan(0, 16).CopyTo(guidBytes);
        return new Guid(guidBytes);
    }

    public static string ComputeRequestHash(
        CanonicalArticleLifecycleFixtureBinding binding,
        CanonicalArticleLifecyclePlan plan)
    {
        string json = JsonSerializer.Serialize(new
        {
            binding.RunId,
            binding.Namespace,
            binding.ProfileId,
            Capabilities = binding.Capabilities.Order(StringComparer.Ordinal).ToArray(),
            binding.WriterContractDigest,
            binding.TemporalContextDigest,
            plan.SemanticRole,
            plan.Variant,
            plan.Title,
            plan.Content,
            plan.Summary,
            plan.CoverImageUrl,
            plan.CategoryId,
            TagIds = plan.TagIds.Order().ToArray(),
            plan.Rights,
            plan.Responsibility,
            plan.ScheduledPublishAt,
            plan.RollbackReason,
            plan.ExpectedRevisionId,
            plan.RollbackTargetRevisionId
        });
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
    }

    private async Task<ArticleLifecycleTransitionWriter.Result> CreateAsync(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        ArticleStatus status,
        DateTime now,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        await ValidateContentAsync(plan, status, now, cancellationToken).ConfigureAwait(false);
        return await ArticleLifecycleTransitionWriter.CreateAsync(
            db,
            configuration,
            new ArticleLifecycleTransitionWriter.CreateRequest(
                plan.Title,
                plan.Content,
                plan.Summary,
                plan.CoverImageUrl,
                plan.CategoryId,
                plan.TagIds,
                status,
                status == ArticleStatus.Scheduled ? plan.ScheduledPublishAt : null,
                now,
                binding.AdminPrincipalId,
                plan.Rights,
                plan.Responsibility!,
                plan.SemanticRole,
                MutationIdentity: new ArticleCreateMutationAuthority.ArticleMutationIdentityWrite(
                    binding.AdminPrincipalId,
                    clientMutationId,
                    requestHash)),
            cancellationToken).ConfigureAwait(false);
    }

    private async Task ExecutePublishedScheduledUpdateAsync(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        DateTime now,
        List<ArticleLifecycleTransitionWriter.Result> results,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        results.Add(await CreateAsync(plan, binding, ArticleStatus.Published, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result initial = results[^1];
        DateTime scheduledAt = plan.ScheduledPublishAt!.Value;
        results.Add(await ArticleLifecycleTransitionWriter.UpdateAsync(
            db,
            configuration,
            RevisionRequest(plan, binding, initial, ArticleStatus.Scheduled, now, scheduledAt),
            cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result scheduled = results[^1];
        if (scheduled.After.PublicationId != initial.After.PublicationId)
        {
            throw new InvalidOperationException("scheduled update changed the old publication before due time");
        }

        // The new revision remains pending. A separate due-time call consumes this receipt
        // after the caller advances the shared business clock, never by substituting dueAt for now.
    }

    private async Task ExecuteArchivedAsync(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        DateTime now,
        List<ArticleLifecycleTransitionWriter.Result> results,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        results.Add(await CreateAsync(plan, binding, ArticleStatus.Published, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
        results.Add(await ArticleLifecycleTransitionWriter.UpdateAsync(
            db,
            configuration,
            RevisionRequest(plan, binding, results[^1], ArticleStatus.Archived, now, null),
            cancellationToken).ConfigureAwait(false));
    }

    private async Task ExecuteDeletedAsync(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        DateTime now,
        List<ArticleLifecycleTransitionWriter.Result> results,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        results.Add(await CreateAsync(plan, binding, ArticleStatus.Published, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result created = results[^1];
        results.Add(await ArticleLifecycleTransitionWriter.DeleteAsync(
            db,
            configuration,
            new ArticleLifecycleTransitionWriter.DeleteRequest(
                created.ArticleId,
                created.After.RevisionId!.Value,
                now,
                binding.AdminPrincipalId,
                plan.SemanticRole),
            cancellationToken).ConfigureAwait(false));
    }

    private async Task ExecuteRestoreAsync(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        DateTime now,
        List<ArticleLifecycleTransitionWriter.Result> results,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        results.Add(await CreateAsync(plan, binding, ArticleStatus.Published, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result created = results[^1];
        results.Add(await ArticleLifecycleTransitionWriter.DeleteAsync(
            db,
            configuration,
            new ArticleLifecycleTransitionWriter.DeleteRequest(
                created.ArticleId,
                created.After.RevisionId!.Value,
                now,
                binding.AdminPrincipalId,
                plan.SemanticRole),
            cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result deleted = results[^1];
        results.Add(await ArticleLifecycleTransitionWriter.RestoreAsync(
            db,
            configuration,
            new ArticleLifecycleTransitionWriter.RestoreRequest(
                deleted.ArticleId,
                deleted.After.RevisionId!.Value,
                now,
                binding.AdminPrincipalId,
                plan.SemanticRole,
                plan.Rights,
                plan.Responsibility),
            cancellationToken).ConfigureAwait(false));
    }

    private async Task ExecuteRollbackAsync(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        DateTime now,
        List<ArticleLifecycleTransitionWriter.Result> results,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        results.Add(await CreateAsync(plan, binding, ArticleStatus.Published, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result created = results[^1];
        string updatedContent = plan.Content + "\n\nrollback candidate";
        results.Add(await ArticleLifecycleTransitionWriter.UpdateAsync(
            db,
            configuration,
            RevisionRequest(
                plan with
                {
                    Content = updatedContent
                },
                binding,
                created,
                ArticleStatus.Published,
                now,
                null),
            cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result candidate = results[^1];
        long targetRevisionId = plan.RollbackTargetRevisionId ?? created.After.RevisionId!.Value;
        results.Add(await ArticleLifecycleTransitionWriter.RollbackAsync(
            db,
            configuration,
            new ArticleLifecycleTransitionWriter.RollbackRequest(
                candidate.ArticleId,
                candidate.After.RevisionId!.Value,
                targetRevisionId,
                now,
                binding.AdminPrincipalId,
                plan.RollbackReason ?? "canonical fixture rollback",
                plan.SemanticRole),
            cancellationToken).ConfigureAwait(false));
    }

    private async Task ExecuteMultipleRevisionsAsync(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        DateTime now,
        List<ArticleLifecycleTransitionWriter.Result> results,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        results.Add(await CreateAsync(plan, binding, ArticleStatus.Published, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result current = results[^1];
        results.Add(await ArticleLifecycleTransitionWriter.UpdateAsync(
            db,
            configuration,
            RevisionRequest(plan with
            {
                Content = plan.Content + "\n\nrevision two"
            }, binding, current, ArticleStatus.Published, now, null),
            cancellationToken).ConfigureAwait(false));
        current = results[^1];
        results.Add(await ArticleLifecycleTransitionWriter.UpdateAsync(
            db,
            configuration,
            RevisionRequest(plan with
            {
                Content = plan.Content + "\n\nrevision three"
            }, binding, current, ArticleStatus.Published, now, null),
            cancellationToken).ConfigureAwait(false));
    }

    private async Task ExecuteMultiplePublicationsAsync(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        DateTime now,
        List<ArticleLifecycleTransitionWriter.Result> results,
        string clientMutationId,
        string requestHash,
        CancellationToken cancellationToken)
    {
        results.Add(await CreateAsync(plan, binding, ArticleStatus.Published, now, clientMutationId, requestHash, cancellationToken).ConfigureAwait(false));
        ArticleLifecycleTransitionWriter.Result current = results[^1];
        results.Add(await ArticleLifecycleTransitionWriter.UpdateAsync(
            db,
            configuration,
            RevisionRequest(plan, binding, current, ArticleStatus.Archived, now, null),
            cancellationToken).ConfigureAwait(false));
        current = results[^1];
        results.Add(await ArticleLifecycleTransitionWriter.UpdateAsync(
            db,
            configuration,
            RevisionRequest(plan, binding, current, ArticleStatus.Published, now, null),
            cancellationToken).ConfigureAwait(false));
    }

    private ArticleLifecycleTransitionWriter.RevisionRequest RevisionRequest(
        CanonicalArticleLifecyclePlan plan,
        CanonicalArticleLifecycleFixtureBinding binding,
        ArticleLifecycleTransitionWriter.Result current,
        ArticleStatus status,
        DateTime now,
        DateTime? scheduledAt)
        => new(
            current.ArticleId,
            current.After.RevisionId ?? throw new InvalidOperationException("expected revision missing"),
            plan.Title,
            plan.Content,
            plan.Summary,
            plan.CoverImageUrl,
            plan.CategoryId,
            plan.TagIds,
            status,
            scheduledAt,
            now,
            binding.AdminPrincipalId,
            plan.Rights,
            plan.Responsibility,
            status switch
            {
                ArticleStatus.Scheduled => ArticlePublicationTransitionKinds.ScheduledPublish,
                ArticleStatus.Archived => ArticlePublicationTransitionKinds.Archive,
                _ => ArticlePublicationTransitionKinds.ImmediatePublish
            },
            plan.SemanticRole,
            status == ArticleStatus.Published && current.After.Status == ArticleStatus.Archived
                ? ArticleStatusTransitionOperation.Update
                : ArticleStatusTransitionOperation.Update);

    private async Task ValidateContentAsync(
        CanonicalArticleLifecyclePlan plan,
        ArticleStatus status,
        DateTime now,
        CancellationToken cancellationToken)
    {
        var validation = await publicationValidator.ValidateAsync(
            new ArticlePublicationValidationInput(
                plan.Title,
                plan.Content,
                plan.Summary,
                plan.CoverImageUrl,
                plan.CategoryId,
                plan.TagIds,
                status,
                status == ArticleStatus.Scheduled ? plan.ScheduledPublishAt : null),
            now,
            cancellationToken).ConfigureAwait(false);
        validation.ThrowIfWriteBlocked();
    }

    private static void ValidatePlan(CanonicalArticleLifecyclePlan plan)
    {
        if (!CanonicalArticleLifecycleVariants.All.Contains(plan.Variant))
            throw new CanonicalArticleLifecycleValidationException("variant_unknown");
        if (string.IsNullOrWhiteSpace(plan.SemanticRole))
            throw new CanonicalArticleLifecycleValidationException("semantic_role_required");
        if (string.IsNullOrWhiteSpace(plan.Title))
            throw new CanonicalArticleLifecycleValidationException("title_required");
        if (string.IsNullOrWhiteSpace(plan.Content))
            throw new CanonicalArticleLifecycleValidationException("content_required");
        if (plan.CategoryId <= 0)
            throw new CanonicalArticleLifecycleValidationException("category_required");
        if (plan.Responsibility is null)
            throw new CanonicalArticleLifecycleValidationException("responsibility_required");
        RejectSentinel(plan.Title, "title");
        RejectSentinel(plan.Content, "content");
        RejectSentinel(plan.Summary, "summary");
        if (plan.Rights is ArticleRightsRequestCoreModel rights)
        {
            RejectSentinel(rights.LicenseType, "license_type");
            RejectSentinel(rights.CopyrightHolder, "copyright_holder");
            RejectSentinel(rights.RightsStatement, "rights_statement");
            RejectSentinel(rights.AttributionTemplate, "attribution_template");
            RejectSentinel(rights.CopyPolicy, "copy_policy");
        }
        if (plan.Variant == CanonicalArticleLifecycleVariants.Rollback
            && plan.RollbackTargetRevisionId is <= 0)
        {
            throw new CanonicalArticleLifecycleValidationException("rollback_target_invalid");
        }
    }

    private static CanonicalArticleLifecycleOperationReceipt MapOperation(
        ArticleLifecycleTransitionWriter.Result result)
        => new(
            result.TransitionId,
            result.After.Status switch
            {
                ArticleStatus.Deleted => "delete",
                _ when result.Before.IsDeleted && !result.After.IsDeleted => "restore",
                _ when result.Before.RevisionId is null => "create",
                _ when result.RollbackSourceRevisionId.HasValue => "rollback",
                _ when result.Before.Status == ArticleStatus.Scheduled
                    || result.Before.PendingPublicationAt.HasValue => "scheduled-publish",
                _ when result.After.PendingPublicationAt.HasValue
                    && result.Before.PublicationId.HasValue => "scheduled-update",
                _ when result.After.Status == ArticleStatus.Scheduled => "scheduled-update",
                _ => "update"
            },
            result.Before.RevisionId is null ? null : result.Before.Status,
            result.After.Status,
            result.Before.IsDeleted,
            result.After.IsDeleted,
            result.Before.RevisionId,
            result.Before.RevisionNo,
            result.After.RevisionId ?? throw new InvalidOperationException("after revision missing"),
            result.After.RevisionNo ?? throw new InvalidOperationException("after revision number missing"),
            result.Before.PublicationId,
            result.Before.PublicationNo,
            result.After.PublicationId,
            result.After.PublicationNo,
            result.Version.RightsSnapshotId,
            result.Version.ResponsibilitySnapshotId,
            result.Version.ResponsibilityVersion,
            result.RollbackSourceRevisionId,
            result.TransitionedAtUtc ?? throw new InvalidOperationException("lifecycle transition business time missing"),
            result.Before.PendingPublicationAt ?? result.Before.ScheduledPublishAt
                ?? result.After.PendingPublicationAt ?? result.After.ScheduledPublishAt,
            result.ContentDigest,
            result.Outbox.EventId,
            ComputeOutboxPayloadDigest(result.Outbox.PayloadJson),
            result.AuditChainId,
            result.AuditRecordHash);

    public static string ComputeReceiptDigest(
        string writerContractDigest,
        string temporalContextDigest,
        string runId,
        string ns,
        string profileId,
        string semanticRole,
        string variant,
        long adminPrincipalId,
        int articleId,
        IReadOnlyList<CanonicalArticleLifecycleOperationReceipt> operations,
        IReadOnlyList<long> revisionIds,
        IReadOnlyList<long> publicationIds,
        long? currentRevisionId,
        long? currentPublicationId,
        ArticleStatus currentStatus,
        bool isDeleted,
        string contentDigest,
        string revisionTimelineDigest)
    {
        string raw = JsonSerializer.Serialize(new
        {
            writerContractDigest,
            temporalContextDigest,
            runId,
            ns,
            profileId,
            semanticRole,
            variant,
            adminPrincipalId,
            articleId,
            operations,
            revisionIds,
            publicationIds,
            currentRevisionId,
            currentPublicationId,
            currentStatus = (int)currentStatus,
            isDeleted,
            contentDigest,
            revisionTimelineDigest
        });
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant();
    }

    public static string ComputeOutboxPayloadDigest(string payloadJson)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payloadJson))).ToLowerInvariant();

    private static string ComputeDigest(string value)
        => "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    public static string ComputeRevisionTimelineDigest(
        IReadOnlyList<ArticleRevision> revisions,
        IReadOnlyList<ArticleRevisionContentBlock> contentBlocks)
    {
        ArgumentNullException.ThrowIfNull(revisions);
        ArgumentNullException.ThrowIfNull(contentBlocks);
        Dictionary<long, ArticleRevisionContentBlock> blocks = contentBlocks
            .ToDictionary(item => item.Id);
        var rows = revisions
            .OrderBy(item => item.RevisionNo)
            .ThenBy(item => item.Id)
            .Select(item =>
            {
                blocks.TryGetValue(item.ContentBlockId, out ArticleRevisionContentBlock? block);
                return new
                {
                    item.Id,
                    item.ArticleId,
                    item.RevisionNo,
                    item.Title,
                    item.Summary,
                    item.CoverImageUrl,
                    item.CategoryId,
                    item.TagIds,
                    item.ContentBlockId,
                    item.MarkdownContent,
                    item.DiffSummary,
                    item.CreatedByAdminPrincipalId,
                    item.RollbackSourceRevisionId,
                    item.RollbackReason,
                    item.CreatedAt,
                    ContentHash = block?.ContentHash,
                    Content = block?.MarkdownContent
                };
            })
            .ToArray();
        string raw = JsonSerializer.Serialize(rows);
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant();
    }

    private static void RejectSentinel(string? value, string field)
    {
        if (!string.IsNullOrWhiteSpace(value)
            && value.Contains("recompute", StringComparison.OrdinalIgnoreCase))
        {
            throw new CanonicalArticleLifecycleValidationException(
                "recompute_sentinel_forbidden",
                $"Field '{field}' contains a prohibited sentinel.");
        }
    }
}
