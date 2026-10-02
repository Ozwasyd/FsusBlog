namespace FsusBlog.Contracts.Schema;

public static class SchemaModelComparer
{
    public static IReadOnlyList<string> Compare(
        SchemaModelSnapshot expected,
        SchemaModelSnapshot actual,
        IReadOnlyCollection<string>? allowedExtraTables = null,
        IReadOnlySet<string>? allowedExtraLinks = null,
        IReadOnlyCollection<string>? requiredExtraTables = null)
    {
        var errors = new List<string>();
        foreach ((string tableName, SchemaTableModel expectedTable) in expected.Tables.OrderBy(static table => table.Key, StringComparer.Ordinal))
        {
            if (!actual.Tables.TryGetValue(tableName, out SchemaTableModel? actualTable))
            {
                errors.Add($"missing table {tableName} owner={Describe(expectedTable.Owner)}");
                continue;
            }
            CompareTable(
                expectedTable,
                actualTable,
                expected.Provider == SchemaProviderKind.PostgreSql,
                allowedExtraLinks,
                errors);
        }

        HashSet<string> allowed = allowedExtraTables?.Select(CurrentSchemaCanonicalAuthority.NormalizeIdentifier).ToHashSet(StringComparer.Ordinal)
            ?? [];
        IEnumerable<string> requiredNames = requiredExtraTables is null
            ? []
            : requiredExtraTables
                .Select(CurrentSchemaCanonicalAuthority.NormalizeIdentifier)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal);
        foreach (string tableName in requiredNames)
        {
            allowed.Add(tableName);
            if (expected.Tables.ContainsKey(tableName))
            {
                continue;
            }
            if (!actual.Tables.ContainsKey(tableName))
            {
                errors.Add($"missing required extra table {tableName}");
            }
        }
        foreach (string tableName in actual.Tables.Keys.Except(expected.Tables.Keys, StringComparer.Ordinal).Except(allowed, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            errors.Add($"extra table {tableName} owner={Describe(actual.Tables[tableName].Owner)}");
        }
        return errors;
    }

