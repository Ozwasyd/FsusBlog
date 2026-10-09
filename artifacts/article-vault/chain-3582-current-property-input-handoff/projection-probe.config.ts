import canonical from '../../../src/frontend/vitest.config'
export default { ...canonical, test: { ...canonical.test, include: ['../../.tmp/chain-3582-expanded/property-3d177/projection-probe.test.ts'] } }
