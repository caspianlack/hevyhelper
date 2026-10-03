// In-app chat: Claude (Anthropic API) or ChatGPT (OpenAI API), both wired to the
// same training-data tools as the MCP server. Conversations live in memory.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { tools, runTool, jsonSchema, INSTRUCTIONS } from './tools.mjs';

const MAX_TOOL_ROUNDS = 12;

export function providers() {
  return [
    { id: 'claude', label: 'Claude', model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5', available: !!process.env.ANTHROPIC_API_KEY },
    { id: 'openai', label: 'ChatGPT', model: process.env.OPENAI_MODEL || 'gpt-6.1-sol', available: !!process.env.OPENAI_API_KEY },
  ];
}

const system = () =>
  `You are a knowledgeable, direct strength & conditioning coach looking at the user's own Hevy training log. ` +
  `Today is ${new Date().toISOString().slice(0, 10)}. ${INSTRUCTIONS} ` +
  `Always pull the data you need with the tools before answering — never guess numbers. ` +
  `Cite specific dates, weights and reps. Keep answers concise and practical; use short markdown lists or tables when they help.`;

const conversations = new Map(); // id -> { provider, messages }

function getConversation(id, provider) {
  let conv = id && conversations.get(id);
  if (!conv || conv.provider !== provider) {
    id = randomUUID();
    conv = { provider, messages: [] };
    conversations.set(id, conv);
    if (conversations.size > 50) conversations.delete(conversations.keys().next().value);
  }
  return [id, conv];
}

async function execTool(name, input, emit) {
  emit({ type: 'tool', name, input });
  try {
    return { content: await runTool(name, input), isError: false };
  } catch (err) {
    return { content: `Error: ${err.message}`, isError: true };
  }
}

// ---------- Claude ----------
let anthropic;
const claudeTools = () => tools.map(t => ({
  name: t.name,
  description: t.description,
  input_schema: jsonSchema(t),
  eager_input_streaming: true,
}));

async function runClaude(messages, emit) {
  anthropic ??= new Anthropic();
  const model = providers()[0].model;
  let jsonRetries = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = anthropic.beta.messages.stream({
      model,
      max_tokens: 64000,
      // Server-side refusal fallback: if the model declines, the API reroutes the same request.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: system(),
      tools: claudeTools(),
      messages,
    });
    stream.on('text', text => emit({ type: 'text', text }));

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API errors propagate.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      continue;
    }

    if (message.stop_reason === 'refusal') {
      emit({ type: 'text', text: '\n\n_(The model declined to answer this.)_' });
      return;
    }
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    const toolUses = message.content.filter(b => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: message.content });
    if (!toolUses.length) return;
    if (message.stop_reason === 'max_tokens') throw new Error('Response hit max_tokens while calling a tool.');

    const results = [];
    for (const t of toolUses) {
      const r = await execTool(t.name, t.input, emit);
      results.push({ type: 'tool_result', tool_use_id: t.id, content: r.content, is_error: r.isError });
    }
    messages.push({ role: 'user', content: results });
    emit({ type: 'text', text: '\n\n' });
  }
  emit({ type: 'text', text: '\n\n_(Stopped after too many tool calls.)_' });
}

// ---------- ChatGPT ----------
let openai;
const openaiTools = () => tools.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: jsonSchema(t) },
}));

async function runOpenAI(messages, emit) {
  openai ??= new OpenAI();
  const model = providers()[1].model;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = await openai.chat.completions.create({
      model,
      stream: true,
      tools: openaiTools(),
      messages: [{ role: 'system', content: system() }, ...messages],
    });
    let text = '';
    const calls = [];
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) { text += delta.content; emit({ type: 'text', text: delta.content }); }
      for (const tc of delta.tool_calls ?? []) {
        const c = (calls[tc.index] ??= { id: '', name: '', args: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
    }
    messages.push({
      role: 'assistant',
      content: text || null,
      ...(calls.length && { tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) }),
    });
    if (!calls.length) return;

    for (const c of calls) {
      let input, r;
      try { input = JSON.parse(c.args || '{}'); } catch { r = { content: 'Error: tool arguments were not valid JSON' }; }
      r ??= await execTool(c.name, input, emit);
      messages.push({ role: 'tool', tool_call_id: c.id, content: r.content });
    }
    emit({ type: 'text', text: '\n\n' });
  }
  emit({ type: 'text', text: '\n\n_(Stopped after too many tool calls.)_' });
}

/** Run one user turn. Streams events via emit(); returns the conversation id. */
export async function chat({ conversationId, provider, message }, emit) {
  const p = providers().find(x => x.id === provider);
  if (!p) throw new Error(`Unknown provider ${provider}`);
  if (!p.available) throw new Error(`${p.label} is not configured — add ${provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} to .env and restart the server.`);

  const [id, conv] = getConversation(conversationId, provider);
  emit({ type: 'conversation', id, model: p.model });
  const before = conv.messages.length;
  conv.messages.push({ role: 'user', content: message });
  try {
    await (provider === 'claude' ? runClaude : runOpenAI)(conv.messages, emit);
  } catch (err) {
    // Roll back the failed turn so the history stays valid for the next message
    conv.messages.length = before;
    throw err;
  }
  return id;
}
