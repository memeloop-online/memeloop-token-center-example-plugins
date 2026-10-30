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


test('rejects encoded routing delimiters while preserving encoded Unicode IDs and query values', async () => {
  const dispatched = [];
  let iteration = 0;
  const validPath = '/v1/items/%E4%B8%AD/details?search=a%2Fb%3Fc%23d%25&label=hello%20world';
  const api = {
    discoverApi: async () => ({ paths: { '/v1/items/{id}/details': { get: {} } } }),
    requestApi: async request => {
      if (request.path !== '/internal/v1/inference/chat/completions') { dispatched.push(request.path); return { ok: true }; }
      return ++iteration === 1 ? answer({ tool_calls: [
        call('docs', 'discover_api', {}),
        call('encoded-slash', 'request_api', { path: '/v1/items/a%2Fdetails', method: 'GET' }),
        call('nested-encoding', 'request_api', { path: '/v1/items/a%252F/details', method: 'GET' }),
        call('encoded-question', 'request_api', { path: '/v1/items/a%3F/details', method: 'GET' }),
        call('canonical', 'request_api', { path: '/v1/items/%2e%2e/details', method: 'GET' }),
        call('legitimate-query', 'request_api', { path: validPath, method: 'GET' }),
      ] }) : answer({ content: 'Checked paths.' });
    },
  };
  await runAgentLoop(options(api));
  assert.deepEqual(dispatched, [validPath]);
});


test('operation matching prefers exact paths and literal specificity and denies ambiguous ties regardless of order', async () => {
  const cases = [
    { entries: [['/v1/{group}/{id}', { post: {} }], ['/v1/items/{id}', { post: {} }], ['/v1/items/current', { get: {} }]], path: '/v1/items/current', allowed: true },
    { entries: [['/v1/{group}/{id}', { get: {} }], ['/v1/items/{id}', { post: {} }]], path: '/v1/items/current', allowed: false },
    { entries: [['/v1/{group}/current', { get: {} }], ['/v1/items/{id}', { post: {} }]], path: '/v1/items/current', allowed: false },
  ];
  for (const scenario of cases) for (const entries of [scenario.entries, [...scenario.entries].reverse()]) {
    let iterations = 0;
    let dispatched = 0;
    const api = {
      discoverApi: async () => ({ paths: Object.fromEntries(entries) }),
      requestApi: async request => {
        if (request.path !== '/internal/v1/inference/chat/completions') { dispatched++; return {}; }
        return ++iterations === 1 ? answer({ tool_calls: [call('docs', 'discover_api', {}), call('read', 'request_api', { path: scenario.path, method: 'GET' })] }) : answer({ content: 'Checked route.' });
      },
    };
    await runAgentLoop(options(api));
    assert.equal(dispatched, Number(scenario.allowed), JSON.stringify(entries));
  }
});

test('Anthropic empty tool input normalizes null and missing inputs to native empty objects', async () => {
  for (const input of [null, undefined]) {
    let iterations = 0;
    let discoveries = 0;
    const api = {
      discoverApi: async () => { discoveries++; return { paths: {} }; },
      requestApi: async request => {
        if (++iterations === 1) return { role: 'assistant', content: [{ type: 'tool_use', id: 'docs', name: 'discover_api', ...(input === undefined ? {} : { input }) }] };
        assert.deepEqual(request.body.request.messages[1].content[0].input, {});
        return { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] };
      },
    };
    await runAgentLoop({ ...options(api), protocol: 'anthropic' });
    assert.equal(discoveries, 1);
  }
});

test('Anthropic array and scalar tool inputs remain invalid', async () => {
  for (const input of [[], 'invalid', 7]) {
    const api = {
      discoverApi: async () => { throw new Error('Must not discover'); },
      requestApi: async () => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'docs', name: 'discover_api', input }] }),
    };
    await assert.rejects(runAgentLoop({ ...options(api), protocol: 'anthropic' }), /Invalid Anthropic tool call/);
  }
});

