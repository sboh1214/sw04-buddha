import { Body, Controller, Get, HttpException, NotFoundException, Post } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommonModule } from '../common.module.js';
import { RawResponse } from '../decorators/raw-response.decorator.js';
import { AppError } from '../errors/app-error.js';

/** Every failure mode the global filter maps (the PLAN 7 envelope), through real Fastify. */
@Controller('boom')
class BoomController {
  @Get('app-error')
  appError(): never {
    throw new AppError('NOT_FOUND', { message: 'no such thing', details: { id: 'x' } });
  }

  @Get('http-exception')
  httpException(): never {
    throw new NotFoundException('nest says no');
  }

  @Get('teapot')
  teapot(): never {
    throw new HttpException('short and stout', 418);
  }

  @Get('upstream')
  upstream(): never {
    throw new HttpException('bad gateway', 502);
  }

  @Get('crash')
  crash(): never {
    throw new Error('secret internal detail');
  }

  @Get('internal-app-error')
  internalAppError(): never {
    throw new AppError('INTERNAL', {
      message: 'Ledger insert failed for balance 42',
      details: { table: 'ledger_entries' },
    });
  }

  @Get('raw')
  @RawResponse()
  raw(): never {
    throw new HttpException({ status: 'degraded' }, 503);
  }

  @Get('ok')
  ok() {
    return { fine: true };
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }

  /** What the better-auth JSON parser throws: a bare SyntaxError, V8's message quoting the body. */
  @Get('raw-syntax')
  @RawResponse()
  rawSyntax(): never {
    throw new SyntaxError(`Unexpected token '홍', "홍길동 01012345678" is not valid JSON`);
  }
}

describe('ApiExceptionFilter (HTTP)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule],
      controllers: [BoomController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('AppError -> its status and code, message and details preserved', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/app-error' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'no such thing', details: { id: 'x' } },
    });
  });

  it('HttpException -> code derived from the status', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/http-exception' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'nest says no' } });
  });

  it('unmapped statuses keep the status: other 4xx -> VALIDATION_ERROR, 5xx -> INTERNAL', async () => {
    const teapot = await app.inject({ method: 'GET', url: '/boom/teapot' });
    expect(teapot.statusCode).toBe(418);
    expect(teapot.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const upstream = await app.inject({ method: 'GET', url: '/boom/upstream' });
    expect(upstream.statusCode).toBe(502);
    // 502, and still no message of its own: ADR-0020's rule is about the status class, not
    // about which class threw. `bad gateway` names an upstream this API has.
    expect(upstream.json()).toEqual({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
    expect(upstream.body).not.toContain('bad gateway');
  });

  it('AppError(INTERNAL) does not leak its developer message either', async () => {
    // The codebase throws this shape in three dozen places, with sentences written for someone
    // reading a stack trace: which table was written, which row was missing. The envelope must
    // not hand that to whoever asked.
    const res = await app.inject({ method: 'GET', url: '/boom/internal-app-error' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(res.body).not.toContain('Ledger insert failed');
    expect(res.body).not.toContain('ledger_entries');
  });

  it('unexpected Error -> 500 INTERNAL without leaking the message', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(res.body).not.toContain('secret internal detail');
  });

  it('@RawResponse() handlers bypass the envelope for errors and data', async () => {
    const raw = await app.inject({ method: 'GET', url: '/boom/raw' });
    expect(raw.statusCode).toBe(503);
    expect(raw.json()).toEqual({ status: 'degraded' });

    const ok = await app.inject({ method: 'GET', url: '/boom/ok' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ data: { fine: true } });
  });
});

describe('ApiExceptionFilter (logs)', () => {
  let app: NestFastifyApplication;
  /** Every line the app's pino logger wrote, at debug and above. */
  const lines: string[] = [];
  const logged = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule],
      controllers: [BoomController],
    }).compile();
    const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) });
    // As in main.ts: Nest's own parsers off, and a JSON parser that fails the way the one
    // @thallesp/nestjs-better-auth installs does — a bare `JSON.parse`, whose SyntaxError reaches
    // the filter as it is (Fastify's own parser errors arrive wrapped, without the body).
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ loggerInstance: logger }),
      { bodyParser: false, logger: false },
    );
    app
      .getHttpAdapter()
      .getInstance()
      .addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
        try {
          done(null, JSON.parse(body as string) as unknown);
        } catch (error) {
          done(error as Error, undefined);
        }
      });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it('logs a body that did not parse without the part of it V8 quotes', async () => {
    // `Unexpected token '홍', ..."realName":홍길동,"phone"... is not valid JSON`.
    const res = await app.inject({
      method: 'POST',
      url: '/boom/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"realName":홍길동,"phone":"01012345678"}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' },
    });
    const refused = logged().filter((line) => line.msg === 'request refused');
    expect(refused).toEqual([
      expect.objectContaining({
        level: 20,
        status: 400,
        code: 'VALIDATION_ERROR',
        errName: 'SyntaxError',
      }),
    ]);
    expect(refused[0]).not.toHaveProperty('err');

    // The better-auth parser's bare SyntaxError, thrown on a @RawResponse() route: the same.
    const raw = await app.inject({ method: 'GET', url: '/boom/raw-syntax' });
    expect(raw.statusCode).toBe(400);
    expect(logged().filter((line) => line.msg === 'request refused')).toHaveLength(2);

    const everything = lines.join('\n');
    expect(everything).not.toContain('01012345678');
    expect(everything).not.toContain('홍길동');
  });

  it('still logs any other refusal with its error', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom/app-error' });
    expect(res.statusCode).toBe(404);
    const [refused] = logged().filter((line) => line.msg === 'request refused');
    expect(refused).toMatchObject({ level: 20, err: { message: 'no such thing' } });
  });
});
