/**
 * Agent de Dépouillement Clinique — IA Cloud Multi-Fournisseurs (Gemini, OpenAI, Anthropic)
 *
 * L'analyse sémantique est effectuée par le modèle Cloud haut-débit (Tier 'batch' : Flash / GPT-4o-mini / Haiku)
 * qui lit le titre, le résumé compressé et les descripteurs MeSH réels de chaque notice PubMed.
 */

import {
  aiScreenBatchArticles,
  BatchScreenItemResult,
  PRISMA_EXCLUSION_LABELS_FR,
  ScreeningJsonParseError,
  formatPrismaExclusionReason,
  getAiConfig,
  getActiveProviderLabel,
  mapErrorToUserMessage
} from './localAiService';
import {
  BibliographicSource,
  CanonicalStudyRecord,
  StudyIdentifiers,
  StudyRecordKind,
  buildCanonicalRecordId,
  extractFirstAuthorSurname,
  extractPubYear,
  getArticleKey,
  inferRecordKindFromPubTypes,
  normalizeDoi,
  normalizePmid,
  normalizeTitleForDedup,
  resolvePreferredUrl
} from './studyRecordTypes';

export type {
  BibliographicSource,
  CanonicalStudyRecord,
  StudyIdentifiers,
  StudyRecordKind
};

export interface ScreenedArticle {
  id?: string;
  pmid: string;
  doi?: string;
  identifiers?: StudyIdentifiers;
  sources?: readonly BibliographicSource[];
  recordKind?: StudyRecordKind;
  title: string;
  authors: string;
  source: string;
  pubDate: string;
  abstract: string;
  meshHeadings: string[];
  publicationTypes?: string[];
  language?: string;
  status: 'pending' | 'included' | 'maybe' | 'excluded' | 'error';
  exclusionReason?: string;
  evidenceSnippet?: string;
  url: string;
  evaluatedBy?: 'gemini' | 'openai' | 'anthropic' | 'manual' | 'rayyan';
}

export interface ScreeningReport {
  totalScreened: number;
  totalIncluded: number;
  totalMaybe?: number;
  totalExcluded: number;
  totalPending?: number;
  failedPendingCount?: number;
  lastErrorMessage?: string;
  exclusionBreakdown: Array<{ reason: string; count: number; pmids: string[] }>;
  screenedArticles: ScreenedArticle[];
}

function hasMissingOrEmptyAbstract(abstractText?: string): boolean {
  if (!abstractText) return true;
  const clean = abstractText.trim();
  if (clean.length < 25) return true;
  if (/aucun r[ée]sum[ée] disponible|no abstract available/i.test(clean)) return true;
  return false;
}

export interface RawPubMedArticleInput {
  readonly id?: string;
  readonly pmid?: string | number;
  readonly doi?: string | null;
  readonly identifiers?: StudyIdentifiers;
  readonly sources?: readonly BibliographicSource[];
  readonly recordKind?: StudyRecordKind;
  readonly title?: string;
  readonly authors?: string;
  readonly source?: string;
  readonly pubDate?: string;
  readonly abstract?: string;
  readonly meshHeadings?: readonly string[];
  readonly publicationTypes?: readonly string[];
  readonly language?: string;
  readonly url?: string;
}

/**
 * Normalise une notice brute PubMed (ou un objet compatible) vers le format canonique `CanonicalStudyRecord`.
 */
export function normalizePubMedToCanonical(art: RawPubMedArticleInput): CanonicalStudyRecord {
  const pmid = normalizePmid(art.pmid) ?? (art.pmid !== undefined ? String(art.pmid).trim() : '');
  const doi = normalizeDoi(art.doi);
  const title = art.title || '';
  const authors = art.authors || '';
  const pubDate = art.pubDate || '';
  const publicationTypes = Array.isArray(art.publicationTypes) ? [...art.publicationTypes] : [];
  const identifiers: StudyIdentifiers = {
    ...(normalizePmid(pmid) ? { pmid } : {}),
    ...(doi ? { doi } : {})
  };
  const id = buildCanonicalRecordId(
    identifiers,
    normalizeTitleForDedup(title),
    extractFirstAuthorSurname(authors),
    extractPubYear(pubDate)
  );
  const url = resolvePreferredUrl(
    identifiers,
    art.url || (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '')
  );

  return {
    id,
    pmid,
    ...(doi ? { doi } : {}),
    identifiers,
    sources: ['pubmed'],
    recordKind: inferRecordKindFromPubTypes(publicationTypes, 'pubmed'),
    title,
    authors,
    source: art.source || '',
    pubDate,
    abstract: art.abstract || '',
    meshHeadings: Array.isArray(art.meshHeadings) ? [...art.meshHeadings] : [],
    publicationTypes,
    url,
    status: 'pending'
  };
}

