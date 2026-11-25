import { useState, useEffect, useRef, useCallback } from 'react';
import Header, { WizardStepNumber } from './components/Header';
import PicoForm from './components/PicoForm';
import AgentStepper from './components/AgentStepper';
import EquationOutput from './components/EquationOutput';
import PrismaFlowchart from './components/PrismaFlowchart';
import HistoryDrawer from './components/HistoryDrawer';
import PrerequisitesModal from './components/PrerequisitesModal';
import AiSettingsModal from './components/AiSettingsModal';
import { LanguageProvider, useTranslation } from './i18n';

import {
  runMultiAgentPipeline,
  PicoInputs,
  PipelineSettings,
  MappedBlock,
  CritiqueReport,
  normalizeAuditObservation
} from './services/multiAgentWorkflow';
import { generatePrismaSummaryData } from './services/prismaReport';
import { isHetopConfigured } from './services/hetopService';
import { hasNcbiApiKey } from './services/pubmedApi';
import {
  checkLocalAiStatus,
  LocalModelStatus,
  aiRefinePicoFromAudit,
  AuditRefinementResult,
  getAiConfig,
  resolveActiveModelForTask,
  aiAuditAndCritiqueQuery,
  mapErrorToUserMessage,
  Rob2ArticleEvaluation
} from './services/localAiService';
import type { ScreenedArticle } from './services/agentScreener';
import {
  SavedReviewSnapshot,
  listReviews,
  saveReview,
  deleteReview,
  saveActiveDraft,
  loadActiveDraft,
  clearActiveDraft,
  parseAndValidateReviewJson,
  buildDefaultReviewTitle,
  hasMeaningfulDraftContent,
  computeReviewSummary,
  sanitizeSearchSettings
} from './services/reviewStorageService';
import {
  queryPubMedRust as queryPubMedLive,
  evaluatePressIndexDeterministic,
  finalizePressStatus
} from './services/rustEngineService';

type PipelineResultData = Awaited<ReturnType<typeof runMultiAgentPipeline>>;

const EMPTY_PICO_INPUTS: PicoInputs = {
  p: '',
  i: '',
  c: '',
  o: '',
  not: ''
};

const DEFAULT_SETTINGS: PipelineSettings = {
  strategy: 'balanced',
  qualifiers: [],
  filters: ['humans_cochrane'],
  activePico: { p: true, i: true, c: false, o: true, not: false },
  screeningMode: 'all',
  useTruncation: true,
  dateRange: {
    enabled: false,
    startYear: '',
    endYear: '',
    startDate: undefined,
    endDate: undefined
  }
};

function isPicoInputsCandidate(value: unknown): value is PicoInputs {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if ('nativeEvent' in candidate || 'target' in candidate) return false;
  return typeof candidate.p === 'string' || typeof candidate.i === 'string';
}

function isPipelineSettingsCandidate(value: unknown): value is PipelineSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if ('nativeEvent' in candidate || 'target' in candidate) return false;
  return 'strategy' in candidate || 'activePico' in candidate;
}

