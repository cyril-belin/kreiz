import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import type {
  ContentEntriesRepository,
} from '../data/repositories/content-entries.js';
import type { KreizContentEntry } from '../data/tables/content-entries.js';
import type { ContentTypeRegistry, ResolvedContentTypeDeclaration } from '../domain/content/registry.js';
import {
  ContentDeletedError,
  ContentNotFoundError,
} from '../domain/content/errors.js';
import { normalizeSlugInput, slugCandidates, slugify, SLUG_FALLBACK } from '../domain/content/slug.js';
import { resolveContentViewModel, type ContentView } from '../domain/content/view-model.js';

/**
 * Service contenu — orchestration du moteur (cadrage §6, mission §13).
 *
 * Responsabilités : résoudre le type déclaré, valider les données communes
 * (titre, slug) et spécifiques (schéma Zod strict dérivé des champs),
 * **imposer** le `route_namespace` depuis la déclaration (jamais depuis le
 * client), générer/vérifier les slugs, écrire via le repository, tracer
 * `created_by` / `updated_by` et écrire l'audit avec le vrai acteur admin.
 *
 * Il ne publie pas, n'appelle aucun service d'infrastructure (Vercel, R2),
 * ne crée pas de redirections (slice 4) et ne connaît pas les templates
 * Astro — il retourne des vues que les routes rendent avec le composant du
 * Project.
 */

/** Vocabulaire d'audit du moteur de contenu (mission §14). */
export const CONTENT_AUDIT_ACTIONS = {
  created: 'content.created',
  updated: 'content.updated',
  deleted: 'content.deleted',
} as const;

/** Longueur maximale du titre commun (colonne `title`, bornée anti-abus). */
export const CONTENT_TITLE_MAX_LENGTH = 300;

/** Erreurs de validation par champ (clé `_form` = message général). */
export type ContentFieldErrors = Record<string, string>;

export type ContentServiceDeps = {
  entries: ContentEntriesRepository;
  audit: AdminAuditLogRepository;
  /** Registre des types déclarés par le Project — injecté (jamais le module virtuel). */
  registry: ContentTypeRegistry;
};

/** Résultat d'une mutation de brouillon validée. */
export type ContentMutationOutcome =
  | { kind: 'created' | 'updated'; entry: KreizContentEntry; view: ContentView<unknown> }
  | { kind: 'invalid'; errors: ContentFieldErrors };

export type DeleteDraftOutcome = { kind: 'deleted'; entryId: string };

export type CreateDraftInput = {
  contentTypeKey: string;
  title: string;
  /** Optionnel à la création : vide ⇒ généré depuis le titre (avec suffixage). */
  slug?: string;
  /** Données spécifiques déjà structurées par le parseur de formulaire (whitelist). */
  data: Record<string, unknown>;
  /** Admin authentifié — vient du guard, jamais du formulaire. */
  actorAdminId: string;
};

export type UpdateDraftInput = {
  entryId: string;
  title: string;
  slug?: string;
  data: Record<string, unknown>;
  actorAdminId: string;
};

