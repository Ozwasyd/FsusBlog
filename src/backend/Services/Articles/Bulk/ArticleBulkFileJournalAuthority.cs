using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal enum ArticleBulkFileJournalDurabilityScope
{
    SingleHostLinuxLocalAtomicRename
}

internal sealed record ArticleBulkFileJournalOptions(
    string DataRoot,
    ArticleBulkFileJournalDurabilityScope DurabilityScope);

internal enum ArticleBulkFileJournalCommitStage
{
    EnvelopeDurable,
    PointerSealed
}

internal sealed record ArticleBulkFileJournalEnvelope(
    string Schema,
    string IdempotencyKeyDigest,
    string PreviousEnvelopeDigest,
    ArticleBulkExecutionRequest Request,
    ArticleBulkJournalEvent Event,
    ArticleBulkJournalHead Head,
    string? ArticleId,
    ArticleBulkItemStatus? ExpectedItemStatus,
    ArticleBulkItemStatus? NextItemStatus,
    ImmutableArray<ArticleBulkItemReceipt> ItemReceipts,
    ArticleBulkAggregateReceipt? AggregateReceipt,
    string ContentDigest);

internal sealed record ArticleBulkFileJournalPointer(
    string Schema,
    string IdempotencyKeyDigest,
    string AttemptId,
    long Ordinal,
    string EnvelopeDigest,
    string HeadDigest,
    string ContentDigest);

internal sealed record ArticleBulkFileJournalEnvelopeReference(
    string Schema,
    string IdempotencyKeyDigest,
    long Ordinal,
    string EnvelopeDigest,
    string PreviousEnvelopeDigest,
    string ContentDigest);

/// <summary>
/// A single-host Linux journal authority rooted in stable application data. Each mutation writes
/// one immutable content-addressed envelope and one ordinal reference before atomically replacing
/// and directory-fsyncing the sealed pointer. Entries above that pointer are prepared state, not
/// journal history. Shared/network filesystems and Windows are intentionally unsupported.
/// </summary>
internal sealed class ArticleBulkFileJournalAuthority : IArticleBulkJournalAuthority
{
    private const string EnvelopeSchema = "fsusblog.article-bulk.file-journal-envelope.v1";
    private const string EnvelopeReferenceSchema = "fsusblog.article-bulk.file-journal-reference.v1";
    private const string PointerSchema = "fsusblog.article-bulk.file-journal-pointer.v1";
    private const int MaximumReadBatchSize = ArticleBulkExecutionFramework.JournalReadBatchSize;
    private const int MaximumJournalEvents = 32_768;
    private const int MaximumEnvelopeBytes = 4 * 1024 * 1024;
    private const int MaximumMetadataBytes = 64 * 1024;
    private const int LinuxOpenDirectory = 0x10000;
    private const int LinuxOpenCloseOnExec = 0x80000;
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string _journalRoot;
    private readonly TimeProvider _timeProvider;
    private readonly Func<ArticleBulkFileJournalCommitStage, CancellationToken, ValueTask>? _commitObserver;
    private readonly ConcurrentDictionary<string, ArticleBulkFileJournalSnapshot> _snapshots =
        new(StringComparer.Ordinal);

    internal ArticleBulkFileJournalAuthority(
        ArticleBulkFileJournalOptions options,
        TimeProvider timeProvider,
        Func<ArticleBulkFileJournalCommitStage, CancellationToken, ValueTask>? commitObserver = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(timeProvider);
        if (options.DurabilityScope != ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename)
        {
            throw new ArticleBulkContractException("article-bulk.journal-filesystem-unsupported");
        }
        if (!OperatingSystem.IsLinux())
        {
            // Windows directory-entry flush and shared/network filesystem semantics are not claimed.
            throw new ArticleBulkContractException("article-bulk.journal-platform-unsupported");
        }
        if (string.IsNullOrWhiteSpace(options.DataRoot)
            || !Path.IsPathFullyQualified(options.DataRoot)
            || !Directory.Exists(options.DataRoot))
        {
            throw new ArticleBulkContractException("article-bulk.journal-data-root-invalid");
        }

        _journalRoot = Path.Combine(Path.GetFullPath(options.DataRoot), "article-bulk", "journal-v1");
        _timeProvider = timeProvider;
        _commitObserver = commitObserver;
    }

    public async Task<ArticleBulkIdempotencyResolution> ResolveIdempotencyAsync(
        string idempotencyKey,
        string executionIdentityDigest,
        CancellationToken cancellationToken)
    {
        string storageKey = GetStorageKey(idempotencyKey);
        string pointerPath = GetPointerPath(storageKey);
        if (!File.Exists(pointerPath))
        {
            return new ArticleBulkIdempotencyResolution(
                ArticleBulkIdempotencyKind.Missing,
                null,
                null,
                null);
        }

        ArticleBulkFileJournalSnapshot snapshot = await LoadCurrentSnapshotAsync(
            storageKey,
            cancellationToken).ConfigureAwait(false);
        if (snapshot.Request.ExecutionIdentityDigest != executionIdentityDigest)
        {
            return new ArticleBulkIdempotencyResolution(
                ArticleBulkIdempotencyKind.Conflict,
                snapshot.Request,
                snapshot.Head,
                snapshot.TerminalReceipt);
        }

        bool terminal = snapshot.TerminalReceipt is not null;
        if (terminal && !IsTerminal(snapshot.Head.State)
            || !terminal && snapshot.Head.State is (ArticleBulkExecutionState.Cancelled
                or ArticleBulkExecutionState.Completed
                or ArticleBulkExecutionState.Partial
                or ArticleBulkExecutionState.Failed
                or ArticleBulkExecutionState.Blocked))
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        return new ArticleBulkIdempotencyResolution(
            terminal ? ArticleBulkIdempotencyKind.Terminal : ArticleBulkIdempotencyKind.InProgress,
            snapshot.Request,
            snapshot.Head,
            snapshot.TerminalReceipt);
    }

