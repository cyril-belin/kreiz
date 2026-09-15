import { mediaOriginalKey, mediaVariantKey } from '../domain/media/keys.js';

/**
 * Port de stockage objet (mission §7 ; cadrage §5, §6, §11) — contrat du
 * domaine média, indépendant de tout provider. Le cœur métier n'importe
 * **jamais** le SDK AWS, un client R2 ou MinIO : il ne voit que cette
 * interface, portée par l'adapter S3-compatible de référence
 * (`adapters/storage/s3.ts`) ou un adapter de test.
 *
 * Décisions V1 portées par le contrat :
 * - **original privé** : seule la paire `{ key, publicUrl }` des **variantes**
 *   peut être résolue publiquement — aucun `publicUrl` n'existe pour
 *   l'original (mission §42/§43) ;
 * - lecture bornée : `read` charge l'objet complet (images ≤ 20 Mo — pas de
 *   streaming en V1, le transformer décode un buffer) ;
 * - les écritures de variantes portent un `cacheControl` explicite
 *   (immuable, mission §40).
 */

/** Métadonnées minimales d'un objet existant (`head`). */
export interface StoredObjectHead {
  sizeBytes: number;
  /** Content-Type constaté côté stockage (peut être `null` chez certains providers). */
  contentType: string | null;
}

/** URL d'upload direct navigateur → stockage (mission §3, §9). */
export interface PresignedUpload {
  /** URL absolue — le navigateur exécute `PUT` avec les en-têtes exigés. */
  url: string;
  method: 'PUT';
  /** En-têtes que la signature impose (ex. content-type figé). */
  headers: Record<string, string>;
  /** Expiration — courte durée (10 min, mission §9). */
  expiresAt: Date;
}

/** Demande d'écriture côté serveur (variantes). */
export interface StoragePutInput {
  key: string;
  body: Uint8Array;
  contentType: string;
  /** Ex. `public, max-age=31536000, immutable` pour les variantes. */
  cacheControl?: string;
}

export interface ObjectStorage {
  /**
   * Présigne un **upload PUT** limité à une clé exacte : courte durée,
   * aucun droit général (pas de list, pas de delete), content-type figé
   * dans la signature. Jamais appelée depuis une route publique (mission §37).
   */
  presignUpload(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<PresignedUpload>;

  /** Statut d'un objet, ou `null` s'il n'existe pas — vérification post-upload (mission §10). */
  head(key: string): Promise<StoredObjectHead | null>;

  /** Lit l'objet complet, ou `null` s'il n'existe pas — entrée du transformer. */
  read(key: string): Promise<Uint8Array | null>;

  /** Écrit un objet (variantes transformées). */
  put(input: StoragePutInput): Promise<void>;

  /** Supprime une liste de clés — best effort, tolère les objets absents. */
  deleteMany(keys: readonly string[]): Promise<void>;

  /**
   * URL publique d'une clé de **variante** — construction locale (CDN/bucket
   * public configuré côté serveur), jamais une URL signée expirante
   * (mission §39). Les clés d'original ne sont jamais passées ici.
   */
  publicUrl(key: string): string;
}

/** Clés de variantes par défaut — factorisation utilisée par les services. */
export { mediaOriginalKey, mediaVariantKey };
