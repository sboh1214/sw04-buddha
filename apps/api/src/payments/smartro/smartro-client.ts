import {
  SMARTRO_APPROVAL_PATH,
  SMARTRO_CANCEL_PATH,
  SMARTRO_INQUIRY_PATH,
} from './smartro-protocol.js';

/** Injection token for the SmartroPay HTTP client; tests replace it with a fake PG. */
export const SMARTRO_CLIENT = Symbol('SMARTRO_CLIENT');

/**
 * A SmartroPay answer: a flat JSON object. The manual warns that fields may be added without
 * notice, so nothing here fixes its shape — the caller parses only what it uses.
 */
export type SmartroResponse = Record<string, unknown>;

/** What the approval and the result inquiry both take (the PC callback / mobile ReturnUrl gave them). */
export interface SmartroAuth {
  Tid: string;
  TrAuthKey: string;
}

/** The cancel request as it goes on the wire: the AES-encrypted parameters plus the Mid in clear. */
export interface SmartroCancelBody {
  EncData: string;
  Mid: string;
}

/** The three server-to-server calls of 일반연동. Each resolves to the PG's JSON answer. */
export interface SmartroClient {
  approve(body: SmartroAuth): Promise<SmartroResponse>;
  /** The approval's result again, within an hour of it (EXTRA STEP 승인 결과 재요청). */
  inquire(body: SmartroAuth): Promise<SmartroResponse>;
  cancel(body: SmartroCancelBody): Promise<SmartroResponse>;
}

/**
 * No readable answer: the PG was unreachable, timed out, answered a non-2xx status or something
 * that is not a JSON object. The call MAY have taken effect, so callers treat the outcome as
 * unknown — never as a refusal.
 */
export class SmartroUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SmartroUnreachableError';
  }
}

/**
 * Bound on one call. The manual's samples read for 20 s ("원천사 별로 최대 응답 시간이 상이");
 * this adds headroom for the connect. Global fetch takes no separate connect timeout without
 * undici's Agent (not a dependency), so this one bound covers both.
 */
export const SMARTRO_TIMEOUT_MS = 25_000;

/** The real client: global fetch, JSON both ways, TLS as Node ships it. */
export class FetchSmartroClient implements SmartroClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = SMARTRO_TIMEOUT_MS,
  ) {}

  approve(body: SmartroAuth): Promise<SmartroResponse> {
    return this.post(SMARTRO_APPROVAL_PATH, body);
  }

  inquire(body: SmartroAuth): Promise<SmartroResponse> {
    return this.post(SMARTRO_INQUIRY_PATH, body);
  }

  cancel(body: SmartroCancelBody): Promise<SmartroResponse> {
    return this.post(SMARTRO_CANCEL_PATH, body);
  }

  private async post(path: string, body: object): Promise<SmartroResponse> {
    const url = new URL(path, this.baseUrl).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The request itself is never in the message: it carries TrAuthKey or EncData.
      throw new SmartroUnreachableError(`${path}: ${describeFailure(error)}`, { cause: error });
    }
    if (!response.ok) {
      throw new SmartroUnreachableError(`${path}: HTTP ${String(response.status)}`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new SmartroUnreachableError(`${path}: the answer is not JSON`, { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SmartroUnreachableError(`${path}: the answer is not a JSON object`);
    }
    return parsed as SmartroResponse;
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'timed out' : `${error.name}: ${error.message}`;
  }
  return String(error);
}
