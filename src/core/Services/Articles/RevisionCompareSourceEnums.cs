namespace FsusBlog.Core.Services.Articles;

public enum RevisionCompareSourceKind
{
    CurrentDraft = 0,
    CurrentRevision = 1,
    HistoricalRevision = 2
}

public enum RevisionCompareViewMode
{
    Unified = 0,
    Split = 1
}

public enum RevisionCompareWordSegmentation
{
    UnicodeTextElementsV1 = 0
}

public enum RevisionCompareMetadataValueType
{
    String = 0,
    NullableString = 1,
    Int32 = 2,
    Int32List = 3,
    Boolean = 4,
    NullableInstant = 5
}
