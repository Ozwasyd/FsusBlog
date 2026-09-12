using System.Diagnostics;
using System.Text;
using System.Text.Json;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.Linux.Tests;

/// <summary>Normalized observation kinds required by the parent #1910 contract.</summary>
internal enum AgentObservationKind
{
    Created,
    ContentChanged,
    MetadataSidecarChanged,
    Renamed,
    Moved,
    Removed,
    Reappeared,
    CaseCollision,
    UnicodeCollision,
    IncompleteWrite,
    PermissionBlocked,
    RescanRequired
}

/// <summary>One deterministic normalized observation (privacy-safe: paths and digests only).</summary>
internal sealed record AgentObservation(
    AgentObservationKind Kind,
    string RelativePath,
    string? OldRelativePath,
    string? PortableArticleIdentity,
    string? SourceSha256,
    string? ErrorCode);

/// <summary>A deterministic, content-addressed observation batch bound to root and watch identities.</summary>
internal sealed record AgentObservationBatch(
    string Schema,
    int SchemaVersion,
    string RootIdentity,
    string AgentIdentity,
    string WatchInstanceIdentity,
    long BatchSequence,
    long FactWatermark,
    string SnapshotSha256,
    IReadOnlyList<AgentObservation> Items,
    string BatchSha256);

/// <summary>One sealed observation/materialization receipt bound 1:1 to a plan operation.</summary>
internal sealed record AgentOperationReceipt(
    string Schema,
    int SchemaVersion,
    string OperationIdentity,
    string PortableArticleIdentity,
    string Decision,
    string RelativePath,
    string SourceSha256,
    string PlanSha256,
    string ReceiptSha256);

/// <summary>Result of a lease acquisition or validation attempt.</summary>
internal sealed record AgentLeaseResult(bool Acquired, string? ReasonCode);

/// <summary>Result of a closed IPC command invocation.</summary>
internal sealed record AgentIpcResult(bool Succeeded, string? ReasonCode);

/// <summary>Captured Linux/ext4 environment identity for the qualification receipt.</summary>
internal sealed record LinuxVaultQualificationEnvironment(
    string KernelRelease,
    string FileSystemType,
    int MountIdentity,
    bool CaseSensitive,
    string UnicodeNormalization,
    int InotifyMaxQueuedEvents);

/// <summary>
/// Qualification-side reference implementation of the still-open agent layers
/// (#2110 stable read/materialization, #2112 normalization/rescan, #2113 lease/IPC,
/// #2114 lifecycle). Every operation executes against the real ext4 filesystem, the real
/// #2672 inotify watcher, and the real shared contracts; nothing here replaces them.
/// </summary>
internal sealed class LinuxVaultAgentHarness : IDisposable
{
    internal const string LeaseSchema = "fsusblog.article-vault.qualification.agent-lease.v1";
    internal const string BatchSchema = "fsusblog.article-vault.qualification.observation-batch.v1";
    internal const string ReceiptSchema = "fsusblog.article-vault.qualification.operation-receipt.v1";
    internal const string RescanReceiptSchema = "fsusblog.article-vault.qualification.rescan-receipt.v1";

    private readonly LinuxVaultTestRoot _root;
    private readonly string _agentIdentity;
    private readonly LinuxVaultWatcherOptions _options;
    private readonly int _protocolVersion;
    private readonly List<AgentOperationReceipt> _receipts = [];
    private LinuxVaultWatcherSession? _session;
    private ArticleVaultRootManifest? _rootManifest;
    private string? _leaseToken;
    private long _lastFactSequence;
    private long _batchSequence;
    private long _rescanSequence;
    private string? _lastRescanReceiptSha256;
    private List<string> _lastRescanPaths = [];
    private bool _disposed;

    internal LinuxVaultAgentHarness(
        LinuxVaultTestRoot root,
        string agentIdentity,
        LinuxVaultWatcherOptions? options = null,
        int protocolVersion = 1)
    {
        _root = root;
        _agentIdentity = agentIdentity;
        _options = options ?? new LinuxVaultWatcherOptions();
        _protocolVersion = protocolVersion;
    }

    internal LinuxVaultWatcherSession Session
        => _session ?? throw new InvalidOperationException("agent session is not started");

    internal ArticleVaultRootManifest RootManifest
        => _rootManifest ?? _root.Manifest;

    internal bool LeaseHeld => _leaseToken is not null;

    internal string? LeaseToken => _leaseToken;

    internal long LastFactSequence => _lastFactSequence;

    internal string? LastRescanReceiptSha256 => _lastRescanReceiptSha256;

    internal IReadOnlyList<string> LastRescanPaths => _lastRescanPaths;

    internal IReadOnlyList<AgentOperationReceipt> Receipts => _receipts;

