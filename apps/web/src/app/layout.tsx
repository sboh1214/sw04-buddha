import { Box } from '@chakra-ui/react';
import type { Metadata } from 'next';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { BottomTabs } from '@/components/layout/bottom-tabs';
import { Nav } from '@/components/layout/nav';
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
        <Provider>
          <Nav />
          {/* Below `md` the bottom of the viewport belongs to a fixed bar — the tab bar, or the
              trade panel's 예/아니오 bar on the market detail route. Neither is in the flow, so the
              document itself has to be that much longer or every page's last row would end up
              under it. At `md` and up nothing is fixed there and the padding goes away. */}
          <Box as="main" pb={{ base: '20', md: '0' }}>
            {children}
          </Box>
          <BottomTabs />
        </Provider>
      </body>
    </html>
  );
}
