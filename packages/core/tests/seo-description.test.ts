import { describe, expect, it } from 'vitest';
import { richTextDocumentToPlainText } from '../src/domain/seo/description';
import { emptyRichTextDocument, parseRichTextDocument } from '../src/domain/content/rich-text/document';

/**
 * Repli description : document canonique → texte brut (mission §7/§23).
 * Jamais de parsing du HTML rendu ; médias et séparateurs exclus ;
 * whitespace compacté ; troncature sur frontière de mot.
 */

const RICH_TEXT_VERSION = 1;

function doc(blocks: unknown) {
  return parseRichTextDocument({ version: RICH_TEXT_VERSION, type: 'doc', content: blocks });
}

describe('richTextDocumentToPlainText', () => {
  it('document vide : texte vide', () => {
    expect(richTextDocumentToPlainText(emptyRichTextDocument(), 300)).toBe('');
  });

  it('concatène paragraphes et titres dans l’ordre de lecture', () => {
    const text = richTextDocumentToPlainText(
      doc([
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Introduction' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Premier paragraphe.' }, { type: 'hardBreak' }, { type: 'text', text: 'Suite.' }] },
      ]),
      300,
    );
    expect(text).toBe('Introduction Premier paragraphe. Suite.');
  });

  it('traverse listes et citations ; ignore médias et séparateurs', () => {
    const text = richTextDocumentToPlainText(
      doc([
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Puce un' }] }] },
          ],
        },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Citation.' }] }] },
        { type: 'media', attrs: { mediaId: crypto.randomUUID(), caption: 'Légende ignorée' } },
        { type: 'horizontalRule' },
      ]),
      300,
    );
    expect(text).toBe('Puce un Citation.');
    expect(text).not.toContain('Légende');
  });

  it('compacte le whitespace et normalise les espaces html-ish', () => {
    const text = richTextDocumentToPlainText(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'a   b\n\n c\t d' }] }]),
      300,
    );
    expect(text).toBe('a b c d');
  });

  it('tronque sur une frontière de mot à la borne', () => {
    const long = doc([
      { type: 'paragraph', content: [{ type: 'text', text: 'mot '.repeat(120).trim() }] },
    ]);
    const text = richTextDocumentToPlainText(long, 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith('mot')).toBe(true);
  });

  it('le HTML/texte hostile du document reste du texte brut (échappé plus tard au rendu)', () => {
    const text = richTextDocumentToPlainText(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }]),
      300,
    );
    expect(text).toBe('<script>alert(1)</script>');
  });
});
