'use client';

import { IconButton, Input, InputGroup, type InputProps } from '@chakra-ui/react';
import { forwardRef, useState } from 'react';
import { copy } from '@/copy';

/** Password field with a show/hide toggle. Forwards the ref for react-hook-form `register`. */
export const PasswordInput = forwardRef<HTMLInputElement, InputProps>(
  function PasswordInput(props, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <InputGroup
        endElement={
          <IconButton
            type="button"
            variant="ghost"
            size="xs"
            aria-label={visible ? copy.hidePassword : copy.showPassword}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
            tabIndex={-1}
          >
            <EyeIcon open={visible} />
          </IconButton>
        }
      >
        <Input
          ref={ref}
          type={visible ? 'text' : 'password'}
          autoComplete="current-password"
          {...props}
        />
      </InputGroup>
    );
  },
);

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {open ? null : <path d="M3 3l18 18" />}
    </svg>
  );
}
