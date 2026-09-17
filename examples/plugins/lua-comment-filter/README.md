# Lua comment filter example

This source fixture shows the intended `activate(ctx)` and
`comment.beforeCreate` binding for issue #122. It requests only
`comment.create`; raw database, filesystem and network permissions remain
disabled.

The repository's default Lua engine adapter is deliberately unavailable. Package
this directory as an `.fspkg` only when a concrete engine adapter has passed the
Level 1 sandbox and resource-budget conformance suite. This example is not a
standalone executable and does not add a package-management or publishing path.
