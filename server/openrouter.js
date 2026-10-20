import { jsonrepair } from 'jsonrepair';
import { db, getSettings } from './db.js';

const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

function headers(apiKey) {
  if (!apiKey) throw httpError(400, 'No OpenRouter API key set. Add one in Settings.');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/ethanmi31/multiversalsocialmedia',
    'X-Title': 'Multiversal Social Media'
  };
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** What has been spent today (local time), as reported by OpenRouter. */
export function spentToday() {
  return db.prepare("SELECT COALESCE(SUM(cost), 0) AS c FROM usage_log WHERE date(created_at, 'localtime') = date('now', 'localtime')").get().c;
}

/** Refuses new AI calls once the daily spending limit is reached. */
function checkBudget(limit) {
  if (!(limit > 0)) return;
  const spent = spentToday();
  if (spent >= limit) {
    throw httpError(402, `Daily spending limit reached: $${spent.toFixed(4)} of $${Number(limit).toFixed(2)} spent today. Raise or turn off the limit in Settings, or wait until tomorrow.`);
  }
}

function logUsage(task, model, usage) {
  if (!usage) return;
  db.prepare(
    'INSERT INTO usage_log (task, model, prompt_tokens, completion_tokens, cached_tokens, cost) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    task,
    model,
    usage.prompt_tokens || 0,
    usage.completion_tokens || 0,
    usage.prompt_tokens_details?.cached_tokens || 0,
    usage.cost || 0
  );
}

const REQUEST_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 180_000;
const STREAM_IDLE_MS = Number(process.env.OPENROUTER_STREAM_IDLE_MS) || 90_000;

/** timeoutMs covers the whole request including the body; streams pass none (they can legitimately run long). */
async function post(body, apiKey, timeoutMs, signal) {
  checkBudget(getSettings().dailySpendLimit);
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({ ...body, usage: { include: true } }),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : signal
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw timeoutError(body.model);
    if (e.name === 'AbortError') throw e;
    throw unreachable(e);
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch {}
    throw httpError(res.status, `OpenRouter error (${res.status}): ${msg}`);
  }
  return res;
}

/** One-shot completion. Returns the text content. */
export async function complete(opts) {
  return (await request(opts)).text;
}

/** Like complete(), but also reports why the model stopped (e.g. "length" when it ran out of tokens). */
async function request({ task, model, messages, maxTokens, temperature, json = false }) {
  const s = getSettings();
  model ||= s.utilityModel;
  const body = {
    model,
    messages,
    max_tokens: maxTokens ?? 1500,
    temperature: temperature ?? 0.7
  };
  if (json) body.response_format = { type: 'json_object' };
  let data = await postJSON(body, s.apiKey);
  logUsage(task, data.model || model, data.usage);
  let text = messageText(data);
  if (!text) {
    // "Thinking" models can spend the whole token allowance reasoning and return no answer: retry once with room to spare.
    data = await postJSON({ ...body, max_tokens: Math.max(4000, body.max_tokens * 4) }, s.apiKey);
    logUsage(task, data.model || model, data.usage);
    text = messageText(data);
  }
  if (!text) throw emptyError(data.model || model, data.choices?.[0]?.finish_reason);
  return { text, finish: data.choices?.[0]?.finish_reason, model: data.model || model };
}

/** "fetch failed" with a DNS/connection cause means we never reached OpenRouter. */
function unreachable(e) {
  const why = e.cause?.code || e.cause?.message || e.message;
  return httpError(503, `Couldn't reach OpenRouter (${why}). Check your internet connection and try again.`);
}

function timeoutError(model) {
  return httpError(504, `${model} took longer than ${REQUEST_TIMEOUT_MS / 1000}s to answer, so the request was stopped. The model or provider may be overloaded — try again or pick a faster model in Settings.`);
}

/** Non-streaming call with a timeout on both the request and reading the answer. */
async function postJSON(body, apiKey) {
  const res = await post(body, apiKey, REQUEST_TIMEOUT_MS);
  try {
    return await res.json();
  } catch (e) {
    throw e.name === 'TimeoutError' || e.name === 'AbortError' ? timeoutError(body.model) : e;
  }
}

function messageText(data) {
  const c = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(c) ? c.map((p) => p?.text || '').join('') : c || '';
  return text.trim();
}

function emptyError(model, finish) {
  return httpError(
    502,
    `The model (${model}) returned an empty response${finish ? ` (finish reason: ${finish})` : ''}. ` +
      `This usually means it is a "thinking" model that used up its tokens, or the provider filtered the request. ` +
      `Try a different model in Settings.`
  );
}

/**
 * Completion that must return JSON. Repairs common model mistakes (code fences, chatter, trailing commas,
 * smart quotes, cut-off output) and retries once if the answer still can't be read.
 */
