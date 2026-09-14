import { createNoopRebuildTrigger } from '../ports/rebuild.js';
import type {
  RebuildRequestReason,
  RebuildTrigger,
  RebuildTriggerResult,
} from '../ports/rebuild.js';
import type { AdminAuditLogRepository } from '../data/repositories/admin-audit-log.js';
import type {
  ContentEntriesRepository,
} from '../data/repositories/content-entries.js';
import type { RedirectsRepository } from '../data/repositories/redirects.js';
import type { KreizContentEntry } from '../data/tables/content-entries.js';
import type { ContentTypeRegistry, ResolvedContentTypeDeclaration } from '../domain/content/registry.js';
import {
  ContentDeletedError,
  ContentNotFoundError,
  PublishedPathOccupiedError,
} from '../domain/content/errors.js';
import {
  planSlugChangeRedirect,
  publicPath,
} from '../domain/content/redirect-engine.js';
import { resolveContentViewModel, type ContentView } from '../domain/content/view-model.js';
import {
  contentFieldErrorMessage,
  validateContentTitle,
  type ContentFieldErrors,
} from './content.js';
import { auditRebuildFailure } from './rebuild-audit.js';

/**
 * Service de publication (cadrage §5, §12 ; mission §3-§17) — orchestration
 * du cycle Save → Publish → rebuild.
 *
 * **Sémantique V1 (décisions du slice, documentées dans docs/slices/slice-4.md)** :
 * - Save != Publish : Save n'écrit que l'état éditorial courant (service
 *   contenu) ; Publish **valide** l'état courant, le **fige** dans les
 *   colonnes snapshot `published_*` (le dernier état effectivement public)
 *   et demande la reconstruction. Le site statique ne lit que les snapshots :
 *   un Save sur un contenu publié ne change jamais la sortie publique, même
 *   au prochain rebuild déclenché par un autre contenu.
 * - `published_at` = date de **première** publication, jamais réécrite
 *   (mission §6) ; conservé par unpublish.
 * - Changement de slug publié → redirection 301 planifiée par le domaine
 *   (chaînes normalisées, boucles impossibles par construction) ; conflit
 *   (ancien chemin occupé par un autre contenu) → échec **avant** toute
 *   écriture.
 * - Écritures **séquentielles à point de bascule unique** : le driver
 *   neon-http ne garantit pas de transaction interactive (mission §32) ;
 *   l'ordre (redirections → UPDATE de publication → audit) fait que tout
 *   crash intermédiaire laisse un état cohérent ou une redirection
 *   simplement non matérialisée au prochain build — réparable en
 *   republiant. Aucune transaction distribuée simulée (mission §12).
 * - Échec du rebuild : la DB reste dans son nouvel état (source éditoriale),
 *   le dernier site valide reste servi (déploiements atomiques), l'échec est
 *   auditée et remonté à l'admin — jamais de rollback fragile.
 */

export const PUBLICATION_AUDIT_ACTIONS = {
  published: 'content.published',
  unpublished: 'content.unpublished',
  rebuildRequested: 'site.rebuild_requested',
  rebuildFailed: 'site.rebuild_failed',
} as const;

export type PublicationServiceDeps = {
  entries: ContentEntriesRepository;
  redirects: RedirectsRepository;
  audit: AdminAuditLogRepository;
  /** Port de reconstruction — seul point de contact infrastructure du service. */
  rebuild: RebuildTrigger;
  /** Registre des types déclarés par le Project — injecté (jamais le module virtuel). */
  registry: ContentTypeRegistry;
};

export type PublishContentInput = { entryId: string; actorAdminId: string };

export type PublishContentOutcome =
  | {
      kind: 'published';
      entry: KreizContentEntry;
      view: ContentView<unknown>;
      /** Redirection créée (chemins), `null` si le slug public n'a pas changé. */
      redirect: { fromPath: string; toPath: string } | null;
      rebuild: RebuildTriggerResult;
    }
  | { kind: 'invalid'; errors: ContentFieldErrors };

export type UnpublishContentInput = { entryId: string; actorAdminId: string };

export type UnpublishContentOutcome =
  | { kind: 'unpublished'; entry: KreizContentEntry; rebuild: RebuildTriggerResult }
  | { kind: 'not-published'; entry: KreizContentEntry };

export type RequestRebuildOutcome = { rebuild: RebuildTriggerResult };

