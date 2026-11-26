/**
 * Service de persistance locale (IndexedDB natif) et d'export/import portable (.json)
 * pour la sauvegarde complète d'une revue systématique et l'auto-sauvegarde anti-F5.
 *
 * Conforme à GEMINI.md : zéro dépendance externe, typage TypeScript strict (zéro any),
 * aucune clé API ni identifiant sensible persisté ou exporté.
 */

import type { PicoInputs, PipelineSettings, MappedBlock, CritiqueReport } from './multiAgentWorkflow';
import type { PubMedResponse } from './rustEngineService';
import type { ScreenedArticle } from './agentScreener';
import type { Rob2ArticleEvaluation } from './localAiService';
import {
  BibliographicSource,
  CANONICAL_SOURCE_ORDER,
  CanonicalStudyRecord,
  CorpusDeduplicationStats,
  SourceImportBatch,
  StudyIdentifiers,
  StudyRecordKind,
  buildCanonicalRecordId,
  extractFirstAuthorSurname,
  extractPubYear,
  inferRecordKindFromPubTypes,
  normalizeDoi,
  normalizeEmbaseId,
  normalizePmid,
  normalizeTitleForDedup,
  resolvePreferredUrl
} from './studyRecordTypes';

const DB_NAME = 'meshcraft_reviews_db';
const DB_VERSION = 1;
const STORE_NAME = 'reviews';
export const ACTIVE_DRAFT_ID = '__active_draft__';

export type ReviewWizardStep = 1 | 2 | 3 | 4;

export interface SavedReviewSummary {
  readonly pubmedHits: number;
  readonly loadedArticlesCount: number;
  readonly screenedCount: number;
  readonly includedCount: number;
  readonly robAssessedCount: number;
}

export interface SavedReviewResultData {
  readonly mappedBlocks: MappedBlock[];
  readonly pubmedQuery: string;
  readonly embaseQuery: string;
  readonly cochraneQuery: string;
  readonly liveResult: PubMedResponse;
  readonly critiqueReport: CritiqueReport;
  readonly droppedComparatorReason?: 'passive_comparator' | 'unrestricted_population';
}

export interface SavedReviewSnapshot {
  readonly schemaVersion: 1 | 2;
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly wizardStep: ReviewWizardStep;
  readonly summary: SavedReviewSummary;
  readonly picoInputs: PicoInputs;
  readonly searchSettings: PipelineSettings;
  readonly resultData: SavedReviewResultData | null;
  readonly refinementCount: number;
  readonly screenedArticles: ScreenedArticle[];
  readonly robEvaluations: Record<string, Rob2ArticleEvaluation>;
  readonly importBatches?: readonly SourceImportBatch[];
  readonly deduplicationStats?: CorpusDeduplicationStats;
}

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|password|passwd|secret|token|authorization|hetop_?pass|hetop_?user|credentials)/i;

const memoryStore = new Map<string, SavedReviewSnapshot>();

export function resetInMemoryReviewStoreForTests(): void {
  memoryStore.clear();
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openReviewsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open error'));
  });
}

function stripSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => stripSensitiveKeys(item));
  }
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      clean[key] = stripSensitiveKeys(val);
    }
    return clean;
  }
  return value;
}

export function sanitizeSearchSettings(settings: PipelineSettings): PipelineSettings {
  return {
    strategy: settings.strategy,
    qualifiers: settings.qualifiers ? [...settings.qualifiers] : undefined,
    filters: settings.filters ? [...settings.filters] : undefined,
    activePico: settings.activePico ? { ...settings.activePico } : undefined,
    screeningMode: settings.screeningMode,
    useTruncation: settings.useTruncation,
    noExplode: settings.noExplode,
    dateRange: settings.dateRange ? { ...settings.dateRange } : undefined,
    qualifications: settings.qualifications ? { ...settings.qualifications } : undefined
  };
}

