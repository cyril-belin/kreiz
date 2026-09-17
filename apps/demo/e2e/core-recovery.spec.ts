import { expect, test } from '@playwright/test';
import { query } from './db';
import { capturedMails, resetMailCaptures, setMailFailMode } from './mail-capture-server';

/**
 * E2E GLOBAL (slice 10) — parcours de récupération réel, transversal
 * public/formulaires/mailer/admin/audit. Preuve que le mécanisme
 * opérationnel « une panne de transport ne perd jamais une demande »
 * n'est pas une fonction morte : le visiteur soumet **pendant** la panne,
 * la demande est persistée, l'admin la voit en échec, la relance livre le
 * message, et l'audit raconte l'histoire complète.
 *
 * Les balayages de rattrapage automatisés (cron futur —
 * `runNotificationRecovery` côté formulaires, `retryFailedMedia` /
 * `processStuckMedia` côté médias) sont couverts par les tests unitaires
 * et d'intégration du Core ; ils ne sont pas exposés par HTTP en V1.
 * La relance manuelle admin testée ici est le même chemin métier.
 */

const adminEmail = process.env.E2E_ADMIN_EMAIL as string;
const adminPassword = process.env.E2E_ADMIN_PASSWORD as string;
const runId = Math.random().toString(36).slice(2, 8);

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(adminEmail);
  await page.getByLabel('Mot de passe').fill(adminPassword);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test.describe('Kreiz Core — récupération opérationnelle (slice 10)', () => {
  test('panne du transport email : demande conservée, relance admin, message livré, audit complet', async ({
    page,
  }) => {
    const contactEmail = `e2e-recovery-${runId}@example.test`;
    await query("delete from kreiz_rate_limits where key like 'contact:%'");
    await setMailFailMode(true);
    await resetMailCaptures();

    // 1. Le visiteur soumet depuis le site public PENDANT la panne —
    //    côté visiteur, tout est un succès (mission : jamais d'erreur
    //    visible, jamais de perte).
    await page.goto('/contact');
    await page.waitForTimeout(3200);
    await page.getByLabel('Nom').fill('Panne parcours global');
    await page.getByLabel('Email').fill(contactEmail);
    await page.getByLabel('Sujet').selectOption('question');
    await page.getByLabel('Message').fill('Soumis pendant la panne du relais.');
    await page.getByRole('checkbox', { name: /consentement|J.accepte/i }).check();
    await page.getByRole('button', { name: /Envoyer/i }).click();
    await expect(page).toHaveURL(/\/contact\/merci$/);

    // La demande est en base, marquée en échec de notification.
    const stored = await query<{
      id: string;
      status: string;
      notification_status: string;
      notification_attempts: number;
    }>(
      "select id, status, notification_status, notification_attempts from kreiz_contact_requests where payload->>'email' = $1",
      [contactEmail],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe('new');
    expect(stored[0]!.notification_status).toBe('failed');
    expect(stored[0]!.notification_attempts).toBe(1);

    // 2. L'admin voit la demande en échec et peut relancer.
    await login(page);
    await page.goto('/admin/forms');
    await page.getByRole('link', { name: 'Consulter' }).first().click();
    await expect(page.getByText('Panne parcours global')).toBeVisible();
    await expect(page.getByText(/Échec après 1 tentative/)).toBeVisible();

    // 3. Transport rétabli → relance → livré, enveloppe intacte.
    await setMailFailMode(false);
    await resetMailCaptures();
    await page.getByRole('button', { name: 'Renvoyer la notification' }).click();
    await expect(page.getByText('Notification envoyée.')).toBeVisible();

    const recovered = await query<{ notification_status: string; notified_at: string }>(
      'select notification_status, notified_at::text from kreiz_contact_requests where id = $1',
      [stored[0]!.id],
    );
    expect(recovered[0]!.notification_status).toBe('sent');
    expect(recovered[0]!.notified_at).toBeTruthy();

    const mails = await capturedMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]!.replyTo?.email).toBe(contactEmail);
    expect(mails[0]!.text).toContain('Soumis pendant la panne du relais.');

    // 4. L'audit raconte la panne ET la relance (la livraison réussie,
    //    elle, est un état de la demande — pas un événement d'audit).
    const audit = await query<{ action: string }>(
      'select action from kreiz_admin_audit_log where entity_type = $1 and entity_id = $2 order by created_at',
      ['contact_request', stored[0]!.id],
    );
    expect(audit.map((row) => row.action)).toEqual([
      'contact.submitted',
      'contact.notification_failed',
      'contact.notification_retried',
    ]);
  });
});