    internal void Install(IReadOnlyList<ArticleVaultArticleManifest>? articles = null)
    {
        Directory.CreateDirectory(ControlPath("tmp"));
        Directory.CreateDirectory(ControlPath("receipts"));
        if (articles is null)
        {
            _rootManifest = _root.Manifest;
            return;
        }

        foreach (ArticleVaultArticleManifest article in articles)
        {
            File.WriteAllBytes(
                Path.Combine(
                    _root.Path,
                    ArticleVaultSchemas.ArticleManifestDirectory.Replace('/', Path.DirectorySeparatorChar),
                    $"{article.PortableArticleIdentity}.json"),
                ArticleVaultManifestCodec.Serialize(article));
        }

        ArticleVaultRootManifest unsealed = _root.Manifest with
        {
            Articles = articles
                .OrderBy(static article => article.PortableArticleIdentity, StringComparer.Ordinal)
                .Select(static article => new VaultArticleReference(
                    article.PortableArticleIdentity,
                    $"{ArticleVaultSchemas.ArticleManifestDirectory}/{article.PortableArticleIdentity}.json",
                    article.ContentSha256,
                    article.PathProjection.RelativePath))
                .ToArray(),
            ContentSha256 = string.Empty
        };
        _rootManifest = unsealed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
        };
        File.WriteAllBytes(
            Path.Combine(_root.Path, ".fsus", "vault.json"),
            ArticleVaultManifestCodec.Serialize(_rootManifest));
    }

    internal void InstallControlTreeOnly()
    {
        Directory.CreateDirectory(ControlPath("tmp"));
        _rootManifest = ArticleVaultManifestCodec.DeserializeRoot(
            File.ReadAllBytes(Path.Combine(_root.Path, ".fsus", "vault.json")));
    }

    internal void Start()
    {
        if (_protocolVersion != ArticleVaultPlanSchemas.Version)
        {
            throw new LinuxVaultWatcherException("agent_protocol_mismatch");
        }

        AgentLeaseResult lease = TryAcquireLease();
        if (!lease.Acquired)
        {
            throw new LinuxVaultWatcherException(lease.ReasonCode ?? "agent_lease_conflict");
        }

        _session = OpenSessionOnly();
        Rescan();
    }

    internal LinuxVaultWatcherSession OpenSessionOnly()
    {
        _session?.Dispose();
        _session = LinuxVaultWatcherSession.Open(new(
            _root.Path,
            RootManifest,
            _agentIdentity,
            _options));
        return _session;
    }

    internal void AttachSession(LinuxVaultWatcherSession session) => _session = session;

    internal void WriteSource(string relativePath, string content)
        => File.WriteAllText(Absolute(relativePath), content);

    internal void WriteSourceBytes(string relativePath, byte[] bytes)
    {
        string absolute = Absolute(relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(absolute)!);
        File.WriteAllBytes(absolute, bytes);
    }

    internal IReadOnlyList<LinuxVaultRawFact> DrainUntil(
        Func<LinuxVaultRawFact, bool> predicate,
        TimeSpan? timeout = null)
    {
        var facts = new List<LinuxVaultRawFact>();
        DateTime deadline = DateTime.UtcNow.Add(timeout ?? TimeSpan.FromSeconds(10));
        while (DateTime.UtcNow < deadline)
        {
            foreach (LinuxVaultRawFact fact in Session.ReadAvailable())
            {
                facts.Add(fact);
                _lastFactSequence = Math.Max(_lastFactSequence, fact.Sequence);
            }

            if (facts.Any(predicate))
            {
                return facts;
            }

            Thread.Sleep(10);
        }

        throw new Xunit.Sdk.XunitException(
            $"qualification fact not observed: {string.Join(", ", facts.Select(static item => $"{item.FactClass}:{item.RawOldRelativePath}->{item.RawNewRelativePath}:{item.ErrorCode}"))}");
    }

    private void DrainPending()
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(2);
        int quietReads = 0;
        while (DateTime.UtcNow < deadline && quietReads < 3)
        {
            IReadOnlyList<LinuxVaultRawFact> facts = Session.ReadAvailable();
            foreach (LinuxVaultRawFact fact in facts)
            {
                _lastFactSequence = Math.Max(_lastFactSequence, fact.Sequence);
            }

            quietReads = facts.Count == 0 ? quietReads + 1 : 0;
            if (facts.Count == 0)
            {
                Thread.Sleep(15);
            }
        }
    }

    /// <summary>
    /// #2110 stable read (simulated at contract level): a path is admitted only with an
    /// atomic close or rename proof in the observed facts, or during a rescan where the
    /// snapshot is stable across a bounded window. Half-written content is never admitted.
    /// </summary>
    internal VaultSourceByteIdentity? StableRead(string relativePath, IReadOnlyList<LinuxVaultRawFact> facts)
    {
        bool closeProof = facts.Any(item =>
            item.RawNewRelativePath == relativePath
            && item.FactClass is LinuxVaultFactClass.ClosedAfterWrite or LinuxVaultFactClass.MovedTo);
        return closeProof ? StableReadSnapshot(relativePath) : null;
    }

    private VaultSourceByteIdentity? StableReadSnapshot(string relativePath)
    {
        string absolute = Absolute(relativePath);
        for (int attempt = 0; attempt < 4; attempt++)
        {
            byte[] first;
            try
            {
                first = File.ReadAllBytes(absolute);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return null;
            }

            VaultSourceByteIdentity firstIdentity;
            try
            {
                firstIdentity = ArticleVaultManifestCodec.CaptureSourceBytes(first);
            }
            catch (DecoderFallbackException)
            {
                return null;
            }

            Thread.Sleep(25);
            try
            {
                byte[] second = File.ReadAllBytes(absolute);
                if (firstIdentity == ArticleVaultManifestCodec.CaptureSourceBytes(second))
                {
                    return firstIdentity;
                }
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or DecoderFallbackException)
            {
                return null;
            }
        }

        return null;
    }

    /// <summary>
    /// #2112 normalization (simulated): folds raw facts into a deterministic
    /// content-addressed observation batch; never derives identity from cookie/inode/mtime.
    /// </summary>
    internal AgentObservationBatch Normalize(IReadOnlyList<LinuxVaultRawFact> facts)
    {
        var moves = new Dictionary<uint, string>();
        foreach (LinuxVaultRawFact fact in facts.Where(static item => item.FactClass == LinuxVaultFactClass.MovedFrom))
        {
            if (fact.CookieDiagnostic is { } cookie && fact.RawOldRelativePath is { } oldPath)
            {
                moves[cookie] = oldPath;
            }
        }

        var items = new List<AgentObservation>();
        var mutated = new HashSet<string>(StringComparer.Ordinal);
        var closed = new HashSet<string>(StringComparer.Ordinal);
        var removed = new HashSet<string>(StringComparer.Ordinal);
        var sourcePaths = new HashSet<string>(StringComparer.Ordinal);
        foreach (LinuxVaultRawFact fact in facts.OrderBy(static item => item.Sequence))
        {
            string? path = fact.RawNewRelativePath ?? fact.RawOldRelativePath;
            if (fact.PathDisposition == LinuxVaultPathDisposition.Source
                && fact.RawNewRelativePath is { Length: > 0 } sourcePath)
            {
                sourcePaths.Add(sourcePath);
            }

            if (fact.PathDisposition == LinuxVaultPathDisposition.ControlTree && path is not null)
            {
                items.Add(new(AgentObservationKind.MetadataSidecarChanged, path, fact.RawOldRelativePath, null, null, fact.ErrorCode));
                continue;
            }

            if (fact.PathDisposition == LinuxVaultPathDisposition.Blocked)
            {
                bool permission = fact.ErrorCode?.Contains("permission", StringComparison.Ordinal) == true;
                items.Add(new(
                    permission ? AgentObservationKind.PermissionBlocked : AgentObservationKind.RescanRequired,
                    path ?? string.Empty,
                    null,
                    null,
                    null,
                    fact.ErrorCode));
                continue;
            }

            switch (fact.FactClass)
            {
                case LinuxVaultFactClass.Created:
                    if (path is not null)
                    {
                        mutated.Add(path);
                        items.Add(new(AgentObservationKind.Created, path, null, null, null, null));
                    }

                    break;
                case LinuxVaultFactClass.Modified:
                case LinuxVaultFactClass.AttributesChanged:
                    if (path is not null)
                    {
                        mutated.Add(path);
                        items.Add(new(AgentObservationKind.ContentChanged, path, null, null, null, null));
                    }

                    break;
                case LinuxVaultFactClass.ClosedAfterWrite:
                    if (path is not null)
                    {
                        mutated.Add(path);
                        closed.Add(path);
                        items.Add(new(AgentObservationKind.ContentChanged, path, null, null, null, null));
                    }

                    break;
                case LinuxVaultFactClass.MovedFrom:
                    break;
                case LinuxVaultFactClass.MovedTo:
                    if (path is null)
                    {
                        break;
                    }

                    mutated.Add(path);
                    closed.Add(path);
                    if (fact.CookieDiagnostic is { } moveCookie && moves.TryGetValue(moveCookie, out string? oldPath))
                    {
                        string oldDirectory = Path.GetDirectoryName(oldPath.Replace('/', Path.DirectorySeparatorChar)) ?? string.Empty;
                        string newDirectory = Path.GetDirectoryName(path.Replace('/', Path.DirectorySeparatorChar)) ?? string.Empty;
                        items.Add(new(
                            string.Equals(oldDirectory, newDirectory, StringComparison.Ordinal)
                                ? AgentObservationKind.Renamed
                                : AgentObservationKind.Moved,
                            path,
                            oldPath,
                            null,
                            null,
                            null));
                        sourcePaths.Add(path);
                    }
                    else
                    {
                        items.Add(new(AgentObservationKind.Reappeared, path, null, null, null, null));
                    }

                    break;
                case LinuxVaultFactClass.Deleted:
                    if (path is not null)
                    {
                        removed.Add(path);
                        items.Add(new(AgentObservationKind.Removed, path, null, null, null, null));
                    }

                    break;
                default:
                    items.Add(new(AgentObservationKind.RescanRequired, path ?? string.Empty, null, null, null,
                        fact.ErrorCode ?? fact.FactClass.ToString()));
                    break;
            }
        }

        foreach (string path in mutated.Except(closed).Except(removed))
        {
            items.Add(new(AgentObservationKind.IncompleteWrite, path, null, null, null, null));
        }

        foreach (IGrouping<string, string> group in sourcePaths
            .GroupBy(static path => path, StringComparer.OrdinalIgnoreCase)
            .Where(static group => group.Count() > 1))
        {
            foreach (string path in group)
            {
                items.Add(new(AgentObservationKind.CaseCollision, path, null, null, null, "agent_case_collision"));
            }
        }

        foreach (IGrouping<string, string> group in sourcePaths
            .GroupBy(static path => path.Normalize(NormalizationForm.FormC), StringComparer.Ordinal)
            .Where(static group => group.Count() > 1))
        {
            foreach (string path in group)
            {
                items.Add(new(AgentObservationKind.UnicodeCollision, path, null, null, null, "agent_unicode_collision"));
            }
        }

        AgentObservation[] ordered = items
            .GroupBy(static item => (item.Kind, item.RelativePath, item.OldRelativePath))
            .Select(static group => group.First())
            .OrderBy(static item => item.RelativePath, StringComparer.Ordinal)
            .ThenBy(static item => item.Kind)
            .ThenBy(static item => item.OldRelativePath, StringComparer.Ordinal)
            .ToArray();
        long watermark = facts.Count == 0 ? 0 : facts.Max(static item => item.Sequence);
        var unsealed = new AgentObservationBatch(
            BatchSchema,
            1,
            Session.Identity.RootIdentity,
            _agentIdentity,
            Session.Identity.WatchInstanceIdentity,
            ++_batchSequence,
            watermark,
            ArticleVaultManifestCodec.ComputeSha256(Encoding.UTF8.GetBytes(
                string.Join('\n', ordered.Select(static item =>
                    $"{item.Kind}:{item.OldRelativePath}->{item.RelativePath}:{item.ErrorCode}")))),
            ordered,
            string.Empty);
        return unsealed with
        {
            BatchSha256 = ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(unsealed))
        };
    }

    /// <summary>Clean/sync admission stays at zero until every rescan obligation is met.</summary>
    internal bool TryAdmitClean(IReadOnlyList<LinuxVaultRawFact> facts)
        => Session.Watermark.IsValid && !facts.Any(static item => item.RescanRequired);

    /// <summary>
    /// #2112 rescan (simulated): re-enumerates the real tree, stable-reads every source,
    /// seals a rescan receipt into the control tree, then acknowledges the rebuilt
    /// watermark through the real watcher.
    /// </summary>
    internal void Rescan()
    {
        DrainPending();
        // Closed-registry cleanup: control-tree temp files are only valid while an
        // operation is applying; a rescan makes them orphans, so they are removed.
        // User Markdown is never touched here.
        foreach (string orphan in Directory.EnumerateFiles(ControlPath("tmp")))
        {
            File.Delete(orphan);
        }

        string[] files = Directory.EnumerateFiles(_root.Path, "*.md", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(_root.Path, path).Replace(Path.DirectorySeparatorChar, '/'))
            .Where(static relative => !relative.StartsWith(".fsus/", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();
        var entries = new List<string>();
        foreach (string relative in files)
        {
            VaultSourceByteIdentity? identity = StableReadSnapshot(relative);
            if (identity is not null)
            {
                entries.Add($"{relative}:{identity.Sha256}");
            }
        }

        _lastRescanPaths = files.ToList();
        var receipt = new
        {
            schema = RescanReceiptSchema,
            schemaVersion = 1,
            rootIdentity = Session.Identity.RootIdentity,
            watchInstanceIdentity = Session.Identity.WatchInstanceIdentity,
            atFactSequence = _lastFactSequence,
            fileCount = files.Length,
            scanSha256 = ArticleVaultManifestCodec.ComputeSha256(Encoding.UTF8.GetBytes(string.Join('\n', entries)))
        };
        string receiptSha256 = ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(receipt));
        var sealedReceipt = new
        {
            receipt.schema,
            receipt.schemaVersion,
            receipt.rootIdentity,
            receipt.watchInstanceIdentity,
            receipt.atFactSequence,
            receipt.fileCount,
            receipt.scanSha256,
            receiptSha256
        };
        File.WriteAllBytes(
            Path.Combine(_root.Path, ".fsus", "receipts", $"rescan-{++_rescanSequence}.json"),
            JsonSerializer.SerializeToUtf8Bytes(sealedReceipt));
        // Control-tree writes from our own receipts are audited facts; drain them before
        // acknowledging so the rebuilt watermark is exact.
        DrainPending();
        Session.AcknowledgeRescan(receiptSha256);
        _lastRescanReceiptSha256 = receiptSha256;
    }

    internal void SettleToClean()
    {
        DrainPending();
        Rescan();
    }

    internal ArticleVaultArticleManifest CreateArticleManifest(
        string portableIdentity,
        string? serverIdentity,
        string relativePath,
        VaultArticleCoordinate baseCoordinate,
        VaultArticleCoordinate localCoordinate,
        VaultArticleCoordinate serverCoordinate)
    {
        var unsealed = new ArticleVaultArticleManifest(
            ArticleVaultSchemas.ArticleManifest,
            ArticleVaultSchemas.Version,
            RootManifest.SiteIdentity,
            RootManifest.VaultIdentity,
            RootManifest.DeviceIdentity,
            portableIdentity,
            serverIdentity,
            new VaultPathProjection(relativePath, ArticleVaultManifestCodec.ComputeProjectionSha256(relativePath)),
            new VaultArticleCoordinates(baseCoordinate, localCoordinate, serverCoordinate),
            new VaultOperationWatermarks(0, null, null, null, null, null, null),
            VaultArticleState.Untracked,
            string.Empty);
        ArticleVaultArticleManifest stateBound = unsealed with
        {
            State = ArticleVaultStateMachine.Derive(unsealed)
        };
        return stateBound with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(stateBound)
        };
    }

    internal ArticleVaultServerObservation CreateObservation(
        ArticleVaultArticleManifest article,
        VaultArticleCoordinate server)
    {
        var unsealed = new ArticleVaultServerObservation(
            ArticleVaultPlanSchemas.ServerObservation,
            ArticleVaultPlanSchemas.Version,
            article.SiteIdentity,
            article.VaultIdentity,
            article.DeviceIdentity,
            article.PortableArticleIdentity,
            article.ServerArticleIdentity,
            server,
            string.Empty);
        return unsealed with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(unsealed)
        };
    }

    /// <summary>
    /// Executes a sealed #1909 plan: Pull* decisions materialize through temp + fsync +
    /// atomic rename, Push* decisions emit stable-read observation receipts. The agent
    /// performs no direct save/write outside planned operations.
    /// </summary>
    internal IReadOnlyList<AgentOperationReceipt> ExecutePlan(
        ArticleVaultSyncPlan plan,
        IReadOnlyList<ArticleVaultArticleManifest> articles,
        IReadOnlyDictionary<string, byte[]> serverPayloads)
    {
        if (!ArticleVaultSyncPlanVerifier.ValidateStructure(plan).IsValid)
        {
            throw new LinuxVaultWatcherException("agent_plan_invalid");
        }

        var receipts = new List<AgentOperationReceipt>();
        foreach (string operationIdentity in plan.OperationOrder)
        {
            VaultSyncPlanItem item = plan.Groups
                .SelectMany(static group => group.Items)
                .Single(candidate => candidate.OperationIdentity == operationIdentity);
            ArticleVaultArticleManifest article = articles.Single(candidate =>
                candidate.PortableArticleIdentity == item.PortableArticleIdentity);
            serverPayloads.TryGetValue(item.PortableArticleIdentity, out byte[]? payload);
            receipts.Add(ExecuteOperation(plan, operationIdentity, article, payload));
        }

        return receipts;
    }

    internal AgentOperationReceipt ExecuteOperation(
        ArticleVaultSyncPlan plan,
        string operationIdentity,
        ArticleVaultArticleManifest article,
        byte[]? serverPayload)
    {
        EnsureWriterLease();
        if (!ArticleVaultSyncPlanVerifier.ValidateStructure(plan).IsValid
            || plan.Status is not (VaultSyncPlanStatus.Ready or VaultSyncPlanStatus.NoOp))
        {
            throw new LinuxVaultWatcherException("agent_plan_invalid");
        }

        VaultSyncPlanItem item = plan.Groups
            .SelectMany(static group => group.Items)
            .SingleOrDefault(candidate => candidate.OperationIdentity == operationIdentity)
            ?? throw new LinuxVaultWatcherException("agent_materialize_operation_unknown");
        if (item.PortableArticleIdentity != article.PortableArticleIdentity)
        {
            throw new LinuxVaultWatcherException("agent_materialize_binding_mismatch");
        }

        string relativePath = article.PathProjection.RelativePath;
        return item.Decision switch
        {
            VaultSyncDecision.PullCreate or VaultSyncDecision.PullUpdate
                => ExecutePull(plan, item, relativePath, serverPayload),
            VaultSyncDecision.PullDelete
                => ExecutePullDelete(plan, item, relativePath),
            VaultSyncDecision.PushCreate or VaultSyncDecision.PushUpdate or VaultSyncDecision.PushDelete
                => ExecutePushObservation(plan, item, relativePath),
            _ => SealReceipt(plan, item, relativePath, "noop", item.Local.Source?.Sha256 ?? new string('0', 64))
        };
    }

    private AgentOperationReceipt ExecutePull(
        ArticleVaultSyncPlan plan,
        VaultSyncPlanItem item,
        string relativePath,
        byte[]? serverPayload)
    {
        if (serverPayload is null || item.Server.Source is null
            || ArticleVaultManifestCodec.CaptureSourceBytes(serverPayload) != item.Server.Source)
        {
            throw new LinuxVaultWatcherException("agent_materialize_payload_mismatch");
        }

        string temporary = Path.Combine(_root.Path, ".fsus", "tmp", $"{item.OperationIdentity}.part");
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            stream.Write(serverPayload);
            stream.Flush(flushToDisk: true);
        }

        string target = Absolute(relativePath);
        try
        {
            File.Move(temporary, target, overwrite: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            if (File.Exists(temporary))
            {
                File.Delete(temporary);
            }

            throw new LinuxVaultWatcherException("agent_materialize_replace_failed", exception);
        }

        VaultSourceByteIdentity applied = ArticleVaultManifestCodec.CaptureSourceBytes(File.ReadAllBytes(target));
        if (applied != item.Server.Source)
        {
            throw new LinuxVaultWatcherException("agent_materialize_verify_failed");
        }

        return SealReceipt(plan, item, relativePath, DecisionName(item.Decision), applied.Sha256);
    }

    private AgentOperationReceipt ExecutePullDelete(
        ArticleVaultSyncPlan plan,
        VaultSyncPlanItem item,
        string relativePath)
    {
        string target = Absolute(relativePath);
        if (File.Exists(target))
        {
            File.Move(
                target,
                Path.Combine(_root.Path, ".fsus", "tmp", $"{item.OperationIdentity}.tombstone"),
                overwrite: true);
        }

        return SealReceipt(plan, item, relativePath, DecisionName(item.Decision), new string('0', 64));
    }

    private AgentOperationReceipt ExecutePushObservation(
        ArticleVaultSyncPlan plan,
        VaultSyncPlanItem item,
        string relativePath)
    {
        string target = Absolute(relativePath);
        if (item.Decision == VaultSyncDecision.PushDelete)
        {
            if (File.Exists(target))
            {
                throw new LinuxVaultWatcherException("agent_observation_source_mismatch");
            }

            return SealReceipt(plan, item, relativePath, DecisionName(item.Decision), new string('0', 64));
        }

        VaultSourceByteIdentity? observed = StableReadSnapshot(relativePath);
        if (observed is null || item.Local.Source is null || observed != item.Local.Source)
        {
            throw new LinuxVaultWatcherException("agent_observation_source_mismatch");
        }

        return SealReceipt(plan, item, relativePath, DecisionName(item.Decision), observed.Sha256);
    }

    private static string DecisionName(VaultSyncDecision decision)
        => System.Text.Json.JsonNamingPolicy.KebabCaseLower.ConvertName(decision.ToString());

    private AgentOperationReceipt SealReceipt(
        ArticleVaultSyncPlan plan,
        VaultSyncPlanItem item,
        string relativePath,
        string decision,
        string sourceSha256)
    {
        var unsealed = new AgentOperationReceipt(
            ReceiptSchema,
            1,
            item.OperationIdentity,
            item.PortableArticleIdentity,
            decision,
            relativePath,
            sourceSha256,
            plan.ContentSha256,
            string.Empty);
        AgentOperationReceipt receipt = unsealed with
        {
            ReceiptSha256 = ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(unsealed))
        };
        File.WriteAllBytes(
            Path.Combine(_root.Path, ".fsus", "receipts", $"{item.OperationIdentity}.json"),
            JsonSerializer.SerializeToUtf8Bytes(receipt));
        _receipts.Add(receipt);
        return receipt;
    }

    internal bool VerifyReceipt(AgentOperationReceipt receipt)
    {
        string expected = ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(
            receipt with
            {
                ReceiptSha256 = string.Empty
            }));
        return receipt.ReceiptSha256 == expected
            && receipt.Schema == ReceiptSchema
            && receipt.SchemaVersion == 1
            && receipt.OperationIdentity.StartsWith("operation-", StringComparison.Ordinal)
            && IsSha256(receipt.SourceSha256)
            && IsSha256(receipt.PlanSha256);
    }

    internal ArticleVaultArticleManifest? ManifestOnDisk(string portableIdentity)
    {
        string path = Path.Combine(
            _root.Path,
            ArticleVaultSchemas.ArticleManifestDirectory.Replace('/', Path.DirectorySeparatorChar),
            $"{portableIdentity}.json");
        return File.Exists(path)
            ? ArticleVaultManifestCodec.DeserializeArticle(File.ReadAllBytes(path))
            : null;
    }

    // --- #2113 lease and closed IPC (simulated at contract level over real ext4) ---

    internal AgentLeaseResult TryAcquireLease()
    {
        string leasePath = LeasePath();
        if (File.Exists(leasePath))
        {
            AgentLeaseResult existing = TryValidateLease();
            return existing.Acquired ? existing : new AgentLeaseResult(false, "agent_lease_conflict");
        }

        string token = Guid.NewGuid().ToString("N");
        var lease = new
        {
            schema = LeaseSchema,
            agent = _agentIdentity,
            pid = Environment.ProcessId,
            token,
            siteIdentity = RootManifest.SiteIdentity,
            vaultIdentity = RootManifest.VaultIdentity,
            deviceIdentity = RootManifest.DeviceIdentity
        };
        string leaseSha256 = ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(lease));
        var sealedLease = new
        {
            lease.schema,
            lease.agent,
            lease.pid,
            lease.token,
            lease.siteIdentity,
            lease.vaultIdentity,
            lease.deviceIdentity,
            leaseSha256
        };
        try
        {
            using var stream = new FileStream(leasePath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(sealedLease);
            stream.Write(bytes);
            stream.Flush(flushToDisk: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return new AgentLeaseResult(false, "agent_lease_conflict");
        }

        _leaseToken = token;
        return new AgentLeaseResult(true, null);
    }

    internal AgentLeaseResult TryValidateLease()
    {
        string leasePath = LeasePath();
        if (!File.Exists(leasePath))
        {
            return new AgentLeaseResult(false, "agent_lease_missing");
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(leasePath));
            JsonElement lease = document.RootElement;
            if (lease.GetProperty("schema").GetString() != LeaseSchema
                || lease.GetProperty("siteIdentity").GetString() != RootManifest.SiteIdentity
                || lease.GetProperty("vaultIdentity").GetString() != RootManifest.VaultIdentity
                || lease.GetProperty("deviceIdentity").GetString() != RootManifest.DeviceIdentity)
            {
                return new AgentLeaseResult(false, "agent_lease_binding_mismatch");
            }

            var body = new
            {
                schema = lease.GetProperty("schema").GetString(),
                agent = lease.GetProperty("agent").GetString(),
                pid = lease.GetProperty("pid").GetInt32(),
                token = lease.GetProperty("token").GetString(),
                siteIdentity = lease.GetProperty("siteIdentity").GetString(),
                vaultIdentity = lease.GetProperty("vaultIdentity").GetString(),
                deviceIdentity = lease.GetProperty("deviceIdentity").GetString()
            };
            string expected = ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(body));
            if (lease.GetProperty("leaseSha256").GetString() != expected)
            {
                return new AgentLeaseResult(false, "agent_lease_binding_mismatch");
            }

            int pid = lease.GetProperty("pid").GetInt32();
            if (!PidAlive(pid))
            {
                return new AgentLeaseResult(false, "agent_lease_stale");
            }

            string token = lease.GetProperty("token").GetString()!;
            if (_leaseToken is not null && token == _leaseToken)
            {
                return new AgentLeaseResult(true, null);
            }

            return new AgentLeaseResult(false, "agent_lease_conflict");
        }
        catch (Exception exception) when (exception is IOException
            or JsonException
            or UnauthorizedAccessException
            or KeyNotFoundException
            or InvalidOperationException
            or FormatException)
        {
            return new AgentLeaseResult(false, "agent_lease_binding_mismatch");
        }
    }

    internal AgentLeaseResult TryRecoverLease()
    {
        AgentLeaseResult current = TryValidateLease();
        if (current.Acquired)
        {
            return current;
        }

        if (current.ReasonCode == "agent_lease_stale")
        {
            File.Delete(LeasePath());
            return TryAcquireLease();
        }

        return current.ReasonCode == "agent_lease_missing" ? TryAcquireLease() : current;
    }

    internal void EnsureWriterLease()
    {
        AgentLeaseResult lease = TryValidateLease();
        if (!lease.Acquired)
        {
            throw new LinuxVaultWatcherException("agent_lease_required");
        }
    }

    /// <summary>
    /// Closed IPC surface (simulated #2113): only status/rescan/unlink exist, every command
    /// is bound to the live lease token, the caller uid and the protocol version, and no
    /// command accepts a filesystem path.
    /// </summary>
    internal AgentIpcResult InvokeIpc(string verb, string? argument, string token, int protocolVersion, int uid)
    {
        if (protocolVersion != ArticleVaultPlanSchemas.Version)
        {
            return new AgentIpcResult(false, "agent_ipc_protocol_mismatch");
        }

        if (uid != CurrentUid())
        {
            return new AgentIpcResult(false, "agent_ipc_cross_user");
        }

        if (!File.Exists(LeasePath()))
        {
            return new AgentIpcResult(false, "agent_ipc_token_revoked");
        }

        AgentLeaseResult lease = TryValidateLease();
        if (!lease.Acquired)
        {
            return new AgentIpcResult(false, "agent_ipc_token_revoked");
        }

        string? liveToken;
        try
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(LeasePath()));
            liveToken = document.RootElement.GetProperty("token").GetString();
        }
        catch (Exception exception) when (exception is IOException or JsonException or KeyNotFoundException)
        {
            return new AgentIpcResult(false, "agent_ipc_token_revoked");
        }

        if (liveToken != token)
        {
            return new AgentIpcResult(false, "agent_ipc_token_rejected");
        }

        if (argument is not null)
        {
            return new AgentIpcResult(false, "agent_ipc_argument_rejected");
        }

        return verb switch
        {
            "status" => new AgentIpcResult(true, null),
            "rescan" => RescanCommand(),
            "unlink" => UnlinkCommand(),
            _ => new AgentIpcResult(false, "agent_ipc_verb_unknown")
        };
    }

    private AgentIpcResult RescanCommand()
    {
        if (_session is not null)
        {
            Rescan();
        }

        return new AgentIpcResult(true, null);
    }

    private AgentIpcResult UnlinkCommand()
    {
        File.Delete(LeasePath());
        _leaseToken = null;
        return new AgentIpcResult(true, null);
    }

    internal static int CurrentUid()
    {
        foreach (string line in File.ReadLines("/proc/self/status"))
        {
            if (line.StartsWith("Uid:", StringComparison.Ordinal))
            {
                string[] fields = line[4..].Split('\t', StringSplitOptions.RemoveEmptyEntries);
                return int.Parse(fields[0], System.Globalization.CultureInfo.InvariantCulture);
            }
        }

        throw new InvalidOperationException("uid not found in /proc/self/status");
    }

    internal static string? FindOnPath(string name)
    {
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(':', StringSplitOptions.RemoveEmptyEntries))
        {
            string candidate = Path.Combine(directory, name);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private static bool PidAlive(int pid)
        => pid == Environment.ProcessId || Directory.Exists($"/proc/{pid}");

    private static bool IsSha256(string? value)
        => value is { Length: 64 } && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private string LeasePath() => ControlPath("agent.lease");

    private string ControlPath(string name) => Path.Combine(_root.Path, ".fsus", name);

    private string Absolute(string relativePath)
        => Path.Combine(_root.Path, relativePath.Replace('/', Path.DirectorySeparatorChar));

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _session?.Dispose();
    }
}

