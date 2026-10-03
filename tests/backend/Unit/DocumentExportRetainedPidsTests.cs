using FsusBlog.Server.Services.DocumentExport;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportRetainedPidsTests
{
    private const string RunId = "0123456789abcdef0123456789abcdef";
    private const string OtherRunId = "1123456789abcdef0123456789abcdef";
    private const string UnitName = "fsusblog-document-export-" + RunId + ".service";
    private const string SliceName = "app-fsusblogdocumentexport" + RunId + ".slice";
    private const string AccountingGroup = "/user.slice/user-1000.slice/user@1000.service/app.slice/" + SliceName;

    [Fact]
    public void BindsOneExactRunServiceAndItsPrivateAccountingSlice()
    {
        Assert.Equal(SliceName, DocumentExportSystemdCgroupAuthority.AccountingSliceName(RunId));
        DocumentExportSystemdCgroupAuthority.ValidateAccountingIdentity(
            RunId,
            UnitName,
            SliceName,
            AccountingGroup + "/" + UnitName,
            AccountingGroup);
        Assert.NotEqual(SliceName, DocumentExportSystemdCgroupAuthority.AccountingSliceName(OtherRunId));
    }

    [Fact]
    public void BatchedInspectionBindsEveryExactUnitWithoutDependingOnOutputOrder()
    {
        string service = $"Id={UnitName}\nLoadState=not-found\n";
        string slice = $"Id={SliceName}\nLoadState=loaded\n";
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> result =
            DocumentExportSystemdCgroupAuthority.ParseUnitPropertyBlocks(
                slice + "\n" + service,
                [UnitName, SliceName],
                ["Id", "LoadState"]);

        Assert.Equal(2, result.Count);
        Assert.Equal("not-found", result[UnitName]["LoadState"]);
        Assert.Equal("loaded", result[SliceName]["LoadState"]);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public void BatchedInspectionRefusesMissingDuplicateForeignOrMalformedUnits(int mutation)
    {
        string service = $"Id={UnitName}\nLoadState=not-found\n";
        string slice = $"Id={SliceName}\nLoadState=loaded\n";
        string output = mutation switch
        {
            0 => service,
            1 => service + "\n" + service,
            2 => service + "\nId=foreign.slice\nLoadState=loaded\n",
            3 => service + "Unknown=value\n\n" + slice,
            4 => service + $"Id={UnitName}\n\n" + slice,
            _ => $"Id={UnitName}\n\n" + slice
        };

        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ParseUnitPropertyBlocks(
            output,
            [UnitName, SliceName],
            ["Id", "LoadState"]));
    }

    [Theory]
    [InlineData(true, true, true, true)]
    [InlineData(false, true, true, false)]
    [InlineData(true, false, true, false)]
    [InlineData(true, true, false, false)]
    public void AdmissionRecoveryRequiresOwnedDispatchAndActualCallerCancellation(
        bool unitMayExist,
        bool cancellationException,
        bool callerRequested,
        bool expected)
    {
        Exception failure = cancellationException ? new TaskCanceledException() : new InvalidDataException();

        Assert.Equal(expected, DocumentExportSystemdCgroupAuthority.ShouldRecoverCancelledAdmission(
            unitMayExist,
            failure,
            callerRequested));
    }

    [Theory]
    [InlineData(true, true, true)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(false, false, false)]
    public void UnknownDispatchReplyCannotQualifyEvenAnOtherwiseEmptyCleanup(
        bool dispatchAcknowledged, bool cleanupQualified, bool expected)
        => Assert.Equal(expected, DocumentExportSystemdCgroupAuthority.CanQualifyAdmissionFailureCleanup(
            dispatchAcknowledged, cleanupQualified));

    [Theory]
    [InlineData("waiting")]
    [InlineData("running")]
    public void CancelsOnlyTheExactNonzeroOwnedStartJob(string state)
        => DocumentExportSystemdCgroupAuthority.ValidateOwnedStartJob(
            new Dictionary<string, string>
            {
                ["Id"] = "42",
                ["Unit"] = UnitName,
                ["JobType"] = "start",
                ["State"] = state
            },
            "42",
            UnitName);

    [Theory]
    [InlineData("Id", "43")]
    [InlineData("Unit", "foreign.service")]
    [InlineData("JobType", "stop")]
    [InlineData("State", "done")]
    [InlineData("Id", "")]
    public void RefusesForeignOrUnqualifiedCancellationJobs(string field, string value)
    {
        var job = new Dictionary<string, string>
        {
            ["Id"] = "42",
            ["Unit"] = UnitName,
            ["JobType"] = "start",
            ["State"] = "waiting"
        };
        job[field] = value;

        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateOwnedStartJob(
            job, "42", UnitName));
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateOwnedStartJob(
            job, "", UnitName));
    }

    [Fact]
    public void CancellationJobUsesTheNativeUnsignedIdRange()
        => DocumentExportSystemdCgroupAuthority.ValidateOwnedStartJob(
            new Dictionary<string, string>
            {
                ["Id"] = "4294967295",
                ["Unit"] = UnitName,
                ["JobType"] = "start",
                ["State"] = "waiting"
            },
            "4294967295",
            UnitName);

    [Theory]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("042")]
    [InlineData("-42")]
    [InlineData(" 42")]
    [InlineData("4294967296")]
    public void CancellationJobRefusesEmptyNoncanonicalOrOutOfRangeIds(string jobId)
        => Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateOwnedStartJob(
            new Dictionary<string, string>
            {
                ["Id"] = jobId,
                ["Unit"] = UnitName,
                ["JobType"] = "start",
                ["State"] = "waiting"
            },
            jobId,
            UnitName));

    [Theory]
    [InlineData("inactive")]
    [InlineData("failed")]
    public void NativeZeroStartRequiresQuiescentLoadedMetadataAndNoPendingJob(string activeState)
    {
        Dictionary<string, string> properties = CreateUnstartedProperties();
        properties["ActiveState"] = activeState;

        Assert.True(DocumentExportSystemdCgroupAuthority.HasNoNativeStart(properties));
    }

    [Theory]
    [InlineData("LoadState", "not-found")]
    [InlineData("ActiveState", "activating")]
    [InlineData("ActiveState", "active")]
    [InlineData("Job", "42")]
    [InlineData("MainPID", "1")]
    [InlineData("ExecMainPID", "1")]
    [InlineData("ExecMainStartTimestampMonotonic", "1")]
    [InlineData("ExecMainExitTimestampMonotonic", "1")]
    [InlineData("ExecMainCode", "1")]
    [InlineData("ExecMainStatus", "1")]
    public void NativeZeroStartRefusesPendingStartedOrGarbageCollectedSnapshots(string field, string value)
    {
        Dictionary<string, string> properties = CreateUnstartedProperties();
        properties[field] = value;

        Assert.False(DocumentExportSystemdCgroupAuthority.HasNoNativeStart(properties));
    }

    [Fact]
    public void NativeZeroStartRefusesMissingOrMalformedProcessIdentity()
    {
        Dictionary<string, string> properties = CreateUnstartedProperties();
        properties.Remove("ExecMainPID");
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.HasNoNativeStart(properties));
        properties["ExecMainPID"] = "-1";
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.HasNoNativeStart(properties));
    }

    [Theory]
    [InlineData(false, false, true)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, true, false)]
    public void LaterZeroMetadataCannotEraseEarlierExecutionOrRawAccountingEvidence(
        bool previouslyStarted, bool previousActivity, bool expected)
        => Assert.Equal(expected, DocumentExportSystemdCgroupAuthority.HasNoNativeStart(
            CreateUnstartedProperties(), previouslyStarted, previousActivity));

    [Theory]
    [InlineData("MainPID")]
    [InlineData("ExecMainPID")]
    [InlineData("ExecMainStartTimestampMonotonic")]
    [InlineData("ExecMainExitTimestampMonotonic")]
    [InlineData("ExecMainCode")]
    [InlineData("ExecMainStatus")]
    public void EveryNativeExecutionFieldMakesEarlierStartEvidenceSticky(string field)
    {
        Dictionary<string, string> properties = CreateUnstartedProperties();
        Assert.False(DocumentExportSystemdCgroupAuthority.HasNativeExecutionEvidence(properties));
        properties[field] = "1";
        bool startedSeen = DocumentExportSystemdCgroupAuthority.HasNativeExecutionEvidence(properties);
        startedSeen |= DocumentExportSystemdCgroupAuthority.HasNativeExecutionEvidence(CreateUnstartedProperties());

        Assert.True(startedSeen);
        Assert.False(DocumentExportSystemdCgroupAuthority.HasNoNativeStart(CreateUnstartedProperties(), startedSeen));
    }

    [Fact]
    public void NativeExecutionEvidenceRefusesMissingOrMalformedFields()
    {
        Dictionary<string, string> properties = CreateUnstartedProperties();
        properties.Remove("ExecMainPID");
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.HasNativeExecutionEvidence(properties));
        properties["ExecMainPID"] = "-1";
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.HasNativeExecutionEvidence(properties));
    }

    [Fact]
    public void AbsentParentNeedsAnExactUnconfiguredInactiveSliceAlongsideRetainedServiceEvidence()
        => Assert.True(DocumentExportSystemdCgroupAuthority.HasUnactivatedAccountingSlice(
            CreateInactiveSliceProperties(), SliceName));

    [Theory]
    [InlineData("Id", "foreign.slice")]
    [InlineData("LoadState", "not-found")]
    [InlineData("ActiveState", "active")]
    [InlineData("Slice", "foreign.slice")]
    [InlineData("ControlGroup", "/foreign")]
    [InlineData("FragmentPath", "/configured")]
    [InlineData("SourcePath", "/configured")]
    [InlineData("DropInPaths", "/configured")]
    [InlineData("Job", "42")]
    [InlineData("ActiveEnterTimestampMonotonic", "1")]
    [InlineData("InactiveExitTimestampMonotonic", "1")]
    public void AbsentParentRefusesForeignConfiguredPendingOrActivatedSliceMetadata(string field, string value)
    {
        Dictionary<string, string> properties = CreateInactiveSliceProperties();
        properties[field] = value;

        Assert.False(DocumentExportSystemdCgroupAuthority.HasUnactivatedAccountingSlice(properties, SliceName));
    }

    [Fact]
    public void AbsentParentRefusesMissingOrMalformedActivationMetadata()
    {
        Dictionary<string, string> properties = CreateInactiveSliceProperties();
        properties.Remove("ActiveEnterTimestampMonotonic");
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.HasUnactivatedAccountingSlice(
            properties, SliceName));
        properties["ActiveEnterTimestampMonotonic"] = "-1";
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.HasUnactivatedAccountingSlice(
            properties, SliceName));
    }

    [Theory]
    [InlineData(0, 0, 0, false, true)]
    [InlineData(1, 1, 0, false, false)]
    [InlineData(0, 1, 0, false, false)]
    [InlineData(0, 0, 1, false, false)]
    [InlineData(0, 0, 0, true, false)]
    public void ZeroStartAccountingDoesNotSubtractTheBrokerOrForgetEarlierActivity(
        long current, long peak, long maxEvents, bool populated, bool expected)
        => Assert.Equal(expected, DocumentExportSystemdCgroupAuthority.HasNoNativeAccountingActivity(
            current, peak, maxEvents, populated));

    [Theory]
    [InlineData(-1, 0, 0)]
    [InlineData(0, -1, 0)]
    [InlineData(0, 0, -1)]
    public void ZeroStartAccountingRefusesMalformedNegativeNativeCounters(long current, long peak, long maxEvents)
        => Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.HasNoNativeAccountingActivity(
            current, peak, maxEvents, false));

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    public void RejectsForeignOrUnnormalizedServiceAccountingBindings(int mutation)
    {
        string runId = mutation == 0 ? OtherRunId : RunId;
        string unit = mutation == 1 ? "fsusblog-document-export-" + OtherRunId + ".service" : UnitName;
        string slice = mutation == 2 ? "app-fsusblogdocumentexport" + OtherRunId + ".slice" : SliceName;
        string parent = mutation switch
        {
            3 => AccountingGroup.Replace("/app.slice/", "/other.slice/", StringComparison.Ordinal),
            4 => AccountingGroup.Replace("/app.slice/", "/app.slice/../app.slice/", StringComparison.Ordinal),
            5 => AccountingGroup.Replace("/app.slice/", "//app.slice/", StringComparison.Ordinal),
            _ => AccountingGroup
        };
        string child = mutation == 6 ? AccountingGroup + "/foreign.service" : AccountingGroup + "/" + UnitName;

        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateAccountingIdentity(
            runId,
            unit,
            slice,
            child,
            parent));
    }

    [Theory]
    [InlineData("")]
    [InlineData("ABCDEF0123456789abcdef0123456789ab")]
    [InlineData("../foreign")]
    public void RejectsInvalidRunIdentityBeforeCreatingAnAccountingName(string runId)
        => Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.AccountingSliceName(runId));

    [Fact]
    public void AcceptsOnlyAnEmptyDirectParentAndTheExactServiceChild()
    {
        DocumentExportSystemdCgroupAuthority.ValidateAccountingMemberNames(UnitName, "\n", []);
        DocumentExportSystemdCgroupAuthority.ValidateAccountingMemberNames(UnitName, string.Empty, [UnitName]);

        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateAccountingMemberNames(
            UnitName,
            "42\n",
            [UnitName]));
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateAccountingMemberNames(
            UnitName,
            string.Empty,
            [UnitName, "foreign.service"]));
        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateAccountingMemberNames(
            UnitName,
            string.Empty,
            [null]));
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(1, 0)]
    [InlineData(2, 1)]
    [InlineData(3, 2)]
    public void UsesOnlyActualRetainedPeakMinusTheExistingBrokerOverhead(long hostPeak, int expected)
    {
        DocumentExportCgroupObservation terminal = CreateTerminal();
        DocumentExportCgroupObservation retained = DocumentExportSystemdCgroupAuthority.RetainPids(
            terminal,
            0,
            hostPeak,
            3,
            false);

        Assert.Equal(expected, retained.PidsPeak);
        Assert.Equal(3, retained.PidsMaxEvents);
        Assert.Equal(0, retained.PidsCurrent);
        Assert.False(retained.Populated);
        Assert.Equal(terminal.CpuUsageMicroseconds, retained.CpuUsageMicroseconds);
        Assert.Equal(terminal.MemoryPeakBytes, retained.MemoryPeakBytes);
        Assert.Equal(0, terminal.PidsPeak);
    }

    [Fact]
    public void RetainedLiveOrInconsistentCountersCannotQualifyDrain()
    {
        DocumentExportCgroupObservation live = DocumentExportSystemdCgroupAuthority.RetainPids(CreateTerminal(), 2, 3, 0, false);
        DocumentExportCgroupObservation populated = DocumentExportSystemdCgroupAuthority.RetainPids(CreateTerminal(), 0, 3, 0, true);

        Assert.False(DocumentExportSystemdCgroupAuthority.IsDrained(live));
        Assert.False(DocumentExportSystemdCgroupAuthority.IsDrained(populated));
        Assert.Equal(2, live.PidsPeak);
    }

    [Theory]
    [InlineData(-1, 0, 0)]
    [InlineData(0, -1, 0)]
    [InlineData(0, 0, -1)]
    public void RefusesNegativeNativeCounters(long current, long peak, long events)
        => Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.RetainPids(
            CreateTerminal(),
            current,
            peak,
            events,
            false));

    [Fact]
    public void RefusesNativeCountsThatCannotFitTheExistingReceipt()
        => Assert.Throws<OverflowException>(() => DocumentExportSystemdCgroupAuthority.RetainPids(
            CreateTerminal(),
            0,
            long.MaxValue,
            0,
            false));

    [Theory]
    [InlineData("rw", "rw")]
    [InlineData("rw,nosuid,nodev,noexec,relatime", "rw,nsdelegate,memory_recursiveprot")]
    public void RetainedEventsRequireTheActualHierarchicalCgroupMount(string mountOptions, string superOptions)
    {
        string mountInfo = $"29 23 0:26 / /sys/fs/cgroup {mountOptions} - cgroup2 cgroup {superOptions}\n";

        DocumentExportSystemdCgroupAuthority.ValidateRetainedPidsMount(
            mountInfo, "/sys/fs/cgroup" + AccountingGroup);
    }

    [Fact]
    public void UnrelatedLocalEventMountAndEscapedNamesDoNotChangeTheOwningProfile()
    {
        string mountInfo = "1 1 0:1 / / rw - tmpfs tmpfs rw\n"
            + "29 1 0:26 / /sys/fs/cgroup rw shared:4 future:5 - cgroup2 cgroup rw\n"
            + "30 1 0:27 / /other\\040root\\134name rw - cgroup2 cgroup rw,pids_localevents\n"
            + "31 1 0:28 / /sys/fs/cgroup-other rw - cgroup2 cgroup rw,pids_localevents\n";

        DocumentExportSystemdCgroupAuthority.ValidateRetainedPidsMount(
            mountInfo, "/sys/fs/cgroup" + AccountingGroup);
    }

    [Theory]
    [InlineData("rw,pids_localevents", "rw")]
    [InlineData("rw", "rw,pids_localevents")]
    [InlineData("rw", "rw,pids_localevents=0")]
    [InlineData("ro", "rw")]
    [InlineData("rw", "ro")]
    [InlineData("rw,ro", "rw")]
    [InlineData("rw,,nosuid", "rw")]
    [InlineData("rw", "rw,rw")]
    public void RefusesLocalOnlyReadOnlyOrMalformedOwningMountOptions(string mountOptions, string superOptions)
        => Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateRetainedPidsMount(
            $"29 23 0:26 / /sys/fs/cgroup {mountOptions} - cgroup2 cgroup {superOptions}\n",
            "/sys/fs/cgroup" + AccountingGroup));

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    [InlineData(7)]
    [InlineData(8)]
    [InlineData(9)]
    [InlineData(10)]
    [InlineData(11)]
    [InlineData(12)]
    public void RefusesMissingAmbiguousRedirectedOrMalformedMountIdentities(int mutation)
    {
        const string valid = "29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n";
        string mountInfo = mutation switch
        {
            0 => string.Empty,
            1 => valid + valid.Replace("29 23", "30 29", StringComparison.Ordinal),
            2 => valid + "30 29 0:27 / /sys/fs/cgroup/user.slice rw - tmpfs tmpfs rw\n",
            3 => valid.Replace(" / /sys", " /subtree /sys", StringComparison.Ordinal),
            4 => valid.Replace(" - cgroup2 ", " - tmpfs ", StringComparison.Ordinal),
            5 => valid.Replace("0:26", "bad-device", StringComparison.Ordinal),
            6 => valid.Replace(" - ", " ", StringComparison.Ordinal),
            7 => valid.Replace("/sys/fs/cgroup", "/sys/fs/cgroup\\999", StringComparison.Ordinal),
            8 => valid.Replace("/sys/fs/cgroup", "/sys/fs/../fs/cgroup", StringComparison.Ordinal),
            9 => valid.Replace(" rw -", " rw  -", StringComparison.Ordinal),
            10 => valid.Replace("29 23", "0 23", StringComparison.Ordinal),
            11 => valid.Replace(" rw\n", " rw\r\n", StringComparison.Ordinal),
            _ => "1 1 0:1 / / rw - tmpfs tmpfs rw\n"
                + "2 1 0:2 / / rw - tmpfs tmpfs rw\n" + valid
        };

        Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateRetainedPidsMount(
            mountInfo, "/sys/fs/cgroup" + AccountingGroup));
    }

    [Theory]
    [InlineData("/sys/fs/cgroup-other/run")]
    [InlineData("/sys/fs/cgroup/../run")]
    [InlineData("/sys/fs/cgroup//run")]
    [InlineData("relative/run")]
    public void MountAdmissionCannotAuthorizeForeignOrNoncanonicalAccountingPaths(string path)
        => Assert.Throws<InvalidDataException>(() => DocumentExportSystemdCgroupAuthority.ValidateRetainedPidsMount(
            "29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n", path));

    private static DocumentExportCgroupObservation CreateTerminal()
        => new(42_000, 0, 2_048, 1, 1, 0, 0, 0, false);

    private static Dictionary<string, string> CreateUnstartedProperties()
        => new()
        {
            ["LoadState"] = "loaded",
            ["ActiveState"] = "inactive",
            ["Job"] = string.Empty,
            ["MainPID"] = "0",
            ["ExecMainPID"] = "0",
            ["ExecMainStartTimestampMonotonic"] = "0",
            ["ExecMainExitTimestampMonotonic"] = "0",
            ["ExecMainCode"] = "0",
            ["ExecMainStatus"] = "0"
        };

    private static Dictionary<string, string> CreateInactiveSliceProperties()
        => new()
        {
            ["Id"] = SliceName,
            ["LoadState"] = "loaded",
            ["ActiveState"] = "inactive",
            ["Slice"] = "app.slice",
            ["ControlGroup"] = string.Empty,
            ["FragmentPath"] = string.Empty,
            ["SourcePath"] = string.Empty,
            ["DropInPaths"] = string.Empty,
            ["Job"] = string.Empty,
            ["ActiveEnterTimestampMonotonic"] = "0",
            ["InactiveExitTimestampMonotonic"] = "0"
        };
}
