using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupCounterNormalizerTests
{
    [Theory]
    [InlineData(LinuxCgroupCounter.AnonymousBytes, LinuxCgroupCounterUnit.Bytes)]
    [InlineData(LinuxCgroupCounter.FileBytes, LinuxCgroupCounterUnit.Bytes)]
    [InlineData(LinuxCgroupCounter.MajorFaults, LinuxCgroupCounterUnit.Events)]
    [InlineData(LinuxCgroupCounter.LocalHighEvents, LinuxCgroupCounterUnit.Events)]
    [InlineData(LinuxCgroupCounter.LocalMaxEvents, LinuxCgroupCounterUnit.Events)]
    [InlineData(LinuxCgroupCounter.LocalOutOfMemoryEvents, LinuxCgroupCounterUnit.Events)]
    [InlineData(LinuxCgroupCounter.LocalOutOfMemoryKillEvents, LinuxCgroupCounterUnit.Events)]
    [InlineData(LinuxCgroupCounter.PressureSomeMicroseconds, LinuxCgroupCounterUnit.Microseconds)]
    [InlineData(LinuxCgroupCounter.PressureFullMicroseconds, LinuxCgroupCounterUnit.Microseconds)]
    public void MatchingCapturesProduceDeltaOrResetWithoutRates(LinuxCgroupCounter counter, LinuxCgroupCounterUnit unit)
    {
        var previous = Counter(counter, unit, 10);
        AssertDelta(Compare(previous, previous with
        {
            Value = 17
        }), 7);
        AssertDelta(Compare(previous, previous with
        {
            Value = 10
        }), 0);
        var regression = Compare(previous, previous with
        {
            Value = 4
        });
        if (unit == LinuxCgroupCounterUnit.Bytes)
        {
            AssertDelta(regression, -6);
        }
        else
        {
            AssertRefusal(regression, MemoryPressureTransition.CounterReset);
        }
        Assert.Equal(MemoryQualification.NotVerified, previous.Qualification);
    }

    [Fact]
    public void NonnegativeExtremesRetainExactSignedGaugeDeltas()
    {
        var zero = Counter(value: 0);
        var maximum = zero with
        {
            Value = long.MaxValue
        };
        AssertDelta(Compare(zero, maximum), long.MaxValue);
        AssertDelta(Compare(maximum, zero), -long.MaxValue);
        var events = Counter(LinuxCgroupCounter.MajorFaults, LinuxCgroupCounterUnit.Events, 0);
        AssertDelta(Compare(events, events with
        {
            Value = long.MaxValue
        }), long.MaxValue);
        AssertRefusal(Compare(events with
        {
            Value = long.MaxValue
        }, events), MemoryPressureTransition.CounterReset);
    }

    [Theory]
    [InlineData(MemoryObservationState.Unknown)]
    [InlineData(MemoryObservationState.Denied)]
    [InlineData(MemoryObservationState.Malformed)]
    [InlineData(MemoryObservationState.Stale)]
    [InlineData((MemoryObservationState)99)]
    public void UnavailableCounterOrContextOnEitherSideSuppressesNumbers(MemoryObservationState state)
    {
        var capture = Counter();
        var before = Context(10, 20);
        var after = Context(30, 40);
        var transition = state == MemoryObservationState.Stale ? MemoryPressureTransition.Stale : MemoryPressureTransition.Unknown;
        AssertRefusal(Compare(capture with
        {
            State = state
        }, capture), transition);
        AssertRefusal(Compare(capture, capture with
        {
            State = state
        }), transition);
        AssertRefusal(Compare(capture, capture, before with
        {
            State = state
        }, after), transition);
        AssertRefusal(Compare(capture, capture, before, after with
        {
            State = state
        }), transition);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(-1L)]
    [InlineData(long.MinValue)]
    public void AvailableCapturesWithMissingOrNegativeValuesRemainUnknown(long? value)
    {
        var capture = Counter();
        AssertRefusal(Compare(capture with
        {
            Value = value
        }, capture), MemoryPressureTransition.Unknown);
        AssertRefusal(Compare(capture, capture with
        {
            Value = value
        }), MemoryPressureTransition.Unknown);
    }

    [Fact]
    public void EveryDirectoryIdentityCoordinateMustAgree()
    {
        var capture = Counter();
        var identity = capture.Identity;
        LinuxCgroupDirectoryIdentity[] changed =
        [
            identity with { Version = 1 },
            identity with { Inode = 102 },
            identity with { MountId = 72 },
            identity with { DeviceMajor = 1 },
            identity with { DeviceMinor = 35 }
        ];
        foreach (var item in changed)
        {
            var transition = item.Version == 1 ? MemoryPressureTransition.Unknown : MemoryPressureTransition.DomainChanged;
            AssertRefusal(Compare(capture with
            {
                Identity = item
            }, capture), transition);
            AssertRefusal(Compare(capture, capture with
            {
                Identity = item
            }), transition);
        }
        foreach (var item in new[] { identity with { Inode = 0 }, identity with { MountId = 0 } })
        {
            AssertRefusal(Compare(capture with
            {
                Identity = item
            }, capture with
            {
                Identity = item
            }), MemoryPressureTransition.Unknown);
        }
        AssertRefusal(Compare(capture with
        {
            Identity = null!
        }, capture), MemoryPressureTransition.Unknown);
    }

    [Fact]
    public void EqualDirectoryIdentitiesMustAlsoMatchTheirContextMountAndDevice()
    {
        var capture = Counter();
        var before = Context(10, 20);
        var after = Context(30, 40);
        foreach (var identity in new[]
        {
            capture.Identity with { MountId = 72 },
            capture.Identity with { DeviceMinor = 35 }
        })
        {
            AssertRefusal(Compare(capture with
            {
                Identity = identity
            }, capture with
            {
                Identity = identity
            }, before, after),
                MemoryPressureTransition.DomainChanged);
        }
        var wrongVersion = before.Scope! with
        {
            Identity = before.Scope.Identity with
            {
                Version = 1
            }
        };
        AssertRefusal(Compare(capture, capture, before with
        {
            Scope = wrongVersion
        }, after with
        {
            Scope = wrongVersion
        }),
            MemoryPressureTransition.DomainChanged);
    }

    [Fact]
    public void CounterUnitAndSourceIdentityCannotBeMixedOrInvented()
    {
        var capture = Counter();
        AssertRefusal(Compare(capture, capture with
        {
            Counter = LinuxCgroupCounter.FileBytes
        }), MemoryPressureTransition.SourceChanged);
        foreach (var invalid in new[]
        {
            capture with { Counter = (LinuxCgroupCounter)99 },
            capture with { Unit = (LinuxCgroupCounterUnit)99 },
            capture with { Unit = LinuxCgroupCounterUnit.Events }
        })
        {
            AssertRefusal(Compare(invalid, invalid), MemoryPressureTransition.Unknown);
            AssertRefusal(Compare(capture, invalid), MemoryPressureTransition.Unknown);
        }
        var before = Context(10, 20);
        var after = Context(30, 40);
        AssertRefusal(Compare(capture, capture, before, after with
        {
            Source = "another-source"
        }), MemoryPressureTransition.SourceChanged);
        AssertRefusal(Compare(capture, capture, before with
        {
            Source = " "
        }, after with
        {
            Source = " "
        }), MemoryPressureTransition.Unknown);
    }

    [Fact]
    public void NamespaceScopeAndOrderedRosterChangesSuppressNumbers()
    {
        var capture = Counter();
        var before = Context(10, 20);
        var after = Context(30, 40);
        var scope = after.Scope!;
        LinuxCgroupContextCapture[] changed =
        [
            after with { CgroupNamespaceAfter = 12 },
            after with { MountNamespaceBefore = null },
            after with { Scope = scope with { Identity = scope.Identity with { CgroupNamespaceInode = 12 } } },
            after with { Scope = scope with { Identity = scope.Identity with { MountNamespaceInode = 12 } } },
            after with { Scope = scope with { Identity = scope.Identity with { HierarchyId = 1 } } },
            after with { Scope = scope with { Identity = scope.Identity with { MembershipPath = "/tenant/other" } } },
            after with { Scope = scope with { Identity = scope.Identity with { MountRoot = "/" } } },
            after with { Scope = scope with { Identity = scope.Identity with { MountPoint = "/other" } } },
            after with { Scope = scope with { ObservableDirectories = ["/observed/groups"] } },
            after with { Scope = scope with { ObservableDirectories = ["/observed/groups", "/observed/groups/worker"] } }
        ];
        foreach (var item in changed)
        {
            AssertRefusal(Compare(capture, capture, before, item), MemoryPressureTransition.Stale);
        }
        AssertRefusal(Compare(capture, capture, before with
        {
            Scope = null
        }, after), MemoryPressureTransition.DomainChanged);
        var empty = scope with
        {
            ObservableDirectories = []
        };
        AssertRefusal(Compare(capture, capture, before with
        {
            Scope = empty
        }, after with
        {
            Scope = empty
        }), MemoryPressureTransition.DomainChanged);
    }

    [Fact]
    public void ContextExpiryAndClockDiscontinuitiesSuppressNumbers()
    {
        var capture = Counter();
        var before = Context(10, 20);
        var after = Context(30, 40);
        LinuxCgroupContextCapture[] changed =
        [
            after with { Timestamp = 19 },
            after with { CompletedTimestamp = 29 },
            after with { TimestampFrequency = 2000 },
            after with { SampledAt = before.SampledAt.AddSeconds(-1) },
            after with { SampledAt = before.SampledAt.AddSeconds(2) },
            after with { Timestamp = long.MaxValue - 1, CompletedTimestamp = long.MaxValue }
        ];
        foreach (var item in changed)
        {
            AssertRefusal(Compare(capture, capture, before, item), MemoryPressureTransition.Stale);
        }
        AssertRefusal(LinuxCgroupCounterNormalizer.Compare(capture, capture, before, after,
            before.SampledAt.AddSeconds(3), TimeSpan.FromSeconds(2)), MemoryPressureTransition.Stale);
        AssertRefusal(Compare(capture, capture, before with
        {
            Timestamp = long.MinValue,
            CompletedTimestamp = long.MinValue + 1
        }, after),
            MemoryPressureTransition.Stale);
    }

    [Fact]
    public void ContextClockSpacingNeverBecomesCounterRateEvidence()
    {
        var previous = Counter(value: 10);
        var current = Counter(value: 20);
        var before = Context(10, 20);
        var after = Context(20, 20);
        AssertDelta(Compare(previous, current, before, after), 10);
        AssertDelta(Compare(previous, current, before, after with
        {
            Timestamp = 100,
            CompletedTimestamp = 900
        }), 10);
        Assert.Equal(MemoryQualification.NotVerified, before.Qualification);
        Assert.Equal(MemoryQualification.NotVerified, before.Scope!.Qualification);
    }

    [Fact]
    public void NullArgumentsAndInvalidAgeAreRejected()
    {
        var capture = Counter();
        var before = Context(10, 20);
        var after = Context(30, 40);
        Assert.Throws<ArgumentNullException>(() => Compare(null!, capture));
        Assert.Throws<ArgumentNullException>(() => Compare(capture, null!));
        Assert.Throws<ArgumentNullException>(() => Compare(capture, capture, null!, after));
        Assert.Throws<ArgumentNullException>(() => Compare(capture, capture, before, null!));
        foreach (var age in new[] { TimeSpan.Zero, TimeSpan.FromSeconds(-1) })
        {
            Assert.Throws<ArgumentOutOfRangeException>(() => LinuxCgroupCounterNormalizer.Compare(capture, capture, before, after,
                before.SampledAt, age));
        }
    }

    private static LinuxCgroupCounterCapture Counter(LinuxCgroupCounter counter = LinuxCgroupCounter.AnonymousBytes,
        LinuxCgroupCounterUnit unit = LinuxCgroupCounterUnit.Bytes, long value = 10)
        => new(counter, unit, MemoryObservationState.Available, value, new(2, 101, 71, 0, 34));

    private static LinuxCgroupContextCapture Context(long started, long completed)
        => new(MemoryObservationState.Available, LinuxCgroupScopeReason.Ready,
            new(new(2, 0, 10, 11, 71, "0:34", "/tenant", "/tenant/worker", "/observed/groups"),
                ["/observed/groups/worker", "/observed/groups"]),
            new DateTimeOffset(2026, 10, 8, 14, 30, 0, TimeSpan.Zero), started, completed, 1000,
            "controlled-context-fixture", 10, 10, 11, 11);

    private static MemoryPressureDelta Compare(LinuxCgroupCounterCapture previous, LinuxCgroupCounterCapture current)
        => Compare(previous, current, Context(10, 20), Context(30, 40));

    private static MemoryPressureDelta Compare(LinuxCgroupCounterCapture previous, LinuxCgroupCounterCapture current,
        LinuxCgroupContextCapture before, LinuxCgroupContextCapture after)
        => LinuxCgroupCounterNormalizer.Compare(previous, current, before, after,
            Context(10, 20).SampledAt.AddSeconds(1), TimeSpan.FromSeconds(2));

    private static void AssertDelta(MemoryPressureDelta result, long expected)
    {
        Assert.Equal(MemoryPressureTransition.Comparable, result.Transition);
        Assert.Equal(expected, result.Change);
        Assert.Null(result.PerSecond);
    }

    private static void AssertRefusal(MemoryPressureDelta result, MemoryPressureTransition expected)
    {
        Assert.Equal(expected, result.Transition);
        Assert.Null(result.Change);
        Assert.Null(result.PerSecond);
    }
}
