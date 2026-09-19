import { z } from 'zod';
import {
  RichTextDocumentError,
  richTextDocumentErrorMessage,
  type RichTextDocumentErrorCode,
} from './errors.js';
import {
  isAllowedRichTextLinkHref,
  RICH_TEXT_FORMAT_VERSION,
  RICH_TEXT_HEADING_LEVELS,
  RICH_TEXT_MAX_CAPTION_LENGTH,
  RICH_TEXT_MAX_DEPTH,
  RICH_TEXT_MAX_JSON_BYTES,
  RICH_TEXT_MAX_LINK_LENGTH,
  RICH_TEXT_MAX_NODES,
} from './policy.js';

/**
 * Format canonique **Kreiz** du rich text (slice 6) — type métier explicite,
 * indépendant de tout runtime d'édition. Tiptap n'est qu'un producteur : le
 * domaine ne connaît ni ProseMirror, ni le DOM, ni un éditeur. Le JSON stocké
 * dans `data` (et figé dans `published_data`) est TOUJOURS passé ici :
 *
 *     entrée inconnue → parseRichTextDocument() → document canonique → base
 *
 * Nodes autorisés V1 : paragraph, heading (2–3), bulletList, orderedList,
 * listItem, blockquote, horizontalRule, hardBreak, media, codeBlock, text.
 * Marks autorisés : bold, italic, strike, code, link (href validé).
 * Tout node/mark/attribut inconnu est rejeté explicitement — le JSON n'est
 * jamais stocké « tel quel » (pas de confiance implicite au producteur).
 */

// ——— Types métier ———

export interface RichTextLinkMarkAttrs {
  href: string;
}

export type RichTextMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'code' }
  | { type: 'link'; attrs: RichTextLinkMarkAttrs };

export interface RichTextTextNode {
  type: 'text';
  text: string;
  marks?: RichTextMark[];
}

export interface RichTextHardBreakNode {
  type: 'hardBreak';
}

/** Contenu en ligne : texte (avec marks) et sauts de ligne. */
export type RichTextInlineNode = RichTextTextNode | RichTextHardBreakNode;

export interface RichTextParagraphNode {
  type: 'paragraph';
  content?: RichTextInlineNode[];
}

export interface RichTextHeadingNode {
  type: 'heading';
  attrs: { level: (typeof RICH_TEXT_HEADING_LEVELS)[number] };
  content?: RichTextInlineNode[];
}

export interface RichTextBulletListNode {
  type: 'bulletList';
  content?: RichTextBlockNode[];
}

export interface RichTextOrderedListNode {
  type: 'orderedList';
  content?: RichTextBlockNode[];
}

export interface RichTextListItemNode {
  type: 'listItem';
  content?: RichTextBlockNode[];
}

export interface RichTextBlockquoteNode {
  type: 'blockquote';
  content?: RichTextBlockNode[];
}

export interface RichTextHorizontalRuleNode {
  type: 'horizontalRule';
}

/**
 * Média du pipeline Kreiz (slice 5) référencé par son **id stable** — jamais
 * d'URL (présignée ou brute), jamais d'HTML embarqué. La légende est une
 * donnée éditoriale contextuelle ; l'alt public vient des métadonnées du
 * média (source unique, slice 6 §19).
 */
export interface RichTextMediaNode {
  type: 'media';
  attrs: { mediaId: string; caption?: string };
}

export interface RichTextCodeBlockNode {
  type: 'codeBlock';
  content?: RichTextTextNode[];
}

export type RichTextBlockNode =
  | RichTextParagraphNode
  | RichTextHeadingNode
  | RichTextBulletListNode
  | RichTextOrderedListNode
  | RichTextListItemNode
  | RichTextBlockquoteNode
  | RichTextHorizontalRuleNode
  | RichTextMediaNode
  | RichTextCodeBlockNode;

export interface KreizRichTextDocument {
  version: typeof RICH_TEXT_FORMAT_VERSION;
  type: 'doc';
  content: RichTextBlockNode[];
}

/** Document vide canonique — valeur d'initialisation des éditeurs. */
export function emptyRichTextDocument(): KreizRichTextDocument {
  return { version: RICH_TEXT_FORMAT_VERSION, type: 'doc', content: [] };
}

// ——— Schéma Zod strict (forme) ———

const inlineArraySchema = z
  .array(z.lazy(() => inlineNodeSchema))
  .max(RICH_TEXT_MAX_NODES);

