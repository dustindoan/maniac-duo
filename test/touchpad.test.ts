import { describe, expect, test } from 'bun:test';
import { direction } from '../src/web/touchpad';

describe('touch gamepad', () => {
  test('the D-pad reads eight ways from where the thumb is, with nothing near the centre', () => {
    expect(direction(0, 0)).toEqual({ dx: 0, dy: 0 });
    expect(direction(0.1, -0.1)).toEqual({ dx: 0, dy: 0 });
    expect(direction(0, -0.9)).toEqual({ dx: 0, dy: -1 });
    expect(direction(0.9, 0.1)).toEqual({ dx: 1, dy: 0 });
    expect(direction(-0.2, 0.9)).toEqual({ dx: 0, dy: 1 });
    expect(direction(-0.9, 0)).toEqual({ dx: -1, dy: 0 });
    expect(direction(0.7, 0.6)).toEqual({ dx: 1, dy: 1 });
    expect(direction(-0.6, -0.7)).toEqual({ dx: -1, dy: -1 });
  });
});