/** Code d'erreur PostgreSQL extrait d'une erreur Drizzle/driver. */
function pgErrorCode(error: unknown): string | null {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function createContentService(deps: ContentServiceDeps) {
  const { entries, audit, registry } = deps;

  function requireDeclaration(key: string): ResolvedContentTypeDeclaration {
    return registry.requireByKey(key);
  }

  function validateTitle(title: string, errors: ContentFieldErrors): string {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      errors.title = 'Le titre est requis.';
    } else if (trimmed.length > CONTENT_TITLE_MAX_LENGTH) {
      errors.title = `Le titre ne doit pas dépasser ${CONTENT_TITLE_MAX_LENGTH} caractères.`;
    }
    return trimmed;
  }

  /** Valide le JSONB spécifique contre le schéma strict du type déclaré. */
  function validateData(
    declaration: ResolvedContentTypeDeclaration,
    data: Record<string, unknown>,
    errors: ContentFieldErrors,
  ): Record<string, unknown> | null {
    const parsed = declaration.dataSchema.safeParse(data);
    if (parsed.success) return parsed.data as Record<string, unknown>;
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      const key = typeof field === 'string' ? field : '_form';
      errors[key] ??= contentFieldErrorMessage(issue);
    }
    return null;
  }

  async function auditContentEvent(
    action: (typeof CONTENT_AUDIT_ACTIONS)[keyof typeof CONTENT_AUDIT_ACTIONS],
    entry: KreizContentEntry,
    actorAdminId: string,
  ): Promise<void> {
    await audit.append({
      actorAdminId,
      action,
      entityType: 'content_entry',
      entityId: entry.id,
      metadata: { contentType: entry.contentType, slug: entry.slug },
    });
  }

  return {
    /** Registre résolu des types déclarés — les routes y retrouvent leurs déclarations. */
    registry,

    /**
     * Crée un brouillon. Le namespace vient **exclusivement** de la
     * déclaration (le client ne peut pas en imposer un autre) ; le statut
     * est `draft` (le Publish appartient au slice 4) ; le slug vide est
     * généré depuis le titre avec suffixage automatique, un slug saisi
     * manuellement en collision est une erreur de validation.
     */
    async createDraft(
      input: CreateDraftInput,
      options: { now?: Date } = {},
    ): Promise<ContentMutationOutcome> {
      const declaration = requireDeclaration(input.contentTypeKey);
      const now = options.now ?? new Date();
      const errors: ContentFieldErrors = {};

      const title = validateTitle(input.title, errors);
      const data = validateData(declaration, input.data, errors);

      const manualSlug = Boolean(input.slug && input.slug.trim().length > 0);
      const slugBase = manualSlug ? normalizeSlugInput(input.slug as string) : slugify(title) || SLUG_FALLBACK;
      if (manualSlug && slugBase.length === 0) {
        errors.slug = 'Slug invalide — lettres minuscules, chiffres et tirets uniquement.';
      }

      if (Object.keys(errors).length > 0 || data === null) {
        return { kind: 'invalid', errors };
      }

      const namespace = declaration.routeNamespace;
      const existsInNamespace = async (slug: string) =>
        entries.slugExistsInNamespace(namespace, slug);

      // Slug manuel : vérification explicite (le suffixage n'est réservé
      // qu'aux slugs générés). Slug généré : premier candidat libre.
      if (manualSlug && (await existsInNamespace(slugBase))) {
        return {
          kind: 'invalid',
          errors: { slug: 'Ce slug est déjà utilisé pour ce type de contenu.' },
        };
      }

      const candidates = manualSlug ? [slugBase] : undefined;
      let lastError: unknown = null;
      for (const candidate of candidates ?? slugCandidates(slugBase)) {
        if (!manualSlug && (await existsInNamespace(candidate))) continue;
        try {
          const entry = await entries.create({
            contentType: declaration.key,
            routeNamespace: namespace,
            title,
            slug: candidate,
            status: 'draft',
            data,
            createdBy: input.actorAdminId,
            updatedBy: input.actorAdminId,
            createdAt: now,
            updatedAt: now,
          });
          await auditContentEvent(CONTENT_AUDIT_ACTIONS.created, entry, input.actorAdminId);
          return { kind: 'created', entry, view: resolveContentViewModel(declaration, entry) };
        } catch (error) {
          // Course concurrentielle sur l'index unique partiel : candidat
          // suivant pour un slug généré, erreur de validation pour un slug
          // saisi à la main.
          if (pgErrorCode(error) === '23505') {
            lastError = error;
            if (manualSlug) break;
            continue;
          }
          throw error;
        }
      }
      if (manualSlug) {
        return {
          kind: 'invalid',
          errors: { slug: 'Ce slug est déjà utilisé pour ce type de contenu.' },
        };
      }
      throw new Error(
        `@kreiz/core : aucun slug disponible pour « ${slugBase} » dans « ${namespace} » (${String(lastError)}).`,
      );
    },

    /**
     * Met à jour un brouillon (titre, slug, champs du type). Le type et le
     * namespace de l'entrée ne sont jamais modifiables ; la déclaration est
     * résolue depuis **l'entrée** (source de vérité en base). Un slug
     * modifié en collision est une erreur — aucun suffixage implicite, et
     * aucune redirection (slice 4, ce slice ne publie pas).
     */
    async updateDraft(
      input: UpdateDraftInput,
      options: { now?: Date } = {},
    ): Promise<ContentMutationOutcome> {
      const now = options.now ?? new Date();
      const existing = await entries.findById(input.entryId);
      if (!existing) {
        throw new ContentNotFoundError(input.entryId);
      }
      if (existing.deletedAt) {
        throw new ContentDeletedError(input.entryId);
      }
      const declaration = requireDeclaration(existing.contentType);
      const errors: ContentFieldErrors = {};

      const title = validateTitle(input.title, errors);
      const data = validateData(declaration, input.data, errors);

      let slug = existing.slug;
      if (input.slug !== undefined) {
        const normalized = normalizeSlugInput(input.slug);
        if (normalized.length === 0) {
          errors.slug = 'Slug invalide — lettres minuscules, chiffres et tirets uniquement.';
        } else if (
          normalized !== existing.slug &&
          (await entries.slugExistsInNamespace(declaration.routeNamespace, normalized, {
            excludeId: existing.id,
          }))
        ) {
          errors.slug = 'Ce slug est déjà utilisé pour ce type de contenu.';
        } else {
          slug = normalized;
        }
      }

      if (Object.keys(errors).length > 0 || data === null) {
        return { kind: 'invalid', errors };
      }

      try {
        const updated = await entries.updateDraft(existing.id, {
          title,
          slug,
          data,
          updatedBy: input.actorAdminId,
          updatedAt: now,
        });
        if (!updated) {
          // Supprimé entre la lecture et l'écriture.
          throw new ContentDeletedError(input.entryId);
        }
        await auditContentEvent(CONTENT_AUDIT_ACTIONS.updated, updated, input.actorAdminId);
        return { kind: 'updated', entry: updated, view: resolveContentViewModel(declaration, updated) };
      } catch (error) {
        // Course concurrentielle : le slug a été pris entre la vérification
        // et l'écriture — erreur de validation, jamais un 23505 brut.
        if (pgErrorCode(error) === '23505') {
          return {
            kind: 'invalid',
            errors: { slug: 'Ce slug est déjà utilisé pour ce type de contenu.' },
          };
        }
        throw error;
      }
    },

    /**
     * Listing actif d'un type (brouillons et publiés, hors supprimés) pour
     * l'admin. Lève `UnknownContentTypeError` sur une clé non déclarée —
     * l'URL `/admin/content/[type]` ne fait jamais foi seule.
     */
    async listContent(contentTypeKey: string): Promise<KreizContentEntry[]> {
      const declaration = requireDeclaration(contentTypeKey);
      return entries.listByType(declaration.key);
    },

    /**
     * Charge une entrée pour édition/preview : entrée non supprimée,
     * déclaration résolue depuis son `content_type` (jamais depuis l'URL),
     * données validées par le schéma du type. Lève `ContentNotFoundError`,
     * `ContentDeletedError` ou `ContentDataCorruptedError` /
     * `UnknownContentTypeError` — jamais de rendu silencieux d'un contenu
     * invalide (mission §4).
     */
    async getContentForEdit(entryId: string): Promise<{
      entry: KreizContentEntry;
      declaration: ResolvedContentTypeDeclaration;
      view: ContentView<unknown>;
    }> {
      const entry = await entries.findById(entryId);
      if (!entry) {
        throw new ContentNotFoundError(entryId);
      }
      if (entry.deletedAt) {
        throw new ContentDeletedError(entryId);
      }
      const declaration = requireDeclaration(entry.contentType);
      return { entry, declaration, view: resolveContentViewModel(declaration, entry) };
    },

    /** Alias sémantique de la preview — mêmes garanties que l'édition. */
    async getContentForPreview(
      entryId: string,
    ): Promise<{
      entry: KreizContentEntry;
      declaration: ResolvedContentTypeDeclaration;
      view: ContentView<unknown>;
    }> {
      return this.getContentForEdit(entryId);
    },

    /**
     * Soft delete (mission §24) : `deleted_at = now`, audit
     * `content.deleted` avec le vrai acteur, slug libéré par l'index
     * unique partiel. Aucune purge physique.
     */
    async deleteDraft(
      input: { entryId: string; actorAdminId: string },
      options: { now?: Date } = {},
    ): Promise<DeleteDraftOutcome> {
      const now = options.now ?? new Date();
      const existing = await entries.findById(input.entryId);
      if (!existing) {
        throw new ContentNotFoundError(input.entryId);
      }
      if (existing.deletedAt) {
        throw new ContentDeletedError(input.entryId);
      }
      const deleted = await entries.softDelete(input.entryId, {
        deletedAt: now,
        updatedBy: input.actorAdminId,
      });
      if (!deleted) {
        throw new ContentDeletedError(input.entryId);
      }
      await auditContentEvent(CONTENT_AUDIT_ACTIONS.deleted, deleted, input.actorAdminId);
      return { kind: 'deleted', entryId: deleted.id };
    },
  };
}

