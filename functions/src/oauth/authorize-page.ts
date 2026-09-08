import { FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID } from './constants';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safe to interpolate inside an inline `<script>` tag: JSON.stringify alone
 * isn't enough because a `</script>` substring inside a string value would
 * still close the tag early in an HTML parser.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b0c0f; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { background: #17181c; border: 1px solid #2a2b31; border-radius: 12px; padding: 32px; width: 360px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #9a9ba3; font-size: 13px; margin: 0 0 20px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 10px; border-radius: 8px; border: 1px solid #33343b; background: #0f1013; color: #e6e6e6; }
  button { width: 100%; padding: 10px 12px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; margin-bottom: 10px; }
  button.primary { background: #5b8cff; color: white; }
  button.google { background: #fff; color: #1f1f1f; }
  button.secondary { background: transparent; color: #9a9ba3; border: 1px solid #33343b; }
  .error { color: #ff6b6b; font-size: 13px; margin-bottom: 12px; white-space: pre-wrap; }
  select { width: 100%; padding: 10px 12px; margin-bottom: 14px; border-radius: 8px; border: 1px solid #33343b; background: #0f1013; color: #e6e6e6; }
  .hidden { display: none; }
`;

export interface AuthorizePageParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  scope: string;
}

export interface AuthorizePageOptions {
  firebaseApiKey: string;
  clientName: string;
  params: AuthorizePageParams;
}

export function renderAuthorizePage(opts: AuthorizePageOptions): string {
  const firebaseConfig = {
    apiKey: opts.firebaseApiKey,
    authDomain: FIREBASE_AUTH_DOMAIN,
    projectId: FIREBASE_PROJECT_ID,
  };

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Conectar Pulse</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Conectar con Pulse</h1>
    <p class="sub"><strong>${escapeHtml(opts.clientName)}</strong> quiere acceder a tu workspace de Pulse.</p>
    <div id="error" class="error hidden"></div>

    <div id="login-step">
      <button id="google-btn" class="google" type="button">Continuar con Google</button>
      <form id="login-form">
        <input id="email" type="email" placeholder="Email" autocomplete="username" required />
        <input id="password" type="password" placeholder="Contraseña" autocomplete="current-password" required />
        <button class="primary" type="submit">Iniciar sesión</button>
      </form>
    </div>

    <div id="consent-step" class="hidden">
      <p class="sub" id="consent-copy"></p>
      <select id="workspace-select"></select>
      <button id="authorize-btn" class="primary" type="button">Autorizar</button>
      <button id="cancel-btn" class="secondary" type="button">Cancelar</button>
    </div>
  </div>

  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
    import {
      getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
    } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

    const firebaseConfig = ${embedJson(firebaseConfig)};
    const oauthParams = ${embedJson(opts.params)};

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);

    const errorEl = document.getElementById('error');
    const loginStep = document.getElementById('login-step');
    const consentStep = document.getElementById('consent-step');

    function showError(message) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
    }

    async function afterLogin(user) {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch(window.location.pathname, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step: 'workspaces', idToken, ...oauthParams }),
        });
        const data = await res.json();
        if (!res.ok) return showError(data.error_description || data.error || 'Error al iniciar sesión.');
        renderConsent(idToken, data.workspaces || []);
      } catch (e) {
        showError(e.message || String(e));
      }
    }

    function renderConsent(idToken, workspaces) {
      loginStep.classList.add('hidden');
      consentStep.classList.remove('hidden');
      const copy = document.getElementById('consent-copy');
      const select = document.getElementById('workspace-select');

      if (workspaces.length === 0) {
        copy.textContent = 'Tu cuenta no pertenece a ningún workspace de Pulse.';
        document.getElementById('authorize-btn').classList.add('hidden');
        return;
      }

      copy.textContent = 'Elegí el workspace que querés autorizar:';
      select.innerHTML = workspaces
        .map((w) => '<option value="' + w.id + '">' + w.name.replace(/</g, '&lt;') + '</option>')
        .join('');

      document.getElementById('authorize-btn').onclick = async () => {
        try {
          const res = await fetch(window.location.pathname, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ step: 'consent', idToken, workspaceId: select.value, ...oauthParams }),
          });
          const data = await res.json();
          if (!res.ok) return showError(data.error_description || data.error || 'Error al autorizar.');
          window.location.href = data.redirectTo;
        } catch (e) {
          showError(e.message || String(e));
        }
      };
    }

    document.getElementById('cancel-btn').onclick = () => {
      const url = new URL(oauthParams.redirect_uri);
      url.searchParams.set('error', 'access_denied');
      if (oauthParams.state) url.searchParams.set('state', oauthParams.state);
      window.location.href = url.toString();
    };

    document.getElementById('google-btn').onclick = async () => {
      errorEl.classList.add('hidden');
      try {
        const cred = await signInWithPopup(auth, new GoogleAuthProvider());
        await afterLogin(cred.user);
      } catch (e) {
        showError(e.message || String(e));
      }
    };

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.classList.add('hidden');
      try {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const cred = await signInWithEmailAndPassword(auth, email, password);
        await afterLogin(cred.user);
      } catch (e) {
        showError(e.message || String(e));
      }
    });
  </script>
</body>
</html>`;
}

export function renderAuthorizeError(message: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8" /><title>Error</title><style>${PAGE_STYLE}</style></head>
<body>
  <div class="card">
    <h1>No se pudo continuar</h1>
    <div class="error">${escapeHtml(message)}</div>
  </div>
</body>
</html>`;
}
