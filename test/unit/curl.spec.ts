import { test, expect } from '@playwright/test';
import { toCurl } from '../../src/shared/curl.ts';
import type { InterceptedRequest, CapturedBody } from '../../src/shared/types.ts';

function req(over: Partial<InterceptedRequest>): InterceptedRequest {
  return {
    id: '1', seq: 1, timestamp: '2026-11-05T00:00:00.000Z',
    url: 'https://api.example.com/x?a=1', method: 'GET', query: [['a', '1']],
    headers: [], contentType: null, body: null, kind: 'fetch', source: 'hook',
    status: 'BLOCKED', origin: { tabId: 1 }, notes: [], ...over,
  };
}

test('POST JSON with header and quote escaping', () => {
  const body: CapturedBody = { type: 'json', raw: '{"q":"it\'s"}', parsed: { q: "it's" } };
  const c = toCurl(req({
    method: 'POST',
    headers: [['Authorization', 'Bearer x'], ['Content-Type', 'application/json']],
    contentType: 'application/json',
    body,
  }));
  expect(c).toContain('-X POST');
  expect(c).toContain("-H 'Authorization: Bearer x'");
  expect(c).toContain(`--data-raw '{"q":"it'\\''s"}'`);
  expect(c).toContain("'https://api.example.com/x?a=1'");
});

test('GET without body has no --data', () => {
  const c = toCurl(req({}));
  expect(c).not.toContain('--data');
  expect(c).toContain("'https://api.example.com/x?a=1'");
});

test('formdata -> -F fields', () => {
  const c = toCurl(req({
    method: 'POST',
    body: {
      type: 'formdata',
      fields: [
        { name: 'name', value: 'Rayan' },
        { name: 'file', file: { name: 'x.txt', type: 'text/plain', size: 3 } },
      ],
    },
  }));
  expect(c).toContain("-F 'name=Rayan'");
  // Nunca @<nome da página>: o curl leria/enviaria um arquivo local do usuário.
  expect(c).not.toContain('@x.txt');
  expect(c).toContain("-F 'file=@ARQUIVO_AQUI'");
  expect(c).toMatch(/^# arquivo "x\.txt" \(text\/plain, 3 bytes\)/m);
});

test('file field name cannot inject a path or a newline', () => {
  const c = toCurl(req({
    method: 'POST',
    body: { type: 'formdata', fields: [{ name: 'f', file: { name: '../.netrc\nrm -rf ~', type: 'x', size: 1 } }] },
  }));
  expect(c).not.toContain('.netrc\n');
  expect(c).not.toMatch(/@\.\.\/\.netrc/);
  expect(c).toContain("-F 'f=@ARQUIVO_AQUI'");
});

test('binary -> omitted comment', () => {
  const c = toCurl(req({
    method: 'POST',
    body: { type: 'binary', mime: null, size: 3, previewHex: '0001ff' },
  }));
  expect(c).toContain('# body binário (3 bytes) omitido');
  expect(c).not.toContain('--data');
});

test('shell injection: method, comment text and form values are neutralized', () => {
  const evil = toCurl(req({
    method: 'X;touch /tmp/pwned',
    body: { type: 'unavailable', reason: 'x\ntouch /tmp/pwned2' },
  }));
  expect(evil).toContain(`-X 'X;touch /tmp/pwned'`);
  // Nenhuma linha fora de comentário/continuação começa com um comando injetado.
  for (const line of evil.split('\n')) {
    expect(line.startsWith('#') || line.startsWith('curl ') || line.startsWith('  ')).toBe(true);
  }
  const fd = toCurl(req({
    method: 'POST',
    body: { type: 'formdata', fields: [{ name: 'a', value: 'x;type=text/html' }] },
  }));
  expect(fd).toContain(`--form-string 'a=x;type=text/html'`);
});
