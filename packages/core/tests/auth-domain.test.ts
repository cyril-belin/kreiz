import { describe, expect, it } from 'vitest';
import {
  checkSessionExpiry,
  isPasswordAcceptable,
  loginInputSchema,
  loginRateLimitKey,
  normalizeAdminEmail,
  parseAdminEmail,
  parseLoginInput,
  sessionTouch,
  sessionWindowFor,
  validatePasswordPolicy,
  LOGIN_RATE_LIMIT_WINDOW_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_SLIDING_TTL_MS,
  SESSION_TOUCH_THRESHOLD_MS,
} from '../src/domain/auth';

const DAY = 24 * 60 * 60 * 1000;

describe('politique de mot de passe', () => {
  it('exige la longueur minimale — sans règle de composition artificielle', () => {
    // 11 caractères, tout en minuscules, sans chiffre : trop court.
    expect(validatePasswordPolicy('courte-mdp!')).toEqual([
      { code: 'too-short', message: expect.stringContaining('12') },
    ]);
    // 12 caractères minuscules sans chiffre ni symbole : accepté.
    expect(isPasswordAcceptable('phrase-longue')).toBe(true);
  });

  it('borne la longueur maximale', () => {
    const long = 'a'.repeat(129);
    expect(validatePasswordPolicy(long).some((issue) => issue.code === 'too-long')).toBe(true);
    expect(isPasswordAcceptable('a'.repeat(128))).toBe(true);
  });

  it('refuse les valeurs manifestement inadéquates (casse ignorée)', () => {
    expect(validatePasswordPolicy('password123456789').some((i) => i.code === 'inadequate')).toBe(true);
    expect(validatePasswordPolicy('PASSWORD123456789').some((i) => i.code === 'inadequate')).toBe(true);
    expect(validatePasswordPolicy('azertyuiopqsd').some((i) => i.code === 'inadequate')).toBe(true);
    // Mais un mot long contenant le fragment n'est pas visé :
    expect(validatePasswordPolicy('passwordlonguetreslongue').some((i) => i.code === 'inadequate')).toBe(false);
  });

  it('refuse un mot de passe contenant le email (contexte fourni)', () => {
    const issues = validatePasswordPolicy('marie-admin-2026-motdepasse', {
      email: 'Marie@Example.test',
    });
    expect(issues.some((issue) => issue.code === 'contains-email')).toBe(true);
  });

  it('n’applique aucune règle de majuscule/symbole/catégorie', () => {
    expect(isPasswordAcceptable('abcdefghijkl')).toBe(true);
    expect(isPasswordAcceptable('abcdefghijkl1234')).toBe(true);
    expect(isPasswordAcceptable('ABCDEFGHIJKLMNOPQRSTUVWXYZ!')).toBe(true);
  });
});

describe('email admin', () => {
  it('normalise (trim + minuscules) pour unicité', () => {
    expect(normalizeAdminEmail('  Marie.Dupont@Example.TEST ')).toBe('marie.dupont@example.test');
  });

  it('parseAdminEmail valide le format et retourne la forme normalisée', () => {
    expect(parseAdminEmail(' Marie@Example.test ')).toBe('marie@example.test');
    expect(parseAdminEmail('pas-un-email')).toBeNull();
    expect(parseAdminEmail('a@b')).toBeNull();
  });
});

describe('validation des entrées de login', () => {
  it('accepte une soumission bien formée', () => {
    expect(parseLoginInput({ email: 'a@b.test', password: 'x'.repeat(12) })).toEqual({
      email: 'a@b.test',
      password: 'x'.repeat(12),
    });
  });

  it('rejette les formes invalides et les clés inconnues', () => {
    expect(parseLoginInput({ email: 'a@b.test' })).toBeNull();
    expect(parseLoginInput({ email: 'nope', password: 'x' })).toBeNull();
    expect(parseLoginInput({ email: 'a@b.test', password: '' })).toBeNull();
    expect(parseLoginInput({ email: 'a@b.test', password: 'x'.repeat(200) })).toBeNull();
    expect(parseLoginInput({ email: 'a@b.test', password: 'x', admin: true })).toBeNull();
    expect(parseLoginInput(null)).toBeNull();
    // La force du mot de passe n'est pas le travail du schéma de forme :
    // elle relève de la politique (validatePasswordPolicy).
    expect(loginInputSchema.safeParse({ email: 'a@b.test', password: 'x' }).success).toBe(true);
  });
});

