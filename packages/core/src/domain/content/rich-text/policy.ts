/**
 * Politique du format rich text Kreiz (slice 6) — constantes **pures**,
 * partagées par le domaine (validation, rendu), l'adaptateur admin Tiptap
 * (schéma de l'éditeur) et les tests. Le contrat métier est ici : Tiptap ne
 * fait que produire des documents conformes, jamais l'inverse.
 *
 * Bornes défensives calibrées pour un CMS éditorial (pas arbitrairement
 * minuscules) : le document vit dans le JSONB `data` (snapshot publié dans
 * `published_data`), les médias sont des **références** (jamais des données
 * binaires), donc le volume d'un document reste textuel.
 */

/** Version du format canonique — première et unique version à ce jour. */
export const RICH_TEXT_FORMAT_VERSION = 1;

/**
 * Taille maximale du JSON sérialisé d'un document (256 KiB). Un document
 * riche de cette taille représente plusieurs dizaines de pages de texte :
 * la borne est anti-abus (payload hostile), pas éditoriale.
 */
export const RICH_TEXT_MAX_JSON_BYTES = 262_144;

/** Nombre maximal de nodes (blocs, inline et textes confondus). */
export const RICH_TEXT_MAX_NODES = 2_000;

/**
 * Profondeur maximale d'imbrication de blocs (citations et listes). Au-delà,
 * un document est soit hostile, soit illisible — refus explicite.
 */
export const RICH_TEXT_MAX_DEPTH = 30;

/** Longueur maximale d'un href de lien. */
export const RICH_TEXT_MAX_LINK_LENGTH = 2_048;

/** Longueur maximale d'une légende de média (donnée éditoriale contextuelle). */
export const RICH_TEXT_MAX_CAPTION_LENGTH = 500;

/**
 * Niveaux de titre autorisés dans le **corps**. Le `<h1>` appartient au
 * titre du contenu (rendu par le template) — jamais au document riche : la
 * hiérarchie publique reste cohérente (une seule h1 par page).
 */
export const RICH_TEXT_HEADING_LEVELS = [2, 3] as const;

/** Protocoles de lien autorisés — tout autre schéma (`javascript:`, `data:`…) est refusé. */
export const RICH_TEXT_LINK_PROTOCOLS = ['http', 'https', 'mailto'] as const;

/**
 * Politique de lien — un href stocké est :
 * - soit un chemin interne relatif à la racine (`/articles/…` — jamais
 *   `//hote` protocol-relative, jamais `..\`) ;
 * - soit une URL absolue `http`, `https` ou `mailto`.
 *
 * Le rendu revalide (défense en profondeur) : un href invalide ne produit
 * jamais d'ancre, seulement le texte du lien.
 */
export function isAllowedRichTextLinkHref(href: string): boolean {
  if (href.length === 0 || href.length > RICH_TEXT_MAX_LINK_LENGTH) return false;
  // Chemin interne : `/…` sans `//` initial (protocol-relative interdit).
  if (href.startsWith('/')) return !href.startsWith('//') && !href.includes('\\');
  // URL absolue : schéma borné à la liste autorisée (pas de `javascript:`,
  // `data:`, `vbscript:`… — même encodés, `new URL` résout le vrai schéma).
  try {
    const url = new URL(href);
    return (RICH_TEXT_LINK_PROTOCOLS as readonly string[]).includes(url.protocol.slice(0, -1));
  } catch {
    return false;
  }
}

/**
 * Attributs `target`/`rel` **décidés par le rendu** (jamais stockés dans le
 * document) : un lien http(s) externe s'ouvre dans un nouvel onglet sans
 * fuite du `window.opener` ; `mailto` et les liens internes restent dans
 * l'onglet courant, sans attributs superflus.
 */
export function externalLinkAttributes(href: string): { target?: '_blank'; rel?: 'noopener noreferrer' } {
  if (!isAllowedRichTextLinkHref(href)) return {};
  if (href.startsWith('/') || href.startsWith('mailto:')) return {};
  return { target: '_blank', rel: 'noopener noreferrer' };
}