const responses = output => ({ id: 'response-test', status: 'completed', output });
const responseText = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=';

test('Responses native tools continue through core inference with private reasoning and native function outputs', async () => {
  const requests = [];
  const events = [];
  const privateReasoning = { type: 'reasoning', id: 'private-reasoning', encrypted_content: 'opaque-private-state', summary: [] };
  const api = {
    discoverApi: async () => ({ paths: {} }),
    requestApi: async request => {
      // A stateless Responses provider only returns encrypted continuation state
      // when the client explicitly requests it before the first model call.
      assert.deepEqual(request.body.request.include, ['reasoning.encrypted_content']);
      requests.push(structuredClone(request));
      return requests.length === 1
        ? responses([privateReasoning, { type: 'function_call', id: 'fc-docs', call_id: 'docs', name: 'discover_api', arguments: '{}' }])
        : responses([responseText('Ready.')]);
    },
  };
  const result = await runAgentLoop({ ...options(api), protocol: 'responses', onEvent: event => events.push(event) });
  assert.equal(result.iterations, 2);
  assert.equal(requests[0].path, '/internal/v1/inference/responses');
  assert.equal(requests[0].body.key_id, 'selected-key-id');
  assert.equal(requests[0].body.request.stream, false);
  assert.equal(requests[0].body.request.store, false);
  assert.deepEqual(requests[0].body.request.include, ['reasoning.encrypted_content']);
  assert.equal(requests[0].body.request.tools[0].name, 'discover_api');
  assert.deepEqual(requests[1].body.request.input[1], privateReasoning);
  assert.equal(requests[1].body.request.input.at(-1).type, 'function_call_output');
  assert.equal(requests[1].body.request.input.at(-1).call_id, 'docs');
  assert.equal(JSON.stringify(events).includes('opaque-private-state'), false);
  assert.equal(JSON.stringify(result).includes('opaque-private-state'), false);
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: 'Ready.' });
});

test('GPT Image 2 uses selected outer model and core Responses endpoint and emits a final raster image', async () => {
  let inference;
  const events = [];
  const api = {
    discoverApi: async () => { throw new Error('No product tools requested'); },
    requestApi: async request => {
      inference = structuredClone(request);
      return responses([{ type: 'image_generation_call', id: 'image-one', status: 'completed', result: png }]);
    },
  };
  const result = await runAgentLoop({ ...options(api), model: 'chosen-text-route', enableImageGeneration: true, enableTools: false, onEvent: event => events.push(event) });
  assert.equal(inference.path, '/internal/v1/inference/responses');
  assert.equal(inference.body.request.model, 'chosen-text-route');
  assert.deepEqual(inference.body.request.tools, [{ type: 'image_generation', model: 'gpt-image-2' }]);
  assert.deepEqual(inference.body.request.tool_choice, { type: 'image_generation' });
  assert.equal(inference.body.request.store, false);
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: '', images: [{ dataUrl: `data:image/png;base64,${png}`, mimeType: 'image/png' }] });
  assert.equal(events.some(event => event.type === 'assistant' && event.message.images?.length === 1), true);
  assert.equal(events.some(event => event.type === 'tool'), false);
});

test('image bytes are kept in display messages and excluded from native product-tool continuation', async () => {
  let iteration = 0;
  const api = {
    discoverApi: async () => ({ paths: {} }),
    requestApi: async request => {
      if (++iteration === 1) return responses([
        { type: 'image_generation_call', status: 'completed', result: png },
        { type: 'function_call', call_id: 'docs', name: 'discover_api', arguments: '{}' },
      ]);
      assert.equal(JSON.stringify(request.body.request.input).includes(png), false);
      assert.equal(request.body.request.input.at(-1).type, 'function_call_output');
      return responses([responseText('Image ready.')]);
    },
  };
  const result = await runAgentLoop({ ...options(api), enableImageGeneration: true });
  assert.equal(result.messages[1].images[0].mimeType, 'image/png');
  assert.equal(result.messages.at(-1).content, 'Image ready.');
});

