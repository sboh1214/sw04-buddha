'use client';

import {
  Toaster as ChakraToaster,
  Portal,
  Spinner,
  Stack,
  Toast,
  createToaster,
} from '@chakra-ui/react';
import {
  BOTTOM_TABS_HEIGHT_PX,
  ORDER_ENTRY_BAR_HEIGHT_PX,
  ORDER_SHEET_MAX_HEIGHT,
} from '@/lib/nav';

/** zag's own offset from each edge of the viewport, kept everywhere but the bottom below md. */
const TOAST_EDGE_OFFSET = '1rem';

/**
 * The toast group's bottom offset: a custom property the group's own class sets per width
 * (`TOAST_OFFSET_BOTTOM_*`, `Toaster` below), zag's 1rem where it is not set. zag writes it into
 * the group's inline `bottom: max(env(safe-area-inset-bottom), <offset>)`, so the property is
 * read on the group itself.
 */
const TOAST_OFFSET_BOTTOM_VAR = '--toast-offset-bottom';

/**
 * Below md the bottom of the viewport is the fixed tab bar's, and on an open market's detail the
 * YES·NO 매수 bar's above it (ADR-0067, #122): a toast stands 1rem above both, so one that stays
 * until it is closed (an order's result, ADR-0140 결정 2-7) never covers the tabs or the buy
 * buttons (ADR-0140 결정 2-24). While the order sheet is open it covers both bars, and a toast at
 * their height would lie on the sheet's own buttons: it stands 1rem above the sheet's tallest
 * instead, over the dimmed page — and the sheet's tallest leaves a toast of two lines its room
 * under the top of the viewport on every height (`ORDER_SHEET_MAX_HEIGHT`, lib/nav.ts), so the
 * toast and its close button are never pushed out above a short viewport. From md up neither bar
 * nor the sheet exists and the toast keeps zag's 1rem.
 */
export const TOAST_OFFSET_BOTTOM_TABS = `calc(${TOAST_EDGE_OFFSET} + ${String(
  BOTTOM_TABS_HEIGHT_PX,
)}px + env(safe-area-inset-bottom))`;
export const TOAST_OFFSET_BOTTOM_ORDER_ENTRY = `calc(${TOAST_EDGE_OFFSET} + ${String(
  BOTTOM_TABS_HEIGHT_PX + ORDER_ENTRY_BAR_HEIGHT_PX,
)}px + env(safe-area-inset-bottom))`;
export const TOAST_OFFSET_BOTTOM_ORDER_SHEET = `calc(${TOAST_EDGE_OFFSET} + ${ORDER_SHEET_MAX_HEIGHT})`;

/**
 * The group's own bottom offset per width. Below md only: above the tab bar, and above the 매수
 * bar while the page has one (it is in the page only on an open market's detail,
 * order-entry-bar.tsx), and above the order sheet while it is open (it is in the page only then:
 * `lazyMount` and `unmountOnExit`) — the later rule, since the 매수 bar is still in the page under
 * the sheet. From md up nothing is set and zag's 1rem stands.
 */
export const TOAST_GROUP_CSS = {
  mdDown: {
    [TOAST_OFFSET_BOTTOM_VAR]: TOAST_OFFSET_BOTTOM_TABS,
    'html:has([data-testid="order-entry-bar"]) &': {
      [TOAST_OFFSET_BOTTOM_VAR]: TOAST_OFFSET_BOTTOM_ORDER_ENTRY,
    },
    'html:has([data-testid="order-sheet"]) &': {
      [TOAST_OFFSET_BOTTOM_VAR]: TOAST_OFFSET_BOTTOM_ORDER_SHEET,
    },
  },
};

/** App-wide toast store. Call `toaster.create({ title, type })` from anywhere on the client. */
export const toaster = createToaster({
  placement: 'bottom-end',
  pauseOnPageIdle: true,
  offsets: {
    top: TOAST_EDGE_OFFSET,
    left: TOAST_EDGE_OFFSET,
    right: TOAST_EDGE_OFFSET,
    bottom: `var(${TOAST_OFFSET_BOTTOM_VAR}, ${TOAST_EDGE_OFFSET})`,
  },
});

/**
 * A toast raised while React runs effects — from an effect's body, or from a callback one calls —
 * stored once the effects are over. The toast group keeps its list with React's `flushSync` (zag's
 * `sync` bindable), which React cannot run during its commit: in development it logs 'flushSync was
 * called from inside a lifecycle method' once for each subscriber of the store (the comment
 * drafts taken back after an account switch, ADR-0092 8-37). A microtask later the commit is over —
 * still in the same task, before the browser paints and before any event or network callback — so
 * the toast says the same thing at the same moment, with the same id. Only the toast waits: what the
 * effect decides (that it was said, the draft taken out of the tab) stays where it is.
 */
export function toastAfterCommit(options: Parameters<typeof toaster.create>[0]): void {
  queueMicrotask(() => {
    toaster.create(options);
  });
}

/** Renders the toast region; mounted once in Provider. (Chakra v3 "toaster" snippet.) */
export function Toaster() {
  return (
    <Portal>
      <ChakraToaster toaster={toaster} insetInline={{ mdDown: '4' }} css={TOAST_GROUP_CSS}>
        {(toast) => (
          <Toast.Root width={{ md: 'sm' }}>
            {toast.type === 'loading' ? (
              <Spinner size="sm" color="colorPalette.solid" />
            ) : (
              <Toast.Indicator />
            )}
            <Stack gap="1" flex="1" maxWidth="100%">
              {toast.title && <Toast.Title>{toast.title}</Toast.Title>}
              {toast.description && <Toast.Description>{toast.description}</Toast.Description>}
            </Stack>
            {toast.action && <Toast.ActionTrigger>{toast.action.label}</Toast.ActionTrigger>}
            {toast.closable && <Toast.CloseTrigger />}
          </Toast.Root>
        )}
      </ChakraToaster>
    </Portal>
  );
}
