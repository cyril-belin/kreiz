import { describe, expect, it } from 'vitest';
import { createInMemoryAuthDeps, stubAdminUser } from './helpers/in-memory-auth';
import type { CommandIo, CommandResult } from '../src/cli/commands';
import { runAdminCreate, runAdminResetPassword } from '../src/cli/commands';
import { hashPassword, verifyPassword } from '../src/services/password';

/**
 * Commandes CLI testées **sans TTY** : les entrées arrivent par flags ou
 * par un `CommandIo` scripté — la logique de commande et l'I/O terminal
 * sont séparées (mission slice 2 §28).
 */

const VALID_PASSWORD = 'phrase-longue-de-passe-2026';

function silentIo(script: { asks?: string[]; hidden?: string[] } = {}): {
  io: CommandIo;
  asked: string[];
} {
  const asked: string[] = [];
  let askIndex = 0;
  let hiddenIndex = 0;
  return {
    asked,
    io: {
      out: () => {},
      err: () => {},
      ask: async (label) => {
        asked.push(`ask:${label}`);
        return script.asks?.[askIndex++] ?? '';
      },
      askHidden: async (label) => {
        asked.push(`hidden:${label}`);
        return script.hidden?.[hiddenIndex++] ?? '';
      },
    },
  };
}

function expectFailure(result: CommandResult): string {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.message;
}

describe('kreiz admin:create', () => {
  it('crée un admin avec des flags complets — hash Argon2id en base', async () => {
    const { deps, state } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io } = silentIo();

    const result = await runAdminCreate(
      auth,
      { email: '  Alice@Example.test ', name: 'Alice', password: VALID_PASSWORD },
      io,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.message).toContain('alice@example.test');
    const created = [...state.users.values()][0]!;
    expect(created.email).toBe('alice@example.test');
    expect(created.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(created.passwordHash, VALID_PASSWORD)).resolves.toBe(true);
    expect(created.passwordHash).not.toContain(VALID_PASSWORD);
  });

  it('refuse un email invalide et un doublon (unicité email)', async () => {
    const { deps } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io } = silentIo();

    expectFailure(
      await runAdminCreate(auth, { email: 'pas-un-email', name: 'X', password: VALID_PASSWORD }, io),
    );
    await runAdminCreate(auth, { email: 'a@b.test', name: 'A', password: VALID_PASSWORD }, io);
    const duplicate = expectFailure(
      await runAdminCreate(auth, { email: 'A@B.TEST', name: 'A2', password: VALID_PASSWORD }, io),
    );
    expect(duplicate).toContain('existe déjà');
  });

  it('refuse un mot de passe hors politique (flag explicite)', async () => {
    const { deps, state } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io } = silentIo();

    const message = expectFailure(
      await runAdminCreate(auth, { email: 'a@b.test', name: 'A', password: 'password123456' }, io),
    );
    expect(message).toContain('trop courant');
    expect(state.users.size).toBe(0);
  });

  it('mode interactif : demande email, nom, mot de passe + confirmation', async () => {
    const { deps, state } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io, asked } = silentIo({
      asks: ['bob@example.test', 'Bob'],
      hidden: [VALID_PASSWORD, VALID_PASSWORD],
    });

    const result = await runAdminCreate(auth, {}, io);

    expect(result.ok).toBe(true);
    expect(state.users.size).toBe(1);
    // Aucun mot de passe ne traverse l'interface de sortie.
    expect(asked.join('\n')).not.toContain(VALID_PASSWORD);
  });

  it('mode interactif : confirmation erronée puis abandon propre', async () => {
    const { deps, state } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io } = silentIo({
      asks: ['bob@example.test', 'Bob'],
      hidden: [
        VALID_PASSWORD,
        'autre-phrase-longue-xyz',
        VALID_PASSWORD,
        'autre-phrase-longue-xyz',
        VALID_PASSWORD,
        'autre-phrase-longue-xyz',
      ],
    });

    const result = await runAdminCreate(auth, {}, io);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toMatch(/abandon/i);
    expect(state.users.size).toBe(0);
  });

  it('mode interactif : mot de passe trop court rejeté avant confirmation', async () => {
    const { deps, state } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io } = silentIo({
      asks: ['Bob', 'bob@example.test'],
      hidden: [
        'court',
        'court',
        'court',
        'court',
        'court',
        'court',
      ],
    });

    const result = await runAdminCreate(auth, {}, io);
    expect(result.ok).toBe(false);
    expect(state.users.size).toBe(0);
  });
});

describe('kreiz admin:reset-password', () => {
  it('réinitialise le mot de passe et révoque toutes les sessions', async () => {
    const { deps, state } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io } = silentIo();

    const admin = stubAdminUser({ email: 'alice@example.test', passwordHash: await hashPassword('ancien-mot-de-passe-long') });
    state.users.set(admin.id, admin);
    const oldSession = {
      id: crypto.randomUUID(),
      adminId: admin.id,
      tokenHash: 'hash-session',
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      absoluteExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      revokedAt: null,
    };
    state.sessions.set('hash-session', oldSession);

    const result = await runAdminResetPassword(
      auth,
      { email: 'alice@example.test', password: VALID_PASSWORD },
      io,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.message).toContain('1 session');
    await expect(verifyPassword(admin.passwordHash, VALID_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(admin.passwordHash, 'ancien-mot-de-passe-long')).resolves.toBe(false);
    expect(oldSession.revokedAt).not.toBeNull();
    // Audit : le reset est journalisé comme action **opérateur (CLI)** —
    // l'acteur ne doit jamais prétendre que l'admin cible l'a réalisée
    // lui-même (invariant de revue).
    const resetRows = state.auditRows.filter((row) => row.action === 'admin.password_reset');
    expect(resetRows).toHaveLength(1);
    expect(resetRows[0]!.actorAdminId).toBeNull();
    expect(resetRows[0]!.entityId).toBe(admin.id);
    expect(resetRows[0]!.metadata).toMatchObject({ source: 'cli', revokedSessions: 1 });
  });

  it('refuse proprement un email inconnu', async () => {
    const { deps } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io } = silentIo();

    const message = expectFailure(
      await runAdminResetPassword(
        auth,
        { email: 'inconnu@example.test', password: VALID_PASSWORD },
        io,
      ),
    );
    expect(message).toContain('Aucun admin');
  });

  it('refuse un mot de passe hors politique — sessions intactes', async () => {
    const { deps, state } = createInMemoryAuthDeps();
    const auth = (await import('../src/services/admin-auth')).createAdminAuthService(deps);
    const { io } = silentIo();

    const admin = stubAdminUser({ email: 'alice@example.test', passwordHash: 'ancien-hash' });
    state.users.set(admin.id, admin);

    const message = expectFailure(
      await runAdminResetPassword(
        auth,
        { email: 'alice@example.test', password: 'alice-motdepasse-2026' },
        io,
      ),
    );
    expect(message).toContain('email');
    expect(state.users.get(admin.id)?.passwordHash).toBe('ancien-hash');
    expect(state.auditRows).toHaveLength(0);
  });
});
