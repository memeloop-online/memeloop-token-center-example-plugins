// Share the existing image budget with the incremental transport parser. No
// event queue or full-stream string is retained; native reads provide backpressure.
export const MAX_IMAGE_BASE64 = Math.ceil(16 * 1024 * 1024 / 3) * 4;
export const MAX_GENERATED_IMAGES = 4;
const MAX_EVENT_CHARS = MAX_IMAGE_BASE64 * MAX_GENERATED_IMAGES + 120000;
const aborted = () => new DOMException('Agent run cancelled', 'AbortError');

export async function readResponsesStream({ body }, signal) {
  if (!body?.getReader) throw new Error('Responses inference returned no event stream');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '';
  let skipLF = false;
  let data = [];
  let eventSize = 0;
  let completed;
  let responseId;
  let retainedSize = 0;
  const items = new Map();
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  function dispatch() {
    if (!data.length) return;
    const text = data.join('\n'); data = []; eventSize = 0;
    if (text === '[DONE]') {
      if (!completed) throw new Error('Responses stream ended before its completed response');
      return;
    }
    let event;
    try { event = JSON.parse(text); } catch { throw new Error('Responses stream contains invalid JSON'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid Responses event');
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      throw new Error('Responses inference did not complete; try again or check the request record.');
    }
    if (event.response?.id) {
      if (responseId && responseId !== event.response.id) throw new Error('Responses stream changed response identity');
      responseId = event.response.id;
    }
    if (event.type === 'response.output_item.done') {
      const item = event.item;
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(event.output_index) || event.output_index < 0) throw new Error('Invalid completed Responses item');
      // Delta/partial images never enter this map. A complete item is held until
      // response.completed establishes the final status and usage of the turn.
      const size = JSON.stringify(item).length;
      retainedSize += size - (items.get(event.output_index)?.size ?? 0);
      if (retainedSize > MAX_EVENT_CHARS) throw new Error('Responses output exceeds the image result budget');
      items.set(event.output_index, { item, size });
    } else if (event.type === 'response.completed') {
      const response = event.response;
      if (completed || response?.status !== 'completed' || !Array.isArray(response.output)) throw new Error('Invalid completed Responses response');
      const output = response.output.map((item, index) => {
        const done = items.get(index)?.item;
        // Some providers send image bytes only on the complete output item. Only
        // the same terminal image identity may supply a missing final result.
        if (item?.type === 'image_generation_call' && item.result == null && done?.type === item.type && done.status === 'completed'
          && typeof item.id === 'string' && item.id === done.id) return { ...item, result: done.result };
        return item;
      });
      completed = { ...response, output };
      items.clear(); retainedSize = 0;
    }
  }
  function acceptLine(value) {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value) { dispatch(); return; }
    if (value.startsWith(':')) return;
    if (value === 'data' || value.startsWith('data:')) {
      const field = value === 'data' ? '' : value.slice(5).replace(/^ /, '');
      eventSize += field.length + 1;
      if (eventSize > MAX_EVENT_CHARS) throw new Error('Responses event exceeds the image result budget');
      data.push(field);
    }
  }
  function acceptText(text) {
    if (!text) return;
    let offset = 0;
    // A CR at a chunk boundary is already a line ending; swallow only its
    // optional LF on the next chunk. Bare CR is also legal SSE framing.
    if (skipLF) { if (text.startsWith('\n')) offset = 1; skipLF = false; }
    const endings = /\r\n|\r|\n/g;
    endings.lastIndex = offset;
    let match;
    while ((match = endings.exec(text))) {
      const next = line + text.slice(offset, match.index);
      if (next.length + eventSize > MAX_EVENT_CHARS) throw new Error('Responses event exceeds the image result budget');
      line = ''; acceptLine(next); offset = endings.lastIndex;
      if (match[0] === '\r' && offset === text.length) skipLF = true;
    }
    line += text.slice(offset);
    if (line.length + eventSize > MAX_EVENT_CHARS) throw new Error('Responses event exceeds the image result budget');
  }

  try {
    if (signal?.aborted) throw aborted();
    for (;;) {
      const result = await reader.read();
      if (signal?.aborted) throw aborted();
      if (result.done) break;
      acceptText(decoder.decode(result.value, { stream: true }));
    }
    acceptText(decoder.decode());
    if (line) acceptLine(line);
    dispatch();
    if (!completed) throw new Error('Responses stream ended before its completed response');
    return completed;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
