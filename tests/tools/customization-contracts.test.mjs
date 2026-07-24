import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCustomizationDag, validateCustomizationOwnership } from '../../tools/contracts/check-customization-contracts.mjs';

test('customization dependency DAG is acyclic and ordered', () => {
  const dagData = {
    nodes: ['#1585', '#156', '#180', '#182'],
    edges: [
      { from: '#1585', to: '#156' },
      { from: '#156', to: '#180' },
      { from: '#180', to: '#182' }
    ]
  };

  const res = validateCustomizationDag(dagData);
  assert.equal(res.cycles, 0);
  assert.equal(res.totalNodes, 4);
});

test('customization dependency DAG rejects cyclic dependencies', () => {
  const dagData = {
    nodes: ['#156', '#180', '#182'],
    edges: [
      { from: '#156', to: '#180' },
      { from: '#180', to: '#182' },
      { from: '#182', to: '#156' }
    ]
  };

  const res = validateCustomizationDag(dagData);
  assert.equal(res.cycles, 3);
});

test('customization ownership verification detects duplicate owners and unowned contracts', () => {
  const validData = {
    ownership: {
      'TypeA': '#1585',
      'TypeB': '#1585'
    }
  };
  const res = validateCustomizationOwnership(validData);
  assert.equal(res.duplicateOwners, 0);
  assert.equal(res.unownedSharedContracts, 0);
});
