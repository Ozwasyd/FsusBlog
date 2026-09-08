# Console feedback entry

The former admin-console welcome callout is no longer rendered on the production dashboard. Repository maintenance copy competed with real operational work, so the dashboard now exposes only a collapsed `帮助与反馈` (Help and feedback) disclosure next to its page title. Opening that disclosure reveals the configured external support destinations.

The retained support-link configuration is the source for those destinations. The visible dashboard labels are task-oriented:

- `查看维护说明` (View maintenance notes)
- `提交问题` (Submit an issue)
- `参与讨论` (Join the discussion)

The first dashboard view does not show GitHub, Issue, repository-maintenance, deployment-diagnostic, or first-run promotional copy. External-link and private-deployment policies still apply.

## Configuration

Supported configuration keys:

- `ConsoleWelcomeCallout.ContributeUrl`
- `ConsoleWelcomeCallout.IssueUrl`
- `ConsoleWelcomeCallout.CommunityUrl`
- `ConsoleWelcomeCallout.HideForPrivateDeployment`

Frontend deployments can provide these through Vite environment values or `window.__FSUSBLOG_CONSOLE_WELCOME_CALLOUT__` before the app mounts:

- `VITE_FSUSBLOG_CONSOLE_WELCOME_CONTRIBUTE_URL`
- `VITE_FSUSBLOG_CONSOLE_WELCOME_ISSUE_URL`
- `VITE_FSUSBLOG_CONSOLE_WELCOME_COMMUNITY_URL`
- `VITE_FSUSBLOG_CONSOLE_WELCOME_HIDE_FOR_PRIVATE_DEPLOYMENT`
- `VITE_FSUSBLOG_EXTERNAL_LINKS_ENABLED`
- `VITE_FSUSBLOG_PRIVATE_DEPLOYMENT`
- `VITE_FSUSBLOG_DEPLOYMENT_MODE`

The default public issue destination is `https://github.com/Ozwasyd/FsusBlog/issues/new/choose`. Contribution and community destinations default to empty.

`buildConsoleSupportLinks` returns no links when external links are disabled, or when a private deployment requests hidden external destinations. The retired first-run component and its per-user dismissal state are no longer part of the production tree.
