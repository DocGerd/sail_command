import { describe, expect, it, vi } from 'vitest';
import { makeFakeMap } from './fakeMaplibre';

// Pins the style-event timing the fake copies from MapLibre (see the header of
// fakeMaplibre.ts); the consumers' re-entry tests only detect a missing
// production guard while the fake stays strict.
describe('makeFakeMap style-event timing', () => {
  it("fires 'styledata' synchronously from addImage, image already registered", () => {
    const map = makeFakeMap();
    const seen: boolean[] = [];
    map.on('styledata', () => seen.push(map.hasImage('x')));
    map.addImage('x');
    expect(seen).toEqual([true]);
  });

  it("does not fire 'styledata' for a duplicate addImage", () => {
    const map = makeFakeMap();
    map.addImage('x');
    const spy = vi.fn();
    map.on('styledata', spy);
    map.addImage('x');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on a duplicate addSource', () => {
    const map = makeFakeMap();
    map.addSource('s', { type: 'geojson' });
    expect(() => map.addSource('s', { type: 'geojson' })).toThrow('Source "s" already exists.');
  });

  it("does not fire 'styledata' synchronously from addSource or addLayer", () => {
    const map = makeFakeMap();
    const spy = vi.fn();
    map.on('styledata', spy);
    map.addSource('s', { type: 'geojson' });
    map.addLayer({ id: 'l', type: 'line', source: 's' });
    expect(spy).not.toHaveBeenCalled();
  });
});
