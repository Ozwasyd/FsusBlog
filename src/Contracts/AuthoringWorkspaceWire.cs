namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    public static void Validate(AuthoringWorkspaceSnapshot value)
        => ValidateSnapshot(value.SchemaVersion, 1, value.Revision, value.UpdatedAtUnixMs, value.ActiveArticleId, value.Tabs, value.Skipped);

    internal static void Validate(AuthoringWorkspaceCommand value) =>
        ValidateWorkspace(value.SchemaVersion, 1, value.ExpectedRevision, value.ActiveArticleId, value.Tabs);

    internal static void Validate(AuthoringWorkspaceLayout value)
    {
        ValidateSnapshot(value.SchemaVersion, 2, value.Revision, value.UpdatedAtUnixMs, value.ActiveArticleId, value.Tabs, value.Skipped);
        if (value.Revision == 0 && value.InspectorOpen) throw new ProtocolException("Invalid authoring workspace layout.");
    }

    internal static void Validate(AuthoringWorkspaceLayoutCommand value)
        => ValidateWorkspace(value.SchemaVersion, 2, value.ExpectedRevision, value.ActiveArticleId, value.Tabs);

    private static void ValidateSnapshot(int version, int expected, long revision, long updated, int active, IReadOnlyList<int> tabs, int skipped)
    {
        ValidateWorkspace(version, expected, revision, active, tabs);
        if (skipped is < 0 or > WireLimits.AuthoringWorkspaceTabs ||
            (revision == 0 ? updated != 0 || tabs.Count != 0 || skipped != 0 : updated <= 0))
            throw new ProtocolException("Invalid authoring workspace revision.");
    }

    private static void ValidateWorkspace(int version, int expected, long revision, int active, IReadOnlyList<int> tabs)
    {
        if (version != expected || revision < 0 || active < 0 || tabs.Count > WireLimits.AuthoringWorkspaceTabs)
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
