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

async function post(body, apiKey) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ ...body, usage: { include: true } })
  });
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
  let data = await (await post(body, s.apiKey)).json();
  logUsage(task, data.model || model, data.usage);
  let text = messageText(data);
  if (!text) {
    // "Thinking" models can spend the whole token allowance reasoning and return no answer: retry once with room to spare.
    data = await (await post({ ...body, max_tokens: Math.max(4000, body.max_tokens * 4) }, s.apiKey)).json();
    logUsage(task, data.model || model, data.usage);
    text = messageText(data);
  }
  if (!text) throw emptyError(data.model || model, data.choices?.[0]?.finish_reason);
  return { text, finish: data.choices?.[0]?.finish_reason, model: data.model || model };
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

/** Streaming completion. Calls onToken for each delta, resolves with the full text. */
export async function stream({ task, model, messages, maxTokens, temperature, onToken, signal }) {
  const s = getSettings();
  model ||= s.chatModel;
  const res = await post(
    { model, messages, max_tokens: maxTokens ?? s.maxReplyTokens, temperature: temperature ?? s.temperature, stream: true },
    s.apiKey
  );
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage = null;
  let servedModel = model;
  signal?.addEventListener('abort', () => reader.cancel().catch(() => {}));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onToken?.(delta);
      }
    }
  }
  logUsage(task, servedModel, usage);
  if (!full.trim()) throw emptyError(servedModel);
  return full;
}

let modelCache = { at: 0, data: null };

/** Model list with pricing (per-token USD), cached for an hour. */
export async function listModels() {
  if (modelCache.data && Date.now() - modelCache.at < 3600_000) return modelCache.data;
  const res = await fetch(`${BASE_URL}/models`);
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
