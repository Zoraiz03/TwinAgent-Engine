import { greet } from './greet.js';
import { shout } from './format.js';

export function describe(name) {
  return shout(greet(name));
}
