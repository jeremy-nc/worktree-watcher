import { createServer, Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { AddressInfo } from 'node:net'
import * as vscode from 'vscode'

export const IAP_AUTH_PROVIDER_ID = 'worktreeWatcher.googleIap'

const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URI = 'https://oauth2.googleapis.com/token'
/** Minimum scopes for an id_token that carries the user's identity to IAP. */
const SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email']
/**
 * Ports the OAuth client has registered as redirect URIs.
 *
 * A true Desktop client would accept any loopback port (RFC 8252), but this one
 * rejects unregistered URIs with `redirect_uri_mismatch`, so the redirect has to
 * match a registered string **exactly** — including `localhost` rather than
 * `127.0.0.1`, and the trailing slash. These are the four terminal-project
 * registered, which is the set known to work against this client.
 */
const REDIRECT_PORTS = [8723, 8724, 8725, 8726]

/** Exactly as registered: host `localhost`, trailing slash. */
function redirectUriFor(port: number): string {
  return `http://localhost:${port}/`
}
/** Refresh before IAP would reject a nearly-expired token. */
const EXPIRY_BUFFER_MS = 5 * 60_000

export interface IapClient {
  readonly clientId: string
  readonly clientSecret: string
  /**
   * Optional target audience for the minted id_token.
   *
   * A plain refresh returns an id_token whose `aud` is the client id, which is
   * what IAP wants when the client itself is the allowed programmatic-access
   * client. Some IAP setups expect a different audience instead; passing it here
   * asks Google to mint the token for that audience.
   */
  readonly audience?: string
}

/**
 * Signs in to Google so TeamCity's Identity-Aware Proxy can be satisfied.
 *
 * Registered as a VS Code authentication provider, so signing in and out happens
 * through the **Accounts** menu rather than anything this extension draws. VS Code
 * persists nothing itself — the refresh token is kept in `SecretStorage`, which is
 * OS-keychain backed rather than a file on disk.
 *
 * The session's `accessToken` is deliberately the **id_token**: that is what IAP
 * wants in `Proxy-Authorization`, and it is minted fresh from the refresh token on
 * each request so a cached one is never served past its expiry.
 *
 * This deliberately does its own consent and keeps its own refresh token. Reading
 * another tool's credential cache would couple to an undocumented format and blur
 * which grant to revoke.
 */
export class GoogleIapAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>()
  readonly onDidChangeSessions = this.changed.event

  private cachedIdToken?: { value: string; expiresAt: number }

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly client: () => IapClient | undefined
  ) {}

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const stored = await this.secrets.get(REFRESH_KEY)
    if (!stored) {
      return []
    }
    const { email } = JSON.parse(stored) as StoredGrant
    // The id_token is minted on demand; the session only proves a grant exists.
    return [
      {
        id: IAP_AUTH_PROVIDER_ID,
        accessToken: '',
        account: { id: email ?? 'google', label: email ?? 'Google account' },
        scopes: SCOPES
      }
    ]
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    const client = this.client()
    if (!client?.clientId || !client.clientSecret) {
      throw new Error(
        'Set worktreeWatcher.teamCity.iapClientId and iapClientSecret before signing in.'
      )
    }

    const grant = await this.consent(client)
    await this.secrets.store(REFRESH_KEY, JSON.stringify(grant))
    this.cachedIdToken = undefined

    const [session] = await this.getSessions()
    this.changed.fire({ added: [session], removed: [], changed: [] })
    return session
  }

  async removeSession(): Promise<void> {
    const [session] = await this.getSessions()
    await this.secrets.delete(REFRESH_KEY)
    this.cachedIdToken = undefined
    if (session) {
      this.changed.fire({ added: [], removed: [session], changed: [] })
    }
  }

  /**
   * A currently-valid id_token for IAP, or undefined when not signed in.
   * Cached until shortly before expiry.
   */
  async idToken(): Promise<string | undefined> {
    if (this.cachedIdToken && Date.now() < this.cachedIdToken.expiresAt) {
      return this.cachedIdToken.value
    }

    const stored = await this.secrets.get(REFRESH_KEY)
    const client = this.client()
    if (!stored || !client) {
      return undefined
    }

    const { refreshToken } = JSON.parse(stored) as StoredGrant
    const response = await postForm(TOKEN_URI, {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      ...(client.audience ? { audience: client.audience } : {})
    })

    if (!response.id_token) {
      return undefined
    }
    this.cachedIdToken = {
      value: response.id_token,
      expiresAt: Date.now() + Math.max(0, (response.expires_in ?? 3600) * 1000 - EXPIRY_BUFFER_MS)
    }
    return response.id_token
  }

  /** Which Google identity the stored grant belongs to — the usual culprit when
   *  IAP refuses a request that otherwise looks correct. */
  async account(): Promise<string | undefined> {
    const stored = await this.secrets.get(REFRESH_KEY)
    return stored ? (JSON.parse(stored) as StoredGrant).email : undefined
  }

  dispose(): void {
    this.changed.dispose()
  }

  /** Browser consent over a loopback redirect, with PKCE. */
  private async consent(client: IapClient): Promise<StoredGrant> {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(16).toString('hex')

    const { server, port } = await listenOnFreePort()
    const redirectUri = redirectUriFor(port)

    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Sign-in timed out')), 5 * 60_000)

        server.on('request', (request, reply) => {
          const url = new URL(request.url ?? '/', `http://localhost:${port}`)
          const received = url.searchParams.get('code')
          const error = url.searchParams.get('error')
          reply.writeHead(200, { 'Content-Type': 'text/html' })
          reply.end(
            `<html><body style="font-family:system-ui;padding:3rem">
             <h2>${received ? 'Signed in' : 'Sign-in failed'}</h2>
             <p>You can close this tab and return to VS Code.</p></body></html>`
          )
          clearTimeout(timeout)
          if (error || url.searchParams.get('state') !== state) {
            reject(new Error(error ?? 'State mismatch — sign-in rejected'))
          } else if (received) {
            resolve(received)
          }
        })

        const authorize = new URL(AUTH_URI)
        authorize.search = new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }).toString()

        void vscode.env.openExternal(vscode.Uri.parse(authorize.toString()))
      })

      const token = await postForm(TOKEN_URI, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })

      if (!token.refresh_token) {
        throw new Error('Google returned no refresh token; sign in again and grant offline access.')
      }
      return { refreshToken: token.refresh_token, email: emailFromIdToken(token.id_token) }
    } finally {
      server.close()
    }
  }
}

const REFRESH_KEY = 'worktreeWatcher.googleIap.grant'

interface StoredGrant {
  readonly refreshToken: string
  readonly email?: string
}

interface TokenResponse {
  id_token?: string
  refresh_token?: string
  expires_in?: number
}

async function postForm(url: string, form: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString()
  })
  if (!response.ok) {
    throw new Error(`Google token endpoint returned ${response.status}`)
  }
  return (await response.json()) as TokenResponse
}

async function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  for (const port of REDIRECT_PORTS) {
    const server = createServer()
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (ok) {
      return { server, port: (server.address() as AddressInfo).port }
    }
    server.close()
  }
  throw new Error(`No free loopback port among ${REDIRECT_PORTS.join(', ')} for the sign-in redirect.`)
}

/** Best-effort label for the Accounts menu; never trusted for anything else. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  try {
    const payload = idToken?.split('.')[1]
    return payload
      ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { email?: string }).email
      : undefined
  } catch {
    return undefined
  }
}
