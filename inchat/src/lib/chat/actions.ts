'use server';

import { redirect } from 'next/navigation';

import { createRepository } from '@/lib/chat/repository';
import { createClient } from '@/lib/supabase/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The repository bound to whoever is on this request.
 *
 * A conversation id in a form is not an invitation: every one of these actions
 * runs as the active guest session, and the database function decides whether that
 * person may be in the thread at all.
 */
async function repositoryForViewer() {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect('/');
  return createRepository(supabase);
}

function formText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function formList(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === 'string' && UUID.test(value));
}

export async function openSelfChat(): Promise<void> {
  const repository = await repositoryForViewer();

  let conversationId: string;
  try {
    conversationId = await repository.ensureSelfConversation();
  } catch {
    redirect('/app/chat/new?error=self_unavailable');
  }

  redirect(`/app/chat/${conversationId}`);
}

export async function openDirectChat(formData: FormData): Promise<void> {
  const repository = await repositoryForViewer();
  const userId = formText(formData, 'user_id');

  let conversationId: string;
  try {
    if (!UUID.test(userId)) throw new Error('no such person');
    conversationId = await repository.startDirect(userId);
  } catch {
    redirect('/app/chat/new?error=cannot_open');
  }

  redirect(`/app/chat/${conversationId}`);
}

/** The name and the roster both come back from the form; the database checks them. */
export async function createGroupChat(formData: FormData): Promise<void> {
  const repository = await repositoryForViewer();
  const title = formText(formData, 'title');
  const memberIds = formList(formData, 'member_ids');

  let conversationId: string;
  try {
    conversationId = await repository.startGroup(title, memberIds);
  } catch {
    redirect('/app/chat/new?error=cannot_open');
  }

  redirect(`/app/chat/${conversationId}`);
}