describe('fenêtres et expiration de session', () => {
  it('sessionWindowFor applique 14 j glissants / 90 j absolus', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const window = sessionWindowFor(now);
    expect(window.expiresAt.getTime() - now.getTime()).toBe(SESSION_SLIDING_TTL_MS);
    expect(window.absoluteExpiresAt.getTime() - now.getTime()).toBe(SESSION_ABSOLUTE_TTL_MS);
  });

  it('checkSessionExpiry distingue révoqué, expirations et validité', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    expect(
      checkSessionExpiry(
        {
          revokedAt: new Date(now.getTime() - 1000),
          expiresAt: new Date(now.getTime() + DAY),
          absoluteExpiresAt: new Date(now.getTime() + 90 * DAY),
        },
        now,
      ),
    ).toEqual({ valid: false, reason: 'revoked' });

    expect(
      checkSessionExpiry(
        {
          revokedAt: null,
          expiresAt: now, // glissante échue exactement
          absoluteExpiresAt: new Date(now.getTime() + DAY),
        },
        now,
      ),
    ).toEqual({ valid: false, reason: 'sliding-expired' });

    expect(
      checkSessionExpiry(
        {
          revokedAt: null,
          expiresAt: new Date(now.getTime() + DAY),
          absoluteExpiresAt: now, // absolue échue
        },
        now,
      ),
    ).toEqual({ valid: false, reason: 'absolute-expired' });

    expect(
      checkSessionExpiry(
        {
          revokedAt: null,
          expiresAt: new Date(now.getTime() + 1000),
          absoluteExpiresAt: new Date(now.getTime() + 1000),
        },
        now,
      ),
    ).toEqual({ valid: true });
  });
});

describe('expiration glissante (touch)', () => {
  const now = new Date('2026-09-05T12:00:00Z');

  function session(lastSeenMsAgo: number, options?: { absoluteInDays?: number }) {
    return {
      lastSeenAt: new Date(now.getTime() - lastSeenMsAgo),
      expiresAt: new Date(now.getTime() - lastSeenMsAgo + SESSION_SLIDING_TTL_MS),
      absoluteExpiresAt: new Date(
        now.getTime() - lastSeenMsAgo + (options?.absoluteInDays ?? 90) * DAY,
      ),
    };
  }

  it('ne réécrit rien sous le seuil d’inactivité', () => {
    expect(sessionTouch(session(SESSION_TOUCH_THRESHOLD_MS - 1), now)).toBeNull();
    expect(sessionTouch(session(0), now)).toBeNull();
  });

  it('prolonge la glissière au-delà du seuil : last_seen = now, expires = now + 14 j', () => {
    const touch = sessionTouch(session(2 * SESSION_TOUCH_THRESHOLD_MS), now);
    expect(touch).not.toBeNull();
    expect(touch!.lastSeenAt).toEqual(now);
    expect(touch!.expiresAt.getTime() - now.getTime()).toBe(SESSION_SLIDING_TTL_MS);
  });

  it('plafonne la prolongation à la limite absolue (jamais au-delà de 90 j)', () => {
    // Créée il y a 80 jours : absolue dans 10 jours, mais glissière échue
    // depuis longtemps — la prolongation est bornée par l'absolue.
    const touch = sessionTouch(session(80 * DAY), now);
    expect(touch).not.toBeNull();
    expect(touch?.expiresAt.getTime()).toBe(
      session(80 * DAY).absoluteExpiresAt.getTime(),
    );
    expect(touch!.expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(10 * DAY);
  });

  it('cap par défaut : 90 jours depuis la création (cadrage §23.4)', () => {
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(90 * DAY);
    expect(SESSION_SLIDING_TTL_MS).toBe(14 * DAY);
    expect(LOGIN_RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe('clés de rate limiting', () => {
  it('encodent le scope et le pseudonyme déjà dérivé par l’appelant', () => {
    expect(loginRateLimitKey('email', 'abc123')).toBe('kreiz:login:v1:email:abc123');
    expect(loginRateLimitKey('ip', 'def456')).toBe('kreiz:login:v1:ip:def456');
  });
});
