import { Stethoscope, History, Settings, Check, Globe } from 'lucide-react';
import { useTranslation } from '../i18n';

export type WizardStepNumber = 1 | 2 | 3 | 4;

export interface HeaderProps {
  readonly wizardStep: WizardStepNumber;
  readonly onSelectWizardStep: (step: WizardStepNumber) => void;
  readonly hasResults: boolean;
  readonly onOpenHistory: () => void;
  readonly onOpenPrerequisites?: () => void;
  readonly onOpenAiSettings?: () => void;
  readonly isHetopConnected?: boolean;
  readonly hasNcbiKey?: boolean;
  readonly isAiOnline?: boolean;
  readonly aiProvider?: string;
  readonly historyCount: number;
  readonly isGenerating: boolean;
}

export default function Header({
  wizardStep,
  onSelectWizardStep,
  hasResults,
  onOpenHistory,
  onOpenPrerequisites,
  onOpenAiSettings,
  isHetopConnected,
  hasNcbiKey,
  isAiOnline,
  historyCount
}: HeaderProps) {
  const { locale, setLocale, t } = useTranslation();

  const steps: ReadonlyArray<{ readonly num: WizardStepNumber; readonly label: string; readonly enabled: boolean }> = [
    { num: 1, label: t.header.step1Short, enabled: true },
    { num: 2, label: t.header.step2Short, enabled: hasResults },
    { num: 3, label: t.header.step3Short, enabled: hasResults },
    { num: 4, label: t.header.step4Short, enabled: hasResults }
  ];

  const isAllConnected = Boolean(isAiOnline && (hasNcbiKey || isHetopConnected));

  return (
    <header className="border-b border-slate-200 bg-white/95 backdrop-blur-md sticky top-0 z-30 shadow-2xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Logo & identité clinique */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => onSelectWizardStep(1)}
            className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-xs hover:bg-indigo-700 transition-colors cursor-pointer"
          >
            <Stethoscope className="w-5 h-5" />
          </button>
          <div>
            <div className="text-base font-bold text-slate-900 tracking-tight leading-tight">
              {t.appTitle}
            </div>
            <p className="text-[11px] text-slate-500 hidden md:block leading-tight">
              {t.appSubtitle}
            </p>
          </div>
        </div>

        {/* Stepper central interactif sur une ligne en desktop */}
        <nav aria-label="Progress" className="hidden lg:flex items-center bg-slate-100/80 p-1 rounded-xl border border-slate-200/80 shrink-0">
          {steps.map((s, idx) => {
            const isActive = wizardStep === s.num;
            const isCompleted = hasResults && wizardStep > s.num;
            return (
              <div key={s.num} className="flex items-center">
                <button
                  type="button"
                  disabled={!s.enabled}
                  onClick={() => s.enabled && onSelectWizardStep(s.num)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                    isActive
                      ? 'bg-white text-indigo-700 shadow-xs border border-slate-200/80 cursor-pointer'
                      : s.enabled
                        ? 'text-slate-600 hover:text-slate-900 hover:bg-white/60 cursor-pointer'
                        : 'text-slate-400 cursor-not-allowed opacity-60'
                  }`}
                >
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                      isActive
                        ? 'bg-indigo-600 text-white'
                        : isCompleted
                          ? 'bg-emerald-600 text-white'
                          : 'bg-slate-200 text-slate-600'
                    }`}
                  >
                    {isCompleted ? <Check className="w-3 h-3" /> : s.num}
                  </span>
                  <span>{s.label}</span>
                </button>
                {idx < steps.length - 1 && (
                  <span className="mx-0.5 text-slate-300 select-none">›</span>
                )}
              </div>
            );
          })}
        </nav>

        {/* Actions sobres à droite : Langue, Historique, Paramètres & API */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setLocale(locale === 'fr' ? 'en' : 'fr')}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold transition-colors cursor-pointer"
          >
            <Globe className="w-3.5 h-3.5 text-slate-500" />
            <span className="uppercase">{locale}</span>
          </button>

          <button
            type="button"
            onClick={onOpenHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
          >
            <History className="w-3.5 h-3.5 text-slate-500" />
            <span className="hidden sm:inline">{t.header.historyBtn}</span>
            {historyCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-700 text-[10px] font-bold">
                {historyCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenAiSettings || onOpenPrerequisites}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5 text-slate-300" />
            <span className="hidden sm:inline">{t.header.settingsBtn}</span>
            <span
              className={`w-2 h-2 rounded-full ${
                isAiOnline ? (isAllConnected ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-rose-400'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Barre d'étapes compacte sur mobile/tablette */}
      <div className="lg:hidden border-t border-slate-100 bg-slate-50 px-3 py-1.5 flex items-center justify-between gap-1 overflow-x-auto">
        {steps.map(s => {
          const isActive = wizardStep === s.num;
          return (
            <button
              key={s.num}
              type="button"
              disabled={!s.enabled}
              onClick={() => s.enabled && onSelectWizardStep(s.num)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap ${
                isActive
                  ? 'bg-indigo-600 text-white'
                  : s.enabled
                    ? 'text-slate-600 hover:bg-white'
                    : 'text-slate-400 opacity-50'
              }`}
            >
              <span>{s.num}.</span>
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
    </header>
  );
}