export function computeReviewSummary(
  resultData: SavedReviewResultData | null,
  screenedArticles: readonly ScreenedArticle[],
  robEvaluations: Readonly<Record<string, Rob2ArticleEvaluation>>
): SavedReviewSummary {
  const pubmedHits = resultData?.liveResult?.count ?? screenedArticles.length;
  const loadedArticlesCount = screenedArticles.length;
  let screenedCount = 0;
  let includedCount = 0;

  for (const art of screenedArticles) {
    if (art.status === 'included' || art.status === 'maybe' || art.status === 'excluded') {
      screenedCount += 1;
    }
    if (art.status === 'included') {
      includedCount += 1;
    }
  }

  const robAssessedCount = Object.keys(robEvaluations || {}).length;

  return {
    pubmedHits,
    loadedArticlesCount,
    screenedCount,
    includedCount,
    robAssessedCount
  };
}

export function buildDefaultReviewTitle(pico: PicoInputs): string {
  const p = (pico.p || '').trim();
  const i = (pico.i || '').trim();
  if (p && i) return `${p} — ${i}`.slice(0, 96);
  if (p) return p.slice(0, 96);
  if (i) return i.slice(0, 96);
  return 'Revue systématique sans titre';
}

export function hasMeaningfulDraftContent(
  pico: PicoInputs,
  resultData: unknown
): boolean {
  if (resultData) return true;
  return Boolean(
    (pico.p || '').trim() ||
    (pico.i || '').trim() ||
    (pico.c || '').trim() ||
    (pico.o || '').trim() ||
    (pico.not || '').trim()
  );
}

/**
 * Hydrate de manière transparente une notice `v1.0.2` (ou partielle) vers le modèle canonique `CanonicalStudyRecord`
 * tout en préservant `pmid`, `robEvaluations` et l'ensemble des décisions existantes.
 */
export function hydrateLegacyScreenedArticle(raw: ScreenedArticle): CanonicalStudyRecord {
  const validSources = new Set<BibliographicSource>(CANONICAL_SOURCE_ORDER);
  const rawSources = Array.isArray(raw.sources)
    ? raw.sources.filter((s): s is BibliographicSource => validSources.has(s))
    : [];

  const normalizedPmid = normalizePmid(raw.identifiers?.pmid ?? raw.pmid);
  const normalizedDoi = normalizeDoi(raw.identifiers?.doi ?? raw.doi);
  const normalizedEmbaseId = normalizeEmbaseId(raw.identifiers?.embaseId ?? raw.identifiers?.embasePui);
  const cochraneId = raw.identifiers?.cochraneId?.trim() || undefined;
  const registryIds =
    Array.isArray(raw.identifiers?.registryIds) && raw.identifiers.registryIds.length > 0
      ? [...raw.identifiers.registryIds]
      : undefined;

  const identifiers: StudyIdentifiers = {
    ...(normalizedPmid ? { pmid: normalizedPmid } : {}),
    ...(normalizedDoi ? { doi: normalizedDoi } : {}),
    ...(normalizedEmbaseId ? { embaseId: normalizedEmbaseId } : {}),
    ...(raw.identifiers?.embasePui ? { embasePui: raw.identifiers.embasePui } : {}),
    ...(cochraneId ? { cochraneId } : {}),
    ...(registryIds ? { registryIds } : {})
  };

  const sources: BibliographicSource[] =
    rawSources.length > 0
      ? CANONICAL_SOURCE_ORDER.filter((s) => rawSources.includes(s))
      : ['pubmed'];

  const validKinds: readonly StudyRecordKind[] = ['article', 'review', 'trial_registry', 'other'];
  const recordKind: StudyRecordKind =
    raw.recordKind && validKinds.includes(raw.recordKind)
      ? raw.recordKind
      : inferRecordKindFromPubTypes(raw.publicationTypes, sources[0]);

  const title = raw.title || '';
  const authors = raw.authors || '';
  const pubDate = raw.pubDate || '';

  const id =
    typeof raw.id === 'string' && raw.id.trim().length > 0
      ? raw.id.trim()
      : buildCanonicalRecordId(
          identifiers,
          normalizeTitleForDedup(title),
          extractFirstAuthorSurname(authors),
          extractPubYear(pubDate)
        );

  const pmid = normalizedPmid ?? (typeof raw.pmid === 'string' ? raw.pmid.trim() : '');
  const url =
    (typeof raw.url === 'string' && raw.url.trim()) ||
    resolvePreferredUrl(identifiers, pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '');

  return {
    id,
    pmid,
    ...(normalizedDoi ? { doi: normalizedDoi } : {}),
    identifiers,
    sources,
    recordKind,
    title,
    authors,
    source: raw.source || '',
    pubDate,
    abstract: raw.abstract || '',
    meshHeadings: Array.isArray(raw.meshHeadings) ? [...raw.meshHeadings] : [],
    publicationTypes: Array.isArray(raw.publicationTypes) ? [...raw.publicationTypes] : [],
    ...(raw.language ? { language: raw.language } : {}),
    url,
    status: raw.status || 'pending',
    ...(raw.exclusionReason ? { exclusionReason: raw.exclusionReason } : {}),
    ...(raw.evidenceSnippet ? { evidenceSnippet: raw.evidenceSnippet } : {}),
    ...(raw.evaluatedBy ? { evaluatedBy: raw.evaluatedBy } : {})
  };
}

