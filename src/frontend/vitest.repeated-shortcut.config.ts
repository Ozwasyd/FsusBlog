import candidate from './vitest.config';

export default {
  ...candidate,
  test: {
    ...candidate.test,
    include: [
      '../../tests/frontend/unit/composables/repeated-shortcut.test.ts'
    ],
    outputFile: {
      json: '../../.tmp/review3935-probes/results.json',
      junit: '../../.tmp/review3935-probes/results.xml'
    }
  }
};
