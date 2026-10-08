if (value.Action == "write" ? value.Layout is null || value.ResetConfirmationDigest is not null
    : value.Action != "reset" || value.Layout is not null || value.ResetConfirmationDigest is null)
{
    throw new FormatException("workspace_snapshot_mutation_shape");
}
