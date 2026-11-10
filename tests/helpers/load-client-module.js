'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CLIENT_DIR = path.join(__dirname, '..', '..', 'client', 'src');

/**
 * The names the React room module offers to the app. The list is explicit so a
 * new export has to be reviewed here before a test can reach it.
 */
const ROOM_CHAT_EXPORTS = [
  'readGuest', 'readRooms', 'saveGuest', 'saveRooms', 'clearGuest', 'forgetRoom',
  'saveNote', 'normalizeRoomName', 'roomSummary', 'resolveGuest',
  'connectRoom', 'connectFeed', 'sessionHeaders', 'CHAT_THEMES', 'fetchChatSettings', 'blockGuest', 'unblockGuest',
  'saveRoomTheme', 'clearChatForMe', 'deleteMessagesForMe', 'deleteChatForMe', 'fetchRoomMessages',
  'fetchMyProfile', 'uploadAvatar', 'removeAvatar', 'fetchProfiles',
  'fetchCallHistory', 'clearCallHistory', 'fetchStatuses', 'postTextStatus', 'postMediaStatus',
  'deleteStatus', 'markStatusSeen', 'fetchStatusViewers', 'uploadStatusMedia',
];

/** Pure builders behind the poll / contact / event cards. */
const RICH_CARD_EXPORTS = [
  'buildPollContent', 'buildContactContent', 'buildEventContent',
  'icsForEvent', 'pollOutcome', 'contactLinks',
];

/** Keyboard arithmetic behind the focus trap and the menu roving focus. */
const A11Y_EXPORTS = [
  'FOCUSABLE_SELECTOR', 'isUsable', 'trapTarget', 'preferredFocus', 'menuTarget',
];

/** Device-side image shrinking behind the upload path. */
const MEDIA_PREPARE_EXPORTS = [
  'readHdPreference', 'saveHdPreference', 'planImageFor', 'scaledSize',
  'prepareFile', 'prepareFiles',
];

/** Geometry behind the floating / minimised / fullscreen call window. */
const CALL_WINDOW_EXPORTS = [
  'WINDOW_MODES', 'readWindowMode', 'saveWindowMode', 'readWindowFrame', 'saveWindowFrame',
  'defaultFrame', 'clampToViewport', 'movedFrame', 'resizedFrame', 'frameStyle',
  'callDuration', 'pointerPoint', 'dragDelta', 'viewportSize',
];

/** Device-side rules for desktop notifications. */
const NOTIFICATION_EXPORTS = [
  'readNotifyPrefs', 'saveNotifyPrefs', 'canNotify', 'requestNotifyPermission',
  'unreadFor', 'shouldNotify', 'notificationTitle', 'notificationBody',
  'openNotification', 'playChime',
];

/** Reading the call log (P7): wording, durations and the day grouping. */
const CALL_HISTORY_EXPORTS = [
  'callMoment', 'callDurationLabel', 'describeCall', 'groupCallsByDay', 'canCallBack',
];

/** Boot-time ICE config: freshness, background refresh and request dedupe. */
const ICE_CACHE_EXPORTS = [
  'ICE_FALLBACK', 'ICE_REFRESH_AFTER_MS', 'ICE_USABLE_FOR_MS',
  'readIceServers', 'primeIceConfig', 'resetIceCache',
];

/** Live-call recovery: grace, restart ladder and status after signaling returns. */
const CALL_RECOVERY_EXPORTS = [
  'RECONNECT_GRACE_MS', 'RECOVERY_WINDOW_MS', 'MAX_RECOVERY_ATTEMPTS',
  'recoveryAction', 'recoveryGrace', 'restoredCallStatus',
];

/** Resumable file transfers: chunk math, the ack bitmap and record lifecycle. */
const TRANSFER_EXPORTS = [
  'TRANSFER_CHUNK_BYTES', 'TRANSFER_MAX_BYTES',
  'chunkCountFor', 'chunkRange', 'createBitmap', 'markChunk', 'hasChunk',
  'receivedCount', 'firstMissingChunk', 'isComplete', 'transferProgress',
  'createTransferRecord', 'ackChunk', 'canResume', 'failTransfer',
];