    public async Task<ArticleBulkJournalAppendReceipt> CreateAsync(
        string idempotencyKey,
        ArticleBulkExecutionRequest request,
        ArticleBulkJournalEvent firstEvent,
        ArticleBulkJournalHead firstHead,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(firstEvent);
        ArgumentNullException.ThrowIfNull(firstHead);
        string storageKey = GetStorageKey(idempotencyKey);
        ValidateCreate(storageKey, idempotencyKey, request, firstEvent, firstHead);
        await using FileStream journalLock = await AcquireLockAsync(storageKey, cancellationToken)
            .ConfigureAwait(false);
        if (File.Exists(GetPointerPath(storageKey)))
        {
            throw new ArticleBulkContractException("article-bulk.idempotency-conflict");
        }

        ArticleBulkFileJournalEnvelope envelope = SealEnvelope(new ArticleBulkFileJournalEnvelope(
            EnvelopeSchema,
            storageKey,
            string.Empty,
            request,
            firstEvent,
            firstHead,
            null,
            null,
            null,
            [],
            null,
            string.Empty));
        ArticleBulkFileJournalPointer pointer = SealPointer(new ArticleBulkFileJournalPointer(
            PointerSchema,
            storageKey,
            request.AttemptId,
            firstEvent.Ordinal,
            envelope.ContentDigest,
            firstHead.ContentDigest,
            string.Empty));
        await CommitAsync(
            storageKey,
            envelope,
            pointer,
            previousSealedOrdinal: -1,
            cancellationToken).ConfigureAwait(false);

        var snapshot = new ArticleBulkFileJournalSnapshot(
            pointer,
            request,
            firstHead,
            terminalReceipt: null,
            new Dictionary<string, ArticleBulkItemStatus>(StringComparer.Ordinal),
            new HashSet<string>(StringComparer.Ordinal));
        _snapshots[storageKey] = snapshot;
        return CreateAppendReceipt(envelope, pointer);
    }

    public async Task<ArticleBulkJournalAppendReceipt> AppendAsync(
        ArticleBulkJournalAppend append,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(append);
        string storageKey = ValidateStorageKey(append.NextHead.IdempotencyKeyDigest);
        await using FileStream journalLock = await AcquireLockAsync(storageKey, cancellationToken)
            .ConfigureAwait(false);
        ArticleBulkFileJournalPointer pointer = await ReadPointerAsync(storageKey, cancellationToken)
            .ConfigureAwait(false);
        ArticleBulkFileJournalSnapshot snapshot;
        if (!_snapshots.TryGetValue(storageKey, out snapshot!)
            || snapshot.Pointer.ContentDigest != pointer.ContentDigest)
        {
            snapshot = await LoadSnapshotAsync(storageKey, pointer, cancellationToken).ConfigureAwait(false);
        }

        ValidateAppend(snapshot, append);
        ArticleBulkFileJournalEnvelope envelope = SealEnvelope(new ArticleBulkFileJournalEnvelope(
            EnvelopeSchema,
            storageKey,
            pointer.EnvelopeDigest,
            snapshot.Request,
            append.Event,
            append.NextHead,
            append.ArticleId,
            append.ExpectedItemStatus,
            append.NextItemStatus,
            append.ItemReceipts,
            append.AggregateReceipt,
            string.Empty));
        ArticleBulkFileJournalPointer nextPointer = SealPointer(pointer with
        {
            AttemptId = append.Event.AttemptId,
            Ordinal = append.Event.Ordinal,
            EnvelopeDigest = envelope.ContentDigest,
            HeadDigest = append.NextHead.ContentDigest,
            ContentDigest = string.Empty
        });
        await CommitAsync(
            storageKey,
            envelope,
            nextPointer,
            pointer.Ordinal,
            cancellationToken).ConfigureAwait(false);

        ApplyEnvelope(snapshot, envelope);
        snapshot.Pointer = nextPointer;
        snapshot.Head = append.NextHead;
        snapshot.TerminalReceipt = append.AggregateReceipt ?? snapshot.TerminalReceipt;
        _snapshots[storageKey] = snapshot;
        return CreateAppendReceipt(envelope, nextPointer);
    }

    public async IAsyncEnumerable<IReadOnlyList<ArticleBulkJournalEvent>> ReadEventBatchesAsync(
        ArticleBulkJournalHead sealedHead,
        int maximumBatchSize,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(sealedHead);
        if (maximumBatchSize is < 1 or > MaximumReadBatchSize)
        {
            throw new ArticleBulkContractException("article-bulk.journal-batch-invalid");
        }

        string storageKey = ValidateStorageKey(sealedHead.IdempotencyKeyDigest);
        await ValidateSealedHeadAsync(storageKey, sealedHead, cancellationToken).ConfigureAwait(false);
        var batch = new List<ArticleBulkJournalEvent>(maximumBatchSize);
        string previousEnvelopeDigest = string.Empty;
        string previousEventDigest = string.Empty;
        for (long ordinal = 0; ordinal < sealedHead.EventCount; ordinal++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleBulkFileJournalEnvelopeReference reference = await ReadReferenceAsync(
                storageKey,
                ordinal,
                cancellationToken).ConfigureAwait(false);
            ArticleBulkFileJournalEnvelope envelope = await ReadEnvelopeAsync(
                storageKey,
                reference.Ordinal,
                reference.EnvelopeDigest,
                cancellationToken).ConfigureAwait(false);
            ValidateEnvelopeLink(
                storageKey,
                sealedHead.AttemptId,
                reference.Ordinal,
                previousEnvelopeDigest,
                previousEventDigest,
                reference,
                envelope);
            batch.Add(envelope.Event);
            previousEnvelopeDigest = reference.EnvelopeDigest;
            previousEventDigest = envelope.Event.ContentDigest;
            if (batch.Count == maximumBatchSize)
            {
                yield return batch.ToArray();
                batch.Clear();
            }
        }
        if (batch.Count > 0)
        {
            yield return batch.ToArray();
        }
    }

