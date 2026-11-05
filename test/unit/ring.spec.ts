import { test, expect } from '@playwright/test';
import { RingBuffer } from '../../src/shared/ring.ts';

test('drops oldest beyond limit', () => {
  const r = new RingBuffer<number>(3);
  for (let i = 1; i <= 5; i++) r.push(i);
  expect(r.toArray()).toEqual([3, 4, 5]);
  expect(r.size).toBe(3);
});

test('setLimit shrinks keeping newest in order', () => {
  const r = new RingBuffer<number>(3);
  for (let i = 1; i <= 5; i++) r.push(i);
  r.setLimit(2);
  expect(r.toArray()).toEqual([4, 5]);
  r.push(6);
  expect(r.toArray()).toEqual([5, 6]);
});

test('order preserved and clear', () => {
  const r = new RingBuffer<string>(10);
  r.push('a'); r.push('b'); r.push('c');
  expect(r.toArray()).toEqual(['a', 'b', 'c']);
  r.clear();
  expect(r.toArray()).toEqual([]);
  expect(r.size).toBe(0);
});
