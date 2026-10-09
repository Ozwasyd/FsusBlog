using System.Data.Common;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

/// <summary>Controlled bootstrap lifecycle data, not runtime DDL or an identity factory.</summary>
internal static class SystemSiteIdentityMigrationDefinitions
{
    internal const string BootstrapKey = "SiteIdentity_Bootstrap";

    internal static string BootstrapValue(OwnedCurrentSchemaTarget owned, CompiledCurrentSchemaBootstrap compiled)
    {
        var tables = owned.ProjectExpectedPhysicalTarget(SchemaProviderKind.PostgreSql).Tables.Tables;
        if (!tables.TryGetValue("sys_systemconfig", out SchemaTableModel? table)
            || !table.Columns.TryGetValue("key", out SchemaColumnModel? key)
            || !table.Columns.TryGetValue("value", out SchemaColumnModel? value)
            || !key.IsPrimaryKey || key.MaxLength != 64 || value.MaxLength != 512)
            throw new InvalidOperationException("site_identity_bootstrap_system_config_shape_changed");
        string revision = owned.Execution.SourceRevision;
        string input = CurrentSchemaOwnedTargetProjection.ComputeInputDigest(owned.ReadBoundInput());
        string commands = compiled.CommandDigest;
        if (!Hex(revision, 40) || !Hex(input, 64) || !Hex(commands, 64))
            throw new InvalidOperationException("site_identity_bootstrap_provenance_invalid");
        return $"1|Fresh|{revision}|{input}|{commands}";
    }

    // Called only after the original empty-source operation has admitted and
    // verified the complete canonical bootstrap on this actual transaction.
    internal static async Task InsertBootstrapAsync(string value, DbConnection connection,
        DbTransaction transaction, CancellationToken cancellationToken)
    {
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO public.sys_systemconfig (key, value) VALUES (@key, @value)";
        foreach ((string name, string text) in new[] { ("key", BootstrapKey), ("value", value) })
        {
            DbParameter parameter = command.CreateParameter();
            parameter.ParameterName = name;
            parameter.Value = text;
            command.Parameters.Add(parameter);
        }
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    internal static async Task<bool> MatchesBootstrapAsync(string expected, DbConnection connection,
        DbTransaction transaction, CancellationToken cancellationToken)
    {
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT value FROM public.sys_systemconfig WHERE key = @key";
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = "key";
        parameter.Value = BootstrapKey;
        command.Parameters.Add(parameter);
        return await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is string value && value == expected;
    }

    private static bool Hex(string value, int length)
        => value.Length == length && value.AsSpan().IndexOfAnyExcept("0123456789abcdef") < 0;
}
