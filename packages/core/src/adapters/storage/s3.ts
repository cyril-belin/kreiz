import { assertSafeS3Key, presignedPutUrl, signedRequestHeaders, type SigV4Config } from './sigv4.js';
import type {
  ObjectStorage,
  PresignedUpload,
  StoragePutInput,
  StoredObjectHead,
} from '../../ports/storage.js';

/**
 * Adapter **ObjectStorage S3-compatible** de référence (mission §8 ; cadrage
 * §11) — fonctionne avec Cloudflare R2, AWS S3 et MinIO (style *path* :
 * `endpoint/bucket/key`, le mode commun à ces trois providers).
 *
 * - Le secret n'existe que dans l'environnement runtime du Project
 *   (`KREIZ_STORAGE_*` validées dans `http/server-env.ts`) : jamais dans le
 *   module virtuel, le HTML, les logs ni le client JS (mission §8).
 * - Upload direct : `presignUpload` produit une URL PUT limitée à une clé,
 *   courte durée (10 min, mission §9), content-type figé — le navigateur
 *   parle **directement** au stockage, jamais via le serveur Astro.
 * - Lectures/écritures serveur (head/get/put/delete) : requêtes SigV4
 *   header-signées (voir `sigv4.ts`).
 * - URL publique : simple concaténation `publicBaseUrl + '/' + key` — pas
 *   d'URL signée expirante dans le HTML statique (mission §39).
 * - Toutes les erreurs réseau/HTTP sont **typées et assainies** : la couche
 *   appelante reçoit un résultat exploitable, jamais une pile ni la config.
 */

export interface S3ObjectStorageOptions {
  /** Ex. `https://<account>.r2.cloudflarestorage.com` ou `http://127.0.0.1:9000`. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `auto` pour R2 ; défaut `us-east-1`. */
  region?: string;
  /** Base publique des variantes (CDN/bucket public) — ex. `https://cdn.example.com/media-bucket`. */
  publicBaseUrl: string;
  /** Injection pour les tests — défaut : fetch global. */
  fetchFn?: typeof fetch;
  /** Défaut : 10 s — une erreur de stockage ne doit pas bloquer une requête admin. */
  timeoutMs?: number;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly config: SigV4Config;
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly publicBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: S3ObjectStorageOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new Error(
        '@kreiz/core : KREIZ_STORAGE_ENDPOINT invalide — une URL absolue de endpoint S3 est attendue.',
      );
    }
    this.endpoint = endpoint;
    this.bucket = options.bucket;
    this.config = {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      region: options.region ?? 'us-east-1',
      service: 's3',
    };
    this.publicBase = `${options.publicBaseUrl.trim().replace(/\/+$/, '')}`;
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** URL path-style d'une clé : `endpoint/bucket/key`. */
  private objectUrlFor(key: string): URL {
    assertSafeS3Key(key);
    const prefix = this.endpoint.pathname.replace(/\/+$/, '');
    return new URL(`${prefix}/${this.bucket}/${key}`, this.endpoint);
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const response = await this.request('HEAD', key);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`@kreiz/core : head storage en échec (statut ${response.status}).`);
    }
    const contentLength = response.headers.get('content-length');
    const contentType = response.headers.get('content-type');
    return {
      sizeBytes: contentLength !== null ? Number(contentLength) : 0,
      contentType: contentType && contentType.length > 0 ? contentType : null,
    };
  }

  async read(key: string): Promise<Uint8Array | null> {
    const response = await this.request('GET', key);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`@kreiz/core : lecture storage en échec (statut ${response.status}).`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async put(input: StoragePutInput): Promise<void> {
    const response = await this.request('PUT', input.key, {
      headers: {
        'content-type': input.contentType,
        ...(input.cacheControl ? { 'cache-control': input.cacheControl } : {}),
      },
      body: input.body,
    });
    if (!response.ok) {
      throw new Error(`@kreiz/core : écriture storage en échec (statut ${response.status}).`);
    }
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    // Suppressions unitaires, tolérantes aux objets absents (204/404 = ok).
    // Pas de batch POST ?delete en V1 : les volumes par média sont minuscules.
    for (const key of keys) {
      const response = await this.request('DELETE', key);
      if (!response.ok && response.status !== 404) {
        throw new Error(`@kreiz/core : suppression storage en échec (statut ${response.status}).`);
      }
    }
  }

  publicUrl(key: string): string {
    assertSafeS3Key(key);
    return `${this.publicBase}/${key}`;
  }

  async presignUpload(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    const url = this.objectUrlFor(input.key);
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    const signedUrl = presignedPutUrl(this.config, {
      url,
      contentType: input.contentType,
      expiresInSeconds: input.expiresInSeconds,
    });
    return {
      url: signedUrl,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt,
    };
  }

  private async request(
    method: 'HEAD' | 'GET' | 'PUT' | 'DELETE',
    key: string,
    options: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<Response> {
    const url = this.objectUrlFor(key);
    const headers = signedRequestHeaders(this.config, {
      method,
      host: url.host,
      path: url.pathname,
    });
    return this.fetchFn(url, {
      method,
      headers: { ...headers, ...(options.headers ?? {}) },
      ...(options.body ? { body: new Blob([new Uint8Array(options.body)]) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

/**
 * Composition courante depuis l'environnement validé (voir
 * `http/server-env.ts`) — l'application ne construit jamais l'adapter
 * à la main depuis des chaînes dispersées.
 */
export function createS3ObjectStorage(options: S3ObjectStorageOptions): S3ObjectStorage {
  return new S3ObjectStorage(options);
}
