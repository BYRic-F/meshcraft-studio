/**
 * Modèle de données canonique unifié multi-bases (PubMed, Embase, Cochrane Reviews, CENTRAL, autres RIS)
 * pour MeSHcraft Studio (PRISMA 2020 / Cochrane Handbook).
 *
 * Conforme à `GEMINI.md` : typage strict (zéro `any`), fonctions pures déterministes sans effet de bord UI.
 */

export type BibliographicSource =
  | 'pubmed'
  | 'embase'
  | 'cochrane_reviews'
  | 'cochrane_central'
  | 'other_ris';

export type StudyRecordKind =
  | 'article'
  | 'review'
  | 'trial_registry'
  | 'other';

export interface StudyIdentifiers {
  readonly pmid?: string;
  readonly doi?: string;
  readonly embaseId?: string;
  readonly embasePui?: string;
  readonly cochraneId?: string;
  readonly registryIds?: readonly string[];
}

export interface CanonicalStudyRecord {
  readonly id: string;
  readonly pmid: string;
  readonly doi?: string;
  readonly identifiers: StudyIdentifiers;
  readonly sources: readonly BibliographicSource[];
  readonly recordKind: StudyRecordKind;
  readonly title: string;
  readonly authors: string;
  readonly source: string;
  readonly pubDate: string;
  readonly abstract: string;
  readonly meshHeadings: string[];
  readonly publicationTypes?: string[];
  readonly language?: string;
  readonly url: string;
  readonly status: 'pending' | 'included' | 'maybe' | 'excluded' | 'error';
  readonly exclusionReason?: string;
  readonly evidenceSnippet?: string;
  readonly evaluatedBy?: 'gemini' | 'openai' | 'anthropic' | 'manual' | 'rayyan';
}

export interface SourceImportBatch {
  readonly batchId: string;
  readonly source: BibliographicSource;
  readonly fileName?: string;
  readonly contentHash?: string;
  readonly importedAt: number;
  readonly rawRecordCount: number;
  readonly registryRecordCount: number;
}

export interface CorpusDeduplicationStats {
  readonly rawBySource: Readonly<Record<BibliographicSource, number>>;
  readonly totalIdentifiedDatabases: number;
  readonly totalIdentifiedRegisters: number;
  readonly totalIdentified: number;
  readonly duplicatesRemoved: number;
  readonly uniqueCorpusCount: number;
}

export const CANONICAL_SOURCE_ORDER: readonly BibliographicSource[] = [
  'pubmed',
  'embase',
  'cochrane_reviews',
  'cochrane_central',
  'other_ris'
];

/**
 * Normalise un DOI (supprime préfixes URL/doi:, espaces, point final, casse minuscule).
 */
export function normalizeDoi(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  let cleaned = String(raw).trim();
  if (!cleaned) return undefined;
  cleaned = cleaned
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/\s+/g, '')
    .replace(/\.+$/, '')
    .toLowerCase();
  if (!cleaned.includes('/') || cleaned.length < 5) return undefined;
  return cleaned;
}

/**
 * Normalise un PMID numérique (5 à 10 chiffres).
 */
