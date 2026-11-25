import React, { useState, useEffect, useRef } from 'react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  Search,
  Sparkles,
  Download,
  Upload,
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ArrowLeft,
  ArrowRight,
  ShieldCheck,
  Table,
  FileText,
  GitBranch,
  Square,
  RefreshCw,
  Info
} from 'lucide-react';
import {
  ScreenedArticle,
  initializeUnscreenedArticles,
  runAgentScreeningDeep,
  computeScreeningMetrics,
  selectPendingArticlesBatch,
  mergeScreenedArticleUpdate
} from '../services/agentScreener';
import { fetchExtendedPubMedArticles } from '../services/pubmedApi';
import {
  Rob2ArticleEvaluation,
  aiEvaluateBatchRoB2,
  selectUnassessedRobBatch,
  PRISMA_EXCLUSION_CATEGORY_KEYS,
  PRISMA_EXCLUSION_LABELS_FR,
  resolvePrismaExclusionCategory,
  PrismaExclusionCategory,
  computeCochraneOverallRating,
  inferStudyDesignFromText,
  getAiConfig,
  getActiveProviderLabel,
  mapErrorToUserMessage
} from '../services/localAiService';
import {
  exportToRayyanRis,
  exportToRayyanCsv,
  parseRayyanImport,
  applyRayyanDecisions,
  buildReadingMatrixRows,
  exportReadingMatrixCsv,
  exportReadingMatrixMarkdown
} from '../services/rayyanAndMatrixService';
import { generatePrismaReportText } from '../services/prismaReport';
import { useTranslation } from '../i18n';

export interface PrismaFlowchartProps {
  readonly prismaData: {
    readonly identification?: {
      readonly pubmedHits?: number;
      readonly embaseEstimatedHits?: number;
      readonly cochraneEstimatedHits?: number;
      readonly totalIdentified?: number;
      readonly duplicatesRemoved?: number;
    };
    readonly identifiedTotal?: number;
    readonly pubmedCount?: number;
    readonly embaseCount?: number;
    readonly duplicatesRemoved?: number;
  } | null;
  readonly pico: {
    readonly p: string;
    readonly i: string;
    readonly c: string;
    readonly o: string;
    readonly not?: string;
  };
  readonly pubmedQuery: string;
  readonly embaseQuery?: string;
  readonly cochraneQuery?: string;
  readonly realArticles: ReadonlyArray<{
    readonly pmid: string;
    readonly doi?: string | null;
    readonly title: string;
    readonly authors: string;
    readonly source: string;
    readonly pubDate: string;
    readonly abstract: string;
    readonly meshHeadings?: string[];
    readonly publicationTypes?: readonly string[];
    readonly url?: string;
  }>;
  readonly pubmedIdList?: readonly string[];
  readonly screenedArticles?: ScreenedArticle[];
  readonly onScreenedArticlesChange?: React.Dispatch<React.SetStateAction<ScreenedArticle[]>>;
  readonly robEvaluations?: Record<string, Rob2ArticleEvaluation>;
  readonly onRobEvaluationsChange?: React.Dispatch<React.SetStateAction<Record<string, Rob2ArticleEvaluation>>>;
  readonly hydratedForQuery?: string;
  readonly onCorpusLoadedForQuery?: (query: string) => void;
  readonly isActive?: boolean;
  readonly wizardMode?: 'step3' | 'step4';
  readonly onBackToStep2?: () => void;
  readonly onGoToStep4?: () => void;
  readonly onBackToStep3?: () => void;
}

const PAGE_SIZE = 25;

