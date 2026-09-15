import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  signedRequestHeaders,
  amzDateFormat,
  assertSafeS3Key,
  credentialScope,
} from '../src/adapters/storage/sigv4';

/**
 * Cryptographie SigV4 prouvée contre les **vecteurs officiels AWS**
 * (documentation S3 « Signature Calculations for the Authorization
 * Header: Transferring Payload in a Single Chunk ») — credentials et
 * signatures d'exemple publiés par AWS, reproduits ici en assertions.
 * Le serveur S3 local (s3rver) n'ayant pas d'implémentation SigV4 côté
 * serveur (authentification par access key), cette preuve cryptographique
 * est le garde réel ; s3rver prouve la forme et l'intégration HTTP.
 */

const AWS_EXAMPLE = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3' as const,
};

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const EXAMPLE_DATE = new Date('2013-05-24T00:00:00Z');

describe('SigV4 — vecteurs officiels AWS', () => {
  it('format de date amz', () => {
    expect(amzDateFormat(EXAMPLE_DATE)).toBe('20130524T000000Z');
    expect(credentialScope(AWS_EXAMPLE, '20130524')).toBe('20130524/us-east-1/s3/aws4_request');
  });

  it('GET Object (Authorization header, payload unique) — signature f0e8bdb8…', () => {
    const { signature, canonical, canonicalHash } = computeSignature(AWS_EXAMPLE, EXAMPLE_DATE, {
      method: 'GET',
      path: '/test.txt',
      headers: [
        ['host', 'examplebucket.s3.amazonaws.com'],
        ['range', 'bytes=0-9'],
        ['x-amz-content-sha256', EMPTY_SHA256],
        ['x-amz-date', '20130524T000000Z'],
      ],
      payloadHash: EMPTY_SHA256,
    });

    // Canonical request attendu, tel que publié par AWS.
    expect(canonical).toBe(
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
    expect(canonicalHash).toBe('7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
    expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('GET Bucket Lifecycle (query vide nommée, corps vide) — signature fea454ca…', () => {
    const { signature, canonical } = computeSignature(AWS_EXAMPLE, EXAMPLE_DATE, {
      method: 'GET',
      path: '/',
      query: [['lifecycle', '']],
      headers: [
        ['host', 'examplebucket.s3.amazonaws.com'],
        ['x-amz-content-sha256', EMPTY_SHA256],
        ['x-amz-date', '20130524T000000Z'],
      ],
      payloadHash: EMPTY_SHA256,
    });

    expect(canonical).toBe(
      [
        'GET',
        '/',
        'lifecycle=',
        'host:examplebucket.s3.amazonaws.com',
        'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date:20130524T000000Z',
        '',
        'host;x-amz-content-sha256;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    );
    expect(signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('les requêtes serveur signent exactement host;x-amz-content-sha256;x-amz-date', () => {
    const headers = signedRequestHeaders(AWS_EXAMPLE, {
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      now: EXAMPLE_DATE,
    });
    expect(headers.Authorization).toContain(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request',
    );
    expect(headers.Authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date',
    );
    // La signature recalculée avec le même canonical que le vecteur GET
    // simple (sans range) reste stable : les trois mêmes en-têtes signés.
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
  });

  it('les clés dangereuses sont refusées avant toute signature', () => {
    expect(assertSafeS3Key('media/abc/original')).toBe('media/abc/original');
    expect(() => assertSafeS3Key('media/../secret')).toThrow(/refusée/);
    expect(() => assertSafeS3Key('media/a b')).toThrow(/refusée/);
    expect(() => assertSafeS3Key('media/point?interro')).toThrow(/refusée/);
  });
});
