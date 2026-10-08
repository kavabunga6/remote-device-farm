import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import type { Config } from './config.js';
import { tokenHash } from './auth.js';

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

function safeClaim(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !/[\x00-\x1f\x7f]/.test(trimmed) ? trimmed : null;
}

export class OidcService {
  private discovery?: Discovery;
  constructor(private readonly pool: Pool, private readonly config: Config) {}

  private async metadata(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const issuer = this.config.oidc!.issuer;
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('OIDC discovery failed');
    const data = await response.json() as Discovery;
    if (data.issuer !== issuer || !data.authorization_endpoint?.startsWith('https://') || !data.token_endpoint?.startsWith('https://') || !data.jwks_uri?.startsWith('https://')) {
      throw new Error('OIDC discovery metadata is invalid');
    }
    this.discovery = data;
    return data;
  }

  async start(res: Response): Promise<string> {
    const settings = this.config.oidc!;
    const metadata = await this.metadata();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.pool.query(
      `INSERT INTO oidc_flows(state_hash,code_verifier,nonce,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')`,
      [tokenHash(state), verifier, nonce],
    );
    res.cookie('rdf_oidc_state', state, { httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/api/oidc/callback', maxAge: 10 * 60 * 1000 });
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', settings.clientId);
    url.searchParams.set('redirect_uri', `${this.config.publicUrl}/api/oidc/callback`);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async complete(req: Request, res: Response): Promise<{ subject: string; username: string; displayName: string; firstName: string | null; lastName: string | null; jobTitle: string | null; company: string | null }> {
    const settings = this.config.oidc!;
    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    const cookie = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('rdf_oidc_state='))?.slice('rdf_oidc_state='.length);
    res.clearCookie('rdf_oidc_state', { path: '/api/oidc/callback', httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax' });
    if (!state || !code || !cookie || state !== cookie) throw new Error('OIDC state mismatch');
    const flow = await this.pool.query(
      `DELETE FROM oidc_flows WHERE state_hash=$1 AND expires_at>now() RETURNING code_verifier,nonce`,
      [tokenHash(state)],
    );
    if (!flow.rows[0]) throw new Error('OIDC login expired');
    const metadata = await this.metadata();
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: `${this.config.publicUrl}/api/oidc/callback`,
      client_id: settings.clientId, code_verifier: flow.rows[0].code_verifier,
    });
    const credentials = Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64');
    const response = await fetch(metadata.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
      body, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('OIDC token exchange failed');
    const tokenResponse = await response.json() as { id_token?: string };
    if (!tokenResponse.id_token) throw new Error('OIDC identity token missing');
    const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    const { payload } = await jwtVerify(tokenResponse.id_token, jwks, {
      issuer: metadata.issuer, audience: settings.clientId, algorithms: ['RS256', 'ES256', 'PS256'],
    });
    if (payload.nonce !== flow.rows[0].nonce || !payload.sub) throw new Error('OIDC identity mismatch');
    return {
      subject: String(payload.sub),
      username: String(payload.preferred_username || payload.email || payload.sub),
      displayName: String(payload.name || payload.preferred_username || payload.email || payload.sub),
      firstName: safeClaim(payload.given_name, 100),
      lastName: safeClaim(payload.family_name, 100),
      jobTitle: safeClaim(payload.job_title ?? payload.title, 150),
      company: safeClaim(payload.company, 150) || safeClaim(payload.organization, 150),
    };
  }
}