/// <summary>Seal helpers mirroring the contract-codec patterns used by the backend tests.</summary>
internal static class AgentHarnessFixtures
{
    internal static VaultArticleCoordinate AbsentCoordinate()
        => Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate,
            ArticleVaultSchemas.Version,
            false,
            false,
            null,
            null,
            null,
            null,
            null,
            null,
            string.Empty));

    internal static VaultArticleCoordinate LocalCoordinate(byte[] sourceBytes)
        => Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate,
            ArticleVaultSchemas.Version,
            true,
            false,
            null,
            ArticleVaultManifestCodec.CaptureSourceBytes(sourceBytes),
            ArticleVaultManifestCodec.ComputeSha256("metadata"u8),
            ArticleVaultManifestCodec.ComputeSha256("dependencies"u8),
            "draft",
            ArticleVaultManifestCodec.ComputeSha256("permission"u8),
            string.Empty));

    internal static VaultArticleCoordinate ServerCoordinate(byte[] sourceBytes, long revision)
        => Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate,
            ArticleVaultSchemas.Version,
            true,
            false,
            revision,
            ArticleVaultManifestCodec.CaptureSourceBytes(sourceBytes),
            ArticleVaultManifestCodec.ComputeSha256("metadata"u8),
            ArticleVaultManifestCodec.ComputeSha256("dependencies"u8),
            "draft",
            ArticleVaultManifestCodec.ComputeSha256("permission"u8),
            string.Empty));

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
    {
        VaultArticleCoordinate unsealed = coordinate with
        {
            ContentSha256 = string.Empty
        };
        return unsealed with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsealed)
        };
    }
}

