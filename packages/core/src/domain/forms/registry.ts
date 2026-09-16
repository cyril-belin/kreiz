import {
  type ContactFormDeclaration,
  type ContactFormDefinition,
  validateContactFormShape,
} from './declaration.js';
import { contactPayloadSchemaFromFields } from './fields.js';
import { CONTACT_KEY_PATTERN } from './policy.js';

/**
 * Registre runtime des formulaires déclarés — miroir du registre des types
 * de contenu : clés uniques, forme revalidée au premier usage runtime (la
 * déclaration a déjà été validée à la définition et à la config ; cette
 * revalidation couvre le canal sérialisé du module virtuel).
 */

export interface ContactFormRegistry {
  list(): Array<ContactFormDeclaration>;
  findByKey(key: string): ContactFormDeclaration | null;
  requireByKey(key: string): ContactFormDeclaration;
}

export function createContactFormRegistry(options: {
  declarations: ReadonlyArray<ContactFormDeclaration>;
}): ContactFormRegistry {
  const byKey = new Map<string, ContactFormDeclaration>();
  const problems: string[] = [];
  for (const declaration of options.declarations) {
    if (!CONTACT_KEY_PATTERN.test(declaration.key)) {
      problems.push(`clé de formulaire invalide « ${String(declaration.key)} »`);
      continue;
    }
    if (byKey.has(declaration.key)) {
      problems.push(`clé de formulaire dupliquée « ${declaration.key} »`);
      continue;
    }
    try {
      validateContactFormShape(declaration);
    } catch (error) {
      problems.push(String((error as Error).message));
      continue;
    }
    byKey.set(declaration.key, declaration);
  }
  if (problems.length > 0) {
    throw new Error(`@kreiz/core : registre des formulaires invalide — ${problems.join(' ; ')}.`);
  }
  return {
    list: () => [...byKey.values()],
    findByKey: (key) => byKey.get(key) ?? null,
    requireByKey: (key) => {
      const declaration = byKey.get(key);
      if (!declaration) {
        throw new Error(`@kreiz/core : formulaire non déclaré « ${key} ».`);
      }
      return declaration;
    },
  };
}

/**
 * Résout une déclaration sérialisée en définition (schéma joint) — utilisé
 * par le runtime Vite : la forme sérialisée transporte la source de vérité,
 * le schéma est dérivé une seconde fois par la même fonction pure.
 */
export function resolveContactFormDefinition(
  declaration: ContactFormDeclaration,
): ContactFormDefinition {
  // Revalidation explicite (défense en profondeur sur le canal sérialisé) :
  // une déclaration mal formée est une erreur de configuration, jamais une
  // donnée traitée.
  validateContactFormShape(declaration);
  return { ...declaration, payloadSchema: contactPayloadSchemaFromFields(declaration.fields) };
}
