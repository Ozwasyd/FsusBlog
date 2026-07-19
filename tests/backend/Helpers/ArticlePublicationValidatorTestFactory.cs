using FsusBlog.Server.Services.Articles;

using NSubstitute;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class ArticlePublicationValidatorTestFactory
{
    public static IArticlePublicationValidator CreateAllowing()
    {
        var validator = Substitute.For<IArticlePublicationValidator>();
        validator.ValidateContent(Arg.Any<ArticlePublicationValidationInput>(), Arg.Any<DateTime>())
            .Returns(new ArticlePublicationValidationResult(true, true, []));
        validator.ValidateAsync(
                Arg.Any<ArticlePublicationValidationInput>(),
                Arg.Any<DateTime>(),
                Arg.Any<CancellationToken>())
            .Returns(new ArticlePublicationValidationResult(true, true, []));
        return validator;
    }
}
