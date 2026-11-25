import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe } from '../src/index.js';

test('describe shouts the greeting', () => assert.equal(describe('x'), 'HELLO X'));