/// <summary>Append-only, privacy-safe qualification evidence writer.</summary>
internal sealed class LinuxVaultQualificationEvidence
{
    private readonly object _gate = new();
    private readonly Dictionary<string, (bool Pass, int Checks)> _cases = new(StringComparer.Ordinal);
    private readonly List<string> _warnings = [];
    private long _sequence;
    private string? _firstFailure;

    internal LinuxVaultQualificationEvidence(string runDirectory)
    {
        RunDirectory = runDirectory;
        Directory.CreateDirectory(runDirectory);
        EvidencePath = Path.Combine(runDirectory, "evidence.jsonl");
    }

    internal string RunDirectory
    {
        get;
    }

    internal string EvidencePath
    {
        get;
    }

    internal void Record(string caseId, string checkId, bool passed, string detail)
    {
        lock (_gate)
        {
            var record = new
            {
                sequence = ++_sequence,
                caseId,
                checkId,
                result = passed ? "pass" : "fail",
                detail
            };
            File.AppendAllText(EvidencePath, JsonSerializer.Serialize(record) + "\n");
            _cases.TryGetValue(caseId, out (bool Pass, int Checks) current);
            bool priorPass = current.Checks == 0 || current.Pass;
            _cases[caseId] = (priorPass && passed, current.Checks + 1);
            if (!passed && _firstFailure is null)
            {
                _firstFailure = $"{caseId}/{checkId}";
            }
        }
    }

