import { emptyRichTextDocument, type KreizRichTextDocument } from '../../domain/content/rich-text/document.js';
import { RICH_TEXT_FORMAT_VERSION } from '../../domain/content/rich-text/policy.js';

/**
 * Traduction **Tiptap JSON ⇄ document canonique Kreiz** (slice 6 §1) — la
 * frontière de l'adaptateur, en un seul endroit testé :
 *
 * - le JSON natif de ProseMirror/Tiptap ne porte **pas** de version : le
 *   tampon `version` du format Kreiz est posé ici, à la seule sortie de
 *   l'éditeur (le serveur revalide de toute façon) ;
 * - à l'entrée, les clés du document canonique sont réduites à ce que
 *   ProseMirror consomme (`type`, `content`) — une future version de
 *   l'adaptateur saura migrer sans toucher au stockage.
 */

/** JSON sortant de l'éditeur → document canonique (version tamponnée). */
export function editorJsonToDocument(json: unknown): KreizRichTextDocument {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return emptyRichTextDocument();
  }
  const candidate = json as { type?: unknown; content?: unknown };
  if (candidate.type !== 'doc' || !Array.isArray(candidate.content)) {
    return emptyRichTextDocument();
  }
  return {
    version: RICH_TEXT_FORMAT_VERSION,
    type: 'doc',
    content: candidate.content as KreizRichTextDocument['content'],
  };
}

/** Document canonique (stocké) → contenu d'initialisation Tiptap. */
export function documentToEditorContent(document: unknown): { type: 'doc'; content: unknown[] } {
  const candidate =
    typeof document === 'object' && document !== null && !Array.isArray(document)
      ? (document as { content?: unknown })
      : emptyRichTextDocument();
  return { type: 'doc', content: Array.isArray(candidate.content) ? candidate.content : [] };
}
