import { redirect } from 'next/navigation';

export default function LegacyResetRoute(): never {
  redirect('/');
}
