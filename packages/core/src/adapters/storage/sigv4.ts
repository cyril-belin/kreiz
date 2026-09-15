import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 — implémentation **minimale confinée à
 * l'adapter S3** (mission §7 : le cœur métier n'importe jamais un SDK
 * provider). Uniquement ce dont Kreiz a besoin :
 *
 * - requêtes header-signées (GET/HEAD/PUT/DELETE) avec payload
 *   `UNSIGNED-PAYLOAD` — accepté par S3 (HTTPS), Cloudflare R2 et MinIO ;
 * - URLs présignées **PUT** (`X-Amz-Expires` court, `host;content-type`
 *   signés — le navigateur doit envoyer exactement le content-type signé).
 *
 * Décision assumée : pas de SDK AWS en dépendance du Core (arbre lourd,
 * surface de supply chain, bundle serverless) pour quatre verbes dont les
 * clés générées (`media/{uuid}/…`) sont restreintes à un jeu de caractères
 * sûr — l'adapter **refuse** toute clé contenant un caractère qui nécessite
 * un encodage, ce qui rend les canonicals triviaux et sans zone grise.
 * Le comportement est prouvé contre un serveur S3 réel en test.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** Clé d'objet autorisée : rien qui exige un encodage d'URL. */
export const SAFE_S3_KEY_PATTERN = /^[a-z0-9][a-z0-9-_.\/]*$/;

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Encodage query strict RFC 3986 (encodeURIComponent n'échappe pas ! ' ( ) *). */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function assertSafeS3Key(key: string): string {
  if (!SAFE_S3_KEY_PATTERN.test(key) || key.includes('..')) {
    throw new Error(
      `@kreiz/core : clé de stockage refusée par l'adapter S3 (caractères non sûrs) « ${key} ».`,
    );
  }
  return key;
}

export interface SigV4Config {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

/** Date de signature au format `YYYYMMDDTHHMMSSZ`. */
export function amzDateFormat(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

interface CanonicalRequestInput {
  method: string;
  /** Chemin path-style déjà sûr (`/bucket/key`) — encodage identité. */
  path: string;
  /** Paires query à signer (presign) — triées par clé par le constructeur. */
  query?: Array<[string, string]>;
  /** En-têtes canoniques (nom déjà minuscule) — triés par nom. */
  headers: Array<[string, string]>;
  payloadHash: string;
}

function canonicalRequest(input: CanonicalRequestInput): string {
  const query = [...(input.query ?? [])].sort(
    ([aKey, aValue], [bKey, bValue]) =>
      aKey < bKey ? -1 : aKey > bKey ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0,
  );
  const canonicalQuery = query
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&');
  const sortedHeaders = [...input.headers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = sortedHeaders.map(([name, value]) => `${name}:${value.trim()}\n`).join('');
  const signedHeaders = sortedHeaders.map(([name]) => name).join(';');
  return [
    input.method,
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
}

function signingKey(config: SigV4Config, dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, config.service ?? 's3');
  return hmac(kService, 'aws4_request');
}

/** Construit la portée de credential `date/region/s3/aws4_request`. */
export function credentialScope(config: SigV4Config, dateStamp: string): string {
  return `${dateStamp}/${config.region}/${config.service ?? 's3'}/aws4_request`;
}

/**
 * Signature partagée d'une requête (header ou query) — retourne la
 * signature hex et les éléments de contexte. Exportée pour être prouvée
 * contre les **vecteurs officiels AWS** (tests) : c'est la fonction qui
 * porte toute la cryptographie de l'adapter.
 */
export function computeSignature(
  config: SigV4Config,
  now: Date,
  input: Omit<CanonicalRequestInput, 'payloadHash'> & { payloadHash?: string },
): { amzDate: string; scope: string; signature: string; canonical: string; canonicalHash: string } {
  const amzDate = amzDateFormat(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = credentialScope(config, dateStamp);
  const canonical = canonicalRequest({
    ...input,
    payloadHash: input.payloadHash ?? 'UNSIGNED-PAYLOAD',
  });
  const canonicalHash = sha256Hex(canonical);
  const stringToSign = [ALGORITHM, amzDate, scope, canonicalHash].join('\n');
  const signature = createHmac('sha256', signingKey(config, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return { amzDate, scope, signature, canonical, canonicalHash };
}

/**
 * En-têtes d'une requête serveur signée (Authorization header). Le payload
 * est déclaré `UNSIGNED-PAYLOAD` : valide en HTTPS chez S3/R2/MinIO, et
 * évite de hacher des corps jusqu'à 20 Mo pour rien.
 */
export function signedRequestHeaders(
  config: SigV4Config,
  options: {
    method: string;
    host: string;
    path: string;
    now?: Date;
  },
): Record<string, string> {
  const now = options.now ?? new Date();
  const amzDate = amzDateFormat(now);
  const { scope, signature } = computeSignature(config, now, {
    method: options.method,
    path: options.path,
    headers: [
      ['host', options.host],
      ['x-amz-content-sha256', 'UNSIGNED-PAYLOAD'],
      ['x-amz-date', amzDate],
    ],
  });
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': amzDate,
  };
}

/**
 * URL présignée **PUT** (mission §9) : courte durée, une clé exacte,
 * `host;content-type` signés — le navigateur doit envoyer exactement le
 * content-type signé (tout autre valeur reçoit un 403 du stockage), et
 * l'URL ne porte aucun autre droit (pas de list, pas de delete, pas de lecture).
 */
export function presignedPutUrl(
  config: SigV4Config,
  options: {
    /** URL absolue du PUT (endpoint + bucket + clé). */
    url: URL;
    contentType: string;
    expiresInSeconds: number;
    now?: Date;
  },
): string {
  const now = options.now ?? new Date();
  const amzDate = amzDateFormat(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = credentialScope(config, dateStamp);
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${config.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(options.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host;content-type'],
  ];
  const { signature } = computeSignature(config, now, {
    method: 'PUT',
    path: options.url.pathname,
    query,
    headers: [
      ['host', options.url.host],
      ['content-type', options.contentType],
    ],
  });
  const encodedQuery = [
    ...query.map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`),
    `X-Amz-Signature=${signature}`,
  ].join('&');
  return `${options.url.origin}${options.url.pathname}?${encodedQuery}`;
}