    private static void CompareTable(
        SchemaTableModel expected,
        SchemaTableModel actual,
        bool requireExactPostgresPhysicalSemantics,
        IReadOnlySet<string>? allowedExtraLinks,
        List<string> errors)
    {
        foreach ((string columnName, SchemaColumnModel expectedColumn) in expected.Columns.OrderBy(static column => column.Key, StringComparer.Ordinal))
        {
            if (!actual.Columns.TryGetValue(columnName, out SchemaColumnModel? actualColumn))
            {
                errors.Add($"missing column {expected.Name}.{columnName} owner={Describe(expectedColumn.Owner)}");
                continue;
            }
            CompareField(
                expected.Name,
                expectedColumn,
                actualColumn,
                requireExactPostgresPhysicalSemantics,
                errors);
        }
        foreach (string columnName in actual.Columns.Keys.Except(expected.Columns.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            errors.Add($"extra column {expected.Name}.{columnName} owner={Describe(actual.Columns[columnName].Owner)}");
        }
        foreach (string indexName in expected.Indexes.Except(actual.Indexes, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            errors.Add($"missing index {expected.Name}.{indexName} owner={Describe(expected.Owner)}");
        }
        foreach (string indexName in actual.Indexes.Except(expected.Indexes, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            if (allowedExtraLinks?.Contains(indexName) == true)
            {
                continue;
            }
            errors.Add($"extra index {expected.Name}.{indexName} owner={Describe(actual.Owner)}");
        }
        foreach (string indexName in expected.IndexDefinitions.Keys.Intersect(actual.IndexDefinitions.Keys, StringComparer.Ordinal))
        {
            SchemaIndexModel expectedIndex = expected.IndexDefinitions[indexName];
            SchemaIndexModel actualIndex = actual.IndexDefinitions[indexName];
            if (expectedIndex.Name != actualIndex.Name
                || expectedIndex.IsUnique != actualIndex.IsUnique
                || !expectedIndex.Keys.SequenceEqual(actualIndex.Keys)
                || !expectedIndex.IncludedColumns.SequenceEqual(actualIndex.IncludedColumns, StringComparer.Ordinal)
                || expectedIndex.AccessMethod != actualIndex.AccessMethod
                || expectedIndex.Predicate != actualIndex.Predicate
                || expectedIndex.NullsNotDistinct != actualIndex.NullsNotDistinct)
            {
                errors.Add($"index mismatch {expected.Name}.{indexName} owner={Describe(expected.Owner)}");
            }
        }
        foreach (string constraintName in expected.Constraints.Keys.Except(actual.Constraints.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            errors.Add($"missing constraint {expected.Name}.{constraintName} owner={Describe(expected.Owner)}");
        }
        foreach (string constraintName in actual.Constraints.Keys.Except(expected.Constraints.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            if (allowedExtraLinks?.Contains(constraintName) == true)
            {
                continue;
            }
            errors.Add($"extra constraint {expected.Name}.{constraintName} owner={Describe(actual.Owner)}");
        }
        foreach (string constraintName in expected.Constraints.Keys.Intersect(actual.Constraints.Keys, StringComparer.Ordinal))
        {
            SchemaConstraintModel expectedConstraint = expected.Constraints[constraintName];
            SchemaConstraintModel actualConstraint = actual.Constraints[constraintName];
            if (expectedConstraint.Name != actualConstraint.Name
                || expectedConstraint.Kind != actualConstraint.Kind
                || !expectedConstraint.Columns.SequenceEqual(actualConstraint.Columns, StringComparer.Ordinal)
                || expectedConstraint.ReferencedTable != actualConstraint.ReferencedTable
                || !(expectedConstraint.ReferencedColumns ?? []).SequenceEqual(
                    actualConstraint.ReferencedColumns ?? [],
                    StringComparer.Ordinal)
                || expectedConstraint.Expression != actualConstraint.Expression
                || expectedConstraint.IsDeferrable != actualConstraint.IsDeferrable
                || expectedConstraint.IsInitiallyDeferred != actualConstraint.IsInitiallyDeferred
                || expectedConstraint.IsValidated != actualConstraint.IsValidated
                || expectedConstraint.ForeignKeyUpdateAction != actualConstraint.ForeignKeyUpdateAction
                || expectedConstraint.ForeignKeyDeleteAction != actualConstraint.ForeignKeyDeleteAction
                || expectedConstraint.ForeignKeyMatchType != actualConstraint.ForeignKeyMatchType
                || expectedConstraint.ReferencedSchema != actualConstraint.ReferencedSchema)
            {
                errors.Add($"constraint mismatch {expected.Name}.{constraintName} owner={Describe(expected.Owner)}");
            }
        }
    }

    private static void CompareField(
        string table,
        SchemaColumnModel expected,
        SchemaColumnModel actual,
        bool requireExactPostgresPhysicalSemantics,
        List<string> errors)
    {
        void Difference(string field, object? expectedValue, object? actualValue)
            => errors.Add($"{field} mismatch {table}.{expected.Name} expected={expectedValue ?? "null"} actual={actualValue ?? "null"} owner={Describe(expected.Owner)}");

        if (expected.DataType != actual.DataType)
            Difference("type", expected.DataType, actual.DataType);
        if (expected.IsNullable != actual.IsNullable)
            Difference("nullable", expected.IsNullable, actual.IsNullable);
        if (expected.IsPrimaryKey != actual.IsPrimaryKey)
            Difference("primary-key", expected.IsPrimaryKey, actual.IsPrimaryKey);
        if (expected.IsIdentity != actual.IsIdentity)
            Difference("identity", expected.IsIdentity, actual.IsIdentity);
        if (expected.MaxLength != actual.MaxLength)
            Difference("length", expected.MaxLength, actual.MaxLength);
        if (expected.DefaultValue != actual.DefaultValue)
            Difference("default", expected.DefaultValue, actual.DefaultValue);
        if (expected.Conversion != actual.Conversion)
            Difference("conversion", expected.Conversion, actual.Conversion);
        if (expected.ComputedExpression != actual.ComputedExpression)
            Difference("computed", expected.ComputedExpression, actual.ComputedExpression);
        if (requireExactPostgresPhysicalSemantics)
        {
            if (expected.PhysicalType != actual.PhysicalType)
                Difference("physical-type", expected.PhysicalType, actual.PhysicalType);
            if (expected.Collation != actual.Collation)
                Difference("collation", expected.Collation, actual.Collation);
            if (expected.GenerationKind != actual.GenerationKind)
                Difference("generation", expected.GenerationKind, actual.GenerationKind);
            if (expected.OwnedSequence != actual.OwnedSequence)
                Difference("owned-sequence", expected.OwnedSequence, actual.OwnedSequence);
        }
    }

    private static string Describe(SchemaOwnerModel? owner)
        => owner is null ? "unknown" : $"{owner.Owner}@{owner.SourceRange}";
}