/** Texte de bloc de code : sans marks (même contrat que l'éditeur). */
const codeBlockTextSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1),
});

const markSchema: z.ZodType<RichTextMark> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('bold') }),
    z.strictObject({ type: z.literal('italic') }),
    z.strictObject({ type: z.literal('strike') }),
    z.strictObject({ type: z.literal('code') }),
    z.strictObject({
      type: z.literal('link'),
      attrs: z.strictObject({
        href: z.string().refine(isAllowedRichTextLinkHref),
      }),
    }),
  ]),
) as unknown as z.ZodType<RichTextMark>;

const inlineNodeSchema: z.ZodType<RichTextInlineNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('text'),
      text: z.string().min(1),
      marks: z.array(markSchema).max(5).optional(),
    }),
    z.strictObject({ type: z.literal('hardBreak') }),
  ]),
) as unknown as z.ZodType<RichTextInlineNode>;

const headingLevelSchema = z.union(
  RICH_TEXT_HEADING_LEVELS.map((level) => z.literal(level)) as unknown as [
    z.ZodLiteral<2>,
    z.ZodLiteral<3>,
  ],
);

const blockNodeSchema: z.ZodType<RichTextBlockNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('paragraph'), content: inlineArraySchema.optional() }),
    z.strictObject({
      type: z.literal('heading'),
      attrs: z.strictObject({ level: headingLevelSchema }),
      content: inlineArraySchema.optional(),
    }),
    z.strictObject({
      type: z.literal('bulletList'),
      content: z.array(blockNodeSchema).max(RICH_TEXT_MAX_NODES).optional(),
    }),
    z.strictObject({
      type: z.literal('orderedList'),
      content: z.array(blockNodeSchema).max(RICH_TEXT_MAX_NODES).optional(),
    }),
    z.strictObject({
      type: z.literal('listItem'),
      content: z.array(blockNodeSchema).max(RICH_TEXT_MAX_NODES).optional(),
    }),
    z.strictObject({
      type: z.literal('blockquote'),
      content: z.array(blockNodeSchema).max(RICH_TEXT_MAX_NODES).optional(),
    }),
    z.strictObject({ type: z.literal('horizontalRule') }),
    z.strictObject({
      type: z.literal('media'),
      attrs: z.strictObject({
        mediaId: z.string().trim().min(1).max(128),
        caption: z.string().trim().max(RICH_TEXT_MAX_CAPTION_LENGTH).optional(),
      }),
    }),
    z.strictObject({
      type: z.literal('codeBlock'),
      content: z.array(codeBlockTextSchema).max(RICH_TEXT_MAX_NODES).optional(),
    }),
  ]),
) as unknown as z.ZodType<RichTextBlockNode>;

const documentSchema: z.ZodType<KreizRichTextDocument> = z.lazy(() =>
  z.strictObject({
    version: z.literal(RICH_TEXT_FORMAT_VERSION),
    type: z.literal('doc'),
    content: z.array(blockNodeSchema).max(RICH_TEXT_MAX_NODES),
  }),
) as unknown as z.ZodType<KreizRichTextDocument>;

// ——— Parse (validation complète : forme + invariants) ———

function errorFromIssues(
  issues: Array<{ code: string; path: PropertyKey[] }>,
): RichTextDocumentError {
  const hasHrefIssue = issues.some((issue) => issue.path.includes('href'));
  if (hasHrefIssue) {
    return new RichTextDocumentError('invalid-link', 'Lien non autorisé.');
  }
  const oversized = issues.some(
    (issue) => issue.code === 'too_big' && issue.path.at(-1) === 'content',
  );
  if (oversized) {
    return new RichTextDocumentError(
      'too-many-nodes',
      `Document trop long (${RICH_TEXT_MAX_NODES} éléments maximum).`,
    );
  }
  const unknownType = issues.find(
    (issue) =>
      issue.path.at(-1) === 'type' &&
      (issue.code === 'invalid_value' || issue.code === 'invalid_union'),
  );
  if (unknownType) {
    // Racine (`type` au premier niveau) = structure du document, pas un node.
    if (unknownType.path.length === 1) {
      return new RichTextDocumentError(
        'invalid-structure',
        'Structure de document riche invalide.',
      );
    }
    const inMarks = unknownType.path.includes('marks');
    return new RichTextDocumentError(
      inMarks ? 'unknown-mark' : 'unknown-node',
      inMarks ? 'Marque de mise en forme inconnue.' : 'Type de bloc inconnu.',
    );
  }
  return new RichTextDocumentError(
    'invalid-structure',
    'Structure de document riche invalide.',
  );
}

