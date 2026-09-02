import type { Metadata } from 'next';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { Provider } from '@/components/ui/provider';
import { copy } from '@/copy';

export const metadata: Metadata = {
  title: copy.appName,
  description: copy.appDescription,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes sets class/style on <html> before hydration.
    <html lang="ko" suppressHydrationWarning>
      <body>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
