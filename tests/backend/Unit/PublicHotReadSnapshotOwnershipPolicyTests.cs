using System.Buffers;
using System.Collections.Frozen;
using System.IO.Pipelines;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Control;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadSnapshotOwnershipPolicyTests
{
    [Fact]
    public void ExistingConfigurationSectionBindsRequiredInputsWithoutNumericalDefaults()
    {
        using var fixture = new Fixture();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["PublicHotRead:SnapshotOwnership:Revision"] = "1",
            ["PublicHotRead:SnapshotOwnership:AccountingRevision"] = "1",
            ["PublicHotRead:SnapshotOwnership:MaximumHolds"] = "5",
            ["PublicHotRead:SnapshotOwnership:MaximumRepresentations"] = "4",
            ["PublicHotRead:SnapshotOwnership:MaximumLeases"] = "1",
            ["PublicHotRead:SnapshotOwnership:MaximumSnapshots"] = "2",
            ["PublicHotRead:SnapshotOwnership:MaximumConsumers"] = "3",
            ["PublicHotRead:SnapshotOwnership:MetadataUpperBoundBytes"] = "512",
            ["PublicHotRead:SnapshotOwnership:MetadataCapacityBytes"] = "1024",
            ["PublicHotRead:SnapshotOwnership:MetadataHeadroomBytes"] = "64",
            ["PublicHotRead:SnapshotOwnership:ReleaseDisposition"] = "FinalSharedHold",
            ["PublicHotRead:SnapshotOwnership:ReloadDisposition"] = "DrainBeforeApply"
        }).Build();
        using ServiceProvider services = new ServiceCollection()
            .Configure<PublicHotReadOptions>(configuration.GetSection("PublicHotRead"))
            .BuildServiceProvider();
        PublicHotReadOptions options = services.GetRequiredService<IOptions<PublicHotReadOptions>>().Value;
        Assert.True(fixture.Resolve(options).Succeeded);
        Assert.Null(new PublicHotReadOptions().SnapshotOwnership);
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Resolve(new PublicHotReadOptions()).Failure);
        Assert.Equal(MemoryCapabilityMode.Auto, MemoryCapabilityPolicy.Parse(null));
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Theory]
    [InlineData("Revision")]
    [InlineData("AccountingRevision")]
    [InlineData("MaximumHolds")]
    [InlineData("MaximumRepresentations")]
    [InlineData("MaximumLeases")]
    [InlineData("MaximumSnapshots")]
    [InlineData("MaximumConsumers")]
    [InlineData("MetadataUpperBoundBytes")]
    [InlineData("MetadataCapacityBytes")]
    [InlineData("MetadataHeadroomBytes")]
    [InlineData("ReleaseDisposition")]
    [InlineData("ReloadDisposition")]
    public void MissingRequiredFieldCannotCreatePolicyOrReserveResources(string field)
    {
        using var fixture = new Fixture();
        PublicHotReadOptions options = Options();
        typeof(PublicHotReadSnapshotOwnershipOptions).GetProperty(field)!.SetValue(options.SnapshotOwnership, null);
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Resolve(options).Failure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["metadata"]);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("consumers")]
    [InlineData("holds")]
    [InlineData("leases")]
    [InlineData("capacity")]
    [InlineData("headroom")]
    [InlineData("release")]
    [InlineData("reload")]
    public void InvalidFiniteValuesRejectBeforeChangingTheOriginalPolicy(string invalid)
    {
        using var fixture = new Fixture();
        Assert.False(fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(Options()).Value!).Value!.Draining);
        PublicHotReadOptions options = Options();
        PublicHotReadSnapshotOwnershipOptions values = options.SnapshotOwnership!;
        switch (invalid)
        {
            case "revision":
                values.Revision = 0;
                break;
            case "consumers":
                values.MaximumConsumers = -1;
                break;
            case "holds":
                values.MaximumSnapshots = int.MaxValue;
                values.MaximumConsumers = int.MaxValue;
                break;
            case "leases":
                values.MaximumLeases = 5;
                break;
            case "capacity":
                values.MetadataUpperBoundBytes = long.MaxValue;
                break;
            case "headroom":
                values.MetadataHeadroomBytes = -1;
                break;
            case "release":
                values.ReleaseDisposition = (PublicHotReadOwnershipReleaseDisposition)99;
                break;
            case "reload":
                values.ReloadDisposition = (PublicHotReadOwnershipReloadDisposition)99;
                break;
        }
        Assert.Equal(MemoryFailure.BoundsViolation, fixture.Resolve(options).Failure);
        Candidate source = fixture.CreateCandidate();
        PublicHotReadSnapshot snapshot = fixture.Attach(source);
        Assert.Equal(576, fixture.Ledger.Snapshot().Used["metadata"]);
        snapshot.DisposeUnpublishedHostOwnership();
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["metadata"]);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("unqualified")]
    [InlineData("unfrozen")]
    [InlineData("future")]
    [InlineData("candidate")]
    [InlineData("digest")]
    public void MissingUnfrozenOrMismatchedBaselineDoesNotGrantAdmission(string invalid)
    {
        using var fixture = new Fixture();
        MemoryGovernorBaselineBinding? baseline = Baseline();
        baseline = invalid switch
        {
            "missing" => null,
            "unqualified" => baseline with { Qualification = MemoryQualification.NotVerified },
            "unfrozen" => baseline with { FrozenAt = default },
            "future" => baseline with { FrozenAt = fixture.Now.AddMinutes(1) },
            "candidate" => baseline with { CandidateCommit = new string('f', 40) },
            "digest" => baseline with { EvidenceDigest = "missing" },
            _ => throw new ArgumentException("Unknown fixture.")
        };
        Assert.Equal(MemoryFailure.TierUnavailable, fixture.Resolve(Options(), baseline).Failure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Fact]
    public void ActualDomainUnitsAndAccountingRevisionAreRequired()
    {
        using var fixture = new Fixture();
        Assert.Equal(MemoryFailure.BoundsViolation, PublicHotReadSnapshotOwnershipPolicy.TryCreate(
            Options(), fixture.Ledger, fixture.Operations, fixture.Metadata, Baseline(), FreezeFixture(Options()), CandidateCommit, fixture.Now).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable, PublicHotReadSnapshotOwnershipPolicy.TryCreate(
            Options(), fixture.Ledger, new(Guid.NewGuid()), fixture.Operations, Baseline(), FreezeFixture(Options()), CandidateCommit, fixture.Now).Failure);
        PublicHotReadOptions options = Options();
        options.SnapshotOwnership!.AccountingRevision = 2;
        Assert.Equal(MemoryFailure.StaleLocation, fixture.Resolve(options).Failure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Fact]
    public void ConfigurationCannotSubstituteDifferentValuesForTheFrozenOwnerInput()
    {
        using var fixture = new Fixture();
        PublicHotReadOptions options = Options();
        PublicHotReadSnapshotOwnershipLimits frozen = FreezeFixture(options);
        options.SnapshotOwnership!.MetadataUpperBoundBytes = 600;
        Assert.Equal(MemoryFailure.TierUnavailable, PublicHotReadSnapshotOwnershipPolicy.TryCreate(
            options, fixture.Ledger, fixture.Metadata, fixture.Operations, Baseline(), frozen, CandidateCommit, fixture.Now).Failure);
        Assert.Equal(MemoryFailure.TierUnavailable, PublicHotReadSnapshotOwnershipPolicy.TryCreate(
            Options(), fixture.Ledger, fixture.Metadata, fixture.Operations, Baseline(), null, CandidateCommit, fixture.Now).Failure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Fact]
    public void FrozenValuesAreCopiedAndTheRealVectorIncludesExplicitHeadroom()
    {
        using var fixture = new Fixture();
        PublicHotReadOptions options = Options();
        PublicHotReadSnapshotOwnershipPolicy policy = fixture.Resolve(options).Value!;
        options.SnapshotOwnership!.MaximumHolds = 999;
        options.SnapshotOwnership.MetadataUpperBoundBytes = 999;
        Assert.Equal(5, policy.MaximumHolds);
        Assert.Equal(512, policy.MetadataUpperBoundBytes);
        fixture.Store.TryApplySnapshotOwnershipPolicy(policy);
        Candidate source = fixture.CreateCandidate();
        PublicHotReadSnapshot snapshot = fixture.Attach(source);
        Assert.Equal(576, fixture.Ledger.Snapshot().Used["metadata"]);
        Assert.Equal(5, fixture.Ledger.Snapshot().Used["ownership-slots"]);
        Assert.Equal(1, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(1, fixture.Ledger.Snapshot().Allocations);
        snapshot.DisposeUnpublishedHostOwnership();
        snapshot.DisposeUnpublishedHostOwnership();
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["metadata"]);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["ownership-slots"]);
    }

    [Fact]
    public void ExplicitZeroHeadroomMeansNoExtraReservationRatherThanOmission()
    {
        using var fixture = new Fixture();
        PublicHotReadOptions options = Options();
        options.SnapshotOwnership!.MetadataHeadroomBytes = 0;
        fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(options).Value!);
        PublicHotReadSnapshot snapshot = fixture.Attach(fixture.CreateCandidate());
        Assert.Equal(512, fixture.Ledger.Snapshot().Used["metadata"]);
        snapshot.DisposeUnpublishedHostOwnership();
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Theory]
    [InlineData("bytes")]
    [InlineData("slots")]
    public void ByteOrSlotExhaustionRejectsBeforeTransferringTheCallerLease(string exhausted)
    {
        using var fixture = new Fixture(metadataCap: exhausted == "bytes" ? 575 : 1152,
            operationCap: exhausted == "slots" ? 4 : 10);
        fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(Options()).Value!);
        Candidate source = fixture.CreateCandidate();
        Assert.Equal(MemoryFailure.BudgetRejected,
            fixture.Store.TryAttachSnapshotHostOwnership(source.Prepared, [source.Lease], fixture.Now).Failure);
        Assert.Equal(source.Frame, source.Lease.Memory.ToArray());
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(0, fixture.Ledger.Snapshot().Used["metadata"]);
        Assert.Equal(0, fixture.Store.Current.Version);
    }

    [Fact]
    public void RepresentationRosterRefusesAdmissionBeforeGroupAllocation()
    {
        using var fixture = new Fixture();
        PublicHotReadOptions options = Options();
        options.SnapshotOwnership!.MaximumRepresentations = 1;
        fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(options).Value!);
        Candidate source = fixture.CreateCandidate();
        Assert.Equal(MemoryFailure.BudgetRejected,
            fixture.Store.TryAttachSnapshotHostOwnership(source.Prepared, [source.Lease], fixture.Now).Failure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        Assert.Equal(source.Frame, source.Lease.Memory.ToArray());
    }

    [Fact]
    public void SnapshotAndConsumerRostersRejectWhileAggregateSlotsRemain()
    {
        using var fixture = new Fixture();
        PublicHotReadOptions options = Options();
        options.SnapshotOwnership!.MaximumSnapshots = 1;
        options.SnapshotOwnership.MaximumConsumers = 1;
        fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(options).Value!);
        PublicHotReadSnapshot snapshot = fixture.Attach(fixture.CreateCandidate());
        fixture.Store.Publish(snapshot);
        using IDisposable first = snapshot.TryRetainHostConsumption().Value!;
        Assert.Equal(MemoryFailure.BudgetRejected, snapshot.TryRetainHostConsumption().Failure);
        Assert.Throws<InsufficientMemoryException>(() => snapshot.WithoutAllArticles());
        Assert.Same(snapshot, fixture.Store.Current);
        Assert.Equal(576, fixture.Ledger.Snapshot().Used["metadata"]);
    }

    [Fact]
    public void SharedCloneKeepsBudgetAndFailedRepresentationGrowthLeavesOriginalAlive()
    {
        using var fixture = new Fixture();
        PublicHotReadOptions options = Options();
        options.SnapshotOwnership!.MaximumRepresentations = 2;
        fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(options).Value!);
        PublicHotReadSnapshot snapshot = fixture.Attach(fixture.CreateCandidate());
        Assert.Throws<InsufficientMemoryException>(() => snapshot.WithHtml("/", new(
            new byte[] { 1 }, "text/html", "fixture", "public")));
        PublicHotReadSnapshot clone = snapshot.WithoutAllArticles();
        try
        {
            snapshot.DisposeUnpublishedHostOwnership();
            Assert.Equal(576, fixture.Ledger.Snapshot().Used["metadata"]);
            Assert.True(clone.CategoryFrameReady);
        }
        finally
        {
            clone.DisposeUnpublishedHostOwnership();
        }
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Fact]
    public void StaleAccountingAndInvalidReloadLeaveTheOriginalRevisionIntact()
    {
        using var fixture = new Fixture();
        PublicHotReadSnapshotOwnershipPolicy original = fixture.Resolve(Options()).Value!;
        fixture.Store.TryApplySnapshotOwnershipPolicy(original);
        Assert.Equal(MemoryFailure.StaleLocation, fixture.Store.TryApplySnapshotOwnershipPolicy(original).Failure);
        PublicHotReadOptions next = Options();
        next.SnapshotOwnership!.Revision = 2;
        Assert.Equal(MemoryFailure.BoundsViolation,
            fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(next).Value!).Failure);
        fixture.Ledger.ReviseLimits(2, fixture.Limits());
        Candidate source = fixture.CreateCandidate();
        Assert.Equal(MemoryFailure.StaleLocation,
            fixture.Store.TryAttachSnapshotHostOwnership(source.Prepared, [source.Lease], fixture.Now).Failure);
        Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
    }

    [Fact]
    public async Task ReloadWaitsForOriginalPipeCompletionAfterPublicationDrop()
    {
        using var fixture = new Fixture();
        fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(Options()).Value!);
        Candidate old = fixture.CreateCandidate();
        fixture.Store.Publish(fixture.Attach(old));
        old.Owner.Close();
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 1, resumeWriterThreshold: 1,
            useSynchronizationContext: false));
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/binary/article/42.aeds";
        context.Request.Method = "GET";
        context.Features.Set<IHttpResponseBodyFeature>(new PipeBodyFeature(pipe.Writer));
        Task<bool> serving = PublicHotReadFastPath.TryServeAsync(context, fixture.Store, new PublicHotReadCounters(),
            () => throw new InvalidOperationException("Endpoint must not execute."),
            () => throw new InvalidOperationException("Endpoint must not execute."));
        ReadResult read = await pipe.Reader.ReadAsync();
        try
        {
            Assert.False(serving.IsCompleted);
            Candidate nextSource = fixture.CreateCandidate(version: 2);
            PublicHotReadOptions nextOptions = Options();
            nextOptions.SnapshotOwnership!.Revision = 2;
            nextOptions.SnapshotOwnership.MetadataUpperBoundBytes = 640;
            PublicHotReadSnapshotOwnershipPolicy next = fixture.Resolve(nextOptions, Baseline(revision: 2)).Value!;
            Assert.True(fixture.Store.TryApplySnapshotOwnershipPolicy(next).Value!.Draining);
            Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.TryAttachSnapshotHostOwnership(
                nextSource.Prepared, [nextSource.Lease], fixture.Now).Failure);
            fixture.Store.Invalidate("owned-policy-control", PublicHotReadInvalidationPolicy.DropToEmptyUntilPublish);
            Assert.Equal(576, fixture.Ledger.Snapshot().Used["metadata"]);
            Assert.Equal(MemoryFailure.TierUnavailable, fixture.Store.TryAttachSnapshotHostOwnership(
                nextSource.Prepared, [nextSource.Lease], fixture.Now).Failure);
            Assert.Equal(old.Frame, read.Buffer.ToArray());
            pipe.Reader.AdvanceTo(read.Buffer.End);
            Assert.True(await serving);
            Assert.Equal(0, fixture.Ledger.Snapshot().Used["metadata"]);
            PublicHotReadSnapshot nextSnapshot = fixture.Attach(nextSource);
            Assert.Equal(704, fixture.Ledger.Snapshot().Used["metadata"]);
            nextSnapshot.DisposeUnpublishedHostOwnership();
            Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
        }
        finally
        {
            await pipe.Reader.CompleteAsync();
            await pipe.Writer.CompleteAsync();
        }
    }

    [Fact]
    public void RepeatedAdmittedGroupsReturnEachReservationOnce()
    {
        using var fixture = new Fixture();
        fixture.Store.TryApplySnapshotOwnershipPolicy(fixture.Resolve(Options()).Value!);
        for (int index = 0; index < 8; index++)
        {
            Candidate source = fixture.CreateCandidate();
            PublicHotReadSnapshot snapshot = fixture.Attach(source);
            source.Owner.Close();
            snapshot.DisposeUnpublishedHostOwnership();
            snapshot.DisposeUnpublishedHostOwnership();
            Assert.Equal(0, fixture.Ledger.Snapshot().Reservations);
            Assert.Equal(0, fixture.Ledger.Snapshot().Used["metadata"]);
            Assert.Equal(0, fixture.Ledger.Snapshot().Used["ownership-slots"]);
            Assert.Equal(0, fixture.Ledger.Snapshot().Allocations);
        }
    }

    private const string CandidateCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    // Declared fixture policy amounts exercise the contract, not measured CLR or production bounds.
    private static PublicHotReadOptions Options() => new()
    {
        EnablePrecompressedBinaryVariants = false,
        SnapshotOwnership = new()
        {
            Revision = 1,
            AccountingRevision = 1,
            MaximumHolds = 5,
            MaximumRepresentations = 4,
            MaximumLeases = 1,
            MaximumSnapshots = 2,
            MaximumConsumers = 3,
            MetadataUpperBoundBytes = 512,
            MetadataCapacityBytes = 1024,
            MetadataHeadroomBytes = 64,
            ReleaseDisposition = PublicHotReadOwnershipReleaseDisposition.FinalSharedHold,
            ReloadDisposition = PublicHotReadOwnershipReloadDisposition.DrainBeforeApply
        }
    };

    // Existing verifier input is controlled fixture data, never a qualification of source content.
    private static MemoryGovernorBaselineBinding Baseline(int revision = 1) => new(CandidateCommit,
        "declared-policy-fixture", new string(revision == 1 ? 'b' : 'c', 64),
        DateTimeOffset.Parse("2026-10-09T11:00:00Z").AddMinutes(revision), MemoryQualification.Qualified);

    // Declared immutable fixture values stand in for the independent policy owner's input.
    private static PublicHotReadSnapshotOwnershipLimits FreezeFixture(PublicHotReadOptions options)
    {
        PublicHotReadSnapshotOwnershipOptions values = options.SnapshotOwnership ?? new();
        return new(values.Revision ?? 0, values.AccountingRevision ?? 0, values.MaximumHolds ?? 0,
            values.MaximumRepresentations ?? 0, values.MaximumLeases ?? 0, values.MaximumSnapshots ?? 0,
            values.MaximumConsumers ?? 0, values.MetadataUpperBoundBytes ?? 0, values.MetadataCapacityBytes ?? 0,
            values.MetadataHeadroomBytes ?? 0, values.ReleaseDisposition ?? default, values.ReloadDisposition ?? default);
    }

    private sealed record Candidate(ManagedMemoryBacking Owner, IMemoryHostReadLease Lease,
        PublicHotReadSnapshot Prepared, byte[] Frame);

    private sealed class Fixture : IDisposable
    {
        private readonly List<Candidate> _sources = [];
        private readonly List<PublicHotReadSnapshot> _attached = [];
        private readonly ResourceDomainId _payload = new(Guid.NewGuid());
        private readonly ResourceDomainId _backingOperations = new(Guid.NewGuid());
        private readonly long _metadataCap;
        private readonly long _operationCap;
        public ResourceDomainId Metadata { get; } = new(Guid.NewGuid());
        public ResourceDomainId Operations { get; } = new(Guid.NewGuid());
        public DateTimeOffset Now { get; } = DateTimeOffset.Parse("2026-10-09T12:00:00Z");
        public MemoryReservationCoordinator Ledger
        {
            get;
        }
        public PublicHotReadStore Store
        {
            get;
        }

        public Fixture(long metadataCap = 1152, long operationCap = 10)
        {
            _metadataCap = metadataCap;
            _operationCap = operationCap;
            var topology = new MemoryResourceTopology([
                new(_payload, "payload", MemoryResourceUnit.Bytes, null),
                new(_backingOperations, "backing-slots", MemoryResourceUnit.OperationSlots, null),
                new(Metadata, "metadata", MemoryResourceUnit.Bytes, null),
                new(Operations, "ownership-slots", MemoryResourceUnit.OperationSlots, null)
            ]);
            Ledger = new(topology, Limits(), policyRevision: 1, entryLimit: 32, eventCapacity: 128);
            Store = new(options: Microsoft.Extensions.Options.Options.Create(Options()), timeProvider: new FixedClock(Now));
        }

        public MemoryResourceLimit[] Limits() => [
            new(_payload, MemoryResourceUnit.Bytes, 1024), new(_backingOperations, MemoryResourceUnit.OperationSlots, 8),
            new(Metadata, MemoryResourceUnit.Bytes, _metadataCap), new(Operations, MemoryResourceUnit.OperationSlots, _operationCap)
        ];

        public MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy> Resolve(PublicHotReadOptions options)
            => Resolve(options, Baseline());

        public MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy> Resolve(PublicHotReadOptions options,
            MemoryGovernorBaselineBinding? baseline)
            => PublicHotReadSnapshotOwnershipPolicy.TryCreate(options, Ledger, Metadata, Operations, baseline,
                FreezeFixture(options), CandidateCommit, Now);

        public Candidate CreateCandidate(long version = 1)
        {
            byte[] frame = new AedsEncoder().Encode(AedsFrameType.ArticleDetail, new byte[] { checked((byte)version) });
            ManagedMemoryBacking owner = ManagedMemoryBacking.TryCreate(Ledger, _payload, _backingOperations,
                new(new(Guid.NewGuid()), new(checked((ulong)version)), new(Guid.NewGuid())), new(1), new(1),
                frame, frame.Length, 8).Value!;
            IMemoryHostReadLease lease = owner.TryAcquireHostView(owner.Location).Value!;
            PublicBinaryArtifact artifact = PublicHotReadBinaryArtifactFactory.FromHostReadLease(lease,
                AedsFrameType.ArticleDetail, "public,max-age=17", version, Options());
            PublicBinaryArtifact category = PublicHotReadBinaryArtifactFactory.FromPayload(new AedsEncoder(),
                AedsFrameType.CategoryList, [], "public,max-age=17", version, Options());
            var prepared = new PublicHotReadSnapshot(version,
                new Dictionary<int, PublicBinaryArtifact> { [42] = artifact }.ToFrozenDictionary(),
                FrozenDictionary<PublicListKey, PublicBinaryArtifact>.Empty, category, default,
                FrozenDictionary<string, PublicHtmlArtifact>.Empty, PublicHotReadPublicationEvidence.CreateVerified(version, Now));
            var source = new Candidate(owner, lease, prepared, frame);
            _sources.Add(source);
            return source;
        }

        public PublicHotReadSnapshot Attach(Candidate source)
        {
            MemoryOperationResult<PublicHotReadSnapshot> result = Store.TryAttachSnapshotHostOwnership(
                source.Prepared, [source.Lease], Now);
            Assert.True(result.Succeeded, $"Fixture attachment failed: {result.Failure}");
            _attached.Add(result.Value!);
            return result.Value!;
        }

        public void Dispose()
        {
            Store.Invalidate("fixture-cleanup", PublicHotReadInvalidationPolicy.DropToEmptyUntilPublish);
            foreach (PublicHotReadSnapshot snapshot in _attached)
            {
                snapshot.DisposeUnclaimedHostOwnership();
            }
            foreach (Candidate source in _sources)
            {
                source.Lease.Dispose();
                source.Owner.Dispose();
            }
        }
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class PipeBodyFeature(PipeWriter writer) : IHttpResponseBodyFeature
    {
        public Stream Stream => Stream.Null;
        public PipeWriter Writer => writer;
        public void DisableBuffering()
        {
        }
        public Task StartAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task SendFileAsync(string path, long offset, long? count, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
        public Task CompleteAsync() => writer.CompleteAsync().AsTask();
    }
}
