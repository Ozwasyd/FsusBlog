using System.Data;
using System.Data.Common;
using System.Globalization;

internal static partial class Migration
{
    private static bool IsLegacyAdminHandle(string? handle) =>
        handle is { Length: >= 1 and <= 64 } && char.IsAsciiLetterLower(handle[0]) &&
        handle.All(character => char.IsAsciiLetterLower(character) || char.IsAsciiDigit(character) || character is '_' or '-' or '.');

    private static bool IsReviewedLegacyGrantSet(string[] grants) =>
        grants.Length <= MappedAdminPermissions.Count && grants.All(grant => grant is not null && MappedAdminPermissions.Contains(grant)) &&
        grants.SequenceEqual(grants.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal));

    private static async Task<LegacyAdminSelection[]> ReadLegacyAdminSelectionsAsync(LegacySource source, DbTransaction tx,
        long[] selected, CancellationToken ct)
    {
        var catalog = await ReadLegacyCatalogAsync(source, tx, ct);
        if (catalog.Any(table => table.Name.Equals("v2_schema", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("The selected administrator authority requires a v1 source.");
        var admin = Require("admin_principal", ["id", "handle", "status", "validationversion", "isroot", "permissions", "totpenabled",
            "totpsecretencrypted", "totpverifiedatutc"]);
        var passkey = Require("admin_passkey_credential", ["adminprincipalid"]);
        var sessions = Require("admin_session", ["adminprincipalid"]);

        string A(string column) => source.Field(admin, column);
        var result = new List<LegacyAdminSelection>(selected.Length);
        var exactHandles = new HashSet<string>(StringComparer.Ordinal);
        foreach (long id in selected)
        {
            var handle = A("handle");
            var status = A("status");
            var grants = A("permissions");
            // Sensitive values are excluded in the SQL projection; only the presence of legacy MFA is observed.
            await using var inspect = CreateLegacyCommand(tx, $"""
                SELECT CASE WHEN {source.Utf8Length(handle)}<=64 THEN {handle} END,
                    CASE WHEN {source.Utf8Length(status)}<=32 THEN {status} END,
                    {A("validationversion")},{A("isroot")},
                    CASE WHEN {source.Utf8Length(grants)}<=4096 THEN {grants} END,
                    {A("totpenabled")},CASE WHEN {A("totpsecretencrypted")} IS NULL THEN 0 ELSE 1 END,
                    CASE WHEN {A("totpverifiedatutc")} IS NULL THEN 0 ELSE 1 END
                FROM {source.Table(admin)} WHERE {A("id")}=@selected LIMIT 2
                """);
            AddLegacyAdminIdParameter(inspect, id);
            string sourceHandle;
            string sourceStatus;
            long generation;
            string[] permissions;
            await using (var row = await inspect.ExecuteReaderAsync(ct))
            {
                if (!await row.ReadAsync(ct))
                    throw new InvalidOperationException("A selected old independent administrator is absent.");
                sourceHandle = IdentityText(row, 0) ?? "";
                sourceStatus = IdentityText(row, 1) ?? "";
                generation = AssetInteger(row.GetValue(2));
                var raw = IdentityText(row, 4);
                permissions = raw?.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Order(StringComparer.Ordinal).ToArray() ?? [];
                if (!IsLegacyAdminHandle(sourceHandle) || !exactHandles.Add(sourceHandle) ||
                    sourceStatus is not ("active" or "disabled") || generation < 1 || raw is null ||
                    IdentityBoolean(row, 3) || IdentityBoolean(row, 5) || IdentityBoolean(row, 6) || IdentityBoolean(row, 7) ||
                    !IsReviewedLegacyGrantSet(permissions) || await row.ReadAsync(ct))
                    throw new InvalidOperationException("A selected old administrator has ambiguous identity, root, MFA, or unsupported authority.");
            }
            // Confirm no other old principal uses the selected handle, without enumerating unselected accounts.
            await using (var duplicate = CreateLegacyCommand(tx,
                $"SELECT count(*) FROM {source.Table(admin)} WHERE {A("handle")}=@selected"))
            {
                var parameter = duplicate.CreateParameter();
                parameter.ParameterName = "selected";
                parameter.Value = sourceHandle;
                duplicate.Parameters.Add(parameter);
                if (Convert.ToInt64(await duplicate.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) != 1)
                    throw new InvalidOperationException("A selected old administrator handle is ambiguous.");
            }
            var credentialRows = await CountLegacyAdminAuthorityAsync(source, tx, passkey, id, ct);
            var sessionsRows = await CountLegacyAdminAuthorityAsync(source, tx, sessions, id, ct);
            result.Add(new LegacyAdminSelection(id, sourceHandle, sourceStatus, generation, permissions, credentialRows, sessionsRows, null));
        }
        return result.ToArray();

        LegacyTable Require(string name, string[] fields)
        {
            var matches = catalog.Where(table => table.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (matches is [var selectedTable] && source.IsSnapshotTable(selectedTable.Kind) &&
                fields.All(field => HasField(selectedTable, field))) return selectedTable;
            throw new InvalidOperationException($"The selected old administrator authority differs: {name}.");
        }
    }

    private static async Task<long> CountLegacyAdminAuthorityAsync(LegacySource source, DbTransaction tx,
        LegacyTable relation, long adminId, CancellationToken ct)
    {
        await using var count = CreateLegacyCommand(tx, $"""
            SELECT count(*) FROM {source.Table(relation)} WHERE {source.Field(relation, "adminprincipalid")}=@selected
            """);
        AddLegacyAdminIdParameter(count, adminId);
        return Convert.ToInt64(await count.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
    }

    private static void AddLegacyAdminIdParameter(DbCommand command, long id)
    {
        var parameter = command.CreateParameter();
        parameter.ParameterName = "selected";
        parameter.DbType = DbType.Int64;
        parameter.Value = id;
        command.Parameters.Add(parameter);
    }
}
