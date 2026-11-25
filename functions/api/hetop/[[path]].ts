/**
 * Cloudflare Pages Function — Relais HTTPS / CORS pour l'API officielle HeTOP (CHU de Rouen / CISMeF).
 * Intercepte `/api/hetop/*` en production sur Cloudflare Pages (en remplacement du `server.proxy` Vite local)
 * et relaie vers `https://www.hetop.eu/CISMeFhetopservice/REST/*`.
 */

const HETOP_UPSTREAM_BASE = 'https://www.hetop.eu/CISMeFhetopservice/REST';

export interface CloudflarePagesContext {
  readonly request: Request;
  readonly params: {
    readonly path?: string | readonly string[];
  };
}

function buildCorsHeaders(upstreamContentType?: string | null): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  if (upstreamContentType) {
    headers.set('Content-Type', upstreamContentType);
  }
  return headers;
}

export function buildHetopUpstreamUrl(
  pathParam: string | readonly string[] | undefined,
  search: string
): string {
  const segments = Array.isArray(pathParam)
    ? pathParam
    : typeof pathParam === 'string' && pathParam.length > 0
      ? [pathParam]
      : [];
  const joinedPath = segments.join('/').replace(/^\/+/, '');
  const base = joinedPath ? `${HETOP_UPSTREAM_BASE}/${joinedPath}` : HETOP_UPSTREAM_BASE;
  return `${base}${search || ''}`;
}

export async function onRequest(context: CloudflarePagesContext): Promise<Response> {
  const { request, params } = context;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: buildCorsHeaders()
    });
  }

  if (method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: buildCorsHeaders('application/json;charset=UTF-8')
    });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = buildHetopUpstreamUrl(params?.path, incomingUrl.search);

  const forwardHeaders = new Headers();
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    forwardHeaders.set('Authorization', authHeader);
  }
  const acceptHeader = request.headers.get('Accept');
  if (acceptHeader) {
    forwardHeaders.set('Accept', acceptHeader);
  } else {
    forwardHeaders.set('Accept', 'application/json');
  }

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: 'GET',
      headers: forwardHeaders
    });

    const responseHeaders = buildCorsHeaders(
      upstreamRes.headers.get('Content-Type') || 'application/json;charset=UTF-8'
    );

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders
    });
  } catch {
    return new Response(
      JSON.stringify({ error: 'HeTOP upstream server unreachable' }),
      {
        status: 502,
        headers: buildCorsHeaders('application/json;charset=UTF-8')
      }
    );
  }
}
