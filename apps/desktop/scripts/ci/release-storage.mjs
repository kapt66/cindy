import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MUTABLE_CACHE_CONTROL = 'no-store, max-age=0';

function errorStatus(error) {
  return error?.$metadata?.httpStatusCode ?? error?.statusCode;
}

/** Object keys are always relative to the configured Cindy Meka prefix. */
export function normalizeReleaseObjectKey(prefix, relativeKey) {
  const cleanPrefix = String(prefix ?? '').replace(/^\/+|\/+$/g, '');
  const cleanRelative = String(relativeKey ?? '').replace(/^\/+/, '');
  if (
    !cleanRelative ||
    cleanRelative.includes('\\') ||
    cleanRelative.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`非法发布对象路径: ${relativeKey}`);
  }
  return cleanPrefix ? `${cleanPrefix}/${cleanRelative}` : cleanRelative;
}

export function contentTypeForReleaseFile(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (lower.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  return 'application/octet-stream';
}

/**
 * RustFS-compatible S3 storage adapter used only by Cindy Meka desktop release
 * tooling. Credentials remain inside the AWS SDK client and are never logged.
 */
export class MekaReleaseStorage {
  constructor(
    config,
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      // AWS SDK annotates static credentials with internal feature metadata.
      // Release config is intentionally frozen, so hand the SDK a private copy.
      credentials: { ...config.credentials },
      forcePathStyle: config.forcePathStyle,
    }),
  ) {
    this.config = config;
    this.client = client;
  }

  objectKey(relativeKey) {
    return normalizeReleaseObjectKey(this.config.prefix, relativeKey);
  }

  cdnUrl(relativeKey) {
    return `${this.config.cdnBase.replace(/\/+$/, '')}/${String(relativeKey).replace(/^\/+/, '')}`;
  }

  async head(relativeKey) {
    const Key = this.objectKey(relativeKey);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key,
        }),
      );
      return {
        key: Key,
        size: Number(result.ContentLength) || 0,
        metadata: result.Metadata ?? {},
        etag: result.ETag,
        lastModified: result.LastModified,
      };
    } catch (error) {
      if (errorStatus(error) === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async getBuffer(relativeKey) {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.objectKey(relativeKey),
      }),
    );
    if (!result.Body) throw new Error(`RustFS 返回空对象体: ${relativeKey}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async deleteObject(relativeKey) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: this.objectKey(relativeKey),
      }),
    );
  }

  async listKeys(relativePrefix) {
    const keys = [];
    let continuationToken;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: this.objectKey(relativePrefix),
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of result.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
      if (result.IsTruncated && !result.NextContinuationToken) {
        throw new Error(`RustFS 分页响应缺少 continuation token: ${relativePrefix}`);
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    const configuredPrefix = String(this.config.prefix ?? '').replace(/^\/+|\/+$/g, '');
    if (!configuredPrefix) return keys;
    const prefixWithSlash = `${configuredPrefix}/`;
    return keys.map((key) => {
      if (!key.startsWith(prefixWithSlash)) {
        throw new Error(`RustFS 返回了发布前缀外的对象: ${key}`);
      }
      return key.slice(prefixWithSlash.length);
    });
  }

  async getText(relativeKey) {
    return (await this.getBuffer(relativeKey)).toString('utf8');
  }

  async download(relativeKey, targetPath) {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.objectKey(relativeKey),
      }),
    );
    if (!result.Body) throw new Error(`RustFS 返回空对象体: ${relativeKey}`);
    const body = result.Body instanceof Readable ? result.Body : Readable.from(result.Body);
    await pipeline(body, fs.createWriteStream(targetPath));
  }

  async putFile(relativeKey, localPath, options = {}) {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: this.objectKey(relativeKey),
        Body: fs.createReadStream(localPath),
        ContentLength: fs.statSync(localPath).size,
        ContentType: options.contentType ?? contentTypeForReleaseFile(localPath),
        CacheControl: options.cacheControl ?? IMMUTABLE_CACHE_CONTROL,
        Metadata: options.metadata,
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  async putText(relativeKey, text, options = {}) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: this.objectKey(relativeKey),
        Body: Buffer.from(text, 'utf8'),
        ContentType: options.contentType ?? 'application/json; charset=utf-8',
        CacheControl: options.cacheControl ?? MUTABLE_CACHE_CONTROL,
        Metadata: options.metadata,
      }),
    );
  }
}

export function createMekaReleaseStorage(config) {
  return new MekaReleaseStorage(config);
}

export const RELEASE_CACHE_CONTROL = Object.freeze({
  immutable: IMMUTABLE_CACHE_CONTROL,
  mutable: MUTABLE_CACHE_CONTROL,
});
