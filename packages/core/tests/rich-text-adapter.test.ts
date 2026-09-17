/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import {
  parseRichTextDocument,
  extractRichTextMediaIds,
  isBlankRichTextDocument,
} from '../src/domain/content/rich-text/document';
import { isAllowedRichTextLinkHref } from '../src/domain/content/rich-text/policy';
import { createRichTextMediaExtension } from '../src/admin/richtext/media-extension';
import {
  documentToEditorContent,
  editorJsonToDocument,
} from '../src/admin/richtext/document-adapter';

/**
 * Contrat **adaptateur ⇄ domaine** (slice 6 §7/§16/§20) — le schéma de
 * l'éditeur produit exactement le format canonique Kreiz : tout JSON sortant
 * passe la traduction de l'adaptateur puis le parseur serveur, le collage
 * est normalisé, et les fonctionnalités hors contrat (underline, h1, liens
 * dangereux) sont impossibles. Toute divergence doit se voir ICI, pas en
 * production — la configuration réplique exactement l'îlot admin.
 */

const MEDIA_ID = '11111111-1111-1111-1111-111111111111';

/** Réplique exacte des extensions de src/admin/richtext/editor.ts. */
function buildExtensions() {
  const mediaExtension = createRichTextMediaExtension({
    getMediaInfo: (id) =>
      id === MEDIA_ID
        ? { thumbnailUrl: 'https://media.ex/cdn/m1/400.webp', alt: 'Alt', width: 400, height: null }
        : undefined,
  });
  const RestrictedLink = Link.extend({
    addAttributes() {
      return {
        href: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute('href'),
        },
      };
    },
  }).configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    protocols: ['http', 'https', 'mailto'],
    defaultProtocol: 'https',
    isAllowedUri: (href) => isAllowedRichTextLinkHref(href),
  });
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      link: false,
      underline: false,
    }),
    RestrictedLink,
    mediaExtension,
  ];
}

const createdEditors: Editor[] = [];

function createEditor(content: string | Record<string, unknown> = '<p></p>'): Editor {
  const editor = new Editor({
    extensions: buildExtensions(),
    content: content as never,
  });
  createdEditors.push(editor);
  return editor;
}

// Sans destroy(), le DOMObserver de ProseMirror garde un timer actif après
// le teardown jsdom : son flush lève « document is not defined » en erreur
// non gérée et fait échouer la suite complète (vitest exit 1).
afterEach(() => {
  for (const editor of createdEditors.splice(0)) {
    editor.destroy();
  }
});

/** Sortie réelle de l'îlot : traduction puis validation serveur. */
function canonicalDocument(editor: Editor) {
  const document = editorJsonToDocument(editor.getJSON());
  return { document, validated: parseRichTextDocument(document) };
}

