/* GChat client. No framework, and no innerHTML for anything a user typed. */
(function () {
  'use strict';

  var MAX_MESSAGE_CHARS = 50000;
  var COLLAPSE_AFTER_CHARS = 900;
  var HISTORY_FETCH_LIMIT = 50;
  var TYPING_EMIT_EVERY_MS = 1200;
  var TYPING_STOP_AFTER_MS = 1600;
  var SEEN_FLUSH_MS = 700;
  var SEEN_BATCH_MAX = 50;
  var GROUP_WINDOW_MS = 120000;
  var MEDIA_ID = /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var SEND_ACK_TIMEOUT_MS = 8000;
  var OUTBOX_KEY = 'chat:outbox';
  var OUTBOX_MAX_ENTRIES = 40;
  var OUTBOX_MAX_TRIES = 6;
  var OUTBOX_RETRY_BASE_MS = 1000;
  var OUTBOX_RETRY_MAX_MS = 20000;
  /**
   * The server de-duplicates a client id for ten minutes. Retrying after that
   * window would store a second copy of the same message, so an older entry is
   * dropped rather than sent.
   */
  var OUTBOX_LIFETIME_MS = 10 * 60 * 1000;

  var el = {
    html: document.documentElement,
    joinScreen: document.getElementById('join-screen'),
    joinForm: document.getElementById('join-form'),
    joinError: document.getElementById('join-error'),
    displayName: document.getElementById('display-name'),
    roomName: document.getElementById('room-name'),
    submitLabel: document.querySelector('#join-form [data-role="submit-label"]'),
    chatScreen: document.getElementById('chat-screen'),
    roomTitle: document.getElementById('room-title'),
    roomAvatar: document.querySelector('[data-role="room-avatar"]'),
    composer: document.getElementById('composer'),
    composerInput: document.getElementById('message-input'),
    sendButton: document.getElementById('send-button'),
    charCount: document.querySelector('#composer-hint [data-role="char-count"]'),
    hint: document.getElementById('composer-hint'),
    messages: document.getElementById('message-list'),
    messageTemplate: document.getElementById('message-template'),
    attachmentTemplate: document.getElementById('attachment-template'),
    typing: document.getElementById('typing-indicator'),
    typingName: document.querySelector('#typing-indicator [data-role="typing-name"]'),
    presencePanel: document.getElementById('presence-panel'),
    presenceToggle: document.getElementById('presence-toggle'),
    presenceList: document.getElementById('presence-list'),
    onlineCount: document.querySelector('.pill [data-role="online-count"]'),
    status: document.getElementById('connection-status'),
    statusText: document.querySelector('#connection-status [data-role="status-text"]'),
    jump: document.getElementById('jump-to-latest'),
    jumpLabel: document.querySelector('#jump-to-latest [data-role="jump-label"]'),
    soundToggle: document.getElementById('sound-toggle'),
    desktopToggle: document.getElementById('desktop-toggle'),
    themeToggle: document.getElementById('theme-toggle'),
    themeIcon: document.querySelector('#theme-toggle [data-role="theme-icon"]'),
    leaveButton: document.getElementById('leave-button'),
    stream: document.querySelector('.chat__stream-wrap'),
    attachButton: document.getElementById('attach-button'),
    attachInput: document.getElementById('attach-input'),
    tray: document.getElementById('attach-tray'),
    toasts: document.getElementById('toasts'),
    lightbox: document.getElementById('lightbox'),
    lightboxStage: document.getElementById('lightbox-stage'),
    lightboxCaption: document.getElementById('lightbox-caption'),
    lightboxClose: document.getElementById('lightbox-close')
  };

  var baseTitle = document.title;

  var state = {
    session: null,
    room: null,
    socket: null,
    limits: { maxBytes: 50 * 1024 * 1024, maxPerMessage: 5 },
    typingUsers: new Map(),
    typingStopTimer: null,
    typingEmitTimer: null,
    unread: 0,
    soundOn: localStorage.getItem('chat:sound') !== 'off',
    desktopOn: localStorage.getItem('chat:desktop') === 'on',
    nearBottom: true,
    nodes: new Map(),          // message id -> <li>
    pending: new Map(),        // client id -> message id
    seenQueue: new Set(),
    seenSent: new Set(),
    deliveredSent: new Set(),
    seenFlushTimer: null,
    lastDayKey: null,
    lastAuthor: null,
    lastTs: 0,
    uploads: new Map(),        // client key -> { node, record, state }
    prepareFiles: null,        // rich.js hook: files -> files (may be a promise)
    attachHandler: null,       // rich.js hook: what the + button opens
    retries: new Map(),        // client id -> backoff timer
    cards: new Map(),          // message id -> card update(payload)
    observer: null
  };

  /* ---------------- helpers ---------------- */

  function initials(name) {
    return String(name || '?')
      .split(/[\s._-]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (part) { return part.charAt(0); })
      .join('') || '?';
  }

  var timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  var dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' });

  function formatTime(ts) { return timeFormat.format(new Date(ts)); }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  }

  function dayLabel(ts) {
    var today = dayKey(Date.now());
    var key = dayKey(ts);
    if (key === today) return 'Today';
    if (key === dayKey(Date.now() - 86400000)) return 'Yesterday';
    return dayFormat.format(new Date(ts));
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    var units = ['KB', 'MB', 'GB'];
    var size = value / 1024;
    var unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return size.toFixed(size < 10 ? 1 : 0) + ' ' + units[unit];
  }

  function mediaUrl(attachment) {
    var url = '/media/' + String(attachment.id || '');
    return MEDIA_ID.test(url) ? url : null;
  }

  function setStatus(status, label) {
    el.status.dataset.state = status;
    el.statusText.textContent = label;
  }

  function showError(message) {
    el.joinError.hidden = !message;
    el.joinError.textContent = message || '';
  }

  function atBottom() {
    return el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight < 90;
  }

  function scrollToLatest(force) {
    if (!force && !state.nearBottom) return;
    el.stream.scrollTop = el.stream.scrollHeight;
  }

  function clearUnread() {
    state.unread = 0;
    el.jump.hidden = true;
    document.title = baseTitle;
  }

  function bumpUnread() {
    state.unread += 1;
    el.jumpLabel.textContent = state.unread + ' new message' + (state.unread > 1 ? 's' : '');
    el.jump.hidden = false;
    document.title = '(' + state.unread + ') ' + baseTitle;
  }

  /* ---------------- theme ---------------- */

  function applyTheme(theme) {
    el.html.dataset.theme = theme;
    el.themeIcon.textContent = theme === 'dark' ? '☾' : '☀';
    localStorage.setItem('chat:theme', theme);
  }

  function initTheme() {
    var stored = localStorage.getItem('chat:theme');
    if (stored === 'dark' || stored === 'light') return applyTheme(stored);
    var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(prefersLight ? 'light' : 'dark');
  }

  /* ---------------- audio + notifications ---------------- */

  var audioCtx = null;

  function unlockAudio() {
    if (audioCtx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
  }

  function playPing(kind) {
    if (!state.soundOn) return;
    unlockAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    var now = audioCtx.currentTime;
    var gain = audioCtx.createGain();
    var osc = audioCtx.createOscillator();
    osc.type = 'sine';
    // Two tones: a brighter pair for incoming mail, a soft one for receipts.
    var first = kind === 'seen' ? 660 : 880;
    var second = kind === 'seen' ? 880 : 1320;
    osc.frequency.setValueAtTime(first, now);
    osc.frequency.exponentialRampToValueAtTime(second, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(kind === 'seen' ? 0.04 : 0.09, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  function pushToast(who, what) {
    var toast = document.createElement('div');
    toast.className = 'toast';

    var body = document.createElement('div');
    body.className = 'toast__body';

    var name = document.createElement('p');
    name.className = 'toast__who';
    name.textContent = who;

    var text = document.createElement('p');
    text.className = 'toast__what';
    text.textContent = what;

    var close = document.createElement('button');
    close.className = 'toast__close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';

    body.append(name, text);
    toast.append(body, close);
    toast.addEventListener('click', function () {
      toast.remove();
      el.composerInput.focus();
    });
    close.addEventListener('click', function (event) {
      event.stopPropagation();
      toast.remove();
    });

    el.toasts.appendChild(toast);
    while (el.toasts.children.length > 3) {
      el.toasts.firstElementChild.remove();
    }
    setTimeout(function () { toast.remove(); }, 6000);
  }

  function desktopNotify(who, what) {
    if (!state.desktopOn || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!document.hidden && document.hasFocus()) return;
    try {
      var note = new Notification(who, { body: what, tag: 'gchat-' + state.room, silent: true });
      note.onclick = function () { window.focus(); };
    } catch {
      state.desktopOn = false;
    }
  }

  function messageSnippet(message) {
    if (message.text) return message.text.slice(0, 110);
    var card = message.content && contentCards[message.kind];
    if (card && typeof card.summary === 'function') {
      var described = card.summary(message.content);
      if (described) return described;
    }
    return attachmentSummary(message.attachments) || 'attachment';
  }

  function notifyIncoming(message) {
    var snippet = messageSnippet(message);
    playPing('message');
    pushToast(message.displayName, snippet);
    desktopNotify(message.displayName, snippet);
  }

  /* ---------------- content cards + event bus ---------------- */

  /**
   * Non-text message kinds are rendered by plugins (rich.js) so this file stays
   * the transport/stream layer. A card gets a slot it owns and may return an
   * updater that receives live events for that message.
   */
  var contentCards = {};

  function registerCard(kind, definition) {
    contentCards[kind] = definition;
  }

  function renderContentCard(node, message) {
    var slot = node.querySelector('[data-role="content"]');
    var card = message.content ? contentCards[message.kind] : null;
    if (!slot || !card) return;
    slot.textContent = '';
    slot.hidden = false;
    var update = card.render(slot, message);
    if (typeof update === 'function' && message.id) {
      state.cards.set(message.id, update);
      update(message);
    }
  }

  function applyCardUpdate(payload) {
    var update = state.cards.get(payload.messageId);
    if (update) update(payload);
  }

  var listeners = {
    new_message: [],
    poll_voted: [],
    history: [],
    presence: [],
    outbox: []
  };

  function on(event, handler) {
    var list = listeners[event] || (listeners[event] = []);
    list.push(handler);
    return function unsubscribe() {
      var index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    };
  }

  function emit(event, payload) {
    (listeners[event] || []).forEach(function (handler) {
      try {
        handler(payload);
      } catch (err) {
        console.warn('[gchat] listener failed for ' + event, err);
      }
    });
  }

  /* ---------------- attachments on a message ---------------- */

  function attachmentSummary(attachments) {
    if (!attachments || !attachments.length) return '';
    var first = attachments[0];
    var label = first.kind === 'document' ? first.name : first.kind;
    return attachments.length > 1
      ? label + ' +' + (attachments.length - 1) + ' more'
      : label;
  }

  function buildAttachmentNode(attachment) {
    var node = el.attachmentTemplate.content.firstElementChild.cloneNode(true);
    var frame = node.querySelector('[data-role="frame"]');
    var name = node.querySelector('[data-role="att-name"]');
    var size = node.querySelector('[data-role="att-size"]');
    var url = mediaUrl(attachment);

    node.classList.add('att--' + (attachment.kind || 'document'));

    if (!url) {
      var missing = document.createElement('p');
      missing.className = 'att__media-failed';
      missing.textContent = 'attachment expired';
      frame.appendChild(missing);
    } else if (attachment.kind === 'image') {
      var img = document.createElement('img');
      img.alt = attachment.name || 'image';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = url;
      img.addEventListener('click', function () { openLightbox('image', url, attachment.name); });
      img.addEventListener('error', function () { frame.textContent = 'image unavailable'; });
      frame.appendChild(img);
    } else if (attachment.kind === 'video') {
      var video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.src = url;
      video.addEventListener('error', function () { frame.textContent = 'video unavailable'; });
      frame.appendChild(video);
    } else if (attachment.kind === 'audio') {
      var audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = url;
      frame.appendChild(audio);
    } else {
      var link = document.createElement('a');
      link.className = 'doc';
      link.href = url;
      link.download = attachment.name || 'file';
      link.rel = 'noopener';

      var icon = document.createElement('span');
      icon.className = 'doc__icon';
      icon.textContent = fileBadge(attachment.name);

      var meta = document.createElement('span');
      meta.className = 'doc__meta';

      var bold = document.createElement('b');
      bold.textContent = attachment.name || 'file';

      var hint = document.createElement('span');
      hint.textContent = (attachment.mime || 'file') + ' · download';

      meta.append(bold, hint);
      link.append(icon, meta);
      frame.appendChild(link);
    }

    name.textContent = attachment.kind === 'document' ? '' : (attachment.name || '');
    size.textContent = formatBytes(attachment.size);
    return node;
  }

  function fileBadge(name) {
    var match = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
    return match ? match[1].toUpperCase().slice(0, 4) : 'FILE';
  }

  function renderAttachments(into, attachments, message) {
    if (!attachments || !attachments.length) return;
    var shown = attachments;
    if (message && message.kind === 'voice') {
      // The voice card owns playback; a second native player would be noise.
      shown = attachments.filter(function (attachment) { return attachment.kind !== 'audio'; });
    }
    if (!shown.length) return;
    into.hidden = false;
    into.dataset.count = String(Math.min(shown.length, 3));
    shown.forEach(function (attachment) {
      into.appendChild(buildAttachmentNode(attachment));
    });
  }

  /* ---------------- message rendering ---------------- */

  function appendDayDivider(ts) {
    var li = document.createElement('li');
    li.className = 'day';
    var chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = dayLabel(ts);
    li.appendChild(chip);
    el.messages.appendChild(li);
    state.lastAuthor = null;
  }

  function appendActivity(text, kind) {
    var li = document.createElement('li');
    li.className = 'day';
    var chip = document.createElement('span');
    chip.className = 'chip chip--activity' + (kind === 'warn' ? ' chip--warn' : '');
    chip.textContent = text;
    li.appendChild(chip);
    el.messages.appendChild(li);
    state.lastAuthor = null;
    trimStream();
    scrollToLatest(state.nearBottom);
  }

  function trimStream() {
    while (el.messages.children.length > 500) {
      var oldest = el.messages.firstElementChild;
      forgetNode(oldest);
      el.messages.removeChild(oldest);
    }
  }

  function forgetNode(node) {
    if (!node || !node.dataset || !node.dataset.messageId) return;
    state.nodes.delete(node.dataset.messageId);
    state.cards.delete(node.dataset.messageId);
  }

  function setTicks(node, status, label) {
    var ticks = node.querySelector('[data-role="ticks"]');
    if (!ticks) return;
    ticks.hidden = false;
    ticks.dataset.state = status;
    ticks.textContent = status === 'pending' || status === 'queued' ? '⏱'
      : status === 'failed' ? '!'
        : status === 'sent' ? '✓'
          : '✓✓';
    ticks.title = label || status;
    if (status === 'seen') ticks.setAttribute('aria-label', 'Seen');
  }

  function renderMessage(message, options) {
    var opts = options || {};
    var node = el.messageTemplate.content.firstElementChild.cloneNode(true);
    var isOwn = message.userId === state.session.userId;
    var key = dayKey(message.ts);

    if (key !== state.lastDayKey) {
      appendDayDivider(message.ts);
      state.lastDayKey = key;
    }

    var grouped = isOwn === state.lastOwn && message.userId === state.lastAuthor
      && Math.abs(message.ts - state.lastTs) < GROUP_WINDOW_MS;

    node.classList.add(isOwn ? 'msg--own' : 'msg--other');
    if (grouped) node.classList.add('msg--grouped');
    if (opts.fresh !== false) node.classList.add('is-fresh');

    node.dataset.messageId = message.id || '';
    node.dataset.userId = message.userId;

    node.querySelector('[data-role="avatar"]').textContent = initials(message.displayName);

    var author = node.querySelector('[data-role="author"]');
    author.textContent = isOwn ? 'You' : message.displayName;

    var time = node.querySelector('[data-role="time"]');
    time.textContent = formatTime(message.ts);
    time.dateTime = new Date(message.ts).toISOString();

    var text = node.querySelector('[data-role="text"]');
    text.textContent = message.text || '';
    if (!message.text) text.hidden = true;

    if (message.text && message.text.length > COLLAPSE_AFTER_CHARS) {
      text.classList.add('is-clamped');
      var more = node.querySelector('[data-role="more"]');
      more.hidden = false;
      more.addEventListener('click', function () {
        var expanded = !text.classList.toggle('is-clamped');
        more.textContent = expanded ? 'Show less' : 'Show more';
      });
    }

    renderAttachments(node.querySelector('[data-role="media"]'), message.attachments, message);
    renderContentCard(node, message);

    if (isOwn) {
      setTicks(node, opts.ticks || 'sent', 'Sent');
      applyDeliveryState(node, message.deliveredTo || []);
      applySeenState(node, message.seenBy || []);
    }

    el.messages.appendChild(node);
    state.lastAuthor = message.userId;
    state.lastOwn = isOwn;
    state.lastTs = message.ts;

    trimStream();
    if (message.id) state.nodes.set(message.id, node);
    if (state.observer) state.observer.observe(node);
    return node;
  }

  function ownReaders(node) {
    return (node.dataset.readBy || '').split(',').filter(Boolean);
  }

  function applySeenState(node, seenBy) {
    var readers = (seenBy || []).filter(function (id) { return id !== state.session.userId; });
    if (!readers.length) return;
    node.dataset.readBy = readers.join(',');
    setTicks(node, 'seen', 'Seen by ' + readers.length);
  }

  /**
   * Delivery comes from the server's receipt list, never from the room being
   * online: an open socket says nothing about the message reaching it.
   */
  function applyDeliveryState(node, deliveredTo) {
    var receivers = (deliveredTo || []).filter(function (id) { return id !== state.session.userId; });
    if (!receivers.length) return;
    node.dataset.deliveredTo = receivers.join(',');
    if (node.dataset.readBy) return;
    setTicks(node, 'delivered', 'Delivered to ' + receivers.length);
  }

  /**
   * Turns the optimistic bubble into the stored message without a re-render, so
   * the reader never sees it jump. Returns false when the echo already did it.
   */
  function promoteNode(clientKey, serverMessage) {
    var optimisticId = state.pending.get(clientKey);
    if (!optimisticId) return false;
    var node = state.nodes.get(optimisticId);
    state.pending.delete(clientKey);
    state.nodes.delete(optimisticId);
    if (!node || !serverMessage || !serverMessage.id) return false;

    node.dataset.messageId = serverMessage.id;
    node.querySelector('[data-role="time"]').textContent = formatTime(serverMessage.ts);
    state.nodes.set(serverMessage.id, node);

    // The card only learns its real id here, which is what votes are keyed by.
    var update = state.cards.get(optimisticId);
    if (update) {
      state.cards.delete(optimisticId);
      state.cards.set(serverMessage.id, update);
      update({ messageId: serverMessage.id, id: serverMessage.id, results: serverMessage.results });
    }

    // A server ack proves the message left this device and was stored, so the
    // tick moves to sent; only real receipts can take it past that.
    setTicks(node, 'sent', 'Sent');
    applyDeliveryState(node, serverMessage.deliveredTo || []);
    applySeenState(node, serverMessage.seenBy || []);
    return true;
  }

  /* ---------------- read receipts ---------------- */

  function setupSeenObserver() {
    if (state.observer || !('IntersectionObserver' in window)) return;
    state.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var node = entry.target;
        var id = node.dataset.messageId;
        if (!id || node.dataset.userId === state.session.userId) return;
        if (document.hidden || !document.hasFocus()) return;
        if (state.seenSent.has(id)) return;
        state.seenQueue.add(id);
        scheduleSeenFlush();
      });
    }, { root: el.stream, threshold: 0.4 });
  }

  function scheduleSeenFlush() {
    clearTimeout(state.seenFlushTimer);
    state.seenFlushTimer = setTimeout(flushSeen, SEEN_FLUSH_MS);
  }

  function flushSeen() {
    if (!state.socket || !state.socket.connected) return;
    var ids = Array.from(state.seenQueue).slice(0, SEEN_BATCH_MAX);
    if (!ids.length) return;
    state.seenQueue.clear();
    ids.forEach(function (id) { state.seenSent.add(id); });
    state.socket.emit('message:seen', { ids: ids });
  }

  /* ---------------- delivery receipts ---------------- */

  /**
   * Reported the moment a message lands in this device's stream. Delivery is a
   * fact about this device, so it is sent eagerly instead of waiting for a scan.
   */
  function reportDelivered(messageId) {
    if (!messageId || !state.socket || !state.socket.connected) return;
    if (state.deliveredSent.has(messageId)) return;
    state.deliveredSent.add(messageId);
    state.socket.emit('message:delivered', { ids: [messageId] });
  }

  /* ---------------- requests ---------------- */

  /**
   * Every panel call carries the session header and throws with the server's
   * own reason, so callers only have to handle one error shape.
   */
  function apiRequest(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers);
    if (state.session) headers['X-Session-Id'] = state.session.userId;
    var body = opts.body;
    if (body !== undefined && body !== null && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    return fetch(path, { method: opts.method || 'GET', headers: headers, body: body })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          if (!response.ok) {
            var error = new Error(payload.error || payload.message || 'request failed (' + response.status + ')');
            error.status = response.status;
            throw error;
          }
          return payload;
        });
      });
  }

  /* ---------------- offline outbox ---------------- */

  function readOutbox() {
    var entries;
    try {
      entries = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) return [];
    return entries.filter(function (entry) { return entry && typeof entry.clientId === 'string'; });
  }

  function writeOutbox(entries) {
    try {
      if (!entries.length) localStorage.removeItem(OUTBOX_KEY);
      else localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(-OUTBOX_MAX_ENTRIES)));
    } catch {
      // Private mode or a full quota: the message is still on screen and still
      // attempted, it simply will not survive a reload.
    }
    announceQueue();
  }

  function saveOutboxEntry(entry) {
    writeOutbox(readOutbox().filter(function (item) { return item.clientId !== entry.clientId; }).concat([entry]));
  }

  function forgetOutboxEntry(clientId) {
    writeOutbox(readOutbox().filter(function (item) { return item.clientId !== clientId; }));
  }

  function loadOutboxEntry(clientId) {
    var found = readOutbox().filter(function (item) { return item.clientId === clientId; });
    return found.length ? found[0] : null;
  }

  function announceQueue() {
    emit('outbox', { count: readOutbox().length });
  }

  function pendingNode(clientId) {
    return state.nodes.get('pending-' + clientId);
  }

  function clearRetry(clientId) {
    var timer = state.retries.get(clientId);
    if (timer) clearTimeout(timer);
    state.retries.delete(clientId);
  }

  function scheduleRetry(entry) {
    clearRetry(entry.clientId);
    var delay = Math.min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_BASE_MS * Math.pow(2, entry.tries));
    state.retries.set(entry.clientId, setTimeout(function () {
      state.retries.delete(entry.clientId);
      var current = loadOutboxEntry(entry.clientId);
      // A queue left behind for another room replays when the user returns.
      if (!current || current.room !== state.room) return;
      attemptSend(current);
    }, delay));
  }

  function payloadOf(entry) {
    var payload = {
      text: entry.text,
      clientId: entry.clientId,
      attachments: (entry.attachments || []).map(function (record) {
        return { id: record.id, kind: record.kind, name: record.name, mime: record.mime, size: record.size };
      })
    };
    if (entry.content) payload.content = entry.content;
    return payload;
  }

  function describeFailure(reason) {
    // The usual dead end: queued long enough that the upload lost its TTL.
    if (/^unknown attachment/i.test(reason)) {
      return 'the attachment expired before this send could go through';
    }
    return reason;
  }

  /**
   * Only transport trouble and throttling are worth another attempt; a payload
   * the server rejected will be rejected identically forever. The server
   * answers with these two codes when the trouble is on its side.
   */
  function isRetryable(err, ack) {
    if (err) return true;
    if (!ack || !ack.error) return false;
    if (ack.error === 'rate_limited' || ack.error === 'store_unavailable') return true;
    return /timed out|timeout|network|not connected|transport close/i.test(ack.error);
  }

  function failEntry(clientId, reason) {
    forgetOutboxEntry(clientId);
    clearRetry(clientId);
    var node = pendingNode(clientId);
    if (node) setTicks(node, 'failed', reason);
    appendActivity('⚠ message not sent: ' + describeFailure(reason), 'warn');
  }

  function attemptSend(entry) {
    var node = pendingNode(entry.clientId);
    if (!state.socket || !state.socket.connected) {
      if (node) setTicks(node, 'queued', 'Waiting for a connection');
      return;
    }
    if (entry.tries >= OUTBOX_MAX_TRIES) {
      failEntry(entry.clientId, 'the server never acknowledged this send');
      return;
    }

    entry.tries += 1;
    saveOutboxEntry(entry);

    // socket.timeout() turns the ack into (err, payload), unlike plain emit.
    state.socket.timeout(SEND_ACK_TIMEOUT_MS).emit('message', payloadOf(entry), function (err, ack) {
      clearRetry(entry.clientId);
      if (!err && ack && ack.ok) {
        forgetOutboxEntry(entry.clientId);
        // Usually the room echo has already promoted this bubble; the ack is the
        // only signal when the send was de-duplicated server-side.
        promoteNode(entry.clientId, ack);
        return;
      }

      var reason = (ack && ack.error) || (err && err.message) || 'server did not acknowledge';
      if (!isRetryable(err, ack) || entry.tries >= OUTBOX_MAX_TRIES) {
        failEntry(entry.clientId, describeFailure(reason));
        return;
      }
      if (node) setTicks(node, 'queued', 'Retrying, attempt ' + entry.tries);
      scheduleRetry(entry);
    });
  }

  /**
   * One write path for everything the composer can produce. The entry is stored
   * before the first attempt so a reload or a dropped connection cannot lose it,
   * and every retry reuses one client id, which is what the server de-dupes on.
   */
  function deliver(input) {
    if (!state.session) return null;
    var now = Date.now();
    var entry = {
      clientId: input.clientId || crypto.randomUUID(),
      room: input.room || state.room,
      text: input.text || '',
      attachments: input.attachments || [],
      content: input.content || null,
      ts: input.ts || now,
      tries: typeof input.tries === 'number' ? input.tries : 0
    };
    if (!entry.text && !entry.attachments.length && !entry.content) return null;

    var optimisticId = 'pending-' + entry.clientId;
    if (!state.pending.has(entry.clientId)) {
      var node = renderMessage({
        id: optimisticId,
        room: entry.room,
        userId: state.session.userId,
        displayName: state.session.displayName,
        text: entry.text,
        attachments: entry.attachments,
        content: entry.content,
        kind: entry.content ? entry.content.type : undefined,
        clientId: entry.clientId,
        ts: entry.ts
      }, { ticks: 'queued' });
      state.pending.set(entry.clientId, optimisticId);
      state.nodes.set(optimisticId, node);
      scrollToLatest(true);
    }

    saveOutboxEntry(entry);
    attemptSend(entry);
    return entry.clientId;
  }

  /** Replays this room's queue; safe to call on every connect, reconnect and `online`. */
  function flushOutbox() {
    var now = Date.now();
    readOutbox()
      .filter(function (entry) { return entry.room === state.room; })
      .forEach(function (entry) {
        if (entry.ts + OUTBOX_LIFETIME_MS <= now) {
          forgetOutboxEntry(entry.clientId);
          return;
        }
        deliver(entry);
      });
  }

  function clearOutboxTimers() {
    state.retries.forEach(function (timer) { clearTimeout(timer); });
    state.retries.clear();
  }

  /**
   * A self room is a machine-generated id; showing it raw makes the header
   * unreadable, so the personal chat gets a fixed label instead.
   */
  function paintRoomHeader(room) {
    var isSelf = room.indexOf('self-') === 0;
    el.roomTitle.textContent = isSelf ? 'Note to self' : room;
    el.roomAvatar.textContent = isSelf ? 'ME' : initials(room).toUpperCase();
    el.composerInput.placeholder = isSelf ? 'Message yourself' : 'Message #' + room;
  }

  /**
   * Room switching goes through the server so presence and history stay
   * authoritative; the client only changes its own view after the ack.
   */
  function switchRoom(room) {
    if (!state.session) return Promise.reject(new Error('join a room first'));
    if (room === state.room) return Promise.resolve({ room: room });
    return emitWithAck('room:join', { room: room }, 8000).then(function () {
      state.room = room;
      localStorage.setItem('chat:room', room);
      clearTray();
      paintRoomHeader(room);
      // The server has already sent `history` for the new room by now.
      flushOutbox();
      return { room: room };
    });
  }

  /* ---------------- transport ---------------- */

  function createSession(displayName) {
    return fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: displayName })
    }).then(function (response) {
      if (!response.ok) {
        return response.json().then(function (body) {
          throw new Error(body.error === 'rate_limited' ? 'Too many attempts, wait a minute.' : (body.error || 'Sign-in failed'));
        });
      }
      return response.json();
    });
  }

  /**
   * Reusing the cached session keeps a returning visitor's own history
   * attributed to them; a fresh id would render their old messages as someone
   * else's.
   */
  function resolveSession(displayName) {
    var cachedId = localStorage.getItem('chat:userId');
    if (!cachedId) return createSession(displayName);

    return fetch('/api/sessions/' + encodeURIComponent(cachedId))
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (session) {
        return session && session.displayName === displayName ? session : createSession(displayName);
      })
      .catch(function () { return createSession(displayName); });
  }

  function loadLimits() {
    return fetch('/api/events')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (info && info.media) state.limits = info.media;
      })
      .catch(function () { /* defaults are fine */ });
  }

  function loadHistory(room) {
    return fetch('/api/rooms/' + encodeURIComponent(room) + '/messages?limit=' + HISTORY_FETCH_LIMIT, {
      headers: { 'X-Session-Id': state.session.userId }
    }).then(function (r) { return r.ok ? r.json() : { messages: [] }; });
  }

  function resetStream() {
    el.messages.textContent = '';
    clearOutboxTimers();
    state.nodes.clear();
    state.cards.clear();
    state.pending.clear();
    state.seenQueue.clear();
    state.seenSent.clear();
    state.deliveredSent.clear();
    state.lastDayKey = null;
    state.lastAuthor = null;
    state.lastTs = 0;
    state.lastOwn = null;
  }

  function paintHistory(messages) {
    resetStream();
    messages.forEach(function (message) {
      renderMessage(message, { fresh: false });
    });
    scrollToLatest(true);
  }

  function connect() {
    var socket = io({
      auth: { userId: state.session.userId, room: state.room },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000
    });
    state.socket = socket;

    socket.on('connect', function () {
      setStatus('online', 'Connected');
      flushOutbox();
    });
    socket.on('disconnect', function (reason) {
      setStatus('offline', reason === 'io client disconnect' ? 'Left' : 'Reconnecting…');
      if (reason !== 'io client disconnect') {
        state.pending.forEach(function (optimisticId) {
          var node = state.nodes.get(optimisticId);
          if (node) setTicks(node, 'queued', 'Waiting for a connection');
        });
      }
    });
    socket.on('connect_error', function () { setStatus('connecting', 'Retrying connection…'); });

    socket.io.on('reconnect', function () {
      setStatus('online', 'Reconnected');
      loadHistory(state.room).then(function (data) {
        paintHistory(data.messages || []);
        flushOutbox();
      });
    });

    socket.on('system', function (payload) {
      if (payload.type === 'error') {
        appendActivity('⚠ ' + payload.message + (payload.reason ? ' — ' + payload.reason : ''), 'warn');
      }
    });

    socket.on('history', function (payload) {
      paintHistory(payload.messages || []);
      flushOutbox();
      emit('history', payload);
    });
    socket.on('presence', function (snapshot) {
      renderPresence(snapshot);
      emit('presence', snapshot);
    });

    socket.on('new_message', function (message) {
      if (message.room !== state.room) return;
      emit('new_message', message);

      var clientKey = message.clientId;
      var isMine = message.userId === state.session.userId;

      if (isMine && clientKey && state.pending.has(clientKey)) {
        // Echo of this tab's own send: promote the optimistic bubble in place.
        promoteNode(clientKey, message);
        return;
      }

      if (state.nodes.has(message.id)) return;

      renderMessage(message);
      if (isMine) return;

      reportDelivered(message.id);
      state.typingUsers.delete(message.userId);
      refreshTypingLabel();
      if (document.hidden || !state.nearBottom) bumpUnread();
      notifyIncoming(message);
      if (!document.hidden) {
        state.seenQueue.add(message.id);
        scheduleSeenFlush();
      }
    });

    socket.on('poll_voted', function (payload) {
      if (payload.room !== state.room) return;
      applyCardUpdate(payload);
      emit('poll_voted', payload);
    });

    socket.on('message_seen', function (receipt) {
      var node = state.nodes.get(receipt.messageId);
      if (!node || node.dataset.userId !== state.session.userId) return;
      applySeenState(node, [receipt.userId]);
      if (!document.hidden) playPing('seen');
    });

    socket.on('message_delivered', function (receipt) {
      var node = state.nodes.get(receipt.messageId);
      if (!node || node.dataset.userId !== state.session.userId) return;
      applyDeliveryState(node, [receipt.userId]);
    });

    socket.on('user_joined', function (payload) {
      if (payload.userId !== state.session.userId) appendActivity(payload.displayName + ' joined');
    });

    socket.on('user_left', function (payload) {
      if (payload.userId !== state.session.userId) {
        appendActivity(payload.displayName + ' left');
        state.typingUsers.delete(payload.userId);
        refreshTypingLabel();
      }
    });

    socket.on('typing', function (payload) {
      state.typingUsers.set(payload.userId, payload.displayName);
      refreshTypingLabel();
      renderPresenceLast();
    });

    socket.on('stop_typing', function (payload) {
      state.typingUsers.delete(payload.userId);
      refreshTypingLabel();
      renderPresenceLast();
    });

    // A reload with an unfinished queue still has to say so.
    announceQueue();
  }

  /* ---------------- presence ---------------- */

  var lastPresence = { users: [], onlineUsers: 0 };

  function renderPresence(snapshot) {
    lastPresence = snapshot;
    // Never paint the word: a missing count is a zero, not a debug message.
    el.onlineCount.textContent = String(snapshot.onlineUsers || 0);
    el.presenceList.textContent = '';

    snapshot.users.forEach(function (user) {
      var li = document.createElement('li');
      li.className = 'presence__item';
      if (state.typingUsers.has(user.userId)) li.classList.add('is-typing');
      li.dataset.userId = user.userId;

      var dot = document.createElement('span');
      dot.className = 'dot';

      var name = document.createElement('span');
      name.className = 'presence__name';
      name.textContent = user.displayName;

      li.append(dot, name);

      if (user.userId === state.session.userId) {
        var you = document.createElement('span');
        you.className = 'presence__you';
        you.textContent = '(you)';
        li.appendChild(you);
      }
      el.presenceList.appendChild(li);
    });
  }

  function renderPresenceLast() {
    renderPresence(lastPresence);
  }

  function refreshTypingLabel() {
    var names = Array.from(state.typingUsers.values()).filter(function (n) {
      return n !== state.session.displayName;
    });

    if (names.length === 0) {
      el.typing.hidden = true;
      return;
    }

    el.typingName.textContent = names.length === 1
      ? names[0]
      : names.length === 2 ? names.join(' and ') : names.length + ' people';
    el.typing.hidden = false;
  }

  /* ---------------- typing signals ---------------- */

  function emitTyping() {
    if (!state.socket || !state.socket.connected) return;
    var now = Date.now();
    if (!state.typingEmitTimer || now - state.typingEmitTimer > TYPING_EMIT_EVERY_MS) {
      state.socket.emit('typing');
      state.typingEmitTimer = now;
    }

    clearTimeout(state.typingStopTimer);
    state.typingStopTimer = setTimeout(function () {
      state.typingEmitTimer = null;
      state.socket.emit('stop_typing');
    }, TYPING_STOP_AFTER_MS);
  }

  function stopTyping() {
    clearTimeout(state.typingStopTimer);
    state.typingEmitTimer = null;
    if (state.socket && state.socket.connected) state.socket.emit('stop_typing');
  }

  /* ---------------- upload tray ---------------- */

  function clearTray() {
    state.uploads.forEach(function (item) { revokeThumb(item.objectUrl); });
    el.tray.textContent = '';
    el.tray.hidden = true;
    state.uploads.clear();
  }

  function trayItem(key, file) {
    var li = document.createElement('li');
    li.className = 'tray__item';
    li.dataset.state = 'queued';

    var thumb = document.createElement('div');
    thumb.className = 'tray__thumb';
    thumb.textContent = fileBadge(file.name);

    var isImage = /^image\//i.test(file.type);
    var isVideo = /^video\//i.test(file.type);
    var objectUrl = null;
    if (isImage || isVideo) {
      objectUrl = URL.createObjectURL(file);
      var media = document.createElement(isImage ? 'img' : 'video');
      if (!isImage) media.preload = 'metadata';
      media.src = objectUrl;
      thumb.textContent = '';
      thumb.appendChild(media);
    }

    var name = document.createElement('div');
    name.className = 'tray__name';
    name.textContent = file.name + ' · ' + formatBytes(file.size);

    var bar = document.createElement('div');
    bar.className = 'tray__bar';
    var fill = document.createElement('i');
    bar.appendChild(fill);

    var remove = document.createElement('button');
    remove.className = 'tray__remove';
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove attachment');
    remove.textContent = '×';
    remove.addEventListener('click', function () {
      revokeThumb(objectUrl);
      state.uploads.delete(key);
      li.remove();
      if (!state.uploads.size) clearTray();
    });

    li.append(remove, thumb, name, bar);
    state.uploads.set(key, { node: li, fill: fill, file: file, record: null, objectUrl: objectUrl });
    return li;
  }

  function revokeThumb(objectUrl) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }

  /**
   * The rich composer can shrink or re-encode picks before they are uploaded;
   * the promise shape keeps that hook out of the size and count rules below.
   */
  function pickFiles(fileList) {
    var files = Array.from(fileList || []);
    if (!files.length) return;
    var prepared = state.prepareFiles ? state.prepareFiles(files) : files;
    Promise.resolve(prepared).then(function (list) {
      acceptFiles(Array.from(list || []));
    }).catch(function (err) {
      appendActivity('⚠ ' + ((err && err.message) || 'could not prepare those files'), 'warn');
    });
  }

  function setFilePreparer(handler) {
    state.prepareFiles = typeof handler === 'function' ? handler : null;
  }

  function setAttachHandler(handler) {
    state.attachHandler = typeof handler === 'function' ? handler : null;
  }

  function acceptFiles(files) {
    if (!files.length) return;

    var rejected = [];
    var kept = [];
    files.forEach(function (file) {
      if (file.size > state.limits.maxBytes) {
        rejected.push(file.name + ' (max ' + formatBytes(state.limits.maxBytes) + ')');
        return;
      }
      if (file.size === 0) {
        rejected.push(file.name + ' (empty)');
        return;
      }
      kept.push(file);
    });

    if (kept.length > state.limits.maxPerMessage) {
      appendActivity('Only ' + state.limits.maxPerMessage + ' files per message; the rest were dropped', 'warn');
      kept = kept.slice(0, state.limits.maxPerMessage);
    }

    if (rejected.length) appendActivity('Not attached: ' + rejected.join(', '), 'warn');
    if (!kept.length) return;

    el.tray.hidden = false;
    var keys = kept.map(function (file) {
      var key = crypto.randomUUID();
      el.tray.appendChild(trayItem(key, file));
      return key;
    });

    uploadBatch(keys, kept);
  }

  /** One multipart request per pick, so progress maps onto every chip. */
  function postMultipart(files, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!state.session) {
        reject(new Error('join a room first'));
        return;
      }
      var form = new FormData();
      files.forEach(function (file) { form.append('files', file); });

      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media', true);
      xhr.setRequestHeader('X-Session-Id', state.session.userId);
      if (onProgress) xhr.upload.addEventListener('progress', onProgress);

      xhr.addEventListener('load', function () {
        var body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }
        if (xhr.status >= 200 && xhr.status < 300 && body.media) {
          resolve(body.media);
          return;
        }
        reject(new Error(body.error || 'upload failed (' + xhr.status + ')'));
      });
      xhr.addEventListener('error', function () { reject(new Error('upload failed — network')); });

      xhr.send(form);
    });
  }

  function uploadBatch(keys, files) {
    postMultipart(files, function (event) {
      if (!event.lengthComputable) return;
      var pct = Math.round((event.loaded / event.total) * 100);
      keys.forEach(function (key) {
        var item = state.uploads.get(key);
        if (item) { item.node.dataset.state = 'uploading'; item.fill.style.width = pct + '%'; }
      });
    }).then(function (media) {
      media.forEach(function (record, index) {
        var item = state.uploads.get(keys[index]);
        if (!item) return;
        item.record = record;
        item.node.dataset.state = 'done';
        item.fill.style.width = '100%';
      });
    }).catch(function (err) {
      keys.forEach(function (key) {
        var item = state.uploads.get(key);
        if (!item) return;
        item.node.dataset.state = 'error';
        item.fill.style.width = '0';
      });
      appendActivity('⚠ upload failed: ' + err.message, 'warn');
    });
  }

  function readyUploads() {
    var records = [];
    state.uploads.forEach(function (item) {
      if (item.record) records.push(item.record);
    });
    return records;
  }

  /* ---------------- composer ---------------- */

  function autoResize() {
    el.composerInput.style.height = 'auto';
    el.composerInput.style.height = Math.min(el.composerInput.scrollHeight, 210) + 'px';
  }

  function updateCharCount() {
    var length = el.composerInput.value.length;
    el.charCount.textContent = length + (length > MAX_MESSAGE_CHARS ? ' (over limit)' : '');
    el.hint.dataset.state = length > MAX_MESSAGE_CHARS ? 'over' : (length > MAX_MESSAGE_CHARS * 0.9 ? 'warn' : 'ok');
  }

  function send() {
    var text = el.composerInput.value.trim();
    var records = readyUploads();
    var pendingUploads = Array.from(state.uploads.values()).some(function (item) {
      return !item.record && item.node.dataset.state !== 'error';
    });

    if (!text && !records.length) return;
    if (pendingUploads) {
      appendActivity('⚠ still uploading, hold on', 'warn');
      return;
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      appendActivity('⚠ message is ' + (text.length - MAX_MESSAGE_CHARS) + ' characters over the limit', 'warn');
      return;
    }

    if (!deliver({ text: text, attachments: records })) return;

    el.composerInput.value = '';
    autoResize();
    updateCharCount();
    clearTray();
    stopTyping();
    scrollToLatest(true);
  }

  /**
   * Requests that change server state use an ack so the UI can show the truth
   * instead of assuming it. Offline callers get an immediate rejection.
   */
  function emitWithAck(event, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var socket = state.socket;
      if (!socket || !socket.connected) {
        reject(new Error('not connected'));
        return;
      }
      socket.timeout(timeoutMs || 6000).emit(event, payload, function (err, ack) {
        if (err) { reject(new Error(err.message || 'no answer from the server')); return; }
        if (!ack || !ack.ok) { reject(new Error((ack && ack.error) || 'rejected')); return; }
        resolve(ack);
      });
    });
  }

  /* ---------------- lightbox ---------------- */

  function openLightbox(kind, url, caption) {
    el.lightboxStage.textContent = '';
    var media = document.createElement(kind === 'video' ? 'video' : 'img');
    if (kind === 'video') { media.controls = true; media.autoplay = true; }
    media.src = url;
    el.lightboxStage.appendChild(media);
    el.lightboxCaption.textContent = caption || '';
    el.lightbox.hidden = false;
    el.lightboxClose.focus();
  }

  function closeLightbox() {
    el.lightbox.hidden = true;
    el.lightboxStage.textContent = '';
    if (state.session) el.composerInput.focus();
  }

  el.lightboxClose.addEventListener('click', closeLightbox);
  el.lightbox.addEventListener('click', function (event) {
    if (event.target === el.lightbox) closeLightbox();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !el.lightbox.hidden) closeLightbox();
  });

  /* ---------------- wiring ---------------- */

  el.joinForm.addEventListener('submit', function (event) {
    event.preventDefault();
    showError('');
    el.submitLabel.textContent = 'Joining…';

    var displayName = el.displayName.value.trim();
    var room = el.roomName.value.trim();

    resolveSession(displayName)
      .then(function (session) {
        state.session = session;
        state.room = room;
        localStorage.setItem('chat:displayName', displayName);
        localStorage.setItem('chat:userId', session.userId);
        localStorage.setItem('chat:room', room);

        paintRoomHeader(room);
        el.joinScreen.hidden = true;
        el.chatScreen.hidden = false;
        el.soundToggle.setAttribute('aria-pressed', String(state.soundOn));
        el.desktopToggle.setAttribute('aria-pressed', String(state.desktopOn));

        setupSeenObserver();
        loadLimits();
        connect();
        unlockAudio();
        el.composerInput.focus();
      })
      .catch(function (err) {
        showError(err.message);
      })
      .finally(function () {
        el.submitLabel.textContent = 'Join room';
      });
  });

  el.composer.addEventListener('submit', function (event) {
    event.preventDefault();
    send();
  });

  el.composerInput.addEventListener('input', function () {
    autoResize();
    updateCharCount();
    if (el.composerInput.value.trim()) emitTyping();
  });

  el.composerInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  el.composerInput.addEventListener('blur', stopTyping);

  el.composerInput.addEventListener('paste', function (event) {
    var files = Array.from((event.clipboardData && event.clipboardData.files) || []);
    if (files.length) {
      event.preventDefault();
      pickFiles(files);
    }
  });

  /* attachment picker + drag and drop */
  el.attachButton.addEventListener('click', function () {
    // The rich composer owns this button once it is loaded; the file picker is
    // the fallback when it is not.
    if (state.attachHandler) {
      state.attachHandler();
      return;
    }
    el.attachInput.click();
  });

  el.attachInput.addEventListener('change', function () {
    pickFiles(el.attachInput.files);
    el.attachInput.value = '';
  });

  var dragDepth = 0;
  el.chatScreen.addEventListener('dragenter', function (event) {
    if (!event.dataTransfer || Array.from(event.dataTransfer.types || []).indexOf('Files') === -1) return;
    dragDepth += 1;
    el.chatScreen.classList.add('is-dragging');
  });

  el.chatScreen.addEventListener('dragover', function (event) {
    if (el.chatScreen.classList.contains('is-dragging')) event.preventDefault();
  });

  el.chatScreen.addEventListener('dragleave', function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.chatScreen.classList.remove('is-dragging');
  });

  el.chatScreen.addEventListener('drop', function (event) {
    if (!event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return;
    event.preventDefault();
    dragDepth = 0;
    el.chatScreen.classList.remove('is-dragging');
    pickFiles(event.dataTransfer.files);
  });

  /* scroll + jump */
  el.stream.addEventListener('scroll', function () {
    state.nearBottom = atBottom();
    if (state.nearBottom) clearUnread();
  });

  el.jump.addEventListener('click', function () {
    scrollToLatest(true);
    clearUnread();
    el.composerInput.focus();
  });

  /* header controls */
  el.presenceToggle.addEventListener('click', function () {
    var open = el.presencePanel.hidden;
    el.presencePanel.hidden = !open;
    el.presenceToggle.setAttribute('aria-expanded', String(open));
  });

  el.soundToggle.addEventListener('click', function () {
    state.soundOn = !state.soundOn;
    el.soundToggle.setAttribute('aria-pressed', String(state.soundOn));
    localStorage.setItem('chat:sound', state.soundOn ? 'on' : 'off');
    if (state.soundOn) playPing('seen');
  });

  el.desktopToggle.addEventListener('click', function () {
    if (!('Notification' in window)) {
      appendActivity('This browser has no desktop notifications', 'warn');
      return;
    }
    Notification.requestPermission().then(function (permission) {
      state.desktopOn = permission === 'granted';
      el.desktopToggle.setAttribute('aria-pressed', String(state.desktopOn));
      localStorage.setItem('chat:desktop', state.desktopOn ? 'on' : 'off');
      appendActivity(state.desktopOn
        ? 'Desktop alerts on — you will be notified even in another tab'
        : 'Desktop alerts off (' + permission + ')', state.desktopOn ? 'info' : 'warn');
    });
  });

  el.themeToggle.addEventListener('click', function () {
    applyTheme(el.html.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  /* mark visible messages read again when the tab comes back */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    clearUnread();
    if (!state.session) return;
    Array.from(el.messages.children).forEach(function (node) {
      var id = node.dataset && node.dataset.messageId;
      if (!id || node.dataset.userId === state.session.userId) return;
      if (state.seenSent.has(id)) return;
      var box = node.getBoundingClientRect();
      var frame = el.stream.getBoundingClientRect();
      if (box.top < frame.bottom && box.bottom > frame.top) {
        state.seenQueue.add(id);
      }
    });
    scheduleSeenFlush();
  });

  el.leaveButton.addEventListener('click', function () {
    if (state.socket) state.socket.disconnect();
    state.socket = null;
    resetStream();
    clearTray();
    el.chatScreen.hidden = true;
    el.joinScreen.hidden = false;
    setStatus('connecting', 'Disconnected');
  });

  window.addEventListener('online', function () {
    if (state.session) flushOutbox();
  });

  window.addEventListener('beforeunload', function () {
    flushSeen();
    stopTyping();
  });

  /* ---------------- bridge for the rich composer (rich.js) ---------------- */

  window.GChat = {
    state: state,
    el: el,
    limits: function () { return state.limits; },
    session: function () { return state.session; },
    room: function () { return state.room; },
    api: apiRequest,
    deliver: deliver,
    sendCard: function (content, text) { return deliver({ text: text || '', content: content }); },
    votePoll: function (messageId, choices) { return emitWithAck('poll:vote', { messageId: messageId, choices: choices }); },
    emitWithAck: emitWithAck,
    registerCard: registerCard,
    on: on,
    queueCount: function () { return readOutbox().length; },
    flushOutbox: flushOutbox,
    switchRoom: switchRoom,
    pickFiles: pickFiles,
    setFilePreparer: setFilePreparer,
    setAttachHandler: setAttachHandler,
    uploadFiles: postMultipart,
    clearTray: clearTray,
    readyUploads: readyUploads,
    appendActivity: appendActivity,
    pushToast: pushToast,
    openLightbox: openLightbox,
    utils: {
      initials: initials,
      formatTime: formatTime,
      formatBytes: formatBytes,
      mediaUrl: mediaUrl,
      fileBadge: fileBadge
    }
  };

  /* boot */
  initTheme();
  el.soundToggle.setAttribute('aria-pressed', String(state.soundOn));
  el.displayName.value = localStorage.getItem('chat:displayName') || '';
  el.roomName.value = localStorage.getItem('chat:room') || 'general';
})();
