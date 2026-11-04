'use client';

import { useActionState } from 'react';

import { saveGuestProfile, startGuestChat } from '@/lib/guest/actions';
import type { GuestFormState } from '@/lib/guest/forms';

const initialState: GuestFormState = {};

function Feedback({ state }: { state: GuestFormState }) {
  return state.message ? (
    <p className="notice notice-error" role="alert">
      {state.message}
    </p>
  ) : null;
}

function GuestFields({
  fullName,
  username,
  bio
}: {
  fullName?: string;
  username?: string;
  bio?: string;
}) {
  const [state, action, pending] = useActionState(bio !== undefined ? saveGuestProfile : startGuestChat, initialState);
  return (
    <form action={action} className="grid gap-4">
      <label className="field">
        <span className="text-xs text-[var(--text-dim)]">Display name</span>
        <input
          className="input"
          name="fullName"
          defaultValue={fullName}
          maxLength={80}
          required
          autoComplete="nickname"
          placeholder="e.g. Arjun"
        />
        {state.errors?.fullName ? <span className="text-xs text-[var(--danger)]">{state.errors.fullName}</span> : null}
      </label>
      <label className="field">
        <span className="text-xs text-[var(--text-dim)]">Username</span>
        <input
          className="input"
          name="username"
          defaultValue={username}
          minLength={3}
          maxLength={32}
          pattern="[A-Za-z0-9._]{3,32}"
          required
          autoComplete="username"
          placeholder="e.g. arjun.k"
        />
        <span className="text-[11px] text-[var(--text-dim)]">3–32 characters: letters, numbers, dot or underscore.</span>
        {state.errors?.username ? <span className="text-xs text-[var(--danger)]">{state.errors.username}</span> : null}
      </label>
      {bio !== undefined ? (
        <label className="field">
          <span className="text-xs text-[var(--text-dim)]">Bio (optional)</span>
          <textarea className="input" name="bio" rows={3} maxLength={200} defaultValue={bio} />
        </label>
      ) : null}
      <Feedback state={state} />
      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? 'Getting your chat ready…' : bio !== undefined ? 'Save profile' : 'Continue to chats'}
      </button>
    </form>
  );
}

export function GuestEntryForm() {
  return (
    <div className="grid gap-4">
      <div className="panel grid gap-2 p-4">
        <h2 className="text-sm font-semibold">Join as a guest</h2>
        <p className="text-sm text-[var(--text-dim)]">No account or sign-in. Choose a name and username, then create or join a chat room.</p>
      </div>
      <GuestFields />
    </div>
  );
}

export function GuestProfileForm({ fullName, username, bio }: { fullName: string; username: string; bio: string }) {
  return <GuestFields fullName={fullName} username={username} bio={bio} />;
}
