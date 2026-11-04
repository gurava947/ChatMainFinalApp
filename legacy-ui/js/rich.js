/* Rich composer: attach sheet, camera, voice notes, cards, library, self chat. */
(function () {
  'use strict';

  var G = window.GChat;
  if (!G) {
    console.warn('[gchat] rich composer disabled: the core script did not load');
    return;
  }

  var utils = G.utils;
  var el = G.el;

  var POLL_MIN_OPTIONS = 2;
  var POLL_MAX_OPTIONS = 12;
  var POLL_OPTION_CHARS = 100;
  var NOTE_CHARS = 500;
  var VOICE_MAX_MS = 15 * 60 * 1000;
  var VOICE_PEAK_BUCKETS = 48;
  var VOICE_SAMPLE_EVERY_MS = 120;
  var VOICE_MIN_MS = 400;

  var HD_KEY = 'chat:hd';
  /** Standard quality is the bandwidth choice: a long edge of 1024 px is enough to read. */
  var STANDARD_MAX_EDGE = 1024;
  var STANDARD_QUALITY = 0.82;

  var dom = {
    back: document.getElementById('back-button'),
    menuToggle: document.getElementById('menu-toggle'),
    menu: document.getElementById('app-menu'),
    queueItem: document.querySelector('#app-menu [data-action="queue"]'),
    queueItemCount: document.querySelector('#app-menu [data-role="queue-count"]'),
    hdItem: document.querySelector('#app-menu [data-action="hd"]'),
    hdState: document.querySelector('#app-menu [data-role="hd-state"]'),
    queueBanner: document.getElementById('queue-banner'),
    queueText: document.querySelector('#queue-banner [data-role="queue-text"]'),
    queueRetry: document.getElementById('queue-retry'),
    library: document.getElementById('library-panel'),
    libraryClose: document.getElementById('library-close'),
    libraryList: document.getElementById('library-list'),
    libraryEmpty: document.getElementById('library-empty'),
    sheet: document.getElementById('attach-sheet'),
    sheetGrid: document.getElementById('sheet-grid'),
    sheetClose: document.querySelector('#attach-sheet [data-role="sheet-close"]'),
    modal: document.getElementById('modal'),
    modalTitle: document.getElementById('modal-title'),
    modalBody: document.getElementById('modal-body'),
    modalFoot: document.getElementById('modal-foot'),
    modalClose: document.getElementById('modal-close'),
    camera: document.getElementById('camera'),
    cameraView: document.querySelector('#camera [data-role="camera-view"]'),
    cameraShutter: document.querySelector('#camera [data-role="camera-shutter"]'),
    cameraCancel: document.querySelector('#camera [data-role="camera-cancel"]'),
    cameraFlip: document.querySelector('#camera [data-role="camera-flip"]'),
    cameraButton: document.getElementById('camera-button'),
    voiceButton: document.getElementById('voice-button'),
    recorder: document.getElementById('recorder'),
    recTime: document.querySelector('#recorder [data-role="rec-time"]'),
    recMeter: document.querySelector('#recorder [data-role="rec-meter"]'),
    recCancel: document.getElementById('recorder-cancel'),
    recSend: document.getElementById('recorder-send')
  };

  /* ---------------- small builders ---------------- */

  function mk(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    var node = mk('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function templateForm(id) {
    var node = document.getElementById(id);
    return node ? node.content.firstElementChild.cloneNode(true) : null;
  }

  function say(message, kind) {
    G.appendActivity((kind === 'warn' ? '⚠ ' : '') + message, kind || 'info');
  }

  function fail(message) {
    say(message, 'warn');
  }

  function showFormError(node, message) {
    node.hidden = !message;
    node.textContent = message || '';
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  function stopStream(stream) {
    if (!stream) return;
    (stream.getTracks ? stream.getTracks() : []).forEach(function (track) {
      try { track.stop(); } catch { /* already ended */ }
    });
  }

  function formatDuration(ms) {
    var total = Math.max(0, Math.round(ms / 100) / 10);
    var minutes = Math.floor(total / 60);
    var seconds = Math.floor(total % 60);
    return minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function requireRoom() {
    if (G.session()) return true;
    fail('join a room first');
    return false;
  }

  /* ---------------- modal ---------------- */

  function openModal(title, body, actions) {
    dom.modalTitle.textContent = title;
    dom.modalBody.textContent = '';
    dom.modalBody.appendChild(body);
    dom.modalFoot.textContent = '';
    (actions || []).forEach(function (action) {
      dom.modalFoot.appendChild(
        button(action.label, 'btn ' + (action.primary ? 'btn--primary' : 'btn--ghost'), action.onClick)
      );
    });
    dom.modal.hidden = false;
    var first = body.querySelector('input, textarea, select, button');
    if (first) first.focus();
  }

  function closeModal() {
    if (dom.modal.hidden) return;
    dom.modal.hidden = true;
    dom.modalBody.textContent = '';
    dom.modalFoot.textContent = '';
  }

  dom.modalClose.addEventListener('click', closeModal);
  dom.modal.addEventListener('click', function (event) {
    if (event.target === dom.modal) closeModal();
  });

  /* ---------------- attach sheet ---------------- */

  var SHEET_ITEMS = [
    { id: 'camera', label: 'Camera', glyph: '📷', run: openCamera },
    { id: 'document', label: 'Document', glyph: '📄', run: function () { el.attachInput.click(); } },
    { id: 'poll', label: 'Poll', glyph: '📊', run: openPollDialog },
    { id: 'location', label: 'Location', glyph: '📍', run: openLocationDialog },
    { id: 'contact', label: 'Contact', glyph: '👤', run: openContactDialog },
    { id: 'event', label: 'Event', glyph: '📅', run: openEventDialog }
  ];

  /** Gallery and image picking are deliberately absent: the camera covers them. */
  function buildSheet() {
    dom.sheetGrid.textContent = '';
    SHEET_ITEMS.forEach(function (item) {
      var tile = button('', 'sheet__tile', function () {
        closeSheet();
        if (!requireRoom()) return;
        item.run();
      });
      tile.dataset.action = item.id;
      tile.appendChild(mk('span', 'sheet__glyph', item.glyph));
      tile.appendChild(mk('span', 'sheet__label', item.label));
      dom.sheetGrid.appendChild(tile);
    });
  }

  function openSheet() {
    if (!requireRoom()) return;
    dom.sheet.hidden = false;
  }

  function closeSheet() {
    dom.sheet.hidden = true;
  }

  dom.sheetClose.addEventListener('click', closeSheet);
  dom.sheet.addEventListener('click', function (event) {
    if (event.target === dom.sheet) closeSheet();
  });
  G.setAttachHandler(openSheet);

  /* ---------------- camera ---------------- */

  var cameraState = { stream: null, facing: 'environment' };

  function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail('this browser cannot open a camera');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: cameraState.facing }, audio: false })
      .then(function (stream) {
        cameraState.stream = stream;
        dom.cameraView.srcObject = stream;
        dom.camera.hidden = false;
        if (dom.cameraView.play) dom.cameraView.play().catch(function () { /* needs a tap */ });
      })
      .catch(function (err) {
        fail('camera unavailable: ' + (err && err.name ? permissionHint(err.name, 'camera') : err.message));
      });
  }

  function closeCamera() {
    stopStream(cameraState.stream);
    cameraState.stream = null;
    dom.cameraView.removeAttribute('src');
    dom.cameraView.srcObject = null;
    dom.camera.hidden = true;
  }

  function permissionHint(name, device) {
    if (name === 'NotAllowedError') return device + ' permission was declined';
    if (name === 'NotFoundError') return 'no ' + device + ' is available';
    if (name === 'NotReadableError') return device + ' is used by another app';
    return name;
  }

  function capturePhoto() {
    var video = dom.cameraView;
    if (!video.videoWidth) {
      fail('the camera is still starting up');
      return;
    }
    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(function (blob) {
      closeCamera();
      if (!blob) {
        fail('the photo could not be encoded');
        return;
      }
      G.pickFiles([new File([blob], 'camera-' + stamp() + '.jpg', { type: 'image/jpeg' })]);
    }, 'image/jpeg', 0.92);
  }

  function flipCamera() {
    cameraState.facing = cameraState.facing === 'user' ? 'environment' : 'user';
    closeCamera();
    openCamera();
  }

  dom.cameraButton.addEventListener('click', function () {
    if (!requireRoom()) return;
    openCamera();
  });
  dom.cameraShutter.addEventListener('click', capturePhoto);
  dom.cameraCancel.addEventListener('click', closeCamera);
  dom.cameraFlip.addEventListener('click', flipCamera);

  /* ---------------- HD media toggle ---------------- */

  function hdEnabled() {
    return localStorage.getItem(HD_KEY) === 'on';
  }

  function paintHdItem() {
    if (!dom.hdItem || !dom.hdState) return;
    dom.hdItem.setAttribute('aria-checked', String(hdEnabled()));
    dom.hdState.textContent = hdEnabled() ? 'on' : 'off';
  }

  function toggleHd() {
    localStorage.setItem(HD_KEY, hdEnabled() ? 'off' : 'on');
    paintHdItem();
    say('Media quality is now ' + (hdEnabled() ? 'HD — original files are sent' : 'standard — photos are resized'));
  }

  /**
   * Standard quality re-encodes still images. Video would need an encoder the
   * browser does not expose, so it keeps going out as captured.
   */
  function prepareFiles(files) {
    if (hdEnabled()) return files;
    return Promise.all(files.map(standardImage));
  }

  function standardImage(file) {
    if (!/^image\//i.test(file.type) || /svg/i.test(file.type)) return file;
    if (!window.createImageBitmap || !window.HTMLCanvasElement) return file;

    return window.createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, STANDARD_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      return encodeToJpeg(canvas, file);
    }).catch(function () { return file; });
  }

  function encodeToJpeg(canvas, file) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        if (!blob || !blob.size || blob.size >= file.size) {
          resolve(file);
          return;
        }
        resolve(new File([blob], file.name.replace(/\.[a-z0-9]{1,5}$/i, '') + '-standard.jpg', {
          type: blob.type,
          lastModified: file.lastModified || Date.now()
        }));
      }, 'image/jpeg', STANDARD_QUALITY);
    });
  }

  G.setFilePreparer(prepareFiles);

  /* ---------------- voice notes ---------------- */

  var record = {
    stream: null,
    recorder: null,
    chunks: [],
    samples: [],
    startedAt: 0,
    tick: null,
    meter: null,
    audioCtx: null,
    mime: '',
    discard: false
  };

  function pickVoiceMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (var i = 0; i < candidates.length; i += 1) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function voiceExtension(mime) {
    if (/mp4/i.test(mime)) return 'm4a';
    if (/ogg/i.test(mime)) return 'ogg';
    return 'webm';
  }

  function startRecording() {
    if (!window.MediaRecorder) {
      fail('this browser cannot record audio');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail('this browser cannot open a microphone');
      return;
    }
    if (record.recorder) return;

    navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (stream) {
      record.stream = stream;
      record.mime = pickVoiceMime();
      record.chunks = [];
      record.samples = [];
      record.discard = false;
      record.startedAt = Date.now();

      try {
        record.recorder = new MediaRecorder(stream, record.mime ? { mimeType: record.mime } : undefined);
      } catch (err) {
        stopStream(stream);
        record.recorder = null;
        record.stream = null;
        fail('recorder unavailable: ' + err.message);
        return;
      }

      record.recorder.addEventListener('dataavailable', function (event) {
        if (event.data && event.data.size) record.chunks.push(event.data);
      });
      record.recorder.addEventListener('stop', finishRecording);
      record.recorder.start();

      dom.recorder.hidden = false;
      dom.voiceButton.setAttribute('aria-pressed', 'true');
      updateRecTime();
      record.tick = setInterval(function () {
        updateRecTime();
        if (Date.now() - record.startedAt > VOICE_MAX_MS) stopRecording(false);
      }, 250);
      startMeter(stream);
    }).catch(function (err) {
      fail('microphone unavailable: ' + (err && err.name ? permissionHint(err.name, 'microphone') : err.message));
    });
  }

  function updateRecTime() {
    dom.recTime.textContent = formatDuration(Date.now() - record.startedAt);
  }

  function stopRecording(discard) {
    if (!record.recorder || record.recorder.state === 'inactive') return;
    record.discard = Boolean(discard);
    try { record.recorder.stop(); } catch { /* already stopping */ }
  }

  function startMeter(stream) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !dom.recMeter) return;
    try {
      record.audioCtx = new Ctx();
      var analyser = record.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      record.audioCtx.createMediaStreamSource(stream).connect(analyser);
      var buffer = new Uint8Array(analyser.fftSize);
      var paint = dom.recMeter.getContext('2d');
      var lastSample = 0;
      var since = function (now) { return now - lastSample; };

      (function frame(now) {
        if (!record.recorder || record.recorder.state === 'inactive') {
          record.meter = null;
          return;
        }
        record.meter = requestAnimationFrame(frame);
        analyser.getByteTimeDomainData(buffer);
        var peak = 0;
        for (var i = 0; i < buffer.length; i += 1) {
          peak = Math.max(peak, Math.abs(buffer[i] - 128) / 128);
        }
        if (since(now) >= VOICE_SAMPLE_EVERY_MS) {
          lastSample = now;
          record.samples.push(Math.min(1, peak));
        }
        paintWave(paint, record.samples);
      })(0);
    } catch {
      /* the meter is feedback only; recording still works without it */
    }
  }

  function paintWave(ctx, samples) {
    if (!ctx || !dom.recMeter) return;
    var width = dom.recMeter.width;
    var height = dom.recMeter.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'currentColor';
    var shown = samples.slice(-40);
    var step = width / 40;
    shown.forEach(function (sample, index) {
      var barHeight = Math.max(2, sample * height);
      ctx.fillRect(index * step, (height - barHeight) / 2, Math.max(1, step - 2), barHeight);
    });
  }

  function downsample(samples, buckets) {
    if (!samples.length) return [];
    var size = Math.ceil(samples.length / buckets);
    var out = [];
    for (var start = 0; start < samples.length; start += size) {
      var slice = samples.slice(start, start + size);
      out.push(Number(Math.max.apply(null, slice).toFixed(3)));
    }
    return out.slice(0, buckets);
  }

  function finishRecording() {
    clearInterval(record.tick);
    record.tick = null;
    if (record.meter) cancelAnimationFrame(record.meter);
    record.meter = null;
    dom.recorder.hidden = true;
    dom.voiceButton.setAttribute('aria-pressed', 'false');

    stopStream(record.stream);
    record.stream = null;
    if (record.audioCtx) {
      record.audioCtx.close().catch(function () { /* already closed */ });
      record.audioCtx = null;
    }

    var durationMs = Date.now() - record.startedAt;
    var chunks = record.chunks;
    var samples = record.samples;
    var discard = record.discard;
    record.chunks = [];
    record.samples = [];
    record.recorder = null;

    if (discard) {
      say('recording discarded');
      return;
    }
    if (durationMs < VOICE_MIN_MS) {
      fail('that was too short to send');
      return;
    }

    var blob = new Blob(chunks, { type: record.mime || 'audio/webm' });
    if (!blob.size) {
      fail('the recorder produced nothing');
      return;
    }

    var limits = G.limits();
    if (blob.size > limits.maxBytes) {
      fail('voice note is ' + utils.formatBytes(blob.size) + ', the limit is ' + utils.formatBytes(limits.maxBytes));
      return;
    }

    var file = new File([blob], 'voice-' + stamp() + '.' + voiceExtension(blob.type), { type: blob.type });
    G.uploadFiles([file]).then(function (records) {
      if (!records || !records.length) throw new Error('upload returned nothing');
      G.deliver({
        attachments: [records[0]],
        content: { type: 'voice', durationMs: Math.round(durationMs), peaks: downsample(samples, VOICE_PEAK_BUCKETS) }
      });
    }).catch(function (err) {
      fail('voice note not sent: ' + err.message);
    });
  }

  dom.voiceButton.addEventListener('click', function () {
    if (!requireRoom()) return;
    if (record.recorder) {
      stopRecording(false);
      return;
    }
    startRecording();
  });
  dom.recSend.addEventListener('click', function () { stopRecording(false); });
  dom.recCancel.addEventListener('click', function () { stopRecording(true); });

  /* ---------------- poll ---------------- */

  function openPollDialog() {
    var form = templateForm('poll-form');
    if (!form) return;
    var question = form.querySelector('[data-role="question"]');
    var list = form.querySelector('[data-role="options"]');
    var error = form.querySelector('[data-role="error"]');

    function addOption(value) {
      var row = mk('li', 'form__option');
      var input = mk('input', 'field__input');
      input.maxLength = POLL_OPTION_CHARS;
      input.placeholder = 'Option ' + (list.children.length + 1);
      input.value = value || '';
      var remove = button('×', 'form__remove', function () {
        if (list.children.length > POLL_MIN_OPTIONS) row.remove();
      });
      row.append(input, remove);
      list.appendChild(row);
      return input;
    }

    addOption();
    addOption();
    form.querySelector('[data-role="add-option"]').addEventListener('click', function () {
      if (list.children.length >= POLL_MAX_OPTIONS) {
        showFormError(error, 'A poll holds at most ' + POLL_MAX_OPTIONS + ' options.');
        return;
      }
      showFormError(error, '');
      addOption().focus();
    });

    function submit() {
      var title = question.value.trim();
      var options = Array.from(list.children)
        .map(function (row) { return row.querySelector('input').value.trim(); })
        .filter(Boolean);

      if (!title) {
        showFormError(error, 'Ask something first.');
        return;
      }
      if (options.length < POLL_MIN_OPTIONS) {
        showFormError(error, 'At least two options are needed.');
        return;
      }
      if (new Set(options.map(function (o) { return o.toLowerCase(); })).size !== options.length) {
        showFormError(error, 'Two options say the same thing.');
        return;
      }

      closeModal();
      G.sendCard({
        type: 'poll',
        question: title,
        options: options,
        multiple: form.querySelector('[data-role="multiple"]').checked
      });
    }

    openModal('New poll', form, [
      { label: 'Send poll', primary: true, onClick: submit },
      { label: 'Cancel', onClick: closeModal }
    ]);
  }

  G.registerCard('poll', {
    summary: function (content) { return 'Poll · ' + content.question; },
    render: function (slot, message) {
      var content = message.content;
      var card = mk('div', 'card card--poll');
      var list = mk('ul', 'poll__list');
      var foot = mk('p', 'poll__foot', 'No votes yet');
      // The id is the optimistic one until the server's echo promotes it.
      var messageId = message.id || '';
      var myUserId = G.session() ? G.session().userId : null;

      var rows = content.options.map(function (option, index) {
        var li = mk('li', 'poll__row');
        var bar = mk('i', 'poll__bar');
        var label = mk('span', 'poll__label', option);
        var count = mk('span', 'poll__count', '');
        var pick = button('', 'poll__pick', function () {
          if (/^pending-/.test(messageId)) {
            say('the poll is still on its way');
            return;
          }
          G.votePoll(messageId, [index]).catch(function (err) {
            fail('vote not recorded: ' + err.message);
          });
        });
        pick.setAttribute('aria-label', 'Vote for ' + option);
        li.append(pick, bar, label, count);
        list.appendChild(li);
        return { li: li, bar: bar, count: count };
      });

      card.append(
        mk('p', 'card__tag', content.multiple ? 'Poll · choose any that fit' : 'Poll · one choice'),
        mk('p', 'card__title', content.question),
        list,
        foot
      );
      slot.appendChild(card);

      function paint(results) {
        var total = results && results.totalVoters ? results.totalVoters : 0;
        rows.forEach(function (row, index) {
          var option = results && results.options ? results.options[index] : null;
          var votes = option ? option.count : 0;
          var share = total ? Math.round((votes / total) * 100) : 0;
          row.bar.style.width = share + '%';
          row.count.textContent = total ? votes + ' · ' + share + '%' : '';
          var chosen = Boolean(option && myUserId && option.voters && option.voters.indexOf(myUserId) !== -1);
          row.li.dataset.mine = chosen ? 'yes' : '';
        });
        if (total === 0) foot.textContent = 'No votes yet';
        else foot.textContent = total === 1 ? '1 vote' : total + ' votes';
      }

      return function update(source) {
        if (source && (source.id || source.messageId)) messageId = source.id || source.messageId;
        paint(source && source.results ? source.results : null);
      };
    }
  });

  /* ---------------- location ---------------- */

  function currentPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) {
        reject(new Error('this browser has no location service'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (position) { resolve(position.coords); },
        function (err) { reject(new Error(permissionHint(err.name, 'location'))); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  function openLocationDialog() {
    var form = templateForm('location-form');
    if (!form) return;
    var coords = form.querySelector('[data-role="coords"]');
    var error = form.querySelector('[data-role="error"]');
    var shared = { lat: null, lng: null, accuracyM: null };

    coords.textContent = 'Waiting for a position…';
    form.querySelector('[data-role="locate"]').addEventListener('click', function () {
      coords.textContent = 'Looking for you…';
      showFormError(error, '');
      currentPosition().then(function (result) {
        shared.lat = result.latitude;
        shared.lng = result.longitude;
        shared.accuracyM = result.accuracy || null;
        coords.textContent = shared.lat.toFixed(5) + ', ' + shared.lng.toFixed(5)
          + (shared.accuracyM ? ' · accurate to about ' + Math.round(shared.accuracyM) + ' m' : '');
      }).catch(function (err) {
        showFormError(error, err.message);
        coords.textContent = 'No position yet — you can add one by hand below.';
      });
    });

    function submit() {
      if (shared.lat === null) {
        showFormError(error, 'A location needs coordinates.');
        return;
      }
      var content = { type: 'location', lat: shared.lat, lng: shared.lng };
      if (shared.accuracyM !== null) content.accuracyM = shared.accuracyM;
      var label = form.querySelector('[data-role="label"]').value.trim();
      var address = form.querySelector('[data-role="address"]').value.trim();
      if (label) content.label = label;
      if (address) content.address = address;
      closeModal();
      G.sendCard(content);
    }

    openModal('Share a location', form, [
      { label: 'Send location', primary: true, onClick: submit },
      { label: 'Cancel', onClick: closeModal }
    ]);
  }

  function mapHref(content) {
    return 'https://www.openstreetmap.org/?mlat=' + content.lat + '&mlon=' + content.lng
      + '#map=16/' + content.lat + '/' + content.lng;
  }

  G.registerCard('location', {
    summary: function (content) { return 'Location · ' + (content.label || content.lat.toFixed(3) + ', ' + content.lng.toFixed(3)); },
    render: function (slot, message) {
      var content = message.content;
      var card = mk('div', 'card card--place');
      var actions = mk('div', 'card__actions');

      card.append(
        mk('p', 'card__tag', 'Location'),
        mk('p', 'card__title', content.label || 'Shared place')
      );
      if (content.address) card.append(mk('p', 'card__sub', content.address));
      card.append(mk('p', 'card__coords', content.lat.toFixed(5) + ', ' + content.lng.toFixed(5)
        + (content.accuracyM ? ' · ±' + Math.round(content.accuracyM) + ' m' : '')));

      var link = mk('a', 'card__link', 'Open in map');
      link.href = mapHref(content);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.appendChild(link);

      var copy = button('Copy', 'btn btn--ghost btn--small', function () {
        if (!navigator.clipboard) {
          say('this browser cannot copy');
          return;
        }
        navigator.clipboard.writeText(content.lat.toFixed(5) + ',' + content.lng.toFixed(5))
          .then(function () { say('coordinates copied'); })
          .catch(function () { fail('copy was blocked'); });
      });
      actions.appendChild(copy);
      card.append(actions);
      slot.appendChild(card);
    }
  });

  /* ---------------- contact ---------------- */

  function openContactDialog() {
    var form = templateForm('contact-form');
    if (!form) return;
    var error = form.querySelector('[data-role="error"]');

    function submit() {
      var content = { type: 'contact', name: form.querySelector('[data-role="name"]').value.trim() };
      if (!content.name) {
        showFormError(error, 'Who is this?');
        return;
      }
      var phone = form.querySelector('[data-role="phone"]').value.trim();
      var email = form.querySelector('[data-role="email"]').value.trim();
      var org = form.querySelector('[data-role="org"]').value.trim();
      var note = form.querySelector('[data-role="note"]').value.trim();
      if (!phone && !email) {
        showFormError(error, 'Add a phone number or an email address.');
        return;
      }
      if (phone) content.phone = phone;
      if (email) content.email = email;
      if (org) content.org = org;
      if (note) content.note = note;
      closeModal();
      G.sendCard(content);
    }

    openModal('Share a contact', form, [
      { label: 'Send contact', primary: true, onClick: submit },
      { label: 'Cancel', onClick: closeModal }
    ]);
  }

  G.registerCard('contact', {
    summary: function (content) { return 'Contact · ' + content.name; },
    render: function (slot, message) {
      var content = message.content;
      var card = mk('div', 'card card--contact');
      var actions = mk('div', 'card__actions');

      card.append(
        mk('p', 'card__tag', 'Contact'),
        mk('p', 'card__title', content.name)
      );
      if (content.org) card.append(mk('p', 'card__sub', content.org));
      if (content.note) card.append(mk('p', 'card__body', content.note));

      if (content.phone) {
        var dial = mk('a', 'card__link', content.phone);
        dial.href = 'tel:' + content.phone.replace(/[^+0-9]/g, '');
        actions.appendChild(dial);
      }
      if (content.email) {
        var mail = mk('a', 'card__link', content.email);
        mail.href = 'mailto:' + content.email;
        actions.appendChild(mail);
      }
      card.append(actions);
      slot.appendChild(card);
    }
  });

  /* ---------------- event ---------------- */

  function openEventDialog() {
    var form = templateForm('event-form');
    if (!form) return;
    var error = form.querySelector('[data-role="error"]');
    var start = form.querySelector('[data-role="start"]');
    var end = form.querySelector('[data-role="end"]');
    var allDay = form.querySelector('[data-role="all-day"]');

    // Default to the next round hour so a quick share needs no typing.
    var soon = new Date(Date.now() + 3600000);
    soon.setMinutes(0, 0, 0);
    start.value = toLocalInput(soon);
    end.value = toLocalInput(new Date(soon.getTime() + 3600000));

    function submit() {
      var title = form.querySelector('[data-role="title"]').value.trim();
      if (!title) {
        showFormError(error, 'Give the event a title.');
        return;
      }
      var from = new Date(start.value);
      if (isNaN(from.getTime())) {
        showFormError(error, 'The start time is not readable.');
        return;
      }
      var to = end.value ? new Date(end.value) : null;
      if (to && isNaN(to.getTime())) {
        showFormError(error, 'The end time is not readable.');
        return;
      }
      if (to && to.getTime() <= from.getTime()) {
        showFormError(error, 'The event has to end after it starts.');
        return;
      }

      var content = {
        type: 'event',
        title: title,
        start: from.getTime(),
        allDay: allDay.checked
      };
      if (to) content.end = to.getTime();
      var place = form.querySelector('[data-role="location"]').value.trim();
      var note = form.querySelector('[data-role="note"]').value.trim();
      if (place) content.location = place;
      if (note) content.note = note;
      closeModal();
      G.sendCard(content);
    }

    openModal('Share an event', form, [
      { label: 'Send event', primary: true, onClick: submit },
      { label: 'Cancel', onClick: closeModal }
    ]);
  }

  function toLocalInput(date) {
    var pad = function (value) { return (value < 10 ? '0' : '') + value; };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dayLabel(millis) {
    var date = new Date(millis);
    return MONTHS[date.getMonth()] + ' ' + date.getDate();
  }

  function whenLabel(event) {
    var start = new Date(event.start);
    var tail = event.allDay
      ? dayLabel(event.start)
      : dayLabel(event.start) + ' · ' + utils.formatTime(event.start);
    if (!event.end) return tail;
    if (dayLabel(event.start) === dayLabel(event.end)) {
      return tail + ' – ' + utils.formatTime(event.end);
    }
    return tail + ' – ' + dayLabel(event.end) + ' · ' + utils.formatTime(event.end);
  }

  /** iCalendar needs UTC basic-format stamps; all-day events carry dates only. */
  function icsStamp(millis, allDay) {
    var date = new Date(millis);
    var pad = function (value) { return (value < 10 ? '0' : '') + value; };
    if (allDay) return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
    return date.getUTCFullYear() + pad(date.getUTCMonth() + 1) + pad(date.getUTCDate())
      + 'T' + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z';
  }

  function icsText(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  function buildIcs(event, uid) {
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//GChat//Group chat events//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:' + uid + '@gchat',
      'DTSTAMP:' + icsStamp(Date.now()),
      'DTSTART' + (event.allDay ? ';VALUE=DATE' : '') + ':' + icsStamp(event.start, event.allDay)
    ];
    if (event.end) lines.push('DTEND' + (event.allDay ? ';VALUE=DATE' : '') + ':' + icsStamp(event.end, event.allDay));
    lines.push('SUMMARY:' + icsText(event.title));
    if (event.location) lines.push('LOCATION:' + icsText(event.location));
    if (event.note) lines.push('DESCRIPTION:' + icsText(event.note));
    lines.push('END:VEVENT', 'END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  G.registerCard('event', {
    summary: function (content) { return 'Event · ' + content.title; },
    render: function (slot, message) {
      var content = message.content;
      var card = mk('div', 'card card--event');
      card.append(mk('p', 'card__tag', content.allDay ? 'Event · all day' : 'Event'),
        mk('p', 'card__title', content.title),
        mk('p', 'card__when', whenLabel(content)));
      if (content.location) card.append(mk('p', 'card__sub', content.location));
      if (content.note) card.append(mk('p', 'card__body', content.note));

      var actions = mk('div', 'card__actions');
      var save = button('Add to calendar', 'btn btn--ghost btn--small', function () {
        var blob = new Blob([buildIcs(content, message.id)], { type: 'text/calendar' });
        var url = URL.createObjectURL(blob);
        var link = mk('a');
        link.href = url;
        link.download = (content.title || 'event').slice(0, 40).replace(/[^\w -]/g, '') + '.ics';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      });
      actions.appendChild(save);
      card.append(actions);
      slot.appendChild(card);
    }
  });

  /* ---------------- voice card ---------------- */

  /** Only one recording plays at a time, across the whole room. */
  var activeVoice = null;

  G.registerCard('voice', {
    summary: function (content) { return 'Voice message · ' + formatDuration(content.durationMs); },
    render: function (slot, message) {
      var content = message.content;
      var audio = (message.attachments || []).filter(function (item) { return item.kind === 'audio'; })[0];
      var url = audio ? utils.mediaUrl(audio) : null;

      var card = mk('div', 'card card--voice');
      var wave = mk('div', 'voice__wave');
      var time = mk('span', 'voice__time', formatDuration(content.durationMs));

      var bars = (content.peaks && content.peaks.length ? content.peaks : [0.35, 0.6, 0.4, 0.8, 0.5, 0.3])
        .slice(0, VOICE_PEAK_BUCKETS)
        .map(function (peak) {
          var bar = mk('i');
          bar.style.height = Math.max(8, Math.round(Math.min(1, peak) * 100)) + '%';
          wave.appendChild(bar);
          return bar;
        });

      card.append(mk('p', 'card__tag', 'Voice message'));

      if (!url) {
        card.append(mk('p', 'card__missing', 'this recording has expired'), wave, time);
        slot.appendChild(card);
        return;
      }

      var player = new Audio(url);
      player.preload = 'metadata';
      var play = button('▶', 'voice__play');
      play.setAttribute('aria-label', 'Play voice message');

      var progress = mk('i', 'voice__progress');
      progress.style.width = '0';

      var head = mk('div', 'voice__head');
      head.append(play, time, progress);
      card.append(head, wave);
      slot.appendChild(card);

      player.addEventListener('timeupdate', function () {
        var ratio = player.duration ? player.currentTime / player.duration : 0;
        progress.style.width = Math.round(ratio * 100) + '%';
        var upto = Math.round(ratio * bars.length);
        bars.forEach(function (bar, index) {
          bar.dataset.played = index < upto ? 'yes' : '';
        });
      });
      player.addEventListener('ended', function () {
        play.textContent = '▶';
        progress.style.width = '0';
        bars.forEach(function (bar) { bar.dataset.played = ''; });
      });
      player.addEventListener('error', function () {
        play.disabled = true;
        say('this recording could not be played');
      });

      play.addEventListener('click', function () {
        if (!player.paused) {
          player.pause();
          play.textContent = '▶';
          return;
        }
        if (activeVoice && activeVoice !== player) activeVoice.pause();
        activeVoice = player;
        player.play().then(function () {
          play.textContent = '❚❚';
        }).catch(function () {
          fail('the browser blocked playback — tap again');
        });
      });
    }
  });

  /* ---------------- media library ---------------- */

  var library = { items: [], tab: 'recents', timer: null };

  function openLibrary() {
    if (!requireRoom()) return;
    dom.library.hidden = false;
    refreshLibrary();
  }

  function closeLibrary() {
    dom.library.hidden = true;
  }

  function refreshLibrary() {
    if (dom.library.hidden) return;
    clearTimeout(library.timer);
    library.timer = setTimeout(function () {
      G.api('/api/rooms/' + encodeURIComponent(G.room()) + '/media').then(function (data) {
        library.items = data.items || [];
        paintLibrary();
      }).catch(function (err) {
        fail('library: ' + err.message);
      });
    }, 400);
  }

  function thumbFor(item) {
    var url = utils.mediaUrl(item);
    if (!url) return mk('span', 'library__badge', utils.fileBadge(item.name));
    if (item.kind === 'image') {
      var img = document.createElement('img');
      img.src = url;
      img.alt = item.name || 'image';
      img.loading = 'lazy';
      return img;
    }
    if (item.kind === 'video') {
      var video = document.createElement('video');
      video.src = url;
      video.preload = 'metadata';
      video.muted = true;
      return video;
    }
    return mk('span', 'library__badge', item.kind === 'audio' ? '♪' : utils.fileBadge(item.name));
  }

  function libraryRow(item, onClick) {
    var li = mk('li', 'library__item');
    var frame = mk('span', 'library__frame');
    frame.appendChild(thumbFor(item));
    var meta = mk('span', 'library__meta');
    meta.append(mk('b', null, item.name || item.kind),
      mk('span', null, item.sender + ' · ' + utils.formatBytes(item.size)));
    li.append(frame, meta);
    li.addEventListener('click', onClick);
    return li;
  }

  function paintLibrary() {
    dom.libraryList.textContent = '';
    var items = library.items.slice();
    if (!items.length) {
      dom.libraryEmpty.hidden = false;
      return;
    }
    dom.libraryEmpty.hidden = true;

    if (library.tab === 'media') {
      items.filter(function (item) { return item.kind === 'image' || item.kind === 'video'; })
        .forEach(function (item) {
          dom.libraryList.appendChild(libraryRow(item, function () { reveal(item); }));
        });
      return;
    }

    if (library.tab === 'folders') {
      var bySender = new Map();
      items.forEach(function (item) {
        var list = bySender.get(item.sender) || [];
        list.push(item);
        bySender.set(item.sender, list);
      });
      bySender.forEach(function (list, sender) {
        var group = mk('li', 'library__group');
        group.append(mk('p', 'library__group-title', sender + ' · ' + list.length + ' item' + (list.length > 1 ? 's' : '')));
        list.slice(0, 6).forEach(function (item) {
          group.appendChild(libraryRow(item, function () { reveal(item); }));
        });
        dom.libraryList.appendChild(group);
      });
      return;
    }

    items.slice(0, 20).forEach(function (item) {
      dom.libraryList.appendChild(libraryRow(item, function () { reveal(item); }));
    });
  }

  function reveal(item) {
    var url = utils.mediaUrl(item);
    if (!url) {
      fail('that file has expired');
      return;
    }
    if (item.kind === 'image' || item.kind === 'video') {
      G.openLightbox(item.kind, url, item.name + ' · ' + item.sender);
      return;
    }
    var link = mk('a');
    link.href = url;
    link.download = item.name || 'file';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  Array.prototype.slice.call(document.querySelectorAll('.library__tab')).forEach(function (tab) {
    tab.addEventListener('click', function () {
      library.tab = tab.dataset.tab;
      Array.prototype.slice.call(document.querySelectorAll('.library__tab')).forEach(function (other) {
        other.setAttribute('aria-selected', String(other === tab));
      });
      paintLibrary();
    });
  });

  dom.libraryClose.addEventListener('click', closeLibrary);
  G.on('new_message', refreshLibrary);

  /* ---------------- personal note + self chat ---------------- */

  var roomTrail = [];

  function openSelfChat() {
    var from = G.room();
    if (from && /^self-/.test(from)) {
      say('you are already in your own chat');
      return;
    }
    G.api('/api/me/self')
      .then(function (info) {
        return G.switchRoom(info.room).then(function () {
          roomTrail.push(from);
          say('This room is only yours. Notes, links and files stay between you and you.');
        });
      })
      .catch(function (err) {
        fail('could not open your chat: ' + err.message);
      });
  }

  function goBack() {
    if (!dom.library.hidden) {
      closeLibrary();
      return;
    }
    if (!dom.menu.hidden) {
      dom.menu.hidden = true;
      return;
    }
    if (roomTrail.length) {
      var previous = roomTrail.pop();
      G.switchRoom(previous).catch(function (err) { fail('could not go back: ' + err.message); });
      return;
    }
    el.leaveButton.click();
  }

  function openNoteDialog() {
    var form = templateForm('note-form');
    if (!form) return;
    var text = form.querySelector('[data-role="note-text"]');
    var meta = form.querySelector('[data-role="note-meta"]');
    var error = form.querySelector('[data-role="error"]');

    text.maxLength = NOTE_CHARS;
    meta.textContent = 'Loading…';
    G.api('/api/me/note').then(function (data) {
      text.value = (data.note && data.note.text) || '';
      meta.textContent = data.note && data.note.updatedAt
        ? 'Last saved ' + utils.formatTime(data.note.updatedAt)
        : 'Nothing saved yet.';
    }).catch(function (err) {
      meta.textContent = 'Could not load it: ' + err.message;
    });

    function save() {
      G.api('/api/me/note', { method: 'PUT', body: { text: text.value.trim() } }).then(function (data) {
        closeModal();
        say('Personal note saved');
        if (data && data.note && data.note.updatedAt) {
          localStorage.setItem('chat:note:updatedAt', String(data.note.updatedAt));
        }
      }).catch(function (err) {
        showFormError(error, err.message);
      });
    }

    openModal('Personal note', form, [
      { label: 'Save', primary: true, onClick: save },
      { label: 'Cancel', onClick: closeModal }
    ]);
  }

  /* ---------------- menu, back, queue ---------------- */

  var MENU_ACTIONS = {
    self: openSelfChat,
    note: openNoteDialog,
    library: openLibrary,
    hd: toggleHd
  };

  dom.menuToggle.addEventListener('click', function () {
    dom.menu.hidden = !dom.menu.hidden;
    dom.menuToggle.setAttribute('aria-expanded', String(!dom.menu.hidden));
  });

  dom.menu.addEventListener('click', function (event) {
    var item = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!item) return;
    var action = MENU_ACTIONS[item.dataset.action];
    if (!action) return;
    if (item.dataset.action !== 'hd') {
      dom.menu.hidden = true;
      dom.menuToggle.setAttribute('aria-expanded', 'false');
    }
    action();
  });

  document.addEventListener('click', function (event) {
    if (dom.menu.hidden) return;
    if (dom.menu.contains(event.target) || dom.menuToggle.contains(event.target)) return;
    dom.menu.hidden = true;
    dom.menuToggle.setAttribute('aria-expanded', 'false');
  });

  dom.back.addEventListener('click', goBack);

  function paintQueue(count) {
    dom.queueBanner.hidden = count === 0;
    dom.queueText.textContent = count === 1
      ? '1 message waiting for a connection'
      : count + ' messages waiting for a connection';
    if (dom.queueItem) dom.queueItem.hidden = count === 0;
    if (dom.queueItemCount) dom.queueItemCount.textContent = String(count);
  }

  G.on('outbox', function (payload) { paintQueue(payload.count); });

  dom.queueRetry.addEventListener('click', function () {
    G.flushOutbox();
    paintQueue(G.queueCount());
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    closeSheet();
    closeModal();
    if (!dom.camera.hidden) closeCamera();
  });

  /* ---------------- boot ---------------- */

  buildSheet();
  paintHdItem();
  paintQueue(G.queueCount());
  G.on('history', function () {
    if (activeVoice) {
      activeVoice.pause();
      activeVoice = null;
    }
    refreshLibrary();
  });

  // Exposed so the behaviour can be unit tested without a browser.
  window.GChatRich = {
    buildIcs: buildIcs,
    icsText: icsText,
    downsample: downsample,
    standardImage: standardImage,
    sheetItems: function () { return SHEET_ITEMS.map(function (item) { return item.id; }); },
    whenLabel: whenLabel
  };
})();
