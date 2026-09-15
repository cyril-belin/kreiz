/**
 * Erreurs du domaine rich text — codes stables (machines) + messages
 * français prêts à afficher (admins). Le parseur ne leve que ces erreurs :
 * la frontière HTTP les traduit en erreurs de champ, jamais en stack trace.
 */

export type RichTextDocumentErrorCode =
  | 'not-json-object'
  | 'unknown-version'
  | 'unknown-node'
  | 'unknown-mark'
  | 'invalid-structure'
  | 'invalid-link'
  | 'too-large'
  | 'too-many-nodes'
  | 'depth-exceeded';

export class KreizRichTextError extends Error {
  override readonly name: string = 'KreizRichTextError';
}

/** Document riche refusé — `code` stable, `message` français affichable. */
export class RichTextDocumentError extends KreizRichTextError {
  override readonly name = 'RichTextDocumentError';
  readonly code: RichTextDocumentErrorCode;

  constructor(code: RichTextDocumentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Message français, prêt à afficher, pour une erreur de document riche. */
export function richTextDocumentErrorMessage(error: RichTextDocumentError): string {
  switch (error.code) {
    case 'not-json-object':
      return 'Document riche illisible (objet attendu).';
    case 'unknown-version':
      return 'Version de document riche inconnue — le format a peut-être évolué.';
    case 'unknown-node':
    case 'unknown-mark':
    case 'invalid-structure':
      return 'Document riche invalide — un élément de mise en forme n’est pas autorisé.';
    case 'invalid-link':
      return 'Lien invalide — seuls les liens http(s), mailto et les chemins internes sont autorisés.';
    case 'too-large':
      return 'Document trop volumineux.';
    case 'too-many-nodes':
      return 'Document trop long (nombre d’éléments maximal atteint).';
    case 'depth-exceeded':
      return 'Document trop profondément imbriqué (citations ou listes).';
  }
}