type GuardState = { count: number; depth: number };

const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
]);

function guardLimits(node: RichTextBlockNode | RichTextInlineNode, state: GuardState): void {
  state.count += 1;
  if (state.count > RICH_TEXT_MAX_NODES) {
    throw new RichTextDocumentError(
      'too-many-nodes',
      `Document trop long (${RICH_TEXT_MAX_NODES} éléments maximum).`,
    );
  }
  if (CONTAINER_TYPES.has(node.type)) {
    state.depth += 1;
    if (state.depth > RICH_TEXT_MAX_DEPTH) {
      throw new RichTextDocumentError(
        'depth-exceeded',
        `Imbrication trop profonde (${RICH_TEXT_MAX_DEPTH} niveaux maximum).`,
      );
    }
  }
  const children: ReadonlyArray<RichTextBlockNode | RichTextInlineNode> =
    node.type === 'text' || node.type === 'hardBreak' || node.type === 'horizontalRule' || node.type === 'media'
      ? []
      : (node.content ?? []);
  for (const child of children) guardLimits(child, state);
}

/**
 * Valide une valeur **inconnue** (JSONB, POST, module virtuel) en document
 * canonique. Lève `RichTextDocumentError` sur toute entropie hors schéma :
 * version inconnue, node/mark inconnu, attribut superflu (`strictObject`),
 * lien non autorisé, bornes dépassées. Aucune normalisation silencieuse de
 * forme — un document stocké a toujours été accepté par cette fonction.
 */
export function parseRichTextDocument(input: unknown): KreizRichTextDocument {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RichTextDocumentError('not-json-object', 'Document riche illisible (objet attendu).');
  }
  const version = (input as { version?: unknown }).version;
  if (version !== RICH_TEXT_FORMAT_VERSION) {
    throw new RichTextDocumentError(
      'unknown-version',
      `Version de document riche inconnue (attendu ${RICH_TEXT_FORMAT_VERSION}).`,
    );
  }
  const json = JSON.stringify(input);
  if (json !== null && new TextEncoder().encode(json).length > RICH_TEXT_MAX_JSON_BYTES) {
    throw new RichTextDocumentError(
      'too-large',
      `Document trop volumineux (${RICH_TEXT_MAX_JSON_BYTES} octets maximum).`,
    );
  }
  // Pré-scan de profondeur **itératif** (revue sécurité finale) : la récursion
  // Zod sur un arbre hostile (~1000 niveaux, sous la borne de taille) lève un
  // `RangeError` brut (débordement de pile) au lieu d'une erreur de domaine —
  // le garde `depth-exceeded` ne courait qu'après le parse. On rejette
  // l'imbrication structurelle excessive avant d'entrer dans le schéma, sans
  // récursion. Cette borne est **plus large** que `RICH_TEXT_MAX_DEPTH` : le
  // scan compte chaque niveau d'objet/tableau (un bloc a deux niveaux), et la
  // garde éditoriale précise (conteneurs uniquement) reste `guardLimits`.
  assertBoundedDepth(input);
  const parsed = documentSchema.safeParse(input);
  if (!parsed.success) {
    throw errorFromIssues(parsed.error.issues);
  }
  const state: GuardState = { count: 0, depth: 0 };
  for (const block of parsed.data.content) guardLimits(block, state);
  return parsed.data;
}

/**
 * Parcours itératif de la structure brute : compte l'imbrication **totale**
 * (objets et tableaux confondus) et échoue au-delà de la borne — pile
 * explicite, jamais la pile d'appels. Un document légitime au maximum de la
 * garde éditoriale (30 conteneurs ≈ 70 niveaux bruts) passe largement ; un
 * arbre hostile (≥ 400 niveaux) ne peut plus atteindre la récursion Zod.
 * Tolérante aux formes invalides : le schéma strict reste responsable de la
 * validité structurelle.
 */
const PRE_SCAN_MAX_STRUCTURAL_DEPTH = 400;

function assertBoundedDepth(input: unknown): void {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: input, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > PRE_SCAN_MAX_STRUCTURAL_DEPTH) {
      throw new RichTextDocumentError(
        'depth-exceeded',
        `Imbrication trop profonde (${RICH_TEXT_MAX_DEPTH} niveaux maximum).`,
      );
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        if (child !== null && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
      }
    } else if (node !== null && typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) {
        if (value !== null && typeof value === 'object') stack.push({ node: value, depth: depth + 1 });
      }
    }
  }
}

