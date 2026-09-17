using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("user_locale_preference")]
[SugarIndex("ux_user_locale_preference_account", nameof(AccountId), OrderByType.Asc, true)]
public sealed class UserLocalePreference
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "account_id")]
    public int AccountId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "mode", Length = 8)]
    public string Mode { get; set; } = LocalePreferenceModes.Auto;

    [SugarColumn(ColumnName = "fixed_locale", Length = 16, IsNullable = true)]
    public string? FixedLocale
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision")]
    public long Revision
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt
    {
        get; set;
    }
}

public static class LocalePreferenceModes
{
    public const string Auto = "auto";
    public const string Fixed = "fixed";
}