export async function completeJSON(opts) {
  // opts.expect: the list the answer must contain (e.g. "characters"), so a reply missing it counts as unreadable
  const read = (text) => {
    const v = tryParseJSON(text);
    if (v === undefined || !opts.expect) return v;
    if (Array.isArray(v)) return { [opts.expect]: v };
    return Array.isArray(v[opts.expect]) ? v : undefined;
  };
  const first = await request({ ...opts, json: true });
  const parsed = read(first.text);
  if (parsed !== undefined) return parsed;

  const retry = first.finish === 'length'
    ? { ...opts, maxTokens: Math.min(16000, (opts.maxTokens ?? 1500) * 2) } // it ran out of room mid-answer
    : {
        ...opts,
        temperature: Math.min(opts.temperature ?? 0.7, 0.5),
        messages: [...opts.messages, { role: 'assistant', content: first.text.slice(0, 4000) }, { role: 'user', content: 'That was not valid JSON. Reply again with ONLY the JSON object, no other text.' }]
      };
  const second = await request({ ...retry, json: true });
  const again = read(second.text);
  if (again !== undefined) return again;

  console.error(`[${opts.task}] unreadable JSON from ${second.model} (finish: ${second.finish}):\n${second.text.slice(0, 1500)}`);
  throw httpError(
    502,
    `The model (${second.model}) didn't return usable data${second.finish === 'length' ? ' (it ran out of tokens)' : ''}. ` +
      'Try again, ask for fewer at once, or pick a different utility model in Settings. The raw reply was printed in the terminal.'
  );
}

/** Returns the parsed value, or undefined if the text can't be turned into JSON even after repair. */
export function tryParseJSON(text) {
  const cleaned = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // reasoning models sometimes inline their thoughts
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start < 0) return undefined; // no data at all, just prose
  const candidates = [cleaned.slice(start)];
  if (end > start) candidates.unshift(cleaned.slice(start, end + 1));
  // strict parse first, then repair (trailing commas, smart quotes, cut-off endings...)
  for (const parse of [JSON.parse, (c) => JSON.parse(jsonrepair(c))]) {
    for (const c of candidates) {
      try {
        let v = parse(c);
        if (typeof v === 'string') v = JSON.parse(v); // double-encoded
        if (v && typeof v === 'object') return v;
      } catch {}
    }
  }
  return undefined;
}

/** Streaming completion. Calls onToken for each delta; resolves with the full text and why the model stopped. */
export async function stream({ task, model, messages, maxTokens, temperature, onToken, signal }) {
  const s = getSettings();
  model ||= s.chatModel;
  // a stream may run long, but not stall: give up if it doesn't start, or goes quiet mid-reply
  const started = new AbortController();
  const startTimer = setTimeout(() => started.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await post(
      { model, messages, max_tokens: maxTokens ?? s.maxReplyTokens, temperature: temperature ?? s.temperature, stream: true },
      s.apiKey,
      null,
      AbortSignal.any([started.signal, ...(signal ? [signal] : [])])
    );
  } catch (e) {
    if (started.signal.aborted) throw timeoutError(model);
    throw e;
  } finally {
    clearTimeout(startTimer);
  }
  const reader = res.body.getReader();
  let stalled = false;
  let idle;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { stalled = true; reader.cancel().catch(() => {}); }, STREAM_IDLE_MS);
  };
  resetIdle();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage = null;
  let servedModel = model;
  let finish = null;
  signal?.addEventListener('abort', () => reader.cancel().catch(() => {}));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    resetIdle();
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // skips ": OPENROUTER PROCESSING" keep-alives
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.error) throw httpError(502, `OpenRouter error: ${chunk.error.message || 'stream failed'}`);
      if (chunk.model) servedModel = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      finish = chunk.choices?.[0]?.finish_reason || finish;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onToken?.(delta);
      }
    }
  }
  clearTimeout(idle);
  logUsage(task, servedModel, usage);
  if (stalled) throw httpError(504, `${servedModel} stopped sending its reply partway through. Try again or pick a different model.`);
  if (!full.trim()) throw emptyError(servedModel);
  return { text: full, finish };
}

let modelCache = { at: 0, data: null };

/** Model list with pricing (per-token USD), cached for an hour. */
export async function listModels() {
  if (modelCache.data && Date.now() - modelCache.at < 3600_000) return modelCache.data;
  let res;
  try {
    res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw e.name === 'TimeoutError' ? httpError(504, 'OpenRouter took too long to send the model list.') : unreachable(e);
  }
  if (!res.ok) throw httpError(res.status, 'Could not load the OpenRouter model list.');
  const json = await res.json();
  const data = (json.data || []).map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length,
    prompt: Number(m.pricing?.prompt || 0),
    completion: Number(m.pricing?.completion || 0)
  }));
  modelCache = { at: Date.now(), data };
  return data;
}

export async function modelPrice(id) {
  try {
    return (await listModels()).find((m) => m.id === id) || null;
  } catch {
    return null;
  }
}