// ——— Valeur de champ (compat legacy + validation) ———

/**
 * Convertit un **texte simple** (format des corps `textarea` antérieurs au
 * slice 6) en document canonique : paragraphes séparés par lignes vides,
 * sauts de ligne simples conservés par `hardBreak`. Aucune mise en forme
 * inventée — la conversion est lisible et réversible à la lecture.
 */
export function richTextDocumentFromPlainText(text: string): KreizRichTextDocument {
  const content: RichTextBlockNode[] = [];
  const blocks = text.split(/\n[ \t]*\n+/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const inline: RichTextInlineNode[] = [];
    lines.forEach((line, index) => {
      if (index > 0) inline.push({ type: 'hardBreak' });
      if (line.length > 0) inline.push({ type: 'text', text: line });
    });
    if (inline.length > 0) content.push({ type: 'paragraph', content: inline });
  }
  return { version: RICH_TEXT_FORMAT_VERSION, type: 'doc', content };
}

/**
 * Valeur d'un champ richText telle que **stockée ou soumise** : soit un
 * document conforme, soit — compat contrôlée avec les contenus créés avant
 * le slice 6 — un texte simple converti à la volée. Toute autre forme est
 * une erreur (`RichTextDocumentError`), jamais un JSON accepté tel quel.
 */
export function coerceRichTextValue(input: unknown): KreizRichTextDocument {
  if (typeof input === 'string') {
    if (input.trim().length === 0) return emptyRichTextDocument();
    return parseRichTextDocument(richTextDocumentFromPlainText(input));
  }
  return parseRichTextDocument(input);
}

// ——— Inspection ———

/** Document sans contenu éditorial réel (vide, paragraphes vides, seules règles horizontales). */
export function isBlankRichTextDocument(document: KreizRichTextDocument): boolean {
  function blockHasContent(node: RichTextBlockNode): boolean {
    switch (node.type) {
      case 'media':
        return true;
      case 'paragraph':
      case 'heading':
        return (node.content ?? []).some(
          (inline) => inline.type === 'text' && inline.text.trim().length > 0,
        );
      case 'codeBlock':
        return (node.content ?? []).some((inline) => inline.text.trim().length > 0);
      case 'horizontalRule':
        return false;
      case 'bulletList':
      case 'orderedList':
      case 'listItem':
      case 'blockquote':
        return (node.content ?? []).some(blockHasContent);
    }
  }
  return !document.content.some(blockHasContent);
}

/**
 * Extraction des **références médias** d'un document — ids dédupliqués,
 * ordre d'apparition conservé. Utilisée par la validation de publication,
 * la résolution batch du build, la protection contre la suppression et le
 * comptage JSONB côté repository (même définition de « référence » partout).
 */
export function extractRichTextMediaIds(document: KreizRichTextDocument): string[] {
  const ids: string[] = [];
  function walk(nodes: ReadonlyArray<RichTextBlockNode>): void {
    for (const node of nodes) {
      if (node.type === 'media') {
        if (!ids.includes(node.attrs.mediaId)) ids.push(node.attrs.mediaId);
        continue;
      }
      if (
        node.type === 'bulletList' ||
        node.type === 'orderedList' ||
        node.type === 'listItem' ||
        node.type === 'blockquote'
      ) {
        walk(node.content ?? []);
      }
    }
  }
  walk(document.content);
  return ids;
}

// ——— Schéma de champ (composition avec dataSchemaFromFields) ———

/**
 * Schéma Zod d'un champ richText : validation par le domaine + transformation
 * en document canonique (le JSONB ne stocke que des documents validés).
 * Les chaînes (legacy pré-slice 6) sont converties de façon contrôlée.
 * Le message d'issue est français, prêt à afficher — il traverse
 * `contentFieldErrorMessage` (branche par défaut) sans remapping.
 */
export const richTextValueSchema: z.ZodType<KreizRichTextDocument> = z
  .unknown()
  .transform((value, ctx) => {
    try {
      return coerceRichTextValue(value);
    } catch (error) {
      if (error instanceof RichTextDocumentError) {
        ctx.addIssue({ code: 'custom', message: richTextDocumentErrorMessage(error) });
        return z.NEVER;
      }
      throw error;
    }
  }) as z.ZodType<KreizRichTextDocument>;

export { RICH_TEXT_MAX_LINK_LENGTH };
export type { RichTextDocumentErrorCode };
