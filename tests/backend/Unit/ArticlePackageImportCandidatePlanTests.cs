using System.Collections;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Pure candidate planning controls; no request grants observed import or execution authority.</summary>
[Trait("Category", "Unit")]
public sealed class ArticlePackageImportCandidatePlanTests
{
    private static readonly DateTime s_created = new(2026, 10, 8, 1, 2, 3, DateTimeKind.Utc);
    private static readonly ArticleRelationActorContext s_actor = new("actor:explicit-importer", "site:primary", new string('a', 64));
    private static readonly string s_policyDigest = new('b', 64);

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CreateNew_RequiresNewIdentitiesAndNeverCopiesSourceIds(bool explicitEmpty)
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        ArticlePackageImportCandidateRequest request = Request(targets: explicitEmpty ? [] : null);
        ArticlePackageImportCandidatePlan plan = Create(candidate, request);

        Assert.Same(candidate, plan.Candidate);
        Assert.Equal(request.Actor, plan.Actor);
        Assert.Equal(request.Mode, plan.Mode);
        Assert.Equal(request.PolicyDigest, plan.PolicyDigest);
        Assert.Equal(request.CreatedAtUtc, plan.CreatedAtUtc);
        Assert.Equal(request.ExpiresAtUtc, plan.ExpiresAtUtc);
        Assert.Equal(2, plan.Targets.Count);
        Assert.All(plan.Targets, target =>
        {
            Assert.True(target.RequiresNewIdentity);
            Assert.Null(target.RequestedTargetArticleId);
            Assert.Null(target.ExpectedTargetRevision);
        });
        Assert.False(plan.RequireExecutionAuthority().IsValid);
        Assert.Equal("article_package_import_authority_unavailable", plan.RequireExecutionAuthority().ReasonCode);
        AssertCriticalAuthorities(plan);
        Assert.Equal(plan.RequiredAuthorities.Count, plan.RequiredAuthorities.Distinct(StringComparer.Ordinal).Count());
        Assert.True(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, s_created).IsValid);
    }

    [Fact]
    public void UpdateRequested_UsesOnlyCompleteExplicitTargetsAndRemainsUnqualified()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        ArticlePackageImportRequestedTarget[] targets = Targets(2);
        ArticlePackageImportCandidatePlan plan = Create(candidate, Request(ArticlePackageImportCandidateMode.UpdateRequested, targets));

        Assert.All(plan.Targets, target => Assert.False(target.RequiresNewIdentity));
        Assert.Equal(targets.Select(target => target.PortableArticle.Value).Order(StringComparer.Ordinal),
            plan.Targets.Select(target => target.PortableArticle.Value));
        foreach (ArticlePackageImportCandidateTarget target in plan.Targets)
        {
            ArticlePackageImportRequestedTarget requested = Assert.Single(targets, row => row.PortableArticle == target.PortableArticle);
            Assert.Equal(requested.RequestedTargetArticleId, target.RequestedTargetArticleId);
            Assert.Equal(requested.ExpectedTargetRevision, target.ExpectedTargetRevision);
        }
        Assert.False(plan.RequireExecutionAuthority().IsValid);
    }

    [Fact]
    public void PlanDigest_IsOrderIndependentButBindsEveryExplicitUpdateTarget()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        ArticlePackageImportRequestedTarget[] targets = Targets(2);
        ArticlePackageImportCandidateRequest forward = Request(ArticlePackageImportCandidateMode.UpdateRequested, targets);
        ArticlePackageImportCandidatePlan plan = Create(candidate, forward);
        ArticlePackageImportCandidatePlan reverse = Create(candidate, forward with
        {
            RequestedTargets = targets.Reverse().ToArray()
        });
        Assert.Equal(plan.PlanDigest, reverse.PlanDigest);
        Assert.True(plan.ValidateRequestBinding(forward with
        {
            RequestedTargets = targets.Reverse().ToArray()
        }, candidate.PackageBytesDigest, s_created.AddTicks(1)).IsValid);
        targets[0] = targets[0] with
        {
            ExpectedTargetRevision = targets[0].ExpectedTargetRevision + 1
        };
        Assert.NotEqual(plan.PlanDigest, Create(candidate, Request(ArticlePackageImportCandidateMode.UpdateRequested, targets)).PlanDigest);
    }

    [Fact]
    public void PlanDigest_MatchesIndependentBigEndianFramedGoldenWithExactUtcTicks()
    {
        // Fixed vector independently reconstructed in Python from the documented framing.
        // It binds all three finite component digests without asserting complete import authority.
        ArticlePackageValidatedImportCandidate candidate = Candidate();
        Assert.Equal("12ddf1160accf085dc2609c0cf8b2b983bfe26b12f9b2d57cb35c3eb5f5122e0", candidate.Manifest.SemanticDigest);
        Assert.Equal("2f812ed9310b8fbf5ea512d69f738de49fa7f592aea1dbf9f5896c8ebd70ec7b", candidate.ChecksumComponentDigest);
        Assert.Equal("8ecdfa53aa9d0d5203ab2b1a88e79405e5daed5ccb0f90aa618f3fb49bd5801f", candidate.PackageBytesDigest);
        ArticlePackageImportCandidateRequest request = Request(ArticlePackageImportCandidateMode.UpdateRequested, Targets(1)) with
        {
            CreatedAtUtc = s_created.AddTicks(1234567),
            ExpiresAtUtc = s_created.AddMinutes(30).AddTicks(7654321)
        };
        Assert.Equal(639270181231234567L, request.CreatedAtUtc.Ticks);
        Assert.Equal(639270199237654321L, request.ExpiresAtUtc.Ticks);

        ArticlePackageImportCandidatePlan plan = Create(candidate, request);

        Assert.Equal("983ba5154fc408bbdbd16ec554a16b24b6af86f6306e7f758e247a98b016206a", plan.PlanDigest);
        Assert.False(plan.RequireExecutionAuthority().IsValid);
    }

    [Fact]
    public void PlanDigest_BindsFinitePackageBytesEvenWithIdenticalCallerIntent()
    {
        ArticlePackageValidatedImportCandidate original = Candidate(markdown: "exact source\n");
        ArticlePackageValidatedImportCandidate changed = Candidate(markdown: "exact source\r\n");
        ArticlePackageImportCandidateRequest request = Request();
        ArticlePackageImportCandidatePlan plan = Create(original, request);

        Assert.NotEqual(original.PackageBytesDigest, changed.PackageBytesDigest);
        Assert.NotEqual(plan.PlanDigest, Create(changed, request).PlanDigest);
        Assert.False(plan.ValidateRequestBinding(request, changed.PackageBytesDigest, s_created).IsValid);
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("site")]
    [InlineData("permission")]
    [InlineData("policy")]
    [InlineData("mode")]
    [InlineData("created")]
    [InlineData("expires")]
    [InlineData("target-id")]
    [InlineData("target-revision")]
    [InlineData("portable-identity")]
    [InlineData("targets-missing")]
    [InlineData("targets-extra")]
    public void Binding_RefusesDriftInEveryFrozenRequestCoordinate(string fault)
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        ArticlePackageImportRequestedTarget[] targets = Targets(2);
        ArticlePackageImportCandidateRequest original = Request(ArticlePackageImportCandidateMode.UpdateRequested, targets);
        ArticlePackageImportCandidatePlan plan = Create(candidate, original);
        ArticlePackageImportCandidateRequest changed = fault switch
        {
            "actor" => original with { Actor = s_actor with { ActorIdentity = "actor:other" } },
            "site" => original with { Actor = s_actor with { SiteIdentity = "site:other" } },
            "permission" => original with { Actor = s_actor with { PermissionContextDigest = new string('c', 64) } },
            "policy" => original with { PolicyDigest = new string('c', 64) },
            "mode" => original with { Mode = ArticlePackageImportCandidateMode.CreateNew, RequestedTargets = null },
            "created" => original with { CreatedAtUtc = original.CreatedAtUtc.AddTicks(-1) },
            "expires" => original with { ExpiresAtUtc = original.ExpiresAtUtc.AddTicks(1) },
            "target-id" => original with { RequestedTargets = [targets[0] with { RequestedTargetArticleId = 999 }, targets[1]] },
            "target-revision" => original with { RequestedTargets = [targets[0] with { ExpectedTargetRevision = 999 }, targets[1]] },
            "portable-identity" => original with { RequestedTargets = [targets[0] with { PortableArticle = Identity(3) }, targets[1]] },
            "targets-missing" => original with { RequestedTargets = [targets[0]] },
            _ => original with { RequestedTargets = [.. targets, new(Identity(3), 999, 1)] }
        };

        Assert.False(plan.ValidateRequestBinding(changed, candidate.PackageBytesDigest, s_created.AddMinutes(1)).IsValid);
        Assert.True(plan.ValidateRequestBinding(original, candidate.PackageBytesDigest, s_created.AddMinutes(1)).IsValid);
    }

    [Theory]
    [InlineData("different")]
    [InlineData("null")]
    [InlineData("uppercase")]
    [InlineData("malformed")]
    public void Binding_RefusesPackageByteDigestDriftEvenForOtherwiseIdenticalRequest(string fault)
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate();
        ArticlePackageImportCandidateRequest request = Request();
        ArticlePackageImportCandidatePlan plan = Create(candidate, request);
        string? digest = fault switch
        {
            "different" => new string('0', 64),
            "null" => null,
            "uppercase" => candidate.PackageBytesDigest.ToUpperInvariant(),
            _ => "sha256:" + candidate.PackageBytesDigest
        };

        Assert.False(plan.ValidateRequestBinding(request, digest, s_created).IsValid);
        Assert.False(plan.ValidateRequestBinding(null, candidate.PackageBytesDigest, s_created).IsValid);
    }

    [Fact]
    public void Binding_UsesUtcInclusiveCreatedAndExclusiveExpiryWithTickPrecision()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate();
        ArticlePackageImportCandidateRequest request = Request();
        ArticlePackageImportCandidatePlan plan = Create(candidate, request);

        Assert.True(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, request.CreatedAtUtc).IsValid);
        Assert.True(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, request.ExpiresAtUtc.AddTicks(-1)).IsValid);
        Assert.False(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, request.CreatedAtUtc.AddTicks(-1)).IsValid);
        Assert.False(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, request.ExpiresAtUtc).IsValid);
        Assert.False(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, request.ExpiresAtUtc.AddTicks(1)).IsValid);
        Assert.False(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, DateTime.SpecifyKind(s_created, DateTimeKind.Unspecified)).IsValid);
        Assert.False(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, DateTime.SpecifyKind(s_created, DateTimeKind.Local)).IsValid);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("empty")]
    [InlineData("incomplete")]
    [InlineData("extra")]
    [InlineData("duplicate-portable")]
    [InlineData("duplicate-target")]
    [InlineData("unknown-portable")]
    [InlineData("default-portable")]
    [InlineData("null-row")]
    [InlineData("zero-id")]
    [InlineData("negative-id")]
    [InlineData("zero-revision")]
    [InlineData("negative-revision")]
    public void UpdateRequested_RejectsIncompleteAliasedAndInvalidTargetsWithoutFallback(string fault)
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        ArticlePackageImportRequestedTarget[] targets = Targets(2);
        IReadOnlyList<ArticlePackageImportRequestedTarget>? changed = fault switch
        {
            "missing" => null,
            "empty" => [],
            "incomplete" => [targets[0]],
            "extra" => [.. targets, new(Identity(3), 999, 1)],
            "duplicate-portable" => [targets[0], targets[1] with { PortableArticle = targets[0].PortableArticle }],
            "duplicate-target" => [targets[0], targets[1] with { RequestedTargetArticleId = targets[0].RequestedTargetArticleId }],
            "unknown-portable" => [targets[0], targets[1] with { PortableArticle = Identity(3) }],
            "default-portable" => [targets[0], targets[1] with { PortableArticle = default }],
            "null-row" => [targets[0], null!],
            "zero-id" => [targets[0] with { RequestedTargetArticleId = 0 }, targets[1]],
            "negative-id" => [targets[0] with { RequestedTargetArticleId = -1 }, targets[1]],
            "zero-revision" => [targets[0] with { ExpectedTargetRevision = 0 }, targets[1]],
            _ => [targets[0] with { ExpectedTargetRevision = -1 }, targets[1]]
        };

        Reject(candidate, Request(ArticlePackageImportCandidateMode.UpdateRequested, changed));
        Assert.All(Create(candidate, Request()).Targets, target => Assert.True(target.RequiresNewIdentity));
    }

    [Theory]
    [InlineData("actor-null")]
    [InlineData("actor-empty")]
    [InlineData("permission-invalid")]
    [InlineData("policy-empty")]
    [InlineData("policy-uppercase")]
    [InlineData("mode-zero")]
    [InlineData("mode-unknown")]
    [InlineData("created-unspecified")]
    [InlineData("expiry-local")]
    [InlineData("expiry-equal")]
    [InlineData("expiry-earlier")]
    [InlineData("create-with-target")]
    public void Planner_RejectsInvalidGlobalRequestBeforeReturningAnyPlan(string fault)
    {
        ArticlePackageImportCandidateRequest original = Request();
        ArticlePackageImportCandidateRequest changed = fault switch
        {
            "actor-null" => original with { Actor = null! },
            "actor-empty" => original with { Actor = s_actor with { ActorIdentity = "" } },
            "permission-invalid" => original with { Actor = s_actor with { PermissionContextDigest = "bad" } },
            "policy-empty" => original with { PolicyDigest = "" },
            "policy-uppercase" => original with { PolicyDigest = s_policyDigest.ToUpperInvariant() },
            "mode-zero" => original with { Mode = 0 },
            "mode-unknown" => original with { Mode = (ArticlePackageImportCandidateMode)3 },
            "created-unspecified" => original with { CreatedAtUtc = DateTime.SpecifyKind(s_created, DateTimeKind.Unspecified) },
            "expiry-local" => original with { ExpiresAtUtc = DateTime.SpecifyKind(original.ExpiresAtUtc, DateTimeKind.Local) },
            "expiry-equal" => original with { ExpiresAtUtc = s_created },
            "expiry-earlier" => original with { ExpiresAtUtc = s_created.AddTicks(-1) },
            _ => original with { RequestedTargets = Targets(1) }
        };

        Reject(Candidate(), changed);
    }

    [Fact]
    public void Plan_FreezesCallerTargetListAndExposesReadonlyTargetsAndAuthorities()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        ArticlePackageImportRequestedTarget[] targets = Targets(2);
        ArticlePackageImportCandidateRequest request = Request(ArticlePackageImportCandidateMode.UpdateRequested, targets);
        ArticlePackageImportCandidatePlan plan = Create(candidate, request);
        string digest = plan.PlanDigest;
        targets[0] = targets[0] with
        {
            ExpectedTargetRevision = 999
        };

        Assert.Equal(10, plan.Targets[0].ExpectedTargetRevision);
        Assert.Equal(digest, plan.PlanDigest);
        Assert.False(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, s_created).IsValid);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageImportCandidateTarget>)plan.Targets)[0] = plan.Targets[1]);
        Assert.Throws<NotSupportedException>(() => ((IList<string>)plan.RequiredAuthorities)[0] = "forged");
    }

    [Fact]
    public void Planner_CopiesBoundedTargetsWithOneCountReadAndNoEnumeration()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        var targets = new IndexOnlyTargets(Targets(2), 2, 1001);
        ArticlePackageImportCandidatePlan plan = Create(candidate, Request(ArticlePackageImportCandidateMode.UpdateRequested, targets));

        Assert.Equal(2, plan.Targets.Count);
        Assert.Equal(1, targets.CountReads);
        Assert.Equal(2, targets.IndexReads);
        Assert.Equal(0, targets.EnumeratorReads);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(1001)]
    public void Planner_RejectsTargetCountBeforeReadingAnyItem(int count)
    {
        var targets = new IndexOnlyTargets([], count, 0);

        Reject(Candidate(), Request(ArticlePackageImportCandidateMode.UpdateRequested, targets));
        Assert.Equal(1, targets.CountReads);
        Assert.Equal(0, targets.IndexReads);
        Assert.Equal(0, targets.EnumeratorReads);
    }

    [Fact]
    public void Planner_IndexFailureAndRepeatedFailureNeverReturnPartialPlanOrPoisonLaterRun()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        ArticlePackageImportCandidateRequest valid = Request(ArticlePackageImportCandidateMode.UpdateRequested, Targets(2));
        string digest = Create(candidate, valid).PlanDigest;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            var targets = new IndexOnlyTargets(Targets(2), 2, 2, failIndex: 1);
            Reject(candidate, valid with
            {
                RequestedTargets = targets
            });
            Assert.Equal(0, targets.EnumeratorReads);
            Assert.Equal(digest, Create(candidate, valid).PlanDigest);
        }
        Reject(null, valid);
        Reject(candidate, null);
    }

    [Fact]
    public void Planner_CancellationBeforeAndDuringBoundedCopyNeverReturnsPartialPlan()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(2);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidatePlanner.TryCreatePlan(candidate, Request(), out var plan, cancelled.Token);
        Assert.False(result.IsValid);
        Assert.Null(plan);
        using var during = new CancellationTokenSource();
        var targets = new IndexOnlyTargets(Targets(2), 2, 2, afterFirstIndex: during.Cancel);
        result = ArticlePackageImportCandidatePlanner.TryCreatePlan(candidate,
            Request(ArticlePackageImportCandidateMode.UpdateRequested, targets), out plan, during.Token);
        Assert.False(result.IsValid);
        Assert.Null(plan);
        Assert.Single(Create(Candidate(), Request()).Targets);
    }

    [Fact]
    public void Planner_AcceptsOneThousandExplicitTargetsButAlwaysRequiresGlobalAuthority()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(1000);
        ArticlePackageImportCandidateRequest request = Request(ArticlePackageImportCandidateMode.UpdateRequested, Targets(1000));
        ArticlePackageImportCandidatePlan plan = Create(candidate, request);

        Assert.Equal(1000, plan.Targets.Count);
        Assert.False(plan.RequireExecutionAuthority().IsValid);
        AssertCriticalAuthorities(plan);
        Assert.Equal(plan.PlanDigest, Create(candidate, request with
        {
            RequestedTargets = Targets(1000).Reverse().ToArray()
        }).PlanDigest);
        Assert.True(plan.ValidateRequestBinding(request, candidate.PackageBytesDigest, s_created).IsValid);
    }

    private static ArticlePackageImportCandidatePlan Create(ArticlePackageValidatedImportCandidate candidate, ArticlePackageImportCandidateRequest request)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidatePlanner.TryCreatePlan(candidate, request, out var plan);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageImportCandidatePlan>(plan);
    }

    private static void Reject(ArticlePackageValidatedImportCandidate? candidate, ArticlePackageImportCandidateRequest? request)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidatePlanner.TryCreatePlan(candidate, request, out var plan);
        Assert.False(result.IsValid);
        Assert.False(string.IsNullOrWhiteSpace(result.ReasonCode));
        Assert.Null(plan);
    }

    private static ArticlePackageImportCandidateRequest Request(ArticlePackageImportCandidateMode mode = ArticlePackageImportCandidateMode.CreateNew,
        IReadOnlyList<ArticlePackageImportRequestedTarget>? targets = null)
        => new(s_actor, mode, s_policyDigest, s_created, s_created.AddMinutes(30), targets);

    private static ArticlePackageImportRequestedTarget[] Targets(int count)
        => Enumerable.Range(1, count).Select(index => new ArticlePackageImportRequestedTarget(Identity(index), 10000 + index, 10)).ToArray();

    private static ArticlePackageIdentity Identity(int index)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
            $"article:{index:x8}-0000-4000-8000-000000000001", out var identity).IsValid);
        return identity;
    }

    private static ArticlePackageValidatedImportCandidate Candidate(int count = 1, string markdown = "exact source\r\n")
    {
        byte[] raw = System.Text.Encoding.UTF8.GetBytes(markdown);
        Assert.True(ArticlePackageSourceBytes.Inspect(raw, out var metadata).IsValid);
        ArticlePackageManifestArticle[] articles = Enumerable.Range(1, count).Select(index =>
            new ArticlePackageManifestArticle(Identity(index),
                new(index, 1000 + index, 3, new string('c', 64), "site:primary", 1, null, null, null),
                "Caller supplied title", null, new string('d', 64), new string('e', 64), new string('f', 64),
                metadata!, new(0, null, null))).ToArray();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, out var manifest).IsValid);
        var files = new List<ArticlePackageFileBytes>
        {
            new(ArticlePackageInventory.ManifestPath, ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!))
        };
        files.AddRange(articles.Select(article => new ArticlePackageFileBytes($"articles/{article.PortableArticle.FileNameToken}.md", raw)));
        ArticlePackageInventoryEntry[] inventory = [.. files.Select(file => Entry(file.Path, file.Bytes.Length)),
            Entry(ArticlePackageInventory.ChecksumsPath, 0)];
        ArticlePackageChecksumEntry[] rows = files.Select(file => new ArticlePackageChecksumEntry(file.Path,
            file.Bytes.Length, Convert.ToHexStringLower(SHA256.HashData(file.Bytes.Span)))).ToArray();
        ArticlePackageChecksumValidationResult checksum = ArticlePackageChecksums.ComputeComponentDigest(inventory, rows);
        Assert.True(checksum.IsValid, checksum.ReasonCode);
        byte[] document = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = ArticlePackageChecksums.Schema,
            version = ArticlePackageChecksums.Version,
            algorithm = ArticlePackageChecksums.Algorithm,
            componentDigest = checksum.ComponentDigest,
            files = rows.Select(row => new
            {
                path = row.Path,
                byteLength = row.ByteLength,
                sha256 = row.Sha256
            })
        });
        inventory[^1] = Entry(ArticlePackageInventory.ChecksumsPath, document.Length);
        files.Add(new(ArticlePackageInventory.ChecksumsPath, document));
        Assert.True(ArticlePackageChecksums.Verify(inventory, files).IsValid);
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidateBytes.Validate(inventory, files, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageValidatedImportCandidate>(candidate);
    }

    private static ArticlePackageInventoryEntry Entry(string path, int length)
        => new(path, ArticlePackageEntryKind.RegularFile, length, length);

    private static void AssertCriticalAuthorities(ArticlePackageImportCandidatePlan plan)
    {
        Assert.Contains("complete_package_schema", plan.RequiredAuthorities);
        Assert.Contains("fsusui_syntax_dependencies", plan.RequiredAuthorities);
        Assert.Contains("persisted_relation_and_embed_plan", plan.RequiredAuthorities);
        Assert.Contains("frozen_public_projection_retention", plan.RequiredAuthorities);
        Assert.Contains("current_actor_site_target_permissions", plan.RequiredAuthorities);
        Assert.Contains("execution_qualification", plan.RequiredAuthorities);
    }

    private sealed class IndexOnlyTargets(ArticlePackageImportRequestedTarget[] values, int firstCount, int laterCount,
        int failIndex = -1, Action? afterFirstIndex = null) : IReadOnlyList<ArticlePackageImportRequestedTarget>
    {
        public int CountReads
        {
            get;
            private set;
        }
        public int IndexReads
        {
            get;
            private set;
        }
        public int EnumeratorReads
        {
            get;
            private set;
        }
        public int Count
        {
            get
            {
                CountReads++;
                int countReads = CountReads;
                return countReads == 1 ? firstCount : laterCount;
            }
        }
        public ArticlePackageImportRequestedTarget this[int index]
        {
            get
            {
                IndexReads++;
                if (index == failIndex)
                {
                    throw new IndexOutOfRangeException();
                }
                ArticlePackageImportRequestedTarget value = values[index];
                if (index == 0)
                {
                    afterFirstIndex?.Invoke();
                }
                return value;
            }
        }

        public IEnumerator<ArticlePackageImportRequestedTarget> GetEnumerator()
        {
            EnumeratorReads++;
            throw new InvalidOperationException("Caller targets must use bounded index copy.");
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
