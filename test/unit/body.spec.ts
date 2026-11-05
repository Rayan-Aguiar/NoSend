import { test, expect } from '@playwright/test';
import { serializeBody } from '../../src/shared/body.ts';

test('json by content-type', async () => {
  const b = await serializeBody('{"a":1}', 'application/json');
  expect(b).toMatchObject({ type: 'json', raw: '{"a":1}', parsed: { a: 1 } });
});

test('json detected by valid parse with text/plain', async () => {
  const b = await serializeBody('{"a":1}', 'text/plain');
  expect(b).toMatchObject({ type: 'json', parsed: { a: 1 } });
});

test('plain text', async () => {
  expect(await serializeBody('hello', null)).toEqual({ type: 'text', raw: 'hello' });
});

test('URLSearchParams -> urlencoded preserving repeats', async () => {
  const b = await serializeBody(new URLSearchParams('a=1&a=2'), null);
  expect(b).toEqual({ type: 'urlencoded', raw: 'a=1&a=2', params: [['a', '1'], ['a', '2']] });
});

test('FormData with field and file', async () => {
  const fd = new FormData();
  fd.append('name', 'Rayan');
  fd.append('file', new File(['abc'], 'x.txt', { type: 'text/plain' }));
  const b = await serializeBody(fd, null);
  expect(b).toEqual({
    type: 'formdata',
    fields: [
      { name: 'name', value: 'Rayan' },
      { name: 'file', file: { name: 'x.txt', type: 'text/plain', size: 3 } },
    ],
  });
});

test('Uint8Array -> binary', async () => {
  const b = await serializeBody(new Uint8Array([0, 1, 255]), null);
  expect(b).toEqual({ type: 'binary', mime: null, size: 3, previewHex: '0001ff' });
});

test('Blob 100 bytes -> previewHex of 64 bytes', async () => {
  const b = await serializeBody(new Blob([new Uint8Array(100).fill(0xab)], { type: 'application/octet-stream' }), null);
  expect(b?.type).toBe('binary');
  if (b?.type !== 'binary') throw new Error('not binary');
  expect(b.size).toBe(100);
  expect(b.mime).toBe('application/octet-stream');
  expect(b.previewHex).toHaveLength(128);
});

test('ReadableStream -> stream', async () => {
  const b = await serializeBody(new ReadableStream(), null);
  expect(b?.type).toBe('stream');
});

test('text over 1 MB is truncated', async () => {
  const big = 'x'.repeat(1048576 + 10);
  const b = await serializeBody(big, null);
  expect(b?.type).toBe('text');
  if (b?.type !== 'text') throw new Error('not text');
  expect(b.raw.length).toBe(1048576);
  expect(b.truncated).toEqual({ originalSize: 1048586 });
});

test('null -> null', async () => {
  expect(await serializeBody(null, null)).toBeNull();
  expect(await serializeBody(undefined, null)).toBeNull();
});
