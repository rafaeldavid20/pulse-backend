import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { mcpKeyPepper, githubAppId, githubAppPrivateKeyB64 } from '../common/secrets';
import { signShortJwt, verifyShortJwt } from '../common/utils/short-jwt';
import { getInstallation, listInstallationRepos } from './client';

const PULSE_APP_URL = 'https://pulse-app--pulse-app-93.us-east4.hosted.app';

interface InstallState {
  workspaceId: string;
  uid: string;
}

/**
 * Builds the signed `state` for a "Install App" link
 * (`github.com/apps/<slug>/installations/new?state=...`). Short-lived (5
 * min) and HMAC-signed with the same pepper already used for API keys — the
 * *raw* workspaceId can't be used here, since anyone who saw it in a URL
 * could link their own GitHub installation to your workspace.
 */
export function buildInstallState(workspaceId: string, uid: string): string {
  const payload: InstallState = { workspaceId, uid };
  return signShortJwt(payload, mcpKeyPepper.value(), 5 * 60);
}

async function isWorkspaceAdmin(workspaceId: string, uid: string): Promise<boolean> {
  const snap = await getFirestore().collection('members').doc(`${workspaceId}_${uid}`).get();
  if (!snap.exists) return false;
  const role = snap.data()!.role;
  return role === 'owner' || role === 'admin';
}

/**
 * Post-installation redirect target configured as the App's "Setup URL".
 * GitHub calls this with `installation_id`, `setup_action`, and — because we
 * put it in the install link — our own signed `state`. This is where the
 * `github_installations/{installationId}` doc actually gets written.
 */
export const githubSetup = onRequest(
  { region: 'us-east4', secrets: [mcpKeyPepper, githubAppId, githubAppPrivateKeyB64] },
  async (req, res) => {
    const installationId = req.query.installation_id as string | undefined;
    const state = req.query.state as string | undefined;

    if (!installationId || !state) {
      res.status(400).send('Falta installation_id o state.');
      return;
    }

    const claims = verifyShortJwt<InstallState>(state, mcpKeyPepper.value());
    if (!claims) {
      res.status(400).send('El link de instalación expiró o es inválido. Volvé a intentar desde Settings.');
      return;
    }

    const allowed = await isWorkspaceAdmin(claims.workspaceId, claims.uid);
    if (!allowed) {
      res.status(403).send('Solo un admin/owner del workspace puede conectar GitHub.');
      return;
    }

    try {
      const [installation, repos] = await Promise.all([
        getInstallation(installationId),
        listInstallationRepos(installationId),
      ]);

      await getFirestore()
        .collection('github_installations')
        .doc(installationId)
        .set(
          {
            installationId,
            workspaceId: claims.workspaceId,
            accountLogin: installation.account.login,
            repositories: repos.map((r) => ({ id: r.id, fullName: r.full_name, defaultBranch: r.default_branch })),
            connectedBy: claims.uid,
            connectedAt: new Date().toISOString(),
          },
          { merge: true }
        );

      res.redirect(302, `${PULSE_APP_URL}/settings?github=connected`);
    } catch (err: any) {
      console.error('[githubSetup] Failed to record installation:', err);
      res.redirect(302, `${PULSE_APP_URL}/settings?github=error`);
    }
  }
);

/**
 * The App's "Callback URL" — only meaningfully hit if "Request user
 * authorization (OAuth) during installation" is enabled, which this App
 * doesn't use (Pulse already has its own identity via Firebase Auth). Kept
 * as a safety net: some installation flows land here instead of the Setup
 * URL depending on account type, so it just forwards to the same handler.
 */
export const githubCallback = onRequest({ region: 'us-east4', secrets: [mcpKeyPepper] }, async (req, res) => {
  if (req.query.installation_id) {
    const qs = new URLSearchParams(req.query as Record<string, string>).toString();
    res.redirect(302, `/githubSetup?${qs}`);
    return;
  }
  res.redirect(302, `${PULSE_APP_URL}/settings`);
});
