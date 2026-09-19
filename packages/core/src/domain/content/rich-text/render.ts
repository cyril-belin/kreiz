import type { PublicMediaView } from '../../media/view-model.js';
import { mediaFallbackSrc, mediaSources } from '../../media/picture.js';
import { isAllowedRichTextLinkHref, externalLinkAttributes } from './policy.js';
import type {
  KreizRichTextDocument,
  RichTextBlockNode,
  RichTextInlineNode,
  RichTextMark,
} from './document.js';

/**
 * Renderer public **déterministe** du rich text Kreiz (slice 6 §15) — pure
 * fonction : même document (+ mêmes vues médias) ⇒ même HTML, octet pour
 * octet, à toute époque.
 *
 * Sécurité : **whitelist stricte**. Tout le texte est échappé ; les seuls
 * tags émis sont ceux du rendu ci-dessous, avec leurs seuls attributs
 * contrôlés. Aucun HTML provenant du document n'est recopié (les documents
 * ne contiennent d'ailleurs jamais de HTML — le parseur refuse toute
 * structure hors schéma). Les href sont **revalidés** ici (défense en
 * profondeur) : un lien invalide perd son ancre, pas sa lisibilité.
 *
 * Sémantique attendue : p, h2/h3, ul/ol/li, blockquote, pre>code, a,
 * hr, br, et figure>picture>img+figcaption pour les médias (pipeline slice 5 :
 * variantes AVIF/WebP, fallback WebP le plus grand, jamais l'original privé).
 */

/** Contexte de rendu — résolution des vues publiques des médias référencés. */
export interface RichTextRenderContext {
  /**
   * Vue publique d'un média référencé, ou `null`. Le build et la preview
   * passent une résolution totale (un document publié ne référence que des
   * médias prêts) ; un `null` — divergence, corruption — retire la figure
   * sans jamais produire d'HTML cassé ni d'URL inventée.
   */
  readonly resolveMedia: (mediaId: string) => PublicMediaView | null;
}

export function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Ordre d'imbrication fixe des marks — rendu stable quelle que soit la saisie. */
const MARK_RENDER_ORDER: ReadonlyArray<RichTextMark['type']> = [
  'link',
  'bold',
  'italic',
  'strike',
  'code',
];

const MARK_OPENERS: Record<RichTextMark['type'], string> = {
  link: 'a', // attributs décidés par le rendu (cible/rel), voir ci-dessous
  bold: 'strong',
  italic: 'em',
  strike: 's',
  code: 'code',
};

function renderInline(nodes: ReadonlyArray<RichTextInlineNode>): string {
  let html = '';
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      html += '<br />';
      continue;
    }
    const marks = [...(node.marks ?? [])].sort(
      (a, b) => MARK_RENDER_ORDER.indexOf(a.type) - MARK_RENDER_ORDER.indexOf(b.type),
    );
    let prefix = '';
    let suffix = '';
    for (const mark of marks) {
      if (mark.type === 'link') {
        // Revalidation au rendu : un href invalide ne produit jamais d'ancre.
        if (!isAllowedRichTextLinkHref(mark.attrs.href)) continue;
        const attrs = externalLinkAttributes(mark.attrs.href);
        prefix += `<a href="${escapeHtmlText(mark.attrs.href)}"${
          attrs.target ? ` target="${attrs.target}"` : ''
        }${attrs.rel ? ` rel="${attrs.rel}"` : ''}>`;
        suffix = `</a>${suffix}`;
        continue;
      }
      const tag = MARK_OPENERS[mark.type];
      prefix += `<${tag}>`;
      suffix = `</${tag}>${suffix}`;
    }
    html += `${prefix}${escapeHtmlText(node.text)}${suffix}`;
  }
  return html;
}

function inlineIsBlank(nodes: ReadonlyArray<RichTextInlineNode>): boolean {
  return (
    !nodes.some((node) => node.type === 'text' && node.text.trim().length > 0) &&
    !nodes.some((node) => node.type === 'hardBreak')
  );
}

