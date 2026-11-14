namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    public static void Validate(AuthoringWorkspaceSnapshot value)
    {
        ValidateWorkspace(value.SchemaVersion, value.Revision, value.ActiveArticleId, value.Tabs);
        if (value.Skipped is < 0 or > WireLimits.AuthoringWorkspaceTabs ||
            (value.Revision == 0 ? value.UpdatedAtUnixMs != 0 || value.Tabs.Count != 0 || value.Skipped != 0 : value.UpdatedAtUnixMs <= 0))
            throw new ProtocolException("Invalid authoring workspace revision.");
    }

    internal static void Validate(AuthoringWorkspaceCommand value) =>
        ValidateWorkspace(value.SchemaVersion, value.ExpectedRevision, value.ActiveArticleId, value.Tabs);

    private static void ValidateWorkspace(int version, long revision, int active, IReadOnlyList<int> tabs)
    {
        if (version != 1 || revision < 0 || active < 0 || tabs.Count > WireLimits.AuthoringWorkspaceTabs)
            throw new ProtocolException("Invalid authoring workspace coordinates.");
        // A negative ID represents the group's sole preview. The magnitude is always a positive article ID.
        var ids = new HashSet<int>();
        var preview = false;
        foreach (var tab in tabs)
        {
            if (tab is 0 or int.MinValue || !ids.Add(Math.Abs(tab)) || (preview && tab < 0))
                throw new ProtocolException("Invalid authoring workspace tabs.");
            preview |= tab < 0;
        }
        if (active != 0 && !ids.Contains(active)) throw new ProtocolException("Unknown active workspace article.");
    }
}
