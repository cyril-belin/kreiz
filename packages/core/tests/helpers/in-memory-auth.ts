import type { AdminAuthDeps } from '../../src/services/admin-auth';
import type { KreizAdminAuditLog } from '../../src/data/tables/admin-audit-log';
import type { KreizAdminSession } from '../../src/data/tables/admin-sessions';
import type { KreizAdminUser } from '../../src/data/tables/admin-users';
import type { KreizRateLimit } from '../../src/data/tables/rate-limits';

/**
 * Dépendances du service auth **en mémoire** — double de test pour les
 * règles de domaine sans PostgreSQL (CLI, guards, flow login). Les
 * comportements PostgreSQL réels (unicité, atomique, FK) restent couverts
 * par les tests d'intégration sur Neon.
 */

export function stubAdminUser(values: Partial<KreizAdminUser> = {}): KreizAdminUser {
  return {
    id: crypto.randomUUID(),
    email: 'admin@example.test',
    passwordHash: 'hash-factice',
    name: 'Admin Test',
    disabledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...values,
  };
}

export function stubSession(values: Partial<KreizAdminSession> = {}): KreizAdminSession {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    adminId: crypto.randomUUID(),
    tokenHash: 'hash-factice',
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 14 * 24 * 3600 * 1000),
    absoluteExpiresAt: new Date(now.getTime() + 90 * 24 * 3600 * 1000),
    revokedAt: null,
    ...values,
  };
}

export type InMemoryAuthState = {
  users: Map<string, KreizAdminUser>;
  /** Clé = tokenHash. */
  sessions: Map<string, KreizAdminSession>;
  auditRows: KreizAdminAuditLog[];
  counters: Map<string, { count: number; windowStartedAt: Date }>;
};

export function createInMemoryAuthDeps(): { deps: AdminAuthDeps; state: InMemoryAuthState } {
  const state: InMemoryAuthState = {
    users: new Map(),
    sessions: new Map(),
    auditRows: [],
    counters: new Map(),
  };

  const deps: AdminAuthDeps = {
    secret: 'test-secret-32-octets-minimum-ok!',
    adminUsers: {
      async create(values) {
        const row: KreizAdminUser = {
          id: crypto.randomUUID(),
          email: String(values.email),
          passwordHash: String(values.passwordHash),
          name: String(values.name),
          disabledAt: values.disabledAt ?? null,
          createdAt: values.createdAt ?? new Date(),
          updatedAt: values.updatedAt ?? new Date(),
        };
        if ([...state.users.values()].some((user) => user.email === row.email)) {
          const error = new Error('duplicate') as Error & { code?: string };
          error.code = '23505';
          throw error;
        }
        state.users.set(row.id, row);
        return row;
      },
      async findById(id) {
        return state.users.get(id) ?? null;
      },
      async findByEmail(email) {
        return [...state.users.values()].find((user) => user.email === email) ?? null;
      },
      async updatePasswordHash(id, passwordHash, updatedAt) {
        const user = state.users.get(id);
        if (!user) return null;
        user.passwordHash = passwordHash;
        user.updatedAt = updatedAt;
        return user;
      },
      async disable(id, disabledAt) {
        const user = state.users.get(id);
        if (!user) return null;
        user.disabledAt = disabledAt;
        user.updatedAt = disabledAt;
        return user;
      },
    },
    sessions: {
      async create(values) {
        const row: KreizAdminSession = {
          id: crypto.randomUUID(),
          adminId: String(values.adminId),
          tokenHash: String(values.tokenHash),
          createdAt: values.createdAt ?? new Date(),
          lastSeenAt: values.lastSeenAt ?? new Date(),
          expiresAt: values.expiresAt as Date,
          absoluteExpiresAt: values.absoluteExpiresAt as Date,
          revokedAt: values.revokedAt ?? null,
        };
        state.sessions.set(row.tokenHash, row);
        return row;
      },
      async findByTokenHash(tokenHash) {
        return state.sessions.get(tokenHash) ?? null;
      },
      async findById(id) {
        return [...state.sessions.values()].find((session) => session.id === id) ?? null;
      },
      async touch(id, values) {
        for (const session of state.sessions.values()) {
          if (session.id === id) {
            session.lastSeenAt = values.lastSeenAt;
            session.expiresAt = values.expiresAt;
            return session;
          }
        }
        return null;
      },
      async revoke(id, revokedAt) {
        for (const session of state.sessions.values()) {
          if (session.id === id) session.revokedAt = revokedAt;
        }
      },
      async revokeAllForAdmin(adminId, revokedAt) {
        let count = 0;
        for (const session of state.sessions.values()) {
          if (session.adminId === adminId && !session.revokedAt) {
            session.revokedAt = revokedAt;
            count += 1;
          }
        }
        return count;
      },
      async purgeExpired(before) {
        let count = 0;
        for (const [hash, session] of state.sessions) {
          if (session.absoluteExpiresAt < before) {
            state.sessions.delete(hash);
            count += 1;
          }
        }
        return count;
      },
    },
    audit: {
      async append(event) {
        const row: KreizAdminAuditLog = {
          id: crypto.randomUUID(),
          actorAdminId: event.actorAdminId,
          action: event.action,
          entityType: event.entityType,
          entityId: event.entityId,
          metadata: event.metadata ?? {},
          createdAt: new Date(),
        };
        state.auditRows.push(row);
        return row;
      },
    },
    rateLimits: {
      async incrementWindowed(key, options) {
        const existing = state.counters.get(key);
        const cutoff = options.now.getTime() - options.windowMs;
        if (!existing || existing.windowStartedAt.getTime() < cutoff) {
          const fresh = { count: 1, windowStartedAt: options.now };
          state.counters.set(key, fresh);
          return { key, count: fresh.count, windowStartedAt: fresh.windowStartedAt };
        }
        existing.count += 1;
        const row: Pick<KreizRateLimit, 'key' | 'windowStartedAt' | 'count'> = {
          key,
          count: existing.count,
          windowStartedAt: existing.windowStartedAt,
        };
        return row;
      },
      async get(key) {
        const counter = state.counters.get(key);
        return counter ? { key, ...counter } : null;
      },
      async reset(keys) {
        for (const key of keys) state.counters.delete(key);
      },
      async purgeExpired(before) {
        let count = 0;
        for (const [key, counter] of state.counters) {
          if (counter.windowStartedAt < before) {
            state.counters.delete(key);
            count += 1;
          }
        }
        return count;
      },
    },
  };

  return { deps, state };
}
