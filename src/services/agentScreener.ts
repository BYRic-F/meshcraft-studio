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
  formatPrismaExclusionReason,
  getAiConfig,
  getActiveProviderLabel
} from './localAiService';

export interface ScreenedArticle {
  pmid: string;
  doi?: string;
  title: string;
  authors: string;
  source: string;
  pubDate: string;
  abstract: string;
  meshHeadings: string[];
  publicationTypes?: string[];
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
  readonly pmid?: string | number;
  readonly doi?: string | null;
  readonly title?: string;
  readonly authors?: string;
  readonly source?: string;
  readonly pubDate?: string;
  readonly abstract?: string;
  readonly meshHeadings?: readonly string[];
  readonly publicationTypes?: readonly string[];
  readonly url?: string;
}

/**
 * Initialise la liste des articles reçus de PubMed en statut "En attente de dépouillement"
 */
export function initializeUnscreenedArticles(articles: readonly RawPubMedArticleInput[]): ScreenedArticle[] {
  if (!articles || articles.length === 0) return [];
  return articles.map(art => ({
    pmid: String(art.pmid || ''),
    doi: art.doi || undefined,
    title: art.title || '',
    authors: art.authors || '',
    source: art.source || '',
    pubDate: art.pubDate || '',
    abstract: art.abstract || '',
    meshHeadings: Array.isArray(art.meshHeadings) ? [...art.meshHeadings] : [],
    publicationTypes: Array.isArray(art.publicationTypes) ? [...art.publicationTypes] : [],
    status: 'pending' as const,
    url: art.url || `https://pubmed.ncbi.nlm.nih.gov/${art.pmid}/`
  }));
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
  const BATCH_SIZE = isFreeTier ? 12 : 20;
  const CONCURRENCY = isFreeTier ? 1 : 2;
  const providerLabel = getActiveProviderLabel(config, 'batch');
  const evaluatedBy: 'gemini' | 'openai' | 'anthropic' =
    config.provider === 'openai' ? 'openai' : config.provider === 'anthropic' ? 'anthropic' : 'gemini';

  const isCancelled = (): boolean => Boolean(abortSignal?.aborted || (shouldCancel && shouldCancel()));

  const batches: Array<{ startIdx: number; items: readonly RawPubMedArticleInput[] }> = [];
  for (let i = 0; i < total; i += BATCH_SIZE) {
    batches.push({ startIdx: i, items: articles.slice(i, i + BATCH_SIZE) });
  }

  const screenedSlots: Array<ScreenedArticle | undefined> = new Array(total);
  let completedCount = 0;

  const markBatchPending = (startIdx: number, batch: readonly RawPubMedArticleInput[]) => {
    for (let k = 0; k < batch.length; k++) {
      const art = batch[k];
      const pmid = String(art.pmid || '');
      screenedSlots[startIdx + k] = {
        pmid,
        doi: art.doi || undefined,
        title: art.title || '',
        authors: art.authors || '',
        source: art.source || '',
        pubDate: art.pubDate || '',
        abstract: art.abstract || '',
        meshHeadings: Array.isArray(art.meshHeadings) ? [...art.meshHeadings] : [],
        publicationTypes: Array.isArray(art.publicationTypes) ? [...art.publicationTypes] : [],
        status: 'pending',
        url: art.url || `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      };
    }
  };

  const processBatch = async (batchEntry: { startIdx: number; items: readonly RawPubMedArticleInput[] }) => {
    const { startIdx, items: batch } = batchEntry;
    const batchStart = startIdx + 1;
    const batchEnd = Math.min(startIdx + batch.length, total);

    if (isCancelled()) {
      markBatchPending(startIdx, batch);
      return;
    }

    onProgress?.(completedCount + 1, total, `Analyse du lot (${batchStart} à ${batchEnd} / ${total}) par ${providerLabel}...`);

    // Séparer les articles avec résumé (évaluables par IA) et sans résumé (retenus d'office en 'maybe' selon Cochrane)
    const articlesWithAbstract = batch
      .filter(a => !hasMissingOrEmptyAbstract(a.abstract))
      .map(a => ({
        pmid: String(a.pmid || ''),
        title: a.title || '',
        abstract: a.abstract || '',
        meshHeadings: a.meshHeadings ? [...a.meshHeadings] : []
      }));

    let evaluatedBatch: BatchScreenItemResult[] = [];

    if (articlesWithAbstract.length > 0) {
      try {
        evaluatedBatch = await aiScreenBatchArticles(articlesWithAbstract, pico, abortSignal);
      } catch (err: unknown) {
        if (isCancelled() || (err instanceof DOMException && err.name === 'AbortError')) {
          markBatchPending(startIdx, batch);
          return;
        }
        throw err;
      }
    }

    if (articlesWithAbstract.length > 0 && evaluatedBatch.length === 0 && isCancelled()) {
      markBatchPending(startIdx, batch);
      return;
    }

    const evalMap = new Map<string, BatchScreenItemResult>();
    evaluatedBatch.forEach(e => {
      if (e.pmid) {
        const rawKey = String(e.pmid).trim();
        const digitsKey = rawKey.replace(/\D+/g, '');
        evalMap.set(rawKey, e);
        if (digitsKey) evalMap.set(digitsKey, e);
      }
    });

    for (let k = 0; k < batch.length; k++) {
      const art = batch[k];
      const pmid = String(art.pmid || '');
      const missingAbs = hasMissingOrEmptyAbstract(art.abstract);
      const aiRes = evalMap.get(pmid);

      let status: ScreenedArticle['status'] = 'maybe';
      let exclusionReason: string | undefined = undefined;
      let evidenceSnippet = 'À vérifier sur texte intégral.';

      if (missingAbs) {
        status = 'maybe';
        evidenceSnippet = "Résumé absent dans PubMed : retenu par précaution pour vérification sur texte intégral (directive Cochrane / PRISMA 2020).";
      } else if (aiRes) {
        status = aiRes.status;
        exclusionReason =
          aiRes.status === 'excluded'
            ? formatPrismaExclusionReason(aiRes.exclusionCategory, aiRes.exclusionReason)
            : undefined;
        evidenceSnippet =
          aiRes.evidenceSnippet ||
          (aiRes.status === 'included'
            ? 'Conforme aux critères PICO'
            : aiRes.status === 'maybe'
              ? 'Information partielle au résumé : à vérifier sur texte intégral.'
              : PRISMA_EXCLUSION_LABELS_FR.other);
      } else {
        throw new Error(
          `Dépouillement IA incomplet sur le lot ${batchStart}-${batchEnd} : la notice PMID ${pmid} est absente de la réponse du modèle.`
        );
      }

      const screened: ScreenedArticle = {
        pmid,
        doi: art.doi || undefined,
        title: art.title || '',
        authors: art.authors || '',
        source: art.source || '',
        pubDate: art.pubDate || '',
        abstract: art.abstract || '',
        meshHeadings: art.meshHeadings ? [...art.meshHeadings] : [],
        publicationTypes: art.publicationTypes ? [...art.publicationTypes] : [],
        status,
        exclusionReason,
        evidenceSnippet,
        url: art.url || `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        evaluatedBy
      };

      screenedSlots[startIdx + k] = screened;
      completedCount++;
      onArticleScreened?.(screened, completedCount, total);
    }
  };

  for (let b = 0; b < batches.length; b += CONCURRENCY) {
    if (isCancelled()) {
      for (let rem = b; rem < batches.length; rem++) {
        await processBatch(batches[rem]);
      }
      break;
    }

    const wave = batches.slice(b, b + CONCURRENCY);
    await Promise.all(wave.map(batchEntry => processBatch(batchEntry)));

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
  return computeScreeningMetrics(screenedArticles);
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
    reasonMap[normalizedReason].push(a.pmid);
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
 * Fusionne de façon immuable le résultat d'un article dépouillé par PMID en préservant
 * toutes les autres décisions existantes (manuelles, Rayyan ou IA précédente).
 */
export function mergeScreenedArticleUpdate(
  articles: readonly ScreenedArticle[],
  updated: ScreenedArticle
): ScreenedArticle[] {
  return articles.map(art => {
    if (art.pmid !== updated.pmid) return art;
    if (art.status !== 'pending' && (art.evaluatedBy === 'manual' || art.evaluatedBy === 'rayyan')) {
      return art;
    }
    return updated;
  });
}
