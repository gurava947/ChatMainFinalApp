import { redirect } from 'next/navigation';

export default function LegacyLoginRoute(): never {
  redirect('/');
}
