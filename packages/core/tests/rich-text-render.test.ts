import { describe, expect, it } from 'vitest';
import {
  parseRichTextDocument,
  type KreizRichTextDocument,
  type RichTextBlockNode,
} from '../src/domain/content/rich-text/document';
import { renderRichTextDocument, escapeHtmlText } from '../src/domain/content/rich-text/render';
import type { PublicMediaView } from '../src/domain/media/view-model';

/**
 * Renderer public déterministe (slice 6 §15/§17/§36) — whitelist stricte :
 * tags et attributs contrôlés, texte échappé, liens selon la politique,
 * médias via le pipeline slice 5. Les tests hostiles prouvent qu'aucun
 * payload ne produit d'HTML exécutable.
 */

function doc(blocks: RichTextBlockNode[]): KreizRichTextDocument {
  return { version: 1, type: 'doc', content: blocks };
}

function paragraph(text: string): RichTextBlockNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

const NO_MEDIA = { resolveMedia: () => null };

const mediaId = '11111111-1111-1111-1111-111111111111';

function mediaView(overrides: Partial<PublicMediaView> = {}): PublicMediaView {
  return {
    id: overrides.id ?? '11111111-1111-1111-1111-111111111111',
    alt: overrides.alt ?? 'Alt canonique',
    width: overrides.width ?? 1600,
    height: overrides.height ?? 900,
    variants: overrides.variants ?? [
      { url: 'https://media.ex/cdn/m1/400.avif', width: 400, format: 'image/avif', height: 225 },
      { url: 'https://media.ex/cdn/m1/800.avif', width: 800, format: 'image/avif', height: 450 },
      { url: 'https://media.ex/cdn/m1/400.webp', width: 400, format: 'image/webp', height: 225 },
      { url: 'https://media.ex/cdn/m1/800.webp', width: 800, format: 'image/webp', height: 450 },
    ],
  };
}

describe('rendu des blocs (slice 6 §17)', () => {
  it('paragraphe → <p>, titres → <h2>/<h3> — jamais de h1/h4', () => {
    const html = renderRichTextDocument(
      doc([
        paragraph('Un.'),
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Deux' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Trois' }] },
      ]),
      NO_MEDIA,
    );
    expect(html).toBe('<p>Un.</p><h2>Deux</h2><h3>Trois</h3>');
  });

  it('niveau de titre forgé hors 2–3 : aucun rendu (défense en profondeur, revue sécurité finale)', () => {
    // `renderRichTextDocument` est une API publique : un appelant lui passant
    // un document non parsé ne doit pas pouvoir injecter de nom de balise.
    const forged = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: '2><img src=x onerror=alert(1)>' }, content: [{ type: 'text', text: 'piégé' }] },
      ],
    } as unknown as KreizRichTextDocument;
    expect(renderRichTextDocument(forged, NO_MEDIA)).toBe('');
  });

  it('listes → <ul>/<ol>/<li>, blockquote → <blockquote>, imbrication', () => {
    const html = renderRichTextDocument(
      doc([
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph('A')] },
            {
              type: 'listItem',
              content: [
                paragraph('B'),
                { type: 'orderedList', content: [{ type: 'listItem', content: [paragraph('B1')] }] },
              ],
            },
          ],
        },
        { type: 'blockquote', content: [paragraph('Citation'), paragraph('Suite')] },
      ]),
      NO_MEDIA,
    );
    expect(html).toBe(
      '<ul><li><p>A</p></li><li><p>B</p><ol><li><p>B1</p></li></ol></li></ul>' +
        '<blockquote><p>Citation</p><p>Suite</p></blockquote>',
    );
  });

  it('code block → <pre><code> sans attribut, horizontalRule → <hr>, hardBreak → <br>', () => {
    const html = renderRichTextDocument(
      doc([
        { type: 'codeBlock', content: [{ type: 'text', text: 'if (a < b) { x = "&"; }' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'L1' }, { type: 'hardBreak' }, { type: 'text', text: 'L2' }] },
      ]),
      NO_MEDIA,
    );
    expect(html).toBe(
      '<pre><code>if (a &lt; b) { x = &quot;&amp;&quot;; }</code></pre><hr /><p>L1<br />L2</p>',
    );
  });

  it('paragraphes vides : bruit de saisie retiré du rendu public', () => {
    const html = renderRichTextDocument(
      doc([{ type: 'paragraph' }, paragraph('Réel'), { type: 'horizontalRule' }, paragraph(' ')]),
      NO_MEDIA,
    );
    expect(html).toBe('<p>Réel</p><hr />');
  });

  it('document vide → chaîne vide', () => {
    expect(renderRichTextDocument(parseRichTextDocument({ version: 1, type: 'doc', content: [] }), NO_MEDIA)).toBe('');
  });
});