function normalizeSnapshotForStorage(snapshot: SavedReviewSnapshot): SavedReviewSnapshot {
  const cleanSettings = sanitizeSearchSettings(snapshot.searchSettings);
  const hydratedArticles = (snapshot.screenedArticles || []).map((art) =>
    hydrateLegacyScreenedArticle(art)
  );
  const summary = computeReviewSummary(
    snapshot.resultData,
    hydratedArticles,
    snapshot.robEvaluations
  );
  const cleanSnapshot: SavedReviewSnapshot = {
    schemaVersion: 2,
    id: snapshot.id,
    title: (snapshot.title || '').trim() || buildDefaultReviewTitle(snapshot.picoInputs),
    createdAt: Number.isFinite(snapshot.createdAt) ? snapshot.createdAt : Date.now(),
    updatedAt: Date.now(),
    wizardStep: snapshot.wizardStep,
    summary,
    picoInputs: {
      p: snapshot.picoInputs.p || '',
      i: snapshot.picoInputs.i || '',
      c: snapshot.picoInputs.c || '',
      o: snapshot.picoInputs.o || '',
      not: snapshot.picoInputs.not || ''
    },
    searchSettings: cleanSettings,
    resultData: snapshot.resultData,
    refinementCount: Number.isFinite(snapshot.refinementCount) ? snapshot.refinementCount : 0,
    screenedArticles: hydratedArticles,
    robEvaluations: { ...snapshot.robEvaluations },
    ...(snapshot.importBatches && snapshot.importBatches.length > 0
      ? { importBatches: [...snapshot.importBatches] }
      : {}),
    ...(snapshot.deduplicationStats ? { deduplicationStats: snapshot.deduplicationStats } : {})
  };

  return stripSensitiveKeys(cleanSnapshot) as SavedReviewSnapshot;
}

async function putRecord(record: SavedReviewSnapshot): Promise<SavedReviewSnapshot> {
  const normalized = normalizeSnapshotForStorage(record);

  if (!hasIndexedDb()) {
    memoryStore.set(normalized.id, normalized);
    return normalized;
  }

  try {
    const db = await openReviewsDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(normalized);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write error'));
    });
    db.close();
  } catch {
    memoryStore.set(normalized.id, normalized);
  }
  return normalized;
}

