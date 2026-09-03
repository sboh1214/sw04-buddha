import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthCard } from '@/components/auth/auth-card';
import { copy } from '@/copy';
import { getServerSession } from '@/lib/session.server';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: `${copy.signupTitle} | ${copy.appName}` };

export default async function SignupPage() {
  if (await getServerSession()) redirect('/');
  return (
    <AuthCard title={copy.signupTitle} subtitle={copy.signupSubtitle}>
      <SignupForm />
    </AuthCard>
  );
}
