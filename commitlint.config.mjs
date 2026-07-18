import { changeContract } from './tools/governance/change-contract-registry.mjs'

// Compatibility adapter for editors and external commitlint integrations.
// tools/governance/check-change-contract.mjs remains the authoritative gate.
export default {
    rules: {
        'type-enum': [2, 'always', changeContract.commitTypes],
        'scope-enum': [2, 'always', changeContract.commitScopes],
        'scope-empty': [2, 'never'],
        'subject-empty': [2, 'never'],
        'subject-full-stop': [2, 'never', '.'],
        'header-max-length': [2, 'always', changeContract.summaryMaximumLength],
        'footer-leading-blank': [2, 'always']
    }
}
