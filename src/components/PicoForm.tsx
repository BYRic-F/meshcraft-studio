import React, { useState } from 'react';
import {
  CheckSquare,
  Square,
  Sparkles,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  Calendar,
  Sliders,
  AlertCircle,
  CheckCircle2,
  FileText,
  Layers,
  HelpCircle
} from 'lucide-react';
import {
  parseClinicalAbstractNLP,
  PicoInputs,
  PipelineSettings,
  ClinicalPicoExtractionResult
} from '../services/multiAgentWorkflow';
import { mapErrorToUserMessage } from '../services/localAiService';
import { useTranslation } from '../i18n';

export interface PicoFormProps {
  readonly picoInputs: PicoInputs;
  readonly setPicoInputs: React.Dispatch<React.SetStateAction<PicoInputs>>;
  readonly settings: PipelineSettings;
  readonly setSettings: React.Dispatch<React.SetStateAction<PipelineSettings>>;
  readonly onGenerate: () => void;
  readonly isGenerating: boolean;
}

type PicoKey = 'p' | 'i' | 'c' | 'o' | 'not';

const AVAILABLE_QUALIFIERS: ReadonlyArray<{ readonly value: string; readonly labelFr: string; readonly labelEn: string }> = [
  { value: 'chemically induced', labelFr: 'Induit chimiquement (/chemically induced)', labelEn: 'Chemically induced (/CI)' },
  { value: 'adverse effects', labelFr: 'Effets indésirables (/adverse effects)', labelEn: 'Adverse effects (/AE)' },
  { value: 'drug therapy', labelFr: 'Traitement médicamenteux (/drug therapy)', labelEn: 'Drug therapy (/DT)' },
  { value: 'therapy', labelFr: 'Thérapeutique (/therapy)', labelEn: 'Therapy (/TH)' },
  { value: 'diet therapy', labelFr: 'Diétothérapie (/diet therapy)', labelEn: 'Diet therapy (/DH)' },
  { value: 'diagnosis', labelFr: 'Diagnostic (/diagnosis)', labelEn: 'Diagnosis (/DI)' },
  { value: 'prevention and control', labelFr: 'Prévention (/prevention and control)', labelEn: 'Prevention & control (/PC)' },
  { value: 'epidemiology', labelFr: 'Épidémiologie (/epidemiology)', labelEn: 'Epidemiology (/EP)' },
  { value: 'mortality', labelFr: 'Mortalité (/mortality)', labelEn: 'Mortality (/MO)' },
  { value: 'complications', labelFr: 'Complications (/complications)', labelEn: 'Complications (/CO)' }
];

