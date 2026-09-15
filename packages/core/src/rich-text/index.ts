/**
 * API publique du rich text Kreiz — sous-chemin `@kreiz/core/rich-text`
 * (slice 6). Le Project consomme ici le format canonique, la validation, la
 * politique de liens, l'extraction des références médias et le renderer
 * déterministe pour ses templates.
 *
 * **Aucune interne d'édition** : Tiptap, ProseMirror et l'adaptateur admin
 * restent hors de cette surface — le domaine manipule uniquement le format
 * Kreiz. L'éditeur doit pouvoir disparaître sans rendre les contenus
 * inutilisables (principe final du slice 6).
 */

// Types du format canonique
export type {
  KreizRichTextDocument,
  RichTextBlockNode,
  RichTextBlockquoteNode,
  RichTextBulletListNode,
  RichTextCodeBlockNode,
  RichTextHardBreakNode,
  RichTextHeadingNode,
  RichTextHorizontalRuleNode,
  RichTextInlineNode,
  RichTextListItemNode,
  RichTextLinkMarkAttrs,
  RichTextMark,
  RichTextMediaNode,
  RichTextOrderedListNode,
  RichTextParagraphNode,
  RichTextTextNode,
} from '../domain/content/rich-text/document.js';

// Politique (version, bornes, liens)
export {
  RICH_TEXT_FORMAT_VERSION,
  RICH_TEXT_MAX_JSON_BYTES,
  RICH_TEXT_MAX_NODES,
  RICH_TEXT_MAX_DEPTH,
  RICH_TEXT_MAX_LINK_LENGTH,
  RICH_TEXT_MAX_CAPTION_LENGTH,
  RICH_TEXT_HEADING_LEVELS,
  RICH_TEXT_LINK_PROTOCOLS,
  isAllowedRichTextLinkHref,
  externalLinkAttributes,
} from '../domain/content/rich-text/policy.js';

// Validation + compat + inspection
export {
  parseRichTextDocument,
  coerceRichTextValue,
  richTextDocumentFromPlainText,
  emptyRichTextDocument,
  isBlankRichTextDocument,
  extractRichTextMediaIds,
  richTextValueSchema,
} from '../domain/content/rich-text/document.js';

// Renderer déterministe (entrée : document validé — sortie : HTML contrôlé)
export { renderRichTextDocument, escapeHtmlText } from '../domain/content/rich-text/render.js';
export type { RichTextRenderContext } from '../domain/content/rich-text/render.js';

// Erreurs de domaine
export {
  KreizRichTextError,
  RichTextDocumentError,
  richTextDocumentErrorMessage,
} from '../domain/content/rich-text/errors.js';
export type { RichTextDocumentErrorCode } from '../domain/content/rich-text/errors.js';
