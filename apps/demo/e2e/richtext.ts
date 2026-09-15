/**
 * Helpers rich text (slice 6) — lecture du **document canonique Kreiz**
 * stocké en JSONB et de l'`input` caché qui porte la valeur de l'éditeur.
 * Les assertions E2E vérifient le document, jamais son HTML.
 */

export interface RichTextDocJson {
  version: number;
  type: 'doc';
  content: Array<Record<string, unknown>>;
}

/** Texte brut d'un document stocké (pour les assertions en base). */
export function bodyText(value: unknown): string {
  const document = value as { content?: Array<Record<string, unknown>> } | null;
  function walk(nodes: Array<Record<string, unknown>>): string {
    return nodes
      .map((node) => {
        if (node['type'] === 'text') return String(node['text'] ?? '');
        if (node['type'] === 'hardBreak') return '\n';
        return walk((node['content'] as Array<Record<string, unknown>>) ?? []);
      })
      .join('');
  }
  return walk(document?.content ?? []);
}

/** Valeur courante de l'éditeur (JSON de l'`input` caché), parsée. */
export async function editorDocument(
  page: import('@playwright/test').Page,
  fieldName = 'body',
): Promise<RichTextDocJson> {
  const raw = await page.locator(`input[name="${fieldName}"]`).inputValue();
  return JSON.parse(raw) as RichTextDocJson;
}

/** Paragraphes de texte du document éditeur courant. */
export async function editorDocumentText(
  page: import('@playwright/test').Page,
  fieldName = 'body',
): Promise<string> {
  return bodyText(await editorDocument(page, fieldName));
}
