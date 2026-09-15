import type { APIContext } from 'astro';
import type { FieldDescriptor } from '../../domain/content/fields.js';
import { coerceRichTextValue } from '../../domain/content/rich-text/document.js';
import { emptyRichTextDocument } from '../../domain/content/rich-text/document.js';
import type { AdminAccess } from '../../http/guards.js';
import type { KreizContentRuntime } from '../../http/admin-runtime.js';
import { getKreizContentRuntime } from '../../http/admin-runtime.js';
import {
  adminSessionCookieOptions,
  ADMIN_COOKIE_PATH,
  ADMIN_SESSION_COOKIE_NAME,
} from '../../http/cookies.js';
import { resolveAdminAccess, sessionTokenFromCookies } from '../../http/guards.js';
import { adminSecurityHeaders } from '../../http/security-headers.js';
import type { ContentFieldErrors } from '../../services/content.js';
import type { FormFieldValue } from '../../http/content-form.js';

/**
 * Contexte minimal consommé par le socle commun des pages — `Astro` (global
 * des pages .astro) le satisfait structurellement ; `APIContext` seul ne
 * porte pas `response`, réservé au global Astro.
 */
export type ContentPageContext = Pick<APIContext, 'request' | 'params' | 'url'> & {
  cookies: Pick<APIContext['cookies'], 'get' | 'set' | 'delete'>;
  response: { headers: Headers };
};

/**
 * Socle commun des pages du moteur de contenu (invariants du slice 2,
 * mission §29) : en-têtes de sécurité admin, guard de session (via le
 * service auth existant — jamais un deuxième système), rafraîchissement du
 * cookie quand la glissière est prolongée. Toute page admin du Core passe
 * ici ; le logout et le login conservent leur propre chemin éprouvé.
 */
export type ContentPageAccess =
  | {
      kind: 'authenticated';
      runtime: KreizContentRuntime;
      access: Extract<AdminAccess, { kind: 'authenticated' }>;
      /** Token de session brut — requis pour vérifier le CSRF des mutations. */
      sessionToken: string;
    }
  | { kind: 'unauthenticated' };

export async function authenticateContentPage(ctx: ContentPageContext): Promise<ContentPageAccess> {
  const prod = import.meta.env.PROD;
  for (const [name, value] of Object.entries(adminSecurityHeaders({ prod }))) {
    ctx.response.headers.set(name, value);
  }
  const runtime = getKreizContentRuntime();
  const sessionToken = sessionTokenFromCookies(ctx.cookies);
  const access = await resolveAdminAccess(runtime.auth, sessionToken);
  if (access.kind === 'unauthenticated') {
    // Cookie éventuellement résiduel nettoyé, destination unique (login) —
    // aucune raison exposée (mission §27).
    ctx.cookies.delete(ADMIN_SESSION_COOKIE_NAME, { path: ADMIN_COOKIE_PATH });
    return { kind: 'unauthenticated' };
  }
  ctx.cookies.set(
    ADMIN_SESSION_COOKIE_NAME,
    sessionToken ?? '',
    adminSessionCookieOptions({ maxAgeSeconds: access.cookieMaxAgeSeconds, secure: prod }),
  );
  return { kind: 'authenticated', runtime, access, sessionToken: sessionToken ?? '' };
}

/**
 * Fusion des erreurs de validation affichées : les erreurs structurelles du
 * parseur (requis vide, paire incomplète — messages « Ce champ est
 * requis ») ont la priorité sur les issues Zod du service pour un même
 * champ ; les erreurs de titre/slug du service complètent.
 */
export function mergeContentFieldErrors(
  ...sources: Array<ContentFieldErrors>
): ContentFieldErrors {
  const merged: ContentFieldErrors = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      merged[key] ??= value;
    }
  }
  return merged;
}

/**
 * Valeurs de formulaire initiales dérivées des données stockées (édition) —
 * même forme que les valeurs brutes du parseur, pour un re-rendu fidèle.
 */
export function formValuesFromData(
  fields: Record<string, FieldDescriptor>,
  data: Record<string, unknown>,
): Record<string, FormFieldValue> {
  const values: Record<string, FormFieldValue> = {};
  for (const [name, descriptor] of Object.entries(fields)) {
    const raw = data[name];
    switch (descriptor.kind) {
      case 'text':
      case 'textarea':
      case 'url':
      case 'date':
      case 'select': {
        values[name] = { kind: 'string', value: typeof raw === 'string' ? raw : '' };
        break;
      }
      case 'richText': {
        // Le champ voyage en JSON canonique dans l'`input` caché : document
        // stocké sérialisé tel quel ; texte simple pré-slice 6 converti de
        // façon contrôlée (conversion effective au premier Save). Une donnée
        // illisible est signalée au domaine — jamais écrasée silencieusement.
        if (raw === undefined || raw === null) {
          values[name] = { kind: 'string', value: JSON.stringify(emptyRichTextDocument()) };
          break;
        }
        try {
          values[name] = { kind: 'string', value: JSON.stringify(coerceRichTextValue(raw)) };
        } catch {
          values[name] = { kind: 'string', value: '' };
        }
        break;
      }
      case 'metric': {
        const pair = (typeof raw === 'object' && raw !== null ? raw : {}) as {
          label?: unknown;
          value?: unknown;
        };
        values[name] = {
          kind: 'metric',
          label: typeof pair.label === 'string' ? pair.label : '',
          value: typeof pair.value === 'string' ? pair.value : '',
        };
        break;
      }
      case 'list': {
        if (descriptor.item.kind === 'text') {
          const items = Array.isArray(raw)
            ? raw.filter((entry): entry is string => typeof entry === 'string')
            : [];
          values[name] = { kind: 'list-string', items };
        } else {
          const items = Array.isArray(raw)
            ? raw.map((row) => {
                const pair = (typeof row === 'object' && row !== null ? row : {}) as {
                  label?: unknown;
                  value?: unknown;
                };
                return {
                  label: typeof pair.label === 'string' ? pair.label : '',
                  value: typeof pair.value === 'string' ? pair.value : '',
                };
              })
            : [];
          values[name] = { kind: 'list-metric', items };
        }
        break;
      }
    }
  }
  return values;
}
