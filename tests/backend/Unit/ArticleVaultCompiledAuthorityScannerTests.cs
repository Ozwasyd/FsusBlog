using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultCompiledAuthorityScannerTests
{
    [Fact]
    public void CurrentServer_UsesSoleCanonicalAuthoritiesAndNoCompiledBackendSidePath()
    {
        Type[] types = ServerTypes();
        Type[] boundaries = types.Where(static type => type.Namespace == typeof(ArticleVaultSyncPlanExecutor).Namespace).ToArray();
        Assert.NotEmpty(boundaries);
        Assert.Empty(ArticleVaultCompiledAuthorityScanner.Scan(types, boundaries));
    }

    [Theory]
    [InlineData(typeof(IArticleVaultSyncPlanExecutor))]
    [InlineData(typeof(IArticleVaultCanonicalGroupWriter))]
    [InlineData(typeof(IArticleVaultExecutionStore))]
    [InlineData(typeof(IArticleVaultTransactionalGroupResultStore))]
    [InlineData(typeof(IArticleVaultOperationCheckpointStore))]
    public void AddedImplementation_CannotIntroduceSecondAuthority(Type contract)
    {
        Type additional = AdditionalImplementation(contract);
        IReadOnlyList<ArticleVaultCompiledAuthorityScanner.Violation> result = ArticleVaultCompiledAuthorityScanner.Scan(
            ServerTypes().Append(additional), []);
        ArticleVaultCompiledAuthorityScanner.Violation violation = Assert.Single(result);
        Assert.Equal("vault_authority_implementation_drift", violation.Code);
        Assert.Equal(contract.FullName, violation.TypeIdentity);
    }

    [Theory]
    [InlineData(typeof(ArticleVaultSyncPlanExecutor))]
    [InlineData(typeof(ArticleService))]
    [InlineData(typeof(PostgresArticleVaultExecutionStore))]
    [InlineData(typeof(PostgresArticleVaultOperationCheckpointStore))]
    [InlineData(typeof(ArticleVaultSyncPlanner))]
    public void MissingOwner_IsRejectedInsteadOfProducingVacuousPass(Type owner)
    {
        Assert.NotEmpty(ArticleVaultCompiledAuthorityScanner.Scan(ServerTypes().Where(type => type != owner), []));
    }

    [Fact]
    public void AddedPlanner_CannotIntroduceAnotherCanonicalPlanBuilder()
    {
        ArticleVaultCompiledAuthorityScanner.Violation violation = Assert.Single(
            ArticleVaultCompiledAuthorityScanner.Scan(ServerTypes().Append(typeof(AdditionalPlanner)), []));
        Assert.Equal("vault_planner_implementation_drift", violation.Code);
        Assert.Equal(typeof(ArticleVaultSyncPlanner).FullName, violation.TypeIdentity);
    }

    [Theory]
    [InlineData(typeof(ConstructorSqlMutation), "vault_direct_article_sql")]
    [InlineData(typeof(QuotedSqlMutation), "vault_direct_article_sql")]
    [InlineData(typeof(RevisionSqlMutation), "vault_direct_article_sql")]
    [InlineData(typeof(ConstructorFileAccess), "vault_backend_filesystem_side_path")]
    [InlineData(typeof(AsyncFileWrite), "vault_backend_filesystem_side_path")]
    [InlineData(typeof(NestedFileWrite), "vault_backend_filesystem_side_path")]
    [InlineData(typeof(ImportFallback), "vault_watcher_or_import_side_path")]
    [InlineData(typeof(WatcherDispatch), "vault_watcher_or_import_side_path")]
    [InlineData(typeof(DirectArticleMutation), "vault_direct_article_service_mutation")]
    [InlineData(typeof(DirectOrmMutation), "vault_direct_business_orm_mutation")]
    [InlineData(typeof(MisnamedOrmMutation), "vault_direct_business_orm_mutation")]
    [InlineData(typeof(LatestReceiptQuery), "vault_latest_result_query")]
    [InlineData(typeof(ReflectedFileWrite), "vault_dynamic_dispatch_side_path")]
    [InlineData(typeof(NativeFileMutation), "vault_backend_native_side_path")]
    public void CompiledMutationFixtures_AreRejectedWithoutRunningTheirBodies(Type fixture, string expectedCode)
    {
        IReadOnlyList<ArticleVaultCompiledAuthorityScanner.Violation> result = ArticleVaultCompiledAuthorityScanner.Scan(
            ServerTypes(), [fixture]);
        Assert.Contains(result, violation => violation.Code == expectedCode && violation.TypeIdentity == fixture.FullName);
    }

    [Fact]
    public void BenignReceiptStatementsAndComments_DoNotBecomeBusinessMutation()
    {
        // File.WriteAllText and INSERT INTO article here are comments, not compiled instructions.
        Assert.Empty(ArticleVaultCompiledAuthorityScanner.Scan(ServerTypes(), [typeof(BenignReceiptStatements)]));
    }

    private static Type[] ServerTypes() => typeof(ArticleVaultSyncPlanExecutor).Assembly.GetTypes()
        .Concat(typeof(ArticleVaultSyncPlanner).Assembly.GetTypes()).ToArray();

    // Additional interface implementations are real compiled test types, never invoked or
    // registered in the server. Every method throws, so fixtures cannot perform a business write.
    private static Type AdditionalImplementation(Type contract)
    {
        AssemblyBuilder assembly = AssemblyBuilder.DefineDynamicAssembly(
            new AssemblyName($"ArticleVaultAuthorityMutation_{Guid.NewGuid():N}"), AssemblyBuilderAccess.RunAndCollect);
        TypeBuilder builder = assembly.DefineDynamicModule("mutation").DefineType("AdditionalAuthority",
            TypeAttributes.Public | TypeAttributes.Sealed);
        builder.AddInterfaceImplementation(contract);
        foreach (MethodInfo method in contract.GetMethods())
        {
            MethodBuilder implementation = builder.DefineMethod(method.Name,
                MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.NewSlot,
                method.ReturnType, method.GetParameters().Select(static parameter => parameter.ParameterType).ToArray());
            ILGenerator body = implementation.GetILGenerator();
            body.Emit(OpCodes.Newobj, typeof(NotSupportedException).GetConstructor(Type.EmptyTypes)!);
            body.Emit(OpCodes.Throw);
            builder.DefineMethodOverride(implementation, method);
        }

        return builder.CreateType()!;
    }

    private sealed class ConstructorSqlMutation
    {
        private ConstructorSqlMutation() => GC.KeepAlive(new NpgsqlCommand("INSERT INTO article (id) VALUES (1)"));
    }

    private static class AdditionalPlanner
    {
        public static ArticleVaultPlanBuildResult Build(ArticleVaultPlanRequest request) => throw new NotSupportedException();
    }

    private static class QuotedSqlMutation
    {
        static QuotedSqlMutation() => GC.KeepAlive(new NpgsqlCommand("DELETE FROM \"public\".\"article\" WHERE id = 1"));
    }

    private static class RevisionSqlMutation
    {
        public static void Write() => GC.KeepAlive(new NpgsqlCommand("UPDATE public.article_revision SET revision_no = 1"));
    }

    private sealed class ConstructorFileAccess
    {
        private ConstructorFileAccess() => GC.KeepAlive(System.IO.Path.GetFileName("unexecuted-fixture"));
    }

    private static class AsyncFileWrite
    {
        public static async Task Write()
        {
            await Task.Yield();
            System.IO.File.WriteAllText("unexecuted-fixture", "source");
        }
    }

    private static class NestedFileWrite
    {
        public static void Write() => Nested.Write();

        private static class Nested
        {
            public static void Write() => GC.KeepAlive(System.IO.File.Create("unexecuted-fixture"));
        }
    }

    private static class ImportFallback
    {
        static ImportFallback() => Import();

        private static void Import() => GC.KeepAlive("unexecuted-fixture");
    }

    private static class WatcherDispatch
    {
        public static void Run() => StartWatcher();

        private static void StartWatcher() => GC.KeepAlive("unexecuted-fixture");
    }

    private static class DirectArticleMutation
    {
        public static Task<bool> Write(ArticleService service) => service.DeleteAsync(1);
    }

    private static class DirectOrmMutation
    {
        public static void Write(ISqlSugarClient db) => GC.KeepAlive(db.Updateable<Article>());
    }

    private static class LatestReceiptQuery
    {
        public static void Read(ISqlSugarClient db) => GC.KeepAlive(db.Queryable<ArticleVaultExecutionResultEntity>()
            .OrderBy(static item => item.CreatedAtUtc, OrderByType.Desc).First());
    }

    private static class MisnamedOrmMutation
    {
        public static void Write(ISqlSugarClient db) => GC.KeepAlive(db.Insertable(new ArticleVaultMisnamedEntity()));
    }

    [SugarTable("article")]
    private sealed class ArticleVaultMisnamedEntity
    {
        public int Id
        {
            get; set;
        }
    }

    private static class ReflectedFileWrite
    {
        public static void Write() => typeof(AsyncFileWrite).GetMethod(nameof(AsyncFileWrite.Write))!.Invoke(null, null);
    }

    private static class NativeFileMutation
    {
        [DllImport("unexecuted-fixture", EntryPoint = "rename")]
        private static extern int Move(string before, string after);

        public static void Write() => GC.KeepAlive(Move("unexecuted-before", "unexecuted-after"));
    }

    private static class BenignReceiptStatements
    {
        public static void Run() => GC.KeepAlive(new NpgsqlCommand(
            "INSERT INTO article_vault_operation_checkpoint (operation_identity) VALUES (@operation)"));
    }
}
