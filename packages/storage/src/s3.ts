import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { assertObjectKey, type ObjectStorage } from './object-storage.js';

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

/** Whether `error` is S3's answer for a key with no object. */
function isNoSuchKey(error: unknown): boolean {
  return (
    error instanceof NoSuchKey ||
    (error as { name?: unknown } | undefined)?.name === 'NoSuchKey' ||
    (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
      ?.httpStatusCode === 404
  );
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

  async get(key: string): Promise<Uint8Array | null> {
    assertObjectKey(key);
    try {
      const answer = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!answer.Body) return null;
      return await answer.Body.transformToByteArray();
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