describe('rendu des marks et liens', () => {
  it('bold/italic/strike/code → strong/em/s/code avec ordre d’imbriquation stable', () => {
    const html = renderRichTextDocument(
      doc([
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'code' }, { type: 'strike' }, { type: 'italic' }, { type: 'bold' }],
            },
          ],
        },
      ]),
      NO_MEDIA,
    );
    // Ordre fixe : strong > em > s > code, indépendamment de l'ordre stocké.
    expect(html).toBe('<p><strong><em><s><code>x</code></s></em></strong></p>');
  });

  it('lien externe → target/rel politique ; interne et mailto → ancre simple', () => {
    const html = renderRichTextDocument(
      doc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'ext', marks: [{ type: 'link', attrs: { href: 'https://autre.ex/a?b=1&c=2' } }] },
            { type: 'text', text: 'int', marks: [{ type: 'link', attrs: { href: '/articles/x' } }] },
            { type: 'text', text: 'mail', marks: [{ type: 'link', attrs: { href: 'mailto:a@b.fr' } }] },
          ],
        },
      ]),
      NO_MEDIA,
    );
    expect(html).toBe(
      '<p><a href="https://autre.ex/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">ext</a>' +
        '<a href="/articles/x">int</a>' +
        '<a href="mailto:a@b.fr">mail</a></p>',
    );
  });

  it('lien invalide en rendu (défense en profondeur) : texte sans ancre', () => {
    // Fabriqué hors parseur (le parseur le refuserait) — le renderer ne
    // doit JAMAIS émettre l'attribut href hostile.
    const html = renderRichTextDocument(
      doc([
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'piège',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } } as never],
            },
          ],
        },
      ]),
      NO_MEDIA,
    );
    expect(html).toBe('<p>piège</p>');
    expect(html).not.toContain('href');
  });
});

describe('rendu des médias (pipeline slice 5)', () => {
  it('figure/picture/sources AVIF puis WebP, fallback, width/height, alt, caption', () => {
    const html = renderRichTextDocument(
      doc([{ type: 'media', attrs: { mediaId, caption: 'La légende' } }]),
      { resolveMedia: () => mediaView() },
    );
    expect(html).toContain('<figure class="kz-richtext-figure" data-kreiz-media><picture>');
    expect(html).toContain('<source type="image/avif" srcset="https://media.ex/cdn/m1/400.avif 400w, https://media.ex/cdn/m1/800.avif 800w" />');
    expect(html).toContain('<source type="image/webp" srcset="https://media.ex/cdn/m1/400.webp 400w, https://media.ex/cdn/m1/800.webp 800w" />');
    expect(html).toContain('<img src="https://media.ex/cdn/m1/800.webp" alt="Alt canonique" width="1600" height="900" loading="lazy" decoding="async" />');
    expect(html).toContain('<figcaption>La légende</figcaption>');
    // Jamais l'original, jamais l'id dans les URLs.
    expect(html).not.toContain('original');
  });

  it('alt vide → alt="" explicite (décoratif), pas d’attribut absent', () => {
    const html = renderRichTextDocument(
      doc([{ type: 'media', attrs: { mediaId } }]),
      { resolveMedia: () => mediaView({ alt: '' }) },
    );
    expect(html).toContain('alt=""');
  });

  it('média non résoluble → figure omise (jamais d’URL inventée)', () => {
    const html = renderRichTextDocument(
      doc([paragraph('Avant'), { type: 'media', attrs: { mediaId } }, paragraph('Après')]),
      NO_MEDIA,
    );
    expect(html).toBe('<p>Avant</p><p>Après</p>');
  });

  it('caption hostile échappée dans <figcaption>', () => {
    const html = renderRichTextDocument(
      doc([{ type: 'media', attrs: { mediaId, caption: '<script>alert(1)</script>' } }]),
      { resolveMedia: () => mediaView() },
    );
    expect(html).toContain('<figcaption>&lt;script&gt;alert(1)&lt;/script&gt;</figcaption>');
    expect(html).not.toContain('<script>');
  });
});

describe('tests hostiles XSS (slice 6 §36)', () => {
  it('tout texte < > & " \' est échappé', () => {
    const hostile = `<script>alert("x")</script> & 'quotes' <img src=x onerror=alert(1)>`;
    const html = renderRichTextDocument(doc([paragraph(hostile)]), NO_MEDIA);
    expect(html).toBe(`<p>${escapeHtmlText(hostile)}</p>`);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });

  it('un faux node HTML dans le document ne produit rien', () => {
    const html = renderRichTextDocument(
      doc([
        { type: 'paragraph', content: [{ type: 'text', text: 'ok' }] },
        // Objets fabriqués hors parseur : le renderer n'émet rien pour eux.
        { type: 'html', html: '<script>alert(1)</script>' } as never,
        { type: 'script' } as never,
      ]),
      NO_MEDIA,
    );
    expect(html).toBe('<p>ok</p>');
  });

  it('payload JSON hostile avec attrs inattendus : le parseur refuse, le renderer n’y est jamais exposé', () => {
    const payload = JSON.parse(`{
      "version": 1, "type": "doc",
      "content": [{
        "type": "paragraph",
        "attrs": {"class": "x", "onmouseover": "alert(1)"},
        "content": [{"type": "text", "text": "x"}]
      }]
    }`);
    expect(() => parseRichTextDocument(payload)).toThrow();
  });

  it('attributs de texte marqués hostilement : aucune sortie d’attribut contrôlée par la donnée', () => {
    // Le seul attribut piloté par la donnée est href (validé) — aucune
    // valeur de mark ne peut injecter un attribut HTML.
    const html = renderRichTextDocument(
      doc([
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'x',
              marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'strike' }, { type: 'code' }],
            },
          ],
        },
      ]),
      NO_MEDIA,
    );
    expect(html).toBe('<p><strong><em><s><code>x</code></s></em></strong></p>');
  });

  it('le rendu est déterministe : même entrée ⇒ même sortie', () => {
    const document = doc([
      paragraph('Intro'),
      { type: 'blockquote', content: [paragraph('Citation')] },
      { type: 'media', attrs: { mediaId, caption: 'L' } },
    ]);
    const ctx = { resolveMedia: () => mediaView() };
    expect(renderRichTextDocument(document, ctx)).toBe(renderRichTextDocument(document, ctx));
  });
});
