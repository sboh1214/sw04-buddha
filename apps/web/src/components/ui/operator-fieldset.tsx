'use client';

import { chakra } from '@chakra-ui/react';

/**
 * An admin form's fields, off while the admin on screen is not known (`useOperatorId()` is
 * undefined: `GET /me` pending or failed, or SessionCacheGuard's reset). Each such form is drawn
 * for one admin — keyed by it, `key={operatorId ?? ''}` — so what A typed is dropped once `['me']`
 * turns from A to B in place, before the session does (ADR-0090 결정 4-2: no reset then), instead of
 * staying with its button on and naming B with B's cookie (ADR-0092, owner decision 2026-10-26
 * 17:21 answer 1 «적용함», as ADR-0091 결정 3 keys the wallet's coupon field). SessionCacheGuard's
 * reset empties it too, the key passing through '': the reset takes no form away, and A's text left
 * in it would go, once `GET /me` answers B, naming B with B's cookie — taken as B's write, which the
 * server's check refuses only before the reset (ADR-0092 결정 5, 8-18). Off until that admin is
 * known, nothing is typed for nobody: the first answer, which draws the form again for its admin,
 * drops nothing, and a pick made then is never handed to whichever admin `GET /me` names first (as
 * `operatorHold` holds nothing). A native `<fieldset disabled>`: every input, select, textarea and
 * button inside is off, the radio items' hidden inputs too — what a browser test waits on.
 */
export const OperatorFieldset = chakra('fieldset', {
  base: { border: '0', padding: '0', margin: '0', minWidth: '0' },
});
