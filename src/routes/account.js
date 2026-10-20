/**
 * Google account connection, invitations and password setting.
 *
 * Routes here are all about getting people into the suite: signing in with
 * Google, connecting an account, and accepting an invitation. Permission checks
 * that apply everywhere else live in server.js; this file only adds the
 * Google-specific rules (an admin may not silently take over someone else's
 * Google identity, and a linked account is required to be the same person).
 */
import { html, esc, redirect } from '../lib/http.js';
import { layout, pageHeader } from '../lib/html.js';
import { get, run, logAudit } from '../db.js';
import {
  getUser, setPasswordWithToken, looksLikeEmail,
} from '../auth.js';
import {
  googleConfigured, googleStatus, authorizeUrl, createState, consumeState,
  exchangeCode, fetchProfile, linkAccount, unlinkAccount, getLink, findBySub,
  markLogin, subFingerprint,
} from '../google.js';
import { issueToken, consumeToken, peekToken, pruneTokens } from '../tokens.js';

/** A plain page that does not require a signed-in user. */
function publicPage({ title, body }) {
  return layout({ title, body: `<div class="auth">${body}</div>` });
}

function googleButton({ label = 'Continue with Google', next = '' }) {
  if (!googleConfigured()) return '';
  return `<form method="post" action="/auth/google/start" class="inline">
    <input type="hidden" name="intent" value="login">
    <input type="hidden" name="next" value="${esc(next)}">
    <button class="btn ghost google" type="submit">
      <span class="g">G</span> ${esc(label)}
    </button>
  </form>`;
}

/* ------------------------------------------------------------------ *
 * Sign in with Google
 * ------------------------------------------------------------------ */

const googleAuthRoutes = [
  {
    method: 'POST',
    path: '/auth/google/start',
    public: true,
    handler: (ctx) => {
      if (!googleConfigured()) {
        return html(ctx.res, publicPage({
          title: 'Google sign-in',
          body: `<h1>Not available</h1><p class="muted">${esc(googleStatus())}</p>
                 <p><a href="/login">Back to sign in</a></p>`,
        }), 503);
      }
      const intent = ctx.body.intent === 'link' ? 'link' : 'login';
      if (intent === 'link' && !ctx.user) return { redirect: '/login' };
      const state = createState(intent);
      // The session cookie identifies the user when Google returns for a link,
      // so nothing about the user is carried in the query string.
      if (intent === 'link' && ctx.user) {
        ctx.setSession(ctx.user.id);
      }
      return { redirect: authorizeUrl(state) };
    },
  },
  {
    method: 'GET',
    path: '/auth/google/callback',
    public: true,
    handler: async (ctx) => {
      if (!googleConfigured()) return { redirect: '/login' };

      // Google reports user-facing failures by redirecting back with ?error=.
      if (ctx.query.error) {
        const msg = ctx.query.error === 'access_denied'
          ? 'Google sign-in was cancelled.'
          : `Google sign-in failed: ${ctx.query.error}`;
        return html(ctx.res, publicPage({
          title: 'Sign in',
          body: `<h1>Sign in</h1><div class="flash err">${esc(msg)}</div>
                 <p><a class="btn" href="/login">Back to sign in</a></p>`,
        }), 400);
      }

      const state = consumeState(ctx.query.state);
      if (!state) {
        return html(ctx.res, publicPage({
          title: 'Sign in',
          body: `<h1>Sign in</h1>
                 <div class="flash err">That sign-in link has expired or was already used. Please try again.</div>
                 <p><a class="btn" href="/login">Back to sign in</a></p>`,
        }), 400);
      }
      if (!ctx.query.code) return { redirect: '/login' };

      const tokenResult = await exchangeCode(ctx.query.code);
      if (tokenResult.error) {
        return html(ctx.res, publicPage({
          title: 'Sign in',
          body: `<h1>Sign in</h1><div class="flash err">${esc(tokenResult.error)}</div>
                 <p><a class="btn" href="/login">Back to sign in</a></p>`,
        }), 502);
      }

      const profileResult = await fetchProfile(tokenResult.data.access_token);
      if (profileResult.error) {
        return html(ctx.res, publicPage({
          title: 'Sign in',
          body: `<h1>Sign in</h1><div class="flash err">${esc(profileResult.error)}</div>
                 <p><a class="btn" href="/login">Back to sign in</a></p>`,
        }), 502);
      }
      const profile = profileResult.data;

      /* ---- linking to an existing signed-in account ---- */
      if (state.intent === 'link') {
        if (!ctx.user) {
          return html(ctx.res, publicPage({
            title: 'Connect Google',
            body: `<h1>Session expired</h1>
                   <p class="muted">Your session ended before Google replied. Sign in and try again.</p>
                   <p><a class="btn" href="/login">Sign in</a></p>`,
          }), 400);
        }
        const linked = linkAccount(ctx.user.id, profile, tokenResult.data);
        if (linked.error) {
          ctx.flashMsg(linked.error, 'err');
          return { redirect: '/profile' };
        }
        logAudit(ctx.user.id, 'google.link', {
          email: profile.email, sub: subFingerprint(profile.sub),
        });
        ctx.flashMsg(`Connected ${profile.email} to your account.`);
        return { redirect: '/profile' };
      }

      /* ---- signing in ---- */
      const existing = findBySub(profile.sub);
      if (existing) {
        const target = getUser(existing.user_id);
        // A disabled account must not be able to sign in via Google either.
        if (!target || !target.active) {
          return html(ctx.res, publicPage({
            title: 'Sign in',
            body: `<h1>Sign in</h1><div class="flash err">That account is disabled.</div>
                   <p><a class="btn" href="/login">Back to sign in</a></p>`,
          }), 403);
        }
        markLogin(target.id);
        ctx.setSession(target.id);
        logAudit(target.id, 'auth.login', {
          via: 'google', email: profile.email, sub: subFingerprint(profile.sub),
        });
        return { redirect: '/dashboard' };
      }

      // Not linked yet. This is where an unverified email matters: matching on
      // an unverified address would let someone claim another person's account
      // by creating a Google account with their email.
      if (!profile.email_verified) {
        return html(ctx.res, publicPage({
          title: 'Sign in',
          body: `<h1>Sign in</h1>
                 <div class="flash err">Google has not verified the email address on that account,
                 so it cannot be matched to a user here. Verify the address with Google, or sign in
                 with your username and password and connect it from your profile.</div>
                 <p><a class="btn" href="/login">Back to sign in</a></p>`,
        }), 403);
      }

      const localUser = get('SELECT * FROM users WHERE lower(email) = lower(?)', profile.email);
      if (localUser && localUser.active) {
        // First Google sign-in for a known email: link it, then sign in. The
        // password path still works, so this is not a lock-in.
        linkAccount(localUser.id, profile, tokenResult.data);
        markLogin(localUser.id);
        ctx.setSession(localUser.id);
        logAudit(localUser.id, 'auth.login', {
          via: 'google', linked: true, email: profile.email, sub: subFingerprint(profile.sub),
        });
        return { redirect: '/dashboard' };
      }

      return html(ctx.res, publicPage({
        title: 'Sign in',
        body: `<h1>No account for that address</h1>
               <p class="muted">${esc(profile.email)} is not in use here, so it could not be signed in.
               Ask an administrator to invite that address.</p>
               <p><a class="btn" href="/login">Back to sign in</a></p>`,
      }), 403);
    },
  },
];

