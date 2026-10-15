import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from './agent-loop.mjs';

const answer = message => ({ choices: [{ message: { role: 'assistant', ...message } }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const options = api => ({ api, keyId: 'selected-key-id', model: 'model', messages: [{ role: 'user', content: 'Inspect workspace' }] });

test('uses selected inference key and resumes after discovery through official loop', async () => {
  const requests = [];
  const api = {
    discoverApi: async () => ({ paths: { '/internal/v1/workspaces': { get: {} } } }),
    requestApi: async request => {
      requests.push(request);
      return requests.length === 1
        ? answer({ tool_calls: [call('discover', 'discover_api', {})] })
        : answer({ content: 'Available APIs inspected.' });
    },
  };
  const result = await runAgentLoop(options(api));
  assert.equal(result.status, 'completed');
  assert.equal(result.iterations, 2);
  assert.equal(requests[0].body.key_id, 'selected-key-id');
  assert.equal(requests[1].body.request.messages.at(-1).role, 'tool');
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: 'Available APIs inspected.' });
});

test('denies secret routes and unconfirmed changes without sending API operations', async () => {
  let inferenceCalls = 0;
  let operations = 0;
  const api = {
    discoverApi: async () => ({ paths: { '/internal/v1/workspaces': { post: {} } } }),
    requestApi: async request => {
      if (request.path !== '/internal/v1/inference/chat/completions') { operations++; return {}; }
      inferenceCalls++;
      return inferenceCalls === 1 ? answer({ tool_calls: [
        call('docs', 'discover_api', {}),
        call('secret', 'request_api', { path: '/internal/v1/keys', method: 'POST', body: {} }),
        call('change', 'request_api', { path: '/internal/v1/workspaces', method: 'POST', body: {} }),
      ] }) : answer({ content: 'Changes declined.' });
    },
  };
  await runAgentLoop(options(api));
  assert.equal(operations, 0);
});

test('cancellation interrupts a pending inference and prevents subsequent tools', async () => {
  const controller = new AbortController();
  let discoveries = 0;
  const api = {
    discoverApi: async () => { discoveries++; },
    requestApi: async () => { controller.abort(); return new Promise(() => {}); },
  };
  const result = await runAgentLoop({ ...options(api), signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(discoveries, 0);
});

test('bounded loop stops repeated model tool requests', async () => {
  let calls = 0;
  const api = {
    discoverApi: async () => ({ paths: { '/internal/v1/workspaces': { post: {} } } }),
    requestApi: async () => answer({ tool_calls: [call(String(++calls), 'discover_api', {})] }),
  };
  const result = await runAgentLoop({ ...options(api), maxIterations: 2 });
  assert.equal(result.status, 'max-iterations');
  assert.equal(calls, 2);
});


test('discovery search reaches paths after a large alphabetical prefix and resolves refs', async () => {
  let iteration = 0;
  let toolResult;
  const paths = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`/internal/v1/aaa${index}`, { get: { summary: 'Prefix' } }]));
  paths['/internal/v1/zebra'] = { get: { summary: 'Find zebra', responses: { 200: { $ref: '#/components/responses/Zebra' } } } };
  const api = {
    discoverApi: async () => ({ paths, components: { responses: { Zebra: { description: 'Zebra result' } } } }),
    requestApi: async request => {
      if (++iteration === 1) return answer({ tool_calls: [call('docs', 'discover_api', { search: 'zebra', path: '/internal/v1/zebra' })] });
      toolResult = JSON.parse(request.body.request.messages.at(-1).content);
      return answer({ content: 'Found zebra.' });
    },
  };
  await runAgentLoop(options(api));
  assert.equal(toolResult.total, 1);
  assert.equal(toolResult.operations[0].path, '/internal/v1/zebra');
  assert.equal(toolResult.references['#/components/responses/Zebra'].description, 'Zebra result');
});

test('passes cancellation signal into discovery, inference, and confirmed API transport', async () => {
  const controller = new AbortController();
  let iteration = 0;
  let operations = 0;
  const api = {
    discoverApi: async signal => { assert.equal(signal, controller.signal); return { paths: { '/internal/v1/workspaces': { post: {} } } }; },
    requestApi: async request => {
      assert.equal(request.signal, controller.signal);
      if (request.path !== '/internal/v1/inference/chat/completions') { operations++; return {}; }
      return ++iteration === 1 ? answer({ tool_calls: [call('docs', 'discover_api', {}), call('write', 'request_api', { path: '/internal/v1/workspaces', method: 'POST', body: {} })] }) : answer({ content: 'Done' });
    },
  };
  await runAgentLoop({ ...options(api), signal: controller.signal, confirmMutation: async () => true });
  assert.equal(operations, 1);
});

