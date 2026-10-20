import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { assertObjectKey, type ObjectReadOptions, type ObjectStorage } from './object-storage.js';

/** What the driver needs of an S3 client: only `send`, so a test can hand it a fake one. */
export type S3Sender = Pick<S3Client, 'send'>;

/** The bucket, its region and, optionally, the access key of the app's own IAM user. */
export interface S3StorageConfig {
  readonly bucket: string;
  readonly region: string;
  /**
   * Both or neither. Neither leaves the SDK's default chain to find credentials (an instance role,
   * the standard AWS_* variables); a deployment whose containers cannot reach the instance role
   * (IMDSv2 with a hop limit of 1, terraform/ec2.tf) gives the app an access key of its own.
   */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
}

/** The S3 client of a deployment, built from the configuration. */
export function createS3Client(config: S3StorageConfig): S3Client {
  const options: S3ClientConfig = { region: config.region };
  if (config.accessKeyId !== undefined && config.secretAccessKey !== undefined) {
    options.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }
  return new S3Client(options);
}

/**
 * Whether `error` is S3's answer for a key with no object: the modelled `NoSuchKey` (by its class,
 * or by its name when another copy of the SDK made it) and nothing else. Other 404s are failures of
 * the store, not answers about the object — `NoSuchBucket` after a wrong bucket name or a removed
 * bucket would otherwise make every image look gone (a 404 per image) while nothing reports the
 * outage — so they are passed on like any other failure.
 */
function isNoSuchKey(error: unknown): boolean {
  return (
    error instanceof NoSuchKey || (error as { name?: unknown } | undefined)?.name === 'NoSuchKey'
  );
}

/** What an S3 answer's body is in Node: a stream the SDK can read whole, and stop. */
interface ObjectBody {
  transformToByteArray(): Promise<Uint8Array>;
  destroy?: (error?: Error) => void;
}

/**
 * The whole of `body`. A `signal` aborted while the bytes stream in destroys the stream, so the read
 * rejects then rather than downloading the rest (the SDK's own `abortSignal` stops the request; this
 * stops the body after the answer has begun). One aborted already — between the answer's headers
 * and this call — destroys the body before a byte of it is read, rather than leaving the stream
 * unread on its connection.
 */
async function readWhole(body: ObjectBody, signal: AbortSignal | undefined): Promise<Uint8Array> {
  if (signal === undefined) return body.transformToByteArray();
  if (signal.aborted) {
    // Closed without an error: nothing reads it, so no one would hear one.
    body.destroy?.();
    signal.throwIfAborted();
  }
  const stop = () => {
    body.destroy?.(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    return await body.transformToByteArray();
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/**
 * The private bucket of a deployment (ADR-0069 decision 2 #45-3: a new S3 bucket, the API writes
 * what it checked and converted). The bucket's own settings — public access blocked, encryption
 * at rest — are terraform's (terraform/media.tf); nothing here makes an object public, and the
 * objects are read back only by the API, which decides whether one may be shown.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3';
  private readonly client: S3Sender;
  private readonly bucket: string;

  constructor(client: S3Sender, bucket: string) {
    this.client = client;
    this.bucket = bucket;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    assertObjectKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string, options: ObjectReadOptions = {}): Promise<Uint8Array | null> {
    assertObjectKey(key);
    try {
      const answer = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: options.signal },
      );
      if (!answer.Body) return null;
      return await readWhole(answer.Body as ObjectBody, options.signal);
    } catch (error) {
      if (isNoSuchKey(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    // S3 answers 204 for a key with no object, so a repeated cleanup is not an error.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