function renderMediaFigure(mediaId: string, caption: string | undefined, ctx: RichTextRenderContext): string {
  const view = ctx.resolveMedia(mediaId);
  if (!view) return '';
  const fallback = mediaFallbackSrc(view);
  if (!fallback) return '';
  const sources = mediaSources(view);
  let html = `<figure class="kz-richtext-figure" data-kreiz-media><picture>`;
  for (const source of sources) {
    html += `<source type="${escapeHtmlText(source.type)}" srcset="${escapeHtmlText(source.srcset)}" />`;
  }
  html += `<img src="${escapeHtmlText(fallback)}" alt="${escapeHtmlText(view.alt)}"${
    view.width != null ? ` width="${view.width}"` : ''
  }${view.height != null ? ` height="${view.height}"` : ''} loading="lazy" decoding="async" /></picture>`;
  if (caption && caption.trim().length > 0) {
    html += `<figcaption>${escapeHtmlText(caption)}</figcaption>`;
  }
  html += '</figure>';
  return html;
}

function renderBlock(node: RichTextBlockNode, ctx: RichTextRenderContext): string {
  switch (node.type) {
    case 'paragraph': {
      const content = node.content ?? [];
      // Les paragraphes vides (fin de saisie, collage) sont du bruit : le
      // rendu public ne les émet pas — décision déterministe.
      if (inlineIsBlank(content)) return '';
      return `<p>${renderInline(content)}</p>`;
    }
    case 'heading': {
      const content = node.content ?? [];
      if (inlineIsBlank(content)) return '';
      // Défense en profondeur (revue sécurité finale) : le niveau est validé
      // par le parseur (2–3), mais `renderRichTextDocument` est une API
      // publique — un appelant lui passant un JSON brut non parsé ne doit
      // pouvoir injecter ni nom de balise ni attribut via `level`.
      if (node.attrs.level !== 2 && node.attrs.level !== 3) return '';
      const tag = `h${node.attrs.level}`;
      return `<${tag}>${renderInline(content)}</${tag}>`;
    }
    case 'bulletList':
    case 'orderedList': {
      const tag = node.type === 'bulletList' ? 'ul' : 'ol';
      const items = (node.content ?? []).map((child) => {
        // Un listItem porte ses blocs internes — un seul <li> par item,
        // quelle que soit la profondeur du contenu (paragraphes, listes…).
        const inner =
          child.type === 'listItem'
            ? (child.content ?? []).map((block) => renderBlock(block, ctx)).join('')
            : renderBlock(child, ctx);
        return `<li>${inner}</li>`;
      });
      return items.length > 0 ? `<${tag}>${items.join('')}</${tag}>` : '';
    }
    case 'blockquote': {
      const inner = (node.content ?? []).map((child) => renderBlock(child, ctx)).join('');
      return inner.length > 0 ? '<blockquote>' + inner + '</blockquote>' : '';
    }
    case 'horizontalRule':
      return '<hr />';
    case 'media':
      return renderMediaFigure(node.attrs.mediaId, node.attrs.caption, ctx);
    case 'codeBlock': {
      const text = (node.content ?? []).map((inline) => inline.text).join('\n');
      if (text.trim().length === 0) return '';
      return `<pre><code>${escapeHtmlText(text)}</code></pre>`;
    }
  }
  return '';
}

/**
 * Rend le document en HTML déterministe. Entrée attendue : document validé
 * (`parseRichTextDocument`) ; la fonction reste défensive — toute structure
 * inconnue ne produit simplement pas de sortie, jamais d'HTML non contrôlé.
 */
export function renderRichTextDocument(
  document: KreizRichTextDocument,
  ctx: RichTextRenderContext,
): string {
  let html = '';
  for (const block of document.content) {
    html += renderBlock(block, ctx);
  }
  return html;
}
