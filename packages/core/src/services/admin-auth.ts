import type { KreizAdminUser } from '../data/tables/admin-users.js';
import type { KreizAdminSession as SessionRow } from '../data/tables/admin-sessions.js';
import type { KreizDatabase } from '../data/connection.js';
import {
  createAdminAuditLogRepository,
  createAdminSessionsRepository,
  createAdminUsersRepository,
  createRateLimitsRepository,
} from '../data/index.js';
import type {
  AdminAuditLogRepository,
  AdminSessionsRepository,
  AdminUsersRepository,
  RateLimitsRepository,
} from '../data/index.js';
import {
  LOGIN_RATE_LIMIT_MAX,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_PURGE_AFTER_MS,
  checkSessionExpiry,
  loginRateLimitKey,
  normalizeAdminEmail,
  parseLoginInput,
  sessionTouch,
  sessionWindowFor,
  validatePasswordPolicy,
  type PasswordIssue,
} from '../domain/auth.js';
import {
  deriveSessionCsrfToken,
  generateSessionToken,
  hashSessionToken,
  isPlausibleSessionToken,
  pseudonymizeIp,
} from './auth-tokens.js';
import { dummyPasswordVerify, hashPassword, verifyPassword } from './password.js';

/**
 * Service d'authentification admin — orchestration du slice 2.
 *
 * Il est le **seul** chemin vers login / validation de session / logout :
 * les routes injectées du Core et le CLI passent par lui. Il ne connaît
 * ni Astro ni le driver Neon — il reçoit des repositories et un secret.
 *
 * Comportements clés :
 * - **Anti-énumération** : email inconnu, mot de passe erroné, compte
 *   désactivé et formulaire malformé produisent le même résultat
 *   fonctionnel (`invalid-credentials`) ; un email inconnu subit quand
 *   même une vérification Argon2id « appeau » pour égaliser la latence.
 * - **Rate limiting** : incrémentation **atomique d'abord, contrôle
 *   ensuite** — chaque tentative incrémente les compteurs (email
 *   normalisé + pseudonyme d'IP) dans la même instruction PostgreSQL qui
 *   retourne le compteur : pas de course read-then-write sous concurrence
 *   serverless. Un succès réinitialise les compteurs : seuls les échecs
 *   consomment le budget (5 échecs / 15 min).
 * - **Sessions** : token brut 256 bits uniquement dans le cookie, hash
 *   SHA-256 en base, expiration glissante 14 j plafonnée par la limite
 *   absolue 90 j, révocables, invalidées si l'admin est désactivé.
 */
export type AdminAuthDeps = {
  adminUsers: AdminUsersRepository;
  sessions: AdminSessionsRepository;
  audit: AdminAuditLogRepository;
  rateLimits: RateLimitsRepository;
  /**
   * Secret de déploiement (`KREIZ_SECRET`) — clé HMAC de pseudonymisation
   * (IP et email) pour les clés de rate limiting. Requis pour `login()` ;
   * les opérations de gestion (CLI) peuvent s'en passer.
   */
  secret?: string;
};

/** Vocabulaire d'audit du slice 2 (texte libre en base, constantes ici). */
export const ADMIN_AUDIT_ACTIONS = {
  login: 'admin.login',
  logout: 'admin.logout',
  passwordReset: 'admin.password_reset',
} as const;

export type LoginOutcome =
  | {
      kind: 'success';
      admin: KreizAdminUser;
      session: SessionRow;
      /** Token brut — à placer dans le cookie, jamais loggué. */
      sessionToken: string;
      /** Token CSRF lié à la session — à rendre dans les formulaires. */
      csrfToken: string;
    }
  | { kind: 'invalid-credentials' }
  | { kind: 'rate-limited' };

export type LoginOptions = {
  now?: Date;
  /** IP source, si disponible — jamais persistée, HMACée pour la clé. */
  ip?: string | null;
};

export type SessionResolution =
  | {
      status: 'authenticated';
      admin: KreizAdminUser;
      session: SessionRow;
      csrfToken: string;
    }
  | { status: 'invalid' | 'expired' | 'revoked' | 'admin-disabled' };

export type LogoutOutcome = { kind: 'logged-out' } | { kind: 'no-active-session' };

export type CreateAdminOutcome =
  | { kind: 'created'; admin: KreizAdminUser }
  | { kind: 'invalid-password'; issues: PasswordIssue[] }
  | { kind: 'email-exists' };

export type ResetPasswordOutcome =
  | { kind: 'reset'; admin: KreizAdminUser; revokedSessions: number }
  | { kind: 'invalid-password'; issues: PasswordIssue[] }
  | { kind: 'unknown-admin' };

export type DisableAdminOutcome =
  | { kind: 'disabled'; revokedSessions: number }
  | { kind: 'unknown-admin' };

