# Console Welcome Callout

The admin console welcome callout is a lightweight project feedback affordance. It is dismissible, does not block workflows, and never attaches deployment diagnostics to issue links.

## Configuration

Supported configuration keys:

- `ConsoleWelcomeCallout.Enabled`
- `ConsoleWelcomeCallout.ShowOnFirstRun`
- `ConsoleWelcomeCallout.ContributeUrl`
- `ConsoleWelcomeCallout.IssueUrl`
- `ConsoleWelcomeCallout.CommunityUrl`
- `ConsoleWelcomeCallout.HideForPrivateDeployment`

Frontend deployments can provide these through Vite env values or `window.__FSUSBLOG_CONSOLE_WELCOME_CALLOUT__` before the app mounts:

- `VITE_FSUSBLOG_CONSOLE_WELCOME_ENABLED`
- `VITE_FSUSBLOG_CONSOLE_WELCOME_SHOW_ON_FIRST_RUN`
- `VITE_FSUSBLOG_CONSOLE_WELCOME_CONTRIBUTE_URL`
- `VITE_FSUSBLOG_CONSOLE_WELCOME_ISSUE_URL`
- `VITE_FSUSBLOG_CONSOLE_WELCOME_COMMUNITY_URL`
- `VITE_FSUSBLOG_CONSOLE_WELCOME_HIDE_FOR_PRIVATE_DEPLOYMENT`
- `VITE_FSUSBLOG_EXTERNAL_LINKS_ENABLED`
- `VITE_FSUSBLOG_PRIVATE_DEPLOYMENT`
- `VITE_FSUSBLOG_DEPLOYMENT_MODE`

The default public issue link is `https://github.com/Ozwasyd/FsusBlog/issues/new/choose`. Contribution and community links default to empty so the callout degrades to the issue link until the project owner configures more destinations.

If external links are disabled, the callout is hidden. If `privateDeployment` is true and `hideForPrivateDeployment` is true, the callout is hidden.

Dismissal is stored locally under `fsus:console-welcome-callout:dismissed:<user>`.
