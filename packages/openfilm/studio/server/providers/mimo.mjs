// @ts-check
/**
 * Xiaomi MiMo with the person's own key: speech recognition (MiMo-V2.5-ASR) and voice-over (MiMo-V2.5-TTS) through
 * the MiMo API (https://platform.xiaomimimo.com/docs). Both are chat completions under /v1/chat/completions with the
 * key in an `api-key` header: recognition carries the audio inline and answers the text alone (no word timings:
 * subtitles spread it over the recording); speech sends the line as the assistant's message and answers a WAV in
 * `message.audio.data`, with no word timings either. A Token Plan subscriber reaches the same API and key through its
 * gateway (https://token-plan-cn.xiaomimimo.com): OPENFILM_MIMO_URL points there. The voices are the ones the API
 * names; it has no endpoint to list them.
 */
import { billedBy, call, clamp, landing, modelOf, needed, notes, number, round, serviceUrl, text, wavSeconds } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Xiaomi MiMo';
/** the models it makes each kind of media with, the default first (https://platform.xiaomimimo.com/docs) */
const MODELS = {
  asr: [{ id: 'mimo-v2.5-asr', name: 'MiMo-V2.5-ASR' }],
  tts: [{ id: 'mimo-v2.5-tts', name: 'MiMo-V2.5-TTS' }],
};
/** the voices it speaks with, as the API names them in its errors (no listing endpoint) */
const VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
/** the largest speech sent at once */
const MAX_UPLOAD = 100 * 1024 * 1024;
/** how long one request may take (a long recording, a long line) */
const TIMEOUT_MS = 300_000;

/** @type {Provider} */
export default {
  id: 'mimo',
  name: NAME,
  env: 'MIMO_API_KEY',
  keysUrl: 'https://platform.xiaomimimo.com/console/api-keys',
  billingUrl: 'https://platform.xiaomimimo.com/console/recharge',
  verbs: ['voice', 'tts', 'asr'],
  models: MODELS,
  speechFormat: 'mp3',
  async run(verb, args, ctx) {
    const base = serviceUrl('MIMO', 'https://api.xiaomimimo.com');
    const send = (/** @type {Record<string, unknown>} */ payload) =>
      call(NAME, `${base}/v1/chat/completions`, {
        method: 'POST', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        headers: { 'content-type': 'application/json', 'api-key': ctx.key }, body: JSON.stringify(payload),
      }, ctx);
    /** @returns {Promise<any>} */
    const answered = async (/** @type {Record<string, unknown>} */ payload) => {
      const res = await send(payload);
      try { return await res.json(); } catch { throw new Error(`${NAME} answered without JSON. Not retried.`); }
    };

    if (verb === 'voice') {
      const said = [
        ...(text(args.language) ? ['MiMo\'s voices speak what they are given: --language does not narrow them'] : []),
        ...(text(args.gender) ? ['MiMo\'s voices have no set gender'] : []),
        ...(text(args.prompt) ? ['--prompt does not narrow MiMo\'s voices'] : []),
      ];
      const limit = clamp(Math.round(number(args.limit) ?? 5), 1, 100);
      const voices = VOICES.slice(0, limit).map((id) => ({ voiceId: id, name: id === 'mimo_default' ? 'Default' : id, language: null, gender: null, description: null }));
      return { files: [], index: [], receipt: { provider: 'mimo', voices, ...notes(said) } };
    }
    if (verb === 'tts') {
      const said = needed(args, 'text');
      const voice = needed(args, 'voice');
      const model = modelOf(MODELS, 'tts', ctx);
      const body = await answered({
        model,
        messages: [{ role: 'assistant', content: said }],
        audio: { format: 'wav', voice },
      });
      const data = body?.choices?.[0]?.message?.audio?.data;
      if (typeof data !== 'string' || !data) throw new Error(`${NAME} answered with no audio. Not retried.`);
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      const dur = wavSeconds(bytes);
      const path = landing('audio/vo', args.out, 'wav');
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), text: said, voice, from: { mode: 'synth', text: said, provider: 'mimo', model } }],
        receipt: { provider: 'mimo', model, src: path, dur, voice, notes: ['MiMo gives no word timings: `get asr` on the file makes timed subtitles'] },
        cost: billedBy(NAME),
      };
    }
    if (verb === 'asr') {
      const src = needed(args, 'src');
      const bytes = await ctx.read(src);
      if (!bytes.length || bytes.length >= MAX_UPLOAD) throw new Error(`MiMo takes speech under 100 MB and this is ${Math.ceil(bytes.length / 1048576)} MB. No audio was uploaded.`);
      const model = modelOf(MODELS, 'asr', ctx);
      const body = await answered({
        model,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/mpeg;base64,${Buffer.from(bytes).toString('base64')}` } }] }],
      });
      const said = text(body?.choices?.[0]?.message?.content);
      /* the seconds of audio it counted (a part of a second counts as one): how far the lines spread */
      const seconds = Number(body?.usage?.seconds);
      return {
        files: [],
        index: [{ src, text: said, ...(Number.isFinite(seconds) && seconds > 0 ? { dur: round(seconds) } : {}), transcribed: true }],
        receipt: { provider: 'mimo', model, src, text: said, notes: ['MiMo gives no word timings: subtitles spread the text over the recording'] },
        cost: billedBy(NAME),
      };
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
