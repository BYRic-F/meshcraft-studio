/**
 * Agent de Dépouillement Clinique — IA Cloud Multi-Fournisseurs (Gemini, OpenAI, Anthropic)
 *
 * L'analyse sémantique est effectuée par le modèle Cloud haut-débit (Tier 'batch' : Flash / GPT-4o-mini / Haiku)
 * qui lit le titre, le résumé compressé et les descripteurs MeSH réels de chaque notice PubMed.
 */

import {
  aiScreenSingleArticle,
  aiScreenBatchArticles,
  getAiConfig,
  getActiveProviderLabel,
  computeBackoffDelayMs,
  mapErrorToUserMessage
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
 * Crée un rapport de screening initialisé sans aucune règle codée en dur
 */
export function initializeScreeningReport(articles: readonly RawPubMedArticleInput[]): ScreeningReport {
  const unscreened = initializeUnscreenedArticles(articles);
  return {
    totalScreened: 0,
    totalIncluded: 0,
    totalExcluded: 0,
    exclusionBreakdown: [],
    screenedArticles: unscreened
  };
}

/**
 * Compatibilité d'initialisation : ne déclenche AUCUN filtrage déterministe
 */
export function runAgentScreening(articles: readonly RawPubMedArticleInput[], _pico?: unknown): ScreeningReport {
  return initializeScreeningReport(articles);
}

/**
 * Évalue un article unitaire via le modèle Cloud actif (Gemini, OpenAI ou Anthropic)
 */
export async function screenArticleDeep(
  article: any,
  pico: { p: string; i: string; c: string; o: string; not?: string }
): Promise<ScreenedArticle> {
  const config = getAiConfig();
  const evaluatedBy: 'gemini' | 'openai' | 'anthropic' =
    config.provider === 'openai' ? 'openai' : config.provider === 'anthropic' ? 'anthropic' : 'gemini';
  const providerLabel = getActiveProviderLabel(config, 'batch');

  const baseArticle: ScreenedArticle = {
    pmid: String(article.pmid || ''),
    doi: article.doi || undefined,
    title: article.title || '',
    authors: article.authors || '',
    source: article.source || '',
    pubDate: article.pubDate || '',
    abstract: article.abstract || '',
    meshHeadings: article.meshHeadings || [],
    status: 'pending',
    url: article.url || `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`,
    evaluatedBy
  };

  // Principe de précaution Cochrane / Protocole § 3 : une absence de résumé ne vaut jamais exclusion d'office
  if (hasMissingOrEmptyAbstract(baseArticle.abstract)) {
    return {
      ...baseArticle,
      status: 'maybe',
      evidenceSnippet: "Résumé absent dans PubMed : référence retenue par précaution pour vérification sur texte intégral (directive Cochrane / PRISMA 2020).",
      evaluatedBy
    };
  }

  try {
    const aiRes = await aiScreenSingleArticle(article, pico);
    if (aiRes) {
      return {
        ...baseArticle,
        status: aiRes.status,
        exclusionReason: aiRes.exclusionReason,
        evidenceSnippet: aiRes.evidenceSnippet,
        evaluatedBy
      };
    }
  } catch (err: unknown) {
    console.warn(`[AgentScreener] Erreur IA pour PMID ${article.pmid}:`, mapErrorToUserMessage(err));
  }

  // En cas d'indisponibilité temporaire du modèle, classer en 'maybe' (À vérifier) plutôt que de bloquer l'utilisateur
  return {
    ...baseArticle,
    status: 'maybe',
    evidenceSnippet: `À vérifier manuellement (${providerLabel} momentanément indisponible).`,
    evaluatedBy
  };
}

/**
 * Dépouillement clinique intégral par lots avec isolation des pannes (Batch Fault Isolation),
 * Mega-Batching FinOps (35 notices/lot en Pay-As-You-Go) et respect du principe de précaution Cochrane.
 */
export async function runAgentScreeningDeep(
  articles: any[],
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

  const batches: Array<{ startIdx: number; items: any[] }> = [];
  for (let i = 0; i < total; i += BATCH_SIZE) {
    batches.push({ startIdx: i, items: articles.slice(i, i + BATCH_SIZE) });
  }

  const screenedSlots: Array<ScreenedArticle | undefined> = new Array(total);
  let completedCount = 0;

  const markBatchPending = (startIdx: number, batch: ReadonlyArray<Record<string, unknown>>) => {
    for (let k = 0; k < batch.length; k++) {
      const art = batch[k];
      const pmid = String(art.pmid || '');
      screenedSlots[startIdx + k] = {
        pmid,
        doi: typeof art.doi === 'string' ? art.doi : undefined,
        title: String(art.title || ''),
        authors: String(art.authors || ''),
        source: String(art.source || ''),
        pubDate: String(art.pubDate || ''),
        abstract: String(art.abstract || ''),
        meshHeadings: Array.isArray(art.meshHeadings) ? (art.meshHeadings as string[]) : [],
        status: 'pending',
        url: typeof art.url === 'string' ? art.url : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      };
    }
  };

  const processBatch = async (batchEntry: { startIdx: number; items: any[] }) => {
    const { startIdx, items: batch } = batchEntry;
    const batchStart = startIdx + 1;
    const batchEnd = Math.min(startIdx + batch.length, total);

    if (isCancelled()) {
      markBatchPending(startIdx, batch);
      return;
    }

    onProgress?.(completedCount + 1, total, `Analyse du lot (${batchStart} à ${batchEnd} / ${total}) par ${providerLabel}...`);

    // Séparer les articles avec résumé (évaluables par IA) et sans résumé (retenus d'office en 'maybe' selon Cochrane)
    const articlesWithAbstract = batch.filter(a => !hasMissingOrEmptyAbstract(a.abstract));
    let evaluatedBatch: any[] = [];

    if (articlesWithAbstract.length > 0) {
      // queryAiModel applique déjà la cascade multi-modèles et le backoff sur erreurs réseau/HTTP ;
      // on n'effectue qu'un seul nouvel essai rapide si le JSON renvoyé était vide/tronqué.
      let attempt = 0;
      const maxJsonRetries = 1;

      while (attempt <= maxJsonRetries) {
        if (isCancelled()) {
          markBatchPending(startIdx, batch);
          return;
        }

        try {
          evaluatedBatch = await aiScreenBatchArticles(articlesWithAbstract, pico, abortSignal);
          if (evaluatedBatch && evaluatedBatch.length > 0) {
            break;
          }
          attempt++;
          if (attempt <= maxJsonRetries && !isCancelled()) {
            const backoffMs = computeBackoffDelayMs(0, 800, 1500);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        } catch (err: unknown) {
          if (isCancelled() || (err instanceof DOMException && err.name === 'AbortError')) {
            markBatchPending(startIdx, batch);
            return;
          }
          console.warn(`[AgentScreener] Lot ${batchStart}-${batchEnd}:`, mapErrorToUserMessage(err));
          break;
        }
      }
    }

    if (articlesWithAbstract.length > 0 && evaluatedBatch.length === 0 && isCancelled()) {
      markBatchPending(startIdx, batch);
      return;
    }

    const evalMap = new Map<string, any>();
    (evaluatedBatch || []).forEach(e => {
      if (e?.pmid) {
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
      let evidenceSnippet = "À vérifier sur texte intégral.";

      if (missingAbs) {
        status = 'maybe';
        evidenceSnippet = "Résumé absent dans PubMed : retenu par précaution pour vérification sur texte intégral (directive Cochrane / PRISMA 2020).";
      } else if (aiRes) {
        status = aiRes.status;
        exclusionReason = aiRes.exclusionReason || (aiRes.status === 'excluded' ? "Non-conformité aux critères d'éligibilité PICO" : undefined);
        evidenceSnippet = aiRes.evidenceSnippet || (aiRes.status === 'included' ? "Conforme aux critères PICO" : aiRes.status === 'maybe' ? "Information partielle au résumé : à vérifier sur texte intégral." : "Critère d'exclusion identifié");
      } else {
        status = 'maybe';
        evidenceSnippet = "Lot mis en attente (serveur IA surchargé) : conservé en 'À vérifier' par précaution.";
      }

      const screened: ScreenedArticle = {
        pmid,
        doi: art.doi || undefined,
        title: art.title || '',
        authors: art.authors || '',
        source: art.source || '',
        pubDate: art.pubDate || '',
        abstract: art.abstract || '',
        meshHeadings: art.meshHeadings || [],
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
