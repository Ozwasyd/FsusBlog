using System.Collections;

using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleRelationCaptureTests
{
    private const string ArticleA = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleB = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string RevisionA = "revision:01991e72-aaaa-7a86-bc95-5518cf8bd7dc";
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    private static readonly ArticleRelationContractCoordinate s_coordinate = new(1, 1, 1, 1, 1);
    private static readonly ArticleRelationActorContext s_actor = new("actor:source", "site:primary", DigestA);
    private static readonly ArticleRelationSourceFacts s_source = new(
        ArticleA, RevisionA, 4, ArticleRelationRevisionKind.Current,
        ArticleRelationLifecycleState.Published, ArticleRelationPermissionState.Allowed, s_actor, DigestB);
    private static readonly ArticleRelationVisibilityFacts s_visibility = new(
        s_actor, new("actor:query", "site:primary", DigestB),
        ArticleRelationQueryScope.Authoring, ArticleRelationPublicContext.AuthoringActor, DigestA);
    private static readonly ArticleRelationTargetIdentity s_target = new(ArticleB, ArticleRelationTargetKind.Article, null, null);

    [Fact]
    public void Set_RemainsValidAfterCallerReplacesAndClearsItsList()
    {
        ArticleRelationRecord relation = Relation();
        List<ArticleRelationRecord> records = [relation];
        ArticleRelationSet captured = ArticleRelationContractValidator.Seal(Set(records));
        Assert.True(ArticleRelationContractValidator.Validate(captured).IsValid);
        string digest = captured.SetDigest;

        records[0] = relation with
        {
            Kind = (ArticleRelationKind)255
        };
        records.Clear();

        Assert.Equal(relation, Assert.Single(captured.Relations));
        Assert.Equal(digest, ArticleRelationDigest.ComputeSet(captured));
        Assert.True(ArticleRelationContractValidator.Validate(captured).IsValid);
        AssertReadOnly(captured.Relations);
    }

    [Fact]
    public void Candidate_RemainsValidAfterCallerReplacesAndClearsItsTargets()
    {
        List<ArticleRelationTargetIdentity> targets = [s_target];
        ArticleRelationUnlinkedMentionCandidate captured = ArticleRelationContractValidator.Seal(Candidate(targets));
        Assert.True(ArticleRelationContractValidator.Validate(captured).IsValid);
        string identity = captured.CandidateIdentity;
        string digest = captured.CandidateDigest;

        targets[0] = s_target with
        {
            ArticleIdentity = "https://example.test"
        };
        targets.Clear();

        Assert.Equal(s_target, Assert.Single(captured.CandidateTargets));
        Assert.Equal(identity, ArticleRelationDigest.ComputeCandidateIdentity(captured));
        Assert.Equal(digest, ArticleRelationDigest.ComputeCandidate(captured));
        Assert.True(ArticleRelationContractValidator.Validate(captured).IsValid);
        AssertReadOnly(captured.CandidateTargets);
    }

    [Fact]
    public void Receipt_RemainsValidAfterCallerMutatesBothDigestLists()
    {
        List<string> relations = [DigestA];
        List<string> candidates = [DigestB];
        ArticleRelationReceipt captured = ArticleRelationContractValidator.Seal(Receipt(relations, candidates));
        Assert.True(ArticleRelationContractValidator.Validate(captured).IsValid);
        string digest = captured.ReceiptDigest;

        relations[0] = "invalid";
        candidates.Clear();

        Assert.Equal(DigestA, Assert.Single(captured.RelationDigests));
        Assert.Equal(DigestB, Assert.Single(captured.CandidateDigests));
        Assert.Equal(digest, ArticleRelationDigest.ComputeReceipt(captured));
        Assert.True(ArticleRelationContractValidator.Validate(captured).IsValid);
        AssertReadOnly(captured.RelationDigests);
        AssertReadOnly(captured.CandidateDigests);
    }

    [Fact]
    public void Capture_PreservesCanonicalOrderAndDigestEncodingAndRepeatedSeals()
    {
        ArticleRelationRecord first = Relation();
        ArticleRelationRecord second = ArticleRelationContractValidator.Seal(first with
        {
            IndexVersion = 2
        });
        ArticleRelationSet set = Set([second, first]);
        ArticleRelationUnlinkedMentionCandidate candidate = Candidate([s_target, s_target with { ArticleIdentity = ArticleA }])
            with
        {
            Ambiguity = ArticleRelationMentionAmbiguity.Ambiguous
        };
        ArticleRelationReceipt receipt = Receipt([DigestB, DigestA], [DigestA, DigestB]);
        string setDigest = ArticleRelationDigest.ComputeSet(set);
        string candidateIdentity = ArticleRelationDigest.ComputeCandidateIdentity(candidate);
        string candidateDigest = ArticleRelationDigest.ComputeCandidate(candidate with
        {
            CandidateIdentity = candidateIdentity
        });
        string receiptIdentity = ArticleRelationDigest.ComputeReceipt(receipt);
        string receiptDigest = ArticleRelationDigest.ComputeReceipt(receipt with
        {
            ReceiptIdentity = receiptIdentity
        });

        ArticleRelationSet sealedSet = ArticleRelationContractValidator.Seal(set);
        ArticleRelationUnlinkedMentionCandidate sealedCandidate = ArticleRelationContractValidator.Seal(candidate);
        ArticleRelationReceipt sealedReceipt = ArticleRelationContractValidator.Seal(receipt);

        Assert.Equal([second, first], sealedSet.Relations);
        Assert.Equal(setDigest, sealedSet.SetDigest);
        Assert.Equal(candidateIdentity, sealedCandidate.CandidateIdentity);
        Assert.Equal(candidateDigest, sealedCandidate.CandidateDigest);
        Assert.Equal(receiptIdentity, sealedReceipt.ReceiptIdentity);
        Assert.Equal(receiptDigest, sealedReceipt.ReceiptDigest);
        Assert.Equal([DigestB, DigestA], sealedReceipt.RelationDigests);
        Assert.Equal([DigestA, DigestB], sealedReceipt.CandidateDigests);
        Assert.Equal(setDigest, ArticleRelationContractValidator.Seal(sealedSet).SetDigest);
        Assert.Equal(candidateDigest, ArticleRelationContractValidator.Seal(sealedCandidate).CandidateDigest);
        Assert.Equal(receiptDigest, ArticleRelationContractValidator.Seal(sealedReceipt).ReceiptDigest);
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(3, false)]
    [InlineData(0, true)]
    [InlineData(1, true)]
    [InlineData(2, true)]
    [InlineData(3, true)]
    public void InvalidCount_RefusesBeforeEnumeratorOrIndexer(int role, bool negative)
    {
        int count = negative ? -1 : Limit(role) + 1;
        ProbeList<object> probe = new(count, [Item(role)], throwOnEnumeration: true);

        ArgumentOutOfRangeException error = Assert.Throws<ArgumentOutOfRangeException>(() => Seal(role, probe));

        Assert.Equal("source", error.ParamName);
        Assert.Equal(1, probe.CountReads);
        Assert.Equal(0, probe.EnumeratorCalls);
        Assert.Equal(0, probe.IndexReads);
    }

    [Theory]
    [InlineData(0, 0, 1)]
    [InlineData(1, 0, 1)]
    [InlineData(2, 0, 1)]
    [InlineData(3, 0, 1)]
    [InlineData(0, 1, 2)]
    [InlineData(1, 1, 2)]
    [InlineData(2, 1, 2)]
    [InlineData(3, 1, 2)]
    [InlineData(0, 2, 1)]
    [InlineData(1, 2, 1)]
    [InlineData(2, 2, 1)]
    [InlineData(3, 2, 1)]
    public void CountMismatch_RefusesWithBoundedEnumerationAndDisposes(int role, int count, int actual)
    {
        ProbeList<object> probe = new(count, Enumerable.Repeat(Item(role), actual).ToArray());

        ArgumentException error = Assert.Throws<ArgumentException>(() => Seal(role, probe));

        Assert.Equal("source", error.ParamName);
        Assert.Equal(1, probe.CountReads);
        Assert.Equal(1, probe.EnumeratorCalls);
        Assert.Equal(1, probe.DisposeCalls);
        Assert.Equal(Math.Min(count, actual), probe.CurrentReads);
        Assert.Equal(Math.Min(count, actual) + 1, probe.MoveNextCalls);
        Assert.Equal(0, probe.IndexReads);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void Capture_ReadsCallerCountOnceAndEnumeratesOnce(int role)
    {
        ProbeList<object> probe = new(1, [Item(role)], rejectRepeatedCount: true);

        Seal(role, probe);

        Assert.Equal(1, probe.CountReads);
        Assert.Equal(1, probe.EnumeratorCalls);
        Assert.Equal(1, probe.DisposeCalls);
        Assert.Equal(1, probe.CurrentReads);
        Assert.Equal(2, probe.MoveNextCalls);
        Assert.Equal(0, probe.IndexReads);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void InterruptedEnumeration_DisposesAndAllowsFreshIndependentCapture(int role)
    {
        ProbeList<object> interrupted = new(1, [Item(role)], throwOnMoveNext: true);
        Assert.Throws<InvalidOperationException>(() => Seal(role, interrupted));
        Assert.Equal(1, interrupted.DisposeCalls);

        ProbeList<object> retry = new(1, [Item(role)]);
        Seal(role, retry);
        Assert.Equal(1, retry.DisposeCalls);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void ExactCollectionLimit_RemainsSealableWithoutSemanticAdmission(int role)
    {
        int count = Limit(role);
        ProbeList<object> probe = new(count, Enumerable.Repeat(Item(role), count).ToArray());

        Seal(role, probe);

        Assert.Equal(1, probe.CountReads);
        Assert.Equal(1, probe.DisposeCalls);
        Assert.Equal(count, probe.CurrentReads);
    }

    [Fact]
    public void Capture_DoesNotReplaceValidationOfResealedUnknownStates()
    {
        ArticleRelationRecord invalid = ArticleRelationContractValidator.Seal(Relation() with
        {
            Kind = (ArticleRelationKind)255
        });
        ArticleRelationSet set = ArticleRelationContractValidator.Seal(Set([invalid]));
        ArticleRelationUnlinkedMentionCandidate candidate = ArticleRelationContractValidator.Seal(Candidate([s_target])
            with
        {
            MatchRule = (ArticleRelationMentionMatchRule)255
        });
        ArticleRelationReceipt receipt = ArticleRelationContractValidator.Seal(Receipt([DigestA], [])
            with
        {
            Kind = (ArticleRelationReceiptKind)255
        });

        Assert.False(ArticleRelationContractValidator.Validate(set).IsValid);
        Assert.False(ArticleRelationContractValidator.Validate(candidate).IsValid);
        Assert.False(ArticleRelationContractValidator.Validate(receipt).IsValid);
    }

    private static void AssertReadOnly<T>(IReadOnlyList<T> captured)
    {
        IList<T> list = Assert.IsAssignableFrom<IList<T>>(captured);
        Assert.True(list.IsReadOnly);
        Assert.Throws<NotSupportedException>(() => list.Clear());
    }

    private static int Limit(int role)
        => role is 0 or 2 ? ArticleRelationContractValidator.MaxRelationsPerSet : ArticleRelationContractValidator.MaxCandidatesPerSource;

    private static object Item(int role)
        => role switch
        {
            0 => Relation(),
            1 => s_target,
            _ => DigestA
        };

    private static void Seal(int role, ProbeList<object> probe)
    {
        switch (role)
        {
            case 0:
                ArticleRelationContractValidator.Seal(Set(new TypedProbe<ArticleRelationRecord>(probe)));
                break;
            case 1:
                ArticleRelationContractValidator.Seal(Candidate(new TypedProbe<ArticleRelationTargetIdentity>(probe)));
                break;
            case 2:
                ArticleRelationContractValidator.Seal(Receipt(new TypedProbe<string>(probe), []));
                break;
            case 3:
                ArticleRelationContractValidator.Seal(Receipt([], new TypedProbe<string>(probe)));
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(role));
        }
    }

    private static ArticleRelationSet Set(IReadOnlyList<ArticleRelationRecord> relations)
        => new(ArticleRelationSchemas.RelationSet, ArticleRelationSchemas.Version, s_source, relations, string.Empty);

    private static ArticleRelationUnlinkedMentionCandidate Candidate(IReadOnlyList<ArticleRelationTargetIdentity> targets)
        => new(ArticleRelationSchemas.MentionCandidate, ArticleRelationSchemas.Version, string.Empty,
            s_source, s_visibility, new(100, 111, "Article B"), targets,
            ArticleRelationMentionMatchRule.ExactTitle, ArticleRelationMentionMatchReason.ExactText,
            ArticleRelationMentionConfidence.Certain, ArticleRelationMentionAmbiguity.Unique,
            null, false, s_coordinate, string.Empty);

    private static ArticleRelationReceipt Receipt(IReadOnlyList<string> relations, IReadOnlyList<string> candidates)
        => new(ArticleRelationSchemas.Receipt, ArticleRelationSchemas.Version, string.Empty, ArticleRelationReceiptKind.Index,
            new(ArticleA, RevisionA, 4, ArticleRelationRevisionKind.Current, s_actor, s_visibility.QueryActor,
                ArticleRelationQueryScope.Authoring, "worktree:2236", "build:capture", "parser:canonical", "renderer:server",
                1, 1, s_coordinate, DigestB), relations, candidates, 1, 1, string.Empty);

    private static ArticleRelationRecord Relation()
        => ArticleRelationContractValidator.Seal(new ArticleRelationRecord(
            ArticleRelationSchemas.Relation, ArticleRelationSchemas.Version, string.Empty, 1,
            ArticleRelationKind.Outgoing, s_source, new("[target]", new(0, 8, "[target]"), new(0, 8, "[target]"), 1),
            new(s_target, RevisionA, 7, ArticleRelationRevisionKind.Published, ArticleRelationLifecycleState.Published,
                ArticleRelationPermissionState.Allowed), s_visibility, ArticleRelationResolutionStatus.Resolved, s_coordinate, string.Empty));

    private sealed class TypedProbe<T>(ProbeList<object> source) : IReadOnlyList<T>
    {
        public int Count => source.Count;
        public T this[int index] => (T)source[index];

        public IEnumerator<T> GetEnumerator() => new TypedEnumerator(source.GetEnumerator());

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        private sealed class TypedEnumerator(IEnumerator<object> source) : IEnumerator<T>
        {
            public T Current => (T)source.Current;
            object? IEnumerator.Current => Current;
            public bool MoveNext() => source.MoveNext();
            public void Reset() => source.Reset();
            public void Dispose() => source.Dispose();
        }
    }

    private sealed class ProbeList<T>(
        int count,
        T[] values,
        bool throwOnEnumeration = false,
        bool throwOnMoveNext = false,
        bool rejectRepeatedCount = false) : IReadOnlyList<T>
    {
        private readonly T[] _values = values;
        private readonly bool _throwOnMoveNext = throwOnMoveNext;

        public int CountReads
        {
            get; private set;
        }
        public int EnumeratorCalls
        {
            get; private set;
        }
        public int MoveNextCalls
        {
            get; private set;
        }
        public int CurrentReads
        {
            get; private set;
        }
        public int IndexReads
        {
            get; private set;
        }
        public int DisposeCalls
        {
            get; private set;
        }

        public int Count
        {
            get
            {
                CountReads++;
                if (rejectRepeatedCount && CountReads > 1)
                {
                    throw new InvalidOperationException("Caller Count changed after capture.");
                }

                return count;
            }
        }

        public T this[int index]
        {
            get
            {
                IndexReads++;
                throw new InvalidOperationException("Caller indexer must not be trusted.");
            }
        }

        public IEnumerator<T> GetEnumerator()
        {
            EnumeratorCalls++;
            if (throwOnEnumeration)
            {
                throw new InvalidOperationException("An out-of-budget collection was enumerated.");
            }

            return new ProbeEnumerator(this);
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        private sealed class ProbeEnumerator(ProbeList<T> owner) : IEnumerator<T>
        {
            private int _index = -1;

            public T Current
            {
                get
                {
                    owner.CurrentReads++;
                    return owner._values[_index];
                }
            }

            object? IEnumerator.Current => Current;

            public bool MoveNext()
            {
                owner.MoveNextCalls++;
                if (owner._throwOnMoveNext)
                {
                    throw new InvalidOperationException("Enumeration interrupted.");
                }

                return ++_index < owner._values.Length;
            }

            public void Reset() => throw new NotSupportedException();

            public void Dispose() => owner.DisposeCalls++;
        }
    }
}
