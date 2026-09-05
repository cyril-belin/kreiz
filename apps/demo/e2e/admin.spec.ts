import { createHash } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { query } from './db';

/**
 * Parcours critiques du slice 2 (mission §27). Tout le flux utilisateur
 * passe par le navigateur ; la base n'est touchée que pour préparer des
 * états (désactivation, révocation, expiration) et vérifier les effets
 * serveur (session révoquée, audit, cookie).
 */

const LOGIN_URL = /\/admin\/login$/;

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const victimEmail = process.env.E2E_VICTIM_EMAIL as string;
const disabledEmail = process.env.E2E_DISABLED_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;

const GENERIC_ERROR = 'Email ou mot de passe invalide.';

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

function sessionCookie(page: Page): Promise<{ value: string } | undefined> {
  return page
    .context()
    .cookies()
    .then((cookies) => cookies.find((cookie) => cookie.name === 'kreiz_admin_session'));
}

function adminIdByEmail(email: string): Promise<string> {
  return query<{ id: string }>('select id from kreiz_admin_users where email = $1', [email]).then(
    (rows) => rows[0]!.id,
  );
}

test.describe('back-office — accès, login, session', () => {
  test('anonyme → /admin redirige vers /admin/login, puis login valide ouvre la session', async ({
    page,
  }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(LOGIN_URL);

    await login(page, adminEmail, adminPassword);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: /Bienvenue, Admin E2E/ })).toBeVisible();
    await expect(page.getByText(adminEmail)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Se déconnecter' })).toBeVisible();

    // Cookie sécurisé : HttpOnly, SameSite=Lax, Path=/admin (non Secure en dev HTTP).
    const cookie = await sessionCookie(page);
    expect(cookie).toBeDefined();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/admin');
    expect(cookie?.value).toHaveLength(43);
  });

  test('/admin/login déjà authentifié redirige vers /admin', async ({ page }) => {
    await login(page, adminEmail, adminPassword);
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/login');
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('identifiants invalides : message générique, email préservé, aucune session', async ({
    page,
  }) => {
    // Mauvais mot de passe.
    await login(page, adminEmail, 'mauvais-mot-de-passe-e2e');
    await expect(page.getByRole('alert')).toHaveText(GENERIC_ERROR);
    await expect(page).toHaveURL(LOGIN_URL);
    await expect(page.getByLabel('Email')).toHaveValue(adminEmail);
    await expect(await sessionCookie(page)).toBeUndefined();

    // Email inconnu : message strictement équivalent (anti-énumération).
    await login(page, 'inconnu-e2e@example.test', 'mauvais-mot-de-passe-e2e');
    await expect(page.getByRole('alert')).toHaveText(GENERIC_ERROR);
    await expect(await sessionCookie(page)).toBeUndefined();
  });

  test('admin désactivé : login refusé, session existante invalidée', async ({ page }) => {
    // Créé désactivé en base avant le test.
    await query('update kreiz_admin_users set disabled_at = now() where email = $1', [
      disabledEmail,
    ]);
    await login(page, disabledEmail, adminPassword);
    await expect(page.getByRole('alert')).toHaveText(GENERIC_ERROR);
    await expect(await sessionCookie(page)).toBeUndefined();

    // Un admin désactivé APRÈS login perd sa session existante.
    await login(page, victimEmail, adminPassword);
    await expect(page).toHaveURL(/\/admin$/);
    await query('update kreiz_admin_users set disabled_at = now() where email = $1', [
      victimEmail,
    ]);
    await page.goto('/admin');
    await expect(page).toHaveURL(LOGIN_URL);
  });

  test('logout : POST + CSRF, session révoquée en base, cookie invalidé', async ({ page }) => {
    await login(page, adminEmail, adminPassword);
    await expect(page).toHaveURL(/\/admin$/);
    const cookieBefore = await sessionCookie(page);
    expect(cookieBefore).toBeDefined();

    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect(page).toHaveURL(LOGIN_URL);
    await expect(await sessionCookie(page)).toBeUndefined();

    // Preuve en base : la session a bien été révoquée (pas seulement le cookie).
    const adminId = await adminIdByEmail(adminEmail);
    const rows = await query<{ count: string }>(
      'select count(*)::text as count from kreiz_admin_sessions where admin_id = $1 and revoked_at is not null',
      [adminId],
    );
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(1);

    // Le cookie supprimé ne suffit pas à rouvrir : /admin renvoie au login.
    await page.goto('/admin');
    await expect(page).toHaveURL(LOGIN_URL);
  });

  test('mutation admin sans CSRF ou avec CSRF invalide → 403, session intacte', async ({
    page,
  }) => {
    await login(page, adminEmail, adminPassword);
    await expect(page).toHaveURL(/\/admin$/);

    // Sans token CSRF.
    const withoutToken = await page.evaluate(async () => {
      const response = await fetch('/admin/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      return response.status;
    });
    expect(withoutToken).toBe(403);

    // Avec un token invalide.
    const withBadToken = await page.evaluate(async () => {
      const response = await fetch('/admin/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf_token: 'token-falsifie' }).toString(),
      });
      return response.status;
    });
    expect(withBadToken).toBe(403);

    // La session survit aux tentatives refusées.
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin$/);
  });

  test('session révoquée en base → accès refusé', async ({ page }) => {
    await login(page, adminEmail, adminPassword);
    await expect(page).toHaveURL(/\/admin$/);

    const adminId = await adminIdByEmail(adminEmail);
    await query(
      'update kreiz_admin_sessions set revoked_at = now() where admin_id = $1 and revoked_at is null',
      [adminId],
    );
    await page.goto('/admin');
    await expect(page).toHaveURL(LOGIN_URL);
  });

  test('session expirée (glissante) → accès refusé', async ({ page }) => {
    await login(page, adminEmail, adminPassword);
    await expect(page).toHaveURL(/\/admin$/);

    const adminId = await adminIdByEmail(adminEmail);
    await query(
      "update kreiz_admin_sessions set expires_at = now() - interval '1 hour' where admin_id = $1 and revoked_at is null",
      [adminId],
    );
    await page.goto('/admin');
    await expect(page).toHaveURL(LOGIN_URL);
  });

  test('le token stocké en base est un hash — jamais le token du cookie', async ({ page }) => {
    await login(page, adminEmail, adminPassword);
    const cookie = await sessionCookie(page);
    expect(cookie).toBeDefined();

    const adminId = await adminIdByEmail(adminEmail);
    const rows = await query<{ token_hash: string }>(
      'select token_hash from kreiz_admin_sessions where admin_id = $1 order by created_at desc limit 1',
      [adminId],
    );
    const expectedHash = createHash('sha256').update(cookie!.value, 'utf8').digest('hex');
    expect(rows[0]!.token_hash).toBe(expectedHash);
    expect(rows[0]!.token_hash).not.toContain(cookie!.value);
  });
});