describe('adaptateur Tiptap ⇄ format Kreiz', () => {
  it('le JSON d’un document saisi passe la traduction puis le parseur', () => {
    const editor = createEditor();
    editor.commands.insertContent('Du texte simple.');
    const { document, validated } = canonicalDocument(editor);
    expect(document.type).toBe('doc');
    expect(document.version).toBe(1);
    expect(validated).toBeDefined();
  });

  it('HTML initial : gras, titres, listes produisent les types canoniques', () => {
    const editor = createEditor(
      '<h2>Titre</h2><p>du <strong>gras</strong> et de <em>l’italique</em></p>' +
        '<ul><li><p>une puce</p></li></ul>',
    );
    const { document } = canonicalDocument(editor);
    expect(document.content.map((node) => node.type)).toEqual(['heading', 'paragraph', 'bulletList']);
    expect(document.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
  });

  it('la traduction tamponne la version (le JSON natif Tiptap n’en a pas)', () => {
    const editor = createEditor('<p>x</p>');
    expect((editor.getJSON() as { version?: unknown }).version).toBeUndefined();
    expect(editorJsonToDocument(editor.getJSON()).version).toBe(1);
    // Rétrocession : document stocké → contenu éditeur sans clé version.
    expect(documentToEditorContent({ version: 1, type: 'doc', content: [{ type: 'paragraph' }] })).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });

  it('les marks hors contrat (underline) sont impossibles', () => {
    const editor = createEditor('<p>texte</p>');
    editor.commands.selectAll();
    // underline: false — la commande n'existe même pas sur l'éditeur.
    expect(typeof (editor.commands as Record<string, unknown>).toggleUnderline).toBe('undefined');
    expect(JSON.stringify(editor.getJSON())).not.toContain('underline');
  });

  it('h1 et h4 sont impossibles (le h1 appartient au titre du contenu)', () => {
    const editor = createEditor('<p>texte</p>');
    editor.commands.selectAll();
    expect(editor.commands.toggleHeading({ level: 1 })).toBe(false);
    expect(editor.commands.toggleHeading({ level: 4 })).toBe(false);
    expect(editor.commands.toggleHeading({ level: 2 })).toBe(true);
    expect(editor.commands.toggleHeading({ level: 3 })).toBe(true);
  });

  it('setLink refuse javascript: (politique de lien partagée)', () => {
    const editor = createEditor('<p>texte</p>');
    editor.commands.selectAll();
    expect(editor.commands.setLink({ href: 'javascript:alert(1)' })).toBe(false);
    expect(JSON.stringify(editor.getJSON())).not.toContain('link');
  });

  it('setLink accepte http(s), mailto et chemins internes', () => {
    const editor = createEditor('<p>texte</p>');
    editor.commands.selectAll();
    expect(editor.commands.setLink({ href: '/articles/x' })).toBe(true);
    expect(JSON.stringify(editor.getJSON())).toContain('/articles/x');
    expect(editor.commands.setLink({ href: 'mailto:a@b.fr' })).toBe(true);
  });

  it('le lien stocké ne porte que href (target/rel décidés au rendu)', () => {
    const editor = createEditor('<p>texte</p>');
    editor.commands.selectAll();
    editor.commands.setLink({ href: 'https://exemple.fr' });
    const paragraph = (
      editorJsonToDocument(editor.getJSON()) as {
        content: Array<{ content: Array<{ marks?: Array<Record<string, unknown>> }> }>;
      }
    ).content[0]!;
    const mark = paragraph.content![0]!.marks![0]!;
    expect(mark).toEqual({ type: 'link', attrs: { href: 'https://exemple.fr' } });
    expect(Object.keys(mark)).toEqual(['type', 'attrs']);
  });

  it('collage HTML Word-like : styles/classes/ids retirés, structure conservée', () => {
    const editor = createEditor();
    editor.commands.insertContent(
      '<meta charset="utf-8"><div>' +
        '<p style="color:red; margin:0" class="MsoNormal" id="p1">Paragraphe collé</p>' +
        '<h2 style="font-size:30px">Titre collé</h2>' +
        '<span style="font-weight:bold">Gras collé</span>' +
        '</div>',
    );
    const { document, validated } = canonicalDocument(editor);
    const serialized = JSON.stringify(validated);
    expect(serialized).not.toContain('style');
    expect(serialized).not.toContain('class');
    expect(serialized).not.toContain('MsoNormal');
    expect(document.content.map((node) => node.type)).toContain('paragraph');
    expect(JSON.stringify(document)).toContain('Paragraphe collé');
    expect(JSON.stringify(document)).toContain('Titre collé');
    expect(JSON.stringify(document)).toContain('bold');
  });

  it('collage de HTML hostile : script/attributs d’événements ne survivent pas', () => {
    const editor = createEditor();
    editor.commands.insertContent(
      '<p onclick="alert(1)">clique</p><script>alert(2)</script><p>après</p>',
    );
    const { validated } = canonicalDocument(editor);
    const serialized = JSON.stringify(validated);
    expect(serialized).not.toContain('script');
    expect(serialized).not.toContain('onclick');
    expect(serialized).toContain('après');
  });

  it('collage d’un lien javascript: : la mark est refusée, jamais de href dangereux', () => {
    const editor = createEditor();
    editor.commands.insertContent('<a href="javascript:alert(1)">piège</a>');
    const { validated } = canonicalDocument(editor);
    // Quelle que soit la stratégie du parseur (mark retirée, texte brut), la
    // sortie canonique ne contient jamais de mark link vers javascript:.
    expect(JSON.stringify(validated)).not.toContain('"type":"link"');
  });

  it('insertion de média : node atomique mediaId + caption, parseur OK, aller-retour', () => {
    const editor = createEditor();
    editor.commands.insertContent({
      type: 'media',
      attrs: { mediaId: MEDIA_ID, caption: 'Légende' },
    });
    const { document, validated } = canonicalDocument(editor);
    expect(document.content[0]).toEqual({
      type: 'media',
      attrs: { mediaId: MEDIA_ID, caption: 'Légende' },
    });
    expect(extractRichTextMediaIds(validated)).toEqual([MEDIA_ID]);
    // documentToEditorContent : l'inverse (document stocké → éditeur).
    const restored = documentToEditorContent(JSON.parse(JSON.stringify(validated)));
    expect(restored).toEqual({ type: 'doc', content: validated.content });
  });

  it('le node média peut être collé dans sa forme clipboard interne (référence à la médiathèque)', () => {
    const editor = createEditor();
    editor.commands.insertContent('<div data-media-id="88888888-4444-4444-4444-444444444444"></div>');
    const { validated } = canonicalDocument(editor);
    expect(extractRichTextMediaIds(validated)).toEqual(['88888888-4444-4444-4444-444444444444']);
  });

  it('document éditeur vide = document canonique vide (blank)', () => {
    const editor = createEditor();
    expect(isBlankRichTextDocument(editorJsonToDocument(editor.getJSON()))).toBe(true);
  });

  it('undo/redo disponibles (toolbar)', () => {
    const editor = createEditor();
    editor.commands.insertContent('abc');
    expect(editor.can().undo()).toBe(true);
    expect(editor.can().redo()).toBe(false);
  });
});
