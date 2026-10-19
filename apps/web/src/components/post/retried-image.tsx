'use client';

import { Image, type ImageProps } from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IMAGE_RETRY_ATTEMPTS, recoverImage, sleep } from '@/lib/image-retry';

/**
 * One of our images (`GET /media/:id` — a post's image, a card's thumbnail) as a plain `<img>` that
 * is drawn again after a refusal that only asked to wait: on its error the image is asked for again
 * the way lib/image-retry.ts reads (429 → its `Retry-After`, bounded), and once it came back the
 * element is made anew, which the browser answers from its cache. Anything else leaves it broken,
 * as before. Keyed by the address: a new image starts with its own budget.
 */
export function RetriedImage(props: ImageProps & { src: string }) {
  return <RetriedImageOf key={props.src} {...props} />;
}

function RetriedImageOf({ src, ...rest }: ImageProps & { src: string }) {
  // How many times the image came back: the element's key, so each is a new element.
  const [drawn, setDrawn] = useState(0);
  // The requests the image has left, spent across its failures (IMAGE_RETRY_ATTEMPTS in all).
  const [budget] = useState(() => ({ left: IMAGE_RETRY_ATTEMPTS }));
  const element = useRef<HTMLImageElement>(null);
  // The recovery under way, given up when the image goes.
  const recovering = useRef<AbortController | null>(null);

  useEffect(() => {
    const under = recovering;
    return () => {
      under.current?.abort();
    };
  }, []);

  const recover = useCallback(() => {
    // One at a time — but one given up (the image went, or React's development run unmounted the
    // effects once) is not under way any more.
    const under = recovering.current;
    if (under !== null && !under.signal.aborted) return;
    const controller = new AbortController();
    recovering.current = controller;
    recoverImage(src, budget, {
      fetch: (url, init) => window.fetch(url, init),
      sleep,
      signal: controller.signal,
    })
      .then(
        (back) => {
          if (back && !controller.signal.aborted) setDrawn((count) => count + 1);
        },
        // The network, or the image gone from the page: it stays as it is.
        () => undefined,
      )
      .finally(() => {
        if (recovering.current === controller) recovering.current = null;
      });
  }, [src, budget]);

  // An image that failed while the page was still being hydrated fired its error before React
  // listened (React replays no image event on hydration): finished with no picture is that error.
  // A lazy image not yet asked for is not finished (`complete` is false).
  useEffect(() => {
    const image = element.current;
    if (image !== null && image.complete && image.naturalWidth === 0) recover();
  }, [recover]);

  return <Image key={drawn} ref={element} src={src} {...rest} onError={recover} />;
}
