import { MeshDetails } from './rustEngineService';

/**
 * Service d'intégration officiel HeTOP (Health Terminology / Ontology Portal)
 * Développé par le Département de Santé Numérique (DéSaN) du CHU de Rouen / CISMeF & Inserm.
 * 
 * Permet l'interrogation en direct du thésaurus MeSH multilingue officiel français-anglais.
 */

const HETOP_STORAGE_KEY = 'meshcraft_hetop_creds';
const hetopTermCache = new Map<string, MeshDetails | null>();
let hetopCooldownUntil = 0;

export function resetHetopCircuitBreaker(): void {
  hetopCooldownUntil = 0;
  hetopTermCache.clear();
}

interface HetopConceptRaw {
  readonly terminology?: string;
  readonly code?: string;
  readonly conceptType?: string;
  readonly cismefId?: string;
  readonly preferredLabelEn?: string;
  readonly englishLabel?: string;
  readonly preferredLabel?: string;
  readonly synonyms?: readonly string[];
}

interface HetopSearchResponse {
  readonly totalResults?: number | string;
  readonly concepts?: readonly HetopConceptRaw[];
}

export interface HetopCredentials {
  username: string;
  password: string;
}

export function getHetopCredentials(): HetopCredentials | null {
  try {
    const raw = localStorage.getItem(HETOP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.username && parsed.password) return parsed;
  } catch {}
  return null;
}

export function setHetopCredentials(username: string, password: string): void {
  try {
    localStorage.setItem(HETOP_STORAGE_KEY, JSON.stringify({ username, password }));
  } catch {}
}

export function clearHetopCredentials(): void {
  try {
    localStorage.removeItem(HETOP_STORAGE_KEY);
  } catch {}
}

export function isHetopConfigured(): boolean {
  return getHetopCredentials() !== null;
}

/**
 * Teste la validité des identifiants HeTOP auprès du serveur CISMeF
 */
export async function testHetopConnection(user?: string, pass?: string): Promise<{ success: boolean; message: string }> {
  const creds = (user && pass) ? { username: user, password: pass } : getHetopCredentials();
  if (!creds) {
    return { success: false, message: "Aucun identifiant HeTOP configuré." };
  }

  try {
    const authHeader = 'Basic ' + btoa(`${creds.username}:${creds.password}`);
    // Recherche de test sur un concept fondamental (asthme)
    const url = `/api/hetop/searchConcepts/asthme/fr/*`;
    const res = await fetch(url, {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(6500)
    });

    if (res.status === 401 || res.status === 403) {
      return { success: false, message: "Identifiants HeTOP invalides (Erreur 401 Unauthorized)." };
    }

    if (!res.ok) {
      return { success: false, message: `Réponse serveur HeTOP : HTTP ${res.status}` };
    }

    const data = (await res.json()) as HetopSearchResponse;
    return { 
      success: true, 
      message: `Connexion réussie au serveur CISMeF HeTOP (${data?.totalResults || 'Concepts'} indexés).` 
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Serveur injoignable';
    return { success: false, message: `Erreur de connexion : ${message}` };
  }
}

/**
 * Recherche un descripteur MeSH via le serveur HeTOP / CISMeF
 * Ignore automatiquement les phrases complexes (> 4 mots ou contenant des parenthèses/virgules)
 * et active un coupe-circuit (circuit-breaker) temporaire en cas de timeout réseau.
 */
export async function searchHetopMesh(term: string): Promise<MeshDetails | null> {
  const creds = getHetopCredentials();
  if (!creds || !term || term.trim().length < 2) return null;

  // Coupe-circuit actif si le serveur HeTOP vient de timeout récemment
  if (Date.now() < hetopCooldownUntil) {
    return null;
  }

  const cleanTerm = term.trim();
  // HeTOP est un thésaurus terminologique : ne jamais lui envoyer une phrase entière ou une chaîne annotée avec parenthèses
  const wordCount = cleanTerm.split(/\s+/).length;
  if (wordCount > 4 || /[(),;:/]/.test(cleanTerm) || /\b(?:ou|or|et|and)\b/i.test(cleanTerm)) {
    return null;
  }

  const cacheKey = cleanTerm.toLowerCase();
  if (hetopTermCache.has(cacheKey)) {
    return hetopTermCache.get(cacheKey)!;
  }

  try {
    const authHeader = 'Basic ' + btoa(`${creds.username}:${creds.password}`);
    const url = `/api/hetop/searchConcepts/${encodeURIComponent(cleanTerm)}/fr/*`;

    const res = await fetch(url, {
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(2500)
    });

    if (!res.ok) {
      if (res.status >= 500) {
        hetopCooldownUntil = Date.now() + 60_000;
      }
      return null;
    }
    const data = (await res.json()) as HetopSearchResponse;

    if (!data || !data.concepts || !Array.isArray(data.concepts) || data.concepts.length === 0) {
      hetopTermCache.set(cacheKey, null);
      return null;
    }

    // Recherche en priorité d'un concept MeSH avec code Dxxxxx
    const meshConcept = data.concepts.find((c: HetopConceptRaw) => 
      c.terminology === 'MeSH' || 
      (c.code && /^D\d+/.test(c.code)) ||
      (c.conceptType && c.conceptType.includes('MESH'))
    ) || data.concepts[0];

    const meshCode = meshConcept.code || meshConcept.cismefId?.replace('MSH_', '') || 'D-HETOP';

    const rawLabel = meshConcept.preferredLabelEn || meshConcept.englishLabel || meshConcept.preferredLabel || cleanTerm;
    const titleCased = rawLabel.length > 2 && rawLabel === rawLabel.toUpperCase()
      ? rawLabel.replace(/\w\S*/g, (txt: string) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase())
      : rawLabel;

    const details: MeshDetails = {
      descriptor: titleCased,
      meshId: meshCode,
      entryTerms: meshConcept.synonyms 
        ? [titleCased.toLowerCase(), ...meshConcept.synonyms.map((s: string) => s.toLowerCase()).slice(0, 5)] 
        : [titleCased.toLowerCase()]
    };

    hetopTermCache.set(cacheKey, details);
    return details;

  } catch {
    // Active le coupe-circuit pendant 60s pour éviter de ralentir tous les concepts suivants du pipeline
    hetopCooldownUntil = Date.now() + 60_000;
    return null;
  }
}
