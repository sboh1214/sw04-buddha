'use client';

import { Button, Dialog, Portal } from '@chakra-ui/react';
import { type ReactNode } from 'react';
import { copy } from '@/copy';

export interface ConfirmDialogProps {
  /** Prefix of the two buttons' test ids: `<testId>-confirm` and `<testId>-cancel`. */
  testId: string;
  open: boolean;
  onClose: () => void;
  title: string;
  confirmLabel: string;
  loading: boolean;
  onConfirm: () => void;
  children: ReactNode;
}

/**
 * The one confirmation shape the admin market detail's transitions and open-market edit share,
 * with the admin theme screen (#81), and since #77 (ADR-0089) the 시장 제안 screens too: the
 * proposer's 철회 and the operators' 채택 and 반려, all final. Moved out of admin-market-detail.tsx
 * unchanged so a member screen can use it.
 * Mounted only while open (several of these live on a page; a closed one must not answer a test
 * id), and pinned while the mutation runs: Cancel, Esc and the backdrop all wait, since dismissing
 * it mid-flight would leave the request running against a screen that no longer shows it.
 */
export function ConfirmDialog({
  testId,
  open,
  onClose,
  title,
  confirmLabel,
  loading,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (!details.open && !loading) onClose();
      }}
      role="alertdialog"
      lazyMount
      unmountOnExit
      closeOnInteractOutside={!loading}
      closeOnEscape={!loading}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>{children}</Dialog.Body>
            <Dialog.Footer>
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={onClose}
                data-testid={`${testId}-cancel`}
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                loading={loading}
                onClick={onConfirm}
                data-testid={`${testId}-confirm`}
              >
                {confirmLabel}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
