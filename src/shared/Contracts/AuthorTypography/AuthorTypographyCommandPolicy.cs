namespace FsusBlog.Shared.Contracts.AuthorTypography;

/// <summary>
/// Domain validation used inside the sole server writer's transaction. A prepared
/// decision never substitutes for its row lock, atomic CAS, authorization or receipt.
/// </summary>
public static class AuthorTypographyCommandPolicy
{
    public static AuthorTypographyCommandDecision Prepare(
        AuthorTypographyScope? authenticatedScope,
        AuthorTypographySnapshot? current,
        AuthorTypographyCommand? command,
        AuthorTypographyProfile? serverCurrentDesignDefault)
    {
        if (command is null || command.ExpectedRevision < 0)
        {
            return Refuse(AuthorTypographyCommandStatus.InvalidCommand);
        }
        switch (command.Mutation)
        {
            case AuthorTypographyMutation.SetProfile:
                if (!AuthorTypographyContractValidator.ValidateProfile(command.Profile))
                {
                    return Refuse(AuthorTypographyCommandStatus.InvalidCommand);
                }
                break;
            case AuthorTypographyMutation.Reset:
                if (command.Profile is not null)
                {
                    return Refuse(AuthorTypographyCommandStatus.InvalidCommand);
                }
                break;
            default:
                return Refuse(AuthorTypographyCommandStatus.InvalidCommand);
        }
        if (AuthorTypographyContractValidator.ValidateSnapshot(current, authenticatedScope)
            != AuthorTypographyContractStatus.Valid)
        {
            return Refuse(AuthorTypographyCommandStatus.InvalidSnapshot);
        }
        if (command.ExpectedRevision != current!.Revision)
        {
            return Refuse(AuthorTypographyCommandStatus.RevisionConflict);
        }
        if (current.Revision == long.MaxValue)
        {
            return Refuse(AuthorTypographyCommandStatus.RevisionExhausted);
        }
        AuthorTypographyProfile? requested = command.Mutation == AuthorTypographyMutation.Reset
            ? serverCurrentDesignDefault
            : command.Profile;
        if (!AuthorTypographyContractValidator.ValidateProfile(requested))
        {
            return Refuse(AuthorTypographyCommandStatus.CurrentDesignDefaultUnavailable);
        }
        return new AuthorTypographyCommandDecision(
            AuthorTypographyCommandStatus.Prepared,
            new AuthorTypographyPreparedMutation(current.Scope, current.Revision, requested!));
    }

    private static AuthorTypographyCommandDecision Refuse(AuthorTypographyCommandStatus status)
    {
        return new AuthorTypographyCommandDecision(status, null);
    }
}
