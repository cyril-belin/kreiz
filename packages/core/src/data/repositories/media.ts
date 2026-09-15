import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { KreizDatabase } from '../connection.js';
import { contentEntries } from '../tables/content-entries.js';
import {
  media,
  type KreizMedia,
  type KreizMediaInsert,
  type KreizMediaStatus,
  type KreizMediaVariant,
} from '../tables/media.js';

/**
 * Repository du domaine médias (mission §24) — primitives d'état gardées,
 * jamais de CRUD générique.
 *
 * Les transitions `markProcessing` / `markReady` / `markFailed` portent la
 * machine à états **dans le WHERE** (`UPDATE … WHERE status IN (…)`) :
 * sous double confirmation ou double job concurrent, une seule écriture
 * réussit, l'autre retourne `null` — la décision d'interprétation
 * (idempotence, erreur) appartient au service (mission §11).
 *
 * Suppression : physique, réservée aux médias **non référencés** (mission
 * §26) — la FK `cover_media_id → RESTRICT` protège de toute façon
 * l'écrasement par effet de bord ; le service vérifie l'usage avant d'appeler
 * `deletePhysical` (un média référencé est refusé, jamais supprimé en
 * silence). Les contenus soft-deleted continuent de compter comme usage
 * (mission §46) : la vérification regarde la table entière, pas seulement
 * les lignes actives.
 *
 * Le SQL brut (`db.execute`) n'apparaît que dans les tests.
 */
/** Format UUID v4-ish — les colonnes sont uuid : un id non conforme produit
 * sinon une 22P02 PostgreSQL brute au lieu d'un simple « introuvable ». */
