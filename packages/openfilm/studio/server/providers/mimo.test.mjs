import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import mimo from './mimo.mjs';
import { wav } from './common.mjs';

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

test('voices: the nine the API names, a limit honored; filters are said not to narrow them', async () => {
  const all = await mimo.run('voice', { limit: 100 }, ctx());
  assert.deepEqual(all.receipt.voices.map((v) => v.voiceId), ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']);
  assert.equal(all.receipt.voices[0].name, 'Default');
  assert.equal(all.receipt.voices[2].name, '茉莉');
  assert.equal(all.receipt.notes, undefined, 'asked for nothing: nothing said');
  const few = await mimo.run('voice', { limit: 2, language: 'en', gender: 'f', prompt: 'whispery' }, ctx());
  assert.deepEqual(few.receipt.voices.map((v) => v.voiceId), ['mimo_default', '冰糖']);
  assert.equal(few.receipt.notes.length, 3);
});

test('voice-over: MiMo-V2.5-TTS as a WAV in the answer, the line as the assistant\'s message', async () => {
  reply = () => [200, { choices: [{ message: { content: '', audio: { data: Buffer.from(wav(new Uint8Array(48000), 24000)).toString('base64') } } }] }];
  const result = await mimo.run('tts', { out: 'line', text: 'Hello there.', voice: 'Chloe' }, ctx());
  const body = sent(seen.at(-1));
  assert.equal(seen.at(-1).url.pathname, '/v1/chat/completions');
  assert.equal(seen.at(-1).headers['api-key'], KEY);
  assert.equal(body.model, 'mimo-v2.5-tts');
  assert.deepEqual(body.messages, [{ role: 'assistant', content: 'Hello there.' }]);
  assert.deepEqual(body.audio, { format: 'wav', voice: 'Chloe' });
  assert.equal(result.files[0].path, 'assets/audio/vo/line.wav');
  assert.equal(result.files[0].bytes.length, 48044, 'the WAV as it came, header and all');
  assert.deepEqual(result.index, [{ src: 'assets/audio/vo/line.wav', kind: 'audio', dur: 1, text: 'Hello there.', voice: 'Chloe',
    from: { mode: 'synth', text: 'Hello there.', provider: 'mimo', model: 'mimo-v2.5-tts' } }]);
  assert.equal(result.receipt.voice, 'Chloe');
  assert.match(result.receipt.notes[0], /no word timings/);
});

test('a voice it does not know is said so in the answer; an answer with no audio is refused', async () => {
  const files = {};
  reply = () => [400, { error: { code: '400', message: 'Param Incorrect', param: 'Unknown voice: NoSuchVoice. Available voices: [mimo_default, Chloe]' } }];
  await assert.rejects(mimo.run('tts', { out: 'x', text: 'hi', voice: 'NoSuchVoice' }, ctx(files)), /Xiaomi MiMo answered 400: Param Incorrect/);
  reply = () => [200, { choices: [{ message: { content: '' } }] }];
  await assert.rejects(mimo.run('tts', { out: 'x', text: 'hi', voice: 'Chloe' }, ctx(files)), /answered with no audio/);
});

test('another verb is refused', async () => {
  await assert.rejects(mimo.run('sfx', { out: 'x', prompt: 'boom' }, ctx()), /Xiaomi MiMo does not do sfx/);
});
