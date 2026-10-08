using System.Collections.Immutable;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.PrivateAssets;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Controlled lifecycle adapter tests, not format/sandbox qualification. The
/// stub verifier is deliberately explicit; no fixture receipt is published as
/// actual tool execution or physical cleanup evidence.
/// </summary>
[Trait("Platform", "Unix")]
public sealed class DocumentExportJobServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"fsusblog-job-tests-{Guid.NewGuid():N}");
    private readonly Microsoft.AspNetCore.DataProtection.EphemeralDataProtectionProvider _protection = new();
    private readonly TestAuthorization _authorization = new();
    private readonly TestTimeProvider _time = new();
    private readonly ReleaseStorageLayout _layout;
    private readonly DocumentExportJobActor _actor = new(7, "https://example.test", "authenticated-session");

    public DocumentExportJobServiceTests()
    {
        _layout = new ReleaseStorageLayout(Path.Combine(_root, "shared"), Path.Combine(_root, "derived"),
            Path.Combine(_root, "assets"), Path.Combine(_root, "instances"), "20261008060000-0123456789ab",
            "blue", "job-tests", Path.Combine(_root, "webroot"));
        Directory.CreateDirectory(_layout.Paths.PrivateAssetRoot);
        Directory.CreateDirectory(_layout.Paths.UploadCommitRoot);
    }

    [Theory]
    [InlineData("self-contained-html")]
    [InlineData("pdf")]
    [InlineData("docx")]
    [InlineData("epub")]
    public async Task Create_PersistsCanonicalFrozenIdentityAcrossRestartForEveryFormat(string format)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request(format);
        DocumentExportJobSnapshot created = await Service().CreateAsync(_actor, task, input, default);
        DocumentExportJobSnapshot restarted = await Service().GetAsync(_actor, task.TaskId, default);

        Assert.Equal(created.Task, restarted.Task);
        Assert.Equal(input.ContentDigest, restarted.Task.InputDigest);
        Assert.Equal(DocumentExportTaskStatus.Queued, restarted.Task.Status);
        Assert.Equal(DocumentExportJobPolicy.JobTtl, restarted.ExpiresAt - restarted.CreatedAt);
        Assert.Single(await Service().ListAsync(_actor, default));
        byte[] encrypted = File.ReadAllBytes(StatePath);
        Assert.DoesNotContain("private-frozen-source", Encoding.UTF8.GetString(encrypted));
    }

    [Theory]
    [InlineData("user")]
    [InlineData("site")]
    [InlineData("permission")]
    [InlineData("status")]
    public async Task Create_RejectsWithoutCreatingJobStorage(string mutation)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        DocumentExportJobActor actor = mutation switch
        {
            "user" => _actor with { UserId = 8 },
            "site" => _actor with { SiteScope = "https://other.example.test" },
            _ => _actor
        };
        _authorization.Allowed = mutation != "permission";
        if (mutation == "status")
        {
            task = DocumentExportContractValidator.Seal(task with
            {
                Status = DocumentExportTaskStatus.Running
            });
        }

        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().CreateAsync(actor, task, input, default));
        Assert.False(Directory.Exists(JobRoot));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" https://example.test")]
    [InlineData("https://example.test/")]
    [InlineData("https://example.test\n")]
    public async Task ActorScope_RejectsNonCanonicalIdentityBeforeStorageWrite(string? scope)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        DocumentExportJobActor actor = _actor with
        {
            SiteScope = scope!
        };
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().CreateAsync(actor, task, input, default));
        Assert.False(Directory.Exists(JobRoot));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Admission_RefusesPriorSharedSchemaBeforeStorageWrite(bool oldInput)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        if (oldInput)
        {
            input = DocumentExportContractValidator.Seal(input with
            {
                Schema = "fsusblog.document-export-frozen-input.v2"
            });
            task = DocumentExportContractTests.ValidTask(input);
        }
        else
        {
            task = DocumentExportContractValidator.Seal(task with
            {
                Schema = "fsusblog.document-export-task.v2"
            });
        }
        await Assert.ThrowsAsync<ArgumentException>(() => Service().CreateAsync(_actor, task, input, default));
        Assert.False(Directory.Exists(JobRoot));
    }

    [Fact]
    public async Task SiteScope_IsolatesIdempotencyCustodyOperationsAndSessionRevocation()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        DocumentExportJobActor other = _actor with
        {
            SiteScope = "https://other.example.test"
        };
        DocumentExportFrozenInput otherInput = DocumentExportContractValidator.Seal(input with
        {
            SiteScope = other.SiteScope
        });
        DocumentExportTask otherTask = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(otherInput) with
        {
            TaskId = "other-scope-task",
            IdempotencyKey = task.IdempotencyKey
        });
        await Service().CreateAsync(other, otherTask, otherInput, default);
        DocumentExportJobSnapshot first = await Service().ExecuteAsync(_actor, task.TaskId, new ControlledProvider(task.ProviderId), default);
        DocumentExportJobSnapshot second = await Service().ExecuteAsync(other, otherTask.TaskId, new ControlledProvider(otherTask.ProviderId), default);
        Assert.Equal(other.SiteScope, second.Output!.SiteScope);
        Assert.NotEqual(first.Output!.ObjectId, second.Output.ObjectId);
        Assert.Single(await Service().ListAsync(other, default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GetAsync(other, task.TaskId, default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().CancelAsync(other, task.TaskId, default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().RetryAsync(other, task.TaskId, default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().DeleteAsync(other, task.TaskId, default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(other, task.TaskId, default));
        DocumentExportDownloadGrant firstGrant = await Service().GrantAsync(_actor, task.TaskId, default);
        DocumentExportDownloadGrant secondGrant = await Service().GrantAsync(other, otherTask.TaskId, default);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().DownloadAsync(other, firstGrant.Token, false, default));
        await Service().RevokeSessionAsync(_actor, default);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().DownloadAsync(_actor, firstGrant.Token, false, default));
        Assert.Equal(ControlledProvider.Output, (await Service().DownloadAsync(other, secondGrant.Token, false, default)).Bytes);
        DocumentExportJobScopeUsage scope = Assert.Single((await Service().GetUsageAsync(default)).Scopes,
            row => row.SiteScope == other.SiteScope);
        Assert.Equal(1, scope.Jobs);
        Assert.Equal(1, scope.Outputs);
    }

    [Fact]
    public async Task Retry_RejectsForeignScopeAfterOriginalAuthorityProvesQuiescence()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        await Service().ExecuteAsync(_actor, task.TaskId, new ControlledProvider(task.ProviderId) { FailExport = true }, default);
        DocumentExportJobSnapshot failed = await Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(true), default);
        Assert.Equal(DocumentExportTaskStatus.Failed, failed.Task.Status);
        DocumentExportJobActor other = _actor with
        {
            SiteScope = "https://other.example.test"
        };
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().RetryAsync(other, task.TaskId, default));
        Assert.Equal(DocumentExportDigest.Serialize(failed),
            DocumentExportDigest.Serialize(await Service().GetAsync(_actor, task.TaskId, default)));
        Assert.Equal(DocumentExportTaskStatus.Queued, (await Service().RetryAsync(_actor, task.TaskId, default)).Task.Status);
    }

    [Theory]
    [InlineData("purpose-v1")]
    [InlineData("state-v1")]
    [InlineData("snapshot-v1")]
    [InlineData("output-v1")]
    [InlineData("numeric-task")]
    [InlineData("numeric-grant")]
    [InlineData("mixed-task")]
    [InlineData("mixed-grant")]
    public async Task LegacyNumericOrVersionedState_RefusesWithoutRewritingOrDeletingPrivateBytes(string mutation)
    {
        DocumentExportJobSnapshot completed = await SucceedAsync();
        DocumentExportDownloadGrant grant = await Service().GrantAsync(_actor, completed.Task.TaskId, default);
        var protector = _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
        byte[] original = File.ReadAllBytes(StatePath);
        byte[] plaintext = protector.Unprotect(original);
        JsonObject value = JsonNode.Parse(plaintext)!.AsObject();
        JsonObject job = value["jobs"]![0]!.AsObject();
        switch (mutation)
        {
            case "state-v1":
                value["schema"] = "fsusblog.document-export-job-state.v1";
                break;
            case "snapshot-v1":
                job["snapshot"]!["schema"] = "fsusblog.document-export-job.v1";
                break;
            case "output-v1":
                job["snapshot"]!["output"]!["schema"] = "fsusblog.document-export-output.v1";
                break;
            case "numeric-task":
                job["snapshot"]!["task"]!.AsObject().Remove("siteScope");
                job["snapshot"]!["task"]!["siteId"] = 11;
                break;
            case "numeric-grant":
                value["grants"]![0]!.AsObject().Remove("siteScope");
                value["grants"]![0]!["siteId"] = 11;
                break;
            case "mixed-task":
                job["snapshot"]!["task"]!["siteId"] = 11;
                break;
            case "mixed-grant":
                value["grants"]![0]!["siteId"] = 11;
                break;
        }
        byte[] altered = Encoding.UTF8.GetBytes(value.ToJsonString());
        if (mutation is "state-v1" or "snapshot-v1" or "output-v1")
        {
            DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(altered);
            if (mutation == "output-v1")
            {
                DocumentExportStoredJob row = state.Jobs[0];
                DocumentExportOutputRecord output = row.Snapshot.Output! with
                {
                    ContentDigest = string.Empty
                };
                state.Jobs[0] = row with
                {
                    Snapshot = row.Snapshot with
                    {
                        Output = output with
                        {
                            ContentDigest = DocumentExportDigest.Compute(output)
                        }
                    }
                };
            }
            state = state with
            {
                ContentDigest = string.Empty
            };
            altered = DocumentExportDigest.Serialize(state with
            {
                ContentDigest = DocumentExportDigest.Compute(state)
            });
        }
        byte[] candidate = mutation == "purpose-v1"
            ? _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v1").Protect(plaintext)
            : protector.Protect(altered);
        File.WriteAllBytes(StatePath, candidate);
        string lockPath = Path.Combine(JobRoot, "owner.lock");
        byte[] lockBytes = File.ReadAllBytes(lockPath);
        string objectPath = Assert.Single(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        byte[] bytes = File.ReadAllBytes(objectPath);
        await Assert.ThrowsAsync<InvalidDataException>(() => Service().GetAsync(_actor, completed.Task.TaskId, default));
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Assert.ThrowsAsync<InvalidDataException>(() => Service().CreateAsync(_actor, task, input, default));
        await Assert.ThrowsAsync<InvalidDataException>(() => Service().CleanupAsync(default));
        Assert.Equal(candidate, File.ReadAllBytes(StatePath));
        Assert.Equal(lockBytes, File.ReadAllBytes(lockPath));
        Assert.Equal(bytes, File.ReadAllBytes(objectPath));
        File.WriteAllBytes(StatePath, original);
        Assert.Equal(bytes, (await Service().DownloadAsync(_actor, grant.Token, false, default)).Bytes);
    }

    [Fact]
    public async Task Create_IdempotencyReturnsOriginalAndRejectsChangedFrozenInput()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        DocumentExportJobSnapshot original = await Service().CreateAsync(_actor, task, input, default);
        DocumentExportTask duplicate = DocumentExportContractValidator.Seal(task with
        {
            TaskId = "duplicate",
            RequestId = "duplicate-request"
        });
        Assert.Equal(original.Task.TaskId, (await Service().CreateAsync(_actor, duplicate, input, default)).Task.TaskId);

        DocumentExportFrozenInput different = DocumentExportContractTests.ValidInput("different frozen source");
        DocumentExportTask changed = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(different)
            with
        {
            TaskId = "other",
            IdempotencyKey = task.IdempotencyKey
        });
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().CreateAsync(_actor, changed, different, default));
        Assert.Single(await Service().ListAsync(_actor, default));
    }

    [Theory]
    [InlineData("pdf")]
    [InlineData("docx")]
    [InlineData("epub")]
    public async Task Execute_InactiveCanonicalProviderIsBlockedWithoutInvocation(string format)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request(format);
        await Service().CreateAsync(_actor, task, input, default);
        var provider = new ControlledProvider(task.ProviderId);
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(DocumentExportTaskStatus.Blocked, result.Task.Status);
        Assert.Equal(0, provider.Invocations);
        Assert.Null(result.Output);
    }

    [Fact]
    public async Task Execute_TwoInstancesClaimOnceAndReceiveExactFrozenBytes()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        var provider = new ControlledProvider(task.ProviderId) { PauseExport = true };
        Task<DocumentExportJobSnapshot> first = Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        await provider.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        DocumentExportJobSnapshot second = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(DocumentExportTaskStatus.Running, second.Task.Status);
        Assert.Equal(1, provider.Invocations);
        Assert.Equal(input.MarkdownUtf8.ToArray(), provider.ObservedInput!.MarkdownUtf8.ToArray());
        Assert.Equal(input.Coordinate, provider.ObservedInput.Coordinate);
        provider.Release.TrySetResult();
        DocumentExportJobSnapshot result = await first;
        Assert.Equal(DocumentExportTaskStatus.Succeeded, result.Task.Status);
        Assert.NotNull(result.Output);
        Assert.Equal(1, provider.Verifications);
    }

    [Fact]
    public async Task AttemptResources_CreatedOnceAfterClaimBindBothProviderPhases()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        var provider = new ControlledProvider(task.ProviderId)
        {
            OnCreateResources = () =>
            {
                var protector = _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
                DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(protector.Unprotect(File.ReadAllBytes(StatePath)));
                Assert.NotNull(state.Jobs[0].WorkerDigest);
                Assert.Equal(DocumentExportTaskStatus.Running, state.Jobs[0].Snapshot.Task.Status);
            }
        };
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(DocumentExportTaskStatus.Succeeded, result.Task.Status);
        DocumentExportAttemptResources resources = Assert.Single(provider.Resources);
        Assert.Same(resources, provider.ExportResources);
        Assert.Same(resources, provider.VerificationResources);
        Assert.Same(_time, provider.ResourceTime);
        Assert.Equal(DocumentExportTaskStatus.Running, provider.ResourceTask!.Status);
        Assert.Equal(input.ContentDigest, provider.ResourceInput!.ContentDigest);
        Assert.Equal(input.ContentDigest, provider.ObservedInput!.ContentDigest);
    }

    [Fact]
    public async Task AttemptResources_LegacyAdapterIsBlockedBeforeClaimOrInvocation()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        var provider = new LegacyProvider(task.ProviderId);
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(DocumentExportTaskStatus.Blocked, result.Task.Status);
        Assert.Equal("attempt_resource_adapter_unavailable", result.Reason);
        Assert.Empty(result.Attempts);
        Assert.Equal(0, provider.Invocations);
        Assert.Null(result.Output);
    }

    [Theory]
    [InlineData("incomplete", false)]
    [InlineData("active", false)]
    [InlineData("failed", false)]
    [InlineData("incomplete", true)]
    [InlineData("active", true)]
    [InlineData("failed", true)]
    public async Task AttemptResources_UnqualifiedCompletionCannotPublishOrReleaseClaim(string fault, bool cancel)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        using var caller = new CancellationTokenSource();
        var provider = new ControlledProvider(task.ProviderId)
        {
            ResourceFault = fault,
            OnVerify = () =>
            {
                if (cancel)
                {
                    caller.Cancel();
                }
            }
        };
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, caller.Token);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, result.Task.Status);
        Assert.Equal(DocumentExportTaskStatus.Failed, result.Attempts[0].Status);
        Assert.Null(result.Output);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        var protector = _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
        DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(protector.Unprotect(File.ReadAllBytes(StatePath)));
        Assert.NotNull(state.Jobs[0].WorkerDigest);
        Assert.NotNull(state.Jobs[0].Input);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, task.TaskId, default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(false), default));
        provider.HeldStage?.Dispose();
        DocumentExportJobSnapshot recovered = await Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(true), default);
        Assert.Equal(cancel ? DocumentExportTaskStatus.Cancelled : DocumentExportTaskStatus.Failed, recovered.Task.Status);
        Assert.Equal(result.Attempts[0], recovered.Attempts[0]);
    }

    [Fact]
    public async Task AttemptResources_DiagnosticRetryGetsFreshOwnerWithoutPhaseReset()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        int calls = 0;
        var provider = new ControlledProvider(task.ProviderId)
        {
            OnExport = () =>
            {
                if (++calls == 1)
                {
                    throw new IOException("controlled first attempt failure");
                }
            }
        };
        await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        await Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(true), default);
        await Service().RetryAsync(_actor, task.TaskId, default);
        DocumentExportJobSnapshot retry = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(2, provider.Resources.Count);
        Assert.NotSame(provider.Resources[0], provider.Resources[1]);
        Assert.Same(provider.Resources[1], provider.ExportResources);
        Assert.Same(provider.Resources[1], provider.VerificationResources);
        Assert.Equal("diagnostic_success_unqualified", retry.Reason);
        Assert.Null(retry.Output);
    }

    [Fact]
    public async Task AttemptResources_CumulativeCpuFailureRetainsClaimAndCannotPublish()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        long cpu = DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.CpuTime.Ticks / TimeSpan.TicksPerMicrosecond;
        var provider = new ControlledProvider(task.ProviderId)
        {
            ExportCpuMicroseconds = cpu * 2 / 3 + 1,
            VerificationCpuMicroseconds = cpu * 2 / 3 + 1
        };
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, result.Task.Status);
        Assert.Equal("sandbox_budget_failed", result.Attempts[0].Reason);
        Assert.Null(result.Output);
        Assert.Equal(1, provider.Verifications);
        Assert.Throws<InvalidDataException>(Assert.Single(provider.Resources).RequireCompleted);
    }

    [Fact]
    public async Task AttemptResources_CompletedForeignAttemptCannotPublishOrReleaseClaim()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        var provider = new ControlledProvider(task.ProviderId)
        {
            ResourceFault = "foreign"
        };
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, result.Task.Status);
        Assert.Equal("attempt_resources_unqualified", result.Attempts[0].Reason);
        Assert.Equal(DocumentExportTaskStatus.Failed, result.Attempts[0].Status);
        Assert.Null(result.Output);
        Assert.Equal(1, provider.Verifications);
        Assert.NotEqual(task.TaskId, provider.ResourceTask!.TaskId);
        var protector = _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
        DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(protector.Unprotect(File.ReadAllBytes(StatePath)));
        Assert.NotNull(state.Jobs[0].WorkerDigest);
        Assert.NotNull(state.Jobs[0].Input);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(false), default));
    }

    [Theory]
    [InlineData("none")]
    [InlineData("caller")]
    [InlineData("deadline")]
    public async Task AttemptResources_FinalStatePublicationRechecksCompletionBeforeUnlock(string interruption)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        var provider = new ControlledProvider(task.ProviderId);
        using var caller = new CancellationTokenSource();
        var sync = new FinalStateDeadlineSync(() =>
        {
            DocumentExportAttemptResources resources = Assert.Single(provider.Resources);
            Assert.Throws<InvalidOperationException>(() => resources.BeginStage(provider.ResourceTask!, provider.ResourceInput!,
                DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets, canonicalRenderer: true));
            if (interruption == "caller")
            {
                caller.Cancel();
            }
            else if (interruption == "deadline")
            {
                _time.Advance(DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.WallTime);
            }
        });
        var service = new DocumentExportJobService(new DocumentExportJobRepository(_layout, _protection, sync), _authorization, _time);
        await service.CreateAsync(_actor, task, input, default);
        DocumentExportJobSnapshot result = await service.ExecuteAsync(_actor, task.TaskId, provider, caller.Token);
        Assert.True(sync.Injected);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, result.Task.Status);
        Assert.Equal(DocumentExportTaskStatus.Failed, result.Attempts[0].Status);
        Assert.Equal(DocumentExportDigest.Serialize(result),
            DocumentExportDigest.Serialize(await Service().GetAsync(_actor, task.TaskId, default)));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => service.GrantAsync(_actor, task.TaskId, default));
        var protector = _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
        DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(protector.Unprotect(File.ReadAllBytes(StatePath)));
        Assert.NotNull(state.Jobs[0].WorkerDigest);
        Assert.NotNull(state.Jobs[0].Input);
        Assert.NotNull(state.Jobs[0].PendingOutput);
        Assert.Null(result.Output);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => service.RecoverInterruptedAsync(task.TaskId, new TestRecovery(false), default));
        await service.CleanupAsync(default);
        Assert.Single(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        DocumentExportJobSnapshot recovered = await service.RecoverInterruptedAsync(task.TaskId, new TestRecovery(true), default);
        Assert.Equal(interruption == "caller" ? DocumentExportTaskStatus.Cancelled : DocumentExportTaskStatus.Failed, recovered.Task.Status);
        Assert.Equal(result.Attempts[0], recovered.Attempts[0]);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancel_DuringExportOrVerifierFencesLateSuccess(bool verifier)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        var provider = new ControlledProvider(task.ProviderId) { PauseExport = !verifier, PauseVerify = verifier };
        Task<DocumentExportJobSnapshot> running = Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        await (verifier ? provider.Verifying.Task : provider.Entered.Task).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(DocumentExportTaskStatus.Cancelling, (await Service().CancelAsync(_actor, task.TaskId, default)).Task.Status);
        provider.Release.TrySetResult();
        DocumentExportJobSnapshot result = await running;
        Assert.NotEqual(DocumentExportTaskStatus.Succeeded, result.Task.Status);
        Assert.Null(result.Output);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, task.TaskId, default));
        result = await Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(true), default);
        Assert.Equal(DocumentExportTaskStatus.Cancelled, result.Task.Status);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().RetryAsync(_actor, task.TaskId, default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AttemptDeadline_FencesLateExportAndCombinedStageTime(bool expireDuringExport)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        TimeSpan wall = DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.WallTime;
        var provider = new ControlledProvider(task.ProviderId)
        {
            OnExport = () => _time.Advance(wall * (expireDuringExport ? 2 : 2.0 / 3)),
            OnVerify = () => _time.Advance(wall * (2.0 / 3))
        };
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(expireDuringExport ? DocumentExportTaskStatus.CleanupRequired : DocumentExportTaskStatus.Failed,
            result.Task.Status);
        Assert.Equal(DocumentExportTaskStatus.Failed, result.Attempts[0].Status);
        Assert.Equal("task_wall_time_budget_failed", result.Attempts[0].Reason);
        Assert.Equal(expireDuringExport ? 0 : 1, provider.Verifications);
        Assert.Null(result.Output);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, task.TaskId, default));
    }

    [Fact]
    public async Task AttemptDeadline_WithinCombinedBudgetPreservesSuccess()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        TimeSpan stage = DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.WallTime / 4;
        var provider = new ControlledProvider(task.ProviderId)
        {
            OnExport = () => _time.Advance(stage),
            OnVerify = () => _time.Advance(stage)
        };
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(DocumentExportTaskStatus.Succeeded, result.Task.Status);
        Assert.Equal(1, provider.Verifications);
        Assert.NotNull(result.Output);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AttemptDeadline_DoesNotReplaceObservedProviderFailure(bool budgetFailure)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        TimeSpan wall = DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.WallTime;
        var provider = new ControlledProvider(task.ProviderId)
        {
            OnFailureCleanup = () => _time.Advance(wall * 2),
            FailBudget = budgetFailure,
            FailExport = !budgetFailure
        };
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, result.Task.Status);
        Assert.Equal(DocumentExportTaskStatus.Failed, result.Attempts[0].Status);
        Assert.Equal(budgetFailure ? "sandbox_budget_failed" : "provider_failed", result.Attempts[0].Reason);
        var protector = _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
        DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(protector.Unprotect(File.ReadAllBytes(StatePath)));
        Assert.Equal(provider.FailureReceipt, state.Jobs[0].SandboxFailure);
        Assert.NotNull(state.Jobs[0].WorkerDigest);
        Assert.Null(result.Output);
    }

    [Fact]
    public async Task AttemptDeadline_PreservesCallerCancellationAfterLateReturn()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        using var caller = new CancellationTokenSource();
        TimeSpan wall = DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.WallTime;
        var provider = new ControlledProvider(task.ProviderId)
        {
            OnExport = () =>
            {
                caller.Cancel();
                _time.Advance(wall * 2);
            }
        };
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, provider, caller.Token);
        Assert.Equal(DocumentExportTaskStatus.Cancelled, result.Attempts[0].Status);
        Assert.NotEqual("task_wall_time_budget_failed", result.Attempts[0].Reason);
        Assert.Equal(0, provider.Verifications);
        Assert.Null(result.Output);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AttemptDeadline_TimerCancelsWaitingProviderAndRetainsFirstOrigin(bool callerFirst)
    {
        DocumentExportTask task = Request().Task;
        TimeSpan wall = DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.WallTime;
        using var caller = new CancellationTokenSource();
        using var stop = new CancellationTokenSource();
        using var deadline = new DocumentExportAttemptDeadline(task, _time, caller.Token, stop.Token);
        Task waiting = Task.Delay(Timeout.InfiniteTimeSpan, deadline.Token);
        if (callerFirst)
        {
            caller.Cancel();
        }
        _time.Advance(wall);
        caller.Cancel();
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(deadline.Token.IsCancellationRequested);
        Assert.Equal(!callerFirst, deadline.DeadlineCancelled);
        if (callerFirst)
        {
            Assert.ThrowsAny<OperationCanceledException>(deadline.ThrowIfExpired);
        }
        else
        {
            Assert.Equal("task-wall-time-budget",
                Assert.Throws<DocumentExportBudgetExceededException>(deadline.ThrowIfExpired).FailureCode);
        }
    }

    [Fact]
    public async Task AttemptDeadline_FinalStateSyncCrossingBudgetIsFencedBeforeUnlock()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        TimeSpan wall = DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets.WallTime;
        var sync = new FinalStateDeadlineSync(() => _time.Advance(wall));
        var repository = new DocumentExportJobRepository(_layout, _protection, sync);
        var service = new DocumentExportJobService(repository, _authorization, _time);
        await service.CreateAsync(_actor, task, input, default);
        DocumentExportJobSnapshot result = await service.ExecuteAsync(_actor, task.TaskId,
            new ControlledProvider(task.ProviderId), default);
        Assert.True(sync.Injected);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, result.Task.Status);
        Assert.Equal(DocumentExportTaskStatus.Failed, result.Attempts[0].Status);
        Assert.Equal("task_wall_time_budget_failed", result.Reason);
        Assert.Equal(DocumentExportDigest.Serialize(result),
            DocumentExportDigest.Serialize(await Service().GetAsync(_actor, task.TaskId, default)));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, task.TaskId, default));
        await service.CleanupAsync(default);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task Permission_RevokedDuringVerifierRejectsOutputCommit()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        var provider = new ControlledProvider(task.ProviderId) { PauseVerify = true };
        Task<DocumentExportJobSnapshot> running = Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        await provider.Verifying.Task.WaitAsync(TimeSpan.FromSeconds(5));
        _authorization.Allowed = false;
        provider.Release.TrySetResult();
        DocumentExportJobSnapshot result = await running;
        Assert.Equal(DocumentExportTaskStatus.Failed, result.Task.Status);
        Assert.Null(result.Output);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task Retry_RequiresOriginalAuthorityRecoveryAndKeepsFirstFailureUnqualified()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        var failing = new ControlledProvider(task.ProviderId) { FailExport = true };
        DocumentExportJobSnapshot failed = await Service().ExecuteAsync(_actor, task.TaskId, failing, default);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, failed.Task.Status);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().RetryAsync(_actor, task.TaskId, default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(false), default));
        Assert.Equal(DocumentExportTaskStatus.Failed,
            (await Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(true), default)).Task.Status);
        await Service().RetryAsync(_actor, task.TaskId, default);
        DocumentExportJobSnapshot diagnostic = await Service().ExecuteAsync(_actor, task.TaskId, new ControlledProvider(task.ProviderId), default);
        Assert.Equal(DocumentExportTaskStatus.Failed, diagnostic.Task.Status);
        Assert.Equal("diagnostic_success_unqualified", diagnostic.Reason);
        Assert.Equal(failed.Attempts[0], diagnostic.Attempts[0]);
        Assert.True(diagnostic.Attempts[1].Diagnostic);
        Assert.Null(diagnostic.Output);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, task.TaskId, default));
    }

    [Fact]
    public async Task Download_HeadDoesNotConsumeGetIsSingleUseWithPrivateHeadersAndActualBytes()
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        DocumentExportDownloadGrant grant = await Service().GrantAsync(_actor, job.Task.TaskId, default);
        DocumentExportDownload metadata = await Service().DownloadAsync(_actor, grant.Token, true, default);
        Assert.Empty(metadata.Bytes);
        DocumentExportDownload download = await Service().DownloadAsync(_actor, grant.Token, false, default);
        Assert.Equal(ControlledProvider.Output, download.Bytes);
        Assert.Equal("private, no-store, max-age=0", download.Headers["Cache-Control"]);
        Assert.Equal("same-origin", download.Headers["Cross-Origin-Resource-Policy"]);
        Assert.Equal("nosniff", download.Headers["X-Content-Type-Options"]);
        Assert.Equal("none", download.Headers["Accept-Ranges"]);
        Assert.Equal("attachment; filename=\"export.html\"", download.Headers["Content-Disposition"]);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().DownloadAsync(_actor, grant.Token, false, default));
        Assert.DoesNotContain(grant.Token, Encoding.UTF8.GetString(File.ReadAllBytes(StatePath)));
    }

    [Theory]
    [InlineData("user")]
    [InlineData("site")]
    [InlineData("session")]
    [InlineData("token")]
    [InlineData("permission")]
    [InlineData("expiry")]
    public async Task Download_UniformDenialForUnauthorizedOrExpiredCapability(string mutation)
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        DocumentExportDownloadGrant grant = await Service().GrantAsync(_actor, job.Task.TaskId, default);
        DocumentExportJobActor actor = mutation switch
        {
            "user" => _actor with { UserId = 8 },
            "site" => _actor with { SiteScope = "https://other.example.test" },
            "session" => _actor with { SessionId = "different-session" },
            _ => _actor
        };
        string token = mutation == "token" ? new string('0', 64) : grant.Token;
        _authorization.Allowed = mutation != "permission";
        if (mutation == "expiry")
        {
            _time.Advance(DocumentExportJobPolicy.GrantTtl);
        }
        DocumentExportJobDeniedException error = await Assert.ThrowsAsync<DocumentExportJobDeniedException>(
            () => Service().DownloadAsync(actor, token, false, default));
        Assert.Equal("document_export_unavailable", error.Message);
    }

    [Fact]
    public async Task Delete_RevokesGrantAndUnlinksOwnedObjectIdempotently()
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        DocumentExportDownloadGrant grant = await Service().GrantAsync(_actor, job.Task.TaskId, default);
        await Service().DeleteAsync(_actor, job.Task.TaskId, default);
        await Service().DeleteAsync(_actor, job.Task.TaskId, default);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        Assert.NotNull((await Service().GetAsync(_actor, job.Task.TaskId, default)).Output!.DeletedAt);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().DownloadAsync(_actor, grant.Token, false, default));
    }

    [Fact]
    public async Task Logout_RevokesSessionGrantWhileRetainingPrivateOutputUntilTtl()
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        DocumentExportDownloadGrant grant = await Service().GrantAsync(_actor, job.Task.TaskId, default);
        await Service().RevokeSessionAsync(_actor, default);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().DownloadAsync(_actor, grant.Token, false, default));
        Assert.Equal(DocumentExportTaskStatus.Succeeded, (await Service().GetAsync(_actor, job.Task.TaskId, default)).Task.Status);
        _time.Advance(DocumentExportJobPolicy.JobTtl);
        DocumentExportJobUsage usage = await Service().CleanupAsync(default);
        Assert.Equal(0, usage.OutputBytes);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        Assert.Equal(DocumentExportTaskStatus.Expired, (await Service().GetAsync(_actor, job.Task.TaskId, default)).Task.Status);
    }

    [Fact]
    public async Task SameDigest_DifferentOwnersKeepDistinctObjectsAndDeletionRights()
    {
        DocumentExportJobSnapshot first = await SucceedAsync();
        DocumentExportJobActor other = _actor with
        {
            UserId = 8
        };
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        input = DocumentExportContractValidator.Seal(input with
        {
            UserId = other.UserId
        });
        task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            TaskId = "other-owner"
        });
        await Service().CreateAsync(other, task, input, default);
        DocumentExportJobSnapshot second = await Service().ExecuteAsync(other, task.TaskId, new ControlledProvider(task.ProviderId), default);
        Assert.Equal(first.Output!.OutputDigest, second.Output!.OutputDigest);
        Assert.NotEqual(first.Output.ObjectId, second.Output.ObjectId);
        await Service().DeleteAsync(_actor, first.Task.TaskId, default);
        DocumentExportDownloadGrant grant = await Service().GrantAsync(other, second.Task.TaskId, default);
        Assert.Equal(ControlledProvider.Output, (await Service().DownloadAsync(other, grant.Token, false, default)).Bytes);
    }

    [Fact]
    public async Task ObjectTamper_UniformDenialRevokesGrantAndRequiresCleanup()
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        DocumentExportDownloadGrant grant = await Service().GrantAsync(_actor, job.Task.TaskId, default);
        string path = Assert.Single(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        File.WriteAllBytes(path, [1, 2, 3]);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().DownloadAsync(_actor, grant.Token, false, default));
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, (await Service().GetAsync(_actor, job.Task.TaskId, default)).Task.Status);
        Assert.Equal(1, (await Service().GetUsageAsync(default)).CleanupRequired);
        await Service().CleanupAsync(default);
        Assert.False(File.Exists(path));
    }

    [Fact]
    public async Task StateTamperOrRemoval_FailsClosedAcrossRestart()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        byte[] original = File.ReadAllBytes(StatePath);
        File.WriteAllBytes(StatePath, [1, 2, 3]);
        await Assert.ThrowsAsync<InvalidDataException>(() => Service().GetAsync(_actor, task.TaskId, default));
        File.WriteAllBytes(StatePath, original);
        File.Delete(StatePath);
        await Assert.ThrowsAsync<InvalidDataException>(() => Service().CreateAsync(_actor, task, input, default));
    }

    [Fact]
    public async Task CleanupFailure_PreservesRecoveryRequiredUntilObstacleIsRemoved()
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        string path = Assert.Single(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        File.Delete(path);
        Directory.CreateDirectory(path);
        await Service().DeleteAsync(_actor, job.Task.TaskId, default);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, (await Service().GetAsync(_actor, job.Task.TaskId, default)).Task.Status);
        Directory.Delete(path);
        await Service().CleanupAsync(default);
        Assert.Equal(0, (await Service().GetUsageAsync(default)).CleanupRequired);
    }

    [Fact]
    public async Task AdmissionQuota_IsBoundedWithoutCreatingExtraJob()
    {
        for (int index = 0; index < DocumentExportJobPolicy.MaximumOwnerJobs; index++)
        {
            (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
            task = DocumentExportContractValidator.Seal(task with
            {
                TaskId = $"job-{index}",
                IdempotencyKey = $"key-{index}"
            });
            await Service().CreateAsync(_actor, task, input, default);
        }
        (DocumentExportTask rejected, DocumentExportFrozenInput frozen) = Request();
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().CreateAsync(_actor, rejected, frozen, default));
        Assert.Equal(DocumentExportJobPolicy.MaximumOwnerJobs, (await Service().ListAsync(_actor, default)).Length);
    }

    [Fact]
    public async Task ConcurrentGrantRedemption_OnlyOneRequestReceivesPrivateBytes()
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        DocumentExportDownloadGrant grant = await Service().GrantAsync(_actor, job.Task.TaskId, default);
        async Task<bool> Redeem()
        {
            try
            {
                await Service().DownloadAsync(_actor, grant.Token, false, default);
                return true;
            }
            catch (DocumentExportJobDeniedException)
            {
                return false;
            }
        }
        bool[] outcomes = await Task.WhenAll(Task.Run(Redeem), Task.Run(Redeem));
        Assert.Single(outcomes, outcome => outcome);
    }

    [Fact]
    public async Task GrantQuota_AndRepeatedCleanupRemainBounded()
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        for (int index = 0; index < DocumentExportJobPolicy.MaximumOwnerGrants; index++)
        {
            await Service().GrantAsync(_actor, job.Task.TaskId, default);
        }
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, job.Task.TaskId, default));
        _time.Advance(DocumentExportJobPolicy.JobTtl);
        for (int index = 0; index < 100; index++)
        {
            await Service().CleanupAsync(default);
        }
        Assert.Equal(DocumentExportTaskStatus.Expired, (await Service().GetAsync(_actor, job.Task.TaskId, default)).Task.Status);
        Assert.Equal(0, (await Service().GetUsageAsync(default)).OutputBytes);
    }

    [Fact]
    public async Task TaskIdentityNeverBecomesObjectPathOrDownloadFilename()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        task = DocumentExportContractValidator.Seal(task with
        {
            TaskId = "../../雪/%0d%0a",
            IdempotencyKey = "unicode-key"
        });
        await Service().CreateAsync(_actor, task, input, default);
        DocumentExportJobSnapshot job = await Service().ExecuteAsync(_actor, task.TaskId, new ControlledProvider(task.ProviderId), default);
        string path = Assert.Single(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        Assert.DoesNotContain("雪", path);
        DocumentExportDownloadGrant grant = await Service().GrantAsync(_actor, job.Task.TaskId, default);
        Assert.Equal("attachment; filename=\"export.html\"",
            (await Service().DownloadAsync(_actor, grant.Token, false, default)).Headers["Content-Disposition"]);
    }

    [Theory]
    [InlineData(DocumentExportProviderResultStatus.Failed)]
    [InlineData(DocumentExportProviderResultStatus.Cancelled)]
    [InlineData(DocumentExportProviderResultStatus.Blocked)]
    [InlineData(DocumentExportProviderResultStatus.CleanupRequired)]
    public async Task NonSuccessProviderResult_CannotPublishDownloadableObject(DocumentExportProviderResultStatus status)
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId,
            new ControlledProvider(task.ProviderId) { ResultStatus = status }, default);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, result.Task.Status);
        Assert.Null(result.Output);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, task.TaskId, default));
    }

    [Fact]
    public async Task MissingJobMutation_DoesNotInitializeStorage()
    {
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().CancelAsync(_actor, "unknown", default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, "unknown", default));
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().DownloadAsync(_actor, new string('0', 64), false, default));
        Assert.False(Directory.Exists(JobRoot));
    }

    [Fact]
    public async Task InputByteBudget_RejectsBeforeCreatingStorage()
    {
        DocumentExportFrozenInput input = DocumentExportContractTests.ValidInput(new string('x', (int)DocumentExportJobPolicy.MaximumInputBytes + 1));
        DocumentExportTask task = DocumentExportContractTests.ValidTask(input);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().CreateAsync(_actor, task, input, default));
        Assert.False(Directory.Exists(JobRoot));
    }

    [Fact]
    public async Task UserAdmissionQuota_AggregatesAcrossAuthorizedSites()
    {
        for (int index = 0; index < DocumentExportJobPolicy.MaximumOwnerJobs; index++)
        {
            DocumentExportJobActor actor = _actor with
            {
                SiteScope = index % 2 == 0 ? _actor.SiteScope : "https://other.example.test"
            };
            DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidInput() with
            {
                SiteScope = actor.SiteScope
            });
            DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input)
                with
            {
                TaskId = $"site-job-{index}",
                IdempotencyKey = $"site-key-{index}"
            });
            await Service().CreateAsync(actor, task, input, default);
        }
        (DocumentExportTask rejected, DocumentExportFrozenInput frozen) = Request();
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().CreateAsync(_actor, rejected, frozen, default));
        DocumentExportJobScopeUsage user = Assert.Single((await Service().GetUsageAsync(default)).Scopes, scope => scope.UserId == _actor.UserId);
        Assert.Equal(DocumentExportJobPolicy.MaximumOwnerJobs, user.Jobs);
    }

    [Fact]
    public async Task Cancellation_CannotEraseObservedCanonicalBudgetFailureOrReleaseItsClaim()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        var provider = new ControlledProvider(task.ProviderId) { PauseExport = true, FailBudget = true };
        Task<DocumentExportJobSnapshot> running = Service().ExecuteAsync(_actor, task.TaskId, provider, default);
        await provider.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Service().CancelAsync(_actor, task.TaskId, default);
        provider.Release.TrySetResult();
        DocumentExportJobSnapshot failed = await running;
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, failed.Task.Status);
        Assert.Equal(DocumentExportTaskStatus.Failed, failed.Attempts[0].Status);
        Assert.Equal("sandbox_budget_failed", failed.Attempts[0].Reason);
        var protector = _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
        DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(protector.Unprotect(File.ReadAllBytes(StatePath)));
        Assert.Equal(provider.FailureReceipt, state.Jobs[0].SandboxFailure);
        Assert.NotNull(state.Jobs[0].WorkerDigest);
        DocumentExportJobSnapshot recovered = await Service().RecoverInterruptedAsync(task.TaskId, new TestRecovery(true), default);
        Assert.Equal(DocumentExportTaskStatus.Cancelled, recovered.Task.Status);
        Assert.Equal(failed.Attempts[0], recovered.Attempts[0]);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().RetryAsync(_actor, task.TaskId, default));
    }

    [Fact]
    public async Task FinalPersistenceFailure_NeverReturnsDownloadableSuccess()
    {
        var sync = new FailFourthStateSync();
        var repository = new DocumentExportJobRepository(_layout, _protection, sync);
        var service = new DocumentExportJobService(repository, _authorization, _time);
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await service.CreateAsync(_actor, task, input, default);
        DocumentExportJobSnapshot result = await service.ExecuteAsync(_actor, task.TaskId, new ControlledProvider(task.ProviderId), default);
        Assert.True(sync.Injected);
        Assert.Equal(DocumentExportTaskStatus.CleanupRequired, result.Task.Status);
        Assert.Equal(DocumentExportTaskStatus.Failed, result.Attempts[0].Status);
        await Assert.ThrowsAsync<DocumentExportJobDeniedException>(() => Service().GrantAsync(_actor, task.TaskId, default));
        await Service().CleanupAsync(default);
        Assert.Empty(Directory.GetFiles(JobRoot, "*.object", SearchOption.AllDirectories));
    }

    [Theory]
    [InlineData("task")]
    [InlineData("output")]
    [InlineData("output-scope")]
    public async Task AuthenticatedButInconsistentStoredRecord_IsRejectedIndependently(string mutation)
    {
        DocumentExportJobSnapshot job = await SucceedAsync();
        var protector = _protection.CreateProtector("FsusBlog.DocumentExport.Jobs.State.v2");
        DocumentExportJobState state = DocumentExportDigest.Deserialize<DocumentExportJobState>(protector.Unprotect(File.ReadAllBytes(StatePath)));
        DocumentExportStoredJob row = state.Jobs[0];
        if (mutation == "task")
        {
            row = row with
            {
                Snapshot = row.Snapshot with
                {
                    Task = DocumentExportContractValidator.Seal(row.Snapshot.Task with
                    {
                        TaskId = "altered"
                    })
                }
            };
        }
        else
        {
            DocumentExportOutputRecord output = row.Snapshot.Output! with
            {
                Length = row.Snapshot.Output!.Length + (mutation == "output-scope" ? 0 : 1),
                SiteScope = mutation == "output-scope" ? "https://other.example.test" : row.Snapshot.Output.SiteScope,
                ContentDigest = string.Empty
            };
            output = output with
            {
                ContentDigest = DocumentExportDigest.Compute(output)
            };
            row = row with
            {
                Snapshot = row.Snapshot with
                {
                    Output = output
                }
            };
        }
        state.Jobs[0] = row;
        state = state with
        {
            ContentDigest = string.Empty
        };
        state = state with
        {
            ContentDigest = DocumentExportDigest.Compute(state)
        };
        File.WriteAllBytes(StatePath, protector.Protect(DocumentExportDigest.Serialize(state)));
        await Assert.ThrowsAsync<InvalidDataException>(() => Service().GetAsync(_actor, job.Task.TaskId, default));
    }

    [Fact]
    public async Task StorageLinkAndBroadMode_RefuseWithoutFollowingOrChangingExternalData()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        string outside = Path.Combine(_root, "outside");
        Directory.CreateDirectory(outside);
        Directory.CreateSymbolicLink(JobRoot, outside);
        await Assert.ThrowsAsync<InvalidDataException>(() => Service().CreateAsync(_actor, task, input, default));
        Assert.Empty(Directory.GetFileSystemEntries(outside));
        Directory.Delete(JobRoot);
        Directory.CreateDirectory(JobRoot);
        File.SetUnixFileMode(JobRoot, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.OtherWrite);
        await Assert.ThrowsAsync<InvalidDataException>(() => Service().CreateAsync(_actor, task, input, default));
    }

    private DocumentExportJobService Service() => new(_layout, _protection, _authorization, _time);
    private string JobRoot => Path.Combine(_layout.Paths.PrivateAssetRoot, "document-export");
    private string StatePath => Path.Combine(JobRoot, "state.bin");

    private static (DocumentExportTask Task, DocumentExportFrozenInput Input) Request(string format = "self-contained-html")
    {
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(format);
        DocumentExportFrozenInput input = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidInput("# private-frozen-source")
            with
        {
            RendererId = provider.RendererId,
            RendererVersion = provider.RendererVersion
        });
        DocumentExportTask task = DocumentExportContractValidator.Seal(DocumentExportContractTests.ValidTask(input) with
        {
            FormatId = format,
            ProviderId = provider.ProviderId,
            ProviderVersion = provider.ProviderVersion
        });
        return (task, input);
    }

    private async Task<DocumentExportJobSnapshot> SucceedAsync()
    {
        (DocumentExportTask task, DocumentExportFrozenInput input) = Request();
        await Service().CreateAsync(_actor, task, input, default);
        DocumentExportJobSnapshot result = await Service().ExecuteAsync(_actor, task.TaskId, new ControlledProvider(task.ProviderId), default);
        Assert.Equal(DocumentExportTaskStatus.Succeeded, result.Task.Status);
        return result;
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private sealed class TestAuthorization : IDocumentExportJobAuthorization
    {
        internal bool Allowed { get; set; } = true;
        public ValueTask<bool> IsAllowedAsync(DocumentExportJobActor actor, DocumentExportArticleCoordinate coordinate,
            DocumentExportJobOperation operation, CancellationToken cancellationToken) => ValueTask.FromResult(Allowed);
    }

    private sealed class FailFourthStateSync : IPrivateAssetDirectorySync
    {
        private readonly LinuxPrivateAssetDirectorySync _canonical = new();
        private int _stateSyncs;
        internal bool Injected
        {
            get; private set;
        }
        public void Sync(Microsoft.Win32.SafeHandles.SafeFileHandle directory, PrivateAssetDirectoryDurabilityPoint point)
        {
            _canonical.Sync(directory, point);
            if (point == PrivateAssetDirectoryDurabilityPoint.ExistingPublication && ++_stateSyncs == 4)
            {
                Injected = true;
                throw new IOException("controlled final-state synchronization failure");
            }
        }
    }

    private sealed class FinalStateDeadlineSync(Action expire) : IPrivateAssetDirectorySync
    {
        private readonly LinuxPrivateAssetDirectorySync _canonical = new();
        private int _stateSyncs;
        internal bool Injected
        {
            get; private set;
        }
        public void Sync(Microsoft.Win32.SafeHandles.SafeFileHandle directory, PrivateAssetDirectoryDurabilityPoint point)
        {
            _canonical.Sync(directory, point);
            if (point == PrivateAssetDirectoryDurabilityPoint.ExistingPublication && ++_stateSyncs == 4)
            {
                Injected = true;
                expire();
            }
        }
    }

    private sealed class TestRecovery(bool quiescent) : IDocumentExportJobRecovery
    {
        public Task<bool> IsQuiescentAsync(DocumentExportTask executionTask, CancellationToken cancellationToken)
            => Task.FromResult(quiescent);
    }

    private sealed class TestTimeProvider : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 10, 8, 6, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => _now;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => _now.UtcTicks;
        private readonly List<DeadlineTimer> _timers = [];
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            var timer = new DeadlineTimer(this, callback, state);
            timer.Change(dueTime, period);
            _timers.Add(timer);
            return timer;
        }
        internal void Advance(TimeSpan elapsed)
        {
            _now += elapsed;
            foreach (DeadlineTimer timer in _timers.ToArray())
            {
                timer.Tick(_now);
            }
        }

        private sealed class DeadlineTimer(TestTimeProvider time, TimerCallback callback, object? state) : ITimer
        {
            private DateTimeOffset? _due;
            private TimeSpan _period;
            private bool _disposed;
            public bool Change(TimeSpan dueTime, TimeSpan period)
            {
                if (_disposed)
                {
                    return false;
                }
                _due = dueTime == Timeout.InfiniteTimeSpan ? null : time.GetUtcNow() + dueTime;
                _period = period;
                return true;
            }
            internal void Tick(DateTimeOffset now)
            {
                if (!_disposed && _due is { } due && due <= now)
                {
                    _due = _period > TimeSpan.Zero ? now + _period : null;
                    callback(state);
                }
            }
            public void Dispose() => _disposed = true;
            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }

    private sealed class LegacyProvider(string providerId) : IDocumentExportJobProvider
    {
        public string ProviderId => providerId;
        internal int Invocations
        {
            get; private set;
        }
        public Task<DocumentExportProviderResult> ExportAsync(DocumentExportTask task, DocumentExportFrozenInput input,
            CancellationToken cancellationToken)
        {
            Invocations++;
            throw new InvalidOperationException("legacy adapter must not run");
        }
        public Task VerifyAsync(DocumentExportProviderResult result, DocumentExportTask task,
            DocumentExportFrozenInput input, CancellationToken cancellationToken)
        {
            Invocations++;
            throw new InvalidOperationException("legacy verifier must not run");
        }
    }

    private sealed class ControlledProvider(string providerId) : IDocumentExportAttemptJobProvider
    {
        private static readonly byte[] s_output = Encoding.UTF8.GetBytes("controlled lifecycle artifact, not a format-qualified output");
        internal static byte[] Output => s_output;
        public string ProviderId => providerId;
        internal List<DocumentExportAttemptResources> Resources { get; } = [];
        internal DocumentExportAttemptResources? ExportResources
        {
            get; private set;
        }
        internal DocumentExportAttemptResources? VerificationResources
        {
            get; private set;
        }
        internal DocumentExportTask? ResourceTask
        {
            get; private set;
        }
        internal DocumentExportFrozenInput? ResourceInput
        {
            get; private set;
        }
        internal TimeProvider? ResourceTime
        {
            get; private set;
        }
        internal DocumentExportAttemptResources.Stage? HeldStage
        {
            get; private set;
        }
        internal Action? OnCreateResources
        {
            get; init;
        }
        internal string? ResourceFault
        {
            get; init;
        }
        internal long ExportCpuMicroseconds
        {
            get; init;
        }
        internal long VerificationCpuMicroseconds
        {
            get; init;
        }

        public DocumentExportAttemptResources CreateAttemptResources(DocumentExportTask task,
            DocumentExportFrozenInput input, TimeProvider time)
        {
            ResourceTask = ResourceFault == "foreign"
                ? DocumentExportContractValidator.Seal(task with
                {
                    TaskId = Guid.NewGuid().ToString("N")
                }) : task;
            ResourceInput = input;
            ResourceTime = time;
            OnCreateResources?.Invoke();
            var resources = new DocumentExportAttemptResources(ResourceTask, input,
                DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets, time);
            Resources.Add(resources);
            return resources;
        }

        public async Task<DocumentExportProviderResult> ExportAsync(DocumentExportTask task, DocumentExportFrozenInput input,
            DocumentExportAttemptResources resources, CancellationToken cancellationToken)
        {
            ExportResources = resources;
            if (ResourceFault == "incomplete")
            {
                return await ExportAsync(task, input, cancellationToken);
            }
            // Component-only controlled observations, using the original stage
            // authority. No native process or physical receipt is qualified.
            using DocumentExportAttemptResources.Stage stage = resources.BeginStage(ResourceTask!, input,
                DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets, canonicalRenderer: true);
            DocumentExportProviderResult result = await ExportAsync(task, input, cancellationToken);
            stage.Observe(ExportCpuMicroseconds, 1, result.Bytes.LongLength, input.MarkdownUtf8.Length,
                result.Bytes.LongLength, 0, 0);
            Exception? failure = stage.Complete(qualified: ResourceFault != "failed");
            if (failure is not null)
            {
                throw failure;
            }
            return result;
        }

        public async Task VerifyAsync(DocumentExportProviderResult result, DocumentExportTask task,
            DocumentExportFrozenInput input, DocumentExportAttemptResources resources, CancellationToken cancellationToken)
        {
            VerificationResources = resources;
            if (ResourceFault is "incomplete" or "failed")
            {
                await VerifyAsync(result, task, input, cancellationToken);
                return;
            }
            DocumentExportAttemptResources.Stage stage = resources.BeginStage(ResourceTask!, input,
                DocumentExportContractCatalog.RequireProvider(task.FormatId).Budgets, canonicalRenderer: false);
            if (ResourceFault == "active")
            {
                HeldStage = stage;
                await VerifyAsync(result, task, input, cancellationToken);
                return;
            }
            using (stage)
            {
                await VerifyAsync(result, task, input, cancellationToken);
                stage.Observe(VerificationCpuMicroseconds, 0, 0, result.Bytes.LongLength, 0, 0, 0);
                Exception? failure = stage.Complete(qualified: true);
                if (failure is not null)
                {
                    throw failure;
                }
            }
        }
        internal bool PauseExport
        {
            get; init;
        }
        internal bool PauseVerify
        {
            get; init;
        }
        internal bool FailExport
        {
            get; init;
        }
        internal bool FailBudget
        {
            get; init;
        }
        internal Action? OnExport
        {
            get; init;
        }
        internal Action? OnVerify
        {
            get; init;
        }
        internal Action? OnFailureCleanup
        {
            get; init;
        }
        internal DocumentExportSandboxReceipt? FailureReceipt
        {
            get; private set;
        }
        internal DocumentExportProviderResultStatus ResultStatus { get; init; } = DocumentExportProviderResultStatus.Succeeded;
        internal int Invocations
        {
            get; private set;
        }
        internal int Verifications
        {
            get; private set;
        }
        internal DocumentExportFrozenInput? ObservedInput
        {
            get; private set;
        }
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Verifying { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<DocumentExportProviderResult> ExportAsync(DocumentExportTask task, DocumentExportFrozenInput input,
            CancellationToken cancellationToken)
        {
            Invocations++;
            ObservedInput = input;
            Entered.TrySetResult();
            if (PauseExport)
            {
                // Intentionally ignore cancellation to exercise the late-result fence.
                await Release.Task.ConfigureAwait(false);
            }
            OnExport?.Invoke();
            if (FailExport)
            {
                var failure = new IOException("deliberate unqualified adapter failure");
                OnFailureCleanup?.Invoke();
                throw failure;
            }
            if (FailBudget)
            {
                FailureReceipt = UnqualifiedSandboxFixture();
                var failure = new DocumentExportBudgetExceededException("controlled canonical exception category", "cpu-budget", null!, FailureReceipt,
                    new IOException("controlled failure"));
                OnFailureCleanup?.Invoke();
                throw failure;
            }
            DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
            DocumentExportSandboxReceipt sandbox = UnqualifiedSandboxFixture();
            DocumentExportProviderReceipt receipt = DocumentExportContractValidator.Seal(new DocumentExportProviderReceipt(
                DocumentExportContractCatalog.ResultSchema, task.ContentDigest, input.ContentDigest,
                provider.ProviderId, provider.ProviderVersion, input.RendererId, input.RendererVersion,
                input.RendererDigest, input.AssetManifestDigest, input.FontManifestDigest, input.ReadingStyleAuthorityDigest,
                provider.ToolchainId, provider.ToolchainVersion, sandbox.ContentDigest, provider.OutputMediaType,
                provider.OutputExtension, provider.NormalizationPolicy, DocumentExportDigest.ComputeBytes(Output),
                DocumentExportDigest.ComputeBytes(Output), Output.Length, [], [], [], ResultStatus,
                (long)provider.Delivery.RetentionTtl.TotalSeconds, string.Empty));
            return new DocumentExportProviderResult(Output.ToArray(), [], receipt, null!, sandbox);
        }

        public async Task VerifyAsync(DocumentExportProviderResult result, DocumentExportTask task,
            DocumentExportFrozenInput input, CancellationToken cancellationToken)
        {
            Verifications++;
            Verifying.TrySetResult();
            if (PauseVerify)
            {
                await Release.Task.ConfigureAwait(false);
            }
            OnVerify?.Invoke();
            Assert.Equal(Output, result.Bytes);
        }

        private static DocumentExportSandboxReceipt UnqualifiedSandboxFixture()
        {
            // Typed test seam only: all authority facts deliberately remain false
            // or zero. The production adapter must independently refuse this.
            ConstructorInfo constructor = typeof(DocumentExportSandboxReceipt).GetConstructors().Single();
            object?[] values = constructor.GetParameters().Select(parameter => parameter.ParameterType == typeof(string)
                ? (object)(parameter.Name == "ContentDigest" ? DocumentExportDigest.ComputeBytes([0]) : "unqualified-test-fixture")
                : Activator.CreateInstance(parameter.ParameterType)).ToArray();
            return (DocumentExportSandboxReceipt)constructor.Invoke(values);
        }
    }
}