export type ContentService = ReturnType<typeof createContentService>;

/**
 * Message d'erreur français, prêt à afficher, pour une issue Zod du schéma
 * de données. Mapping local (pas de locale globale mutée à l'import) : le
 * vocabulaire des issues est borné par les schémas dérivés.
 */
export function contentFieldErrorMessage(issue: {
  code: string;
  path: PropertyKey[];
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  format?: string;
}): string {
  switch (issue.code) {
    case 'unrecognized_keys':
      return 'Champ non autorisé.';
    case 'too_small': {
      if (issue.minimum === 1 && issue.origin === 'string') return 'Ce champ est requis.';
      const unit = issue.origin === 'array' ? 'éléments' : 'caractères';
      return `Doit contenir au moins ${String(issue.minimum)} ${unit}.`;
    }
    case 'too_big': {
      const unit = issue.origin === 'array' ? 'éléments' : 'caractères';
      return `Doit contenir au plus ${String(issue.maximum)} ${unit}.`;
    }
    case 'invalid_format': {
      if (issue.format === 'url') return 'URL invalide (lien http(s) absolu attendu).';
      if (issue.format === 'date') return 'Date invalide (format AAAA-MM-JJ attendu).';
      return issue.message;
    }
    case 'invalid_value':
      return 'Choix invalide.';
    default:
      return issue.message;
  }
}

// Ré-export des erreurs de domaine — les routes n'importent que le service.
export {
  ContentDataCorruptedError,
  ContentDeletedError,
  ContentNotFoundError,
  UnknownContentTypeError,
} from '../domain/content/errors.js';