export function createPublicationService(deps: PublicationServiceDeps) {
  const { entries, redirects, audit, rebuild, registry } = deps;

  function requireDeclaration(contentType: string): ResolvedContentTypeDeclaration {
    return registry.requireByKey(contentType);
  }

  /**
   * Valide l'état éditorial **courant** avant publication : titre commun et
   * JSONB spécifique contre le schéma strict du type. Toute invalidité
   * échoue **avant** la moindre écriture (mission §4).
   */
  function validateForPublish(
    declaration: ResolvedContentTypeDeclaration,
    entry: KreizContentEntry,
  ): { title: string; data: Record<string, unknown> } | { errors: ContentFieldErrors } {
    const errors: ContentFieldErrors = {};
    const title = validateContentTitle(entry.title, errors);
    const parsed = declaration.dataSchema.safeParse(entry.data);
    if (parsed.success && Object.keys(errors).length === 0) {
      return { title, data: parsed.data as Record<string, unknown> };
    }
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        const key = typeof field === 'string' ? field : '_form';
        errors[key] ??= contentFieldErrorMessage(issue);
      }
    }
    return { errors };
  }

  return {
    registry,

    /**
     * Publie un contenu (draft ou déjà publié — « Publier les modifications »).
     *
     * Séquence : validation → plan de redirection (si le slug public change)
     * → écritures ordonnées (point de bascule : `markPublished`) → audit →
     * rebuild. Sur slug changé, l'occupation de l'ancien chemin public par
     * un autre contenu actif est vérifiée **avant** toute écriture
     * (`PublishedPathOccupiedError`).
     */
    async publishContent(
      input: PublishContentInput,
      options: { now?: Date } = {},
    ): Promise<PublishContentOutcome> {
      const now = options.now ?? new Date();
      const existing = await entries.findById(input.entryId);
      if (!existing) throw new ContentNotFoundError(input.entryId);
      if (existing.deletedAt) throw new ContentDeletedError(input.entryId);

      const declaration = requireDeclaration(existing.contentType);

      // Validation avant tout effet de bord (mission §4).
      const validated = validateForPublish(declaration, existing);
      if ('errors' in validated) {
        return { kind: 'invalid', errors: validated.errors };
      }

      // Plan de redirection — uniquement si le slug **public** change
      // (mission §18 : un changement de slug d'un simple draft ne crée
      // jamais de redirect ; un contenu jamais publié n'a pas d'URL
      // historique).
      const previousPublicSlug = existing.publishedSlug;
      const slugChanged = previousPublicSlug !== null && previousPublicSlug !== existing.slug;
      let redirect: { fromPath: string; toPath: string } | null = null;
      if (slugChanged && previousPublicSlug !== null) {
        // Conflit (cadrage §12) : l'ancien chemin public est-il le chemin
        // vivant d'un autre contenu actif ? Refus avant toute écriture.
        const occupied = await entries.slugExistsInNamespace(
          existing.routeNamespace,
          previousPublicSlug,
          { excludeId: existing.id },
        );
        if (occupied) {
          throw new PublishedPathOccupiedError(
            existing.id,
            publicPath(existing.routeNamespace, previousPublicSlug),
          );
        }
        const currentRows = await redirects.listAll();
        const plan = planSlugChangeRedirect({
          routeNamespace: existing.routeNamespace,
          previousPublicSlug,
          newSlug: existing.slug,
          redirects: currentRows,
        });

        // Écritures ordonnées (point de bascule plus bas) :
        // 1. le nouveau chemin redevient une page — ses anciennes
        //    redirections sources meurent ;
        await redirects.deleteByFromPaths(plan.removeStaleSources);
        // 2. la redirection ancien → nouveau (upsert sur `from_path`) ;
        await redirects.upsert({
          fromPath: plan.fromPath,
          toPath: plan.toPath,
          contentEntryId: existing.id,
        });
        // 3. normalisation des chaînes : tout ce qui pointait vers l'ancien
        //    chemin public est re-ciblé (jamais de /a → /b → /c).
        await redirects.retargetTargets(plan.fromPath, plan.toPath);
        redirect = { fromPath: plan.fromPath, toPath: plan.toPath };
      }

      // Point de bascule : fige le dernier état public et bascule le statut.
      const published = await entries.markPublished(existing.id, {
        publishedAt: existing.publishedAt ?? now,
        publishedSlug: existing.slug,
        publishedTitle: validated.title,
        publishedData: validated.data,
        publishedSeo: existing.seo,
        updatedBy: input.actorAdminId,
        updatedAt: now,
      });
      if (!published) {
        // Supprimé entre la lecture et l'écriture.
        throw new ContentDeletedError(input.entryId);
      }

      await audit.append({
        actorAdminId: input.actorAdminId,
        action: PUBLICATION_AUDIT_ACTIONS.published,
        entityType: 'content_entry',
        entityId: published.id,
        metadata: {
          contentType: published.contentType,
          routeNamespace: published.routeNamespace,
          slug: published.slug,
          ...(previousPublicSlug !== null && previousPublicSlug !== published.slug
            ? { previousSlug: previousPublicSlug }
            : {}),
          ...(redirect ? { redirectCreated: true } : {}),
        },
      });

      const rebuild = await this.requestRebuild('content.published');
      if (!rebuild.ok && rebuild.failure.kind !== 'not-configured') {
        await auditRebuildFailure(audit, input.actorAdminId, 'content.published', rebuild.failure);
      }

      return {
        kind: 'published',
        entry: published,
        view: resolveContentViewModel(declaration, published),
        redirect,
        rebuild,
      };
    },

    /**
     * Dépublie : retour en draft, contenu conservé, historique public
     * conservé (`published_at`, snapshots — mission §7). Aucune redirection
     * créée ; les redirections existantes dont la cible meurt ne sont plus
     * matérialisées au build (mission §7 — 404 honnête). Idempotent :
     * dépublier un draft est un no-op sans audit ni rebuild.
     */
    async unpublishContent(
      input: UnpublishContentInput,
      options: { now?: Date } = {},
    ): Promise<UnpublishContentOutcome> {
      const now = options.now ?? new Date();
      const existing = await entries.findById(input.entryId);
      if (!existing) throw new ContentNotFoundError(input.entryId);
      if (existing.deletedAt) throw new ContentDeletedError(input.entryId);
      if (existing.status !== 'published') {
        return { kind: 'not-published', entry: existing };
      }

      const unpublished = await entries.markUnpublished(existing.id, {
        updatedBy: input.actorAdminId,
        updatedAt: now,
      });
      if (!unpublished) throw new ContentDeletedError(input.entryId);

      await audit.append({
        actorAdminId: input.actorAdminId,
        action: PUBLICATION_AUDIT_ACTIONS.unpublished,
        entityType: 'content_entry',
        entityId: unpublished.id,
        metadata: {
          contentType: unpublished.contentType,
          routeNamespace: unpublished.routeNamespace,
          slug: unpublished.slug,
          // Le dernier slug public (inchangé) — trace de l'adresse retirée.
          publishedSlug: unpublished.publishedSlug,
        },
      });

      const rebuild = await this.requestRebuild('content.unpublished');
      if (!rebuild.ok && rebuild.failure.kind !== 'not-configured') {
        await auditRebuildFailure(audit, input.actorAdminId, 'content.unpublished', rebuild.failure);
      }

      return { kind: 'unpublished', entry: unpublished, rebuild };
    },

    /**
     * Reconstruction manuelle (mission §13) — même port, même sémantique
     * qu'un rebuild déclenché par une publication. Action d'admin
     * authentifiée, auditée `site.rebuild_requested`.
     */
    async requestSiteRebuild(
      input: { actorAdminId: string; reason?: RebuildRequestReason },
    ): Promise<RequestRebuildOutcome> {
      const reason = input.reason ?? 'manual';
      const rebuild = await this.requestRebuild(reason);
      await audit.append({
        actorAdminId: input.actorAdminId,
        action: PUBLICATION_AUDIT_ACTIONS.rebuildRequested,
        entityType: 'site',
        entityId: 'rebuild',
        metadata: {
          reason,
          source: 'admin',
          outcome: rebuild.ok ? 'requested' : rebuild.failure.kind,
        },
      });
      return { rebuild };
    },

    /** Appelle le port (factorisation — jamais d'appel direct ailleurs). */
    requestRebuild(reason: RebuildRequestReason): Promise<RebuildTriggerResult> {
      return rebuild.requestRebuild({ reason });
    },
  };
}

export type PublicationService = ReturnType<typeof createPublicationService>;

/** Déclencheur de repli quand aucun provider n'est configuré (runtime admin). */
export { createNoopRebuildTrigger };
export { auditRebuildFailure };
export type { RebuildTrigger, RebuildTriggerResult };
