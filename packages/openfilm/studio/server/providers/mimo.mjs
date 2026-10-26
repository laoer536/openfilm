// @ts-check
/**
 * Xiaomi MiMo with the person's own key: speech recognition (MiMo-V2.5-ASR) through the MiMo API
 * (https://platform.xiaomimimo.com/docs): a chat completion whose user message carries the audio inline, the
 * key in an `api-key` header. The answer is the text alone, with no word timings: subtitles spread it over the
 * recording. A Token Plan subscriber reaches the same API and key through its gateway
 * (https://token-plan-cn.xiaomimimo.com): OPENFILM_MIMO_URL points there.
 */
import { billedBy, call, modelOf, needed, round, serviceUrl, text } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Xiaomi MiMo';
/** the models it transcribes with, the default first (https://platform.xiaomimimo.com/docs) */
const MODELS = { asr: [{ id: 'mimo-v2.5-asr', name: 'MiMo-V2.5-ASR' }] };
/** the largest speech sent at once */
const MAX_UPLOAD = 100 * 1024 * 1024;
/** how long a transcription may take before it is given up on (long speech on a small model) */
const TIMEOUT_MS = 300_000;

/** @type {Provider} */
export default {
  id: 'mimo',
  name: NAME,
  env: 'MIMO_API_KEY',
  keysUrl: 'https://platform.xiaomimimo.com/console/api-keys',
  billingUrl: 'https://platform.xiaomimimo.com/console/recharge',
  verbs: ['asr'],
  models: MODELS,
  speechFormat: 'mp3',
  async run(verb, args, ctx) {
    if (verb !== 'asr') throw new Error(`${NAME} does not do ${verb}.`);
    const src = needed(args, 'src');
    const bytes = await ctx.read(src);
    if (!bytes.length || bytes.length >= MAX_UPLOAD) throw new Error(`MiMo takes speech under 100 MB and this is ${Math.ceil(bytes.length / 1048576)} MB. No audio was uploaded.`);
    const model = modelOf(MODELS, 'asr', ctx);
    const base = serviceUrl('MIMO', 'https://api.xiaomimimo.com');
    const res = await call(NAME, `${base}/v1/chat/completions`, {
      method: 'POST', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: { 'content-type': 'application/json', 'api-key': ctx.key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/mpeg;base64,${Buffer.from(bytes).toString('base64')}` } }] }],
      }),
    }, ctx);
    let body;
    try { body = await res.json(); } catch { throw new Error(`${NAME} answered without JSON. Not retried.`); }
    const said = text(/** @type {any} */ (body)?.choices?.[0]?.message?.content);
    /* the seconds of audio it counted (a part of a second counts as one): how far the lines spread */
    const seconds = Number(/** @type {any} */ (body)?.usage?.seconds);
    return {
      files: [],
      index: [{ src, text: said, ...(Number.isFinite(seconds) && seconds > 0 ? { dur: round(seconds) } : {}), transcribed: true }],
      receipt: { provider: 'mimo', model, src, text: said, notes: ['MiMo gives no word timings: subtitles spread the text over the recording'] },
      cost: billedBy(NAME),
    };
  },
};
