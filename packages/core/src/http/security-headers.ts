/**
 * En-têtes de sécurité des réponses `/admin`.
 *
 * Le CSP applicatif (script-src/style-src avec hashes) est la capacité
 * native d'Astro (`security.csp`, activée par l'application consommatrice)
 * — aucune infrastructure maison de hashes/nonces ici (cadrage §16).
 * L'en-tête CSP ci-dessous ne porte que `frame-ancestors`, directive que
 * les navigateurs ignorent dans un `<meta>` : c'est le **complément**
 * obligatoire, et il n'interdit rien de plus que la politique native
 * (les politiques multiples s'intersectent — un header restreint ne
 * bloque jamais ce que le `<meta>` d'Astro autorise).
 */
export type AdminSecurityHeadersOptions = {
  /** `true` en production — HSTS uniquement quand le site est en HTTPS. */
  prod: boolean;
};

export function adminSecurityHeaders(options: AdminSecurityHeadersOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    // Chromium annule l'header Origin des POST de formulaires quand la
    // politique est `no-referrer` — ce qui casse la validation Origin
    // (checkOrigin natif Astro). `strict-origin-when-cross-origin` (défaut
    // navigateur) préserve l'Origin same-origin sans fuir les URL complètes
    // cross-origin : c'est la politique compatible CSRF validée en test.
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    // Back-office non indexable (header + <meta> dans les pages).
    'x-robots-tag': 'noindex, nofollow',
    // Anti-clickjacking : frame-ancestors moderne + XFO historique.
    'content-security-policy': "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  };
  if (options.prod) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}
