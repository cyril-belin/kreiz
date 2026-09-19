import { describe, expect, it } from 'vitest';
import {
  coerceRichTextValue,
  emptyRichTextDocument,
  extractRichTextMediaIds,
  isBlankRichTextDocument,
  parseRichTextDocument,
  richTextDocumentFromPlainText,
  richTextValueSchema,
  type KreizRichTextDocument,
  type RichTextBlockNode,
} from '../src/domain/content/rich-text/document';
import { RichTextDocumentError } from '../src/domain/content/rich-text/errors';
import {
  RICH_TEXT_MAX_DEPTH,
  RICH_TEXT_MAX_JSON_BYTES,
} from '../src/domain/content/rich-text/policy';

/**
 * Format canonique Kreiz (slice 6 §3/§4/§21) — whitelist stricte : version,
 * nodes, marks, attributs, liens et bornes. Toute entropie hors schéma est
 * rejetée explicitement — le JSON n'est jamais stocké tel quel.
 */

function doc(blocks: RichTextBlockNode[]): KreizRichTextDocument {
  return { version: 1, type: 'doc', content: blocks };
}

function paragraph(text: string): RichTextBlockNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function expectCode(run: () => unknown, code: RichTextDocumentError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RichTextDocumentError);
    expect((error as RichTextDocumentError).code).toBe(code);
    expect((error as RichTextDocumentError).message.length).toBeGreaterThan(0);
    return;
  }
  throw new Error(`RichTextDocumentError (${code}) attendue — aucune levée`);
}

describe('parseRichTextDocument — documents valides', () => {
  it('accepte le document vide canonique', () => {
    expect(parseRichTextDocument(emptyRichTextDocument())).toEqual(emptyRichTextDocument());
  });

  it('accepte tous les nodes V1 avec leurs attributs autorisés', () => {
    const document = doc([
      paragraph('Intro '),
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Titre' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Sous-titre' }] },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('Puce')] }],
      },
      {
        type: 'orderedList',
        content: [{ type: 'listItem', content: [paragraph('Numéro')] }],
      },
      { type: 'blockquote', content: [paragraph('Citation')] },
      { type: 'horizontalRule' },
      { type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1;' }] },
      { type: 'media', attrs: { mediaId: crypto.randomUUID(), caption: 'Légende' } },
      { type: 'paragraph', content: [{ type: 'hardBreak' }, { type: 'text', text: 'Suite' }] },
    ]);
    expect(parseRichTextDocument(document)).toEqual(document);
  });

  it('accepte les marks autorisées et un imbriquage de marks', () => {
    const document = doc([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'gras', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'lien', marks: [{ type: 'link', attrs: { href: 'https://exemple.fr/a' } }] },
          {
            type: 'text',
            text: 'combo',
            marks: [
              { type: 'link', attrs: { href: 'https://exemple.fr' } },
              { type: 'bold' },
              { type: 'italic' },
              { type: 'strike' },
              { type: 'code' },
            ],
          },
        ],
      },
    ]);
    expect(parseRichTextDocument(document)).toEqual(document);
  });

  it('accepte les chemins internes et mailto comme liens', () => {
    const document = doc([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a', marks: [{ type: 'link', attrs: { href: '/articles/one' } }] },
          { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: 'mailto:x@y.fr' } }] },
        ],
      },
    ]);
    expect(parseRichTextDocument(document)).toEqual(document);
  });

  it('impose la canonicalité : attribut inconnu sur un node = refus (strict)', () => {
    expectCode(
      () =>
        parseRichTextDocument(doc([
          { type: 'paragraph', textAlign: 'center', content: [{ type: 'text', text: 'x' }] } as never,
        ])),
      'invalid-structure',
    );
  });
});