    public async IAsyncEnumerable<ArticleBulkItemReceipt> ReadItemReceiptsAsync(
        ArticleBulkJournalHead sealedHead,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(sealedHead);
        string storageKey = ValidateStorageKey(sealedHead.IdempotencyKeyDigest);
        await ValidateSealedHeadAsync(storageKey, sealedHead, cancellationToken).ConfigureAwait(false);
        string previousEnvelopeDigest = string.Empty;
        string previousEventDigest = string.Empty;
        for (long ordinal = 0; ordinal < sealedHead.EventCount; ordinal++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArticleBulkFileJournalEnvelopeReference reference = await ReadReferenceAsync(
                storageKey,
                ordinal,
                cancellationToken).ConfigureAwait(false);
            ArticleBulkFileJournalEnvelope envelope = await ReadEnvelopeAsync(
                storageKey,
                reference.Ordinal,
                reference.EnvelopeDigest,
                cancellationToken).ConfigureAwait(false);
            ValidateEnvelopeLink(
                storageKey,
                sealedHead.AttemptId,
                reference.Ordinal,
                previousEnvelopeDigest,
                previousEventDigest,
                reference,
                envelope);
            foreach (ArticleBulkItemReceipt receipt in envelope.ItemReceipts)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return receipt;
            }
            previousEnvelopeDigest = reference.EnvelopeDigest;
            previousEventDigest = envelope.Event.ContentDigest;
        }
    }

    private async Task CommitAsync(
        string storageKey,
        ArticleBulkFileJournalEnvelope envelope,
        ArticleBulkFileJournalPointer pointer,
        long previousSealedOrdinal,
        CancellationToken cancellationToken)
    {
        await PersistEnvelopeAsync(storageKey, envelope, cancellationToken).ConfigureAwait(false);
        await PersistReferenceAsync(
            storageKey,
            envelope,
            previousSealedOrdinal,
            cancellationToken).ConfigureAwait(false);
        if (_commitObserver is not null)
        {
            await _commitObserver(ArticleBulkFileJournalCommitStage.EnvelopeDurable, cancellationToken)
                .ConfigureAwait(false);
        }
        await WriteJsonDurablyAsync(
            GetPointerPath(storageKey),
            pointer,
            overwrite: true,
            cancellationToken).ConfigureAwait(false);
        if (_commitObserver is not null)
        {
            await _commitObserver(ArticleBulkFileJournalCommitStage.PointerSealed, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task PersistEnvelopeAsync(
        string storageKey,
        ArticleBulkFileJournalEnvelope envelope,
        CancellationToken cancellationToken)
    {
        string path = GetEnvelopePath(storageKey, envelope.Event.Ordinal, envelope.ContentDigest);
        if (File.Exists(path))
        {
            _ = await ReadEnvelopeAsync(
                storageKey,
                envelope.Event.Ordinal,
                envelope.ContentDigest,
                cancellationToken).ConfigureAwait(false);
            return;
        }
        await WriteJsonDurablyAsync(path, envelope, overwrite: false, cancellationToken).ConfigureAwait(false);
    }

    private async Task PersistReferenceAsync(
        string storageKey,
        ArticleBulkFileJournalEnvelope envelope,
        long previousSealedOrdinal,
        CancellationToken cancellationToken)
    {
        ArticleBulkFileJournalEnvelopeReference reference = SealReference(
            new ArticleBulkFileJournalEnvelopeReference(
                EnvelopeReferenceSchema,
                storageKey,
                envelope.Event.Ordinal,
                envelope.ContentDigest,
                envelope.PreviousEnvelopeDigest,
                string.Empty));
        string path = GetReferencePath(storageKey, reference.Ordinal);
        if (File.Exists(path))
        {
            ArticleBulkFileJournalEnvelopeReference existing = await ReadReferenceAsync(
                storageKey,
                reference.Ordinal,
                cancellationToken).ConfigureAwait(false);
            if (existing.ContentDigest == reference.ContentDigest)
            {
                return;
            }
            if (reference.Ordinal <= previousSealedOrdinal)
            {
                throw new ArticleBulkContractException("article-bulk.journal-reference-conflict");
            }
        }

        // A reference above the current sealed pointer is prepared state, not journal history. It may be
        // replaced after a pre-pointer crash; committed references are immutable by the check above.
        await WriteJsonDurablyAsync(path, reference, overwrite: true, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ArticleBulkFileJournalSnapshot> LoadCurrentSnapshotAsync(
        string storageKey,
        CancellationToken cancellationToken)
    {
        ArticleBulkFileJournalPointer pointer = await ReadPointerAsync(storageKey, cancellationToken)
            .ConfigureAwait(false);
        if (_snapshots.TryGetValue(storageKey, out ArticleBulkFileJournalSnapshot? cached)
            && cached.Pointer.ContentDigest == pointer.ContentDigest)
        {
            return cached;
        }
        ArticleBulkFileJournalSnapshot snapshot = await LoadSnapshotAsync(
            storageKey,
            pointer,
            cancellationToken).ConfigureAwait(false);
        _snapshots[storageKey] = snapshot;
        return snapshot;
    }

    private async Task<ArticleBulkFileJournalSnapshot> LoadSnapshotAsync(
        string storageKey,
        ArticleBulkFileJournalPointer pointer,
        CancellationToken cancellationToken)
    {
        ArticleBulkExecutionRequest? request = null;
        ArticleBulkJournalHead? head = null;
        ArticleBulkAggregateReceipt? terminalReceipt = null;
        var itemStates = new Dictionary<string, ArticleBulkItemStatus>(StringComparer.Ordinal);
        var receiptArticleIds = new HashSet<string>(StringComparer.Ordinal);
        string previousEnvelopeDigest = string.Empty;
        string previousEventDigest = string.Empty;
        ValidatePointerBound(pointer);
        for (long ordinal = 0; ordinal <= pointer.Ordinal; ordinal++)
        {
            ArticleBulkFileJournalEnvelopeReference reference = await ReadReferenceAsync(
                storageKey,
                ordinal,
                cancellationToken).ConfigureAwait(false);
            ArticleBulkFileJournalEnvelope envelope = await ReadEnvelopeAsync(
                storageKey,
                reference.Ordinal,
                reference.EnvelopeDigest,
                cancellationToken).ConfigureAwait(false);
            ValidateEnvelopeLink(
                storageKey,
                pointer.AttemptId,
                reference.Ordinal,
                previousEnvelopeDigest,
                previousEventDigest,
                reference,
                envelope);
            if (request is null)
            {
                request = envelope.Request;
            }
            else if (request.ContentDigest != envelope.Request.ContentDigest)
            {
                throw new ArticleBulkContractException("article-bulk.journal-corrupt");
            }
            ApplyEnvelope(itemStates, receiptArticleIds, envelope);
            head = envelope.Head;
            if (terminalReceipt is not null && envelope.AggregateReceipt is not null)
            {
                throw new ArticleBulkContractException("article-bulk.journal-corrupt");
            }
            terminalReceipt = envelope.AggregateReceipt ?? terminalReceipt;
            previousEnvelopeDigest = reference.EnvelopeDigest;
            previousEventDigest = envelope.Event.ContentDigest;
        }
        if (request is null || head is null
            || previousEnvelopeDigest != pointer.EnvelopeDigest
            || head.ContentDigest != pointer.HeadDigest)
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        return new ArticleBulkFileJournalSnapshot(
            pointer,
            request,
            head,
            terminalReceipt,
            itemStates,
            receiptArticleIds);
    }

    private async Task ValidateSealedHeadAsync(
        string storageKey,
        ArticleBulkJournalHead sealedHead,
        CancellationToken cancellationToken)
    {
        if (sealedHead.EventCount < 1
            || sealedHead.ContentDigest != ArticleBulkDigest.Of(sealedHead with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new ArticleBulkContractException("article-bulk.journal-head-tampered");
        }
        ArticleBulkFileJournalPointer pointer = await ReadPointerAsync(storageKey, cancellationToken)
            .ConfigureAwait(false);
        long sealedOrdinal = sealedHead.EventCount - 1;
        if (pointer.Ordinal < sealedOrdinal)
        {
            throw new ArticleBulkContractException("article-bulk.journal-incomplete");
        }
        ArticleBulkFileJournalEnvelopeReference reference = await ReadReferenceAsync(
            storageKey,
            sealedOrdinal,
            cancellationToken).ConfigureAwait(false);
        ArticleBulkFileJournalEnvelope envelope = await ReadEnvelopeAsync(
            storageKey,
            sealedOrdinal,
            reference.EnvelopeDigest,
            cancellationToken).ConfigureAwait(false);
        if (envelope.Head.ContentDigest != sealedHead.ContentDigest)
        {
            throw new ArticleBulkContractException("article-bulk.journal-head-mismatch");
        }
    }

    private async Task<ArticleBulkFileJournalEnvelopeReference> ReadReferenceAsync(
        string storageKey,
        long ordinal,
        CancellationToken cancellationToken)
    {
        ArticleBulkFileJournalEnvelopeReference reference =
            await ReadJsonAsync<ArticleBulkFileJournalEnvelopeReference>(
                GetReferencePath(storageKey, ordinal),
                MaximumMetadataBytes,
                cancellationToken).ConfigureAwait(false);
        if (reference.Schema != EnvelopeReferenceSchema
            || reference.IdempotencyKeyDigest != storageKey
            || reference.Ordinal != ordinal
            || !IsContentDigest(reference.EnvelopeDigest)
            || ordinal == 0 && reference.PreviousEnvelopeDigest != string.Empty
            || ordinal > 0 && !IsContentDigest(reference.PreviousEnvelopeDigest)
            || reference.ContentDigest != ArticleBulkDigest.Of(reference with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        return reference;
    }

    private async Task<ArticleBulkFileJournalPointer> ReadPointerAsync(
        string storageKey,
        CancellationToken cancellationToken)
    {
        ArticleBulkFileJournalPointer pointer = await ReadJsonAsync<ArticleBulkFileJournalPointer>(
            GetPointerPath(storageKey),
            MaximumMetadataBytes,
            cancellationToken).ConfigureAwait(false);
        if (pointer.Schema != PointerSchema
            || pointer.IdempotencyKeyDigest != storageKey
            || pointer.Ordinal < 0
            || pointer.ContentDigest != ArticleBulkDigest.Of(pointer with
            {
                ContentDigest = string.Empty
            })
            || !IsContentDigest(pointer.EnvelopeDigest)
            || !IsContentDigest(pointer.HeadDigest))
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        ValidatePointerBound(pointer);
        return pointer;
    }

    private static void ValidatePointerBound(ArticleBulkFileJournalPointer pointer)
    {
        if (pointer.Ordinal >= MaximumJournalEvents)
        {
            throw new ArticleBulkContractException("article-bulk.journal-unbounded");
        }
    }

    private async Task<ArticleBulkFileJournalEnvelope> ReadEnvelopeAsync(
        string storageKey,
        long ordinal,
        string contentDigest,
        CancellationToken cancellationToken)
    {
        ArticleBulkFileJournalEnvelope envelope = await ReadJsonAsync<ArticleBulkFileJournalEnvelope>(
            GetEnvelopePath(storageKey, ordinal, contentDigest),
            MaximumEnvelopeBytes,
            cancellationToken).ConfigureAwait(false);
        if (envelope.Schema != EnvelopeSchema
            || envelope.IdempotencyKeyDigest != storageKey
            || envelope.ContentDigest != contentDigest
            || envelope.ContentDigest != ArticleBulkDigest.Of(envelope with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        return envelope;
    }

    private static void ValidateEnvelopeLink(
        string storageKey,
        string attemptId,
        long ordinal,
        string previousEnvelopeDigest,
        string previousEventDigest,
        ArticleBulkFileJournalEnvelopeReference reference,
        ArticleBulkFileJournalEnvelope envelope)
    {
        if (reference.Ordinal != ordinal
            || reference.EnvelopeDigest != envelope.ContentDigest
            || reference.PreviousEnvelopeDigest != previousEnvelopeDigest
            || envelope.IdempotencyKeyDigest != storageKey
            || envelope.Request.AttemptId != attemptId
            || envelope.Request.ContentDigest
                != ArticleBulkDigest.Of(envelope.Request with
                {
                    ContentDigest = string.Empty
                })
            || ArticleBulkDigest.Of(envelope.Request.IdempotencyKey) != storageKey
            || envelope.Request.PlanDigest != envelope.Head.PlanDigest
            || envelope.Request.Strategy != envelope.Head.Strategy
            || envelope.Request.ExecutionIdentityDigest != envelope.Head.ExecutionIdentityDigest
            || envelope.Event.AttemptId != attemptId
            || envelope.Event.Ordinal != ordinal
            || envelope.Event.ContentDigest
                != ArticleBulkDigest.Of(envelope.Event with
                {
                    ContentDigest = string.Empty
                })
            || envelope.Event.PreviousEventDigest != previousEventDigest
            || envelope.Head.AttemptId != attemptId
            || envelope.Head.IdempotencyKeyDigest != storageKey
            || !IsContentDigest(envelope.Head.PlanDigest)
            || envelope.Head.State != envelope.Event.ResultingState
            || envelope.Head.EventCount != ordinal + 1
            || envelope.Head.EventCount > MaximumJournalEvents
            || envelope.Head.LastEventDigest != envelope.Event.ContentDigest
            || envelope.Head.ActiveArticleIds.IsDefault
            || envelope.Head.ActiveArticleIds.Length > 256
            || envelope.Head.ActiveArticleIds.Distinct(StringComparer.Ordinal).Count()
                != envelope.Head.ActiveArticleIds.Length
            || envelope.Head.ActiveArticleIds.Any(static articleId =>
                !IsBoundedOpaqueValue(articleId, 256))
            || envelope.Head.AdmittedCount is < 0 or > 10_000
            || envelope.Head.SucceededCount is < 0 or > 10_000
            || envelope.Head.FailedCount is < 0 or > 10_000
            || envelope.Head.CancelledCount is < 0 or > 10_000
            || envelope.Head.ContentDigest
                != ArticleBulkDigest.Of(envelope.Head with
                {
                    ContentDigest = string.Empty
                })
            || envelope.PreviousEnvelopeDigest != previousEnvelopeDigest
            || envelope.ItemReceipts.IsDefault
            || envelope.ItemReceipts.Length > ArticleBulkExecutionFramework.ReceiptChunkSize
            || envelope.ArticleId is null
                && (envelope.ExpectedItemStatus is not null || envelope.NextItemStatus is not null)
            || envelope.ArticleId is not null && envelope.NextItemStatus is null
            || envelope.ItemReceipts.Any(receipt =>
                receipt.ContentDigest != ArticleBulkDigest.Of(receipt with
                {
                    ContentDigest = string.Empty
                })
                || receipt.AttemptId != attemptId
                || receipt.PlanDigest != envelope.Request.PlanDigest
                || receipt.RegistryDigest != envelope.Request.RegistryDigest
                || receipt.OperationId != envelope.Request.OperationId)
            || envelope.AggregateReceipt is not null
                && (envelope.AggregateReceipt.ContentDigest
                    != ArticleBulkDigest.Of(envelope.AggregateReceipt with
                    {
                        ContentDigest = string.Empty
                    })
                    || envelope.AggregateReceipt.AttemptId != attemptId
                    || envelope.AggregateReceipt.RequestDigest != envelope.Request.ContentDigest
                    || envelope.AggregateReceipt.PlanDigest != envelope.Request.PlanDigest
                    || envelope.AggregateReceipt.RegistryDigest != envelope.Request.RegistryDigest
                    || envelope.AggregateReceipt.OperationId != envelope.Request.OperationId
                    || envelope.AggregateReceipt.Strategy != envelope.Request.Strategy
                    || envelope.AggregateReceipt.FrozenSetDigest != envelope.Request.FrozenSetDigest))
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        ValidatePayloadBinding(
            envelope.Event,
            envelope.ArticleId,
            envelope.ItemReceipts,
            envelope.AggregateReceipt,
            "article-bulk.journal-corrupt");
    }

    private static void ValidateCreate(
        string storageKey,
        string idempotencyKey,
        ArticleBulkExecutionRequest request,
        ArticleBulkJournalEvent firstEvent,
        ArticleBulkJournalHead firstHead)
    {
        if (request.IdempotencyKey != idempotencyKey
            || request.ContentDigest != ArticleBulkDigest.Of(request with
            {
                ContentDigest = string.Empty
            })
            || request.AttemptId != firstEvent.AttemptId
            || request.AttemptId != firstHead.AttemptId
            || request.ExecutionIdentityDigest != firstHead.ExecutionIdentityDigest
            || request.PlanDigest != firstHead.PlanDigest
            || request.Strategy != firstHead.Strategy
            || !IsContentDigest(request.PlanDigest)
            || !IsContentDigest(request.RegistryDigest)
            || !IsContentDigest(request.ParametersDigest)
            || !IsContentDigest(request.FrozenSetDigest)
            || !IsContentDigest(request.ConfirmationDigest)
            || !IsContentDigest(request.AdmissionAuthorityReceiptDigest)
            || firstHead.IdempotencyKeyDigest != storageKey
            || !IsContentDigest(firstHead.PlanDigest)
            || firstEvent.Ordinal != 0
            || firstEvent.Kind != ArticleBulkJournalEventKind.Planned
            || firstEvent.ResultingState != ArticleBulkExecutionState.Planned
            || firstEvent.PreviousEventDigest != string.Empty
            || firstEvent.ArticleId is not null
            || firstEvent.CanonicalCommandOwner is not null
            || firstEvent.CanonicalCommandReceiptDigest is not null
            || firstEvent.GroupCommitOutcome is not null
            || firstEvent.GroupReceiptDigest is not null
            || firstEvent.AggregateReceiptDigest is not null
            || firstEvent.RetryRequestDigest is not null
            || firstEvent.ZeroWriteProofDigest is not null
                && !IsContentDigest(firstEvent.ZeroWriteProofDigest)
            || firstEvent.ContentDigest != ArticleBulkDigest.Of(firstEvent with
            {
                ContentDigest = string.Empty
            })
            || firstHead.EventCount != 1
            || firstHead.State != firstEvent.ResultingState
            || firstHead.LastEventDigest != firstEvent.ContentDigest
            || firstHead.ActiveArticleIds.IsDefault
            || !firstHead.ActiveArticleIds.IsEmpty
            || firstHead.AdmittedCount != 0
            || firstHead.SucceededCount != 0
            || firstHead.FailedCount != 0
            || firstHead.CancelledCount != 0
            || firstHead.GroupCommitStarted
            || firstHead.GroupCommitTerminal
            || firstHead.GroupCommitOutcome is not null
            || firstHead.ContentDigest != ArticleBulkDigest.Of(firstHead with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new ArticleBulkContractException("article-bulk.journal-create-invalid");
        }
        ValidatePayloadBinding(
            firstEvent,
            articleId: null,
            itemReceipts: [],
            aggregateReceipt: null,
            errorCode: "article-bulk.journal-create-invalid");
    }

    private static void ValidateAppend(
        ArticleBulkFileJournalSnapshot snapshot,
        ArticleBulkJournalAppend append)
    {
        if (append.Event.Kind == ArticleBulkJournalEventKind.GroupReconciled)
        {
            ArticleBulkExecutionFramework.ValidateReconciliationRequestShape(snapshot.Request);
        }
        if (snapshot.Head.ContentDigest != append.ExpectedHeadDigest)
        {
            throw new ArticleBulkContractException("article-bulk.journal-cas-conflict");
        }
        if (append.Event.AttemptId != snapshot.Head.AttemptId
            || append.Event.Ordinal != snapshot.Head.EventCount
            || append.Event.Ordinal >= MaximumJournalEvents
            || append.Event.PreviousEventDigest != snapshot.Head.LastEventDigest
            || append.Event.ContentDigest != ArticleBulkDigest.Of(append.Event with
            {
                ContentDigest = string.Empty
            })
            || append.NextHead.AttemptId != snapshot.Head.AttemptId
            || append.NextHead.ExecutionIdentityDigest != snapshot.Head.ExecutionIdentityDigest
            || append.NextHead.IdempotencyKeyDigest != snapshot.Head.IdempotencyKeyDigest
            || append.NextHead.PlanDigest != snapshot.Head.PlanDigest
            || append.NextHead.PlanDigest != snapshot.Request.PlanDigest
            || append.NextHead.Strategy != snapshot.Head.Strategy
            || append.NextHead.Strategy != snapshot.Request.Strategy
            || append.NextHead.State != append.Event.ResultingState
            || append.NextHead.EventCount != snapshot.Head.EventCount + 1
            || append.NextHead.LastEventDigest != append.Event.ContentDigest
            || append.NextHead.AdmittedCount != snapshot.Head.AdmittedCount
                + (append.Event.Kind == ArticleBulkJournalEventKind.ItemAdmitted ? 1 : 0)
            || append.NextHead.SucceededCount != snapshot.Head.SucceededCount + append.Event.SucceededDelta
            || append.NextHead.FailedCount != snapshot.Head.FailedCount + append.Event.FailedDelta
            || append.NextHead.CancelledCount != snapshot.Head.CancelledCount + append.Event.CancelledDelta
            || append.NextHead.GroupCommitStarted
                != (snapshot.Head.GroupCommitStarted
                    || append.Event.Kind == ArticleBulkJournalEventKind.GroupCommitStarted)
            || append.NextHead.GroupCommitTerminal
                != (snapshot.Head.GroupCommitTerminal
                    || ArticleBulkExecutionFramework.IsGroupTerminalKind(append.Event.Kind))
            || append.NextHead.GroupCommitOutcome
                != (ArticleBulkExecutionFramework.IsGroupTerminalKind(append.Event.Kind)
                    ? append.Event.GroupCommitOutcome
                    : snapshot.Head.GroupCommitOutcome)
            || append.NextHead.ActiveArticleIds.IsDefault
            || append.NextHead.ActiveArticleIds.Length > 256
            || append.NextHead.ActiveArticleIds.Distinct(StringComparer.Ordinal).Count()
                != append.NextHead.ActiveArticleIds.Length
            || append.NextHead.ActiveArticleIds.Any(static articleId =>
                !IsBoundedOpaqueValue(articleId, 256))
            || append.NextHead.AdmittedCount is < 0 or > 10_000
            || append.NextHead.SucceededCount is < 0 or > 10_000
            || append.NextHead.FailedCount is < 0 or > 10_000
            || append.NextHead.CancelledCount is < 0 or > 10_000
            || append.NextHead.ContentDigest
                != ArticleBulkDigest.Of(append.NextHead with
                {
                    ContentDigest = string.Empty
                }))
        {
            throw new ArticleBulkContractException("article-bulk.journal-append-invalid");
        }
        ValidatePayloadBinding(
            append.Event,
            append.ArticleId,
            append.ItemReceipts,
            append.AggregateReceipt,
            "article-bulk.journal-append-invalid");

        if (append.ItemReceipts.IsDefault
            || append.ItemReceipts.Any(receipt => receipt.ContentDigest
                    != ArticleBulkDigest.Of(receipt with
                    {
                        ContentDigest = string.Empty
                    })
                || receipt.AttemptId != snapshot.Request.AttemptId
                || receipt.PlanDigest != snapshot.Request.PlanDigest
                || receipt.RegistryDigest != snapshot.Request.RegistryDigest
                || receipt.OperationId != snapshot.Request.OperationId)
            || append.AggregateReceipt is not null
                && (append.AggregateReceipt.ContentDigest
                        != ArticleBulkDigest.Of(append.AggregateReceipt with
                        {
                            ContentDigest = string.Empty
                        })
                    || append.AggregateReceipt.AttemptId != snapshot.Request.AttemptId
                    || append.AggregateReceipt.RequestDigest != snapshot.Request.ContentDigest
                    || append.AggregateReceipt.PlanDigest != snapshot.Request.PlanDigest
                    || append.AggregateReceipt.RegistryDigest != snapshot.Request.RegistryDigest
                    || append.AggregateReceipt.OperationId != snapshot.Request.OperationId
                    || append.AggregateReceipt.Strategy != snapshot.Request.Strategy
                    || append.AggregateReceipt.FrozenSetDigest != snapshot.Request.FrozenSetDigest))
        {
            throw new ArticleBulkContractException("article-bulk.journal-append-invalid");
        }

        ImmutableArray<string> expectedActiveArticleIds = append.Event.Kind switch
        {
            ArticleBulkJournalEventKind.ItemStarted when append.ArticleId is not null =>
                snapshot.Head.ActiveArticleIds.Add(append.ArticleId),
            ArticleBulkJournalEventKind.ItemTerminal when append.ArticleId is not null =>
                snapshot.Head.ActiveArticleIds.Remove(append.ArticleId),
            _ => snapshot.Head.ActiveArticleIds
        };
        if (append.Event.Kind == ArticleBulkJournalEventKind.ItemStarted
                && snapshot.Head.ActiveArticleIds.Contains(append.ArticleId!, StringComparer.Ordinal)
            || append.Event.Kind == ArticleBulkJournalEventKind.ItemTerminal
                && !snapshot.Head.ActiveArticleIds.Contains(append.ArticleId!, StringComparer.Ordinal)
            || !append.NextHead.ActiveArticleIds.SequenceEqual(expectedActiveArticleIds))
        {
            throw new ArticleBulkContractException("article-bulk.journal-append-invalid");
        }

        if (append.ArticleId is not null && append.ExpectedItemStatus is not null
            && (!snapshot.ItemStates.TryGetValue(append.ArticleId, out ArticleBulkItemStatus actual)
                || actual != append.ExpectedItemStatus))
        {
            throw new ArticleBulkContractException("article-bulk.item-cas-conflict");
        }
        if (append.ArticleId is not null && append.ExpectedItemStatus is null
            && append.NextItemStatus is not null && snapshot.ItemStates.ContainsKey(append.ArticleId))
        {
            throw new ArticleBulkContractException("article-bulk.item-overwrite");
        }
        if (append.ItemReceipts.Any(receipt => snapshot.ReceiptArticleIds.Contains(receipt.ArticleId))
            || append.ItemReceipts.Select(static receipt => receipt.ArticleId)
                .Distinct(StringComparer.Ordinal).Count() != append.ItemReceipts.Length
            || append.AggregateReceipt is not null && snapshot.TerminalReceipt is not null)
        {
            throw new ArticleBulkContractException("article-bulk.item-overwrite");
        }
    }

    private static void ValidatePayloadBinding(
        ArticleBulkJournalEvent journalEvent,
        string? articleId,
        ImmutableArray<ArticleBulkItemReceipt> itemReceipts,
        ArticleBulkAggregateReceipt? aggregateReceipt,
        string errorCode)
    {
        string? receiptDigest = itemReceipts.Length switch
        {
            0 => null,
            1 => itemReceipts[0].ContentDigest,
            _ => ArticleBulkDigest.Of(itemReceipts.Select(static receipt => receipt.ContentDigest).ToArray())
        };
        bool articleBindingValid = journalEvent.Kind is ArticleBulkJournalEventKind.ItemAdmitted
            or ArticleBulkJournalEventKind.ItemStarted or ArticleBulkJournalEventKind.ItemTerminal
            ? articleId is not null
            : articleId is null;
        bool commandBindingValid = journalEvent.Kind switch
        {
            ArticleBulkJournalEventKind.ItemStarted or ArticleBulkJournalEventKind.GroupCommitStarted =>
                IsBoundedOpaqueValue(journalEvent.CanonicalCommandOwner, 256)
                && journalEvent.CanonicalCommandReceiptDigest is null,
            ArticleBulkJournalEventKind.ItemTerminal =>
                IsBoundedOpaqueValue(journalEvent.CanonicalCommandOwner, 256)
                && IsContentDigest(journalEvent.CanonicalCommandReceiptDigest),
            ArticleBulkJournalEventKind.GroupCommitTerminal or ArticleBulkJournalEventKind.GroupReconciled =>
                IsBoundedOpaqueValue(journalEvent.CanonicalCommandOwner, 256)
                && journalEvent.CanonicalCommandReceiptDigest == journalEvent.GroupReceiptDigest,
            _ => journalEvent.CanonicalCommandOwner is null
                && journalEvent.CanonicalCommandReceiptDigest is null
        };
        bool eventPayloadValid = journalEvent.Kind switch
        {
            ArticleBulkJournalEventKind.Planned => journalEvent.GroupCommitOutcome is null
                && journalEvent.GroupReceiptDigest is null
                && (journalEvent.ZeroWriteProofDigest is null
                    || IsContentDigest(journalEvent.ZeroWriteProofDigest))
                && aggregateReceipt is null && journalEvent.RetryRequestDigest is null,
            ArticleBulkJournalEventKind.GroupCommitTerminal or ArticleBulkJournalEventKind.GroupReconciled =>
                (journalEvent.GroupCommitOutcome switch
                {
                    ArticleBulkGroupCommitOutcome.Committed => IsContentDigest(journalEvent.GroupReceiptDigest)
                        && journalEvent.ZeroWriteProofDigest is null,
                    ArticleBulkGroupCommitOutcome.RejectedZeroWrite
                        or ArticleBulkGroupCommitOutcome.FailedZeroWrite =>
                        journalEvent.GroupReceiptDigest is null
                        && IsContentDigest(journalEvent.ZeroWriteProofDigest),
                    ArticleBulkGroupCommitOutcome.UnknownRecovery => journalEvent.GroupReceiptDigest is null
                        && journalEvent.ZeroWriteProofDigest is null,
                    _ => false
                }) && aggregateReceipt is null && journalEvent.RetryRequestDigest is null,
            ArticleBulkJournalEventKind.ExecutionTerminal => aggregateReceipt is not null
                && journalEvent.RetryRequestDigest is null,
            ArticleBulkJournalEventKind.RetryRequested => journalEvent.GroupCommitOutcome is null
                && journalEvent.GroupReceiptDigest is null && journalEvent.ZeroWriteProofDigest is null
                && aggregateReceipt is null && IsContentDigest(journalEvent.RetryRequestDigest),
            _ => journalEvent.GroupCommitOutcome is null && journalEvent.GroupReceiptDigest is null
                && journalEvent.ZeroWriteProofDigest is null && aggregateReceipt is null
                && journalEvent.RetryRequestDigest is null
        };
        if (!articleBindingValid || !commandBindingValid || !eventPayloadValid
            || journalEvent.AtUtc.Offset != TimeSpan.Zero
            || journalEvent.ReasonCode is not null
                && !IsBoundedOpaqueValue(journalEvent.ReasonCode, 256)
            || journalEvent.ArticleId != articleId
            || journalEvent.ItemReceiptDigest != receiptDigest
            || journalEvent.ReceiptCount != itemReceipts.Length
            || journalEvent.SucceededDelta
                != itemReceipts.Count(static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Succeeded)
            || journalEvent.FailedDelta
                != itemReceipts.Count(static receipt => receipt.ExecutionStatus is ArticleBulkItemStatus.Failed
                    or ArticleBulkItemStatus.RecoveryRequired)
            || journalEvent.CancelledDelta
                != itemReceipts.Count(static receipt => receipt.ExecutionStatus == ArticleBulkItemStatus.Cancelled)
            || journalEvent.AggregateReceiptDigest != aggregateReceipt?.ContentDigest)
        {
            throw new ArticleBulkContractException(errorCode);
        }
        if (itemReceipts.Any(receipt => aggregateReceipt is not null
                && receipt.PlanDigest != aggregateReceipt.PlanDigest)
            || aggregateReceipt is not null
                && (aggregateReceipt.AttemptId != journalEvent.AttemptId
                    || aggregateReceipt.TerminalState != journalEvent.ResultingState
                    || aggregateReceipt.GroupCommitOutcome != journalEvent.GroupCommitOutcome
                    || aggregateReceipt.GroupReceiptDigest != journalEvent.GroupReceiptDigest
                    || aggregateReceipt.ZeroWriteProofDigest != journalEvent.ZeroWriteProofDigest))
        {
            throw new ArticleBulkContractException(errorCode);
        }
    }

    private static void ApplyEnvelope(
        ArticleBulkFileJournalSnapshot snapshot,
        ArticleBulkFileJournalEnvelope envelope)
        => ApplyEnvelope(snapshot.ItemStates, snapshot.ReceiptArticleIds, envelope);

    private static void ApplyEnvelope(
        Dictionary<string, ArticleBulkItemStatus> itemStates,
        HashSet<string> receiptArticleIds,
        ArticleBulkFileJournalEnvelope envelope)
    {
        if (envelope.ArticleId is not null && envelope.ExpectedItemStatus is not null
            && (!itemStates.TryGetValue(envelope.ArticleId, out ArticleBulkItemStatus actual)
                || actual != envelope.ExpectedItemStatus))
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        if (envelope.ArticleId is not null && envelope.ExpectedItemStatus is null
            && envelope.NextItemStatus is not null && itemStates.ContainsKey(envelope.ArticleId))
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        if (envelope.ArticleId is not null && envelope.NextItemStatus is not null)
        {
            itemStates[envelope.ArticleId] = envelope.NextItemStatus.Value;
        }
        foreach (ArticleBulkItemReceipt receipt in envelope.ItemReceipts)
        {
            if (!receiptArticleIds.Add(receipt.ArticleId))
            {
                throw new ArticleBulkContractException("article-bulk.journal-corrupt");
            }
        }
    }

    private async Task<FileStream> AcquireLockAsync(
        string storageKey,
        CancellationToken cancellationToken)
    {
        string lockPath = Path.Combine(GetAttemptRoot(storageKey), "journal.lock");
        EnsureDirectoryDurably(Path.GetDirectoryName(lockPath)!);
        long waitStarted = _timeProvider.GetTimestamp();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return new FileStream(
                    lockPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.Asynchronous | FileOptions.WriteThrough);
            }
            catch (IOException) when (_timeProvider.GetElapsedTime(waitStarted) < TimeSpan.FromSeconds(10))
            {
                // This waits only for the storage mutex; it never retries a command or mutation.
                await Task.Delay(TimeSpan.FromMilliseconds(25), _timeProvider, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (IOException)
            {
                throw new ArticleBulkContractException("article-bulk.journal-lock-unavailable");
            }
        }
    }

    private static async Task<T> ReadJsonAsync<T>(
        string path,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                64 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            if (stream.Length is < 1 || stream.Length > maximumBytes)
            {
                throw new ArticleBulkContractException("article-bulk.journal-corrupt");
            }
            T? value = await JsonSerializer.DeserializeAsync<T>(stream, s_jsonOptions, cancellationToken)
                .ConfigureAwait(false);
            return value ?? throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            throw new ArticleBulkContractException("article-bulk.journal-corrupt");
        }
    }

    private static async Task WriteJsonDurablyAsync<T>(
        string path,
        T value,
        bool overwrite,
        CancellationToken cancellationToken)
    {
        string directory = Path.GetDirectoryName(path)!;
        EnsureDirectoryDurably(directory);
        string temporaryPath = Path.Combine(directory, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, value, s_jsonOptions, cancellationToken)
                    .ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, path, overwrite);
            FlushDirectoryDurably(directory);
        }
        finally
        {
            if (File.Exists(temporaryPath))
            {
                File.Delete(temporaryPath);
            }
        }
    }

    private static void EnsureDirectoryDurably(string path)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new ArticleBulkContractException("article-bulk.journal-platform-unsupported");
        }
        string fullPath = Path.GetFullPath(path);
        if (Directory.Exists(fullPath))
        {
            return;
        }

        var missing = new Stack<string>();
        string? cursor = fullPath;
        while (cursor is not null && !Directory.Exists(cursor))
        {
            missing.Push(cursor);
            cursor = Path.GetDirectoryName(cursor);
        }
        if (cursor is null)
        {
            throw new ArticleBulkContractException("article-bulk.journal-data-root-invalid");
        }

        while (missing.Count > 0)
        {
            string directory = missing.Pop();
            Directory.CreateDirectory(directory);
            File.SetUnixFileMode(
                directory,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            FlushDirectoryDurably(directory);
            FlushDirectoryDurably(Path.GetDirectoryName(directory)!);
        }
    }

    private static void FlushDirectoryDurably(string directory)
    {
        int descriptor = OpenDirectory(
            directory,
            LinuxOpenDirectory | LinuxOpenCloseOnExec);
        if (descriptor < 0)
        {
            throw new ArticleBulkContractException("article-bulk.journal-directory-fsync-unavailable");
        }
        try
        {
            if (FlushDescriptor(descriptor) != 0)
            {
                throw new ArticleBulkContractException("article-bulk.journal-directory-fsync-unavailable");
            }
        }
        finally
        {
            _ = CloseDescriptor(descriptor);
        }
    }

    private string GetAttemptRoot(string storageKey)
        => Path.Combine(_journalRoot, "attempts", ValidateStorageKey(storageKey).AsSpan(7).ToString());

    private string GetPointerPath(string storageKey)
        => Path.Combine(GetAttemptRoot(storageKey), "sealed.json");

    private string GetEnvelopePath(string storageKey, long ordinal, string contentDigest)
        => Path.Combine(
            GetAttemptRoot(storageKey),
            "objects",
            $"{ordinal:D20}-{ValidateStorageKey(contentDigest)[7..]}.json");

    private string GetReferencePath(string storageKey, long ordinal)
        => Path.Combine(GetAttemptRoot(storageKey), "references", $"{ordinal:D20}.json");

    private static string GetStorageKey(string idempotencyKey)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey)
            || idempotencyKey.Length > 256
            || idempotencyKey.Any(char.IsControl))
        {
            throw new ArticleBulkContractException("article-bulk.idempotency-key-invalid");
        }
        return ArticleBulkDigest.Of(idempotencyKey);
    }

    private static string ValidateStorageKey(string storageKey)
        => IsContentDigest(storageKey)
            ? storageKey
            : throw new ArticleBulkContractException("article-bulk.journal-storage-key-invalid");

    private static ArticleBulkFileJournalEnvelope SealEnvelope(ArticleBulkFileJournalEnvelope envelope)
        => envelope with
        {
            ContentDigest = ArticleBulkDigest.Of(envelope with
            {
                ContentDigest = string.Empty
            })
        };

    private static ArticleBulkFileJournalEnvelopeReference SealReference(
        ArticleBulkFileJournalEnvelopeReference reference)
        => reference with
        {
            ContentDigest = ArticleBulkDigest.Of(reference with
            {
                ContentDigest = string.Empty
            })
        };

    private static ArticleBulkFileJournalPointer SealPointer(ArticleBulkFileJournalPointer pointer)
        => pointer with
        {
            ContentDigest = ArticleBulkDigest.Of(pointer with
            {
                ContentDigest = string.Empty
            })
        };

    private static ArticleBulkJournalAppendReceipt CreateAppendReceipt(
        ArticleBulkFileJournalEnvelope envelope,
        ArticleBulkFileJournalPointer pointer)
        => new(
            envelope.Event.AttemptId,
            envelope.Event.Ordinal,
            envelope.Event.ContentDigest,
            envelope.Head.ContentDigest,
            ArticleBulkDigest.Of(new
            {
                EnvelopeDigest = envelope.ContentDigest,
                PointerDigest = pointer.ContentDigest
            }));

    private static bool IsTerminal(ArticleBulkExecutionState state)
        => state is ArticleBulkExecutionState.Cancelled
            or ArticleBulkExecutionState.Completed
            or ArticleBulkExecutionState.Partial
            or ArticleBulkExecutionState.Failed
            or ArticleBulkExecutionState.Blocked
            or ArticleBulkExecutionState.RecoveryRequired;

    private static bool IsContentDigest(string? value)
        => value is not null
            && value.Length == 71
            && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static bool IsBoundedOpaqueValue(string? value, int maximumLength)
        => !string.IsNullOrWhiteSpace(value)
            && value.Length <= maximumLength
            && value.All(static character => !char.IsControl(character));

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int OpenDirectory(string path, int flags);

    [DllImport("libc", EntryPoint = "fsync", SetLastError = true)]
    private static extern int FlushDescriptor(int descriptor);

    [DllImport("libc", EntryPoint = "close", SetLastError = true)]
    private static extern int CloseDescriptor(int descriptor);

    private sealed class ArticleBulkFileJournalSnapshot(
        ArticleBulkFileJournalPointer pointer,
        ArticleBulkExecutionRequest request,
        ArticleBulkJournalHead head,
        ArticleBulkAggregateReceipt? terminalReceipt,
        Dictionary<string, ArticleBulkItemStatus> itemStates,
        HashSet<string> receiptArticleIds)
    {
        internal ArticleBulkFileJournalPointer Pointer { get; set; } = pointer;
        internal ArticleBulkExecutionRequest Request { get; } = request;
        internal ArticleBulkJournalHead Head { get; set; } = head;
        internal ArticleBulkAggregateReceipt? TerminalReceipt { get; set; } = terminalReceipt;
        internal Dictionary<string, ArticleBulkItemStatus> ItemStates { get; } = itemStates;
        internal HashSet<string> ReceiptArticleIds { get; } = receiptArticleIds;
    }
}