/* ------------------------------------------------------------------ *
 * Invitations and password setting (public - the token is the credential)
 * ------------------------------------------------------------------ */

const tokenRoutes = [
  {
    method: 'GET',
    path: '/invite/:token',
    public: true,
    handler: (ctx) => {
      const row = peekToken(ctx.params.token, 'invite');
      if (!row) {
        return html(ctx.res, publicPage({
          title: 'Invitation',
          body: `<h1>Invitation</h1>
                 <div class="flash err">This invitation is not valid, has expired, or has already been used.
                 Ask an administrator for a new one.</div>
                 <p><a class="btn" href="/login">Sign in</a></p>`,
        }), 400);
      }
      const user = getUser(row.user_id);
      return html(ctx.res, publicPage({
        title: 'Set your password',
        body: `
        <img src="/img/logo-ink.png" alt="" width="72" height="78" class="auth-logo">
        <h1>Welcome${user ? `, ${esc(user.name)}` : ''}</h1>
        <p class="muted">Choose a password to finish setting up your account.</p>
        <form method="post" action="/invite/${esc(ctx.params.token)}" class="card form">
          <div class="field"><label for="p1">New password</label>
            <input id="p1" name="password" type="password" minlength="6" required autocomplete="new-password" autofocus></div>
          <div class="field"><label for="p2">Confirm password</label>
            <input id="p2" name="password2" type="password" minlength="6" required autocomplete="new-password"></div>
          <div class="actions"><button class="btn" type="submit">Set password and sign in</button></div>
        </form>`,
      }));
    },
  },
  {
    method: 'POST',
    path: '/invite/:token',
    public: true,
    handler: (ctx) => {
      const { password, password2 } = ctx.body;
      if (!password || password !== password2) {
        ctx.flashMsg('Those passwords do not match.', 'err');
        return { redirect: `/invite/${encodeURIComponent(ctx.params.token)}` };
      }
      const consumed = consumeToken(ctx.params.token, 'invite');
      if (consumed.error) {
        ctx.flashMsg(consumed.error, 'err');
        return { redirect: '/login' };
      }
      const result = setPasswordWithToken(consumed.userId, password);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: '/login' };
      }
      const user = getUser(consumed.userId);
      pruneTokens();
      logAudit(consumed.userId, 'user.accept-invite', {});
      // Sign them straight in - they just proved control of the link.
      ctx.setSession(consumed.userId);
      ctx.flashMsg(`Welcome, ${user?.name || 'there'}. Your password is set.`);
      return { redirect: '/dashboard' };
    },
  },
];

