import type { Message, MessageKind } from './timeline';

/**
 * The database surface the chat screen needs, as one narrow object.
 *
 * Every call goes through a SECURITY DEFINER function rather than the table:
 * a client cannot insert a receipt for somebody else's message, cannot forge a
 * sender, and cannot write into a conversation it was never added to. This
 * module is the only place that knows those function names, so a component
 * never builds an RPC call by hand and a fake client can be injected in tests.
 */

export type RpcError = { message: string; code?: string };

export type RpcResult = { data: unknown; error: RpcError | null };

export type DbClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
};

export class ChatRpcFailure extends Error {
  code: string | undefined;

  constructor(name: string, error: RpcError) {
    super(`${name}: ${error.message}`);
    this.name = 'ChatRpcFailure';
    this.code = error.code;
  }
}

/** A row of public.messages, exactly as the table declares it. */
export type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  kind: MessageKind;
  body: string;
  payload: Record<string, unknown> | null;
  client_id: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
};

export type ConversationRow = {
  id: string;
  kind: string;
  title: string | null;
  avatar_path: string | null;
  partner_id: string | null;
  partner_name: string | null;
  partner_username: string | null;
  last_message_at: string | null;
  sort_at: string | null;
  unread_count: number | string;
  muted: boolean;
  role: string;
};

export type SendAck = {
  id: string;
  createdAt: number;
  senderId: string;
  /** The server already held this client id, so nothing new was stored. */
  duplicate: boolean;
};

/** A row of public.attachments, as register_message_attachment() files it. */
export type AttachmentRegistration = {
  storagePath: string;
  /** The attachments table, not the message: a voice note is an 'audio' row. */
  kind: 'image' | 'video' | 'audio' | 'file';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationSecs?: number | null;
};

/** Someone who can be messaged: a finished profile, never the viewer. */
export type Person = { id: string; name: string; handle: string };

export type SearchHit = {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  senderId: string;
  senderName: string;
  body: string;
  kind: MessageKind;
  createdAt: number;
};

const ms = (iso: string): number => Date.parse(iso);

/** Fold a database row into the shape the timeline folds on. */
export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    clientId: row.client_id,
    kind: row.kind,
    body: row.body,
    payload: row.payload ?? {},
    createdAt: ms(row.created_at),
    editedAt: row.edited_at === null ? null : ms(row.edited_at),
    deletedAt: row.deleted_at === null ? null : ms(row.deleted_at),
    pending: false,
    failed: false
  };
}

function rows<T>(name: string, result: RpcResult): T[] {
  if (result.error) throw new ChatRpcFailure(name, result.error);
  if (result.data === null || result.data === undefined) return [];
  return Array.isArray(result.data) ? (result.data as T[]) : ([result.data] as T[]);
}

function one<T>(name: string, result: RpcResult): T {
  if (result.error) throw new ChatRpcFailure(name, result.error);
  return result.data as T;
}

/**
 * A conversation id, or a failure.
 *
 * The create-functions answer with a bare uuid, and a null travelling any
 * further than here becomes a link to `/app/chat/null`: the user sits on a
 * blank thread that cannot be opened, with no error to read.
 */
function id(name: string, result: RpcResult): string {
  const value = one<unknown>(name, result);
  if (typeof value !== 'string' || value.length === 0) {
    throw new ChatRpcFailure(name, { message: 'no conversation id returned' });
  }
  return value;
}

export type Cursor = { createdAt: number; id: string };

