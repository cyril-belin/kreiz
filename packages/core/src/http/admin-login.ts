import type { AdminAuthService } from '../services/admin-auth.js';
import { isTrustedSameSiteMutation } from './mutations.js';

/**
 * Orchestration HTTP du formulaire de login (page `/admin/login`).
 *
 * Sépare la logique de la présentation : la page .astro appelle
 * `processLoginSubmission()` et rend soit un redirect (succès), soit le
 * formulaire avec un message **générique** (anti-énumération) — l'email
 * saisi est préservé, le mot de passe n'est jamais republié ni rendu.
 */

export const LOGIN_GENERIC_ERROR = 'Email ou mot de passe invalide.';
export const LOGIN_RATE_LIMIT_ERROR =
  'Trop de tentatives. Attendez quelques minutes avant de réessayer.';
export const LOGIN_FORBIDDEN_ERROR = 'Requête refusée.';

export type LoginViewData = {
  /** Email à re-rendre dans le champ (jamais le mot de passe). */
  email: string;
  error: string | null;
};

export type LoginSubmissionResult =
  | {
      kind: 'success';
      /** Token de session brut — à placer dans le cookie HttpOnly. */
      sessionToken: string;
      cookieMaxAgeSeconds: number;
    }
  | { kind: 'render'; view: LoginViewData; status: number };

/**
 * IP du client telle que fournie par la plateforme d'exécution. La valeur
 * n'est jamais persistée : elle est HMACée (secret serveur) pour la clé
 * de rate limiting. `x-real-ip` / `x-vercel-forwarded-for` sont posés par
 * la plateforme (non falsifiables par le client **sur Vercel**) ; `x-forwarded-for` ne
 * sert qu'en secours local — sur une autre topologie proxy, cette confiance
 * doit être revalidée (dette #10, revue sécurité finale).
 *
 * **Bucketisation IPv6 /64** (revue sécurité finale) : un hôte dispose de
 * 2^64 adresses dans son /64 — sans normalisation, la rotation d'adresses
 * rend le budget par IP décoratif. L'identité de rate limiting est le /64
 * pour IPv6, l'adresse exacte pour IPv4 (CGNAT : pas de bucket /24 qui
 * punirait des visiteurs légitimes partageant une sortie).
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const realIp = headers.get('x-real-ip');
  if (realIp) return bucketIpForRateLimiting(realIp.trim());
  const vercelForwarded = headers.get('x-vercel-forwarded-for');
  if (vercelForwarded) {
    const first = vercelForwarded.split(',')[0]?.trim();
    return first ? bucketIpForRateLimiting(first) : null;
  }
  const forwardedFor = headers.get('x-forwarded-for');
  const first = forwardedFor?.split(',')[0]?.trim() || null;
  return first ? bucketIpForRateLimiting(first) : null;
}

/**
 * Normalise une IP pour le rate limiting : IPv6 → préfixe /64 (4 premiers
 * groupes de l'adresse **expansée**), IPv4 et valeurs non parsables →
 * inchangées. Pure et tolérante — une valeur étrange n'est jamais un échec,
 * elle passe au HMAC telle quelle.
 */
export function bucketIpForRateLimiting(ip: string): string {
  if (!ip.includes(':')) return ip; // IPv4 (ou valeur opaque) — inchangé
  // IPv4 mappé (ex. ::ffff:1.2.3.4) : garder l'identité v4 lisible.
  if (ip.split(':').at(-1)?.includes('.')) return ip;
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Expande une adresse IPv6 en 8 groupes hexadécimaux — `null` si imparsable. */
function expandIpv6(ip: string): string[] | null {
  const doubleColonCount = ip.split('::').length - 1;
  if (doubleColonCount > 1) return null;
  let head: string[] = [];
  let tail: string[] = [];
  if (doubleColonCount === 1) {
    const [left, right] = ip.split('::');
    head = left ? left.split(':') : [];
    tail = right ? right.split(':') : [];
  } else {
    head = ip.split(':');
  }
  const invalid = [...head, ...tail].some((group) => !/^[0-9a-f]{1,4}$/i.test(group));
  if (invalid) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
}

/** Traite une soumission POST du formulaire de login. */
export async function processLoginSubmission(
  auth: Pick<AdminAuthService, 'login'>,
  request: Request,
  options: { now?: Date } = {},
): Promise<LoginSubmissionResult> {
  if (!isTrustedSameSiteMutation(request)) {
    return {
      kind: 'render',
      view: { email: '', error: LOGIN_FORBIDDEN_ERROR },
      status: 403,
    };
  }

  let email = '';
  let password = '';
  try {
    const formData = await request.formData();
    email = String(formData.get('email') ?? '');
    password = String(formData.get('password') ?? '');
  } catch {
    return {
      kind: 'render',
      view: { email: '', error: LOGIN_GENERIC_ERROR },
      status: 400,
    };
  }

  const outcome = await auth.login({ email, password }, {
    ip: clientIpFromHeaders(request.headers),
    now: options.now,
  });

  switch (outcome.kind) {
    case 'success': {
      return {
        kind: 'success',
        sessionToken: outcome.sessionToken,
        cookieMaxAgeSeconds: Math.max(
          1,
          Math.ceil((outcome.session.expiresAt.getTime() - (options.now ?? new Date()).getTime()) / 1000),
        ),
      };
    }
    case 'rate-limited':
      return { kind: 'render', view: { email, error: LOGIN_RATE_LIMIT_ERROR }, status: 429 };
    case 'invalid-credentials':
      return { kind: 'render', view: { email, error: LOGIN_GENERIC_ERROR }, status: 401 };
  }
}
