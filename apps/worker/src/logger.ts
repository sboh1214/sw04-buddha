import { pino, type Logger, type LoggerOptions } from 'pino';
import { getEnv } from './env.js';

const env = getEnv();

const defaultLevel: Record<typeof env.NODE_ENV, string> = {
  development: 'debug',
  test: 'silent',
  production: 'info',
};

const options: LoggerOptions = {
  name: 'worker',
  level: env.LOG_LEVEL ?? defaultLevel[env.NODE_ENV],
};

if (env.NODE_ENV === 'development') {
  // pino-pretty runs in a worker thread (pino.transport). It is a devDependency,
  // so this branch must never be taken outside development.
  options.transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
  };
}

export const logger: Logger = pino(options);