describe('parseRichTextDocument — documents invalides', () => {
  it('refuse non-objet, tableau et primitives', () => {
    expectCode(() => parseRichTextDocument('hello'), 'not-json-object');
    expectCode(() => parseRichTextDocument([doc([])]), 'not-json-object');
    expectCode(() => parseRichTextDocument(null), 'not-json-object');
    expectCode(() => parseRichTextDocument(42), 'not-json-object');
  });

  it('refuse une version inconnue ou absente', () => {
    expectCode(() => parseRichTextDocument({ version: 2, type: 'doc', content: [] }), 'unknown-version');
    expectCode(() => parseRichTextDocument({ type: 'doc', content: [] }), 'unknown-version');
  });

  it('refuse un type racine invalide', () => {
    expectCode(() => parseRichTextDocument({ version: 1, type: 'page', content: [] }), 'invalid-structure');
  });

  it('refuse un node inconnu', () => {
    expectCode(
      () => parseRichTextDocument(doc([{ type: 'rawHtml', attrs: { html: '<script>x</script>' } } as never])),
      'unknown-node',
    );
    expectCode(() => parseRichTextDocument(doc([{ type: 'iframe' } as never])), 'unknown-node');
  });

  it('refuse une mark inconnue', () => {
    expectCode(
      () =>
        parseRichTextDocument(
          doc([
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'x', marks: [{ type: 'underline' } as never] }],
            },
          ]),
        ),
      'unknown-mark',
    );
  });

  it('refuse les niveaux de titre interdits (h1 appartient au titre du contenu)', () => {
    expectCode(
      () =>
        parseRichTextDocument(
          doc([{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'x' }] }] as never),
        ),
      'invalid-structure',
    );
    expectCode(
      () =>
        parseRichTextDocument(
          doc([{ type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'x' }] }] as never),
        ),
      'invalid-structure',
    );
  });

  it('refuse les liens dangereux (javascript:, data:, protocol-relative)', () => {
    const withHref = (href: string) =>
      doc([
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }],
        },
      ]);
    expectCode(() => parseRichTextDocument(withHref('javascript:alert(1)')), 'invalid-link');
    expectCode(() => parseRichTextDocument(withHref('data:text/html,<script>')), 'invalid-link');
    expectCode(() => parseRichTextDocument(withHref('//exemple.fr/path')), 'invalid-link');
    expectCode(() => parseRichTextDocument(withHref('vbscript:x')), 'invalid-link');
  });

  it('refuse un lien trop long', () => {
    const long = `https://exemple.fr/${'a'.repeat(3000)}`;
    expectCode(
      () =>
        parseRichTextDocument(
          doc([
            { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: long } }] }] },
          ]),
        ),
      'invalid-link',
    );
  });

  it('refuse un node média sans mediaId', () => {
    expectCode(
      () => parseRichTextDocument(doc([{ type: 'media', attrs: {} } as never])),
      'invalid-structure',
    );
  });

  it('refuse une légende trop longue', () => {
    expectCode(
      () =>
        parseRichTextDocument(
          doc([{ type: 'media', attrs: { mediaId: 'm1', caption: 'x'.repeat(501) } }]),
        ),
      'invalid-structure',
    );
  });

  it('refuse un texte vide dans un node texte', () => {
    expectCode(
      () =>
        parseRichTextDocument(doc([{ type: 'paragraph', content: [{ type: 'text', text: '' }] } as never])),
      'invalid-structure',
    );
  });
});