    internal void Warn(string warning)
    {
        lock (_gate)
        {
            _warnings.Add(warning);
        }
    }

    internal string Complete(LinuxVaultQualificationEnvironment environment, string agentIdentity)
    {
        lock (_gate)
        {
            string evidenceSha256 = File.Exists(EvidencePath)
                ? ArticleVaultManifestCodec.ComputeSha256(File.ReadAllBytes(EvidencePath))
                : ArticleVaultManifestCodec.ComputeSha256(ReadOnlySpan<byte>.Empty);
            var cases = _cases
                .OrderBy(static pair => pair.Key, StringComparer.Ordinal)
                .Select(static pair => new
                {
                    id = pair.Key,
                    result = pair.Value.Pass ? "pass" : "fail",
                    checks = pair.Value.Checks
                })
                .ToArray();
            var receipt = new
            {
                schema = "fsusblog.vault-agent-platform-qualification-receipt.v1",
                platform = "linux",
                issue = 2675,
                run = new
                {
                    runId = Path.GetFileName(RunDirectory),
                    completedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                },
                environment = new
                {
                    kernelRelease = environment.KernelRelease,
                    fileSystemType = environment.FileSystemType,
                    mountIdentity = environment.MountIdentity,
                    caseSensitive = environment.CaseSensitive,
                    unicodeNormalization = environment.UnicodeNormalization,
                    inotifyMaxQueuedEvents = environment.InotifyMaxQueuedEvents
                },
                identities = new
                {
                    agent = agentIdentity,
                    protocols = new
                    {
                        rawFact = LinuxVaultWatcherSchemas.RawFact,
                        rootManifest = ArticleVaultSchemas.RootManifest,
                        articleManifest = ArticleVaultSchemas.ArticleManifest,
                        metadataManifest = ArticleVaultSchemas.MetadataManifest,
                        coordinate = ArticleVaultSchemas.Coordinate,
                        controlTree = ArticleVaultSchemas.ControlTreeVersion,
                        syncPlan = ArticleVaultPlanSchemas.Plan,
                        serverObservation = ArticleVaultPlanSchemas.ServerObservation
                    }
                },
                cases,
                totals = new
                {
                    cases = cases.Length,
                    checks = _cases.Values.Sum(static value => value.Checks),
                    failures = cases.Count(static item => item.result == "fail")
                },
                firstFailure = _firstFailure,
                warnings = _warnings.ToArray(),
                evidenceSha256,
                contentSha256 = string.Empty
            };
            string receiptSha256 = ArticleVaultManifestCodec.ComputeSha256(
                JsonSerializer.SerializeToUtf8Bytes(receipt));
            var sealedReceipt = new
            {
                receipt.schema,
                receipt.platform,
                receipt.issue,
                receipt.run,
                receipt.environment,
                receipt.identities,
                receipt.cases,
                receipt.totals,
                receipt.firstFailure,
                receipt.warnings,
                receipt.evidenceSha256,
                contentSha256 = receiptSha256
            };
            string receiptPath = Path.Combine(RunDirectory, "receipt.json");
            File.WriteAllBytes(receiptPath, JsonSerializer.SerializeToUtf8Bytes(sealedReceipt));
            return receiptPath;
        }
    }
}