export const MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMediaRepository(db: KreizDatabase) {
  return {
    /** Crée la ligne d'un upload demandé (statut `uploading`). L'id est fourni par le service : la clé storage en dérive. */
    async createUploading(values: KreizMediaInsert): Promise<KreizMedia> {
      const rows = await db
        .insert(media)
        .values({ ...values, status: 'uploading' satisfies KreizMediaStatus })
        .returning();
      const row = rows.at(0);
      if (!row) {
        throw new Error('@kreiz/core : media.createUploading() n’a retourné aucune ligne.');
      }
      return row;
    },

    findById(id: string): Promise<KreizMedia | null> {
      // Garde à la frontière Drizzle : un id non UUID est « introuvable »,
      // jamais une erreur SQL brute (22P02) remontée aux routes.
      if (!MEDIA_ID_PATTERN.test(id)) return Promise.resolve(null);
      return db
        .select()
        .from(media)
        .where(eq(media.id, id))
        .limit(1)
        .then((rows) => rows.at(0) ?? null);
    },

    /**
     * `uploading → processing` (confirmation) et `failed → processing`
     * (retry/récupération) — retourne `null` si le média n'est pas dans un
     * état source valide (double confirm, retry concurrent…).
     */
    async markProcessing(
      id: string,
      patch: { mime?: string; sizeBytes?: number; updatedAt: Date },
    ): Promise<KreizMedia | null> {
      const rows = await db
        .update(media)
        .set({
          status: 'processing',
          failureReason: null,
          ...(patch.mime !== undefined ? { mime: patch.mime } : {}),
          ...(patch.sizeBytes !== undefined ? { sizeBytes: patch.sizeBytes } : {}),
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(media.id, id), inArray(media.status, ['uploading', 'failed'])))
        .returning();
      return rows.at(0) ?? null;
    },

    /**
     * `processing → ready` avec dimensions et variantes produites. L'objet
     * retourné est la source de vérité du rendu public.
     */
    async markReady(
      id: string,
      patch: { width: number; height: number; variants: KreizMediaVariant[]; updatedAt: Date },
    ): Promise<KreizMedia | null> {
      const rows = await db
        .update(media)
        .set({
          status: 'ready',
          width: patch.width,
          height: patch.height,
          variants: patch.variants,
          failureReason: null,
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(media.id, id), eq(media.status, 'processing')))
        .returning();
      return rows.at(0) ?? null;
    },

    /**
     * `processing|uploading → failed` avec une raison **courte et
     * stable** (code machine, mission §21) — jamais une stack trace.
     */
    async markFailed(
      id: string,
      patch: { failureReason: string; updatedAt: Date },
    ): Promise<KreizMedia | null> {
      const rows = await db
        .update(media)
        .set({
          status: 'failed',
          failureReason: patch.failureReason.slice(0, 200),
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(media.id, id), inArray(media.status, ['uploading', 'processing'])))
        .returning();
      return rows.at(0) ?? null;
    },

    /** Alt text (mission §16) — saisi par l'admin, borné par le domaine. */
    async updateAlt(
      id: string,
      patch: { altText: string; updatedAt: Date },
    ): Promise<KreizMedia | null> {
      const rows = await db
        .update(media)
        .set({ altText: patch.altText, updatedAt: patch.updatedAt })
        .where(and(eq(media.id, id), isNull(media.deletedAt)))
        .returning();
      return rows.at(0) ?? null;
    },

    /** Médias `ready` actifs — pickers et formulaires de couverture. */
    listReady(limit = 200): Promise<KreizMedia[]> {
      return db
        .select()
        .from(media)
        .where(and(eq(media.status, 'ready'), isNull(media.deletedAt)))
        .orderBy(desc(media.createdAt))
        .limit(limit);
    },

    /** Médias actifs tous statuts — listing admin. */
    listAdmin(limit = 200): Promise<KreizMedia[]> {
      return db
        .select()
        .from(media)
        .where(isNull(media.deletedAt))
        .orderBy(desc(media.createdAt))
        .limit(limit);
    },

    /** Lecture batch pour le lecteur public de build — résolution des couvertures. */
    listReadyByIds(ids: readonly string[]): Promise<KreizMedia[]> {
      if (ids.length === 0) return Promise.resolve([]);
      return db
        .select()
        .from(media)
        .where(and(inArray(media.id, [...ids]), eq(media.status, 'ready'), isNull(media.deletedAt)));
    },

    /**
     * Nombre de contenus (y compris soft-deleted — mission §46) référençant
     * le média comme couverture. La FK RESTRICT protège l'intégrité ; ce
     * comptage donne le **message admin** explicite (mission §26).
     */
    async countCoverReferences(mediaId: string): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(contentEntries)
        .where(
          sql`(${contentEntries.coverMediaId} = ${mediaId} or ${contentEntries.publishedCoverMediaId} = ${mediaId})`,
        );
      return rows.at(0)?.count ?? 0;
    },

    /**
     * Nombre de contenus (y compris soft-deleted) référençant le média dans
     * un **corps rich text** (slice 6) — champ `mediaId` d'un node média,
     * état éditorial courant ou snapshot publié. Requête JSONB structurelle
     * (`jsonb_path_exists` + descente récursive `$.**.mediaId`) : pas de
     * recherche texte naïve — la même définition de « référence » que
     * `extractRichTextMediaIds` (toute profondeur de listes/citations).
     * Aucune FK possible dans du JSONB : ce comptage est la seule garde,
     * en complément du refus explicite côté service.
     */
    async countRichTextReferences(mediaId: string): Promise<number> {
      const params = sql`jsonb_build_object('id', ${mediaId}::text)`;
      const path = sql.raw("'lax $.**.mediaId ? (@ == $id)'");
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(contentEntries)
        .where(
          sql`(jsonb_path_exists(${contentEntries.data}, ${path}, ${params}) or jsonb_path_exists(${contentEntries.publishedData}, ${path}, ${params}))`,
        );
      return rows.at(0)?.count ?? 0;
    },

    /**
     * Usage total d'un média — couverture (courante ou snapshot) **plus**
     * références rich text (courantes ou snapshot). Une seule question :
     * « ce média est-il utilisé ? » — la réponse ne doit jamais dépendre de
     * l'endroit où la référence vit (slice 6 §13).
     */
    async countContentReferences(mediaId: string): Promise<number> {
      const [cover, richText] = await Promise.all([
        this.countCoverReferences(mediaId),
        this.countRichTextReferences(mediaId),
      ]);
      return cover + richText;
    },

    /**
     * Suppression physique d'un média **non référencé** (mission §26) :
     * la ligne part, les objets storage sont supprimés par le service.
     * Un média référencé provoque une 23001 (RESTRICT) — le service ne
     * l'appelle qu'après `countCoverReferences() === 0`.
     */
    async deletePhysical(id: string): Promise<boolean> {
      if (!MEDIA_ID_PATTERN.test(id)) return false;
      const rows = await db.delete(media).where(eq(media.id, id)).returning();
      return rows.length > 0;
    },

    /** `processing` trop ancien — balayage de récupération (mission §20). */
    findStuckProcessing(olderThan: Date, limit = 50): Promise<KreizMedia[]> {
      return db
        .select()
        .from(media)
        .where(and(eq(media.status, 'processing'), lt(media.updatedAt, olderThan)))
        .orderBy(media.updatedAt)
        .limit(limit);
    },

    /** `failed` actifs — reprise manuelle ou balayage futur. */
    listFailed(limit = 50): Promise<KreizMedia[]> {
      return db
        .select()
        .from(media)
        .where(and(eq(media.status, 'failed'), isNull(media.deletedAt)))
        .orderBy(desc(media.updatedAt))
        .limit(limit);
    },
  };
}

export type MediaRepository = ReturnType<typeof createMediaRepository>;