describe('parseRichTextDocument — bornes défensives (slice 6 §21)', () => {
  it('refuse un document trop volumineux', () => {
    // La taille est vérifiée sur le JSON sérialisé (représentation stockée),
    // pas sur l'objet brut : un texte ~1× la limite JSON la dépasse avec
    // l'enveloppe du document.
    const giant = 'x'.repeat(RICH_TEXT_MAX_JSON_BYTES);
    expectCode(() => parseRichTextDocument(doc([paragraph(giant)])), 'too-large');
  });

  it('refuse un document au-delà du nombre maximal de nodes', () => {
    const blocks = Array.from({ length: 2100 }, (_, index) => paragraph(`p${index}`));
    expectCode(() => parseRichTextDocument(doc(blocks)), 'too-many-nodes');
  });

  it('refuse une imbrication au-delà de la profondeur maximale', () => {
    let block: RichTextBlockNode = paragraph('fond');
    for (let index = 0; index < RICH_TEXT_MAX_DEPTH + 2; index += 1) {
      block = { type: 'blockquote', content: [block] };
    }
    expectCode(() => parseRichTextDocument(doc([block])), 'depth-exceeded');
  });

  it('arbre ~1000 niveaux : erreur de domaine, jamais un RangeError de pile (revue sécurité finale)', () => {
    // Sous la borne de taille (256 KiB) mais au-delà de ce que la récursion
    // Zod tolère : le pré-scan itératif rejette avec `depth-exceeded` avant
    // d'entrer dans le schéma — pas de débordement de pile (500 brut).
    let block: RichTextBlockNode = paragraph('fond');
    for (let index = 0; index < 1_000; index += 1) {
      block = { type: 'blockquote', content: [block] };
    }
    expectCode(() => parseRichTextDocument(doc([block])), 'depth-exceeded');
  });

  it('accepte une imbrication profonde mais dans la limite', () => {
    let block: RichTextBlockNode = paragraph('fond');
    for (let index = 0; index < RICH_TEXT_MAX_DEPTH - 1; index += 1) {
      block = { type: 'blockquote', content: [block] };
    }
    expect(() => parseRichTextDocument(doc([block]))).not.toThrow();
  });
});

describe('coercition et compatibilité (slice 6 §31/§32)', () => {
  it('convertit un texte simple pré-slice 6 en paragraphes', () => {
    const document = coerceRichTextValue('Premier paragraphe.\n\nDeuxième.\nligne suivante');
    expect(document.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Premier paragraphe.' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Deuxième.' },
          { type: 'hardBreak' },
          { type: 'text', text: 'ligne suivante' },
        ],
      },
    ]);
  });

  it('convertit une chaîne vide en document vide', () => {
    expect(coerceRichTextValue('')).toEqual(emptyRichTextDocument());
  });

  it('rejette une forme non document (nombre, tableau)', () => {
    expectCode(() => coerceRichTextValue(42), 'not-json-object');
    expectCode(() => coerceRichTextValue([paragraph('x')]), 'not-json-object');
  });

  it('le schéma de champ transforme et valide (composition dataSchemaFromFields)', () => {
    const parsed = richTextValueSchema.safeParse('Hello\n\nWorld');
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.content).toHaveLength(2);
    }
    const rejected = richTextValueSchema.safeParse({ version: 9, type: 'doc', content: [] });
    expect(rejected.success).toBe(false);
    // L'issue porte un message français prêt à afficher.
    if (!rejected.success) {
      expect(rejected.error.issues[0]?.message).toContain('Version');
    }
  });
});

describe('inspection — blank et références médias', () => {
  it('isBlank : vide, paragraphes vides et seules règles horizontales', () => {
    expect(isBlankRichTextDocument(emptyRichTextDocument())).toBe(true);
    expect(isBlankRichTextDocument(doc([{ type: 'paragraph' }]))).toBe(true);
    expect(isBlankRichTextDocument(doc([paragraph('   ')]))).toBe(true);
    expect(isBlankRichTextDocument(doc([{ type: 'horizontalRule' }]))).toBe(true);
    expect(isBlankRichTextDocument(doc([paragraph('Contenu')]))).toBe(false);
    expect(
      isBlankRichTextDocument(doc([{ type: 'media', attrs: { mediaId: 'm1' } }])),
    ).toBe(false);
  });

  it('extraction des ids médias : toutes profondeurs, dédupliqués, ordre stable', () => {
    const document = doc([
      { type: 'media', attrs: { mediaId: 'a' } },
      { type: 'blockquote', content: [{ type: 'media', attrs: { mediaId: 'b' } }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'media', attrs: { mediaId: 'c' } }] },
          { type: 'listItem', content: [{ type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'media', attrs: { mediaId: 'a' } }] }] }] },
        ],
      },
      paragraph('sans média'),
    ]);
    expect(extractRichTextMediaIds(document)).toEqual(['a', 'b', 'c']);
  });

  it('richTextDocumentFromPlainText est déterministe et re-parseable', () => {
    const document = richTextDocumentFromPlainText('A\n\nB');
    expect(parseRichTextDocument(document)).toEqual(document);
  });
});