/// <summary>Shared fixture: one run directory, one environment capture, one receipt.</summary>
public sealed class LinuxVaultQualificationFixture : IDisposable
{
    public LinuxVaultQualificationFixture()
    {
        string repository = LinuxVaultTestRoot.FindRepositoryRoot();
        string runDirectory = Path.Combine(
            repository,
            ".tmp",
            "article-vault-linux-qualification",
            $"run-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{System.Environment.ProcessId}");
        Evidence = new LinuxVaultQualificationEvidence(runDirectory);

        using LinuxVaultTestRoot root = LinuxVaultTestRoot.Create();
        using LinuxVaultWatcherSession session = LinuxVaultWatcherSession.Open(new(
            root.Path,
            root.Manifest,
            "linux-vault-agent-qualification",
            new LinuxVaultWatcherOptions()));
        Environment = new LinuxVaultQualificationEnvironment(
            File.ReadAllText("/proc/sys/kernel/osrelease").Trim(),
            session.Identity.Filesystem.FileSystemType,
            session.Identity.Filesystem.MountIdentity,
            session.Identity.Filesystem.CaseSensitive,
            session.Identity.Filesystem.UnicodeNormalization,
            int.Parse(
                File.ReadAllText("/proc/sys/fs/inotify/max_queued_events"),
                System.Globalization.CultureInfo.InvariantCulture));
    }

