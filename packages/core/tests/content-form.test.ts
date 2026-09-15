import { describe, expect, it } from 'vitest';
import { fields } from '../src/domain/content/declaration';
import { parseContentForm } from '../src/http/content-form';
import { emptyRichTextDocument } from '../src/domain/content/rich-text/document';

/**
 * Parseur des formulaires admin (mission §19) — whitelist stricte : seuls
 * le titre, le slug et les champs déclarés sont lus ; tout champ POSTé non
 * déclaré est ignoré. Mapping champs ⇔ formulaire (mission §33).
 */

const declarationFields = {
  excerpt: fields.text({ label: 'Accroche', required: true }),
  bio: fields.textarea({ label: 'Bio' }),
  category: fields.select({
    label: 'Catégorie',
    choices: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  }),
  link: fields.url({ label: 'Lien' }),
  day: fields.date({ label: 'Jour' }),
  weight: fields.metric({ label: 'Poids' }),
  tags: fields.list({ label: 'Tags', item: fields.text({ label: 'Tag' }) }),
  results: fields.list({ label: 'Résultats', item: fields.metric({ label: 'Résultat' }) }),
  body: fields.richText({ label: 'Corps', required: true }),
  notes: fields.richText({ label: 'Notes' }),
};

function form(entries: Record<string, string | string[]>): FormData {
  const formData = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      formData.append(name, item);
    }
  }
  return formData;
}

describe('parseContentForm', () => {
  it('extrait le titre et le slug', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: '  Mon titre  ', slug: ' mon-slug ', excerpt: 'x', category: 'a' }),
    );
    expect(parsed.title).toBe('Mon titre');
    expect(parsed.slug).toBe('mon-slug');
  });

  it('whitelist : les champs non déclarés (content_type, status, inconnus) sont ignorés', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({
        title: 'T',
        excerpt: 'ok',
        category: 'a',
        content_type: 'guide',
        route_namespace: 'guides',
        status: 'published',
        created_by: 'falsifie',
        injected: 'valeur malveillante',
      }),
    );
    expect(parsed.data).toEqual({ excerpt: 'ok', category: 'a' });
    expect(Object.keys(parsed.data)).not.toContain('content_type');
    expect(Object.keys(parsed.data)).not.toContain('status');
  });

  it('champs vides omis ; champ requis vide signalé', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', excerpt: '', bio: '', category: '', link: '', day: '' }),
    );
    // excerpt requis vide → erreur ; les optionnels vides sont simplement omis.
    expect(parsed.errors.excerpt).toBe('Ce champ est requis.');
    expect(parsed.data).toEqual({});
    expect(parsed.values.excerpt).toEqual({ kind: 'string', value: '' });
  });

  it('métrique : paire complète stockée, paire incomplète en erreur', () => {
    const ok = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', 'weight:label': 'Poids', 'weight:value': '42 kg' }),
    );
    expect(ok.data.weight).toEqual({ label: 'Poids', value: '42 kg' });

    const incomplete = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', 'weight:label': 'Poids' }),
    );
    expect(incomplete.errors.weight).toMatch(/libellé et une valeur/);
    expect(incomplete.data.weight).toBeUndefined();
  });

  it('liste de textes : getAll(name), lignes vides ignorées', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', tags: ['un', '', '  deux  ', ''] }),
    );
    expect(parsed.data.tags).toEqual(['un', 'deux']);
    expect((parsed.values.tags as { kind: string; items: string[] }).items).toEqual([
      'un',
      'deux',
    ]);
  });

  it('liste de métriques : paires alignées, lignes vides ignorées, incomplète en erreur', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({
        title: 'T',
        'results:label': ['Trafic', '', 'Conversion'],
        'results:value': ['+120 %', '', ''],
      }),
    );
    expect(parsed.data.results).toEqual([{ label: 'Trafic', value: '+120 %' }]);
    expect(parsed.errors.results).toMatch(/libellé et une valeur/);
  });

  it('les valeurs brutes sont préservées pour le re-rendu fidèle', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', excerpt: 'ok', 'results:label': ['A', ''], 'results:value': ['1', '2'] }),
    );
    expect(parsed.values.results).toEqual({
      kind: 'list-metric',
      items: [
        { label: 'A', value: '1' },
        { label: '', value: '2' },
      ],
    });
  });

  it('un formulaire vide ne produit aucune donnée, hors champs requis signalés', () => {
    const parsed = parseContentForm({ fields: declarationFields }, new FormData());
    expect(parsed.data).toEqual({});
    // excerpt et body sont requis : les erreurs structurelles sont levées par le parseur.
    expect(parsed.errors).toEqual({ excerpt: 'Ce champ est requis.', body: 'Ce champ est requis.' });
  });

  // ——— Rich text (slice 6) ———

  it('richText : JSON de document parse et stocké comme objet canonique', () => {
    const document = {
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Corps saisi.' }] }],
    };
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', excerpt: 'x', body: JSON.stringify(document) }),
    );
    expect(parsed.errors.body).toBeUndefined();
    expect(parsed.data.body).toEqual(document);
  });

  it('richText : document vide soumis passe le parseur (la blank-policy reste au schéma)', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', excerpt: 'x', body: JSON.stringify(emptyRichTextDocument()) }),
    );
    expect(parsed.errors.body).toBeUndefined();
    expect(parsed.data.body).toEqual(emptyRichTextDocument());
  });

  it('richText : JSON illisible → erreur de champ, donnée non corrompue', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', excerpt: 'x', body: '{"version": 1, "type":' }),
    );
    expect(parsed.errors.body).toMatch(/illisible/);
    expect(parsed.data.body).toBeUndefined();
  });

  it('richText : node inconnu → erreur de champ au parseur (whitelist serveur)', () => {
    const hostile = JSON.stringify({
      version: 1,
      type: 'doc',
      content: [{ type: 'rawHtml', attrs: { html: '<script>x</script>' } }],
    });
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', excerpt: 'x', body: hostile }),
    );
    expect(parsed.errors.body).toMatch(/invalide|inconnu/i);
    expect(parsed.data.body).toBeUndefined();
  });

  it('richText optionnel vide : simplement omis', () => {
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', excerpt: 'x', body: 'x', notes: '' }),
    );
    expect(parsed.errors.notes).toBeUndefined();
    expect(parsed.data.notes).toBeUndefined();
  });

  it('richText : sans JavaScript, la valeur serveur repart inchangée', () => {
    // Re-soumission du JSON sérialisé par le serveur = roundtrip identique.
    const stored = JSON.stringify({
      version: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stocké.' }] }],
    });
    const parsed = parseContentForm(
      { fields: declarationFields },
      form({ title: 'T', excerpt: 'x', body: stored }),
    );
    expect(JSON.stringify(parsed.data.body)).toEqual(stored);
  });
});
