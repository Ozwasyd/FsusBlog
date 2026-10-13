using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Inspects compiled server authority without executing it. This bounded scanner reuses the
/// canonical IL decoder, including constructors and async/nested bodies. It does not qualify
/// native materialization or replace the required script/workflow and terminal protocol gates.
/// </summary>
internal static class ArticleVaultCompiledAuthorityScanner
{
    internal sealed record Violation(string Code, string TypeIdentity);

    internal static IReadOnlyList<Violation> Scan(IEnumerable<Type> authorityTypes, IEnumerable<Type> boundaryTypes)
    {
        Type[] types = authorityTypes.Distinct().ToArray();
        var violations = new List<Violation>();
        HashSet<string> receiptTables = CanonicalReceiptTables();
        MethodInfo[] planners = types.SelectMany(static type => type.GetMethods(
                BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly))
            .Where(static method => method.ReturnType == typeof(ArticleVaultPlanBuildResult)
                && method.GetParameters().Select(static parameter => parameter.ParameterType)
                    .SequenceEqual([typeof(ArticleVaultPlanRequest)])).ToArray();
        if (planners.Length != 1 || planners[0].DeclaringType != typeof(ArticleVaultSyncPlanner))
        {
            violations.Add(new("vault_planner_implementation_drift", typeof(ArticleVaultSyncPlanner).FullName!));
        }

        RequireSoleImplementation<IArticleVaultSyncPlanExecutor, ArticleVaultSyncPlanExecutor>(types, violations);
        RequireSoleImplementation<IArticleVaultCanonicalGroupWriter, ArticleService>(types, violations);
        RequireSoleImplementation<IArticleVaultExecutionStore, PostgresArticleVaultExecutionStore>(types, violations);
        RequireSoleImplementation<IArticleVaultTransactionalGroupResultStore, PostgresArticleVaultExecutionStore>(types, violations);
        RequireSoleImplementation<IArticleVaultOperationCheckpointStore, PostgresArticleVaultOperationCheckpointStore>(types, violations);
        foreach (Type type in boundaryTypes.Distinct())
        {
            string description = string.Join('\n', RuntimeMetadataInspection.DescribeType(type),
                RuntimeMetadataInspection.DescribeConstructors(type));
            string identity = type.FullName ?? type.Name;
            if (DirectArticleSql().IsMatch(description))
            {
                violations.Add(new("vault_direct_article_sql", identity));
            }

            foreach (RuntimeMetadataInspection.RuntimeMemberSite site in RuntimeMetadataInspection.ReadMemberSites(type))
            {
                MemberInfo member = site.Member;
                Type? owner = member.DeclaringType;
                string? ownerName = owner?.FullName;
                if (member is MethodBase native && native.GetCustomAttribute<DllImportAttribute>() is not null)
                {
                    violations.Add(new("vault_backend_native_side_path", identity));
                }

                if (member.Name is "Invoke" or "InvokeMember" or "DynamicInvoke"
                    && (owner?.Namespace == "System.Reflection" || owner == typeof(Type) || owner == typeof(Delegate)))
                {
                    violations.Add(new("vault_dynamic_dispatch_side_path", identity));
                }

                if (ownerName?.StartsWith("System.IO.", StringComparison.Ordinal) == true)
                {
                    violations.Add(new("vault_backend_filesystem_side_path", identity));
                }

                if (member.Name.Contains("Import", StringComparison.OrdinalIgnoreCase)
                    || ownerName?.Contains("Watcher", StringComparison.OrdinalIgnoreCase) == true
                    || member.Name.Contains("Watcher", StringComparison.OrdinalIgnoreCase))
                {
                    violations.Add(new("vault_watcher_or_import_side_path", identity));
                }

                if (owner == typeof(ArticleService)
                    && member.Name is "CreateMutationAsync" or "UpdateAsync" or "DeleteAsync")
                {
                    violations.Add(new("vault_direct_article_service_mutation", identity));
                }

                if (owner?.Namespace == "SqlSugar")
                {
                    if (member.Name.StartsWith("OrderBy", StringComparison.Ordinal))
                    {
                        violations.Add(new("vault_latest_result_query", identity));
                    }

                    if (member.Name is "Insertable" or "Updateable" or "Deleteable")
                    {
                        Type[] arguments = member is MethodInfo method && method.IsGenericMethod
                            ? method.GetGenericArguments()
                            : owner.IsGenericType ? owner.GetGenericArguments() : [];
                        if (arguments.Length == 0 || arguments.Any(argument =>
                            PhysicalTable(argument) is not { } table || !receiptTables.Contains(table)))
                        {
                            violations.Add(new("vault_direct_business_orm_mutation", identity));
                        }
                    }
                }
            }
        }

        return violations.Distinct().OrderBy(static violation => violation.Code, StringComparer.Ordinal)
            .ThenBy(static violation => violation.TypeIdentity, StringComparer.Ordinal).ToArray();
    }

    private static string? PhysicalTable(Type entity)
    {
        CustomAttributeData? mapping = entity.GetCustomAttributesData()
            .SingleOrDefault(static attribute => attribute.AttributeType == typeof(SugarTable));
        if (mapping is null)
        {
            return null;
        }

        CustomAttributeNamedArgument named = mapping.NamedArguments
            .FirstOrDefault(static argument => argument.MemberName == "TableName");
        return named.TypedValue.Value as string
            ?? (mapping.ConstructorArguments.Count > 0 ? mapping.ConstructorArguments[0].Value as string : null);
    }

    // Obtain physical receipt table identities from the existing migration producer. Entity
    // naming is not authority, and this scanner must not maintain another table roster.
    private static HashSet<string> CanonicalReceiptTables()
        => new[]
        {
            ArticleVaultExecutionMigrationDefinitions.BuildMigration(),
            ArticleVaultOperationMigrationDefinitions.BuildMigration()
        }.SelectMany(static descriptor => descriptor.Steps.OfType<RawSqlStep>())
            .SelectMany(static step => Regex.Matches(step.Sql,
                @"\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?<table>[a-z0-9_]+)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant).Select(static match => match.Groups["table"].Value))
            .ToHashSet(StringComparer.Ordinal);

    private static void RequireSoleImplementation<TContract, TOwner>(Type[] types, List<Violation> violations)
        where TOwner : TContract
    {
        Type[] implementations = types.Where(static type => !type.IsInterface && !type.IsAbstract
            && typeof(TContract).IsAssignableFrom(type)).ToArray();
        if (implementations.Length != 1 || implementations[0] != typeof(TOwner))
        {
            violations.Add(new("vault_authority_implementation_drift", typeof(TContract).FullName!));
        }
    }

    // Only literal article mutation targets are recognized here. The resolved ORM/member checks
    // additionally cover typed calls; dynamic SQL and other languages still need the full gate.
    private static Regex DirectArticleSql()
        => new(@"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+(?:(?:""[^""]+""|\[[^\]]+\]|[a-z0-9_]+)\s*\.\s*)?[""\[]?(?:article(?!_vault_)[a-z0-9_]*)[""\]]?(?![a-z0-9_])",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
}