    internal LinuxVaultQualificationEvidence Evidence
    {
        get;
    }

    internal LinuxVaultQualificationEnvironment Environment
    {
        get;
    }

    public void Dispose()
    {
        string receiptPath = Evidence.Complete(Environment, "linux-vault-agent-qualification");
        Console.WriteLine($"linux vault agent qualification receipt: {receiptPath}");
    }
}

/// <summary>
/// Real-process probes for crash and bind-mount qualification. Dispatched from
/// <see cref="LinuxVaultBindMountProbeProgram.Main"/> so the test assembly keeps a single
/// startup object.
/// </summary>
public static class LinuxVaultAgentProbeProgram
{
    public static int Main(string[] args)
        => args switch
        {
            ["--agent-crash-probe", var root] => RunCrashProbe(root),
            ["--agent-bind-probe", var root, var outside] => RunBindProbe(root, outside),
            _ => 64
        };

    private static int RunCrashProbe(string root)
    {
        try
        {
            ArticleVaultRootManifest manifest = ArticleVaultManifestCodec.DeserializeRoot(
                File.ReadAllBytes(Path.Combine(root, ".fsus", "vault.json")));
            Directory.CreateDirectory(Path.Combine(root, ".fsus", "tmp"));
            string leasePath = Path.Combine(root, ".fsus", "agent.lease");
            var lease = new
            {
                schema = "fsusblog.article-vault.qualification.agent-lease.v1",
                agent = "linux-vault-agent-crash-probe",
                pid = Environment.ProcessId,
                token = Guid.NewGuid().ToString("N"),
                siteIdentity = manifest.SiteIdentity,
                vaultIdentity = manifest.VaultIdentity,
                deviceIdentity = manifest.DeviceIdentity
            };
            string leaseSha256 = ArticleVaultManifestCodec.ComputeSha256(JsonSerializer.SerializeToUtf8Bytes(lease));
            var sealedLease = new
            {
                lease.schema,
                lease.agent,
                lease.pid,
                lease.token,
                lease.siteIdentity,
                lease.vaultIdentity,
                lease.deviceIdentity,
                leaseSha256
            };
            try
            {
                using var stream = new FileStream(leasePath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(sealedLease);
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                return 5;
            }

            using LinuxVaultWatcherSession session = LinuxVaultWatcherSession.Open(new(
                root,
                manifest,
                "linux-vault-agent-crash-probe",
                new LinuxVaultWatcherOptions()));
            // Partial materialization: write the payload into the control-tree temp file and
            // flush it; the process is killed before the atomic rename exists.
            string temporary = Path.Combine(root, ".fsus", "tmp", "crash-op.part");
            using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                stream.Write("partial-body-never-admitted\n"u8);
                stream.Flush(flushToDisk: true);
            }

            Console.WriteLine("ready");
            Console.Out.Flush();
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            return 1;
        }
    }