export function createRepository(client: DbClient) {
  return {
    async listConversations(input: {
      limit?: number;
      before?: Cursor | null;
    } = {}): Promise<ConversationRow[]> {
      const result = await client.rpc('list_my_conversations', {
        p_limit: input.limit ?? 30,
        p_before_sort_at: input.before ? new Date(input.before.createdAt).toISOString() : null,
        p_before_id: input.before?.id ?? null
      });
      return rows<ConversationRow>('list_my_conversations', result);
    },

    /** Oldest-first window walking backwards; pass the previous page's cursor. */
    async listMessages(input: {
      conversationId: string;
      before?: Cursor | null;
      limit?: number;
    }): Promise<Message[]> {
      const result = await client.rpc('list_messages', {
        p_conversation_id: input.conversationId,
        p_before_created_at: input.before ? new Date(input.before.createdAt).toISOString() : null,
        p_before_id: input.before?.id ?? null,
        p_limit: input.limit ?? 50
      });
      return rows<MessageRow>('list_messages', result).map(toMessage).reverse();
    },

    async sendMessage(input: {
      conversationId: string;
      clientId: string;
      body: string;
      kind?: MessageKind;
      payload?: Record<string, unknown>;
    }): Promise<SendAck> {
      const result = await client.rpc('send_message', {
        p_conversation_id: input.conversationId,
        p_client_id: input.clientId,
        p_kind: input.kind ?? 'text',
        p_body: input.body,
        p_payload: input.payload ?? {}
      });
      const ack = rows<{
        message_id: string;
        message_created_at: string;
        message_sender_id: string;
        duplicate: boolean;
      }>('send_message', result)[0];

      if (!ack) throw new ChatRpcFailure('send_message', { message: 'no acknowledgement row' });
      return {
        id: ack.message_id,
        createdAt: ms(ack.message_created_at),
        senderId: ack.message_sender_id,
        duplicate: ack.duplicate === true
      };
    },

    async editMessage(messageId: string, body: string): Promise<Message> {
      const result = await client.rpc('edit_message', { p_message_id: messageId, p_body: body });
      return toMessage(one<MessageRow>('edit_message', result));
    },

    /** False when the window has closed or the caller is not allowed to remove it. */
    async deleteForEveryone(messageId: string): Promise<boolean> {
      const result = await client.rpc('delete_message_for_everyone', { p_message_id: messageId });
      return one<boolean>('delete_message_for_everyone', result) === true;
    },

    async markSeen(conversationId: string): Promise<number> {
      const result = await client.rpc('mark_messages_seen', {
        p_conversation_id: conversationId
      });
      return one<number>('mark_messages_seen', result) ?? 0;
    },

    /**
     * Report the messages this client actually received.
     *
     * Only the recipient can witness a delivery, and the bounded batch keeps a
     * scrolled thread from sending one request per row.
     */
    async markDelivered(conversationId: string, messageIds: string[]): Promise<number> {
      const result = await client.rpc('mark_messages_delivered', {
        p_conversation_id: conversationId,
        p_message_ids: messageIds
      });
      return one<number>('mark_messages_delivered', result) ?? 0;
    },

    /** null clears the mute; a timestamp mutes until then. */
    async setMute(conversationId: string, until: number | null): Promise<boolean> {
      const result = await client.rpc('set_conversation_mute', {
        p_conversation_id: conversationId,
        p_until: until === null ? null : new Date(until).toISOString()
      });
      return one<boolean>('set_conversation_mute', result) === true;
    },

    async unreadTotal(): Promise<number> {
      const result = await client.rpc('my_unread_total');
      return Number(one<number>('my_unread_total', result) ?? 0);
    },

    async search(query: string, limit = 50): Promise<SearchHit[]> {
      const result = await client.rpc('search_my_messages', { p_query: query, p_limit: limit });
      return rows<{
        message_id: string;
        conversation_id: string;
        conversation_title: string;
        sender_id: string;
        sender_name: string;
        body: string;
        kind: MessageKind;
        created_at: string;
      }>('search_my_messages', result).map((hit) => ({
        messageId: hit.message_id,
        conversationId: hit.conversation_id,
        conversationTitle: hit.conversation_title,
        senderId: hit.sender_id,
        senderName: hit.sender_name,
        body: hit.body,
        kind: hit.kind,
        createdAt: ms(hit.created_at)
      }));
    },

    /**
     * People the viewer can start a chat with.
     *
     * The term travels as a parameter to a function that sanitises it, because
     * a PostgREST filter string would put the keyboard's own text where the
     * query operators belong.
     */
    async findPeople(query: string, limit = 20): Promise<Person[]> {
      const result = await client.rpc('find_people', { p_query: query, p_limit: limit });
      return rows<{ user_id: string; name: string; handle: string }>('find_people', result).map(
        (row) => ({ id: row.user_id, name: row.name, handle: row.handle })
      );
    },

    async startDirect(otherUserId: string): Promise<string> {
      const result = await client.rpc('create_direct_conversation', {
        p_other_user_id: otherUserId
      });
      return id('create_direct_conversation', result);
    },

    /**
     * Vote in a poll.
     *
     * The server writes the voter into a map keyed by user, so this is safe to
     * fire twice: a second tap on another option moves the vote and a resend
     * changes nothing. False means the poll is closed or removed.
     */
    async voteInPoll(messageId: string, choice: number): Promise<boolean> {
      const result = await client.rpc('vote_in_poll', {
        p_message_id: messageId,
        p_choice: choice
      });
      return one<boolean>('vote_in_poll', result) === true;
    },

    /**
     * File the attachment row for a message whose bytes already landed.
     *
     * Runs after send_message() has returned an id, because the row references
     * the message. It is the one write the client may repeat: the server ignores
     * a second registration of the same storage path.
     */
    async registerAttachment(
      messageId: string,
      input: AttachmentRegistration
    ): Promise<boolean> {
      const result = await client.rpc('register_message_attachment', {
        p_message_id: messageId,
        p_storage_path: input.storagePath,
        p_kind: input.kind,
        p_file_name: input.fileName,
        p_mime_type: input.mimeType,
        p_size_bytes: input.sizeBytes,
        p_width: input.width ?? null,
        p_height: input.height ?? null,
        p_duration_secs: input.durationSecs ?? null
      });
      return one<boolean>('register_message_attachment', result) === true;
    },

    async startGroup(title: string, memberIds: string[]): Promise<string> {
      const result = await client.rpc('create_group_conversation', {
        p_title: title,
        p_member_ids: memberIds
      });
      return id('create_group_conversation', result);
    },

    /** The private "Message Yourself" thread, created on first use. */
    async ensureSelfConversation(): Promise<string> {
      const result = await client.rpc('ensure_self_conversation');
      return id('ensure_self_conversation', result);
    }
  };
}

export type Repository = ReturnType<typeof createRepository>;