function MeSHcraftStudioShell() {
  const { t } = useTranslation();

  const [wizardStep, setWizardStep] = useState<WizardStepNumber>(1);
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState(false);
  const [isUpdatingQuery, setIsUpdatingQuery] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [picoInputs, setPicoInputs] = useState<PicoInputs>(EMPTY_PICO_INPUTS);

  const [settings, setSettings] = useState<PipelineSettings>(DEFAULT_SETTINGS);
  const [reviewResetKey, setReviewResetKey] = useState<number>(0);

  const [currentStep, setCurrentStep] = useState<number>(0);
  const [stepLogs, setStepLogs] = useState<Record<number, { status: string; message: string }>>({});
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isRefiningAudit, setIsRefiningAudit] = useState<boolean>(false);
  const [refinementCount, setRefinementCount] = useState<number>(0);
  const [resultData, setResultData] = useState<PipelineResultData | null>(null);
  const [screenedArticles, setScreenedArticles] = useState<ScreenedArticle[]>([]);
  const [robEvaluations, setRobEvaluations] = useState<Record<string, Rob2ArticleEvaluation>>({});
  const [hydratedQuery, setHydratedQuery] = useState<string>('');

  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [activeReviewTitle, setActiveReviewTitle] = useState<string>('');
  const [savedReviews, setSavedReviews] = useState<SavedReviewSnapshot[]>([]);
  const [justSavedStep2, setJustSavedStep2] = useState<boolean>(false);
  const isDraftHydratedRef = useRef<boolean>(false);

  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [isPrerequisitesOpen, setIsPrerequisitesOpen] = useState<boolean>(false);
  const [isHetopConnected, setIsHetopConnected] = useState<boolean>(() => isHetopConfigured());
  const [aiStatus, setAiStatus] = useState<LocalModelStatus | null>(null);

  const handleGenerate = async (customInputs?: unknown, customSettings?: unknown) => {
    const inputsToUse: PicoInputs = isPicoInputsCandidate(customInputs) ? customInputs : picoInputs;
    const settingsToUse: PipelineSettings = isPipelineSettingsCandidate(customSettings) ? customSettings : settings;

    setIsGenerating(true);
    setErrorBanner(null);
    if (!settingsToUse.previousAudit) {
      setRefinementCount(0);
    }
    setCurrentStep(1);
    setStepLogs({});

    try {
      const result = await runMultiAgentPipeline(
        inputsToUse,
        settingsToUse,
        (stepId: number, status: string, message: string) => {
          setCurrentStep(stepId);
          setStepLogs(prev => ({
            ...prev,
            [stepId]: { status, message }
          }));
        }
      );
      setResultData(result);
      setScreenedArticles([]);
      setRobEvaluations({});
      setHydratedQuery('');
      setCurrentStep(6);
      setWizardStep(2);
      if (result.critiqueReport?.auditError) {
        setErrorBanner(result.critiqueReport.auditError);
      }
    } catch (err: unknown) {
      setErrorBanner(mapErrorToUserMessage(err));
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePreviewAuditRefinement = async (): Promise<AuditRefinementResult | null> => {
    if (!resultData?.critiqueReport || isRefiningAudit || isGenerating) return null;
    const currentReport = resultData.critiqueReport;
    setIsRefiningAudit(true);
    setErrorBanner(null);
    try {
      const refined = await aiRefinePicoFromAudit(
        picoInputs,
        settings.activePico || { p: true, i: true, c: false, o: true, not: false },
        currentReport,
        settings.qualifications
      );
      return refined;
    } catch (err: unknown) {
      setErrorBanner(mapErrorToUserMessage(err));
      return null;
    } finally {
      setIsRefiningAudit(false);
    }
  };

  const handleCommitAuditRefinement = async (preview: AuditRefinementResult): Promise<boolean> => {
    if (isGenerating || isRefiningAudit) return false;
    setErrorBanner(null);
    const mergedQualifications = {
      ...(settings.qualifications || {}),
      ...(preview.qualifications || {})
    };
    const nextActive = preview.activePico
      ? {
        p: preview.activePico.p ?? settings.activePico?.p ?? true,
        i: preview.activePico.i ?? settings.activePico?.i ?? true,
        c: preview.activePico.c ?? settings.activePico?.c ?? false,
        o: preview.activePico.o ?? settings.activePico?.o ?? true,
        not: preview.activePico.not ?? settings.activePico?.not ?? false
      }
      : settings.activePico;

    const previousWarnings = (resultData?.critiqueReport?.observations || [])
      .map((obs) => normalizeAuditObservation(obs))
      .filter((item): item is NonNullable<typeof item> => Boolean(item && item.severity === 'warning'))
      .map((item) => item.text);

    const diffParts: string[] = [];
    for (const axisKey of ['p', 'i', 'c', 'o', 'not'] as const) {
      const beforeVal = (picoInputs[axisKey] || '').trim();
      const afterVal = (preview.refinedPico[axisKey] || '').trim();
      if (beforeVal !== afterVal) {
        diffParts.push(`${axisKey.toUpperCase()}: "${beforeVal}" -> "${afterVal}"`);
      }
    }

    const nextCount = refinementCount + 1;
    setRefinementCount(nextCount);

    const newSettings: PipelineSettings = {
      ...settings,
      qualifications:
        Object.keys(mergedQualifications).length > 0 ? mergedQualifications : settings.qualifications,
      activePico: nextActive,
      strategy: preview.strategy || settings.strategy,
      previousAudit: {
        iteration: nextCount + 1,
        previousWarnings,
        changesSummary: diffParts.length > 0 ? diffParts.join(' ; ') : 'Ajustement des paramètres/axes actifs'
      }
    };

    setPicoInputs(preview.refinedPico);
    setSettings(newSettings);
    await handleGenerate(preview.refinedPico, newSettings);
    return true;
  };

  const handleUpdatePubMedQuery = async (
    newQuery: string,
    syncPayload?: {
      readonly mappedBlocks?: MappedBlock[];
      readonly embaseQuery?: string;
      readonly cochraneQuery?: string;
    }
  ) => {
    if (!resultData || isGenerating || isUpdatingQuery) return;
    setIsUpdatingQuery(true);
    setErrorBanner(null);
    const effectiveBlocks = syncPayload?.mappedBlocks ?? resultData.mappedBlocks;
    const effectiveEmbase = syncPayload?.embaseQuery ?? resultData.embaseQuery;
    const effectiveCochrane = syncPayload?.cochraneQuery ?? resultData.cochraneQuery;

    try {
      const live = await queryPubMedLive(newQuery, { maxResults: 2500, sort: 'relevance' });
      const activeBlocks = settings.activePico || { p: true, i: true, c: false, o: true, not: false };
      const totalSynonyms = (effectiveBlocks || []).reduce(
        (acc, b) => acc + (b.entryTerms?.length || 0),
        0
      );
      const coreCount = (effectiveBlocks || []).filter((b) => b.picoType !== 'NOT').length;

      const activeUserAxes = [
        ...(activeBlocks.p && picoInputs.p?.trim() ? [{ picoType: 'P' as const, text: picoInputs.p }] : []),
        ...(activeBlocks.i && picoInputs.i?.trim() ? [{ picoType: 'I' as const, text: picoInputs.i }] : []),
        ...(activeBlocks.c && picoInputs.c?.trim() ? [{ picoType: 'C' as const, text: picoInputs.c }] : []),
        ...(activeBlocks.o && picoInputs.o?.trim() ? [{ picoType: 'O' as const, text: picoInputs.o }] : []),
        ...(activeBlocks.not && picoInputs.not?.trim() ? [{ picoType: 'NOT' as const, text: picoInputs.not }] : [])
      ];

      const pressReport = evaluatePressIndexDeterministic({
        pubmedQuery: newQuery,
        embaseQuery: effectiveEmbase,
        cochraneQuery: effectiveCochrane,
        blocks: effectiveBlocks || [],
        activeCoreAxesCount: coreCount,
        articleCount: live.count,
        totalSynonyms,
        hasActiveComparator: Boolean(activeBlocks.c && picoInputs.c?.trim()),
        hasActiveNot: Boolean(activeBlocks.not && picoInputs.not?.trim()),
        hasStrictHumansFilter: Boolean(settings.filters?.includes('humans')),
        activeUserAxes
      });

      let updatedCritique: CritiqueReport = pressReport;
      const aiConfig = getAiConfig();
      try {
        const sampleTitles = (live.articles || []).map(a => a.title).filter(Boolean);
        const descriptorsList = (effectiveBlocks || [])
          .map((b: MappedBlock) => b.descriptor)
          .filter(Boolean);
        const effectiveAuditPico: PicoInputs = {
          p: activeBlocks.p ? picoInputs.p : '',
          i: activeBlocks.i ? picoInputs.i : '',
          c: activeBlocks.c ? picoInputs.c : '',
          o: activeBlocks.o ? picoInputs.o : '',
          not: activeBlocks.not ? (picoInputs.not || '') : ''
        };
        const critique = await aiAuditAndCritiqueQuery(
          effectiveAuditPico,
          newQuery,
          descriptorsList,
          live.count,
          sampleTitles,
          undefined,
          live.stratifiedSample
        );
        if (critique) {
          const finalized = finalizePressStatus(
            pressReport,
            critique.observations,
            live.count,
            false
          );
          updatedCritique = {
            score: pressReport.score,
            pressBreakdown: pressReport.pressBreakdown,
            pressStatus: finalized.pressStatus,
            pressAlertCount: finalized.pressAlertCount,
            observations: critique.observations,
            recommendations: critique.recommendations,
            source: aiConfig.provider,
            evaluatorModel: resolveActiveModelForTask(aiConfig, 'reasoning')
          };
        }
      } catch (auditErrRaw: unknown) {
        const auditErr = mapErrorToUserMessage(auditErrRaw);
        const degradedObservations = [
          ...pressReport.observations,
          { severity: 'warning' as const, text: `Audit qualitatif IA indisponible : ${auditErr}` }
        ];
        const finalized = finalizePressStatus(
          pressReport,
          degradedObservations,
          live.count,
          false
        );
        updatedCritique = {
          ...pressReport,
          observations: degradedObservations,
          recommendations: [
            ...pressReport.recommendations,
            `Vérifiez votre configuration IA dans les Paramètres : ${auditErr}`
          ],
          pressStatus: finalized.pressStatus,
          pressAlertCount: finalized.pressAlertCount,
          evaluatorModel: 'Contrôles PRESS (Audit IA indisponible)',
          auditError: auditErr
        };
        setErrorBanner(auditErr);
      }

      const queryChanged = (resultData.pubmedQuery || '').trim() !== newQuery.trim();
      setResultData({
        ...resultData,
        mappedBlocks: effectiveBlocks,
        pubmedQuery: newQuery,
        embaseQuery: effectiveEmbase,
        cochraneQuery: effectiveCochrane,
        liveResult: live,
        critiqueReport: updatedCritique
      });
      if (queryChanged) {
        setScreenedArticles([]);
        setRobEvaluations({});
        setHydratedQuery('');
      }
    } catch (err: unknown) {
      setErrorBanner(mapErrorToUserMessage(err));
    } finally {
      setIsUpdatingQuery(false);
    }
  };

  useEffect(() => {
    checkLocalAiStatus().then(st => {
      setAiStatus(st);
      if (!st?.online) {
        setIsPrerequisitesOpen(true);
      }
    }).catch(() => {
      setIsPrerequisitesOpen(true);
    });
  }, []);

  const buildSnapshotPayload = useCallback(
    (id: string, titleOverride?: string, existingCreatedAt?: number): SavedReviewSnapshot => {
      const now = Date.now();
      const title =
        (titleOverride || activeReviewTitle || '').trim() || buildDefaultReviewTitle(picoInputs);
      return {
        schemaVersion: 1,
        id,
        title,
        createdAt: existingCreatedAt ?? now,
        updatedAt: now,
        wizardStep,
        summary: computeReviewSummary(resultData, screenedArticles, robEvaluations),
        picoInputs: { ...picoInputs },
        searchSettings: sanitizeSearchSettings(settings),
        resultData,
        refinementCount,
        screenedArticles,
        robEvaluations
      };
    },
    [
      activeReviewTitle,
      picoInputs,
      wizardStep,
      resultData,
      screenedArticles,
      robEvaluations,
      settings,
      refinementCount
    ]
  );

  const applyRestoredSnapshot = useCallback((snapshot: SavedReviewSnapshot, isNamedReview: boolean) => {
    setPicoInputs({ ...snapshot.picoInputs });
    setSettings(sanitizeSearchSettings(snapshot.searchSettings));
    setResultData(snapshot.resultData);
    setRefinementCount(snapshot.refinementCount || 0);
    setScreenedArticles([...snapshot.screenedArticles]);
    setRobEvaluations({ ...snapshot.robEvaluations });
    const restoredQuery = (snapshot.resultData?.pubmedQuery || '').trim();
    setHydratedQuery(snapshot.screenedArticles.length > 0 && restoredQuery ? restoredQuery : '');
    setWizardStep(snapshot.resultData ? snapshot.wizardStep : 1);
    setErrorBanner(null);
    if (isNamedReview) {
      setActiveReviewId(snapshot.id);
      setActiveReviewTitle(snapshot.title);
    } else {
      setActiveReviewId(null);
      setActiveReviewTitle(snapshot.title || '');
    }
  }, []);

  // Chargement initial : revues sauvegardées + restauration automatique du brouillon anti-F5
  useEffect(() => {
    let active = true;
    const hydrateStorage = async () => {
      try {
        const [reviews, draft] = await Promise.all([listReviews(), loadActiveDraft()]);
        if (!active) return;
        setSavedReviews(reviews);
        if (draft) {
          applyRestoredSnapshot(draft, false);
        }
      } finally {
        if (active) {
          isDraftHydratedRef.current = true;
        }
      }
    };
    void hydrateStorage();
    return () => {
      active = false;
    };
  }, [applyRestoredSnapshot]);

  // Auto-sauvegarde anti-F5 (debounce 1 000 ms) dès qu'un PICO ou un résultat existe
  useEffect(() => {
    if (!isDraftHydratedRef.current) return;
    if (!hasMeaningfulDraftContent(picoInputs, resultData)) return;

    const timer = setTimeout(() => {
      const payload = buildSnapshotPayload('__draft_tmp__');
      const { id: _unused, ...draftWithoutId } = payload;
      void _unused;
      void saveActiveDraft(draftWithoutId);
    }, 1000);

    return () => clearTimeout(timer);
  }, [
    picoInputs,
    settings,
    resultData,
    refinementCount,
    screenedArticles,
    robEvaluations,
    wizardStep,
    buildSnapshotPayload
  ]);

  const handleSaveCurrentReview = async (customTitle?: string): Promise<void> => {
    const existing = activeReviewId ? savedReviews.find(r => r.id === activeReviewId) : undefined;
    const reviewId = existing?.id || `rev-${Date.now()}`;
    const snapshot = buildSnapshotPayload(reviewId, customTitle, existing?.createdAt);
    const saved = await saveReview(snapshot);
    setActiveReviewId(saved.id);
    setActiveReviewTitle(saved.title);
    const updatedList = await listReviews();
    setSavedReviews(updatedList);
    setJustSavedStep2(true);
    setTimeout(() => setJustSavedStep2(false), 2500);
  };

  const handleDeleteReview = async (id: string): Promise<void> => {
    await deleteReview(id);
    if (activeReviewId === id) {
      setActiveReviewId(null);
      setActiveReviewTitle('');
    }
    const updatedList = await listReviews();
    setSavedReviews(updatedList);
  };

  const handleImportReviewJson = async (rawJson: string): Promise<{ ok: boolean; error?: string }> => {
    const parsed = parseAndValidateReviewJson(rawJson);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    const saved = await saveReview(parsed.snapshot);
    const updatedList = await listReviews();
    setSavedReviews(updatedList);
    applyRestoredSnapshot(saved, true);
    return { ok: true };
  };

  const handleStartNewReview = async (): Promise<void> => {
    await clearActiveDraft();
    setPicoInputs(EMPTY_PICO_INPUTS);
    setSettings(DEFAULT_SETTINGS);
    setReviewResetKey(prev => prev + 1);
    setResultData(null);
    setScreenedArticles([]);
    setRobEvaluations({});
    setHydratedQuery('');
    setRefinementCount(0);
    setActiveReviewId(null);
    setActiveReviewTitle('');
    setCurrentStep(0);
    setStepLogs({});
    setErrorBanner(null);
    setWizardStep(1);
  };

  const canSaveCurrent = hasMeaningfulDraftContent(picoInputs, resultData);
  const isCurrentSaved = Boolean(justSavedStep2 || (activeReviewId && savedReviews.some(r => r.id === activeReviewId)));
  const prismaData = resultData
    ? generatePrismaSummaryData(resultData.liveResult, resultData.mappedBlocks, picoInputs, screenedArticles)
    : null;

  return (
    <div className="min-h-screen flex flex-col font-sans bg-slate-50 text-slate-900">
      <Header
        onOpenHistory={() => setIsHistoryOpen(true)}
        onOpenPrerequisites={() => setIsPrerequisitesOpen(true)}
        onOpenAiSettings={() => setIsAiSettingsOpen(true)}
        isHetopConnected={isHetopConnected}
        hasNcbiKey={hasNcbiApiKey()}
        isAiOnline={aiStatus?.online ?? false}
        aiProvider={getAiConfig().provider}
        historyCount={savedReviews.length}
        isGenerating={isGenerating}
        wizardStep={wizardStep}
        onSelectWizardStep={setWizardStep}
        hasResults={Boolean(resultData)}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-7 space-y-6">
        {/* Bandeau d'erreur convivial et non bloquant */}
        {errorBanner && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-amber-900">{errorBanner}</p>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="text-xs font-semibold text-amber-800 hover:text-amber-950 px-2.5 py-1 rounded-md border border-amber-300 bg-white"
            >
              ✕
            </button>
          </div>
        )}

        {/* ÉTAPE 1 : Question Clinique & Structuration PICO/PECO */}
        {wizardStep === 1 && (
          <div className="space-y-5">
            <PicoForm
              key={reviewResetKey}
              picoInputs={picoInputs}
              setPicoInputs={setPicoInputs}
              settings={settings}
              setSettings={setSettings}
              onGenerate={() => void handleGenerate()}
              isGenerating={isGenerating}
              onOpenAiSettings={() => setIsAiSettingsOpen(true)}
            />
            {(isGenerating || currentStep > 0) && (
              <AgentStepper
                currentStep={currentStep}
                stepLogs={stepLogs}
              />
            )}
          </div>
        )}

        {/* ÉTAPE 2 : Validation Terminologique MeSH & Équations Multi-Bases */}
        {wizardStep === 2 && resultData && (
          <div className="space-y-5">
            {(isGenerating || isRefiningAudit) && (
              <AgentStepper
                currentStep={currentStep}
                stepLogs={stepLogs}
              />
            )}
            <EquationOutput
              resultData={resultData}
              picoInputs={picoInputs}
              settings={settings}
              onSaveHistory={() => { void handleSaveCurrentReview(); }}
              isSaved={isCurrentSaved}
              onPreviewAuditRefinement={() => handlePreviewAuditRefinement()}
              onCommitAuditRefinement={(preview) => handleCommitAuditRefinement(preview)}
              isRefiningAudit={isRefiningAudit}
              refinementCount={refinementCount}
              onUpdatePubMedQuery={(q, syncPayload) => handleUpdatePubMedQuery(q, syncPayload)}
              isUpdatingQuery={isUpdatingQuery}
              onBackToStep1={() => setWizardStep(1)}
              onGoToStep3={() => setWizardStep(3)}
            />
          </div>
        )}

        {/* ÉTAPES 3 & 4 : Screening Assisté, Pont Rayyan, Matrice de Lecture, RoB 2 & PRISMA 2020 */}
        {/* Maintenu monté dès que resultData existe pour préserver l'état de screening entre les étapes */}
        {resultData && prismaData && (
          <div className={wizardStep === 3 || wizardStep === 4 ? 'block' : 'hidden'}>
            <PrismaFlowchart
              prismaData={prismaData}
              pico={picoInputs}
              pubmedQuery={resultData.pubmedQuery || ''}
              embaseQuery={resultData.embaseQuery || ''}
              cochraneQuery={resultData.cochraneQuery || ''}
              realArticles={resultData.liveResult?.articles || []}
              pubmedIdList={resultData.liveResult?.idList}
              screenedArticles={screenedArticles}
              onScreenedArticlesChange={setScreenedArticles}
              robEvaluations={robEvaluations}
              onRobEvaluationsChange={setRobEvaluations}
              hydratedForQuery={hydratedQuery}
              onCorpusLoadedForQuery={setHydratedQuery}
              isActive={wizardStep === 3}
              wizardMode={wizardStep === 3 ? 'step3' : 'step4'}
              onBackToStep2={() => setWizardStep(2)}
              onGoToStep4={() => setWizardStep(4)}
              onBackToStep3={() => setWizardStep(3)}
            />
          </div>
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white py-5 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <p className="font-medium text-slate-600">
            {t.appTitle} — {t.footerLeft}
          </p>
          <p className="text-slate-400 text-[11px]">
            {t.footerRight}
          </p>
        </div>
      </footer>

      <HistoryDrawer
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        reviews={savedReviews}
        activeReviewId={activeReviewId}
        defaultTitle={activeReviewTitle || buildDefaultReviewTitle(picoInputs)}
        canSaveCurrent={canSaveCurrent}
        hasActiveSession={Boolean(resultData || screenedArticles.length > 0)}
        onSaveCurrent={handleSaveCurrentReview}
        onResumeReview={(snapshot) => applyRestoredSnapshot(snapshot, true)}
        onDeleteReview={handleDeleteReview}
        onImportReviewJson={handleImportReviewJson}
        onNewReview={handleStartNewReview}
      />

      <PrerequisitesModal
        isOpen={isPrerequisitesOpen}
        onSuccess={() => {
          setIsPrerequisitesOpen(false);
          setIsHetopConnected(isHetopConfigured());
          checkLocalAiStatus().then(st => setAiStatus(st)).catch(() => { });
        }}
      />

      <AiSettingsModal
        isOpen={isAiSettingsOpen}
        onClose={() => {
          setIsAiSettingsOpen(false);
          setIsHetopConnected(isHetopConfigured());
          checkLocalAiStatus().then(st => setAiStatus(st)).catch(() => { });
        }}
        onStatusChange={(st) => setAiStatus(st)}
      />
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <MeSHcraftStudioShell />
    </LanguageProvider>
  );
}