function pgErrorCode(error: unknown): string | null {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function createAdminAuthService(deps: AdminAuthDeps) {
  const { adminUsers, sessions, audit, rateLimits, secret } = deps;

  function loginRateLimitKeys(email: string, ip: string | null | undefined, keyingSecret: string): string[] {
    const keys = [loginRateLimitKey('email', pseudonymizeIp(email, keyingSecret))];
    if (ip) keys.push(loginRateLimitKey('ip', pseudonymizeIp(ip, keyingSecret)));
    return keys;
  }

  async function consumeRateLimitBudget(keys: string[], now: Date): Promise<number> {
    // Incrément atomique de chaque clé ; la fenêtre se réinitialise dans
    // la même instruction si elle a expiré. Le compteur retourné est
    // post-incrément : la tentative qui franchit la limite est bloquée.
    const counters = await Promise.all(
      keys.map((key) =>
        rateLimits.incrementWindowed(key, { windowMs: LOGIN_RATE_LIMIT_WINDOW_MS, now }),
      ),
    );
    return Math.max(...counters.map((counter) => counter.count));
  }

  return {
    /**
     * Connexion : validation → rate limit → lookup → désactivation ? →
     * vérification Argon2id → création de session → audit.
     */
    async login(input: unknown, options: LoginOptions = {}): Promise<LoginOutcome> {
      const now = options.now ?? new Date();
      if (!secret) {
        throw new Error(
          '@kreiz/core : login indisponible sans secret de déploiement (KREIZ_SECRET).',
        );
      }
      const parsed = parseLoginInput(input);
      if (!parsed) {
        // Forme invalide : message générique identique aux mauvais
        // identifiants (pas de sonde sur la validation).
        return { kind: 'invalid-credentials' };
      }
      const email = normalizeAdminEmail(parsed.email);
      const keys = loginRateLimitKeys(email, options.ip, secret);

      const maxCount = await consumeRateLimitBudget(keys, now);
      if (maxCount > LOGIN_RATE_LIMIT_MAX) {
        return { kind: 'rate-limited' };
      }

      const admin = await adminUsers.findByEmail(email);
      if (!admin) {
        // Email inconnu : appeau Argon2id pour égaliser la latence avec
        // une vraie vérification, puis échec générique.
        await dummyPasswordVerify();
        await rateLimits.purgeExpired(new Date(now.getTime() - RATE_LIMIT_PURGE_AFTER_MS));
        return { kind: 'invalid-credentials' };
      }

      const passwordOk = await verifyPassword(admin.passwordHash, parsed.password);
      if (!passwordOk || admin.disabledAt) {
        await rateLimits.purgeExpired(new Date(now.getTime() - RATE_LIMIT_PURGE_AFTER_MS));
        return { kind: 'invalid-credentials' };
      }

      const sessionToken = generateSessionToken();
      const window = sessionWindowFor(now);
      const session = await sessions.create({
        adminId: admin.id,
        tokenHash: hashSessionToken(sessionToken),
        expiresAt: window.expiresAt,
        absoluteExpiresAt: window.absoluteExpiresAt,
      });
      await audit.append({
        actorAdminId: admin.id,
        action: ADMIN_AUDIT_ACTIONS.login,
        entityType: 'admin_user',
        entityId: admin.id,
        metadata: { sessionId: session.id },
      });
      // Succès : les échecs consomment le budget, pas les connexions.
      await rateLimits.reset(keys);
      return {
        kind: 'success',
        admin,
        session,
        sessionToken,
        csrfToken: deriveSessionCsrfToken(sessionToken),
      };
    },

    /**
     * Validation d'une session depuis le token du cookie : token connu,
     * non révoqué, non expiré (glissant et absolu), admin existant et
     * non désactivé. Rafraîchit la glissière si le seuil est atteint.
     */
    async resolveSession(
      token: string | undefined | null,
      options: { now?: Date } = {},
    ): Promise<SessionResolution> {
      const now = options.now ?? new Date();
      if (!isPlausibleSessionToken(token)) {
        return { status: 'invalid' };
      }
      const session = await sessions.findByTokenHash(hashSessionToken(token));
      if (!session) {
        return { status: 'invalid' };
      }
      const expiry = checkSessionExpiry(session, now);
      if (!expiry.valid) {
        return { status: expiry.reason === 'revoked' ? 'revoked' : 'expired' };
      }
      const admin = await adminUsers.findById(session.adminId);
      if (!admin) {
        return { status: 'invalid' };
      }
      if (admin.disabledAt) {
        // Un admin désactivé ne conserve aucun accès via une session existante.
        return { status: 'admin-disabled' };
      }
      const touch = sessionTouch(session, now);
      const current = touch ? ((await sessions.touch(session.id, touch)) ?? session) : session;
      return {
        status: 'authenticated',
        admin,
        session: current,
        csrfToken: deriveSessionCsrfToken(token),
      };
    },

    /**
     * Déconnexion : exige une session active, la révoque en base et
     * journalise. L'invalidation du cookie reste à la charge de l'appelant
     * HTTP (couche routes).
     */
    async logout(token: string | undefined | null, options: { now?: Date } = {}): Promise<LogoutOutcome> {
      const now = options.now ?? new Date();
      const resolution = await this.resolveSession(token, { now });
      if (resolution.status !== 'authenticated') {
        return { kind: 'no-active-session' };
      }
      await sessions.revoke(resolution.session.id, now);
      await audit.append({
        actorAdminId: resolution.admin.id,
        action: ADMIN_AUDIT_ACTIONS.logout,
        entityType: 'admin_user',
        entityId: resolution.admin.id,
        metadata: { sessionId: resolution.session.id },
      });
      return { kind: 'logged-out' };
    },

    /** Création d'un admin (CLI V1) — email normalisé et unique, hash Argon2id. */
    async createAdmin(
      input: { email: string; name: string; password: string },
      options: { now?: Date } = {},
    ): Promise<CreateAdminOutcome> {
      const now = options.now ?? new Date();
      const email = normalizeAdminEmail(input.email);
      const issues = validatePasswordPolicy(input.password, { email });
      if (issues.length > 0) {
        return { kind: 'invalid-password', issues };
      }
      const existing = await adminUsers.findByEmail(email);
      if (existing) {
        return { kind: 'email-exists' };
      }
      try {
        const admin = await adminUsers.create({
          email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
          createdAt: now,
          updatedAt: now,
        });
        return { kind: 'created', admin };
      } catch (error) {
        // Course concurrente sur l'unicité email : même sémantique que le
        // pré-contrôle.
        if (pgErrorCode(error) === '23505') {
          return { kind: 'email-exists' };
        }
        throw error;
      }
    },

    /**
     * Réinitialisation de mot de passe (CLI V1) : nouveau hash, puis
     * révocation de toutes les sessions actives de l'admin — un reset
     * invalide toujours les accès courants.
     */
    async resetPassword(
      input: { email: string; password: string },
      options: { now?: Date } = {},
    ): Promise<ResetPasswordOutcome> {
      const now = options.now ?? new Date();
      const email = normalizeAdminEmail(input.email);
      const admin = await adminUsers.findByEmail(email);
      if (!admin) {
        return { kind: 'unknown-admin' };
      }
      const issues = validatePasswordPolicy(input.password, { email });
      if (issues.length > 0) {
        return { kind: 'invalid-password', issues };
      }
      const updated = await adminUsers.updatePasswordHash(
        admin.id,
        await hashPassword(input.password),
        now,
      );
      if (!updated) {
        return { kind: 'unknown-admin' };
      }
      const revokedSessions = await sessions.revokeAllForAdmin(admin.id, now);
      // Action **opérateur/système** (CLI, aucune session admin) :
      // actor_admin_id = NULL — l'admin cible est désigné par entity_id.
      // L'audit ne doit jamais prétendre que l'admin a lui-même réalisé
      // l'action. La source réelle est portée par metadata.source.
      await audit.append({
        actorAdminId: null,
        action: ADMIN_AUDIT_ACTIONS.passwordReset,
        entityType: 'admin_user',
        entityId: admin.id,
        metadata: { source: 'cli', revokedSessions },
      });
      return { kind: 'reset', admin: updated, revokedSessions };
    },

    /**
     * Désactivation d'un admin (helper de domaine — utilisé par les tests
     * et disponible pour un futur back-office) : `disabled_at` + révocation
     * de toutes les sessions actives. Jamais de suppression physique.
     */
    async disableAdmin(
      id: string,
      options: { now?: Date } = {},
    ): Promise<DisableAdminOutcome> {
      const now = options.now ?? new Date();
      const admin = await adminUsers.findById(id);
      if (!admin) {
        return { kind: 'unknown-admin' };
      }
      const updated = await adminUsers.disable(id, now);
      if (!updated) {
        return { kind: 'unknown-admin' };
      }
      const revokedSessions = await sessions.revokeAllForAdmin(id, now);
      return { kind: 'disabled', revokedSessions };
    },
  };
}

export type AdminAuthService = ReturnType<typeof createAdminAuthService>;

/**
 * Câblage standard du service sur une base Drizzle — utilisé par la
 * composition root des routes admin et par le CLI. `secret` est requis
 * pour le login (routes) ; le CLI, qui ne connecte jamais, s'en passe.
 */
export function createAdminAuthServiceForDatabase(
  db: KreizDatabase,
  options: { secret?: string } = {},
): AdminAuthService {
  return createAdminAuthService({
    adminUsers: createAdminUsersRepository(db),
    sessions: createAdminSessionsRepository(db),
    audit: createAdminAuditLogRepository(db),
    rateLimits: createRateLimitsRepository(db),
    secret: options.secret,
  });
}
