/**
 * Protection des mutations admin — complément du CSRF et du `checkOrigin`
 * natif d'Astro (actif par défaut : les POST de formulaires cross-origin
 * reçoivent déjà un 403 d'Astro, cadrage §16).
 *
 * Deux signaux navigateur sont exploités ici **en complément**, jamais en
 * remplacement du token CSRF :
 * - **Fetch Metadata** (`Sec-Fetch-Site`) : une mutation non same-origin
 *   est refusée quand le header est présent (tous les navigateurs
 *   modernes) ;
 * - **Origin** : si le header est présent, son hôte doit correspondre à
 *   l'hôte de la requête — couvre les cas où le content-type sort du
 *   périmètre de `checkOrigin`.
 *
 * Un client sans ces headers (curl, serveur) n'est pas un vecteur CSRF :
 * il ne porte pas le cookie d'une victime navigateur. Les requêtes
 * légitimes du back-office ne dépendent d'aucun de ces deux headers.
 */
export function isTrustedSameSiteMutation(request: Request): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin') {
    return false;
  }

  const origin = request.headers.get('origin');
  if (origin) {
    let requestHost: string | null;
    try {
      requestHost = new URL(request.url).host;
    } catch {
      requestHost = null;
    }
    let originHost: string | null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!requestHost || !originHost || requestHost !== originHost) {
      return false;
    }
  }

  return true;
}
