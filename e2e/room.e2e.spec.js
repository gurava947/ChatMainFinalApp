'use strict';

const { test, expect } = require('@playwright/test');

const CONTEXT_OPTIONS = { permissions: ['microphone', 'camera'] };

function roomName(suffix) {
  return `e2e-${suffix}-${Date.now().toString(36)}`;
}

async function joinRoom(page, displayName, room, code) {
  await page.getByRole('button', { name: 'Create or join a room' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create or join a room' });
  await dialog.getByLabel('Display name').fill(displayName);
  await dialog.getByLabel('Room name').fill(room);
  if (code) await dialog.getByLabel('Pairing code').fill(code);
  await dialog.getByRole('button', { name: 'Enter room' }).click();
  await expect(page.getByLabel('Type a message')).toBeVisible();
}

async function mintPairingCode(page) {
  await page.getByRole('button', { name: 'Chat settings' }).click();
  const settings = page.getByRole('dialog', { name: /Chat settings for/ });
  const give = settings.getByRole('button', { name: 'Give a code' });
  await expect(give).toBeVisible();
  await give.click();
  const code = settings.locator('.pairing-code code');
  await expect(code).toBeVisible();
  const value = (await code.textContent()).trim();
  await settings.getByRole('button', { name: 'Close chat settings' }).click();
  return value;
}

async function sendMessage(page, text) {
  const composer = page.getByLabel('Type a message');
  await composer.fill(text);
  await composer.press('Enter');
}

async function pairTwoGuests(browser, label, onPageCreated) {
  const ownerContext = await browser.newContext(CONTEXT_OPTIONS);
  const guestContext = await browser.newContext(CONTEXT_OPTIONS);
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();
  if (onPageCreated) {
    onPageCreated(owner);
    onPageCreated(guest);
  }
  const room = roomName(label);

  await owner.goto('/');
  await joinRoom(owner, 'E2E Owner', room);
  const code = await mintPairingCode(owner);

  await guest.goto('/');
  await joinRoom(guest, 'E2E Guest', room, code);

  return { ownerContext, guestContext, owner, guest, room };
}

async function expectBubble(page, text) {
  await expect(page.locator('.bubble-text').filter({ hasText: text })).toBeVisible();
}

/** The ICE config must be warmed once at boot and never again on the call path. */
function trackRtcConfig(page) {
  const seen = { requests: 0, responses: 0 };
  page.on('request', (request) => {
    if (request.url().includes('/api/rtc-config')) seen.requests += 1;
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/rtc-config')) seen.responses += 1;
  });
  return seen;
}

test('two guests pair, exchange messages, and keep history on reload', async ({ browser }) => {
  const { ownerContext, guestContext, owner, guest } = await pairTwoGuests(browser, 'chat');

  try {
    await sendMessage(owner, 'hello from the owner');
    await expectBubble(guest, 'hello from the owner');

    await sendMessage(guest, 'hello from the guest');
    await expectBubble(owner, 'hello from the guest');

    // History comes from the store, not from the socket that delivered it. A
    // reload lands on the room list, so the room has to be reopened first.
    await guest.reload();
    await guest.locator('.chat-item').first().click();
    await expectBubble(guest, 'hello from the owner');
    await expectBubble(guest, 'hello from the guest');
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});

test('one seat can call the other and both reach connected audio', async ({ browser }) => {
  const tracked = [];
  const { ownerContext, guestContext, owner, guest } = await pairTwoGuests(browser, 'call', (page) => tracked.push(trackRtcConfig(page)));
  const [ownerConfig, guestConfig] = tracked;

  try {
    // Each page warms the config once while joining; nothing after this should
    // touch the endpoint, because starting a call reads the cache.
    await expect.poll(() => ownerConfig.responses, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => guestConfig.responses, { timeout: 10_000 }).toBe(1);
    const bootRequests = { owner: ownerConfig.requests, guest: guestConfig.requests };

    await guest.getByRole('button', { name: 'Start audio call' }).click();
    const picker = guest.getByRole('dialog', { name: 'Choose someone for an audio call' });
    await picker.getByRole('button', { name: /E2E Owner/ }).click();

    const incoming = owner.getByRole('dialog', { name: 'audio call with E2E Guest' });
    await expect(incoming).toBeVisible();
    await incoming.getByRole('button', { name: 'Accept' }).click();

    // "Audio connected" is only rendered once the peer connection is up and both
    // sides have exchanged SDP and ICE, so it covers the whole media path.
    await expect(owner.getByText('Audio connected')).toBeVisible({ timeout: 30_000 });
    await expect(guest.getByText('Audio connected')).toBeVisible({ timeout: 30_000 });

    expect(ownerConfig.requests).toBe(bootRequests.owner);
    expect(guestConfig.requests).toBe(bootRequests.guest);
    expect(ownerConfig.requests).toBe(1);
    expect(guestConfig.requests).toBe(1);

    const outgoing = guest.getByRole('dialog', { name: 'audio call with E2E Owner' });
    await outgoing.getByRole('button', { name: 'End call' }).last().click();

    await expect(owner.getByRole('status').filter({ hasText: 'Call ended.' })).toBeVisible();
    await expect(owner.getByRole('button', { name: 'Start audio call' })).toBeEnabled();
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});

test('one seat can call the other with video and both see a live frame', async ({ browser }) => {
  const { ownerContext, guestContext, owner, guest } = await pairTwoGuests(browser, 'video');
  const pageErrors = [];
  for (const page of [owner, guest]) {
    page.on('pageerror', (error) => pageErrors.push(error.message));
  }

  try {
    await guest.getByRole('button', { name: 'Start video call' }).click();
    const picker = guest.getByRole('dialog', { name: 'Choose someone for an video call' });
    await picker.getByRole('button', { name: /E2E Owner/ }).click();

    const incoming = owner.getByRole('dialog', { name: 'video call with E2E Guest' });
    await expect(incoming).toBeVisible();
    await incoming.getByRole('button', { name: 'Accept' }).click();

    // videoWidth stays 0 until the remote track has actually produced a frame,
    // so this is stricter than checking that the element exists.
    for (const page of [owner, guest]) {
      await expect
        .poll(() => page.locator('.remote-call-video').evaluate((video) => video.videoWidth), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await expect
        .poll(() => page.locator('.local-call-video').evaluate((video) => video.videoWidth), { timeout: 30_000 })
        .toBeGreaterThan(0);
    }

    expect(pageErrors).toEqual([]);

    const outgoing = guest.getByRole('dialog', { name: 'video call with E2E Owner' });
    await outgoing.getByRole('button', { name: 'End call' }).last().click();
    await expect(owner.getByRole('status').filter({ hasText: 'Call ended.' })).toBeVisible();
  } finally {
    await ownerContext.close();
    await guestContext.close();
  }
});
