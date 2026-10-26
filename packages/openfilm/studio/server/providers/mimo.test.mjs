import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import mimo from './mimo.mjs';

const KEY = 'sk-test_0123456789abcdef';
/** a fake Xiaomi MiMo on 127.0.0.1: `reply` answers each request; `seen` keeps them. */
let server;
let reply = () => [404, {}];
const seen = [];

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const call = { method: req.method, url: new URL(req.url, 'http://x'), headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(call);
    const [status, body] = await reply(call);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  process.env.OPENFILM_MIMO_URL = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const ctx = (files = {}, model) => ({ key: KEY, model, root: '/project', signal: new AbortController().signal, say: () => {}, read: async (p) => files[p] });
const sent = (call) => JSON.parse(call.body.toString('utf8'));

test('transcription: MiMo-V2.5-ASR with the audio inline in a chat completion, the key as api-key', async () => {
  reply = () => [200, { choices: [{ finish_reason: 'stop', message: { content: 'Hello，大家好。' } }], usage: { seconds: 4 } }];
  const mp3 = new Uint8Array(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]));
  const result = await mimo.run('asr', { src: 'assets/upload/talk.mp4' }, ctx({ 'assets/upload/talk.mp4': mp3 }));
  const call = seen.at(-1);
  const body = sent(call);
  assert.equal(call.url.pathname, '/v1/chat/completions');
  assert.equal(call.headers['api-key'], KEY);
  assert.equal(body.model, 'mimo-v2.5-asr');
  const audio = body.messages[0].content[0];
  assert.equal(audio.type, 'input_audio');
  assert.match(audio.input_audio.data, /^data:audio\/mpeg;base64,/);
  assert.deepEqual(Buffer.from(audio.input_audio.data.split(',')[1], 'base64'), Buffer.from(mp3), 'the speech itself, byte for byte');
  assert.deepEqual(result.files, [], 'the provider writes no files: runGet lands the transcript');
  assert.deepEqual(result.index, [{ src: 'assets/upload/talk.mp4', text: 'Hello，大家好。', dur: 4, transcribed: true }]);
  assert.equal(result.receipt.provider, 'mimo');
  assert.equal(result.receipt.model, 'mimo-v2.5-asr');
  assert.equal(result.receipt.text, 'Hello，大家好。');
  assert.match(result.receipt.notes[0], /no word timings/);
  assert.match(result.cost.note, /billed by Xiaomi MiMo/);
});

test('the model chosen in Settings is the one asked for', async () => {
  reply = () => [200, { choices: [{ message: { content: 'Two.' } }], usage: { seconds: 1 } }];
  const mp3 = new Uint8Array(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(10)]));
  await mimo.run('asr', { src: 'assets/talk.mp3' }, ctx({ 'assets/talk.mp3': mp3 }, 'mimo-v2.5-asr'));
  assert.equal(sent(seen.at(-1)).model, 'mimo-v2.5-asr');
});

test('speech over 100 MB is refused before anything is sent', async () => {
  const before = seen.length;
  const huge = new Uint8Array(100 * 1024 * 1024);
  await assert.rejects(mimo.run('asr', { src: 'assets/big.mp3' }, ctx({ 'assets/big.mp3': huge })), /under 100 MB.*No audio was uploaded/);
  assert.equal(seen.length, before);
});

test('a key it does not accept, an emptied account and an untranscribable answer each say so plainly', async () => {
  const mp3 = new Uint8Array(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(10)]));
  const files = { 'assets/talk.mp3': mp3 };
  reply = () => [401, { error: { message: 'Invalid API Key' } }];
  await assert.rejects(mimo.run('asr', { src: 'assets/talk.mp3' }, ctx(files)), /did not accept your key.*Settings/);
  reply = () => [402, { error: { message: 'Insufficient account balance' } }];
  await assert.rejects(mimo.run('asr', { src: 'assets/talk.mp3' }, ctx(files)), (e) => e.code === 'balance');
  reply = () => [200, { choices: [{ message: { content: null } }] }];
  const silent = await mimo.run('asr', { src: 'assets/talk.mp3' }, ctx(files));
  assert.equal(silent.index[0].text, '', 'silence is an answer, not an error');
  assert.equal(silent.index[0].dur, undefined);
});

test('another verb is refused', async () => {
  await assert.rejects(mimo.run('tts', { out: 'x', text: 'hi', voice: 'v' }, ctx()), /Xiaomi MiMo does not do tts/);
});
