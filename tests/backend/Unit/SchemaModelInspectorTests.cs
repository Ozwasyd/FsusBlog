using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests;

public sealed class SchemaModelInspectorTests
{
    [Fact]
    public void BuildExpectedModel_ReflectsManagedTablesAndColumns()
    {
        var inspector = new SchemaModelInspector();

        IReadOnlyList<Type> entityTypes = inspector.GetManagedEntityTypes();
        SchemaModelSnapshot snapshot = inspector.BuildExpectedModel(entityTypes);

        Assert.Contains("article", snapshot.Tables.Keys);
        Assert.Contains("article_body", snapshot.Tables.Keys);
        Assert.Contains("page_content", snapshot.Tables.Keys);
        Assert.Contains("sys_user_session", snapshot.Tables.Keys);
        Assert.Contains("msg_conversation", snapshot.Tables.Keys);
        Assert.Contains("sys_audit_log", snapshot.Tables.Keys);

        SchemaTableModel article = snapshot.Tables["article"];
        Assert.Contains("title", article.Columns.Keys);
        Assert.Contains("createtime", article.Columns.Keys);
        Assert.DoesNotContain("content", article.Columns.Keys);

        SchemaTableModel userSession = snapshot.Tables["sys_user_session"];
        Assert.Contains("idleexpiresat", userSession.Columns.Keys);
        Assert.Contains("absoluteexpiresat", userSession.Columns.Keys);
        Assert.Contains("rememberme", userSession.Columns.Keys);

        SchemaTableModel auditLog = snapshot.Tables["sys_audit_log"];
        Assert.Contains("source", auditLog.Columns.Keys);
        Assert.Contains("type", auditLog.Columns.Keys);
        Assert.Contains("occurred_at_utc", auditLog.Columns.Keys);
    }
}
