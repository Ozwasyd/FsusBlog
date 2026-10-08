namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Complete canonical insert values excluding the generated PK; explicit roles correlate native results.</summary>
internal sealed record DataScaleGeneratedIdentityRows(DataScaleBulkTableRows Values,
    DataScaleBulkColumn PrimaryKey, IReadOnlyList<DataScaleNativeIdentityRoleGroup> Roles);

/// <summary>Inserted rows and IDs are provisional in the caller transaction, never a commit/seed receipt.</summary>
internal sealed record DataScaleGeneratedIdentityExecution(
    IReadOnlyDictionary<string, long> RoleIds, DataScaleBulkTableRows InsertedRows,
    int InsertCommands, int NativeStatements, bool AlreadyPresent = false);
