import config from 'virtual:kreiz/config';
import { createContactFormRegistry, type ContactFormRegistry } from '../domain/forms/registry.js';

/**
 * Registre runtime des formulaires déclarés — fin du canal
 * `Project → kreiz({ forms: [...] }) → virtual:kreiz/config → Core`, à
 * l'image du registre des types de contenu.
 *
 * Memoïsé par processus : le module virtuel est une constante du bundle.
 * Ce module n'est importable **que** dans un contexte Vite/Astro ; les
 * services et tests reçoivent un registre ou une déclaration injectée.
 */

let cachedRegistry: ContactFormRegistry | null = null;

export function getContactFormRegistry(): ContactFormRegistry {
  cachedRegistry ??= createContactFormRegistry({
    declarations: config.forms ?? [],
  });
  return cachedRegistry;
}
