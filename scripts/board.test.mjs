import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { options, available } from './board.mjs';

test('explicit modes and remote scope; reject invalid options before starting', () => {
  assert.equal(options([]).mode, 'continuous');
  assert.equal(options(['--no-local', '--hosts', 'fixture']).hosts, 'fixture');
  for (const args of [['--port','0'],['--port','3003;bad'],['--mode','silent-mock'],['--no-local'],['unknown']]) assert.throws(() => options(args));
});

test('occupied port fails without changing the owner', async () => {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await assert.rejects(available(server.address().port), /端口/);
    assert.equal(server.listening,true);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
