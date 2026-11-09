import { describe, expect, it } from 'vitest';

import {
  ChatRpcFailure,
  createRepository,
  toMessage,
  type DbClient,
  type MessageRow,
  type RpcResult
} from '@/lib/chat/repository';

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'm-1',
    conversation_id: 'c-1',
    sender_id: 'u-2',
    kind: 'text',
    body: 'hi',
    payload: {},
    client_id: 'k-1',
    created_at: '2026-11-03T10:00:00.000Z',
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    ...over
  };
}

const at = (iso: string) => Date.parse(iso);

/** Records every call so a test can assert on the exact arguments the RPC saw. */
function fake(responses: Responses = {}): {
  client: DbClient;
  calls: Array<{ name: string; args?: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const client: DbClient = {
    async rpc(name, args) {
      calls.push({ name, args });
      return responses[name] ?? { data: null, error: null };
    }
  };
  return { client, calls };
}

type Responses = Record<string, RpcResult>;

describe('row mapping', () => {
  it('turns a table row into a settled timeline message', () => {
    const message = toMessage(row({ edited_at: '2026-11-03T10:05:00.000Z' }));
    expect(message).toMatchObject({
      id: 'm-1',
      conversationId: 'c-1',
      senderId: 'u-2',
      clientId: 'k-1',
      createdAt: at('2026-11-03T10:00:00.000Z'),
      editedAt: at('2026-11-03T10:05:00.000Z'),
      deletedAt: null,
      pending: false,
      failed: false
    });
  });

  it('reads a null payload as an empty object, not as nothing', () => {
    expect(toMessage(row({ payload: null })).payload).toEqual({});
  });
});

describe('reads', () => {
  it('asks for the newest page and hands it back oldest first', async () => {
    const { client, calls } = fake({
      list_messages: { data: [row({ id: 'new', created_at: '2026-11-03T10:02:00.000Z' }), row({ id: 'old', created_at: '2026-11-03T10:01:00.000Z' })], error: null }
    });
    const messages = await createRepository(client).listMessages({ conversationId: 'c-1' });

    expect(messages.map((m) => m.id)).toEqual(['old', 'new']);
    expect(calls[0]).toEqual({
      name: 'list_messages',
      args: { p_conversation_id: 'c-1', p_before_created_at: null, p_before_id: null, p_limit: 50 }
    });
  });

  it('sends a keyset cursor as the pair the function expects', async () => {
    const { client, calls } = fake({ list_messages: { data: [], error: null } });
    const cursor = { createdAt: at('2026-11-03T09:00:00.000Z'), id: 'm-9' };

    await createRepository(client).listMessages({ conversationId: 'c-1', before: cursor, limit: 10 });
    expect(calls[0].args).toMatchObject({
      p_before_created_at: '2026-11-03T09:00:00.000Z',
      p_before_id: 'm-9',
      p_limit: 10
    });
  });

  it('treats a null body as an empty list instead of a crash', async () => {
    const { client } = fake({ list_my_conversations: { data: null, error: null } });
    expect(await createRepository(client).listConversations()).toEqual([]);
  });

  it('pages the conversation list from its sort position', async () => {
    const { client, calls } = fake({ list_my_conversations: { data: [], error: null } });
    await createRepository(client).listConversations({
      limit: 20,
      before: { createdAt: at('2026-11-01T08:00:00.000Z'), id: 'c-5' }
    });

    expect(calls[0].args).toMatchObject({
      p_limit: 20,
      p_before_sort_at: '2026-11-01T08:00:00.000Z',
      p_before_id: 'c-5'
    });
  });

  it('renames the search columns the function returns', async () => {
    const { client } = fake({
      search_my_messages: {
        data: [
          {
            message_id: 'm-1',
            conversation_id: 'c-1',
            conversation_title: 'Ana',
            sender_id: 'u-2',
            sender_name: 'Ana Souza',
            body: 'quarterly numbers',
            kind: 'text',
            created_at: '2026-11-03T10:00:00.000Z'
          }
        ],
        error: null
      }
    });

    const hits = await createRepository(client).search('numbers');
    expect(hits[0]).toMatchObject({
      messageId: 'm-1',
      conversationTitle: 'Ana',
      senderName: 'Ana Souza',
      createdAt: at('2026-11-03T10:00:00.000Z')
    });
  });

  it('sends the person search as a bound term, never as a filter string', async () => {
    const { client, calls } = fake({
      find_people: {
        data: [
          { user_id: 'u-2', name: 'Ana Souza', handle: 'ana' },
          { user_id: 'u-3', name: 'Anil Kumar', handle: 'anil.k' }
        ],
        error: null
      }
    });

    const people = await createRepository(client).findPeople('an');

    expect(calls[0]).toMatchObject({ name: 'find_people', args: { p_query: 'an', p_limit: 20 } });
    expect(people).toEqual([
      { id: 'u-2', name: 'Ana Souza', handle: 'ana' },
      { id: 'u-3', name: 'Anil Kumar', handle: 'anil.k' }
    ]);
  });

  it('reads the badge total as a number', async () => {
    const { client } = fake({ my_unread_total: { data: '7', error: null } });
    expect(await createRepository(client).unreadTotal()).toBe(7);
  });
});

describe('writes', () => {
  it('sends with an idempotency token and reports the acknowledgement', async () => {
    const { client, calls } = fake({
      send_message: {
        data: [{ message_id: 'm-9', message_created_at: '2026-11-03T10:00:00.000Z', message_sender_id: 'me', duplicate: false }],
        error: null
      }
    });

    const ack = await createRepository(client).sendMessage({
      conversationId: 'c-1',
      clientId: 'k-1',
      body: 'hello'
    });

    expect(calls[0].args).toMatchObject({
      p_conversation_id: 'c-1',
      p_client_id: 'k-1',
      p_kind: 'text',
      p_body: 'hello',
      p_payload: {}
    });
    expect(ack).toEqual({
      id: 'm-9',
      createdAt: at('2026-11-03T10:00:00.000Z'),
      senderId: 'me',
      duplicate: false
    });
  });

  it('tells the caller when the server already held the message', async () => {
    const { client } = fake({
      send_message: {
        data: [{ message_id: 'm-9', message_created_at: '2026-11-03T10:00:00.000Z', message_sender_id: 'me', duplicate: true }],
        error: null
      }
    });
    const ack = await createRepository(client).sendMessage({
      conversationId: 'c-1',
      clientId: 'k-1',
      body: 'hello'
    });
    expect(ack.duplicate).toBe(true);
  });

  it('refuses to pretend a send succeeded when no row came back', async () => {
    const { client } = fake({ send_message: { data: [], error: null } });
    await expect(
      createRepository(client).sendMessage({ conversationId: 'c-1', clientId: 'k-1', body: 'x' })
    ).rejects.toThrow(/no acknowledgement row/);
  });

  it('carries the poll payload through', async () => {
    const { client, calls } = fake({
      send_message: {
        data: [{ message_id: 'm-9', message_created_at: '2026-11-03T10:00:00.000Z', message_sender_id: 'me', duplicate: false }],
        error: null
      }
    });
    await createRepository(client).sendMessage({
      conversationId: 'c-1',
      clientId: 'k-2',
      body: '',
      kind: 'poll',
      payload: { question: 'Lunch?', options: ['a', 'b'] }
    });

    expect(calls[0].args).toMatchObject({
      p_kind: 'poll',
      p_payload: { question: 'Lunch?', options: ['a', 'b'] }
    });
  });

  it('maps an edit to the stored row', async () => {
    const { client, calls } = fake({
      edit_message: { data: row({ body: 'fixed', edited_at: '2026-11-03T11:00:00.000Z' }), error: null }
    });
    const edited = await createRepository(client).editMessage('m-1', 'fixed');

    expect(calls[0].args).toEqual({ p_message_id: 'm-1', p_body: 'fixed' });
    expect(edited).toMatchObject({ body: 'fixed', editedAt: at('2026-11-03T11:00:00.000Z') });
  });

  it('reports a refused delete instead of throwing', async () => {
    const yes = fake({ delete_message_for_everyone: { data: true, error: null } });
    const no = fake({ delete_message_for_everyone: { data: false, error: null } });

    expect(await createRepository(yes.client).deleteForEveryone('m-1')).toBe(true);
    expect(await createRepository(no.client).deleteForEveryone('m-1')).toBe(false);
  });

  it('reads the mute clear as a null timestamp', async () => {
    const { client, calls } = fake({ set_conversation_mute: { data: true, error: null } });
    await createRepository(client).setMute('c-1', null);
    expect(calls[0].args).toEqual({ p_conversation_id: 'c-1', p_until: null });

    await createRepository(client).setMute('c-1', at('2026-11-04T00:00:00.000Z'));
    expect(calls[1].args).toMatchObject({ p_until: '2026-11-04T00:00:00.000Z' });
  });

  it('counts the rows a seen-mark moved', async () => {
    const { client } = fake({ mark_messages_seen: { data: 4, error: null } });
    expect(await createRepository(client).markSeen('c-1')).toBe(4);
  });

  it('reports the batch this client actually received', async () => {
    const { client, calls } = fake({ mark_messages_delivered: { data: 2, error: null } });
    expect(await createRepository(client).markDelivered('c-1', ['m-1', 'm-2'])).toBe(2);
    expect(calls[0].args).toEqual({ p_conversation_id: 'c-1', p_message_ids: ['m-1', 'm-2'] });
  });

  it('reads a delivery report that recorded nothing as zero', async () => {
    const { client } = fake({ mark_messages_delivered: { data: null, error: null } });
    expect(await createRepository(client).markDelivered('c-1', ['m-1'])).toBe(0);
  });

  it('votes by index and reads a closed poll as false', async () => {
    const { client, calls } = fake({ vote_in_poll: { data: true, error: null } });
    expect(await createRepository(client).voteInPoll('m-1', 2)).toBe(true);
    expect(calls[0]).toEqual({ name: 'vote_in_poll', args: { p_message_id: 'm-1', p_choice: 2 } });

    const closed = fake({ vote_in_poll: { data: false, error: null } });
    expect(await createRepository(closed.client).voteInPoll('m-1', 0)).toBe(false);
  });

  it('files the attachment row against the message the send returned', async () => {
    const { client, calls } = fake({ register_message_attachment: { data: true, error: null } });
    const filed = await createRepository(client).registerAttachment('m-1', {
      storagePath: 'c-1/u-1/f-1.webm',
      kind: 'audio',
      fileName: 'voice note.webm',
      mimeType: 'audio/webm',
      sizeBytes: 18_432,
      durationSecs: 4.2
    });

    expect(filed).toBe(true);
    expect(calls[0].args).toEqual({
      p_message_id: 'm-1',
      p_storage_path: 'c-1/u-1/f-1.webm',
      p_kind: 'audio',
      p_file_name: 'voice note.webm',
      p_mime_type: 'audio/webm',
      p_size_bytes: 18_432,
      // The columns a voice note does not have are null, not absent: the
      // function signature is fixed and PostgREST needs every argument.
      p_width: null,
      p_height: null,
      p_duration_secs: 4.2
    });
  });

  it('reports a rejected registration instead of throwing', async () => {
    const { client } = fake({ register_message_attachment: { data: null, error: null } });
    expect(
      await createRepository(client).registerAttachment('m-1', {
        storagePath: 'c-1/u-1/f-1.jpg',
        kind: 'image',
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 10
      })
    ).toBe(false);
  });
});

describe('failures', () => {
  it('names the function and the code that failed', async () => {
    const { client } = fake({
      create_direct_conversation: { data: null, error: { message: 'that user cannot be messaged yet', code: '22023' } }
    });

    await expect(createRepository(client).startDirect('u-9')).rejects.toMatchObject({
      name: 'ChatRpcFailure',
      message: 'create_direct_conversation: that user cannot be messaged yet',
      code: '22023'
    });
  });

  it('never returns a half read when the database said no', async () => {
    const { client } = fake({ list_my_conversations: { data: null, error: { message: 'permission denied' } } });
    await expect(createRepository(client).listConversations()).rejects.toBeInstanceOf(ChatRpcFailure);
  });

  it('refuses to hand back a conversation id that is not there', async () => {
    const empty = fake({ ensure_self_conversation: { data: null, error: null } });
    const notAString = fake({ create_direct_conversation: { data: 42, error: null } });

    await expect(createRepository(empty.client).ensureSelfConversation()).rejects.toThrow(
      /no conversation id returned/
    );
    await expect(createRepository(notAString.client).startDirect('u-2')).rejects.toBeInstanceOf(
      ChatRpcFailure
    );
  });

  it('returns the id when the function gives one', async () => {
    const { client, calls } = fake({ create_group_conversation: { data: 'c-77', error: null } });
    expect(await createRepository(client).startGroup('Team', ['u-2', 'u-3'])).toBe('c-77');
    expect(calls[0].args).toMatchObject({ p_title: 'Team', p_member_ids: ['u-2', 'u-3'] });
  });
});
