const { visualEvidencePolicy } = require('../../scripts/visual-evidence-policy.cjs')
module.exports = {
  testDir: __dirname,
  testMatch: 'policy.spec.ts',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.POLICY_OUTPUT,
  preserveOutput: visualEvidencePolicy().preserveOutput,
  use: { ...visualEvidencePolicy(), browserName: 'chromium', headless: true },
}