/** The data-channel fast path: framing, watermarks and the resume handshake. */
const FILE_TRANSFER_EXPORTS = [
  'FILE_CHANNEL_LABEL', 'FILE_CHUNK_WINDOW', 'FILE_ACK_EVERY', 'FILE_HIGH_WATER', 'FILE_LOW_WATER',
  'FILE_CHANNEL_TIMEOUT_MS', 'FILE_HEADER_BYTES', 'FILE_RESUME_TIMEOUT_MS',
  'directFileKey', 'encodeChunkFrame', 'decodeChunkFrame', 'controlFrame', 'parseControlFrame',
  'bitmapToArray', 'bitmapFromArray', 'waitForDrain', 'createFileTransferController',
];

/** The 24-hour status feed (P8): palette, countdown, ordering and viewer copy. */
const STATUS_FEED_EXPORTS = [
  'STATUS_PALETTE', 'STATUS_TEXT_MAX', 'timeLeftLabel', 'isLive', 'hasUnseen', 'pickColor',
  'groupFeed', 'cardSummary', 'viewersLabel', 'canReadViewers', 'mediaKind', 'playOrder', 'nextInPlay',
];

/** The shorts feed: real room history turned into playable clips. */
const SHORTS_FEED_EXPORTS = [
  'SHORTS_LIMIT', 'clipUrl', 'collectVideoClips',
];

/** The composer's emoji list and the caret arithmetic behind picking one. */
const EMOJI_EXPORTS = [
  'EMOJI_GROUPS', 'insertAtCaret',
];

/** Appearance choices applied to <html> before the first paint. */
const PREFERENCE_EXPORTS = [
  'ACCENTS', 'readAccent', 'saveAccent', 'applyAccent',
  'readMotion', 'saveMotion', 'applyMotion', 'applyPreferences',
];

/** The IndexedDB layer. Its surface is long on purpose - every read and write the
 * app performs goes through one of these names, so a test can assert on the same
 * functions the browser runs instead of on a component tree.
 */
const LOCAL_STORE_EXPORTS = [
  'DB_NAME', 'DB_VERSION', 'MIN_SEQ', 'MAX_SEQ', 'PINNED_PER_ROOM',
  'DEFAULT_MEDIA_TTL_MS', 'DEFAULT_MESSAGE_TTL_MS', 'DEFAULT_TRANSFER_TTL_MS',
  'STORE_MESSAGES', 'STORE_ROOMS', 'STORE_PROFILES', 'STORE_CALLS', 'STORE_OUTBOX', 'STORE_MEDIA', 'STORE_TRANSFERS', 'STORE_META',
  'supportsLocalStore', 'storageAvailable', 'localStoreError', 'openLocalStore', 'closeLocalStore', 'wipeLocalStore',
  'isQuotaError', 'storableRows', 'messageRecord', 'mergeRecord',
  'storeMessages', 'readMessagePage', 'readOlderMessages', 'readNewerMessages',
  'findMessageByClientId', 'deleteMessages', 'deleteRoomMessages',
  'readRoomState', 'saveRoomState', 'listRoomStates', 'forgetRoomState', 'seqSpan',
  'storeProfiles', 'readProfile', 'readProfiles',
  'storeCalls', 'readCalls', 'clearCalls',
  'queueOutbox', 'readOutbox', 'bumpOutboxTries', 'resolveOutbox', 'clearOutbox',
  'storeMedia', 'readMedia', 'listMedia', 'deleteMedia', 'deleteRoomMedia',
  'saveTransfer', 'readTransfer', 'listTransfers', 'deleteTransfer',
  'readMeta', 'writeMeta',
  'readUsage', 'requestPersistence', 'enforceRetention',
];

/**
 * The transcript rules the room component folds its rows through. They live in
 * their own module so the reconciliation a guest sees after a reconnect - what
 * order, what survives, what gets written to IndexedDB - is asserted against the
 * shipped source rather than against a copy of it.
 */
const TRANSCRIPT_EXPORTS = [
  'byArrival', 'mergeMessage', 'mergePage', 'mergeServerPage', 'olderCursor',
  'rowsToPersist', 'attachmentRows', 'transcriptPhase', 'localReadFailure', 'SKELETON_ROWS',
];

