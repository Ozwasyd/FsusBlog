namespace FsusBlog.Core.Services.Articles;

public enum RevisionCompareSnapshotKind
{
    Rights = 0,
    Responsibility = 1,
    Release = 2
}

public enum RevisionCompareSnapshotState
{
    Present = 0,
    NotApplicable = 1,
    Missing = 2
}

public enum RevisionComparePackageReadStatus
{
    Available = 0,
    Unavailable = 1,
    Stale = 2,
    Invalid = 3,
    BudgetExceeded = 4
}

public enum RevisionComparePlanStatus
{
    Accepted = 0,
    Unavailable = 1,
    Stale = 2,
    Invalid = 3,
    BudgetExceeded = 4,
    Cancelled = 5,
    Tampered = 6
}

public enum RevisionCompareAdmissionMode
{
    BoundedWorkerChunksV1 = 0
}
