export const releaseDeploymentDocMutationCorpus = Object.freeze([
    ['manual-runtime-role-table', '| Mode | Responsibility |\n| --- | --- |\n| `single` | owns everything |'],
    ['manual-stage-table', '| Stage | Owner |\n| --- | --- |\n| release-final | aggregate |'],
    ['finalizer-as-rerun', 'release-final re-runs every producer to confirm success'],
    ['job-success-authority', 'the CI job success is the authority for release evidence'],
    ['auto-spawn-evidence', 'missing evidence auto-spawn is allowed before closeout'],
    ['unknown-active-standby', 'unknown active identity is treated as a safe standby'],
    ['active-cleanup-allowed', 'the GC may delete the active release assets'],
    ['compose-workflow-role-authority', 'the compose file is the runtime-role authority'],
    ['waiver', 'deployment-waiver'],
    ['hidden-compatibility', '<details>legacy compatibility table</details>'],
    ['overbroad-claim', 'one claim covers all behaviors'],
    ['self-certification', 'lastVerifiedCommit: deadbeef'],
    ['renamed-manual-section', '## Traffic handoff\nThe controller verifies the candidate and reloads the gateway upstream.'],
    ['reordered-manual-sections', '## Recovery procedure\nRestore the former serving slot.\n## Promotion steps\nPromote the standby and switch traffic.'],
    ['extra-active-section', '## Active slot maintenance\nThe operator must retain the serving slot until the drain finishes.'],
    ['synonymous-manual-command', '## Operator sequence\nInvoke the cutover utility, promote standby, then retire the former serving slot.'],
    ['synonymous-manual-claim', '## Service transfer\nA standby becomes serving after the proxy is reloaded; fallback reactivates the former slot.'],
    ['unowned-qualification-claim', '## Deployment conclusion\nThe blue/green deployment claim is eligible and runtime-role ownership is verified.'],
    ['synonymous-qualification-claim', '## Readiness conclusion\nThe blue-green deployment qualification is approved.'],
    ['synonymous-ownership-claim', '## Topology conclusion\nThe runtime-role authority is established.'],
    ['passive-cutover-clearance', 'The candidate is cleared for cutover.'],
    ['passive-handoff-permission', 'Traffic handoff permitted after observation.'],
    ['headingless-authority-table', '| Target | State |\n| --- | --- |\n| Candidate | Cleared for cutover |'],
    ['headingless-authority-list', '- Traffic handoff permitted.'],
    ['markdown-split-ownership', 'The run**time-role** owner**ship** is veri**fied**.'],
    ['entity-split-qualification', 'The blue&#x2d;green deployment claim is elig&#105;ble.'],
    ['generated-claim-body-laundering', `<!-- fsus-doc-claim
claimId: fixture.generated
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.deployment
render: generated-section
-->
The blue-green deployment claim is eligible.`],
    ['link-before-sentence-normalization', '[deployment](https://example.test/a.b) claim is eligible.'],
    ['split-runtime-role-link', '[runtime](https://example.test/runtime)-[role](https://example.test/role) ownership is settled.'],
    ['inline-comment-split', 'deploy<!-- split -->ment claim is valid.'],
    ['zero-width-split', 'deploy​ment claim passed.'],
    ['soft-hyphen-entity-split', 'blue&shy;-green deployment claim valid.'],
    ['active-callout-authority', '> [!IMPORTANT]\n> Standby may take traffic.'],
    ['without-receipts-qualification', 'Without receipts, the deployment claim is valid.'],
    ['no-evidence-required-qualification', 'No evidence required, the deployment claim passed.'],
    ['not-only-qualification', 'The deployment claim is not only eligible.'],
    ['not-merely-qualification', 'The deployment claim is not merely valid.'],
    ['standby-takes-traffic', 'Standby may take traffic.'],
    ['gateway-points-standby', 'The gateway points at standby.'],
    ['settled-ownership', 'Runtime-role ownership is settled.'],
    ['passed-claim', 'The deployment claim passed.'],
    ['valid-claim', 'The deployment claim is valid.'],
    ['nested-active-callout', '> > [!IMPORTANT]\n> > The deployment claim is valid.'],
    ['multiline-dotted-link', '[deployment claim](https://example.test/a.b\n/c.d) is valid.'],
    ['bare-authority-url', 'https://example.test/deployment-claim-eligible'],
    ['except-after-claim', 'Except after drain, the deployment claim is valid.'],
    ['failed-to-deny-claim', 'The observer failed to deny that the deployment claim is valid.'],
    ['failed-to-remain-blocked', 'The deployment claim failed to remain blocked.'],
    ['mixed-old-current-claim', 'The old claim was invalid, but the current deployment claim is valid.'],
    ['post-backtick-fence-prose', '```text\nignored\n```\nThe deployment claim is valid.'],
    ['post-tilde-fence-prose', '~~~text\nignored\n~~~\nThe deployment claim is valid.'],
    ['post-multiple-fence-prose', '```text\none\n```\n~~~text\ntwo\n~~~\nThe deployment claim is valid.'],
    ['html-comment-visible-tail', '<!-- hidden --> The deployment claim is valid.'],
    ['html-pre-visible-tail', '<pre>hidden\n</pre> The deployment claim is valid.'],
    ['ordinary-blockquote-authority', '> The deployment claim is valid.'],
    ['html-comment-hidden-waiver', '<!-- deployment-waiver: cleanup may delete the active release -->'],
    ['html-pre-hidden-old-runbook', '<pre>Unknown active identity is a safe standby.</pre>'],
    ['fenced-old-runbook', '```text\nUnknown active identity is a safe standby.\n```'],
    ['unclosed-fenced-old-runbook', '```text\nUnknown active identity is a safe standby.'],
    ['indented-old-runbook', '    Unknown active identity is a safe standby.'],
    ['adjacent-generated-ownership-prose', `<!-- fsus-doc-claim
claimId: fixture.generated-adjacent
behaviorId: deployment-blue-green-runtime-role
claimType: generated-section
generatedSectionId: fixture.adjacent
render: generated-section
-->
<!-- FSUSBLOG-GENERATED:BEGIN fixture.adjacent -->
generated body
<!-- FSUSBLOG-GENERATED:END fixture.adjacent -->
The deployment claim is valid.`]
])
