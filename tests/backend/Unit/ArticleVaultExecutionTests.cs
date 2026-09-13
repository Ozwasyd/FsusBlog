using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultExecutionTests
{
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    [Fact]
    public async Task Executor_LoadsSealedReferenceAndDuplicateReplaysTerminalResult()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        var store = new MemoryStore(bundle);
        var observer = new FixedObserver(CreateCurrent(bundle));
        var writer = new RecordingWriter();
        var executor = new ArticleVaultSyncPlanExecutor(
            store,
            observer,
            writer,
            new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

        ArticleVaultExecutionResult first = await executor.ExecuteAsync(
            bundle.PlanReference,
            bundle.PlanSha256);
        ArticleVaultExecutionResult replay = await executor.ExecuteAsync(
            bundle.PlanReference,
            bundle.PlanSha256);

        Assert.Equal(ArticleVaultExecutionOutcome.Completed, first.Outcome);
        Assert.Equal(first.ContentSha256, replay.ContentSha256);
        Assert.Equal(1, writer.ExecutionCount);
        Assert.Equal(1, store.SaveCount);
        ArticleVaultExecutionIntegrity.VerifyResult(bundle, replay);
    }

    [Fact]
    public async Task Executor_RejectsRevisionPermissionLifecycleAndDependencyDriftBeforeWriter()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        ArticleVaultCurrentArticleObservation current = Assert.Single(CreateCurrent(bundle));
        ArticleVaultCurrentArticleObservation[] drifts =
        [
            current with { ServerRevision = current.ServerRevision + 1 },
            current with { Permitted = false },
            current with { Lifecycle = "published" },
            current with { DependencySha256 = DigestA }
        ];

        foreach (ArticleVaultCurrentArticleObservation drift in drifts)
        {
            var writer = new RecordingWriter();
            var executor = new ArticleVaultSyncPlanExecutor(
                new MemoryStore(bundle),
                new FixedObserver([drift]),
                writer,
                new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

            ArticleVaultExecutionRejectedException exception = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
                () => executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256));
            Assert.Equal("article_vault_current_observation_drift", exception.ReasonCode);
            Assert.Equal(0, writer.ExecutionCount);
        }
    }

    [Fact]
    public async Task Executor_StopsAtCancellationBoundaryWithoutStartingNextGroup()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var writer = new RecordingWriter();
        var executor = new ArticleVaultSyncPlanExecutor(
            new MemoryStore(bundle),
            new FixedObserver(CreateCurrent(bundle)),
            writer,
            new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

        ArticleVaultExecutionResult result = await executor.ExecuteAsync(
            bundle.PlanReference,
            bundle.PlanSha256,
            cancellation.Token);

        Assert.Equal(ArticleVaultExecutionOutcome.Cancelled, result.Outcome);
        Assert.Empty(result.Groups);
        Assert.Equal(0, writer.ExecutionCount);
    }

    [Fact]
    public async Task Executor_FailsClosedOnWriterReceiptTamper()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        var writer = new RecordingWriter { TamperOutbox = true };
        var executor = new ArticleVaultSyncPlanExecutor(
            new MemoryStore(bundle),
            new FixedObserver(CreateCurrent(bundle)),
            writer,
            new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

        ArticleVaultExecutionRejectedException exception = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256));

        Assert.Equal("article_vault_group_receipt_invalid", exception.ReasonCode);
    }

    [Theory]
    [InlineData(ReceiptMutation.MissingOutbox, "article_vault_operation_side_effect_receipt_missing")]
    [InlineData(ReceiptMutation.MissingAudit, "article_vault_operation_side_effect_receipt_missing")]
    [InlineData(ReceiptMutation.MalformedOutbox, "article_vault_operation_side_effect_receipt_missing")]
    [InlineData(ReceiptMutation.MalformedAudit, "article_vault_operation_side_effect_receipt_missing")]
    [InlineData(ReceiptMutation.ArticleDigestMismatch, "article_vault_writer_receipt_mismatch")]
    [InlineData(ReceiptMutation.AfterRevisionMismatch, "article_vault_writer_receipt_mismatch")]
    [InlineData(ReceiptMutation.SiteMismatch, "article_vault_group_receipt_invalid")]
    [InlineData(ReceiptMutation.VaultMismatch, "article_vault_group_receipt_invalid")]
    [InlineData(ReceiptMutation.MembershipMismatch, "article_vault_group_receipt_invalid")]
    public async Task Executor_FailsClosedOnResealedReceiptMismatch(
        ReceiptMutation mutation,
        string expectedReason)
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        var executor = new ArticleVaultSyncPlanExecutor(
            new MemoryStore(bundle),
            new FixedObserver(CreateCurrent(bundle)),
            new RecordingWriter { Mutation = mutation },
            new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

        ArticleVaultExecutionRejectedException exception = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256));

        Assert.Equal(expectedReason, exception.ReasonCode);
    }

    [Fact]
    public async Task Executor_RejectsDuplicateOutboxAndAuditReferencesAcrossGroup()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle(itemCount: 2);
        var executor = new ArticleVaultSyncPlanExecutor(
            new MemoryStore(bundle),
            new FixedObserver(CreateCurrent(bundle)),
            new RecordingWriter { Mutation = ReceiptMutation.DuplicateSideEffects },
            new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

        ArticleVaultExecutionRejectedException exception = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256));

        Assert.Equal("article_vault_operation_side_effect_receipt_duplicate", exception.ReasonCode);
    }

    [Fact]
    public async Task Executor_PersistsCancelledTerminalWhenCancellationOccursInsideWriter()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        using var cancellation = new CancellationTokenSource();
        var writer = new RecordingWriter
        {
            BeforeExecute = () => cancellation.Cancel(),
            ThrowCancellation = true
        };
        var store = new MemoryStore(bundle);
        var executor = new ArticleVaultSyncPlanExecutor(
            store,
            new FixedObserver(CreateCurrent(bundle)),
            writer,
            new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

        ArticleVaultExecutionResult result = await executor.ExecuteAsync(
            bundle.PlanReference,
            bundle.PlanSha256,
            cancellation.Token);

        Assert.Equal(ArticleVaultExecutionOutcome.Cancelled, result.Outcome);
        Assert.Empty(result.Groups);
        Assert.Equal(1, store.SaveCount);
    }

    [Fact]
    public async Task Executor_PersistsCancelledTerminalWhenCancellationOccursDuringObservation()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        using var cancellation = new CancellationTokenSource();
        var observer = new CallbackObserver(
            CreateCurrent(bundle),
            cancellation.Cancel,
            throwCancellation: true);
        var writer = new RecordingWriter();
        var store = new MemoryStore(bundle);
        var executor = new ArticleVaultSyncPlanExecutor(
            store,
            observer,
            writer,
            new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

        ArticleVaultExecutionResult result = await executor.ExecuteAsync(
            bundle.PlanReference,
            bundle.PlanSha256,
            cancellation.Token);

        Assert.Equal(ArticleVaultExecutionOutcome.Cancelled, result.Outcome);
        Assert.Empty(result.Groups);
        Assert.Equal(0, writer.ExecutionCount);
        Assert.Equal(1, store.SaveCount);
    }

    [Fact]
    public async Task Executor_StopsWhenPlanExpiresAfterObservationBeforeWriter()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        var timeProvider = new MutableTimeProvider(bundle.Plan.CreatedAtUnixMs + 1);
        var observer = new CallbackObserver(
            CreateCurrent(bundle),
            () => timeProvider.UnixMs = bundle.Plan.ExpiresAtUnixMs + 1);
        var writer = new RecordingWriter();
        var executor = new ArticleVaultSyncPlanExecutor(
            new MemoryStore(bundle),
            observer,
            writer,
            timeProvider);

        ArticleVaultExecutionResult result = await executor.ExecuteAsync(
            bundle.PlanReference,
            bundle.PlanSha256);

        Assert.Equal(ArticleVaultExecutionOutcome.Failed, result.Outcome);
        Assert.Equal("article_vault_plan_expired", result.ReasonCode);
        Assert.Equal(0, writer.ExecutionCount);
    }

    [Fact]
    public async Task Executor_RejectsExpiredPlanBeforeObservationOrWriter()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        var observer = new FixedObserver(CreateCurrent(bundle));
        var writer = new RecordingWriter();
        var executor = new ArticleVaultSyncPlanExecutor(
            new MemoryStore(bundle),
            observer,
            writer,
            new FixedTimeProvider(bundle.Plan.ExpiresAtUnixMs + 1));

        ArticleVaultExecutionResult result = await executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256);

        Assert.Equal(ArticleVaultExecutionOutcome.Failed, result.Outcome);
        Assert.Equal("article_vault_plan_expired", result.ReasonCode);
        Assert.Equal(0, observer.ObservationCount);
        Assert.Equal(0, writer.ExecutionCount);
    }

    [Fact]
    public async Task Executor_RecoversCommittedGroupAfterTerminalWriteFailureWithoutRepeatingWriter()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        var store = new MemoryStore(bundle) { FailNextResultSave = true };
        var writer = new RecordingWriter
        {
            OnReceipt = receipt => store.GroupResult = receipt
        };
        var executor = new ArticleVaultSyncPlanExecutor(
            store,
            new FixedObserver(CreateCurrent(bundle)),
            writer,
            new FixedTimeProvider(bundle.Plan.CreatedAtUnixMs + 1));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => executor.ExecuteAsync(bundle.PlanReference, bundle.PlanSha256));
        ArticleVaultExecutionResult recovered = await executor.ExecuteAsync(
            bundle.PlanReference,
            bundle.PlanSha256);

        Assert.Equal(ArticleVaultExecutionOutcome.Completed, recovered.Outcome);
        Assert.Equal(1, writer.ExecutionCount);
        Assert.Equal(2, store.SaveCount);
    }

    [Fact]
    public async Task TerminalResultEquivalence_IgnoresOnlyCompletionTimestamp()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        ArticleVaultGroupResultReceipt group = await new RecordingWriter().ExecuteGroupAsync(
            bundle,
            Assert.Single(bundle.Plan.Groups),
            CreateCurrent(bundle));
        ArticleVaultExecutionResult first = SealResult(bundle, [group], bundle.Plan.CreatedAtUnixMs + 10);
        ArticleVaultExecutionResult later = SealResult(bundle, [group], bundle.Plan.CreatedAtUnixMs + 20);
        ArticleVaultExecutionResult conflicting = later with
        {
            ReasonCode = "conflicting"
        };
        conflicting = conflicting with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(conflicting)
        };

        Assert.True(ArticleVaultExecutionIntegrity.AreTerminalResultsEquivalent(first, later));
        Assert.False(ArticleVaultExecutionIntegrity.AreTerminalResultsEquivalent(first, conflicting));
    }

    [Fact]
    public void Payload_CannotCarryLifecycleRightsOwnerPathOrImportFallback()
    {
        string[] propertyNames = typeof(ArticleVaultExecutionPayloadItem).GetProperties()
            .Select(static property => property.Name)
            .ToArray();

        Assert.DoesNotContain(propertyNames, static name =>
            name.Contains("Status", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Lifecycle", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Publish", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Rights", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Owner", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Path", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Import", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Bundle_RejectsPayloadMembershipAndActualSourceByteMismatch()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        ArticleVaultExecutionPayloadItem payloadItem = Assert.Single(bundle.Payload.Items);

        ArticleVaultSealedExecutionBundle missingPayload = ResealPayload(bundle, []);
        ArticleVaultExecutionRejectedException membership = Assert.Throws<ArticleVaultExecutionRejectedException>(
            () => ArticleVaultExecutionIntegrity.ValidateBundle(missingPayload));
        Assert.Equal("article_vault_execution_payload_membership_mismatch", membership.ReasonCode);

        ArticleVaultExecutionPayloadItem alteredBytes = ResealPayloadItem(payloadItem with
        {
            Content = "different content\n"
        });
        ArticleVaultSealedExecutionBundle changedSource = ResealPayload(bundle, [alteredBytes]);
        ArticleVaultExecutionRejectedException source = Assert.Throws<ArticleVaultExecutionRejectedException>(
            () => ArticleVaultExecutionIntegrity.ValidateBundle(changedSource));
        Assert.Equal("article_vault_execution_payload_binding_invalid", source.ReasonCode);
    }

    [Fact]
    public void GroupIdempotency_IsBoundToSiteVaultPlanGroupAndOperations()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        VaultSyncPlanGroup group = Assert.Single(bundle.Plan.Groups);
        string baseline = ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(bundle.Plan, group);

        Assert.NotEqual(
            baseline,
            ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(
                bundle.Plan with
                {
                    SiteIdentity = "site-secondary"
                },
                group));
        Assert.NotEqual(
            baseline,
            ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(
                bundle.Plan with
                {
                    VaultIdentity = "vault-secondary"
                },
                group));
        Assert.NotEqual(
            baseline,
            ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(
                bundle.Plan,
                group with
                {
                    GroupIdentity = "group-secondary"
                }));
        Assert.NotEqual(
            baseline,
            ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(
                bundle.Plan,
                group with
                {
                    Items = [group.Items[0] with { OperationIdentity = "operation-secondary" }]
                }));
    }

    [Fact]
    public async Task ResultVerifier_RejectsResealedMembershipAndWriterReferenceTamper()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        ArticleVaultGroupResultReceipt group = await new RecordingWriter().ExecuteGroupAsync(
            bundle,
            Assert.Single(bundle.Plan.Groups),
            CreateCurrent(bundle));
        ArticleVaultExecutionResult missingGroup = SealResult(
            bundle,
            [],
            bundle.Plan.CreatedAtUnixMs + 10);
        ArticleVaultExecutionRejectedException membership = Assert.Throws<ArticleVaultExecutionRejectedException>(
            () => ArticleVaultExecutionIntegrity.VerifyResult(bundle, missingGroup));
        Assert.Equal("article_vault_execution_result_membership_mismatch", membership.ReasonCode);

        ArticleVaultOperationResultReceipt operation = Assert.Single(group.Operations);
        ArticleVaultOperationResultReceipt alteredOperation = ResealOperation(operation with
        {
            WriterReference = "article-service:42:999"
        });
        ArticleVaultGroupResultReceipt alteredGroup = ResealGroup(group with
        {
            Operations = [alteredOperation]
        });
        ArticleVaultExecutionResult alteredResult = SealResult(
            bundle,
            [alteredGroup],
            bundle.Plan.CreatedAtUnixMs + 10);
        ArticleVaultExecutionRejectedException writer = Assert.Throws<ArticleVaultExecutionRejectedException>(
            () => ArticleVaultExecutionIntegrity.VerifyResult(bundle, alteredResult));
        Assert.Equal("article_vault_writer_receipt_mismatch", writer.ReasonCode);

        ArticleVaultExecutionResult beforePlanCreation = SealResult(
            bundle,
            [group],
            bundle.Plan.CreatedAtUnixMs - 1);
        ArticleVaultExecutionRejectedException timestamp = Assert.Throws<ArticleVaultExecutionRejectedException>(
            () => ArticleVaultExecutionIntegrity.VerifyResult(bundle, beforePlanCreation));
        Assert.Equal("article_vault_execution_result_invalid", timestamp.ReasonCode);
    }

    [Fact]
    public async Task GroupVerifier_RejectsExecutedOperationInFailedAttemptLedger()
    {
        ArticleVaultSealedExecutionBundle bundle = CreateBundle();
        VaultSyncPlanGroup planned = Assert.Single(bundle.Plan.Groups);
        ArticleVaultGroupResultReceipt committed = await new RecordingWriter().ExecuteGroupAsync(
            bundle,
            planned,
            CreateCurrent(bundle));
        ArticleVaultGroupResultReceipt failedAttempt = ResealGroup(committed with
        {
            Committed = false,
            ReasonCode = "article_vault_group_write_failed"
        });

        ArticleVaultExecutionRejectedException exception = Assert.Throws<ArticleVaultExecutionRejectedException>(
            () => ArticleVaultExecutionIntegrity.VerifyGroupReceipt(bundle, planned, failedAttempt));

        Assert.Equal("article_vault_group_partial_result", exception.ReasonCode);
    }

    [Fact]
    public void ExecutionSource_HasNoFilesystemWatcherImportOrDirectArticleMutationSidePath()
    {
        string executionRoot = Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src",
            "backend",
            "Services",
            "ArticleVault");
        string executorSource = File.ReadAllText(Path.Combine(executionRoot, "ArticleVaultSyncPlanExecutor.cs"));
        string writerSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Services",
            "ArticleService.ArticleVaultWriter.cs"));
        string transactionSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Services",
            "ArticleService.ArticleVaultTransaction.cs"));
        string mutationSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Services",
            "ArticleService.Mutations.cs"));
        string lifecycleSource = File.ReadAllText(BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Services",
            "ArticleService.LifecycleAndReadModels.cs"));
        string combined = string.Join('\n', Directory.GetFiles(executionRoot, "*.cs").Select(File.ReadAllText));

        Assert.DoesNotContain("System.IO", combined, StringComparison.Ordinal);
        Assert.DoesNotContain("File.", combined, StringComparison.Ordinal);
        Assert.DoesNotContain("Directory.", combined, StringComparison.Ordinal);
        Assert.DoesNotContain("Watcher", combined, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Import", combined, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("VaultPathProjection", executorSource, StringComparison.Ordinal);
        Assert.DoesNotContain("INSERT INTO article", writerSource, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("UPDATE article SET", writerSource, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("CreateMutationAsync", writerSource, StringComparison.Ordinal);
        Assert.Contains("UpdateAsync", writerSource, StringComparison.Ordinal);
        Assert.Contains("DeleteAsync", writerSource, StringComparison.Ordinal);
        Assert.Contains("_articleVaultPublicFenceScopes", transactionSource, StringComparison.Ordinal);
        Assert.Contains("ExecuteForegroundWriteAsync", writerSource, StringComparison.Ordinal);
        Assert.Contains("article-vault-write", writerSource, StringComparison.Ordinal);
        Assert.Contains("DbWorkloadClass.ForegroundWrite", transactionSource, StringComparison.Ordinal);
        Assert.Contains("article-publication-write", transactionSource, StringComparison.Ordinal);
        Assert.Contains("RecoverArticleVaultPublicMutationFencesAsync", writerSource, StringComparison.Ordinal);
        Assert.Contains("EstablishArticlePublicMutationFenceAsync(id, ct)", mutationSource, StringComparison.Ordinal);
        Assert.Contains("EstablishArticlePublicMutationFenceAsync(id, ct)", lifecycleSource, StringComparison.Ordinal);
        Assert.DoesNotContain("requiresPublicFence && !IsArticleVaultGroupTransaction", mutationSource, StringComparison.Ordinal);
    }

    private static ArticleVaultSealedExecutionBundle CreateBundle(int itemCount = 1)
    {
        VaultArticleCoordinate server = Seal(new VaultArticleCoordinate(
            ArticleVaultSchemas.Coordinate,
            ArticleVaultSchemas.Version,
            Present: true,
            Deleted: false,
            ServerRevision: 4,
            Source: new VaultSourceByteIdentity(DigestA, 8, false, VaultNewlineStyle.Lf, 0, true),
            MetadataManifestSha256: DigestB,
            DependencySha256: DigestC,
            Lifecycle: "draft",
            PermissionSha256: DigestC,
            ContentSha256: string.Empty));
        VaultArticleCoordinate local = Seal(server with
        {
            Source = ArticleVaultManifestCodec.CaptureSourceBytes(
                System.Text.Encoding.UTF8.GetBytes("content\n"))
        });
        ArticleVaultArticleManifest[] articles = Enumerable.Range(0, itemCount)
            .Select(index =>
            {
                string portableIdentity = $"portable-article-{index}";
                string path = $"articles/{index}.md";
                return Seal(new ArticleVaultArticleManifest(
                    ArticleVaultSchemas.ArticleManifest,
                    ArticleVaultSchemas.Version,
                    "site-primary",
                    "vault-primary",
                    "device-primary",
                    portableIdentity,
                    (42 + index).ToString("D3", System.Globalization.CultureInfo.InvariantCulture),
                    new VaultPathProjection(path, ArticleVaultManifestCodec.ComputeProjectionSha256(path)),
                    new VaultArticleCoordinates(server, local, server),
                    new VaultOperationWatermarks(0, null, null, null, null, null, null),
                    VaultArticleState.LocalModified,
                    string.Empty));
            })
            .ToArray();
        ArticleVaultServerObservation[] observations = articles.Select(article => Seal(new ArticleVaultServerObservation(
            ArticleVaultPlanSchemas.ServerObservation,
            ArticleVaultPlanSchemas.Version,
            article.SiteIdentity,
            article.VaultIdentity,
            article.DeviceIdentity,
            article.PortableArticleIdentity,
            article.ServerArticleIdentity,
            server,
            string.Empty))).ToArray();
        ArticleVaultRootManifest root = SealRoot(articles);
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(new ArticleVaultPlanRequest(
            root,
            articles,
            observations,
            [new VaultPlanGroupRequest(
                "group-primary",
                articles.Select(static article => article.PortableArticleIdentity).ToArray(),
                [])],
            VaultSyncDirection.Sync,
            1_800_000_000_000,
            1_800_000_060_000,
            CancellationRequested: false));
        Assert.True(built.IsSuccess, string.Join(",", built.Errors));
        ArticleVaultSyncPlan plan = Assert.IsType<ArticleVaultSyncPlan>(built.Plan);
        VaultSyncPlanItem[] operations = Assert.Single(plan.Groups).Items.ToArray();
        Assert.All(operations, static operation => Assert.Equal(VaultSyncDecision.PushUpdate, operation.Decision));
        ArticleVaultExecutionPayloadItem[] payloadItems = operations.Select(operation =>
        {
            var unsigned = new ArticleVaultExecutionPayloadItem(
                operation.OperationIdentity,
                operation.PortableArticleIdentity,
                operation.ServerArticleIdentity,
                $"Updated {operation.PortableArticleIdentity}",
                "content\n",
                "summary",
                null,
                1,
                [1],
                operation.Local.Source!.Sha256,
                operation.Local.MetadataManifestSha256!,
                string.Empty);
            return unsigned with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealPayloadItem(unsigned)
            };
        }).ToArray();
        var payload = new ArticleVaultExecutionPayload(
            ArticleVaultExecutionSchemas.Payload,
            ArticleVaultExecutionSchemas.Version,
            payloadItems,
            string.Empty);
        payload = payload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(payload)
        };
        var bundle = new ArticleVaultSealedExecutionBundle(
            ArticleVaultExecutionSchemas.Bundle,
            ArticleVaultExecutionSchemas.Version,
            plan.PlanCandidateIdentity,
            plan.ContentSha256,
            7,
            plan,
            root,
            articles,
            observations,
            payload,
            string.Empty);
        return bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
    }

    private static IReadOnlyList<ArticleVaultCurrentArticleObservation> CreateCurrent(
        ArticleVaultSealedExecutionBundle bundle)
    {
        return Assert.Single(bundle.Plan.Groups).Items.Select(item =>
            new ArticleVaultCurrentArticleObservation(
                item.PortableArticleIdentity,
                item.ServerArticleIdentity,
                item.Preconditions.ExpectedServerRevision,
                item.Preconditions.ExpectedLifecycle,
                Permitted: true,
                item.Preconditions.ExpectedPermissionSha256!,
                item.Server.DependencySha256!,
                DigestA,
                DigestB,
                item.Server.Source?.Sha256,
                item.Preconditions.ServerObservationSha256))
            .ToArray();
    }

    private static VaultArticleCoordinate Seal(VaultArticleCoordinate coordinate)
    {
        VaultArticleCoordinate unsigned = coordinate with
        {
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsigned)
        };
    }

    private static ArticleVaultExecutionPayloadItem ResealPayloadItem(
        ArticleVaultExecutionPayloadItem item)
    {
        ArticleVaultExecutionPayloadItem unsigned = item with
        {
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayloadItem(unsigned)
        };
    }

    private static ArticleVaultSealedExecutionBundle ResealPayload(
        ArticleVaultSealedExecutionBundle bundle,
        IReadOnlyList<ArticleVaultExecutionPayloadItem> items)
    {
        ArticleVaultExecutionPayload unsignedPayload = bundle.Payload with
        {
            Items = items,
            ContentSha256 = string.Empty
        };
        ArticleVaultExecutionPayload payload = unsignedPayload with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealPayload(unsignedPayload)
        };
        ArticleVaultSealedExecutionBundle unsignedBundle = bundle with
        {
            Payload = payload,
            ContentSha256 = string.Empty
        };
        return unsignedBundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(unsignedBundle)
        };
    }

    private static ArticleVaultOperationResultReceipt ResealOperation(
        ArticleVaultOperationResultReceipt operation)
    {
        ArticleVaultOperationResultReceipt unsigned = operation with
        {
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(unsigned)
        };
    }

    private static ArticleVaultGroupResultReceipt ResealGroup(ArticleVaultGroupResultReceipt group)
    {
        ArticleVaultGroupResultReceipt unsigned = group with
        {
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealGroupReceipt(unsigned)
        };
    }

    private static ArticleVaultArticleManifest Seal(ArticleVaultArticleManifest article)
    {
        ArticleVaultArticleManifest unsigned = article with
        {
            State = ArticleVaultStateMachine.Derive(article),
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsigned)
        };
    }

    private static ArticleVaultServerObservation Seal(ArticleVaultServerObservation observation)
    {
        ArticleVaultServerObservation unsigned = observation with
        {
            ContentSha256 = string.Empty
        };
        return unsigned with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(unsigned)
        };
    }

    private static ArticleVaultRootManifest SealRoot(IReadOnlyList<ArticleVaultArticleManifest> articles)
    {
        ArticleVaultArticleManifest first = articles[0];
        var unsigned = new ArticleVaultRootManifest(
            ArticleVaultSchemas.RootManifest,
            ArticleVaultSchemas.Version,
            ArticleVaultSchemas.ControlTreeVersion,
            new VaultControlTree(
                ArticleVaultSchemas.RootManifestPath,
                ArticleVaultSchemas.ArticleManifestDirectory,
                ArticleVaultSchemas.ReceiptDirectory),
            first.SiteIdentity,
            first.VaultIdentity,
            first.DeviceIdentity,
            articles.Select(article => new VaultArticleReference(
                article.PortableArticleIdentity,
                $"{ArticleVaultSchemas.ArticleManifestDirectory}/{article.PortableArticleIdentity}.json",
                article.ContentSha256,
                article.PathProjection.RelativePath)).ToArray(),
            [],
            string.Empty);
        return unsigned with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(unsigned)
        };
    }

    private sealed class FixedObserver(IReadOnlyList<ArticleVaultCurrentArticleObservation> observations)
        : IArticleVaultCurrentObservationAuthority
    {
        public int ObservationCount
        {
            get; private set;
        }

        public Task<IReadOnlyList<ArticleVaultCurrentArticleObservation>> ObserveGroupAsync(
            ArticleVaultSealedExecutionBundle bundle,
            VaultSyncPlanGroup group,
            CancellationToken cancellationToken = default)
        {
            ObservationCount++;
            return Task.FromResult(observations);
        }
    }

    private sealed class CallbackObserver(
        IReadOnlyList<ArticleVaultCurrentArticleObservation> observations,
        Action callback,
        bool throwCancellation = false) : IArticleVaultCurrentObservationAuthority
    {
        public Task<IReadOnlyList<ArticleVaultCurrentArticleObservation>> ObserveGroupAsync(
            ArticleVaultSealedExecutionBundle bundle,
            VaultSyncPlanGroup group,
            CancellationToken cancellationToken = default)
        {
            callback();
            if (throwCancellation)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            return Task.FromResult(observations);
        }
    }

    private sealed class RecordingWriter : IArticleVaultCanonicalGroupWriter
    {
        public int ExecutionCount
        {
            get; private set;
        }

        public bool TamperOutbox
        {
            get; init;
        }

        public ReceiptMutation Mutation
        {
            get; init;
        }

        public Action? BeforeExecute
        {
            get; init;
        }

        public bool ThrowCancellation
        {
            get; init;
        }

        public Action<ArticleVaultGroupResultReceipt>? OnReceipt
        {
            get; init;
        }

        public Task<ArticleVaultGroupResultReceipt> ExecuteGroupAsync(
            ArticleVaultSealedExecutionBundle bundle,
            VaultSyncPlanGroup group,
            IReadOnlyList<ArticleVaultCurrentArticleObservation> expectedCurrent,
            CancellationToken cancellationToken = default)
        {
            ExecutionCount++;
            BeforeExecute?.Invoke();
            if (ThrowCancellation)
            {
                throw new OperationCanceledException(cancellationToken);
            }
            string idempotency = ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(bundle.Plan, group);
            var operations = new List<ArticleVaultOperationResultReceipt>(group.Items.Count);
            for (int index = 0; index < group.Items.Count; index++)
            {
                VaultSyncPlanItem item = group.Items[index];
                int articleId = int.Parse(item.ServerArticleIdentity!, System.Globalization.CultureInfo.InvariantCulture);
                string[] dependencyOutcomes = item.DependsOnOperationIdentities.Select(dependency =>
                {
                    ArticleVaultOperationResultReceipt receipt = operations.Single(
                        candidate => candidate.OperationIdentity == dependency);
                    return ArticleVaultExecutionIntegrity.ComputeDependencyOutcome(
                        receipt.OperationIdentity,
                        receipt.Outcome,
                        receipt.ContentSha256);
                }).ToArray();
                var unsignedOperation = new ArticleVaultOperationResultReceipt(
                    ArticleVaultExecutionSchemas.OperationReceipt,
                    ArticleVaultExecutionSchemas.Version,
                    bundle.Plan.SiteIdentity,
                    bundle.Plan.VaultIdentity,
                    bundle.PlanSha256,
                    group.GroupIdentity,
                    item.OperationIdentity,
                    item.PortableArticleIdentity,
                    item.Decision,
                    ArticleVaultOperationOutcome.Executed,
                    articleId,
                    item.Preconditions.ExpectedServerRevision,
                    item.Preconditions.ExpectedServerRevision + 1,
                    $"article-service:{articleId}:5",
                    Guid.NewGuid().ToString("N"),
                    ArticleVaultExecutionIntegrity.Digest(new
                    {
                        Receipt = "audit",
                        index
                    }),
                    item.DependsOnOperationIdentities,
                    dependencyOutcomes,
                    idempotency,
                    bundle.Payload.Items.Single(payload => payload.OperationIdentity == item.OperationIdentity).SourceSha256,
                    null,
                    string.Empty);
                operations.Add(unsignedOperation with
                {
                    ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(unsignedOperation)
                });
            }

            operations = ApplyMutation(operations);
            var unsignedGroup = new ArticleVaultGroupResultReceipt(
                ArticleVaultExecutionSchemas.GroupReceipt,
                ArticleVaultExecutionSchemas.Version,
                Mutation == ReceiptMutation.SiteMismatch ? "site-other" : bundle.Plan.SiteIdentity,
                Mutation == ReceiptMutation.VaultMismatch ? "vault-other" : bundle.Plan.VaultIdentity,
                bundle.PlanSha256,
                group.GroupIdentity,
                idempotency,
                Committed: true,
                Mutation == ReceiptMutation.MembershipMismatch ? [] : operations,
                null,
                string.Empty);
            ArticleVaultGroupResultReceipt receipt = unsignedGroup with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealGroupReceipt(unsignedGroup)
            };
            if (TamperOutbox)
            {
                receipt = receipt with
                {
                    Operations = [.. receipt.Operations.Select(operation => operation with
                    {
                        OutboxReference = "tampered"
                    })]
                };
            }
            OnReceipt?.Invoke(receipt);
            return Task.FromResult(receipt);
        }

        private List<ArticleVaultOperationResultReceipt> ApplyMutation(
            List<ArticleVaultOperationResultReceipt> operations)
        {
            if (Mutation == ReceiptMutation.DuplicateSideEffects && operations.Count > 1)
            {
                operations[1] = Reseal(operations[1] with
                {
                    OutboxReference = operations[0].OutboxReference,
                    AuditReference = operations[0].AuditReference
                });
            }
            if (operations.Count == 0)
            {
                return operations;
            }

            operations[0] = Mutation switch
            {
                ReceiptMutation.MissingOutbox => Reseal(operations[0] with { OutboxReference = null }),
                ReceiptMutation.MissingAudit => Reseal(operations[0] with { AuditReference = null }),
                ReceiptMutation.MalformedOutbox => Reseal(operations[0] with { OutboxReference = "not-a-guid" }),
                ReceiptMutation.MalformedAudit => Reseal(operations[0] with { AuditReference = "not-a-digest" }),
                ReceiptMutation.ArticleDigestMismatch => Reseal(operations[0] with { ArticleContentSha256 = DigestC }),
                ReceiptMutation.AfterRevisionMismatch => Reseal(operations[0] with
                {
                    AfterRevision = operations[0].BeforeRevision
                }),
                _ => operations[0]
            };
            return operations;
        }

        private static ArticleVaultOperationResultReceipt Reseal(ArticleVaultOperationResultReceipt operation)
        {
            ArticleVaultOperationResultReceipt unsigned = operation with
            {
                ContentSha256 = string.Empty
            };
            return unsigned with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(unsigned)
            };
        }
    }

    private sealed class MemoryStore(ArticleVaultSealedExecutionBundle bundle) : IArticleVaultExecutionStore
    {
        private ArticleVaultExecutionResult? _result;

        public int SaveCount
        {
            get; private set;
        }

        public bool FailNextResultSave
        {
            get; set;
        }

        public ArticleVaultGroupResultReceipt? GroupResult
        {
            get; set;
        }

        public Task SealAsync(ArticleVaultSealedExecutionBundle value, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<ArticleVaultSealedExecutionBundle?> LoadSealedAsync(
            string planReference,
            string planSha256,
            CancellationToken cancellationToken = default)
            => Task.FromResult<ArticleVaultSealedExecutionBundle?>(
                planReference == bundle.PlanReference && planSha256 == bundle.PlanSha256 ? bundle : null);

        public Task<ArticleVaultGroupResultReceipt?> LoadGroupResultAsync(
            string siteIdentity,
            string vaultIdentity,
            string planSha256,
            string groupIdentity,
            string idempotencySha256,
            CancellationToken cancellationToken = default)
            => Task.FromResult(GroupResult);

        public Task<ArticleVaultExecutionResult?> LoadResultAsync(
            string resultReference,
            CancellationToken cancellationToken = default)
            => Task.FromResult(_result);

        public Task SaveResultAsync(
            ArticleVaultExecutionResult result,
            CancellationToken cancellationToken = default)
        {
            SaveCount++;
            if (FailNextResultSave)
            {
                FailNextResultSave = false;
                throw new InvalidOperationException("simulated terminal write failure");
            }
            _result ??= result;
            return Task.CompletedTask;
        }
    }

    private static ArticleVaultExecutionResult SealResult(
        ArticleVaultSealedExecutionBundle bundle,
        IReadOnlyList<ArticleVaultGroupResultReceipt> groups,
        long completedAtUnixMs)
    {
        var unsigned = new ArticleVaultExecutionResult(
            ArticleVaultExecutionSchemas.Result,
            ArticleVaultExecutionSchemas.Version,
            bundle.Plan.ResultCandidateIdentity,
            bundle.Plan.SiteIdentity,
            bundle.Plan.VaultIdentity,
            bundle.PlanReference,
            bundle.PlanSha256,
            bundle.Plan.IdempotencyKey,
            ArticleVaultExecutionOutcome.Completed,
            groups,
            null,
            completedAtUnixMs,
            string.Empty);
        return unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealResult(unsigned)
        };
    }

    public enum ReceiptMutation
    {
        None,
        MissingOutbox,
        MissingAudit,
        MalformedOutbox,
        MalformedAudit,
        DuplicateSideEffects,
        ArticleDigestMismatch,
        AfterRevisionMismatch,
        SiteMismatch,
        VaultMismatch,
        MembershipMismatch
    }

    private sealed class FixedTimeProvider(long unixMs) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow()
            => DateTimeOffset.FromUnixTimeMilliseconds(unixMs);
    }

    private sealed class MutableTimeProvider(long unixMs) : TimeProvider
    {
        public long UnixMs { get; set; } = unixMs;

        public override DateTimeOffset GetUtcNow()
            => DateTimeOffset.FromUnixTimeMilliseconds(UnixMs);
    }
}
