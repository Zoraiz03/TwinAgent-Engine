import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../src/math.js';
import { greet } from '../src/greet.js';

test('add', () => assert.equal(add(1, 2), 3));
test('greet', () => assert.equal(greet('x'), 'hello x'));