export default function PrismaFlowchart({
  prismaData,
  pico,
  pubmedQuery,
  embaseQuery = '',
  cochraneQuery = '',
  realArticles,
  pubmedIdList,
  screenedArticles: controlledArticles,
  onScreenedArticlesChange,
  robEvaluations: controlledRobEvaluations,
  onRobEvaluationsChange,
  hydratedForQuery = '',
  onCorpusLoadedForQuery,
  isActive = false,
  wizardMode = 'step3',
  onBackToStep2,
  onGoToStep4,
  onBackToStep3
}: PrismaFlowchartProps) {
  const { t } = useTranslation();
  const [localArticles, setLocalArticles] = useState<ScreenedArticle[]>(() =>
    initializeUnscreenedArticles(realArticles || [])
  );
  const articles = controlledArticles ?? localArticles;
  const setArticles: React.Dispatch<React.SetStateAction<ScreenedArticle[]>> =
    onScreenedArticlesChange ?? setLocalArticles;
  const [statusFilter, setStatusFilter] = useState<'all' | 'included' | 'maybe' | 'excluded' | 'pending'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [expandedAbstracts, setExpandedAbstracts] = useState<Record<string, boolean>>({});
  const [includeAiNotesInRayyan, setIncludeAiNotesInRayyan] = useState<boolean>(true);

  // État du chargement PubMed à la demande (Étape 3 uniquement)
  const [isLoadingCorpus, setIsLoadingCorpus] = useState<boolean>(false);
  const [loadProgress, setLoadProgress] = useState<{ current: number; total: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRetryToken, setLoadRetryToken] = useState<number>(0);
  const loadedQueryRef = useRef<string>('');

  // État du pré-dépouillement IA par lots
  const [isScreening, setIsScreening] = useState<boolean>(false);
  const [confirmAllScreening, setConfirmAllScreening] = useState<boolean>(false);
  const [screeningProgress, setScreeningProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const cancelScreeningRef = useRef<boolean>(false);
  const screeningAbortRef = useRef<AbortController | null>(null);
  const rayyanFileInputRef = useRef<HTMLInputElement>(null);
  const [feedbackBanner, setFeedbackBanner] = useState<{ readonly kind: 'success' | 'error' | 'info'; readonly text: string } | null>(null);

  // État Étape 4 : Onglet de synthèse, périmètre, pagination, Risque de biais & Rapport
  const [step4Tab, setStep4Tab] = useState<'flowchart' | 'rob2' | 'matrix' | 'report'>('flowchart');
  const [step4IncludeMaybe, setStep4IncludeMaybe] = useState<boolean>(false);
  const [step4Page, setStep4Page] = useState<number>(1);
  const [localRobEvaluations, setLocalRobEvaluations] = useState<Record<string, Rob2ArticleEvaluation>>({});
  const robEvaluations = controlledRobEvaluations ?? localRobEvaluations;
  const setRobEvaluations: React.Dispatch<React.SetStateAction<Record<string, Rob2ArticleEvaluation>>> =
    onRobEvaluationsChange ?? setLocalRobEvaluations;
  const [isEvaluatingRob, setIsEvaluatingRob] = useState<boolean>(false);
  const [confirmAllRob, setConfirmAllRob] = useState<boolean>(false);
  const [robProgress, setRobProgress] = useState<{ current: number; total: number } | null>(null);
  const cancelRobRef = useRef<boolean>(false);
  const robAbortRef = useRef<AbortController | null>(null);
  const [copiedFlag, setCopiedFlag] = useState<string | null>(null);

  const metrics = computeScreeningMetrics(articles);
  const totalCohort = articles.length;
  const pubmedIdentified = prismaData?.identification?.pubmedHits ?? prismaData?.pubmedCount ?? totalCohort;
  const embaseIdentified = prismaData?.identification?.embaseEstimatedHits ?? prismaData?.embaseCount ?? 0;
  const identifiedTotal = pubmedIdentified + embaseIdentified;
  const duplicatesRemoved = prismaData?.identification?.duplicatesRemoved ?? prismaData?.duplicatesRemoved ?? 0;
  const isPartialPreview = pubmedIdentified > 2500;
  const isCorpusCapped = pubmedIdentified > totalCohort && totalCohort > 0;
  const screenedCount = metrics.totalScreened > 0 ? metrics.totalScreened : totalCohort;
  const fullTextAssessed = metrics.totalIncluded + metrics.totalMaybe;
  const includedFinal = metrics.totalIncluded;

  // Chargement exhaustif à la demande (efetch XML par lots de 100) déclenché uniquement
  // lors de l'activation de l'Étape 3 pour une nouvelle pubmedQuery non encore chargée.
  // Garde-fou critique : si la revue a été restaurée (F5, « Reprendre » ou import .json)
  // avec des articles déjà peuplés pour cette requête, on synchronise loadedQueryRef sans ré-interroger PubMed.
  useEffect(() => {
    const trimmedQuery = (pubmedQuery || '').trim();
    if (!trimmedQuery) return;

    if (
      hydratedForQuery &&
      hydratedForQuery.trim() === trimmedQuery &&
      articles.length > 0 &&
      loadRetryToken === 0
    ) {
      loadedQueryRef.current = trimmedQuery;
      return;
    }

    if (!isActive) return;
    if (loadedQueryRef.current === trimmedQuery && loadRetryToken === 0) return;

    const targetToLoad = pubmedIdentified > 2500
      ? 1000
      : Math.min(2500, pubmedIdentified || (pubmedIdList?.length ?? realArticles.length));

    if (targetToLoad === 0) {
      loadedQueryRef.current = trimmedQuery;
      onCorpusLoadedForQuery?.(trimmedQuery);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const loadFullCorpus = async () => {
      setIsLoadingCorpus(true);
      setLoadError(null);
      setLoadProgress({ current: 0, total: targetToLoad });

      try {
        const loadedArticles = await fetchExtendedPubMedArticles(
          trimmedQuery,
          targetToLoad,
          [],
          (current, total) => {
            if (!cancelled) {
              setLoadProgress({ current, total });
            }
          },
          pubmedIdList,
          controller.signal
        );

        if (!cancelled) {
          loadedQueryRef.current = trimmedQuery;
          setLoadRetryToken(0);
          setArticles(initializeUnscreenedArticles(loadedArticles));
          onCorpusLoadedForQuery?.(trimmedQuery);
          setCurrentPage(1);
          setExpandedAbstracts({});
          setConfirmAllScreening(false);
        }
      } catch (err: unknown) {
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
          setLoadError(mapErrorToUserMessage(err));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCorpus(false);
          setLoadProgress(null);
        }
      }
    };

    void loadFullCorpus();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    isActive,
    pubmedQuery,
    pubmedIdentified,
    pubmedIdList,
    loadRetryToken,
    realArticles.length,
    hydratedForQuery,
    articles.length,
    onCorpusLoadedForQuery,
    setArticles
  ]);

  const aiConfig = getAiConfig();
  const activeEngineLabel = getActiveProviderLabel(aiConfig, 'batch');

  // Actions de décision humaine sur une carte d'article
  const handleManualDecision = (pmid: string, newStatus: 'included' | 'maybe' | 'excluded', customReason?: string) => {
    const defaultReason = t.step3.exclusionReasons[0];
    setArticles(prev =>
      prev.map(art => {
        if (art.pmid !== pmid) return art;
        return {
          ...art,
          status: newStatus,
          exclusionReason: newStatus === 'excluded' ? (customReason || art.exclusionReason || defaultReason) : undefined,
          evidenceSnippet:
            newStatus === 'included'
              ? t.step3.manualNoteIncluded
              : newStatus === 'maybe'
                ? t.step3.manualNoteMaybe
                : `${t.step3.manualNoteExcludedPrefix}${customReason || art.exclusionReason || defaultReason}`,
          evaluatedBy: 'manual'
        };
      })
    );
  };

  // Lancement du pré-dépouillement IA par lots (tranche de 50 en attente ou totalité après confirmation)
  const handleRunBatchScreening = async (limit?: number) => {
    if (isScreening || isLoadingCorpus || articles.length === 0) return;
    const pendingSlice = selectPendingArticlesBatch(articles, limit);
    if (pendingSlice.length === 0) return;

    setConfirmAllScreening(false);
    setIsScreening(true);
    setFeedbackBanner(null);
    cancelScreeningRef.current = false;

    const controller = new AbortController();
    screeningAbortRef.current = controller;

    try {
      await runAgentScreeningDeep(
        pendingSlice,
        pico,
        (current, total, message) => {
          setScreeningProgress({ current, total, message });
        },
        screenedArt => {
          setArticles(prev => mergeScreenedArticleUpdate(prev, screenedArt));
        },
        () => cancelScreeningRef.current,
        controller.signal
      );
    } catch (err: unknown) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setFeedbackBanner({ kind: 'error', text: mapErrorToUserMessage(err) });
      }
    } finally {
      screeningAbortRef.current = null;
      setIsScreening(false);
      setScreeningProgress(null);
    }
  };

  const handleStopScreening = () => {
    cancelScreeningRef.current = true;
    screeningAbortRef.current?.abort();
  };

  // Export Rayyan (.ris ou .csv)
  const handleDownloadRayyan = (format: 'ris' | 'csv') => {
    const content = format === 'ris'
      ? exportToRayyanRis(articles, includeAiNotesInRayyan)
      : exportToRayyanCsv(articles, includeAiNotesInRayyan);
    const mime = format === 'ris' ? 'application/x-research-info-systems;charset=utf-8' : 'text/csv;charset=utf-8';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meshcraft_rayyan_export.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import décisions Rayyan (.ris ou .csv)
  const handleImportRayyanFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const decisions = parseRayyanImport(text);
      if (decisions.size === 0) {
        setFeedbackBanner({ kind: 'error', text: t.step3.rayyanImportEmpty });
      } else {
        setArticles(prev => applyRayyanDecisions(prev, decisions));
        setFeedbackBanner({
          kind: 'success',
          text: t.step3.rayyanImportSuccess.replace('{n}', String(decisions.size))
        });
      }
    } catch (err: unknown) {
      setFeedbackBanner({ kind: 'error', text: mapErrorToUserMessage(err) });
    } finally {
      e.target.value = '';
    }
  };

  // Périmètre unifié Étape 4 (Incluses uniquement par défaut, ou Incluses + À vérifier)
  const includedOnlyCount = metrics.totalIncluded;
  const includedAndMaybeCount = metrics.totalIncluded + metrics.totalMaybe;
  const step4ScopedArticles = articles.filter(a =>
    step4IncludeMaybe ? (a.status === 'included' || a.status === 'maybe') : a.status === 'included'
  );
  const eligibleRobArticles = step4ScopedArticles.filter(
    a => inferStudyDesignFromText(a.title, a.abstract, a.publicationTypes) !== 'other'
  );
  const unassessedRobArticles = selectUnassessedRobBatch(step4ScopedArticles, robEvaluations);
  const assessedEligibleRobCount = eligibleRobArticles.length - unassessedRobArticles.length;
  const nextRobBatchSize = Math.min(20, unassessedRobArticles.length);

  const handleRunBatchRob2 = async (limit?: number) => {
    if (isEvaluatingRob) return;
    const toEvaluate = selectUnassessedRobBatch(step4ScopedArticles, robEvaluations, limit);
    if (toEvaluate.length === 0) return;

    setConfirmAllRob(false);
    setIsEvaluatingRob(true);
    setFeedbackBanner(null);
    cancelRobRef.current = false;

    const controller = new AbortController();
    robAbortRef.current = controller;

    const batchSize = 20;
    let totalEvaluated = 0;
    let wasCancelled = false;

    try {
      setRobProgress({ current: 0, total: toEvaluate.length });
      for (let i = 0; i < toEvaluate.length; i += batchSize) {
        if (cancelRobRef.current || controller.signal.aborted) {
          wasCancelled = true;
          break;
        }
        const batch = toEvaluate.slice(i, i + batchSize);
        const results = await aiEvaluateBatchRoB2(batch, controller.signal);
        if (results && results.size > 0) {
          totalEvaluated += results.size;
          setRobEvaluations(prev => {
            const next = { ...prev };
            for (const r of results.values()) {
              if (!next[r.pmid]) {
                next[r.pmid] = r;
              }
            }
            return next;
          });
        }
        setRobProgress({
          current: Math.min(i + batch.length, toEvaluate.length),
          total: toEvaluate.length
        });
      }

      if (wasCancelled) {
        setFeedbackBanner({
          kind: 'info',
          text: t.step4.robStoppedFeedback.replace('{n}', String(totalEvaluated))
        });
      } else if (totalEvaluated > 0) {
        setFeedbackBanner({
          kind: 'success',
          text: t.step4.robDoneFeedback.replace('{n}', String(totalEvaluated))
        });
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setFeedbackBanner({
          kind: 'info',
          text: t.step4.robStoppedFeedback.replace('{n}', String(totalEvaluated))
        });
      } else {
        setFeedbackBanner({ kind: 'error', text: mapErrorToUserMessage(err) });
      }
    } finally {
      robAbortRef.current = null;
      setIsEvaluatingRob(false);
      setRobProgress(null);
    }
  };

  const handleStopRob = () => {
    cancelRobRef.current = true;
    robAbortRef.current?.abort();
  };

  const handleCycleRobDomain = (art: ScreenedArticle, domainKey: 'd1' | 'd2' | 'd3' | 'd4' | 'd5') => {
    const inferredDesign = inferStudyDesignFromText(art.title, art.abstract, art.publicationTypes);
    if (inferredDesign === 'other') return;

    const existing = robEvaluations[art.pmid] || {
      pmid: art.pmid,
      d1: 'moderate' as const,
      d2: 'moderate' as const,
      d3: 'low' as const,
      d4: 'low' as const,
      d5: 'moderate' as const,
      overall: 'moderate' as const,
      studyDesign: inferredDesign,
      justification: 'Évaluation ajustée manuellement par le lecteur.',
      evaluatedBy: 'Manuel'
    };

    const order: ReadonlyArray<'low' | 'moderate' | 'high'> = ['low', 'moderate', 'high'];
    const currentVal = existing[domainKey];
    const nextVal = order[(order.indexOf(currentVal) + 1) % order.length];
    const updated = {
      ...existing,
      [domainKey]: nextVal,
      evaluatedBy: 'Manuel'
    };
    updated.overall = computeCochraneOverallRating(updated.d1, updated.d2, updated.d3, updated.d4, updated.d5);

    setRobEvaluations(prev => ({
      ...prev,
      [art.pmid]: updated
    }));
  };

  // Filtrage et pagination client (25 notices/page) pour l'étape 3
  const filteredArticles = articles.filter(art => {
    if (statusFilter !== 'all' && art.status !== statusFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        art.title.toLowerCase().includes(q) ||
        art.authors.toLowerCase().includes(q) ||
        art.pmid.includes(q)
      );
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredArticles.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const paginatedArticles = filteredArticles.slice(
    (safeCurrentPage - 1) * PAGE_SIZE,
    safeCurrentPage * PAGE_SIZE
  );
  const allPageAbstractsExpanded =
    paginatedArticles.length > 0 && paginatedArticles.every(a => Boolean(expandedAbstracts[a.pmid]));

  const handleTogglePageAbstracts = () => {
    setExpandedAbstracts(prev => {
      const next = { ...prev };
      const targetState = !allPageAbstractsExpanded;
      for (const art of paginatedArticles) {
        next[art.pmid] = targetState;
      }
      return next;
    });
  };

  const nextBatchSize = Math.min(50, metrics.totalPending);
  const pubmedDirectUrl = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(pubmedQuery)}`;

  // Matrice de synthèse, pagination Étape 4 et Rapport PRISMA
  const readingMatrixRows = buildReadingMatrixRows(articles, robEvaluations, { includeMaybe: step4IncludeMaybe });
  const robTotalPages = Math.max(1, Math.ceil(step4ScopedArticles.length / PAGE_SIZE));
  const safeRobPage = Math.min(step4Page, robTotalPages);
  const paginatedRobArticles = step4ScopedArticles.slice(
    (safeRobPage - 1) * PAGE_SIZE,
    safeRobPage * PAGE_SIZE
  );

  const matrixTotalPages = Math.max(1, Math.ceil(readingMatrixRows.length / PAGE_SIZE));
  const safeMatrixPage = Math.min(step4Page, matrixTotalPages);
  const paginatedMatrixRows = readingMatrixRows.slice(
    (safeMatrixPage - 1) * PAGE_SIZE,
    safeMatrixPage * PAGE_SIZE
  );

  const top5ExclusionReasons = metrics.exclusionBreakdown.slice(0, 5);
  const remainingExclusionReasons = metrics.exclusionBreakdown.slice(5);
  const remainingExclusionRecords = remainingExclusionReasons.reduce((sum, item) => sum + item.count, 0);

  const methodsReportText = generatePrismaReportText(
    pubmedQuery,
    {
      identifiedTotal,
      pubmedCount: pubmedIdentified,
      embaseCount: embaseIdentified,
      duplicatesRemoved,
      screened: screenedCount,
      excludedScreening: metrics.totalExcluded,
      fullTextAssessed,
      pendingFullText: metrics.totalMaybe,
      excludedFullText: 0,
      includedFinal,
      exclusionBreakdown: metrics.exclusionBreakdown
    },
    {
      pico,
      embaseQuery,
      cochraneQuery
    }
  );

  const fullReportText =
    methodsReportText +
    '\n\n## MATRICE DE SYNTHÈSE DES ÉTUDES RETENUES\n\n' +
    exportReadingMatrixMarkdown(readingMatrixRows);

  const handleCopyText = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedFlag(key);
    setTimeout(() => setCopiedFlag(null), 2000);
  };

  // ============================================================================
  // VUE ÉTAPE 3 : SÉLECTION DES ÉTUDES (TRI SUR TITRES/RÉSUMÉS & PONT RAYYAN)
  // ============================================================================
  if (wizardMode === 'step3') {
    const partialBannerText = t.step3.partialPreviewBanner
      .replace('{loaded}', articles.length.toLocaleString('fr-FR'))
      .replace('{total}', pubmedIdentified.toLocaleString('fr-FR'));
    const next50Label = t.step3.runAiNext50Btn.replace('{n}', String(nextBatchSize || 50));
    const allPendingLabel = t.step3.runAiAllPendingBtn.replace('{n}', String(metrics.totalPending));
    const confirmAllLabel = t.step3.confirmAllTitle.replace('{n}', String(metrics.totalPending));
    const risLabel = isPartialPreview
      ? `${t.step3.exportRayyanRisBtn} ${t.step3.partialSuffix}`
      : t.step3.exportRayyanRisBtn;
    const csvLabel = isPartialPreview
      ? `${t.step3.exportRayyanCsvBtn} ${t.step3.partialSuffix}`
      : t.step3.exportRayyanCsvBtn;

    return (
      <section className="space-y-5">
        {/* En-tête Étape 3 */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-5">
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
              {t.step3.badge}
            </span>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              {t.step3.title}
            </h1>
            <p className="text-xs text-slate-500 max-w-2xl">
              {t.step3.subtitle}
            </p>
          </div>

          {/* Barre d'actions scindée en 2 zones : Pré-dépouillement IA à gauche / Rayyan-Zotero à droite */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 pt-1">
            {/* Zone Gauche : Pré-dépouillement IA maîtrisé + avancement X / Y triées */}
            <div className="lg:col-span-7 p-3.5 rounded-xl bg-slate-50/80 border border-slate-200/80 flex flex-col justify-between gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  {t.step3.runAiScreeningBtn}
                </span>
                <span className="text-xs font-mono font-semibold text-slate-700">
                  {metrics.totalScreened} / {articles.length} {t.step3.screenedProgressUnit}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!isScreening ? (
                  <>
                    <button
                      type="button"
                      disabled={isLoadingCorpus || metrics.totalPending === 0}
                      onClick={() => void handleRunBatchScreening(50)}
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold shadow-2xs cursor-pointer transition-colors"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{next50Label}</span>
                    </button>

                    {metrics.totalPending > 50 && (
                      <button
                        type="button"
                        disabled={isLoadingCorpus}
                        onClick={() => setConfirmAllScreening(prev => !prev)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 text-xs font-semibold cursor-pointer transition-colors"
                      >
                        <span>{allPendingLabel}</span>
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleStopScreening}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" />
                    <span>{t.step3.stopScreeningBtn}</span>
                  </button>
                )}
              </div>

              {confirmAllScreening && !isScreening && (
                <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900">
                  <span className="font-medium">{confirmAllLabel}</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleRunBatchScreening()}
                      className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold cursor-pointer"
                    >
                      {t.step3.confirmAllApplyBtn}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmAllScreening(false)}
                      className="px-2.5 py-1 rounded-lg border border-amber-300 bg-white hover:bg-amber-100 text-amber-900 font-semibold cursor-pointer"
                    >
                      {t.step3.confirmAllCancelBtn}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Zone Droite : Interopérabilité Rayyan / Zotero */}
            <div className="lg:col-span-5 p-3.5 rounded-xl bg-slate-50/80 border border-slate-200/80 flex flex-col justify-between gap-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  {t.step3.rayyanGroupTitle}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={isLoadingCorpus || articles.length === 0}
                  onClick={() => handleDownloadRayyan('ris')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-indigo-600" />
                  <span>{risLabel}</span>
                </button>

                <button
                  type="button"
                  disabled={isLoadingCorpus || articles.length === 0}
                  onClick={() => handleDownloadRayyan('csv')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-slate-500" />
                  <span>{csvLabel}</span>
                </button>

                <input
                  ref={rayyanFileInputRef}
                  type="file"
                  accept=".ris,.csv,.txt"
                  onChange={handleImportRayyanFile}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => rayyanFileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-semibold cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-emerald-700" />
                  <span>{t.step3.importRayyanBtn}</span>
                </button>
              </div>

              <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-slate-600 font-medium">
                <input
                  type="checkbox"
                  checked={includeAiNotesInRayyan}
                  onChange={e => setIncludeAiNotesInRayyan(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600"
                />
                <span>{t.step3.includeAiNotesLabel}</span>
              </label>
            </div>
          </div>

          <p className="text-[11px] text-slate-500 pt-1 border-t border-slate-100">
            {t.step3.cochranePrecautionNote}
          </p>

          {/* Barre de chargement PubMed à la demande */}
          {isLoadingCorpus && loadProgress && (
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-800">
                <span className="inline-flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-600" />
                  <span>{t.step3.loadingCorpusLabel}</span>
                </span>
                <span className="font-mono">{loadProgress.current} / {loadProgress.total}</span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className="h-full bg-indigo-600 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.round((loadProgress.current / Math.max(1, loadProgress.total)) * 100))}%` }}
                />
              </div>
            </div>
          )}

          {loadError && !isLoadingCorpus && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-900 flex flex-wrap items-center justify-between gap-2">
              <span>{loadError}</span>
              <button
                type="button"
                onClick={() => setLoadRetryToken(prev => prev + 1)}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{t.step3.retryLoadBtn}</span>
              </button>
            </div>
          )}

          {/* Bandeau d'aperçu partiel lorsque pubmedHits > 2 500 */}
          {isPartialPreview && !isLoadingCorpus && (
            <div className="p-3.5 rounded-xl bg-amber-50/80 border border-amber-200 text-xs text-amber-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2 leading-relaxed">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>{partialBannerText}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <a
                  href={pubmedDirectUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold transition-colors"
                >
                  <span>{t.step3.openOnPubMedBtn}</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => handleCopyText(pubmedQuery, 'partial-query')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-300 bg-white hover:bg-amber-100 text-amber-900 font-semibold cursor-pointer transition-colors"
                >
                  {copiedFlag === 'partial-query' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedFlag === 'partial-query' ? t.step3.copiedLabel : t.step3.copyQueryBtn}</span>
                </button>
              </div>
            </div>
          )}

          {/* Barre de progression en direct pendant le dépouillement IA */}
          {screeningProgress && (
            <div className="p-3.5 rounded-xl bg-indigo-50 border border-indigo-200 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-indigo-900">
                <span>{screeningProgress.message}</span>
                <span className="font-mono">{screeningProgress.current} / {screeningProgress.total}</span>
              </div>
              <div className="w-full h-2 rounded-full bg-indigo-100 overflow-hidden">
                <div
                  className="h-full bg-indigo-600 transition-all duration-300"
                  style={{ width: `${Math.min(100, Math.round((screeningProgress.current / Math.max(1, screeningProgress.total)) * 100))}%` }}
                />
              </div>
            </div>
          )}

          {feedbackBanner && (
            <div
              className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-2 ${
                feedbackBanner.kind === 'error'
                  ? 'bg-rose-50 border-rose-200 text-rose-800'
                  : feedbackBanner.kind === 'success'
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-slate-100 border-slate-200 text-slate-800'
              }`}
            >
              <div className="flex items-center gap-2">
                {feedbackBanner.kind === 'error' ? (
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                ) : feedbackBanner.kind === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                ) : (
                  <Info className="w-4 h-4 text-slate-600 shrink-0" />
                )}
                <span>{feedbackBanner.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setFeedbackBanner(null)}
                className="font-bold opacity-70 hover:opacity-100 cursor-pointer shrink-0"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {/* Barre de filtres sémantiques (pastilles sobres) & Recherche & Déplier/Replier page */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'all', label: `${t.step3.filterAll} (${articles.length})`, dotClass: null },
                { id: 'included', label: `${t.step3.filterIncluded} (${metrics.totalIncluded})`, dotClass: 'bg-emerald-500' },
                { id: 'maybe', label: `${t.step3.filterMaybe} (${metrics.totalMaybe})`, dotClass: 'bg-amber-500' },
                { id: 'excluded', label: `${t.step3.filterExcluded} (${metrics.totalExcluded})`, dotClass: 'bg-rose-500' },
                { id: 'pending', label: `${t.step3.filterPending} (${metrics.totalPending})`, dotClass: 'bg-slate-400' }
              ] as const
            ).map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setStatusFilter(tab.id);
                  setCurrentPage(1);
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                  statusFilter === tab.id
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {tab.dotClass && <span className={`w-2 h-2 rounded-full ${tab.dotClass}`} />}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {paginatedArticles.length > 0 && (
              <button
                type="button"
                onClick={handleTogglePageAbstracts}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer shrink-0"
              >
                {allPageAbstractsExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                <span>
                  {allPageAbstractsExpanded
                    ? t.step3.collapsePageAbstractsBtn
                    : t.step3.expandPageAbstractsBtn}
                </span>
              </button>
            )}

            <div className="relative w-full sm:w-64">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder={t.step3.searchPlaceholder}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-3 py-1.5 text-xs text-slate-800 focus:bg-white focus:border-indigo-600 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Liste paginée des cartes d'articles (25/page) */}
        <div className="space-y-3">
          {paginatedArticles.map(art => {
            const isExpanded = Boolean(expandedAbstracts[art.pmid]);
            const evaluatorBadge =
              art.evaluatedBy === 'rayyan'
                ? t.step3.evaluatorRayyan
                : art.evaluatedBy === 'manual'
                  ? t.step3.evaluatorManual
                  : art.evaluatedBy === 'gemini'
                    ? 'Google Gemini'
                    : art.evaluatedBy === 'openai'
                      ? 'OpenAI GPT'
                      : art.evaluatedBy === 'anthropic'
                        ? 'Anthropic Claude'
                        : activeEngineLabel;

            return (
              <div
                key={art.pmid}
                className={`bg-white rounded-xl border p-4 shadow-2xs transition-all space-y-3 ${
                  art.status === 'included'
                    ? 'border-l-4 border-l-emerald-500 border-slate-200'
                    : art.status === 'maybe'
                      ? 'border-l-4 border-l-amber-500 border-slate-200'
                      : art.status === 'excluded'
                        ? 'border-l-4 border-l-rose-500 border-slate-200 opacity-85'
                        : 'border-slate-200'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="space-y-1 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {art.status === 'included' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <CheckCircle2 className="w-3 h-3" /> {t.step3.statusIncludedBadge}
                        </span>
                      )}
                      {art.status === 'maybe' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200">
                          <HelpCircle className="w-3 h-3" /> {t.step3.statusMaybeBadge}
                        </span>
                      )}
                      {art.status === 'excluded' && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200">
                          <XCircle className="w-3 h-3" /> {t.step3.statusExcludedBadge}
                        </span>
                      )}
                      {art.status !== 'pending' && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-600">
                          {evaluatorBadge}
                        </span>
                      )}
                      <a
                        href={art.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-mono font-semibold text-indigo-600 hover:underline"
                      >
                        <span>PMID: {art.pmid}</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <span className="text-xs text-slate-500">
                        • {art.source} ({art.pubDate})
                      </span>
                    </div>

                    <h3 className="text-sm font-bold text-slate-900 leading-snug">
                      {art.title}
                    </h3>
                    <p className="text-xs text-slate-500">
                      {art.authors}
                    </p>
                  </div>

                  {/* 3 Boutons de décision rapide (Inclure / À vérifier / Exclure) */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleManualDecision(art.pmid, 'included')}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                        art.status === 'included'
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white hover:bg-emerald-50 text-emerald-700 border-slate-200'
                      }`}
                    >
                      {t.step3.btnInclude}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleManualDecision(art.pmid, 'maybe')}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                        art.status === 'maybe'
                          ? 'bg-amber-500 text-white border-amber-500'
                          : 'bg-white hover:bg-amber-50 text-amber-800 border-slate-200'
                      }`}
                    >
                      {t.step3.btnMaybe}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleManualDecision(art.pmid, 'excluded')}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                        art.status === 'excluded'
                          ? 'bg-rose-600 text-white border-rose-600'
                          : 'bg-white hover:bg-rose-50 text-rose-700 border-slate-200'
                      }`}
                    >
                      {t.step3.btnExclude}
                    </button>
                  </div>
                </div>

                {/* Justification clinique ou sélecteur de motif d'exclusion */}
                {art.status !== 'pending' && (
                  <div
                    className={`p-2.5 rounded-lg text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                      art.status === 'included'
                        ? 'bg-emerald-50/70 text-emerald-900'
                        : art.status === 'maybe'
                          ? 'bg-amber-50/70 text-amber-900'
                          : 'bg-rose-50/70 text-rose-900'
                    }`}
                  >
                    <div>
                      <strong>
                        {art.status === 'excluded'
                          ? t.step3.exclusionReasonPrefix
                          : t.step3.clinicalNotePrefix}
                      </strong>
                      <span>
                        {art.status === 'excluded'
                          ? art.evidenceSnippet && art.evidenceSnippet !== art.exclusionReason
                            ? `${art.exclusionReason || PRISMA_EXCLUSION_LABELS_FR.other} — ${art.evidenceSnippet}`
                            : (art.exclusionReason || art.evidenceSnippet)
                          : art.evidenceSnippet}
                      </span>
                    </div>

                    {art.status === 'excluded' && (
                      <select
                        value={resolvePrismaExclusionCategory(undefined, art.exclusionReason)}
                        onChange={e => {
                          const cat = e.target.value as PrismaExclusionCategory;
                          handleManualDecision(art.pmid, 'excluded', PRISMA_EXCLUSION_LABELS_FR[cat]);
                        }}
                        className="rounded border border-rose-200 bg-white px-2 py-1 text-[11px] text-slate-800 shrink-0"
                      >
                        {PRISMA_EXCLUSION_CATEGORY_KEYS.map((catKey, idx) => (
                          <option key={catKey} value={catKey}>
                            {t.step3.exclusionReasons[idx] || PRISMA_EXCLUSION_LABELS_FR[catKey]}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}

                {/* Résumé déroulable en texte pur structuré (whitespace-pre-line) */}
                <div>
                  <button
                    type="button"
                    onClick={() => setExpandedAbstracts(prev => ({ ...prev, [art.pmid]: !prev[art.pmid] }))}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-indigo-600 cursor-pointer"
                  >
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    <span>{isExpanded ? t.step3.hideAbstract : t.step3.showAbstract}</span>
                  </button>

                  {isExpanded && (
                    <div className="mt-2 p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 leading-relaxed whitespace-pre-line">
                      {art.abstract || t.step3.noAbstractFallback}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Pagination client (25 notices/page) */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-4 py-3 text-xs">
            <button
              type="button"
              disabled={safeCurrentPage <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-semibold cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>{t.step3.paginationPrev}</span>
            </button>

            <span className="font-mono font-semibold text-slate-700">
              {t.step3.paginationPageLabel} {safeCurrentPage} {t.step3.paginationOfLabel} {totalPages}
            </span>

            <button
              type="button"
              disabled={safeCurrentPage >= totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-semibold cursor-pointer"
            >
              <span>{t.step3.paginationNext}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Navigation bas de page Étape 3 */}
        <div className="flex items-center justify-between pt-2">
          {onBackToStep2 ? (
            <button
              type="button"
              onClick={onBackToStep2}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>{t.step3.backToStep2}</span>
            </button>
          ) : <div />}

          {onGoToStep4 && (
            <button
              type="button"
              onClick={onGoToStep4}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold shadow-xs cursor-pointer"
            >
              <span>{t.step3.goToStep4}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </section>
    );
  }

  // ============================================================================
  // VUE ÉTAPE 4 : DIAGRAMME PRISMA 2020, BIAIS, MATRICE DE SYNTHÈSE & THÈSE
  // ============================================================================
  const renderRobLevelBadge = (level: 'low' | 'moderate' | 'high' | 'unassessed' | 'na') => {
    if (level === 'low') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold text-[11px]">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          <span>{t.step4.robLevelLow}</span>
        </span>
      );
    }
    if (level === 'moderate') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-900 border border-amber-200 font-semibold text-[11px]">
          <span className="w-2 h-2 rounded-full bg-amber-500" />
          <span>{t.step4.robLevelModerate}</span>
        </span>
      );
    }
    if (level === 'high') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-800 border border-rose-200 font-semibold text-[11px]">
          <span className="w-2 h-2 rounded-full bg-rose-500" />
          <span>{t.step4.robLevelHigh}</span>
        </span>
      );
    }
    if (level === 'na') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-medium text-[11px]">
          <span className="w-2 h-2 rounded-full bg-slate-400" />
          <span>{t.step4.robLevelNa}</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-50 text-slate-500 border border-slate-200 font-medium text-[11px]">
        <span className="w-2 h-2 rounded-full bg-slate-300" />
        <span>{t.step4.robLevelUnassessed}</span>
      </span>
    );
  };

  const renderScopeSelector = () => (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-semibold text-slate-500">{t.step4.scopeLabel}</span>
      <div className="inline-flex rounded-lg bg-slate-100 p-0.5 gap-0.5">
        <button
          type="button"
          onClick={() => {
            setStep4IncludeMaybe(false);
            setStep4Page(1);
            setConfirmAllRob(false);
          }}
          className={`px-3 py-1.5 rounded-md font-semibold transition-colors cursor-pointer ${
            !step4IncludeMaybe
              ? 'bg-white text-slate-900 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          {t.step4.scopeIncludedOnly} ({includedOnlyCount})
        </button>
        <button
          type="button"
          onClick={() => {
            setStep4IncludeMaybe(true);
            setStep4Page(1);
            setConfirmAllRob(false);
          }}
          className={`px-3 py-1.5 rounded-md font-semibold transition-colors cursor-pointer ${
            step4IncludeMaybe
              ? 'bg-white text-slate-900 shadow-2xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          {t.step4.scopeIncludedAndMaybe} ({includedAndMaybeCount})
        </button>
      </div>
    </div>
  );

  const renderEmptyScopeState = () => (
    <div className="p-8 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 text-center space-y-3">
      <p className="text-sm font-semibold text-slate-800">{t.step4.emptyScopeTitle}</p>
      <p className="text-xs text-slate-500 max-w-md mx-auto">{t.step4.emptyScopeDesc}</p>
      {onBackToStep3 && (
        <button
          type="button"
          onClick={onBackToStep3}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>{t.step4.emptyScopeGoStep3Btn}</span>
        </button>
      )}
    </div>
  );

  const renderStep4Pagination = (page: number, totalPgs: number) => {
    if (totalPgs <= 1) return null;
    return (
      <div className="flex items-center justify-between pt-2 text-xs">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => setStep4Page(p => Math.max(1, p - 1))}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-semibold cursor-pointer"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          <span>{t.step3.paginationPrev}</span>
        </button>
        <span className="font-mono font-semibold text-slate-700">
          {t.step3.paginationPageLabel} {page} {t.step3.paginationOfLabel} {totalPgs}
        </span>
        <button
          type="button"
          disabled={page >= totalPgs}
          onClick={() => setStep4Page(p => Math.min(totalPgs, p + 1))}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-semibold cursor-pointer"
        >
          <span>{t.step3.paginationNext}</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  };

  return (
    <section className="space-y-6">
      {/* En-tête Étape 4 */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
        <div className="space-y-4">
          <div className="space-y-1">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
              {t.step4.badge}
            </span>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
              {t.step4.title}
            </h1>
            <p className="text-xs text-slate-500 max-w-2xl">
              {t.step4.subtitle}
            </p>
          </div>

          {/* Barre de sélection des 4 sous-vues de l'Étape 4 sur une seule ligne desktop */}
          <div className="overflow-x-auto">
            <div className="inline-flex flex-nowrap items-center rounded-xl bg-slate-100 p-1 gap-1 min-w-max">
              {(
                [
                  { id: 'flowchart', label: t.step4.tabFlowchart, icon: GitBranch },
                  { id: 'rob2', label: t.step4.tabRob2, icon: ShieldCheck },
                  { id: 'matrix', label: t.step4.tabMatrix, icon: Table },
                  { id: 'report', label: t.step4.tabReport, icon: FileText }
                ] as const
              ).map(tab => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setStep4Tab(tab.id);
                      setStep4Page(1);
                      setConfirmAllRob(false);
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                      step4Tab === tab.id
                        ? 'bg-white text-indigo-700 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {feedbackBanner && (
          <div
            className={`p-3 rounded-xl border flex items-center justify-between gap-2 ${
              feedbackBanner.kind === 'error'
                ? 'bg-rose-50 border-rose-200 text-rose-800'
                : feedbackBanner.kind === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-indigo-50 border-indigo-200 text-indigo-900'
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              {feedbackBanner.kind === 'error' ? (
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              ) : feedbackBanner.kind === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <Info className="w-4 h-4 text-indigo-600 shrink-0" />
              )}
              <span>{feedbackBanner.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setFeedbackBanner(null)}
              className="text-xs opacity-70 hover:opacity-100 font-semibold px-2 cursor-pointer shrink-0"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* SOUS-VUE 1 : DIAGRAMME DE FLUX PRISMA 2020 */}
      {step4Tab === 'flowchart' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-6">
          <div className="max-w-3xl mx-auto space-y-4">
            {/* Phase 1 : Identification */}
            <div className="p-4 rounded-xl bg-indigo-50/50 border border-indigo-200 flex items-center justify-between">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-700">
                  {t.step4.phase1Tag}
                </div>
                <div className="text-sm font-bold text-slate-900">
                  {t.step4.phase1Title}
                </div>
                <div className="text-xs text-slate-500">
                  {t.step4.phase1PubmedLabel} (n = {pubmedIdentified.toLocaleString('fr-FR')}) • {t.step4.phase1OtherLabel} (n = {embaseIdentified.toLocaleString('fr-FR')})
                </div>
              </div>
              <div className="text-xl font-bold font-mono text-indigo-700">
                n = {identifiedTotal.toLocaleString('fr-FR')}
              </div>
            </div>

            <div className="flex justify-center text-slate-300">↓</div>

            {/* Phase 2 : Dépouillement titre / résumé */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-white border border-slate-200 space-y-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  {t.step4.phase2Tag}
                </div>
                <div className="text-sm font-bold text-slate-900">{t.step4.phase2Title}</div>
                <div className="text-lg font-bold font-mono text-slate-900">n = {screenedCount.toLocaleString('fr-FR')}</div>
                {isCorpusCapped && (
                  <div className="text-[11px] text-amber-800">
                    {t.step4.phase2CappedNote
                      .replace('{loaded}', totalCohort.toLocaleString('fr-FR'))
                      .replace('{total}', pubmedIdentified.toLocaleString('fr-FR'))}
                  </div>
                )}
              </div>

              <div className="p-4 rounded-xl bg-rose-50/50 border border-rose-200 space-y-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-rose-700">
                  {t.step4.phase2ExcludedTag}
                </div>
                <div className="text-sm font-bold text-rose-900">{t.step4.phase2ExcludedTitle}</div>
                <div className="text-lg font-bold font-mono text-rose-700">n = {metrics.totalExcluded}</div>
                {top5ExclusionReasons.map(b => (
                  <div key={b.reason} className="text-[11px] text-rose-800 truncate" title={b.reason}>
                    • {b.reason} ({b.count})
                  </div>
                ))}
                {remainingExclusionReasons.length > 0 && (
                  <div className="text-[11px] font-semibold text-rose-900 pt-0.5">
                    {t.step4.phase2OtherReasons
                      .replace('{count}', String(remainingExclusionReasons.length))
                      .replace('{records}', String(remainingExclusionRecords))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-center text-slate-300">↓</div>

            {/* Phase 3 : Éligibilité texte intégral */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-amber-50/50 border border-amber-200 space-y-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-amber-800">
                  {t.step4.phase3Tag}
                </div>
                <div className="text-sm font-bold text-slate-900">{t.step4.phase3Title}</div>
                <div className="text-xs text-slate-500">
                  {t.step4.phase3Breakdown
                    .replace('{included}', String(metrics.totalIncluded))
                    .replace('{maybe}', String(metrics.totalMaybe))}
                </div>
                <div className="text-lg font-bold font-mono text-amber-800">n = {fullTextAssessed}</div>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  {t.step4.phase3PendingTag}
                </div>
                <div className="text-sm font-bold text-slate-800">{t.step4.phase3PendingTitle}</div>
                <div className="text-lg font-bold font-mono text-slate-700">n = {metrics.totalMaybe}</div>
              </div>
            </div>

            <div className="flex justify-center text-slate-300">↓</div>

            {/* Phase 4 : Retenues après tri titre/résumé */}
            <div className="p-5 rounded-xl bg-emerald-50/70 border-2 border-emerald-500 flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-emerald-800">
                  {t.step4.phase4Tag}
                </div>
                <div className="text-base font-bold text-emerald-950">
                  {t.step4.phase4Title}
                </div>
              </div>
              <div className="text-2xl font-bold font-mono text-emerald-700 shrink-0">
                n = {includedFinal}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SOUS-VUE 2 : RISQUE DE BIAIS (PRÉ-REPÉRAGE SUR RÉSUMÉ) */}
      {step4Tab === 'rob2' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-sm font-bold text-slate-900">
                {t.step4.robTitle} ({step4ScopedArticles.length})
              </h2>
              <p className="text-xs text-slate-500 max-w-2xl">
                {t.step4.robSubtitle}
              </p>
            </div>

            <div className="flex flex-col sm:items-end gap-2">
              {renderScopeSelector()}
              {eligibleRobArticles.length > 0 && (
                <span className="text-[11px] font-mono text-slate-500">
                  {t.step4.robAssessedProgress
                    .replace('{assessed}', String(assessedEligibleRobCount))
                    .replace('{eligible}', String(eligibleRobArticles.length))}
                </span>
              )}
            </div>
          </div>

          {/* Bandeau méthodologique discret */}
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 flex items-start gap-2">
            <Info className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
            <span>{t.step4.robDisclaimer}</span>
          </div>

          {step4ScopedArticles.length === 0 ? (
            renderEmptyScopeState()
          ) : (
            <>
              {/* Barre de contrôle du pré-repérage IA borné par lots de 20 */}
              <div className="flex flex-wrap items-center gap-2">
                {!isEvaluatingRob ? (
                  <>
                    <button
                      type="button"
                      disabled={unassessedRobArticles.length === 0}
                      onClick={() => void handleRunBatchRob2(20)}
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer transition-colors"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>
                        {t.step4.robRunNext20Btn.replace('{n}', String(nextRobBatchSize || 20))}
                      </span>
                    </button>

                    {unassessedRobArticles.length > 20 && (
                      <button
                        type="button"
                        onClick={() => setConfirmAllRob(prev => !prev)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer transition-colors"
                      >
                        <span>
                          {t.step4.robRunAllBtn.replace('{n}', String(unassessedRobArticles.length))}
                        </span>
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleStopRob}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" />
                    <span>{t.step4.robStopBtn}</span>
                  </button>
                )}
              </div>

              {confirmAllRob && !isEvaluatingRob && unassessedRobArticles.length > 20 && (
                <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-900">
                  <span className="font-medium">
                    {t.step4.robConfirmAllTitle.replace('{n}', String(unassessedRobArticles.length))}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void handleRunBatchRob2()}
                      className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold cursor-pointer"
                    >
                      {t.step4.robConfirmApplyBtn.replace('{n}', String(unassessedRobArticles.length))}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmAllRob(false)}
                      className="px-3 py-1 rounded-lg border border-amber-300 bg-white hover:bg-amber-100 text-amber-900 font-semibold cursor-pointer"
                    >
                      {t.step4.robConfirmCancelBtn}
                    </button>
                  </div>
                </div>
              )}

              {isEvaluatingRob && robProgress && (
                <div className="p-3 rounded-xl bg-indigo-50 border border-indigo-200 space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-semibold text-indigo-900">
                    <span>
                      {t.step4.robProgressLabel
                        .replace('{current}', String(robProgress.current))
                        .replace('{total}', String(robProgress.total))}
                    </span>
                    <span className="font-mono">{robProgress.current} / {robProgress.total}</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-indigo-100 overflow-hidden">
                    <div
                      className="h-full bg-indigo-600 transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.round((robProgress.current / Math.max(1, robProgress.total)) * 100))}%`
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
                      <th className="p-3">{t.step4.robColStudy}</th>
                      <th className="p-3 text-center">{t.step4.robColD1}</th>
                      <th className="p-3 text-center">{t.step4.robColD2}</th>
                      <th className="p-3 text-center">{t.step4.robColD3}</th>
                      <th className="p-3 text-center">{t.step4.robColD4}</th>
                      <th className="p-3 text-center">{t.step4.robColD5}</th>
                      <th className="p-3 text-center">{t.step4.robColOverall}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {paginatedRobArticles.map(art => {
                      const rob = robEvaluations[art.pmid];
                      const design = rob?.studyDesign || inferStudyDesignFromText(art.title, art.abstract, art.publicationTypes);
                      const isOtherFormat = design === 'other';
                      const designTag =
                        design === 'rct'
                          ? t.step4.designRctTag
                          : design === 'review'
                            ? t.step4.designReviewTag
                            : design === 'observational'
                              ? t.step4.designObsTag
                              : t.step4.designOtherTag;

                      const renderCell = (dKey: 'd1' | 'd2' | 'd3' | 'd4' | 'd5') => {
                        const val = rob?.[dKey];
                        const cls =
                          val === 'low'
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            : val === 'moderate'
                              ? 'bg-amber-50 text-amber-900 border-amber-200'
                              : val === 'high'
                                ? 'bg-rose-50 text-rose-800 border-rose-200'
                                : 'bg-slate-50 text-slate-500 border-slate-200';
                        const dotCls =
                          val === 'low'
                            ? 'bg-emerald-500'
                            : val === 'moderate'
                              ? 'bg-amber-500'
                              : val === 'high'
                                ? 'bg-rose-500'
                                : 'bg-slate-300';
                        const label =
                          val === 'low'
                            ? t.step4.robLevelLow
                            : val === 'moderate'
                              ? t.step4.robLevelModerate
                              : val === 'high'
                                ? t.step4.robLevelHigh
                                : t.step4.robLevelUnassessed;
                        return (
                          <button
                            type="button"
                            onClick={() => handleCycleRobDomain(art, dKey)}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold cursor-pointer ${cls}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
                            <span>{label}</span>
                          </button>
                        );
                      };

                      return (
                        <tr key={art.pmid} className="hover:bg-slate-50/70">
                          <td className="p-3 max-w-xs">
                            <div className="font-bold text-slate-900 line-clamp-2">{art.title}</div>
                            <div className="flex flex-wrap items-center gap-1.5 mt-1">
                              <a
                                href={art.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-0.5 font-mono text-[10px] text-indigo-600 hover:underline"
                              >
                                <span>PMID: {art.pmid}</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-semibold">
                                {designTag}
                              </span>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  art.status === 'included'
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : 'bg-amber-50 text-amber-800'
                                }`}
                              >
                                {art.status === 'included' ? t.step4.statusIncludedShort : t.step4.statusMaybeShort}
                              </span>
                            </div>
                            {rob?.justification && !isOtherFormat && (
                              <div className="mt-1 text-[11px] text-slate-500 italic">{rob.justification}</div>
                            )}
                          </td>

                          {isOtherFormat ? (
                            <td colSpan={5} className="p-3 text-center text-[11px] text-slate-500 italic bg-slate-50/50">
                              {t.step4.robNaNote}
                            </td>
                          ) : (
                            <>
                              <td className="p-3 text-center">{renderCell('d1')}</td>
                              <td className="p-3 text-center">{renderCell('d2')}</td>
                              <td className="p-3 text-center">{renderCell('d3')}</td>
                              <td className="p-3 text-center">{renderCell('d4')}</td>
                              <td className="p-3 text-center">{renderCell('d5')}</td>
                            </>
                          )}

                          <td className="p-3 text-center">
                            {isOtherFormat
                              ? renderRobLevelBadge('na')
                              : renderRobLevelBadge(rob ? rob.overall : 'unassessed')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {renderStep4Pagination(safeRobPage, robTotalPages)}
            </>
          )}
        </div>
      )}

      {/* SOUS-VUE 3 : MATRICE DE SYNTHÈSE DES ÉTUDES */}
      {step4Tab === 'matrix' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                {t.step4.matrixTitle} ({readingMatrixRows.length})
              </h2>
              <p className="text-xs text-slate-500">
                {t.step4.matrixSubtitle}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {renderScopeSelector()}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={readingMatrixRows.length === 0}
                  onClick={() => {
                    const csv = exportReadingMatrixCsv(readingMatrixRows);
                    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'matrice_de_synthese_these.csv';
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{t.step4.exportCsvBtn}</span>
                </button>

                <button
                  type="button"
                  disabled={readingMatrixRows.length === 0}
                  onClick={() => handleCopyText(exportReadingMatrixMarkdown(readingMatrixRows), 'matrix-md')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  {copiedFlag === 'matrix-md' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{t.step4.exportMdBtn}</span>
                </button>
              </div>
            </div>
          </div>

          {readingMatrixRows.length === 0 ? (
            renderEmptyScopeState()
          ) : (
            <>
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
                      <th className="p-3">{t.step4.matrixColStudy}</th>
                      <th className="p-3">{t.step4.matrixColDesignStatus}</th>
                      <th className="p-3">{t.step4.matrixColSummary}</th>
                      <th className="p-3">{t.step4.matrixColRob}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {paginatedMatrixRows.map(row => (
                      <tr key={row.pmid} className="hover:bg-slate-50/80">
                        <td className="p-3 align-top max-w-xs">
                          <div className="font-bold text-slate-900">{row.firstAuthorYear}</div>
                          <div className="text-[11px] text-slate-600 line-clamp-2 mt-0.5">{row.title}</div>
                          <div className="flex flex-wrap items-center gap-2 mt-1">
                            <span className="text-[11px] text-slate-500">{row.journal}</span>
                            <a
                              href={row.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-0.5 font-mono text-[10px] text-indigo-600 hover:underline"
                            >
                              <span>PMID: {row.pmid}</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          </div>
                        </td>
                        <td className="p-3 align-top space-y-1.5">
                          <div>
                            <span className="inline-block px-2 py-0.5 rounded bg-slate-100 text-slate-800 font-medium text-[11px]">
                              {row.studyDesignLabel}
                            </span>
                          </div>
                          <div>
                            <span
                              className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                row.screeningStatus === 'included'
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : 'bg-amber-50 text-amber-800 border border-amber-200'
                              }`}
                            >
                              {row.screeningStatus === 'included'
                                ? t.step4.statusIncludedShort
                                : t.step4.statusMaybeShort}
                            </span>
                          </div>
                        </td>
                        <td className="p-3 align-top text-slate-700 max-w-md leading-relaxed">
                          {row.abstractSummary}
                        </td>
                        <td className="p-3 align-top">
                          {renderRobLevelBadge(row.riskOfBiasOverall)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {renderStep4Pagination(safeMatrixPage, matrixTotalPages)}
            </>
          )}
        </div>
      )}

      {/* SOUS-VUE 4 : CHAPITRE MÉTHODES & RAPPORT THÈSE */}
      {step4Tab === 'report' && (
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900">
              {t.step4.reportTitle}
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleCopyText(fullReportText, 'report')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
              >
                {copiedFlag === 'report' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{t.step4.copyReportBtn}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const blob = new Blob([fullReportText], { type: 'text/markdown;charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'chapitre_methodes_prisma2020.md';
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t.step4.downloadReportBtn}</span>
              </button>
            </div>
          </div>

          <pre className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs font-mono text-slate-800 whitespace-pre-wrap leading-relaxed max-h-[460px] overflow-y-auto">
            {methodsReportText}
          </pre>

          {/* Aperçu lisible de la matrice de synthèse (sans Markdown brut) */}
          <div className="pt-2 border-t border-slate-100 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-bold text-slate-900">
                  {t.step4.reportMatrixSectionTitle} ({readingMatrixRows.length})
                </h3>
                <p className="text-[11px] text-slate-500">
                  {t.step4.reportMatrixExportNote}
                </p>
              </div>
              {readingMatrixRows.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setStep4Tab('matrix');
                    setStep4Page(1);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-[11px] font-semibold text-indigo-700 cursor-pointer"
                >
                  <Table className="w-3 h-3" />
                  <span>{t.step4.reportMatrixOpenTabBtn}</span>
                </button>
              )}
            </div>

            {readingMatrixRows.length === 0 ? (
              <p className="text-xs text-slate-500 italic">
                {t.step4.reportMatrixEmptyNote}
              </p>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-700 font-bold">
                      <th className="p-2.5">{t.step4.matrixColStudy}</th>
                      <th className="p-2.5">{t.step4.matrixColDesignStatus}</th>
                      <th className="p-2.5">{t.step4.matrixColSummary}</th>
                      <th className="p-2.5">{t.step4.matrixColRob}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {readingMatrixRows.slice(0, 5).map(row => (
                      <tr key={row.pmid} className="hover:bg-slate-50/70">
                        <td className="p-2.5 align-top max-w-[200px]">
                          <div className="font-semibold text-slate-900">{row.firstAuthorYear}</div>
                          <div className="text-[11px] text-slate-500 truncate">{row.journal}</div>
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 font-mono text-[10px] text-indigo-600 hover:underline mt-0.5"
                          >
                            <span>PMID: {row.pmid}</span>
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        </td>
                        <td className="p-2.5 align-top">
                          <div className="text-[11px] font-medium text-slate-800">{row.studyDesignLabel}</div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            {row.screeningStatus === 'included'
                              ? t.step4.statusIncludedShort
                              : t.step4.statusMaybeShort}
                          </div>
                        </td>
                        <td className="p-2.5 align-top text-slate-700 max-w-md line-clamp-2">
                          {row.abstractSummary}
                        </td>
                        <td className="p-2.5 align-top">
                          {renderRobLevelBadge(row.riskOfBiasOverall)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {readingMatrixRows.length > 5 && (
                  <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 text-[11px] font-medium text-slate-600">
                    {t.step4.reportMatrixMoreRows.replace('{n}', String(readingMatrixRows.length - 5))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Navigation bas de page Étape 4 */}
      {onBackToStep3 && (
        <div className="flex items-center justify-start pt-2">
          <button
            type="button"
            onClick={onBackToStep3}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{t.step4.backToStep3}</span>
          </button>
        </div>
      )}
    </section>
  );
}