/**
 * Initialise la liste des articles reçus de PubMed en statut "En attente de dépouillement"
 */
export function initializeUnscreenedArticles(articles: readonly RawPubMedArticleInput[]): ScreenedArticle[] {
  if (!articles || articles.length === 0) return [];
  return articles.map(art => normalizePubMedToCanonical(art));
}

/**
 * Dépouillement clinique intégral par lots avec respect du principe de précaution Cochrane.
 * Propage toute erreur d'authentification, de quota ou de réponse invalide vers l'interface appelante.
 */
export async function runAgentScreeningDeep(
  articles: readonly RawPubMedArticleInput[],
  pico: { p: string; i: string; c: string; o: string; not?: string },
  onProgress?: (current: number, total: number, articleTitle: string) => void,
  onArticleScreened?: (article: ScreenedArticle, index: number, total: number) => void,
  shouldCancel?: () => boolean,
  abortSignal?: AbortSignal
): Promise<ScreeningReport> {
  if (!articles || articles.length === 0) {
    return {
      totalScreened: 0,
      totalIncluded: 0,
      totalMaybe: 0,
      totalExcluded: 0,
      totalPending: 0,
      exclusionBreakdown: [],
      screenedArticles: []
    };
  }

  const total = articles.length;
  const config = getAiConfig();
  const isFreeTier = config.rateLimitMode === 'free_tier';
  const BATCH_SIZE = 12;
  const CONCURRENCY = isFreeTier ? 1 : 2;
  const providerLabel = getActiveProviderLabel(config, 'batch');
  const evaluatedBy: 'gemini' | 'openai' | 'anthropic' =
    config.provider === 'openai' ? 'openai' : config.provider === 'anthropic' ? 'anthropic' : 'gemini';

  const isCancelled = (): boolean => Boolean(abortSignal?.aborted || (shouldCancel && shouldCancel()));

  interface IndexedArticle {
    readonly slotIndex: number;
    readonly article: RawPubMedArticleInput;
  }

  const batches: Array<{ startIdx: number; items: readonly IndexedArticle[] }> = [];
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const slice = articles.slice(i, i + BATCH_SIZE).map((article, offset) => ({
      slotIndex: i + offset,
      article
    }));
    batches.push({ startIdx: i, items: slice });
  }

  const screenedSlots: Array<ScreenedArticle | undefined> = new Array(total);
  let completedCount = 0;
  let failedPendingCount = 0;
  let lastErrorMessage: string | undefined;

  const buildCanonicalBase = (art: RawPubMedArticleInput): ScreenedArticle => {
    const rawPmid = art.pmid !== undefined ? String(art.pmid).trim() : '';
    const normPmid = normalizePmid(art.identifiers?.pmid ?? rawPmid);
    const normDoi = normalizeDoi(art.identifiers?.doi ?? art.doi);
    const identifiers: StudyIdentifiers = {
      ...(art.identifiers ?? {}),
      ...(normPmid ? { pmid: normPmid } : {}),
      ...(normDoi ? { doi: normDoi } : {})
    };
    const sources: readonly BibliographicSource[] =
      art.sources && art.sources.length > 0 ? [...art.sources] : ['pubmed'];
    const publicationTypes = Array.isArray(art.publicationTypes) ? [...art.publicationTypes] : [];
    const recordKind: StudyRecordKind =
      art.recordKind ?? inferRecordKindFromPubTypes(publicationTypes, sources[0]);
    const title = art.title || '';
    const authors = art.authors || '';
    const pubDate = art.pubDate || '';
    const id =
      (typeof art.id === 'string' && art.id.trim().length > 0 ? art.id.trim() : undefined) ??
      buildCanonicalRecordId(
        identifiers,
        normalizeTitleForDedup(title),
        extractFirstAuthorSurname(authors),
        extractPubYear(pubDate)
      );
    const url = resolvePreferredUrl(
      identifiers,
      art.url || (normPmid ? `https://pubmed.ncbi.nlm.nih.gov/${normPmid}/` : '')
    );

    return {
      id,
      pmid: normPmid ?? rawPmid,
      ...(normDoi ? { doi: normDoi } : {}),
      identifiers,
      sources,
      recordKind,
      title,
      authors,
      source: art.source || '',
      pubDate,
      abstract: art.abstract || '',
      meshHeadings: Array.isArray(art.meshHeadings) ? [...art.meshHeadings] : [],
      publicationTypes,
      ...(art.language ? { language: art.language } : {}),
      status: 'pending',
      url
    };
  };

  const buildPendingArticle = (art: RawPubMedArticleInput): ScreenedArticle => buildCanonicalBase(art);

  const markItemsPending = (items: readonly IndexedArticle[], countAsFailure = false) => {
    for (const entry of items) {
      if (!screenedSlots[entry.slotIndex]) {
        screenedSlots[entry.slotIndex] = buildPendingArticle(entry.article);
        if (countAsFailure) {
          failedPendingCount++;
        }
      }
    }
  };

  const commitScreenedArticle = (slotIndex: number, screened: ScreenedArticle) => {
    screenedSlots[slotIndex] = screened;
    completedCount++;
    onArticleScreened?.(screened, completedCount, total);
  };

  /**
   * Traite un sous-lot d'articles ayant un résumé avec :
   * 1. 1 tentative automatique supplémentaire en cas d'échec de parsing JSON ;
   * 2. Bisection en 2 moitiés si l'échec persiste et que le sous-lot compte > 2 notices ;
   * 3. Sauvegarde immédiate au fil de l'eau de chaque notice valide via `onArticleScreened`.
   */
  const screenAbstractSubBatch = async (
    itemsWithAbstract: readonly IndexedArticle[],
    allowBisection: boolean
  ): Promise<void> => {
    if (itemsWithAbstract.length === 0) return;
    if (isCancelled()) {
      markItemsPending(itemsWithAbstract, false);
      return;
    }

    const toPayload = (list: readonly IndexedArticle[]) =>
      list.map(({ article }) => {
        const base = buildCanonicalBase(article);
        return {
          id: base.id,
          pmid: base.pmid,
          identifiers: base.identifiers,
          sources: base.sources,
          recordKind: base.recordKind,
          title: base.title,
          abstract: base.abstract,
          meshHeadings: [...base.meshHeadings]
        };
      });

    let evaluatedBatch: BatchScreenItemResult[] = [];
    let lastErr: unknown = null;
    let isParseFailure = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (isCancelled()) {
        markItemsPending(itemsWithAbstract, false);
        return;
      }
      try {
        evaluatedBatch = await aiScreenBatchArticles(toPayload(itemsWithAbstract), pico, abortSignal);
        lastErr = null;
        isParseFailure = false;
        break;
      } catch (err: unknown) {
        if (isCancelled() || (err instanceof DOMException && err.name === 'AbortError')) {
          markItemsPending(itemsWithAbstract, false);
          return;
        }
        lastErr = err;
        isParseFailure = err instanceof ScreeningJsonParseError;
        // Seul un échec de parsing JSON déclenche la 2e tentative automatique ; les erreurs auth/réseau/quota sortent immédiatement
        if (!isParseFailure) {
          break;
        }
      }
    }

    if (lastErr !== null) {
      if (isParseFailure && allowBisection && itemsWithAbstract.length > 2 && !isCancelled()) {
        const mid = Math.ceil(itemsWithAbstract.length / 2);
        await screenAbstractSubBatch(itemsWithAbstract.slice(0, mid), false);
        await screenAbstractSubBatch(itemsWithAbstract.slice(mid), false);
        return;
      }
      lastErrorMessage = mapErrorToUserMessage(lastErr);
      markItemsPending(itemsWithAbstract, true);
      return;
    }

    const evalMap = new Map<string, BatchScreenItemResult>();
    for (const e of evaluatedBatch) {
      if (e.recordId && e.recordId.trim()) {
        evalMap.set(e.recordId.trim(), e);
      }
      if (e.pmid && String(e.pmid).trim()) {
        evalMap.set(String(e.pmid).trim(), e);
      }
    }

    const missingEntries: IndexedArticle[] = [];
    for (const entry of itemsWithAbstract) {
      const { slotIndex, article } = entry;
      const base = buildCanonicalBase(article);
      const artKey = getArticleKey(base);
      const pmidTrimmed = String(base.pmid || '').trim();
      const aiRes = evalMap.get(artKey) ?? (pmidTrimmed ? evalMap.get(pmidTrimmed) : undefined);
      if (!aiRes) {
        missingEntries.push(entry);
        continue;
      }

      const screened: ScreenedArticle = {
        ...base,
        status: aiRes.status,
        exclusionReason:
          aiRes.status === 'excluded'
            ? formatPrismaExclusionReason(aiRes.exclusionCategory, aiRes.exclusionReason)
            : undefined,
        evidenceSnippet:
          aiRes.evidenceSnippet ||
          (aiRes.status === 'included'
            ? 'Conforme aux critères PICO'
            : aiRes.status === 'maybe'
              ? 'Information partielle au résumé : à vérifier sur texte intégral.'
              : PRISMA_EXCLUSION_LABELS_FR.other),
        evaluatedBy
      };
      commitScreenedArticle(slotIndex, screened);
    }

    // Si le modèle a omis quelques PMIDs dans un lot par ailleurs valide, tenter une passe réduite sur les manquants
    if (missingEntries.length > 0 && !isCancelled()) {
      if (allowBisection && missingEntries.length < itemsWithAbstract.length) {
        await screenAbstractSubBatch(missingEntries, false);
      } else if (allowBisection && missingEntries.length > 2) {
        const mid = Math.ceil(missingEntries.length / 2);
        await screenAbstractSubBatch(missingEntries.slice(0, mid), false);
        await screenAbstractSubBatch(missingEntries.slice(mid), false);
      } else {
        lastErrorMessage = `Réponse IA incomplète : ${missingEntries.length} notice(s) omise(s) dans le sous-lot.`;
        markItemsPending(missingEntries, true);
      }
    }
  };

  const processBatch = async (batchEntry: { startIdx: number; items: readonly IndexedArticle[] }) => {
    const { startIdx, items: batch } = batchEntry;
    const batchStart = startIdx + 1;
    const batchEnd = Math.min(startIdx + batch.length, total);

    if (isCancelled()) {
      markItemsPending(batch, false);
      return;
    }

    onProgress?.(completedCount + 1, total, `Analyse du lot (${batchStart} à ${batchEnd} / ${total}) par ${providerLabel}...`);

    // 1. Les articles sans résumé sont immédiatement retenus en 'maybe' selon Cochrane (sans appel IA)
    const itemsWithAbstract: IndexedArticle[] = [];
    for (const entry of batch) {
      const { slotIndex, article } = entry;
      if (hasMissingOrEmptyAbstract(article.abstract)) {
        const base = buildCanonicalBase(article);
        commitScreenedArticle(slotIndex, {
          ...base,
          status: 'maybe',
          evidenceSnippet:
            "Résumé absent dans la notice : retenu par précaution pour vérification sur texte intégral (directive Cochrane / PRISMA 2020).",
          evaluatedBy
        });
      } else {
        itemsWithAbstract.push(entry);
      }
    }

    // 2. Traitement résilient du sous-lot avec retry + bisection
    await screenAbstractSubBatch(itemsWithAbstract, true);
  };

  for (let b = 0; b < batches.length; b += CONCURRENCY) {
    if (isCancelled()) {
      for (let rem = b; rem < batches.length; rem++) {
        markItemsPending(batches[rem].items, false);
      }
      break;
    }

    const wave = batches.slice(b, b + CONCURRENCY);
    await Promise.allSettled(wave.map(batchEntry => processBatch(batchEntry)));

    // Régulation douce uniquement si l'utilisateur est resté en quota gratuit (15 req/min)
    if (isFreeTier && (b + CONCURRENCY < batches.length) && !isCancelled()) {
      const done = Math.min(total, (b + CONCURRENCY) * BATCH_SIZE);
      for (let pauseSec = 4; pauseSec > 0; pauseSec--) {
        if (isCancelled()) break;
        onProgress?.(done, total, `Lot validé (${done}/${total}). Pause quota gratuit (${pauseSec}s)...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  const screenedArticles = screenedSlots.filter((item): item is ScreenedArticle => Boolean(item));
  const metrics = computeScreeningMetrics(screenedArticles);

  // Si aucune notice n'a pu être évaluée et qu'une erreur a laissé des notices en attente, propager l'erreur explicite
  if (failedPendingCount > 0 && metrics.totalScreened === 0 && !isCancelled()) {
    throw new Error(
      `${lastErrorMessage || "Erreur lors du dépouillement IA."} (${failedPendingCount} notice(s) restée(s) en attente).`
    );
  }

  return {
    ...metrics,
    ...(failedPendingCount > 0 ? { failedPendingCount, lastErrorMessage } : {})
  };
}

/**
 * Calcule de manière centralisée les effectifs PRISMA (inclus, à vérifier, exclus, en attente, motifs d'exclusion)
 * à partir d'une liste d'articles dépouillés.
 */
export function computeScreeningMetrics(articles: ScreenedArticle[]): ScreeningReport & { totalPending: number; totalMaybe: number } {
  const list = articles || [];
  const included = list.filter(a => a.status === 'included');
  const maybe = list.filter(a => a.status === 'maybe');
  const excluded = list.filter(a => a.status === 'excluded');
  const pending = list.filter(a => a.status === 'pending');
  const evaluated = list.filter(a => a.status === 'included' || a.status === 'maybe' || a.status === 'excluded');

  const reasonMap: Record<string, string[]> = {};
  excluded.forEach(a => {
    const normalizedReason = (a.exclusionReason || '').trim() || "Autre critère de non-conformité";
    if (!reasonMap[normalizedReason]) reasonMap[normalizedReason] = [];
    reasonMap[normalizedReason].push(getArticleKey(a));
  });

  const exclusionBreakdown = Object.entries(reasonMap)
    .map(([reason, pmids]) => ({
      reason,
      count: pmids.length,
      pmids
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, 'fr'));

  return {
    totalScreened: evaluated.length,
    totalPending: pending.length,
    totalIncluded: included.length,
    totalMaybe: maybe.length,
    totalExcluded: excluded.length,
    exclusionBreakdown,
    screenedArticles: list
  };
}

/**
 * Sélectionne strictement les `limit` prochaines notices encore en attente (`status === 'pending'`),
 * sans jamais ré-soumettre les notices déjà tranchées manuellement, par IA ou importées depuis Rayyan.
 */
export function selectPendingArticlesBatch(
  articles: readonly ScreenedArticle[],
  limit?: number
): ScreenedArticle[] {
  const pending = (articles || []).filter(a => a.status === 'pending');
  if (typeof limit === 'number' && limit > 0) {
    return pending.slice(0, limit);
  }
  return pending;
}

/**
 * Fusionne de façon immuable le résultat d'un article dépouillé par clé canonique (`id` ou `pmid`)
 * en préservant toutes les autres décisions existantes (manuelles, Rayyan ou IA précédente).
 */
export function mergeScreenedArticleUpdate(
  articles: readonly ScreenedArticle[],
  updated: ScreenedArticle
): ScreenedArticle[] {
  const updatedKey = getArticleKey(updated);
  return articles.map(art => {
    const artKey = getArticleKey(art);
    const sameRecord =
      (Boolean(artKey) && artKey === updatedKey) ||
      (Boolean(art.pmid) && Boolean(updated.pmid) && art.pmid === updated.pmid);
    if (!sameRecord) return art;
    if (art.status !== 'pending' && (art.evaluatedBy === 'manual' || art.evaluatedBy === 'rayyan')) {
      return art;
    }
    return updated;
  });
}