export default function PicoForm({
  picoInputs,
  setPicoInputs,
  settings,
  setSettings,
  onGenerate,
  isGenerating
}: PicoFormProps) {
  const { locale, t } = useTranslation();
  const [inputMode, setInputMode] = useState<'structured' | 'freetext'>('structured');
  const [frameworkMode, setFrameworkMode] = useState<'pico' | 'peco'>('pico');
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);

  const [rawNlpText, setRawNlpText] = useState<string>('');
  const [isParsingNlp, setIsParsingNlp] = useState<boolean>(false);
  const [nlpResult, setNlpResult] = useState<ClinicalPicoExtractionResult | null>(null);
  const [nlpError, setNlpError] = useState<string | null>(null);

  const activePico = settings.activePico || { p: true, i: true, c: false, o: true, not: false };

  const handleFieldChange = (key: PicoKey, value: string) => {
    setPicoInputs(prev => ({ ...prev, [key]: value }));
    if (settings.qualifications?.[key]) {
      setSettings(prev => {
        if (!prev.qualifications) return prev;
        const { [key]: _discarded, ...restQualifications } = prev.qualifications;
        return {
          ...prev,
          qualifications: restQualifications
        };
      });
    }
  };

  const togglePicoAxis = (key: PicoKey) => {
    setSettings(prev => {
      const current = prev.activePico || { p: true, i: true, c: false, o: true, not: false };
      return {
        ...prev,
        activePico: {
          ...current,
          [key]: !current[key]
        }
      };
    });
  };

  const toggleFilter = (filterCode: string) => {
    setSettings(prev => {
      const current = prev.filters || [];
      const updated = current.includes(filterCode)
        ? current.filter(f => f !== filterCode)
        : [...current, filterCode];
      return { ...prev, filters: updated };
    });
  };

  const toggleQualifier = (qual: string) => {
    setSettings(prev => {
      const current = prev.qualifiers || [];
      const updated = current.includes(qual)
        ? current.filter(q => q !== qual)
        : [...current, qual];
      return { ...prev, qualifiers: updated };
    });
  };

  const handleNlpExtract = async () => {
    if (!rawNlpText.trim()) return;
    setIsParsingNlp(true);
    setNlpError(null);
    try {
      const extracted = await parseClinicalAbstractNLP(rawNlpText);
      setNlpResult(extracted);
    } catch (err: unknown) {
      setNlpError(mapErrorToUserMessage(err));
      setNlpResult(null);
    } finally {
      setIsParsingNlp(false);
    }
  };

  const handleApplyExtracted = () => {
    if (!nlpResult) return;
    setPicoInputs({
      p: nlpResult.p || '',
      i: nlpResult.i || '',
      c: nlpResult.c || '',
      o: nlpResult.o || '',
      not: nlpResult.not || ''
    });
    const rec = nlpResult.qualifications?.recommendedActivePico;
    setSettings((prev) => ({
      ...prev,
      qualifications: nlpResult.qualifications,
      ...(rec
        ? {
            activePico: {
              p: rec.p,
              i: rec.i,
              c: rec.c,
              o: rec.o,
              not: rec.not
            }
          }
        : {})
    }));
    setInputMode('structured');
  };

  const handleLoadSampleText = (sample: 'fasting' | 'sglt2' | 'parkinson') => {
    if (sample === 'fasting') {
      setFrameworkMode('pico');
      setRawNlpText(
        "Évaluation de l'effet du jeûne intermittent sans restriction calorique prescrite sur la perte de poids et l'IMC chez les adultes en surpoids ou obésité, comparé à une alimentation habituelle. Exclusion du diabète de type 1."
      );
    } else if (sample === 'sglt2') {
      setFrameworkMode('pico');
      setRawNlpText(
        "Chez les adultes atteints de diabète de type 2 et d'insuffisance rénale chronique, évaluation des inhibiteurs du SGLT2 (empagliflozine, dapagliflozine) comparés au placebo sur la mortalité cardiovasculaire et l'hospitalisation pour insuffisance cardiaque."
      );
    } else {
      setFrameworkMode('peco');
      setRawNlpText(
        "Le syndrome parkinsonien médicamenteux peut conduire à une erreur diagnostique, à une cascade de prescriptions et à une perte fonctionnelle. La revue vise à produire une synthèse utile au médecin généraliste, centrée sur les médicaments encore commercialisés en France, en distinguant estimation du risque, signal de pharmacovigilance et observation clinique. Chez l’adulte, quels médicaments actuellement commercialisés en France et utilisés en soins primaires sont associés à la survenue d’un syndrome parkinsonien, avec quelle ampleur du risque et quel niveau de certitude des preuves publiées entre le 29 octobre 2006 et le 28 octobre 2026 ?"
      );
    }
  };

  const axesConfig: ReadonlyArray<{
    readonly key: PicoKey;
    readonly badge: string;
    readonly label: string;
    readonly placeholder: string;
    readonly tooltip?: string;
    readonly isExclusion?: boolean;
  }> = [
    {
      key: 'p',
      badge: 'P',
      label: t.step1.pLabel,
      placeholder: t.step1.pPlaceholder
    },
    {
      key: 'i',
      badge: frameworkMode === 'peco' ? 'E' : 'I',
      label: frameworkMode === 'peco' ? t.step1.iLabelPeco : t.step1.iLabelPico,
      placeholder: frameworkMode === 'peco' ? t.step1.iPlaceholderPeco : t.step1.iPlaceholderPico
    },
    {
      key: 'c',
      badge: 'C',
      label: t.step1.cLabel,
      placeholder: t.step1.cPlaceholder,
      tooltip: t.step1.cTooltip
    },
    {
      key: 'o',
      badge: 'O',
      label: t.step1.oLabel,
      placeholder: t.step1.oPlaceholder
    },
    {
      key: 'not',
      badge: 'NOT',
      label: t.step1.notLabel,
      placeholder: t.step1.notPlaceholder,
      tooltip: t.step1.notTooltip,
      isExclusion: true
    }
  ];

  const startYearValue = String(
    settings.dateRange?.startYear ??
      (settings.dateRange?.startDate ? settings.dateRange.startDate.slice(0, 4) : '2006')
  );
  const endYearValue = String(
    settings.dateRange?.endYear ??
      (settings.dateRange?.endDate ? settings.dateRange.endDate.slice(0, 4) : '2026')
  );
  const expertFilterCount = (settings.filters?.length ?? 0) + (settings.qualifiers?.length ?? 0);

  return (
    <section className="bg-white border border-slate-200 rounded-2xl shadow-xs">
      {/* En-tête de l'étape 1 */}
      <div className="px-6 py-5 border-b border-slate-100 flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-slate-50/60 rounded-t-2xl">
        <div className="space-y-1">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
            {t.step1.badge}
          </span>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">
            {t.step1.title}
          </h1>
          <p className="text-xs text-slate-500 max-w-2xl">
            {t.step1.subtitle}
          </p>
        </div>

        {/* Bascule Mode Structuré / Assistant IA */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="inline-flex rounded-xl bg-slate-200/70 p-1">
            <button
              type="button"
              onClick={() => setInputMode('structured')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                inputMode === 'structured'
                  ? 'bg-indigo-600 text-white shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>{t.step1.modeStructured}</span>
            </button>
            <button
              type="button"
              onClick={() => setInputMode('freetext')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                inputMode === 'freetext'
                  ? 'bg-indigo-600 text-white shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>{t.step1.modeFreeText}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Mode Extraction par IA depuis un protocole ou résumé libre */}
        {inputMode === 'freetext' ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-semibold text-slate-700">
                {t.step1.freeTextLabel}
              </label>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleLoadSampleText('parkinson')}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer"
                >
                  {t.step1.sampleParkinson}
                </button>
                <button
                  type="button"
                  onClick={() => handleLoadSampleText('fasting')}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer"
                >
                  {t.step1.sampleFasting}
                </button>
                <button
                  type="button"
                  onClick={() => handleLoadSampleText('sglt2')}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer"
                >
                  {t.step1.sampleSglt2}
                </button>
              </div>
            </div>

            <textarea
              rows={4}
              value={rawNlpText}
              onChange={e => setRawNlpText(e.target.value)}
              placeholder={t.step1.freeTextPlaceholder}
              className="w-full rounded-xl border border-slate-300 bg-slate-50/50 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 focus:bg-white focus:outline-none transition-colors"
            />

            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled={isParsingNlp || !rawNlpText.trim()}
                onClick={handleNlpExtract}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold transition-colors cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>{isParsingNlp ? t.step1.extractingBtn : t.step1.extractBtn}</span>
              </button>
            </div>

            {nlpError && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2.5 text-xs text-rose-800">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{nlpError}</span>
              </div>
            )}

            {nlpResult && (
              <div className="p-4 rounded-xl bg-emerald-50/60 border border-emerald-200 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>{nlpResult.reasoning}</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleApplyExtracted}
                    className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    {t.step1.applyExtractionBtn}
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-700">
                  <div><strong>P :</strong> {nlpResult.p || '—'}</div>
                  <div><strong>I/E :</strong> {nlpResult.i || '—'}</div>
                  <div><strong>C :</strong> {nlpResult.c || '—'}</div>
                  <div><strong>O :</strong> {nlpResult.o || '—'}</div>
                  {nlpResult.not && <div className="sm:col-span-2"><strong>NOT :</strong> {nlpResult.not}</div>}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Mode Guidé Structuré par Axe (P, I/E, C, O, NOT) */
          <div className="space-y-3">
            {/* Sélecteur compact PICO / PECO en en-tête de formulaire */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
              <div className="inline-flex items-center gap-2 text-xs text-slate-600">
                <span className="font-semibold text-slate-700">{t.step1.frameworkApproachLabel}</span>
                <div className="inline-flex rounded-lg bg-slate-100 p-0.5 border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setFrameworkMode('pico')}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                      frameworkMode === 'pico'
                        ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t.step1.frameworkPico}
                  </button>
                  <button
                    type="button"
                    onClick={() => setFrameworkMode('peco')}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer ${
                      frameworkMode === 'peco'
                        ? 'bg-white text-indigo-700 shadow-2xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {t.step1.frameworkPeco}
                  </button>
                </div>
              </div>
            </div>

            {axesConfig.map(axis => {
              const isChecked = Boolean(activePico[axis.key]);
              const value = picoInputs[axis.key] || '';
              return (
                <div
                  key={axis.key}
                  className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3.5 rounded-xl border transition-all ${
                    isChecked
                      ? axis.isExclusion
                        ? 'bg-rose-50/30 border-rose-200'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                      : 'bg-slate-50 border-slate-200/60 opacity-75'
                  }`}
                >
                  <div className="flex items-center gap-2 sm:w-64 shrink-0">
                    <button
                      type="button"
                      onClick={() => togglePicoAxis(axis.key)}
                      className="flex items-center gap-2.5 text-left cursor-pointer"
                    >
                      {isChecked ? (
                        <CheckSquare className={`w-4 h-4 shrink-0 ${axis.isExclusion ? 'text-rose-600' : 'text-indigo-600'}`} />
                      ) : (
                        <Square className="w-4 h-4 shrink-0 text-slate-400" />
                      )}
                      <span
                        className={`px-2 py-0.5 rounded-md text-xs font-bold font-mono ${
                          axis.isExclusion
                            ? 'bg-rose-100 text-rose-700'
                            : 'bg-indigo-50 text-indigo-700'
                        }`}
                      >
                        {axis.badge}
                      </span>
                      <span className="text-xs font-semibold text-slate-800 leading-tight">
                        {axis.label}
                      </span>
                    </button>
                    {axis.tooltip && (
                      <span
                        title={axis.tooltip}
                        aria-label={axis.tooltip}
                        tabIndex={0}
                        className="inline-flex items-center text-slate-400 hover:text-indigo-600 cursor-help shrink-0"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                      </span>
                    )}
                  </div>

                  <input
                    type="text"
                    value={value}
                    onChange={e => handleFieldChange(axis.key, e.target.value)}
                    placeholder={axis.placeholder}
                    className="flex-1 rounded-lg border border-slate-200 bg-slate-50/60 px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 focus:bg-white focus:outline-none transition-colors"
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Paramètres principaux visibles dans le flux : Profil de sensibilité & Bornes de dates */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-1">
          {/* 1. Profil de sensibilité */}
          <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/40 space-y-2.5">
            <label className="text-xs font-semibold text-slate-700 block">
              {t.step1.sensitivityLabel}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['sensitive', 'balanced', 'specific'] as const).map(strat => {
                const isSelected = (settings.strategy || 'balanced') === strat;
                const label = strat === 'sensitive'
                  ? t.step1.sensBroad
                  : strat === 'balanced'
                    ? t.step1.sensBalanced
                    : t.step1.sensSpecific;
                return (
                  <button
                    key={strat}
                    type="button"
                    onClick={() => setSettings(prev => ({ ...prev, strategy: strat }))}
                    className={`px-2.5 py-2 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-50 border-indigo-600 text-indigo-700'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 2. Bornes de dates (Année début – Année fin) */}
          <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/40 space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                <span>{t.step1.dateRangeLabel}</span>
              </label>
              <button
                type="button"
                onClick={() =>
                  setSettings(prev => ({
                    ...prev,
                    dateRange: {
                      ...prev.dateRange,
                      enabled: !prev.dateRange?.enabled,
                      startYear: startYearValue,
                      endYear: endYearValue,
                      startDate: startYearValue.length === 4 ? `${startYearValue}/01/01` : '2006/01/01',
                      endDate: endYearValue.length === 4 ? `${endYearValue}/12/31` : '2026/12/31'
                    }
                  }))
                }
                className={`px-2.5 py-0.5 rounded-md text-xs font-semibold border transition-colors cursor-pointer ${
                  settings.dateRange?.enabled
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                    : 'bg-white border-slate-200 text-slate-600 hover:text-indigo-700'
                }`}
              >
                {settings.dateRange?.enabled ? t.step1.dateEnabled : t.step1.dateEnable}
              </button>
            </div>

            <div className={`grid grid-cols-2 gap-3 ${settings.dateRange?.enabled ? '' : 'opacity-65'}`}>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 shrink-0">{t.step1.dateFrom}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={startYearValue}
                  onChange={e => {
                    const cleanYear = e.target.value.replace(/\D/g, '').slice(0, 4);
                    setSettings(prev => ({
                      ...prev,
                      dateRange: {
                        ...prev.dateRange,
                        enabled: true,
                        startYear: cleanYear,
                        endYear: endYearValue,
                        startDate: cleanYear.length === 4 ? `${cleanYear}/01/01` : undefined,
                        endDate: endYearValue.length === 4 ? `${endYearValue}/12/31` : undefined
                      }
                    }));
                  }}
                  placeholder="2006"
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono text-slate-800 focus:border-indigo-600 focus:outline-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 shrink-0">{t.step1.dateTo}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={endYearValue}
                  onChange={e => {
                    const cleanYear = e.target.value.replace(/\D/g, '').slice(0, 4);
                    setSettings(prev => ({
                      ...prev,
                      dateRange: {
                        ...prev.dateRange,
                        enabled: true,
                        startYear: startYearValue,
                        endYear: cleanYear,
                        startDate: startYearValue.length === 4 ? `${startYearValue}/01/01` : undefined,
                        endDate: cleanYear.length === 4 ? `${cleanYear}/12/31` : undefined
                      }
                    }));
                  }}
                  placeholder="2026"
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-mono text-slate-800 focus:border-indigo-600 focus:outline-none"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Accordéon replié par défaut : Affinage expert (Filtres méthodologiques & Qualificatifs MeSH) */}
        <div className="border border-slate-200 rounded-xl">
          <button
            type="button"
            onClick={() => setShowAdvanced(prev => !prev)}
            className="w-full px-4 py-3 bg-slate-50 hover:bg-slate-100/80 rounded-xl flex items-center justify-between text-xs font-semibold text-slate-700 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-indigo-600" />
              <span>{t.step1.expertRefinementTitle}</span>
              {expertFilterCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                  {expertFilterCount} {expertFilterCount === 1 ? t.step1.expertActiveSingle : t.step1.expertActivePlural}
                </span>
              )}
            </div>
            {showAdvanced ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
          </button>

          {showAdvanced && (
            <div className="p-5 bg-white border-t border-slate-200 rounded-b-xl grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* 3. Filtres méthodologiques Cochrane */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 block">
                  {t.step1.filtersLabel}
                </label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { code: 'humans_cochrane', label: t.step1.filterHumansCochrane },
                    { code: 'rct', label: t.step1.filterRct },
                    { code: 'systematic', label: t.step1.filterSystematic }
                  ].map(f => {
                    const active = (settings.filters || []).includes(f.code);
                    return (
                      <button
                        key={f.code}
                        type="button"
                        onClick={() => toggleFilter(f.code)}
                        className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer ${
                          active
                            ? 'bg-emerald-50 border-emerald-600 text-emerald-800 font-semibold'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {f.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 4. Sous-rubriques / Qualificatifs MeSH */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700 block">
                  {t.step1.qualifiersLabel}
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {AVAILABLE_QUALIFIERS.map(q => {
                    const active = (settings.qualifiers || []).includes(q.value);
                    return (
                      <button
                        key={q.value}
                        type="button"
                        onClick={() => toggleQualifier(q.value)}
                        className={`px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer ${
                          active
                            ? 'bg-indigo-50 border-indigo-600 text-indigo-700 font-semibold'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {locale === 'en' ? q.labelEn : q.labelFr}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Barre d'action principale en bas à droite */}
        <div className="pt-2 flex items-center justify-end">
          <button
            type="button"
            disabled={isGenerating}
            onClick={onGenerate}
            className="inline-flex items-center gap-2.5 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white text-sm font-semibold shadow-xs transition-all cursor-pointer"
          >
            <span>{isGenerating ? t.step1.generatingCta : t.step1.generateCta}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </section>
  );
}