async function getRecord(id: string): Promise<SavedReviewSnapshot | null> {
  if (!hasIndexedDb()) {
    const rec = memoryStore.get(id) ?? null;
    return rec && rec.schemaVersion === 1 ? normalizeSnapshotForStorage(rec) : rec;
  }

  try {
    const db = await openReviewsDb();
    const record = await new Promise<SavedReviewSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve((req.result as SavedReviewSnapshot | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read error'));
    });
    db.close();
    if (record && record.schemaVersion === 1) {
      return normalizeSnapshotForStorage(record);
    }
    return record;
  } catch {
    const rec = memoryStore.get(id) ?? null;
    return rec && rec.schemaVersion === 1 ? normalizeSnapshotForStorage(rec) : rec;
  }
}

async function deleteRecord(id: string): Promise<void> {
  if (!hasIndexedDb()) {
    memoryStore.delete(id);
    return;
  }

  try {
    const db = await openReviewsDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete error'));
    });
    db.close();
  } catch {
    memoryStore.delete(id);
  }
}

export async function listReviews(): Promise<SavedReviewSnapshot[]> {
  let allRecords: SavedReviewSnapshot[] = [];

  if (!hasIndexedDb()) {
    allRecords = Array.from(memoryStore.values());
  } else {
    try {
      const db = await openReviewsDb();
      allRecords = await new Promise<SavedReviewSnapshot[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve((req.result as SavedReviewSnapshot[]) || []);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB list error'));
      });
      db.close();
    } catch {
      allRecords = Array.from(memoryStore.values());
    }
  }

  return allRecords
    .filter(item => item && item.id !== ACTIVE_DRAFT_ID)
    .map(item => (item.schemaVersion === 1 ? normalizeSnapshotForStorage(item) : item))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function saveReview(snapshot: SavedReviewSnapshot): Promise<SavedReviewSnapshot> {
  if (snapshot.id === ACTIVE_DRAFT_ID) {
    throw new Error('Reserved draft identifier cannot be saved as a named review.');
  }
  return putRecord(snapshot);
}

export async function deleteReview(id: string): Promise<void> {
  if (id === ACTIVE_DRAFT_ID) return;
  await deleteRecord(id);
}

export async function saveActiveDraft(
  snapshot: Omit<SavedReviewSnapshot, 'id'>
): Promise<SavedReviewSnapshot> {
  return putRecord({
    ...snapshot,
    id: ACTIVE_DRAFT_ID
  });
}

export async function loadActiveDraft(): Promise<SavedReviewSnapshot | null> {
  return getRecord(ACTIVE_DRAFT_ID);
}

export async function clearActiveDraft(): Promise<void> {
  await deleteRecord(ACTIVE_DRAFT_ID);
}

