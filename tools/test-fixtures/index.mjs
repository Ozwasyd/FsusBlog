/** Public exports for the unique FixtureOrchestrator (#1709), FixtureReceipt (#1710), run-once reuse (#1711). */
export {
  plan,
  prepare,
  verify,
  cleanup,
  buildProducerDag,
  createTerminalState,
  FIXTURE_TERMINAL_STATES,
  normalizeProducerPort,
  createProducerContext
} from './orchestrator.mjs'
export {
  createDefaultProducerPorts,
  createPortsForProducerIds
} from './producers/catalog-ports.mjs'
export {
  runFixtureOnce,
  REQUIRED_PRODUCER_REUSE_VERIFIER
} from './run-fixture-once.mjs'
export * from './receipt/index.mjs'
export * from './mutation-recovery/index.mjs'
