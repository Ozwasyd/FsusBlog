using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DataScaleNativeCommentBindingsTests
{
    [Fact]
    public void Binding_SnapshotsDistinctOccurrenceAndEntityRolesWithoutArticleAliases()
    {
        var first = new DataScaleNativeCommentRole("deep", 0, "article", "reply", DataScaleNativeCommentEntity.Comment, "created");
        var second = first with
        {
            Repetition = 1
        };
        var revision = first with
        {
            Entity = DataScaleNativeCommentEntity.Revision
        };
        var ids = new Dictionary<DataScaleNativeCommentRole, long> { [first] = 501, [second] = 502, [revision] = 501 };
        DataScaleNativeCommentBindings binding = Bind(ids);
        binding.RequireCoverage([first, second, revision]);
        Assert.Equal(501, binding.Resolve(first));
        Assert.Equal(501, binding.Resolve(revision));
        string digest = binding.Digest;
        ids[first] = 999;
        Assert.Equal(501, binding.Resolve(first));
        Assert.Equal(digest, Bind(new Dictionary<DataScaleNativeCommentRole, long>
        {
            [revision] = 501,
            [second] = 502,
            [first] = 501
        }).Digest);
        Assert.Throws<InvalidOperationException>(() => binding.RequireCoverage([first, revision]));
        Assert.Throws<InvalidOperationException>(() => binding.RequireCoverage([first, first, second, revision]));
        Assert.Throws<InvalidOperationException>(() => binding.Resolve(first with { Repetition = 2 }));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(501)]
    public void Binding_RefusesNonpositiveAndDuplicateNativeIds(long invalid)
    {
        var first = new DataScaleNativeCommentRole("deep", 0, "article", "root", DataScaleNativeCommentEntity.Comment, "created");
        var second = first with
        {
            CommentRole = "reply"
        };
        Assert.Throws<ArgumentException>(() => Bind(new Dictionary<DataScaleNativeCommentRole, long>
        {
            [first] = 501,
            [second] = invalid
        }));
    }

    private static DataScaleNativeCommentBindings Bind(IReadOnlyDictionary<DataScaleNativeCommentRole, long> ids)
        => new("run", "namespace", "runtime", "PostgreSql", Digest('1'), Digest('2'),
            new("original-native-owner-reference", new string('a', 40), Digest('3')), ids);

    private static string Digest(char value) => "sha256:" + new string(value, 64);
}
