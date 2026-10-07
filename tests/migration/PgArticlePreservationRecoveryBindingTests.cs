using Xunit;

namespace FsusBlog.Migration.Tests;

// Original producer locators/limits only; no private native/tool capability is
// fabricated, and these controls cannot qualify a recovery or database commit.
public sealed class PgArticlePreservationRecoveryBindingTests
{
    [Fact]
    public void A_Caller_Owned_Explicit_Output_And_Finite_Input_Limit_Is_Not_A_Native_Grant()
        => PgArticlePreservationOperation.RequireRecoveryOutput(Output(), 1024);

    [Theory]
    [InlineData("missing-output")]
    [InlineData("relative-output")]
    [InlineData("root-output")]
    [InlineData("uncanonical-output")]
    [InlineData("latest-output")]
    [InlineData("control-output")]
    [InlineData("missing-budget")]
    [InlineData("overflow-budget")]
    public void Invalid_Recovery_Input_Configuration_Is_Rejected_Before_Media_Preparation(string invalid)
    {
        string valid = Output();
        PgArticlePreservationOperation.RequireRecoveryOutput(valid, 1024);
        string output = invalid switch
        {
            "missing-output" => "",
            "relative-output" => "unowned-output.json",
            "root-output" => Path.GetPathRoot(valid)!,
            "uncanonical-output" => Path.GetDirectoryName(valid) + Path.DirectorySeparatorChar + "." + Path.DirectorySeparatorChar + "recovery.json",
            "latest-output" => Path.Combine(Path.GetDirectoryName(valid)!, "latest", "recovery.json"),
            "control-output" => valid + "\n",
            _ => valid
        };
        long limit = invalid switch
        {
            "missing-budget" => 0,
            "overflow-budget" => (long)int.MaxValue + 1,
            _ => 1024
        };
        Assert.Throws<InvalidOperationException>(() => PgArticlePreservationOperation.RequireRecoveryOutput(output, limit));
    }

    [Fact]
    public void An_Output_And_Tool_Identity_Record_Cannot_Replace_The_Original_Private_Tool_Capability()
        => Assert.Throws<InvalidOperationException>(() => PgArticlePreservationOperation.RequireRecoveryConfiguration(
            new(null!, Output(), 1024)));

    private static string Output()
        => Path.GetFullPath(Path.Combine(Path.GetTempPath(), "fsusblog-article-original-run", "recovery.json"));
}
