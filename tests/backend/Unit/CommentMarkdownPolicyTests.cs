using FsusBlog.Server.Infrastructure.Content;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentMarkdownPolicyTests
{
    [Theory]
    [InlineData("**重点** [官网](https://example.com/docs?q=1) `code`")]
    [InlineData("> 引用\n\n- 列表项\n\n```html\n<img src=\"demo\">\n```")]
    public void ValidateForSubmit_AllowsSafeTextMarkdownAndBuildsReviewText(string content)
    {
        CommentMarkdownPolicyResult result = CommentMarkdownPolicy.ValidateForSubmit(content);

        Assert.True(result.IsValid);
        Assert.DoesNotContain("](", result.ReviewText, StringComparison.Ordinal);
        Assert.DoesNotContain("**", result.ReviewText, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidateForSubmit_AddsLinkTargetHostAndPathToReviewText()
    {
        CommentMarkdownPolicyResult result = CommentMarkdownPolicy.ValidateForSubmit("[官网](https://example.com/docs?q=1)");

        Assert.True(result.IsValid);
        Assert.Contains("官网", result.ReviewText, StringComparison.Ordinal);
        Assert.Contains("example.com/docs", result.ReviewText, StringComparison.Ordinal);
        Assert.DoesNotContain("?q=1", result.ReviewText, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("这里有 ![alt](https://example.com/a.png)", "comment_markdown_image")]
    [InlineData("这里有 ![alt][img]\n\n[img]: https://example.com/a.png", "comment_markdown_image")]
    [InlineData("这里有 <img src=\"https://example.com/a.png\">", "comment_markdown_html")]
    [InlineData("<iframe src=\"https://example.com\"></iframe>", "comment_markdown_html")]
    [InlineData("[点这里](javascript:alert(1))", "comment_markdown_unsafe_link")]
    [InlineData("[点这里](data:text/html,evil)", "comment_markdown_unsafe_link")]
    public void ValidateForSubmit_RejectsUnsafeCommentMarkdown(string content, string reasonCode)
    {
        CommentMarkdownPolicyResult result = CommentMarkdownPolicy.ValidateForSubmit(content);

        Assert.False(result.IsValid);
        Assert.Equal(reasonCode, result.ReasonCode);
        Assert.NotEmpty(result.PublicMessage);
    }
}