/* ------------------------------------------------------------------ *
 * Connect / disconnect (signed in)
 * ------------------------------------------------------------------ */

const accountRoutes = [
  {
    method: 'POST',
    path: '/auth/google/start-link',
    handler: (ctx) => {
      if (!googleConfigured()) {
        ctx.flashMsg(googleStatus(), 'err');
        return { redirect: '/profile' };
      }
      const state = createState('link');
      // The session cookie identifies the user when Google returns, so the
      // callback does not need anything from the client.
      ctx.setSession(ctx.user.id);
      return { redirect: authorizeUrl(state, { prompt: 'select_account' }) };
    },
  },
  {
    method: 'POST',
    path: '/auth/google/disconnect',
    handler: (ctx) => {
      const result = unlinkAccount(ctx.user.id);
      if (result.error) {
        ctx.flashMsg(result.error, 'err');
        return { redirect: '/profile' };
      }
      logAudit(ctx.user.id, 'google.unlink', { email: result.data.email });
      ctx.flashMsg('Google account disconnected.');
      return { redirect: '/profile' };
    },
  },
  {
    method: 'POST',
    path: '/profile/dismiss-google',
    handler: (ctx) => {
      // A per-user acknowledgement so the prompt does not nag, but the link
      // stays available on the profile page regardless.
      run('UPDATE users SET google_prompt_dismissed = 1 WHERE id = ?', ctx.user.id);
      return { redirect: '/dashboard' };
    },
  },
];

export const accountAllRoutes = [...googleAuthRoutes, ...tokenRoutes, ...accountRoutes];

/** The dashboard prompt, shown until the account is connected or dismissed. */
export function googlePrompt(user) {
  if (!user || getLink(user.id)) return '';
  if (!googleConfigured()) return '';
  const dismissed = get('SELECT google_prompt_dismissed AS d FROM users WHERE id = ?', user.id)?.d;
  if (dismissed) return '';
  return `
  <div class="prompt">
    <div>
      <strong>Connect your Google account</strong>
      <p class="muted">Link your account to sign in with Google. You can do this later from your profile.</p>
    </div>
    <div class="prompt-actions">
      <form method="post" action="/auth/google/start-link" class="inline">
        <button class="btn">Connect Google</button>
      </form>
      <form method="post" action="/profile/dismiss-google" class="inline">
        <button class="btn ghost">Not now</button>
      </form>
    </div>
  </div>`;
}

export { googleButton };

/**
 * The "Sign in with Google" control on the login page. Posts rather than
 * linking directly, so the OAuth state is created server-side.
 */
export function googleSignInForm(next = '') {
  if (!googleConfigured()) return '';
  return `<form method="post" action="/auth/google/start" class="inline google-form">
    <input type="hidden" name="intent" value="login">
    <input type="hidden" name="next" value="${esc(next)}">
    <button class="btn ghost google" type="submit"><span class="g">G</span> Continue with Google</button>
  </form>`;
}

/**
 * The permanent "Google account" section on the profile page. This is where
 * someone lands when they skipped the prompt at first login.
 */
export function googleProfileBlock(user) {
  if (!user) return '';
  const link = getLink(user.id);

  if (!googleConfigured()) {
    return `
    <h2>Google account</h2>
    <div class="card">
      <p class="muted">${esc(googleStatus())}</p>
    </div>`;
  }

  if (!link) {
    return `
    <h2>Google account</h2>
    <div class="card">
      <p class="muted">Not connected. Connect a Google account to sign in without a password.</p>
      <form method="post" action="/auth/google/start-link" class="inline">
        <button class="btn">Connect Google</button>
      </form>
    </div>`;
  }

  const verified = link.email_verified
    ? '<span class="pill on">verified</span>'
    : '<span class="pill off">not verified</span>';
  const last = link.last_login_at ? esc(link.last_login_at) : 'never';
  return `
  <h2>Google account</h2>
  <div class="card">
    <dl class="kv">
      <dt>Email</dt><dd>${esc(link.email)} ${verified}</dd>
      <dt>Connected</dt><dd>${esc(link.connected_at)}</dd>
      <dt>Last used to sign in</dt><dd>${last}</dd>
    </dl>
    <p class="muted">Disconnecting removes the ability to sign in with Google. Your
    username and password still work.</p>
    <form method="post" action="/auth/google/disconnect" class="inline"
          onsubmit="return confirm('Disconnect this Google account?')">
      <button class="btn ghost">Disconnect</button>
    </form>
  </div>`;
}
