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
export async function complete({ task, model, messages, maxTokens, temperature, json = false }) {
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
  return text;
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

/** Completion that must return JSON; tolerates code fences and chatter around the object. */
export async function completeJSON(opts) {
  const text = await complete({ ...opts, json: true });
  return parseJSONLoose(text);
}

export function parseJSONLoose(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  throw httpError(502, 'The model did not return valid JSON. Try again or pick a different utility model.');
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
