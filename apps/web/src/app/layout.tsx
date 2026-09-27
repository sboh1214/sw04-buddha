import { Box } from '@chakra-ui/react';
import type { Metadata } from 'next';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import { OnboardingGate } from '@/components/auth/onboarding-gate';
import { BottomTabs } from '@/components/layout/bottom-tabs';
import { Footer } from '@/components/layout/footer';
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
              document itself has to be that much longer or its last row would end up under it.
              The footer is that last row now (ADR-0044), so the clearance is the footer's own
              bottom padding (footer.tsx) rather than `<main>`'s. */}
          <Box as="main">
            {/* A signed-in account with no real name and phone is sent to /onboarding from
                every page but a few (ADR-0043, components/auth/onboarding-gate.tsx). */}
            <OnboardingGate>{children}</OnboardingGate>
          </Box>
          <Footer />
          <BottomTabs />
        </Provider>
      </body>
    </html>
  );
}
