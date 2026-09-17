import type {
  KreizRichTextDocument,
  RichTextBlockNode,
  RichTextInlineNode,
} from '../content/rich-text/document.js';

/**
 * Extraction de **texte brut** depuis un document rich text canonique
 * (mission slice 9 §7/§23) — le repli déterministe de la meta description.
 *
 * On ne parse **jamais** le HTML rendu (mission §7) : la source est le
 * document structuré, seul format stocké. Les nodes porteurs de texte
 * (paragraphes, titres, items de liste, citations, blocs de code) sont
 * concaténés dans l'ordre de lecture ; les médias (légende comprise) et
 * les séparateurs horizontaux ne contribuent pas — une description décrit
 * un propos, pas une planche d'images. Whitespace compacté, troncature
 * **sur frontière de mot** à la borne, aucun caractère ajouté.
 */
export function richTextDocumentToPlainText(document: KreizRichTextDocument, maxLength: number): string {
  const parts: string[] = [];
  collectBlocks(document.content, parts);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
}

function collectBlocks(blocks: ReadonlyArray<RichTextBlockNode>, parts: string[]): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        collectInline(block.content, parts);
        break;
      case 'blockquote':
      case 'bulletList':
      case 'orderedList':
      case 'listItem':
        collectBlocks(block.content ?? [], parts);
        break;
      case 'codeBlock':
        for (const node of block.content ?? []) {
          if (node.text.trim().length > 0) parts.push(node.text.trim());
        }
        break;
      case 'media':
      case 'horizontalRule':
        break;
    }
  }
}

function collectInline(nodes: ReadonlyArray<RichTextInlineNode> | undefined, parts: string[]): void {
  for (const node of nodes ?? []) {
    if (node.type === 'text' && node.text.trim().length > 0) {
      parts.push(node.text.trim());
    }
    // hardBreak : séparation visuelle — l'espace jointeur des parties suffit.
  }
}
