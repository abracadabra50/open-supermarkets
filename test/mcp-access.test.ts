import assert from 'node:assert/strict';
import { getProviderAccess } from '../src/mcp-access';

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    failures++;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

console.log('mcp access');

check('allows anonymous Migros search and basket operations', () => {
  assert.deepEqual(getProviderAccess('migros', 'search'), {
    error: null,
    requiresStoredSession: false,
  });
  assert.deepEqual(getProviderAccess('migros', 'basket'), {
    error: null,
    requiresStoredSession: false,
  });
});

check('keeps stored-session requirements for authenticated basket providers', () => {
  assert.deepEqual(getProviderAccess('sainsburys', 'basket'), {
    error: null,
    requiresStoredSession: true,
  });
});

check('rejects operations omitted from a provider manifest', () => {
  assert.deepEqual(getProviderAccess('ahorramas', 'basket'), {
    error: 'AhorraMás does not support basket operations.',
    requiresStoredSession: false,
  });
});

if (failures) process.exitCode = 1;