test('rejects undocumented operations even after successful discovery', async () => {
  let iteration = 0;
  let operations = 0;
  const api = {
    discoverApi: async () => ({ paths: {} }),
    requestApi: async request => {
      if (request.path !== '/internal/v1/inference/chat/completions') { operations++; return {}; }
      return ++iteration === 1 ? answer({ tool_calls: [call('docs', 'discover_api', {}), call('read', 'request_api', { path: '/internal/v1/imaginary', method: 'GET' })] }) : answer({ content: 'Unavailable.' });
    },
  };
  await runAgentLoop(options(api));
  assert.equal(operations, 0);
});


test('preserves provider reasoning privately for tool continuation without exposing it', async () => {
  const privateReasoning = 'provider-private-continuation-state';
  const events = [];
  let inferenceCalls = 0;
  let continuation;
  const api = {
    discoverApi: async () => ({ paths: {} }),
    requestApi: async request => {
      if (++inferenceCalls === 1) return answer({ content: 'Inspecting APIs.', reasoning_content: privateReasoning, tool_calls: [call('docs', 'discover_api', {})] });
      continuation = request.body.request.messages.find(message => message.role === 'assistant');
      return answer({ content: 'Inspection complete.', reasoning_content: 'private-final-state' });
    },
  };
  const result = await runAgentLoop({ ...options(api), onEvent: event => events.push(event) });
  assert.equal(continuation.reasoning_content, privateReasoning);
  assert.equal(continuation.tool_calls[0].id, 'docs');
  assert.equal(JSON.stringify(events).includes(privateReasoning), false);
  assert.equal(JSON.stringify(events).includes('reasoning_content'), false);
  assert.equal(JSON.stringify(result).includes('reasoning_content'), false);
  assert.equal(JSON.stringify(result).includes('private-final-state'), false);
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: 'Inspection complete.' });
});

test('tool-less mode omits tool definitions from inference and never runs tools', async () => {
  let discoveries = 0;
  let inferenceRequest;
  const api = {
    discoverApi: async () => { discoveries++; return { paths: {} }; },
    requestApi: async request => { inferenceRequest = request.body.request; return answer({ content: 'Text-only answer.' }); },
  };
  const result = await runAgentLoop({ ...options(api), enableTools: false });
  assert.equal(Object.hasOwn(inferenceRequest, 'tools'), false);
  assert.equal(discoveries, 0);
  assert.equal(result.iterations, 1);
});

test('Anthropic tool continuation uses selected key, Messages endpoint, and native private blocks', async () => {
  const events = [];
  const thinking = { type: 'thinking', thinking: 'private-anthropic-thought', signature: 'opaque-signature' };
  let iterations = 0;
  let continuation;
  const api = {
    discoverApi: async () => ({ paths: {} }),
    requestApi: async request => {
      assert.equal(request.path, '/internal/v1/inference/messages');
      assert.equal(request.body.key_id, 'selected-key-id');
      assert.equal(request.body.request.model, 'claude-selected');
      assert.equal(request.body.request.max_tokens, 2048);
      assert.equal(typeof request.body.request.system, 'string');
      assert.equal(request.body.request.messages.some(message => message.role === 'system'), false);
      assert.equal(request.body.request.tools[0].name, 'discover_api');
      assert.equal(request.body.request.tools[0].input_schema.type, 'object');
      if (++iterations === 1) return { role: 'assistant', content: [thinking, { type: 'text', text: 'Inspecting.' }, { type: 'tool_use', id: 'tool-discovery', name: 'discover_api', input: {} }] };
      continuation = structuredClone(request.body.request.messages);
      return { role: 'assistant', content: [{ type: 'text', text: 'Inspection complete.' }] };
    },
  };
  const result = await runAgentLoop({ ...options(api), model: 'claude-selected', protocol: 'anthropic', onEvent: event => events.push(event) });
  assert.deepEqual(continuation[1].content[0], thinking);
  assert.equal(continuation[2].role, 'user');
  assert.equal(continuation[2].content[0].type, 'tool_result');
  assert.equal(continuation[2].content[0].tool_use_id, 'tool-discovery');
  assert.equal(JSON.parse(continuation[2].content[0].content).total, 0);
  assert.equal(JSON.stringify(events).includes(thinking.thinking), false);
  assert.equal(JSON.stringify(result).includes(thinking.signature), false);
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: 'Inspection complete.' });
});

test('Anthropic text-only mode has native plain Messages request and no tools', async () => {
  const api = {
    discoverApi: async () => { throw new Error('Must not discover'); },
    requestApi: async request => {
      assert.equal(request.path, '/internal/v1/inference/messages');
      assert.equal(Object.hasOwn(request.body.request, 'tools'), false);
      assert.deepEqual(request.body.request.messages, [{ role: 'user', content: 'Inspect workspace' }]);
      return { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'private-opaque' }, { type: 'text', text: 'Text response.' }] };
    },
  };
  const result = await runAgentLoop({ ...options(api), protocol: 'anthropic', enableTools: false });
  assert.equal(result.status, 'completed');
  assert.equal(JSON.stringify(result).includes('private-opaque'), false);
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: 'Text response.' });
});