    private static int RunBindProbe(string root, string outside)
    {
        try
        {
            ArticleVaultRootManifest manifest = ArticleVaultManifestCodec.DeserializeRoot(
                File.ReadAllBytes(Path.Combine(root, ".fsus", "vault.json")));
            using LinuxVaultWatcherSession session = LinuxVaultWatcherSession.Open(new(
                root,
                manifest,
                "linux-vault-agent-bind-probe",
                new LinuxVaultWatcherOptions()));
            LinuxVaultRawFact? blocked = session.ReadAvailable()
                .FirstOrDefault(static item => item.ErrorCode == "linux_vault_mount_changed");
            if (blocked is null || !blocked.RescanRequired || blocked.PathDisposition != LinuxVaultPathDisposition.Blocked)
            {
                return 2;
            }

            Console.WriteLine(blocked.ErrorCode);
            Console.WriteLine($"mount-identity {session.Identity.Filesystem.MountIdentity}");

            int rootWatchDescriptor = LinuxVaultBindMountProbeProgram.RootWatchDescriptor(session);
            var mountStart = new ProcessStartInfo("mount")
            {
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false
            };
            mountStart.ArgumentList.Add("--bind");
            mountStart.ArgumentList.Add(outside);
            mountStart.ArgumentList.Add(root);
            using Process mount = Process.Start(mountStart)
                ?? throw new InvalidOperationException("failed to start mount");
            string mountOutput = mount.StandardOutput.ReadToEnd();
            string mountError = mount.StandardError.ReadToEnd();
            if (!mount.WaitForExit(10000) || mount.ExitCode != 0)
            {
                // This kernel/AppArmor policy denies mount(2) inside user namespaces.
                // Root-mount drift is then declared simulated; the child-bind block
                // above and the negative control remain real evidence.
                Console.Error.WriteLine($"mount failed stdout={mountOutput} stderr={mountError}");
                Console.WriteLine("mount-drift-environment-denied");
                return 0;
            }

            var convertRecord = typeof(LinuxVaultWatcherSession).GetMethod(
                "ConvertRecord",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("raw conversion entrypoint is missing");
            var drift = (LinuxVaultRawFact?)convertRecord.Invoke(
                session,
                [rootWatchDescriptor, 0x00000004u, 0u, null]);
            if (drift is null
                || drift.ErrorCode != "linux_vault_mount_changed"
                || drift.PathDisposition != LinuxVaultPathDisposition.Blocked
                || !drift.RescanRequired
                || drift.WatermarkValid
                || !LinuxVaultRawFactCodec.Validate(drift))
            {
                return 4;
            }

            Console.WriteLine("linux_vault_root_mount_changed_on_attrib");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            return 1;
        }
    }
}