export function normalizePmid(raw?: string | number | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const cleaned = String(raw).trim();
  if (!/^\d{5,10}$/.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * Normalise un identifiant Embase (ex: "L2051170234" ou "623793174" -> "2051170234" / "623793174").
 */
export function normalizeEmbaseId(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = String(raw).trim();
  const match = /^[Ll]?(\d{6,15})$/.exec(cleaned);
  return match ? match[1] : undefined;
}

/**
 * Normalise un titre pour la déduplication :
 * - retire les crochets `[...]` encadrant un titre traduit PubMed (et le point final éventuel)
 * - translittère les caractères latins non décomposés par NFD (`ı`, `İ`, `ø`, `æ`, `œ`, `ß`, `ł`, `đ`)
 * - supprime les diacritiques et normalise toute ponctuation/tiret Unicode en espace simple.
 */
export function normalizeTitleForDedup(title: string): string {
  if (!title) return '';
  let s = title.trim();
  // Retire les crochets encadrant les titres traduits PubMed, ex: "[Low back pain in adults]."
  const bracketed = /^\[([\s\S]+)\]\s*\.?$/.exec(s);
  if (bracketed) {
    s = bracketed[1].trim();
  }

  s = s
    .replace(/\u0131/g, 'i')
    .replace(/\u0130/g, 'i')
    .replace(/[\u00F8\u00D8]/g, 'o')
    .replace(/[\u00E6\u00C6]/g, 'ae')
    .replace(/[\u0153\u0152]/g, 'oe')
    .replace(/\u00DF/g, 'ss')
    .replace(/[\u0142\u0141]/g, 'l')
    .replace(/[\u0111\u0110]/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return s;
}

/**
 * Extrait le nom de famille normalisé du premier auteur pour le contrôle strict des titres courts.
 */
export function extractFirstAuthorSurname(authors: string): string {
  const clean = (authors || '').trim();
  if (!clean) return '';
  const firstSegment = clean.split(';')[0].trim();
  let rawSurname = '';
  if (firstSegment.includes(',')) {
    rawSurname = firstSegment.split(',')[0].trim();
  } else {
    const parts = firstSegment.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '';
    // Format PubMed abrégé fréquent : "Smith J" ou "Anker SD"
    if (parts.length >= 2 && /^[A-Z]{1,4}$/.test(parts[parts.length - 1])) {
      rawSurname = parts.slice(0, -1).join(' ');
    } else {
      rawSurname = parts[0];
    }
  }

  const normalized = rawSurname
    .replace(/\u0131/g, 'i')
    .replace(/\u0130/g, 'i')
    .replace(/[\u00F8\u00D8]/g, 'o')
    .replace(/[\u00E6\u00C6]/g, 'ae')
    .replace(/[\u0153\u0152]/g, 'oe')
    .replace(/\u00DF/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  if (normalized === 'anonymous' || normalized === 'anonym') return '';
  return normalized;
}

/**
 * Extrait l'année de publication sur 4 chiffres (ex. "2026 Nov" -> 2026).
 */
export function extractPubYear(pubDate: string): number | null {
  const match = (pubDate || '').match(/\b(19\d{2}|20\d{2})\b/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * Calcule une empreinte 64-bit déterministe (double FNV-1a 32-bit en hexadécimal sur 16 caractères).
 */
export function computeStableFingerprintId(
  normalizedTitle: string,
  firstAuthorSurname: string,
  year: number | null
): string {
  const payload = `${normalizedTitle}|${firstAuthorSurname}|${year !== null ? String(year) : ''}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (code + (i & 0xff)) & 0xffff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `fp:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Construit une clé primaire canonique stable selon la hiérarchie :
 * pmid > doi > cochrane > embase > registry > empreinte titre/auteur/année.
 */
export function buildCanonicalRecordId(
  identifiers: StudyIdentifiers,
  normalizedTitle: string,
  firstAuthorSurname: string,
  year: number | null
): string {
  if (identifiers.pmid) return `pmid:${identifiers.pmid}`;
  if (identifiers.doi) return `doi:${identifiers.doi}`;
  if (identifiers.cochraneId) return `cochrane:${identifiers.cochraneId.toUpperCase()}`;
  if (identifiers.embaseId) return `embase:${identifiers.embaseId}`;
  if (identifiers.registryIds && identifiers.registryIds.length > 0) {
    return `registry:${identifiers.registryIds[0].toUpperCase()}`;
  }
  return computeStableFingerprintId(normalizedTitle, firstAuthorSurname, year);
}

/**
 * Résout l'URL canonique préférée d'une notice :
 * PubMed (si PMID) > DOI resolver > URL source de repli.
 */
export function resolvePreferredUrl(identifiers: StudyIdentifiers, fallbackUrl?: string): string {
  if (identifiers.pmid) {
    return `https://pubmed.ncbi.nlm.nih.gov/${identifiers.pmid}/`;
  }
  if (identifiers.doi) {
    return `https://doi.org/${identifiers.doi}`;
  }
  const cleanFallback = (fallbackUrl || '').trim();
  return cleanFallback;
}

/**
 * Formate le badge d'identifiant principal lisible pour l'UI et la matrice de lecture.
 */
export function formatPrimaryIdentifierLabel(record: {
  readonly id?: string;
  readonly pmid?: string;
  readonly identifiers?: StudyIdentifiers;
}): string {
  const pmid = normalizePmid(record.identifiers?.pmid ?? record.pmid);
  if (pmid) return `PMID: ${pmid}`;

  const cochraneId = record.identifiers?.cochraneId;
  if (cochraneId) {
    const upper = cochraneId.toUpperCase();
    return upper.startsWith('CN-') ? `CENTRAL: ${upper}` : `Cochrane: ${upper}`;
  }

  if (record.identifiers?.embasePui) {
    return `Embase: ${record.identifiers.embasePui}`;
  }
  if (record.identifiers?.embaseId) {
    return `Embase: ${record.identifiers.embaseId}`;
  }
  if (record.identifiers?.doi) {
    return `DOI: ${record.identifiers.doi}`;
  }
  if (record.identifiers?.registryIds && record.identifiers.registryIds.length > 0) {
    return `Registre: ${record.identifiers.registryIds[0]}`;
  }
  if (record.id) {
    return `ID: ${record.id}`;
  }
  return 'ID: N/A';
}

/**
 * Déduit le `StudyRecordKind` à partir des types de publication et de la source.
 */
export function inferRecordKindFromPubTypes(
  publicationTypes?: readonly string[],
  source?: BibliographicSource
): StudyRecordKind {
  const normalized = (publicationTypes || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (normalized.some((t) => t.includes('trial registry record'))) {
    return 'trial_registry';
  }
  if (source === 'cochrane_reviews') {
    return 'review';
  }
  if (
    normalized.some(
      (t) =>
        t === 'review' ||
        t.includes('systematic review') ||
        t.includes('meta-analysis') ||
        t.includes('scoping review')
    )
  ) {
    return 'review';
  }
  if (
    normalized.some(
      (t) =>
        t === 'editorial' ||
        t === 'letter' ||
        t === 'comment' ||
        t.includes('congress') ||
        t.includes('conference abstract')
    )
  ) {
    return 'other';
  }
  return 'article';
}

export function createEmptySourceCounts(): Record<BibliographicSource, number> {
  return {
    pubmed: 0,
    embase: 0,
    cochrane_reviews: 0,
    cochrane_central: 0,
    other_ris: 0
  };
}

/**
 * Retourne la clé primaire canonique d'une notice (priorité `id`, sinon `pmid:<digits>`, sinon `pmid` brut).
 */
export function getArticleKey(art: {
  readonly id?: string;
  readonly pmid?: string;
  readonly identifiers?: StudyIdentifiers;
}): string {
  if (typeof art.id === 'string' && art.id.trim().length > 0) {
    return art.id.trim();
  }
  const normPmid = normalizePmid(art.identifiers?.pmid ?? art.pmid);
  if (normPmid) {
    return `pmid:${normPmid}`;
  }
  return (art.pmid || '').trim();
}

/**
 * Calcule une empreinte 64-bit déterministe du contenu brut normalisé d'un fichier RIS
 * afin de garantir l'idempotence en cas de réimportation du même fichier.
 */
export function computeContentFingerprint(rawText: string): string {
  const normalized = (rawText || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (code + (i & 0xff)) & 0xffff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