test('incomplete, partial, non-raster and unsolicited image outputs fail before display', async () => {
  const samples = [
    { ...responses([{ type: 'image_generation_call', result: png }]), status: 'incomplete' },
    responses([{ type: 'image_generation_call', status: 'in_progress', result: png }]),
    responses([{ type: 'image_generation_call', result: Buffer.from('<svg/>').toString('base64') }]),
    responses([{ type: 'image_generation_call', result: 'https://external.invalid/image.png' }]),
  ];
  for (const sample of samples) {
    const events = [];
    const api = { discoverApi: async () => ({ paths: {} }), requestApi: async () => sample };
    await assert.rejects(runAgentLoop({ ...options(api), enableImageGeneration: true, onEvent: event => events.push(event) }));
    assert.equal(events.some(event => event.type === 'assistant'), false);
  }
  const api = { discoverApi: async () => ({ paths: {} }), requestApi: async () => responses([{ type: 'image_generation_call', result: png }]) };
  await assert.rejects(runAgentLoop({ ...options(api), protocol: 'responses' }), /Unexpected image generation/);
});

test('Responses cancellation reaches the core bridge and stops without displaying late images', async () => {
  const abort = new AbortController();
  const events = [];
  const api = {
    discoverApi: async () => ({ paths: {} }),
    requestApi: async request => {
      assert.equal(request.signal, abort.signal);
      abort.abort();
      return responses([{ type: 'image_generation_call', result: png }]);
    },
  };
  const result = await runAgentLoop({ ...options(api), enableImageGeneration: true, signal: abort.signal, onEvent: event => events.push(event) });
  assert.equal(result.status, 'cancelled');
  assert.equal(events.some(event => event.type === 'assistant'), false);
});

test('core session wrapper links independent inference rounds and stays outside provider JSON', async () => {
  const requests = [];
  const api = {
    discoverApi: async () => ({ paths: {} }),
    requestApi: async request => {
      requests.push(structuredClone(request));
      return requests.length === 1 ? responses([{ type: 'function_call', call_id: 'docs', name: 'discover_api', arguments: '{}' }]) : responses([responseText('Done.')]);
    },
  };
  const result = await runAgentLoop({ ...options(api), protocol: 'responses', conversationId: 'playground-session', turnId: 'user-turn', parentTurnId: 'previous-turn' });
  assert.deepEqual(requests[0].body.conversation, { id: 'playground-session', turn_id: 'user-turn', parent_turn_id: 'previous-turn' });
  assert.equal(requests[1].body.conversation.id, 'playground-session');
  assert.equal(requests[1].body.conversation.parent_turn_id, 'user-turn');
  assert.notEqual(requests[1].body.conversation.turn_id, 'user-turn');
  assert.equal(result.lastTurnId, requests[1].body.conversation.turn_id);
  assert.equal(Object.hasOwn(requests[0].body.request, 'conversation'), false);
  assert.equal(Object.hasOwn(requests[0].body.request, 'metadata'), false);
});

test('conversation wrapper is supported for Chat and Anthropic and rejects malformed IDs before dispatch', async () => {
  for (const protocol of ['openai', 'anthropic']) {
    let wrapper;
    const api = {
      discoverApi: async () => ({ paths: {} }),
      requestApi: async request => {
        wrapper = request.body.conversation;
        return protocol === 'anthropic' ? { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } : answer({ content: 'Done.' });
      },
    };
    await runAgentLoop({ ...options(api), protocol, enableTools: false, conversationId: 'session-123', turnId: 'turn-123' });
    assert.deepEqual(wrapper, { id: 'session-123', turn_id: 'turn-123' });
    for (const conversationId of ['', 'space id', '换行', 'a'.repeat(129)]) {
      await assert.rejects(runAgentLoop({ ...options(api), conversationId }), /Invalid conversation identifier/);
    }
  }
});
