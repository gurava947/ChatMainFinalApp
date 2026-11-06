'use strict';

/**
 * The browser APIs `client/src/localStore.js` is written against do not exist in
 * jsdom: no `indexedDB`, no `IDBKeyRange`, no `navigator.storage`, and - the one
 * that surprises people - no `structuredClone`, which is how IndexedDB copies a
 * record on the way in and out.
 *
 * `fake-indexeddb` supplies the first two. For cloning this uses Node's
 * `v8.serialize`, which implements the same structured clone algorithm a browser
 * does, rather than a JSON round trip: JSON would quietly accept things a real
 * database rejects and quietly drop `undefined` fields, and a storage layer whose
 * fake lies about what is storable is worse than no test.
 */

const v8 = require('node:v8');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

function installFakeIndexedDb(target = globalThis) {
  if (typeof target.structuredClone !== 'function') {
    target.structuredClone = (value) => v8.deserialize(v8.serialize(value));
  }
  const factory = new IDBFactory();
  target.indexedDB = factory;
  target.IDBKeyRange = IDBKeyRange;
  return factory;
}

function removeIndexedDb(target = globalThis) {
  target.indexedDB = undefined;
  target.IDBKeyRange = undefined;
}

/**
 * `navigator.storage` is absent in jsdom, which is itself one of the cases the
 * store has to handle. This puts a quota answer in its place, and hands back the
 * undo so a test cannot leak it into the next one.
 */
function stubStorageApi(target, storage) {
  const descriptor = Object.getOwnPropertyDescriptor(target.navigator, 'storage');
  Object.defineProperty(target.navigator, 'storage', { value: storage, configurable: true, writable: true });
  return () => {
    delete target.navigator.storage;
    if (descriptor) Object.defineProperty(target.navigator, 'storage', descriptor);
  };
}

module.exports = { installFakeIndexedDb, removeIndexedDb, stubStorageApi };
