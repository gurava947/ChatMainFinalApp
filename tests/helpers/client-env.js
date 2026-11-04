'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'legacy-ui');

function readSource(relative) {
  return fs.readFileSync(path.join(PUBLIC, relative), 'utf8');
}

/** The page body, so the client's getElementById calls find their elements. */
function bodyMarkup() {
  const html = readSource('index.html');
  const start = html.indexOf('<body>') + '<body>'.length;
  const end = html.indexOf('</body>');
  return html.slice(start, end);
}

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
  });
}

function makeSocket() {
  const handlers = new Map();
  const engineHandlers = new Map();
  const emitted = [];

  const instance = {
    connected: true,
    id: 'test-socket',
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    off(event, handler) {
      const list = handlers.get(event) || [];
      handlers.set(event, list.filter((entry) => entry !== handler));
    },
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    timeout(ms) {
      return {
        emit(event, payload, ack) {
          emitted.push({ event, payload, ack, timeout: ms });
        }
      };
    },
    disconnect() {
      instance.connected = false;
      (handlers.get('disconnect') || []).forEach((fn) => fn('io client disconnect'));
    },
    io: {
      on(event, handler) {
        engineHandlers.set(event, handler);
      }
    }
  };

  return {
    instance,
    emitted,
    fire(event, payload) {
      (handlers.get(event) || []).forEach((fn) => fn(payload));
    },
    fireEngine(event) {
      (engineHandlers.get(event) || []).forEach((fn) => fn());
    },
    /** The most recent emit for an event, newest last. */
    last(event) {
      return emitted.filter((entry) => entry.event === event).pop();
    },
    /** Answer the pending ack of the last emit for an event. */
    answer(event, payload, err) {
      const entry = this.last(event);
      if (!entry || typeof entry.ack !== 'function') throw new Error(`no ack pending for ${event}`);
      entry.ack(err || null, payload);
    }
  };
}

function uploadStub() {
  const state = { responses: [], sent: [] };

  function XMLHttpRequestMock() {
    const local = {};
    this.upload = { addEventListener: () => {} };
    this.open = () => {};
    this.setRequestHeader = () => {};
    this.addEventListener = (name, handler) => {
      local[name] = handler;
    };
    this.send = (form) => {
      state.sent.push(form);
      this.status = 200;
      const next = state.responses.shift();
      this.responseText = JSON.stringify(next || { media: [] });
      if (local.load) local.load();
    };
  }

  return {
    XMLHttpRequest: XMLHttpRequestMock,
    state,
    respond(body) {
      state.responses.push(body);
    }
  };
}

/**
 * The client registers `window`/`document` listeners it cannot unregister, and
 * jsdom keeps one window per test file, so a second boot would let the first
 * client act on shared state (localStorage, in particular). Recording the
 * listeners lets the next boot start from a clean page.
 */
let previousTeardown = null;

function installListenerTracking(targetNames) {
  const added = [];
  for (const name of targetNames) {
    const target = name === 'window' ? window : document;
    const original = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, handler, options) => {
      if (typeof handler === 'function') added.push({ remove, type, handler, options });
      original(type, handler, options);
    };
  }
  return () => {
    added.forEach(({ remove, type, handler, options }) => remove(type, handler, options));
    if (window.GChat) {
      window.GChat.state.retries.forEach((timer) => clearTimeout(timer));
      window.GChat.state.retries.clear();
    }
  };
}

/**
 * Boots the real client scripts inside jsdom with a fake socket, fetch and
 * upload transport. Returns the handles a test needs to drive them.
 */
function loadClient({ rich = true, session = { userId: 'user-1', displayName: 'Arjun' } } = {}) {
  if (previousTeardown) previousTeardown();
  previousTeardown = installListenerTracking(['window', 'document']);

  document.body.innerHTML = bodyMarkup();
  window.localStorage.clear();

  let counter = 0;
  const uuid = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  };
  Object.defineProperty(window.crypto, 'randomUUID', { value: uuid, configurable: true });

  // jsdom has no media pipeline; the client only needs the promises to settle.
  if (window.HTMLMediaElement) {
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    window.HTMLMediaElement.prototype.pause = () => {};
    window.HTMLMediaElement.prototype.load = () => {};
  }

  // Attachment previews use blob urls, which jsdom does not implement.
  if (typeof window.URL.createObjectURL !== 'function') {
    window.URL.createObjectURL = () => 'blob:test/asset';
    window.URL.revokeObjectURL = () => {};
  }

  const socket = makeSocket();
  window.io = () => socket.instance;

  const uploads = uploadStub();
  window.XMLHttpRequest = uploads.XMLHttpRequest;

  const routes = [];
  // Registered later wins, so a test can override the default answer for one route.
  const matchRoute = (method, url) => {
    for (let i = routes.length - 1; i >= 0; i -= 1) {
      const route = routes[i];
      if (route.method === method && url.startsWith(route.url)) return route;
    }
    return null;
  };
  window.fetch = jest.fn((url, options) => {
    const method = ((options && options.method) || 'GET').toUpperCase();
    const hit = matchRoute(method, url);
    if (hit) {
      hit.calls.push({ url, options });
      return typeof hit.reply === 'function' ? hit.reply(url, options) : jsonResponse(hit.reply);
    }
    if (method === 'POST' && url === '/api/sessions') return jsonResponse(session);
    if (url === '/api/events') return jsonResponse({ media: { maxBytes: 4194304, maxPerMessage: 5 } });
    if (url.endsWith('/messages')) return jsonResponse({ room: 'general', messages: [] });
    if (url.endsWith('/media')) return jsonResponse({ room: 'general', items: [] });
    return jsonResponse({});
  });

  window.eval(readSource('js/app.js'));
  if (rich) window.eval(readSource('js/rich.js'));

  const api = {
    socket,
    uuid,
    uploads,
    session,
    G: () => window.GChat,
    route(method, url, reply) {
      routes.push({ method, url, reply, calls: [] });
      return this;
    },
    callsFor(method, url) {
      const hit = matchRoute(method, url);
      return hit ? hit.calls : [];
    },
    bodyOf(method, url) {
      const calls = this.callsFor(method, url);
      if (!calls.length) return null;
      return JSON.parse(calls[calls.length - 1].options.body);
    }
  };

  return api;
}

async function tick(times = 2) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function join(api, { displayName = 'Arjun', room = 'general' } = {}) {
  document.getElementById('display-name').value = displayName;
  document.getElementById('room-name').value = room;
  document.getElementById('join-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick(4);
  api.socket.fire('connect');
  api.socket.fire('history', { room, messages: [] });
  await tick();
}

module.exports = {
  bodyMarkup,
  join,
  jsonResponse,
  loadClient,
  readSource,
  tick
};
