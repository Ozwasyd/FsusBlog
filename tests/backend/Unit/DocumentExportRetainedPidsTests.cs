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

    private static DocumentExportCgroupObservation CreateTerminal()
        => new(42_000, 0, 2_048, 1, 1, 0, 0, 0, false);
}