export function serializeReviewToJson(snapshot: SavedReviewSnapshot): string {
  const sanitized = normalizeSnapshotForStorage(snapshot);
  return JSON.stringify(sanitized, null, 2);
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

export type ParseReviewJsonResult =
  | { readonly ok: true; readonly snapshot: SavedReviewSnapshot }
  | { readonly ok: false; readonly error: string };

export function parseAndValidateReviewJson(rawJson: string): ParseReviewJsonResult {
  if (!rawJson || !rawJson.trim()) {
    return { ok: false, error: 'Le fichier JSON est vide.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, error: 'Fichier JSON mal formé : impossible de lire son contenu.' };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Format de fichier invalide : objet de revue attendu.' };
  }

  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) {
    return {
      ok: false,
      error: `Version de schéma non prise en charge (attendu : 1 ou 2, reçu : ${String(parsed.schemaVersion)}).`
    };
  }

  if (!isPlainObject(parsed.picoInputs)) {
    return { ok: false, error: 'Champ PICO/PECO manquant ou invalide dans le fichier.' };
  }

  const picoRaw = parsed.picoInputs;
  if (
    typeof picoRaw.p !== 'string' ||
    typeof picoRaw.i !== 'string' ||
    typeof picoRaw.c !== 'string' ||
    typeof picoRaw.o !== 'string'
  ) {
    return { ok: false, error: 'Les champs P, I, C et O doivent être des chaînes de caractères.' };
  }

  const rawStep = parsed.wizardStep;
  const wizardStep: ReviewWizardStep =
    rawStep === 1 || rawStep === 2 || rawStep === 3 || rawStep === 4 ? rawStep : 1;

  if (!Array.isArray(parsed.screenedArticles)) {
    return { ok: false, error: 'Champ screenedArticles manquant ou invalide.' };
  }

  for (const item of parsed.screenedArticles) {
    if (
      !isPlainObject(item) ||
      typeof item.title !== 'string' ||
      (typeof item.id !== 'string' && typeof item.pmid !== 'string')
    ) {
      return { ok: false, error: 'Une notice dans screenedArticles est invalide ou corrompue.' };
    }
  }

  if (!isPlainObject(parsed.robEvaluations)) {
    return { ok: false, error: 'Champ robEvaluations manquant ou invalide.' };
  }

  let resultData: SavedReviewResultData | null = null;
  if (parsed.resultData !== null && parsed.resultData !== undefined) {
    if (
      !isPlainObject(parsed.resultData) ||
      typeof parsed.resultData.pubmedQuery !== 'string' ||
      !Array.isArray(parsed.resultData.mappedBlocks)
    ) {
      return { ok: false, error: 'Champ resultData invalide dans le fichier de revue.' };
    }
    resultData = stripSensitiveKeys(parsed.resultData) as SavedReviewResultData;
  }

  const rawSettings = isPlainObject(parsed.searchSettings)
    ? (stripSensitiveKeys(parsed.searchSettings) as unknown as PipelineSettings)
    : ({ strategy: 'balanced' } as PipelineSettings);

  const picoInputs: PicoInputs = {
    p: picoRaw.p,
    i: picoRaw.i,
    c: picoRaw.c,
    o: picoRaw.o,
    not: typeof picoRaw.not === 'string' ? picoRaw.not : ''
  };

  const screenedArticles = (stripSensitiveKeys(parsed.screenedArticles) as ScreenedArticle[]).map(
    art => hydrateLegacyScreenedArticle(art)
  );
  const robEvaluations = stripSensitiveKeys(parsed.robEvaluations) as Record<string, Rob2ArticleEvaluation>;
  const importBatches = Array.isArray(parsed.importBatches)
    ? (stripSensitiveKeys(parsed.importBatches) as SourceImportBatch[])
    : undefined;
  const deduplicationStats = isPlainObject(parsed.deduplicationStats)
    ? (stripSensitiveKeys(parsed.deduplicationStats) as unknown as CorpusDeduplicationStats)
    : undefined;
  const now = Date.now();

  const rawId = typeof parsed.id === 'string' && parsed.id.trim() && parsed.id !== ACTIVE_DRAFT_ID
    ? parsed.id.trim()
    : `rev-${now}`;

  const title =
    typeof parsed.title === 'string' && parsed.title.trim()
      ? parsed.title.trim()
      : buildDefaultReviewTitle(picoInputs);

  const snapshot = normalizeSnapshotForStorage({
    schemaVersion: 2,
    id: rawId,
    title,
    createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) ? parsed.createdAt : now,
    updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : now,
    wizardStep,
    summary: computeReviewSummary(resultData, screenedArticles, robEvaluations),
    picoInputs,
    searchSettings: sanitizeSearchSettings(rawSettings),
    resultData,
    refinementCount:
      typeof parsed.refinementCount === 'number' && Number.isFinite(parsed.refinementCount)
        ? parsed.refinementCount
        : 0,
    screenedArticles,
    robEvaluations,
    ...(importBatches ? { importBatches } : {}),
    ...(deduplicationStats ? { deduplicationStats } : {})
  });

  return { ok: true, snapshot };
}