/**
 * The React client ships ESM while Jest runs CommonJS, so the shipped source is
 * evaluated here with its lone external dependency stubbed. Nothing is
 * re-implemented: the assertions run against the same file the browser loads,
 * and only the allowlisted names above are handed back.
 */
function loadClientModule(fileName, exportNames) {
  const names = new Set(exportNames);
  const source = fs.readFileSync(path.join(CLIENT_DIR, fileName), 'utf8')
    .replace(/^import\s+\{\s*io\s*\}\s*from\s+'socket.io-client'$/m, 'const io = () => { throw new Error("sockets are out of scope") }')
    .replace(/^export /gm, '');
  const found = [
    ...[...source.matchAll(/^(?:async )?function (\w+)/gm)].map((match) => match[1]),
    ...[...source.matchAll(/^const ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]),
  ].filter((name) => names.has(name));
  if (found.length !== names.size) {
    const missing = exportNames.filter((name) => !found.includes(name));
    throw new Error(`${fileName} no longer exports ${missing.join(', ')} — update the allowlist`);
  }
  const factory = new Function(`\n${source}\nreturn { ${found.join(', ')} };`);
  return factory();
}

function loadRoomChat() {
  return loadClientModule('roomChat.js', ROOM_CHAT_EXPORTS);
}

function loadRichCards() {
  return loadClientModule('richCards.js', RICH_CARD_EXPORTS);
}

function loadA11y() {
  return loadClientModule('a11y.js', A11Y_EXPORTS);
}

function loadMediaPrepare() {
  return loadClientModule('mediaPrepare.js', MEDIA_PREPARE_EXPORTS);
}

function loadCallWindow() {
  return loadClientModule('callWindow.js', CALL_WINDOW_EXPORTS);
}

function loadNotifications() {
  return loadClientModule('notifications.js', NOTIFICATION_EXPORTS);
}

function loadCallHistory() {
  return loadClientModule('callHistory.js', CALL_HISTORY_EXPORTS);
}

function loadIceCache() {
  return loadClientModule('iceCache.js', ICE_CACHE_EXPORTS);
}

function loadCallRecovery() {
  return loadClientModule('callRecovery.js', CALL_RECOVERY_EXPORTS);
}

function loadTransferProtocol() {
  return loadClientModule('transferProtocol.js', TRANSFER_EXPORTS);
}

function loadFileTransfer() {
  return loadClientModule('fileTransfer.js', FILE_TRANSFER_EXPORTS);
}

function loadStatusFeed() {
  return loadClientModule('statusFeed.js', STATUS_FEED_EXPORTS);
}

function loadShortsFeed() {
  return loadClientModule('shortsFeed.js', SHORTS_FEED_EXPORTS);
}

function loadTranscript() {
  return loadClientModule('transcript.js', TRANSCRIPT_EXPORTS);
}

function loadEmoji() {
  return loadClientModule('emoji.js', EMOJI_EXPORTS);
}

function loadLocalStore() {
  return loadClientModule('localStore.js', LOCAL_STORE_EXPORTS);
}

function loadPreferences() {
  return loadClientModule('preferences.js', PREFERENCE_EXPORTS);
}

module.exports = {
  loadRoomChat, loadRichCards, loadA11y, loadMediaPrepare, loadCallWindow, loadNotifications,
  loadCallHistory, loadIceCache, loadCallRecovery, loadTransferProtocol, loadFileTransfer, loadStatusFeed, loadShortsFeed, loadLocalStore, loadTranscript, loadEmoji, loadPreferences,
  ROOM_CHAT_EXPORTS, RICH_CARD_EXPORTS, A11Y_EXPORTS, MEDIA_PREPARE_EXPORTS, CALL_WINDOW_EXPORTS,
  NOTIFICATION_EXPORTS, CALL_HISTORY_EXPORTS, ICE_CACHE_EXPORTS, CALL_RECOVERY_EXPORTS, TRANSFER_EXPORTS, FILE_TRANSFER_EXPORTS,
  STATUS_FEED_EXPORTS, SHORTS_FEED_EXPORTS, LOCAL_STORE_EXPORTS, TRANSCRIPT_EXPORTS, EMOJI_EXPORTS, PREFERENCE_EXPORTS,
};
