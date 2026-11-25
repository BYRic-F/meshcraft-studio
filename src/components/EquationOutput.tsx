import { useState } from 'react';
import {
  Copy,
  Check,
  Bookmark,
  Sparkles,
  RefreshCw,
  Plus,
  X,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Info,
  XCircle,
  Target,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import {
  buildQuerySyntax,
  MappedBlock,
  PicoInputs,
  PipelineSettings,
  AuditObservationEntry,
  normalizeAuditObservation,
  PressCriterionScore,
  PressStatusLevel
} from '../services/multiAgentWorkflow';
import { AuditRefinementResult, isPassiveComparatorConcept } from '../services/localAiService';
import { shouldDisplayStrategyConverged } from '../services/rustEngineService';
import { parseBenchmarkPmids, evaluateBenchmarkCoverage, BenchmarkCoverageResult } from '../services/rayyanAndMatrixService';
import { useTranslation } from '../i18n';

export interface QuerySyncPayload {
  readonly mappedBlocks?: MappedBlock[];
  readonly embaseQuery?: string;
  readonly cochraneQuery?: string;
}

export interface EquationOutputProps {
  readonly resultData: {
    readonly pubmedQuery: string;
    readonly embaseQuery: string;
    readonly cochraneQuery: string;
    readonly mappedBlocks: MappedBlock[];
    readonly droppedComparatorReason?: 'passive_comparator' | 'unresolved_mesh';
    readonly liveResult?: {
      readonly count: number;
      readonly idList?: readonly string[];
      readonly articles: ReadonlyArray<{ readonly pmid: string; readonly title: string }>;
    };
    readonly critiqueReport?: {
      readonly score: number;
      readonly pressStatus?: PressStatusLevel;
      readonly pressAlertCount?: number;
      readonly observations: readonly AuditObservationEntry[];
      readonly recommendations: readonly string[];
      readonly pressBreakdown?: readonly PressCriterionScore[];
      readonly evaluatorModel?: string;
    };
  };
  readonly picoInputs?: PicoInputs;
  readonly settings?: PipelineSettings;
  readonly onSaveHistory: (query: string) => void;
  readonly isSaved: boolean;
  readonly onPreviewAuditRefinement?: () => Promise<AuditRefinementResult | null>;
  readonly onCommitAuditRefinement?: (preview: AuditRefinementResult) => Promise<boolean | void>;
  readonly isRefiningAudit?: boolean;
  readonly refinementCount?: number;
  readonly onUpdatePubMedQuery?: (newQuery: string, syncPayload?: QuerySyncPayload) => Promise<void>;
  readonly isUpdatingQuery?: boolean;
  readonly onBackToStep1?: () => void;
  readonly onGoToStep3?: () => void;
}

export default function EquationOutput({
  resultData,
  picoInputs,
  settings,
  onSaveHistory,
  isSaved,
  onPreviewAuditRefinement,
  onCommitAuditRefinement,
  isRefiningAudit,
  refinementCount = 0,
  onUpdatePubMedQuery,
  isUpdatingQuery,
  onBackToStep1,
  onGoToStep3
}: EquationOutputProps) {
  const { t } = useTranslation();
  const [activeDbTab, setActiveDbTab] = useState<'pubmed' | 'embase' | 'cochrane'>('pubmed');
  const [syncedResultData, setSyncedResultData] = useState(resultData);
  const [editableBlocks, setEditableBlocks] = useState<MappedBlock[]>(resultData?.mappedBlocks || []);
  const [customPubMedQuery, setCustomPubMedQuery] = useState<string>(resultData?.pubmedQuery || '');
  const [customEmbaseQuery, setCustomEmbaseQuery] = useState<string>(resultData?.embaseQuery || '');
  const [customCochraneQuery, setCustomCochraneQuery] = useState<string>(resultData?.cochraneQuery || '');

  const [newTermInputs, setNewTermInputs] = useState<Record<number, string>>({});
  const [copiedTab, setCopiedTab] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<{
    readonly kind: 'success' | 'info';
    readonly text: string;
  } | null>(null);
  const [pendingRefinement, setPendingRefinement] = useState<AuditRefinementResult | null>(null);

  // Contrôle des PMID repères (accordéon replié par défaut en bas de page)
  const [showBenchmark, setShowBenchmark] = useState<boolean>(false);
  const [benchmarkInput, setBenchmarkInput] = useState<string>('');
  const [benchmarkResult, setBenchmarkResult] = useState<BenchmarkCoverageResult | null>(null);
  const [expandedSynonymsByBlock, setExpandedSynonymsByBlock] = useState<Record<number, boolean>>({});

  if (resultData !== syncedResultData) {
    setSyncedResultData(resultData);
    setEditableBlocks(resultData?.mappedBlocks || []);
    setCustomPubMedQuery(resultData?.pubmedQuery || '');
    setCustomEmbaseQuery(resultData?.embaseQuery || '');
    setCustomCochraneQuery(resultData?.cochraneQuery || '');
    setPendingRefinement(null);
    setExpandedSynonymsByBlock({});
  }

  const isPubMedQueryModified =
    customPubMedQuery.trim() !== (resultData?.pubmedQuery || '').trim();

  const currentQueryText = activeDbTab === 'pubmed'
    ? customPubMedQuery
    : activeDbTab === 'embase'
      ? customEmbaseQuery
      : customCochraneQuery;

  const handleCopy = (text: string, tabName: string) => {
    navigator.clipboard.writeText(text);
    setCopiedTab(tabName);
    setTimeout(() => setCopiedTab(null), 2000);
  };

  const toggleDescriptorOption = (blockIdx: number, descIdx: number, field: 'noExp' | 'isMajor') => {
    setEditableBlocks(prev =>
      prev.map((b, idx) => {
        if (idx !== blockIdx) return b;
        const updatedDescs = (b.descriptors || []).map((d, dIdx) =>
          dIdx === descIdx ? { ...d, [field]: !d[field] } : d
        );
        return { ...b, descriptors: updatedDescs };
      })
    );
  };

  const handleRemoveEntryTerm = (blockIdx: number, termToRemove: string) => {
    setEditableBlocks(prev =>
      prev.map((b, idx) => {
        if (idx !== blockIdx) return b;
        return {
          ...b,
          entryTerms: (b.entryTerms || []).filter(term => term !== termToRemove)
        };
      })
    );
  };

  const handleAddEntryTerm = (blockIdx: number) => {
    const val = (newTermInputs[blockIdx] || '').trim();
    if (!val) return;
    setEditableBlocks(prev =>
      prev.map((b, idx) => {
        if (idx !== blockIdx) return b;
        const existing = b.entryTerms || [];
        if (existing.includes(val.toLowerCase())) return b;
        return {
          ...b,
          entryTerms: [...existing, val.toLowerCase()]
        };
      })
    );
    setNewTermInputs(prev => ({ ...prev, [blockIdx]: '' }));
  };

  const handleRebuildFromBlocks = async () => {
    setStatusBanner(null);
    const effectiveSettings: PipelineSettings = {
      strategy: settings?.strategy ?? 'balanced',
      useTruncation: settings?.useTruncation ?? true,
      noExplode: settings?.noExplode,
      filters: settings?.filters,
      qualifiers: settings?.qualifiers,
      dateRange: settings?.dateRange
    };
    const rebuilt = buildQuerySyntax(editableBlocks, effectiveSettings);
    setCustomPubMedQuery(rebuilt.pubmedQuery);
    setCustomEmbaseQuery(rebuilt.embaseQuery);
    setCustomCochraneQuery(rebuilt.cochraneQuery);
    if (onUpdatePubMedQuery) {
      await onUpdatePubMedQuery(rebuilt.pubmedQuery, {
        mappedBlocks: editableBlocks,
        embaseQuery: rebuilt.embaseQuery,
        cochraneQuery: rebuilt.cochraneQuery
      });
    }
  };

  const handleRefineFromAudit = async () => {
    if (!onPreviewAuditRefinement || isRefiningAudit) return;
    setStatusBanner(null);
    const preview = await onPreviewAuditRefinement();
    if (preview) {
      setPendingRefinement(preview);
    }
  };

  const handleConfirmRefinement = async () => {
    if (!pendingRefinement || !onCommitAuditRefinement || isRefiningAudit) return;
    const toApply = pendingRefinement;
    setPendingRefinement(null);
    const didCommit = await onCommitAuditRefinement(toApply);
    if (didCommit !== false) {
      setStatusBanner({
        kind: 'success',
        text: t.step2.refinedSuccessBanner
      });
    }
  };

  const hasComparatorDroppedNotice =
    Boolean(settings?.activePico?.c && picoInputs?.c?.trim()) &&
    !editableBlocks.some((b) => b.picoType === 'C');

  const isPassiveDropped =
    resultData?.droppedComparatorReason === 'passive_comparator' ||
    (Boolean(picoInputs?.c) && isPassiveComparatorConcept(picoInputs?.c || ''));

  const handleCheckBenchmark = () => {
    const benchList = parseBenchmarkPmids(benchmarkInput);
    const retrievedPmids =
      resultData?.liveResult?.idList && resultData.liveResult.idList.length > 0
        ? resultData.liveResult.idList.map(id => String(id))
        : (resultData?.liveResult?.articles || []).map(a => String(a.pmid));
    const coverage = evaluateBenchmarkCoverage(benchList, retrievedPmids);
    setBenchmarkResult(coverage);
  };

  const score = resultData?.critiqueReport?.score ?? 85;
  const hitCount = resultData?.liveResult?.count ?? 0;
  const pubmedError = resultData?.liveResult?.error || null;
  const rawObservations = resultData?.critiqueReport?.observations || [];
  const rawBreakdown = resultData?.critiqueReport?.pressBreakdown || [];
  const qualitativeAlertCount = rawObservations.filter(
    obs => normalizeAuditObservation(obs)?.severity === 'warning'
  ).length;
  const technicalWarningCount = rawBreakdown.filter(item => item.status === 'warning').length;
  const technicalErrorCount = rawBreakdown.filter(item => item.status === 'penalty').length;
  const basePressStatus: PressStatusLevel =
    resultData?.critiqueReport?.pressStatus ??
    (hitCount === 0 || score === 0 || technicalErrorCount > 0
      ? 'revision_required'
      : hitCount > 2500 || technicalWarningCount > 0 || qualitativeAlertCount > 0
        ? 'needs_refinement'
        : 'compliant');
  const computedPressStatus: PressStatusLevel = pubmedError ? 'revision_required' : basePressStatus;
  const computedAlertCount =
    resultData?.critiqueReport?.pressAlertCount ??
    (technicalErrorCount + technicalWarningCount + qualitativeAlertCount);
  const isStrategyConverged = shouldDisplayStrategyConverged({
    pressStatus: computedPressStatus,
    refinementCount,
    hitCount,
    pubmedError
  });

  return (
    <section className="space-y-6">
      {/* En-tête de l'étape 2 */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
            {t.step2.badge}
          </span>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
            {t.step2.title}
          </h1>
          <p className="text-xs text-slate-500 max-w-2xl">
            {t.step2.subtitle}
          </p>
        </div>

        {/* Compteurs clés (Hits PubMed & Score PRISMA-S) */}
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <div
            className={`px-4 py-2.5 rounded-xl border ${
              pubmedError
                ? 'bg-rose-50/70 border-rose-200 text-rose-900'
                : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="text-[11px] font-medium text-slate-500">{t.step2.pubmedHitsLabel}</div>
            <div className={`text-lg font-bold font-mono ${pubmedError ? 'text-rose-700' : 'text-slate-900'}`}>
              {pubmedError ? t.step2.pubmedUnavailableValue : hitCount.toLocaleString('fr-FR')}
            </div>
          </div>

          <div
            className={`px-4 py-2.5 rounded-xl border ${
              computedPressStatus === 'compliant'
                ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900'
                : computedPressStatus === 'needs_refinement'
                  ? 'bg-amber-50/70 border-amber-200 text-amber-900'
                  : 'bg-rose-50/70 border-rose-200 text-rose-900'
            }`}
          >
            <div className="text-[11px] font-medium opacity-80">{t.step2.auditScoreLabel}</div>
            <div className="flex items-center gap-1.5 text-sm font-bold mt-0.5">
              {computedPressStatus === 'compliant' ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>{t.step2.pressStatusCompliant}</span>
                </>
              ) : computedPressStatus === 'needs_refinement' ? (
                <>
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>
                    {t.step2.pressStatusNeedsRefinement}
                    {computedAlertCount > 0 && (
                      <span className="ml-1.5 text-xs font-semibold opacity-90">
                        ({computedAlertCount}{' '}
                        {computedAlertCount === 1
                          ? t.step2.pressAlertSingle
                          : t.step2.pressAlertPlural}
                        )
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{t.step2.pressStatusRevisionRequired}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {pubmedError && (
        <div className="p-3.5 rounded-xl border border-rose-200 bg-rose-50 text-xs text-rose-900 flex items-start gap-2.5">
          <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <strong className="font-semibold">{t.step2.pubmedErrorBannerPrefix}</strong>{' '}
            <span>{pubmedError}</span>
          </div>
        </div>
      )}

      {statusBanner && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-3 ${
            statusBanner.kind === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2
              className={`w-4 h-4 shrink-0 ${
                statusBanner.kind === 'success' ? 'text-emerald-600' : 'text-amber-600'
              }`}
            />
            <span>{statusBanner.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="font-bold cursor-pointer opacity-75 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {/* Grille principale 2 colonnes : Gauche = Descripteurs MeSH | Droite = Équations & Audit */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Colonne Gauche (5/12) : Descripteurs MeSH validés par axe */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h2 className="text-sm font-bold text-slate-900">
              {t.step2.meshColumnTitle}
            </h2>
            <button
              type="button"
              disabled={isUpdatingQuery}
              onClick={handleRebuildFromBlocks}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isUpdatingQuery ? 'animate-spin' : ''}`} />
              <span>{t.step2.rebuildQueryBtn}</span>
            </button>
          </div>

          <div className="space-y-3">
            {editableBlocks.map((block, bIdx) => {
              const isNot = block.picoType === 'NOT';
              return (
                <div
                  key={`${block.picoType}-${bIdx}`}
                  className={`p-3.5 rounded-xl border space-y-2.5 ${
                    isNot ? 'bg-rose-50/30 border-rose-200' : 'bg-slate-50/60 border-slate-200'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-bold font-mono shrink-0 ${
                          isNot ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-800'
                        }`}
                      >
                        {block.picoType}
                      </span>
                      <span className="text-xs font-semibold text-slate-800 whitespace-normal break-words leading-relaxed">
                        {block.originalText}
                      </span>
                    </div>
                  </div>

                  {/* Descripteurs officiels NLM Dxxxxxx ou Texte libre [tiab] */}
                  <div className="space-y-1.5">
                    {(block.descriptors || []).map((desc, dIdx) => {
                      const isFreeTextConcept =
                        desc.meshId === 'Concept-Libre' ||
                        desc.meshId === 'Custom' ||
                        desc.meshId.startsWith('Concept-');

                      return (
                        <div
                          key={`${desc.meshId}-${dIdx}`}
                          className="p-2 rounded-lg bg-white border border-slate-200 flex flex-wrap items-center justify-between gap-2"
                        >
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            {isFreeTextConcept ? (
                              <>
                                <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 text-[10px] font-semibold shrink-0">
                                  {t.step2.freeTextConceptBadge}
                                </span>
                                <span className="text-xs font-bold text-slate-900 font-mono break-words">
                                  "{desc.descriptor}"[tiab]
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-mono font-bold shrink-0">
                                  {desc.meshId}
                                </span>
                                <span className="text-xs font-bold text-slate-900 font-mono break-words">
                                  "{desc.descriptor}"[Mesh]
                                </span>
                              </>
                            )}
                          </div>
                          {!isFreeTextConcept && (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => toggleDescriptorOption(bIdx, dIdx, 'noExp')}
                                className={`px-2 py-0.5 rounded text-[10px] font-semibold border cursor-pointer ${
                                  desc.noExp
                                    ? 'bg-amber-50 border-amber-400 text-amber-800'
                                    : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                                }`}
                              >
                                :NoExp
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleDescriptorOption(bIdx, dIdx, 'isMajor')}
                                className={`px-2 py-0.5 rounded text-[10px] font-semibold border cursor-pointer ${
                                  desc.isMajor
                                    ? 'bg-indigo-50 border-indigo-400 text-indigo-800'
                                    : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                                }`}
                              >
                                [Majr]
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Synonymes [TiAb] */}
                  {(() => {
                    const allTerms = block.entryTerms || [];
                    const isExpanded = Boolean(expandedSynonymsByBlock[bIdx]);
                    const visibleTerms = isExpanded ? allTerms : allTerms.slice(0, 5);
                    const hiddenCount = Math.max(0, allTerms.length - 5);
                    return (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        {visibleTerms.map(term => (
                          <span
                            key={term}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white border border-slate-200 text-[11px] text-slate-700 font-mono"
                          >
                            <span>{term}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveEntryTerm(bIdx, term)}
                              className="text-slate-400 hover:text-rose-600 cursor-pointer"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {hiddenCount > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedSynonymsByBlock(prev => ({
                                ...prev,
                                [bIdx]: !isExpanded
                              }))
                            }
                            className="px-2 py-0.5 rounded-md border border-slate-200 bg-slate-100/80 hover:bg-slate-200/70 text-[11px] font-medium text-slate-600 cursor-pointer transition-colors"
                          >
                            {isExpanded
                              ? t.step2.collapseSynonymsBtn
                              : `+ ${hiddenCount} ${t.step2.showMoreSynonymsWord}`}
                          </button>
                        )}
                      </div>
                    );
                  })()}

                  {/* Ajout rapide d'un synonyme ou molécule */}
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="text"
                      value={newTermInputs[bIdx] || ''}
                      onChange={e => setNewTermInputs(prev => ({ ...prev, [bIdx]: e.target.value }))}
                      onKeyDown={e => e.key === 'Enter' && handleAddEntryTerm(bIdx)}
                      placeholder={t.step2.addConceptPlaceholder}
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-800 placeholder:text-slate-400"
                    />
                    <button
                      type="button"
                      onClick={() => handleAddEntryTerm(bIdx)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium cursor-pointer"
                    >
                      <Plus className="w-3 h-3" />
                      <span>{t.step2.addBtn}</span>
                    </button>
                  </div>
                </div>
              );
            })}

            {hasComparatorDroppedNotice && (
              <div className="p-3 rounded-xl bg-amber-50/60 border border-amber-200 text-xs text-amber-900 flex items-start gap-2 leading-relaxed">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-mono font-bold mr-1.5 text-amber-800">C</span>
                  <span>
                    {isPassiveDropped
                      ? t.step2.droppedComparatorNotice
                      : t.step2.unresolvedComparatorNotice}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Colonne Droite (7/12) : Équations PubMed / Embase / CENTRAL, Audit & PMID repères */}
        <div className="lg:col-span-7 space-y-5">
          {/* Carte Équations Booléennes */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
              {/* Onglets des 3 bases */}
              <div className="inline-flex rounded-xl bg-slate-100 p-1">
                {(
                  [
                    { id: 'pubmed', label: 'PubMed / MEDLINE' },
                    { id: 'embase', label: 'Embase.com' },
                    { id: 'cochrane', label: 'Cochrane CENTRAL' }
                  ] as const
                ).map(db => (
                  <button
                    key={db.id}
                    type="button"
                    onClick={() => setActiveDbTab(db.id)}
                    className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                      activeDbTab === db.id
                        ? 'bg-white text-indigo-700 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {db.label}
                  </button>
                ))}
              </div>

              {/* Actions Copier & Sauvegarder */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleCopy(currentQueryText, activeDbTab)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  {copiedTab === activeDbTab ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                      <span className="text-emerald-700">{t.step2.copiedLabel}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-slate-500" />
                      <span>{t.step2.copyQueryBtn}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => onSaveHistory(customPubMedQuery)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer ${
                    isSaved
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Bookmark className="w-3.5 h-3.5" />
                  <span>{isSaved ? t.step2.savedBtn : t.step2.saveBtn}</span>
                </button>
              </div>
            </div>

            {/* Zone d'édition de l'équation avec police monospace haute lisibilité et hauteur adaptative */}
            <textarea
              rows={Math.max(8, Math.min(24, currentQueryText.split('\n').length + 3))}
              value={currentQueryText}
              onChange={e => {
                if (activeDbTab === 'pubmed') setCustomPubMedQuery(e.target.value);
                else if (activeDbTab === 'embase') setCustomEmbaseQuery(e.target.value);
                else setCustomCochraneQuery(e.target.value);
              }}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-900 focus:border-indigo-600 focus:bg-white focus:outline-none"
            />

            {(onPreviewAuditRefinement || (activeDbTab === 'pubmed' && isPubMedQueryModified && onUpdatePubMedQuery)) && (
              <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  {onPreviewAuditRefinement && isStrategyConverged ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      <span>{t.step2.strategyConvergedBadge}</span>
                    </span>
                  ) : (
                    onPreviewAuditRefinement && (
                      <button
                        type="button"
                        disabled={isRefiningAudit}
                        onClick={() => void handleRefineFromAudit()}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                      >
                        {isRefiningAudit ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        <span>{isRefiningAudit ? t.step2.refiningPicoBtn : t.step2.optimizePicoBtn}</span>
                      </button>
                    )
                  )}
                </div>

                {activeDbTab === 'pubmed' && isPubMedQueryModified && onUpdatePubMedQuery && (
                  <button
                    type="button"
                    disabled={isUpdatingQuery}
                    onClick={() =>
                      void onUpdatePubMedQuery(customPubMedQuery, {
                        mappedBlocks: editableBlocks
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-60 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isUpdatingQuery ? 'animate-spin' : ''}`} />
                    <span>{t.step2.applyEditedQueryBtn}</span>
                  </button>
                )}
              </div>
            )}

            {/* Aperçu Avant / Après de l'affinage PICO avant validation */}
            {pendingRefinement && (
              <div className="p-4 rounded-xl bg-indigo-50/50 border border-indigo-200 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-xs font-bold text-indigo-950">
                      {t.step2.refinePreviewTitle}
                    </h4>
                    <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                      {pendingRefinement.explanation}
                    </p>
                  </div>
                </div>

                {(() => {
                  const axesList: ReadonlyArray<{ readonly key: 'p' | 'i' | 'c' | 'o' | 'not'; readonly badge: string }> = [
                    { key: 'p', badge: 'P' },
                    { key: 'i', badge: 'I/E' },
                    { key: 'c', badge: 'C' },
                    { key: 'o', badge: 'O' },
                    { key: 'not', badge: 'NOT' }
                  ];
                  const changedAxes = axesList.filter(({ key }) => {
                    const beforeVal = (picoInputs?.[key] || '').trim();
                    const afterVal = (pendingRefinement.refinedPico[key] || '').trim();
                    const beforeAct = Boolean(settings?.activePico?.[key] ?? (key !== 'c' && key !== 'not'));
                    const afterAct = Boolean(pendingRefinement.activePico?.[key] ?? beforeAct);
                    return beforeVal !== afterVal || beforeAct !== afterAct;
                  });

                  if (changedAxes.length === 0) {
                    return (
                      <div className="text-xs text-slate-600 italic">
                        {t.step2.refineNoChangesNotice}
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-2">
                      {changedAxes.map(({ key, badge }) => {
                        const beforeVal = (picoInputs?.[key] || '').trim() || '—';
                        const afterVal = (pendingRefinement.refinedPico[key] || '').trim() || '—';
                        const beforeAct = Boolean(settings?.activePico?.[key] ?? (key !== 'c' && key !== 'not'));
                        const afterAct = Boolean(pendingRefinement.activePico?.[key] ?? beforeAct);
                        const activationChanged = beforeAct !== afterAct;

                        return (
                          <div key={key} className="p-2.5 rounded-lg bg-white border border-indigo-100 text-xs space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 font-mono font-bold text-[10px]">
                                {badge}
                              </span>
                              {activationChanged && (
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                                    afterAct
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                      : 'bg-amber-50 text-amber-800 border border-amber-200'
                                  }`}
                                >
                                  {afterAct ? t.step2.refineActivatedBadge : t.step2.refineDeactivatedBadge}
                                </span>
                              )}
                            </div>
                            {beforeVal !== afterVal && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
                                <div className="text-slate-500">
                                  <span className="font-semibold mr-1">{t.step2.refineBeforeLabel} :</span>
                                  <span className="line-through">{beforeVal}</span>
                                </div>
                                <div className="text-slate-900 font-medium">
                                  <span className="font-semibold text-indigo-700 mr-1">{t.step2.refineAfterLabel} :</span>
                                  <span>{afterVal}</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setPendingRefinement(null)}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium cursor-pointer"
                  >
                    {t.step2.refineCancelBtn}
                  </button>
                  <button
                    type="button"
                    disabled={isRefiningAudit}
                    onClick={() => void handleConfirmRefinement()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>{t.step2.refineApplyBtn}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Synthèse détaillée de l'Indice PRESS & Revue qualitative */}
          {resultData?.critiqueReport && (
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
              {resultData.critiqueReport.pressBreakdown && resultData.critiqueReport.pressBreakdown.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    {t.step2.pressBreakdownTitle}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {resultData.critiqueReport.pressBreakdown.map((item) => (
                      <span
                        key={item.id}
                        title={item.detail}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold ${
                          item.status === 'ok'
                            ? 'bg-emerald-50/70 text-emerald-800 border-emerald-200'
                            : item.status === 'warning'
                              ? 'bg-amber-50/80 text-amber-900 border-amber-200'
                              : 'bg-rose-50/80 text-rose-800 border-rose-200'
                        }`}
                      >
                        {item.status === 'ok' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        ) : item.status === 'warning' ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                        )}
                        <span>{item.label}</span>
                      </span>
                    ))}
                  </div>
                  {resultData.critiqueReport.pressBreakdown.some(item => item.status !== 'ok') && (
                    <div className="space-y-1.5 pt-0.5">
                      {resultData.critiqueReport.pressBreakdown
                        .filter(item => item.status !== 'ok')
                        .map(item => (
                          <div
                            key={`${item.id}-detail`}
                            className={`px-3 py-1.5 rounded-lg border text-[11px] leading-snug ${
                              item.status === 'warning'
                                ? 'bg-amber-50/60 border-amber-200 text-amber-900'
                                : 'bg-rose-50/60 border-rose-200 text-rose-900'
                            }`}
                          >
                            <span className="font-semibold">{item.label} :</span> {item.detail}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    {t.step2.auditObservationsTitle}
                  </h3>
                  {resultData.critiqueReport.evaluatorModel && (
                    <span className="text-[11px] font-medium text-slate-500">
                      {resultData.critiqueReport.evaluatorModel}
                    </span>
                  )}
                </div>

                <ul className="space-y-2 text-xs text-slate-700 leading-relaxed">
                  {(resultData.critiqueReport.observations || []).map((obs, idx) => {
                    const normalized = normalizeAuditObservation(obs);
                    if (!normalized) return null;
                    const isWarning = normalized.severity === 'warning';
                    const isInfo = normalized.severity === 'info';
                    return (
                      <li key={idx} className="flex items-start gap-2">
                        {isWarning ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                        ) : isInfo ? (
                          <Info className="w-3.5 h-3.5 text-sky-600 shrink-0 mt-0.5" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                        )}
                        <span
                          className={`whitespace-normal break-words ${
                            isWarning
                              ? 'text-amber-900 font-medium'
                              : isInfo
                                ? 'text-slate-600'
                                : 'text-slate-700'
                          }`}
                        >
                          {normalized.text}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                {(resultData.critiqueReport.recommendations || []).length > 0 && (
                  <div className="pt-2.5 border-t border-slate-100 space-y-2">
                    {(resultData.critiqueReport.recommendations || []).map((rec, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-xs text-amber-900 bg-amber-50/70 border border-amber-200/80 rounded-lg px-3 py-2 leading-relaxed">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                        <span className="whitespace-normal break-words">{rec}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Accordéon replié par défaut en bas de page : Vérifier la présence d'articles connus (PMID repères) */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xs">
        <button
          type="button"
          onClick={() => setShowBenchmark(prev => !prev)}
          className="w-full px-5 py-3.5 bg-slate-50/70 hover:bg-slate-100/70 rounded-2xl flex items-center justify-between text-xs font-semibold text-slate-800 cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-indigo-600" />
            <span>{t.step2.benchmarkTitle}</span>
          </div>
          {showBenchmark ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </button>

        {showBenchmark && (
          <div className="p-5 border-t border-slate-200 space-y-3">
            <p className="text-xs text-slate-500 leading-relaxed">
              {t.step2.benchmarkHelper}
            </p>
            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={benchmarkInput}
                onChange={e => setBenchmarkInput(e.target.value)}
                placeholder={t.step2.benchmarkPlaceholder}
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-mono text-slate-800"
              />
              <button
                type="button"
                onClick={handleCheckBenchmark}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold cursor-pointer"
              >
                {t.step2.benchmarkVerifyBtn}
              </button>
            </div>

            {benchmarkResult && (
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1.5">
                <div className="font-semibold text-slate-900">
                  {t.step2.benchmarkCoverageSummary
                    .replace('{found}', String(benchmarkResult.foundPmids.length))
                    .replace('{total}', String(benchmarkResult.totalBenchmark))
                    .replace('{pct}', String(benchmarkResult.coveragePercent))}
                </div>
                {benchmarkResult.foundPmids.length > 0 && (
                  <div className="text-emerald-700 font-mono">
                    {t.step2.benchmarkFoundLabel} {benchmarkResult.foundPmids.join(', ')}
                  </div>
                )}
                {benchmarkResult.missingPmids.length > 0 && (
                  <div className="text-amber-700 font-mono">
                    {t.step2.benchmarkMissingLabel} {benchmarkResult.missingPmids.join(', ')}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Navigation bas de page (Retour Étape 1 / Continuer vers Étape 3) */}
      <div className="flex items-center justify-between pt-2">
        {onBackToStep1 ? (
          <button
            type="button"
            onClick={onBackToStep1}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{t.step2.backToStep1}</span>
          </button>
        ) : <div />}

        {onGoToStep3 && (
          <button
            type="button"
            onClick={onGoToStep3}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold shadow-xs cursor-pointer"
          >
            <span>{t.step2.goToStep3}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </section>
  );
}
