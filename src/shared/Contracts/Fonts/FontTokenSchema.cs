namespace FsusBlog.Shared.Contracts.Fonts;

/// <summary>
/// Stable, versioned token names shared by the font runtime, themes, and clients.
/// </summary>
public static class FontTokenSchema
{
    public const string Version = "1.0.0";

    public static class Family
    {
        public const string Ui = "font.family.ui";
        public const string Prose = "font.family.prose";
        public const string Code = "font.family.code";
        public const string Cjk = "font.family.cjk";
        public const string Emoji = "font.family.emoji";

        public static IReadOnlyList<string> All
        {
            get;
        } =
            [Ui, Prose, Code, Cjk, Emoji];
    }

    public static class Weight
    {
        public const string Regular = "font.weight.regular";
        public const string Medium = "font.weight.medium";
        public const string Bold = "font.weight.bold";

        public static IReadOnlyList<string> All
        {
            get;
        } =
            [Regular, Medium, Bold];
    }

    public static class Size
    {
        public const string Body = "font.size.body";
        public const string Article = "font.size.article";
        public const string Code = "font.size.code";
        public const string Caption = "font.size.caption";

        public static IReadOnlyList<string> All
        {
            get;
        } =
            [Body, Article, Code, Caption];
    }

    public static class LineHeight
    {
        public const string Body = "font.lineHeight.body";
        public const string Article = "font.lineHeight.article";
        public const string Code = "font.lineHeight.code";

        public static IReadOnlyList<string> All
        {
            get;
        } =
            [Body, Article, Code];
    }

    public static class LetterSpacing
    {
        public const string Ui = "font.letterSpacing.ui";
        public const string Prose = "font.letterSpacing.prose";
        public const string Code = "font.letterSpacing.code";

        public static IReadOnlyList<string> All
        {
            get;
        } =
            [Ui, Prose, Code];
    }

    public static class Typography
    {
        public const string BodyFamily = "typography.body.family";
        public const string BodyWeight = "typography.body.weight";
        public const string BodyLineHeight = "typography.body.lineHeight";
        public const string ArticleFamily = "typography.article.family";
        public const string ArticleSize = "typography.article.size";
        public const string ArticleLineHeight = "typography.article.lineHeight";
        public const string HeadingFamily = "typography.heading.family";
        public const string HeadingWeight = "typography.heading.weight";
        public const string CodeFamily = "typography.code.family";
        public const string CodeSize = "typography.code.size";
        public const string AdminTableFamily = "typography.admin.table.family";

        public static IReadOnlyList<string> All
        {
            get;
        } =
        [
            BodyFamily,
            BodyWeight,
            BodyLineHeight,
            ArticleFamily,
            ArticleSize,
            ArticleLineHeight,
            HeadingFamily,
            HeadingWeight,
            CodeFamily,
            CodeSize,
            AdminTableFamily
        ];

        public static IReadOnlySet<string> FamilyReferences
        {
            get;
        } = new HashSet<string>(
            [BodyFamily, ArticleFamily, HeadingFamily, CodeFamily, AdminTableFamily],
            StringComparer.Ordinal);
    }

    public static IReadOnlyList<string> All
    {
        get;
    } =
    [
        .. Family.All,
        .. Weight.All,
        .. Size.All,
        .. LineHeight.All,
        .. LetterSpacing.All,
        .. Typography.All
    ];
}
