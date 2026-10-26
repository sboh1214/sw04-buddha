'use client';

import {
  Toaster as ChakraToaster,
  Portal,
  Spinner,
  Stack,
  Toast,
  createToaster,
} from '@chakra-ui/react';

/** App-wide toast store. Call `toaster.create({ title, type })` from anywhere on the client. */
export const toaster = createToaster({
  placement: 'bottom-end',
  pauseOnPageIdle: true,
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
      <ChakraToaster toaster={toaster} insetInline={{ mdDown: '4' }}>
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
