import { useState, useEffect } from 'react';
import {
  Stethoscope,
  Key,
  Database,
  ExternalLink,
  RefreshCw,
  ArrowRight,
  CheckCircle2,
  XCircle
} from 'lucide-react';
import { getNcbiApiKey, setNcbiApiKey } from '../services/pubmedApi';
import {
  getHetopCredentials,
  setHetopCredentials,
  clearHetopCredentials,
  testHetopConnection
} from '../services/hetopService';
import {
  getAiConfig,
  saveAiConfig,
  testAiConnectionLive,
  canUnlockPrerequisitesModal,
  LiveAiConnectionResult,
  AiProvider,
  AiConfig
} from '../services/localAiService';
import { useTranslation } from '../i18n';

interface PrerequisitesModalProps {
  readonly isOpen: boolean;
  readonly onSuccess: () => void;
}

export default function PrerequisitesModal({ isOpen, onSuccess }: PrerequisitesModalProps) {
  const { t } = useTranslation();
  const [initialConf] = useState<AiConfig>(() => getAiConfig());
  const [aiProvider, setAiProvider] = useState<'gemini' | 'openai' | 'anthropic'>(() =>
    initialConf.provider === 'openai' || initialConf.provider === 'anthropic' ? initialConf.provider : 'gemini'
  );
  const [geminiKey, setGeminiKey] = useState<string>(() => initialConf.geminiApiKey || '');
  const [openaiKey, setOpenaiKey] = useState<string>(() => initialConf.openaiApiKey || '');
  const [anthropicKey, setAnthropicKey] = useState<string>(() => initialConf.anthropicApiKey || '');

  const [aiStatus, setAiStatus] = useState<LiveAiConnectionResult | null>(null);
  const [isTestingAi, setIsTestingAi] = useState<boolean>(false);

  const [ncbiKey, setNcbiKeyState] = useState<string>(() => getNcbiApiKey() || '');
  const [hetopUser, setHetopUser] = useState<string>(() => getHetopCredentials()?.username || '');
  const [hetopPass, setHetopPass] = useState<string>(() => getHetopCredentials()?.password || '');
  const [hetopStatus, setHetopStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [isTestingHetop, setIsTestingHetop] = useState<boolean>(false);

  const [prevIsOpen, setPrevIsOpen] = useState<boolean>(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      const conf = getAiConfig();
      const prov: 'gemini' | 'openai' | 'anthropic' =
        conf.provider === 'openai' || conf.provider === 'anthropic' ? conf.provider : 'gemini';
      setAiProvider(prov);
      setGeminiKey(conf.geminiApiKey || '');
      setOpenaiKey(conf.openaiApiKey || '');
      setAnthropicKey(conf.anthropicApiKey || '');
      setNcbiKeyState(getNcbiApiKey() || '');
      const creds = getHetopCredentials();
      setHetopUser(creds?.username || '');
      setHetopPass(creds?.password || '');
      setAiStatus(null);
      setHetopStatus(null);
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const conf = getAiConfig();
    const prov: AiProvider =
      conf.provider === 'openai' || conf.provider === 'anthropic' ? conf.provider : 'gemini';
    const keyForProv =
      prov === 'gemini' ? conf.geminiApiKey : prov === 'openai' ? conf.openaiApiKey : conf.anthropicApiKey;

    if (!keyForProv || keyForProv.trim().length < 10) return;

    const autoCheck = async () => {
      setIsTestingAi(true);
      try {
        const res = await testAiConnectionLive({
          ...conf,
          provider: prov,
          routingMode: 'smart'
        });
        if (active) setAiStatus(res);
      } finally {
        if (active) setIsTestingAi(false);
      }
    };
    void autoCheck();
    return () => {
      active = false;
    };
  }, [isOpen]);

  const activeKey =
    aiProvider === 'gemini'
      ? geminiKey
      : aiProvider === 'openai'
        ? openaiKey
        : anthropicKey;

  const handleTestAiConnection = async (overrideProvider?: 'gemini' | 'openai' | 'anthropic') => {
    const prov = overrideProvider || aiProvider;
    setIsTestingAi(true);
    try {
      const res = await testAiConnectionLive({
        ...getAiConfig(),
        provider: prov,
        geminiApiKey: geminiKey.trim(),
        openaiApiKey: openaiKey.trim(),
        anthropicApiKey: anthropicKey.trim(),
        routingMode: 'smart'
      });
      setAiStatus(res);
    } finally {
      setIsTestingAi(false);
    }
  };

  const handleTestHetop = async () => {
    setIsTestingHetop(true);
    try {
      const res = await testHetopConnection(hetopUser.trim(), hetopPass.trim());
      setHetopStatus({ ok: res.success, message: res.message });
    } finally {
      setIsTestingHetop(false);
    }
  };

  const canEnterStudio = canUnlockPrerequisitesModal({
    activeKey,
    testedStatus: aiStatus
  });

  const handleSaveAndEnter = () => {
    if (!canEnterStudio) return;

    saveAiConfig({
      provider: aiProvider,
      geminiApiKey: geminiKey.trim(),
      openaiApiKey: openaiKey.trim(),
      anthropicApiKey: anthropicKey.trim(),
      routingMode: 'smart'
    });
    setNcbiApiKey(ncbiKey.trim());

    if (hetopUser.trim() && hetopPass.trim()) {
      setHetopCredentials(hetopUser.trim(), hetopPass.trim());
    } else if (!hetopUser.trim() && !hetopPass.trim()) {
      clearHetopCredentials();
    }

    onSuccess();
  };

  if (!isOpen) return null;

  const providerTabs: ReadonlyArray<{
    readonly id: 'gemini' | 'openai' | 'anthropic';
    readonly label: string;
    readonly portalUrl: string;
    readonly portalLabel: string;
    readonly placeholder: string;
  }> = [
    {
      id: 'gemini',
      label: 'Google Gemini',
      portalUrl: 'https://aistudio.google.com/app/apikey',
      portalLabel: t.prerequisitesModal.aiPortalGemini,
      placeholder: t.prerequisitesModal.aiKeyPlaceholderGemini
    },
    {
      id: 'openai',
      label: 'OpenAI',
      portalUrl: 'https://platform.openai.com/api-keys',
      portalLabel: t.prerequisitesModal.aiPortalOpenai,
      placeholder: t.prerequisitesModal.aiKeyPlaceholderOpenai
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      portalUrl: 'https://console.anthropic.com/settings/keys',
      portalLabel: t.prerequisitesModal.aiPortalAnthropic,
      placeholder: t.prerequisitesModal.aiKeyPlaceholderAnthropic
    }
  ];

  const activeTabMeta = providerTabs.find(tab => tab.id === aiProvider) || providerTabs[0];
  const hasNcbiInput = ncbiKey.trim().length >= 8;
  const hasHetopInput = Boolean(hetopUser.trim() && hetopPass.trim());

  const updateActiveKey = (val: string) => {
    setAiStatus(null);
    if (aiProvider === 'gemini') setGeminiKey(val);
    else if (aiProvider === 'openai') setOpenaiKey(val);
    else setAnthropicKey(val);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-50/95 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-2xl overflow-hidden shadow-xl flex flex-col max-h-[92vh]">
        {/* En-tête sobre thème clair */}
        <div className="px-6 py-5 border-b border-slate-200 bg-slate-50/70 flex items-start gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shrink-0 shadow-2xs">
            <Stethoscope className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 tracking-tight">
              {t.prerequisitesModal.title}
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              {t.prerequisitesModal.subtitle}
            </p>
          </div>
        </div>

        {/* Corps : 3 blocs clairs (IA requis, NCBI optionnel, HeTOP optionnel) */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1 text-xs text-slate-700">
          {/* Bloc 1 : Fournisseur IA (Requis) */}
          <div className="p-4 rounded-xl bg-white border border-slate-200 space-y-3.5 shadow-2xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-900">
                  {t.prerequisitesModal.aiBlockTitle}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-semibold">
                  {t.prerequisitesModal.badgeRequired}
                </span>
              </div>

              <a
                href={activeTabMeta.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
              >
                <span>{activeTabMeta.portalLabel}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-slate-100 border border-slate-200">
              {providerTabs.map((tab) => {
                const isSelected = aiProvider === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setAiProvider(tab.id);
                      setAiStatus(null);
                    }}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-white text-indigo-700 shadow-2xs border border-slate-200/80'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                type="password"
                value={activeKey}
                onChange={(e) => updateActiveKey(e.target.value)}
                placeholder={activeTabMeta.placeholder}
                className="flex-1 px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 font-mono text-xs focus:outline-none focus:border-indigo-600"
              />
              <button
                type="button"
                disabled={isTestingAi || activeKey.trim().length < 10}
                onClick={() => void handleTestAiConnection()}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-50 text-slate-700 text-xs font-semibold cursor-pointer shrink-0 transition-colors"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isTestingAi ? 'animate-spin' : ''}`} />
                <span>
                  {isTestingAi ? t.prerequisitesModal.testingAiBtn : t.prerequisitesModal.testAiBtn}
                </span>
              </button>
            </div>

            {aiStatus ? (
              <div
                className={`px-3 py-2 rounded-lg border flex items-center gap-2 text-xs font-medium ${
                  aiStatus.online
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-rose-50 border-rose-200 text-rose-800'
                }`}
              >
                {aiStatus.online ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                )}
                <span>{aiStatus.message}</span>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500">
                {activeKey.trim().length >= 10
                  ? t.prerequisitesModal.aiStatusReadyHint
                  : t.prerequisitesModal.aiStatusMissingHint}
              </p>
            )}
          </div>

          {/* Bloc 2 : Clé API NCBI PubMed (Optionnel) */}
          <div className="p-4 rounded-xl bg-slate-50/70 border border-slate-200 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Key className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-bold text-slate-800">
                  {t.prerequisitesModal.ncbiBlockTitle}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-[10px] font-semibold">
                  {t.prerequisitesModal.badgeOptional}
                </span>
                {hasNcbiInput && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold">
                    {t.prerequisitesModal.ncbiStatusConfigured}
                  </span>
                )}
              </div>

              <a
                href="https://account.ncbi.nlm.nih.gov/settings/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
              >
                <span>{t.prerequisitesModal.ncbiPortalLink}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <input
              type="password"
              value={ncbiKey}
              onChange={(e) => setNcbiKeyState(e.target.value)}
              placeholder={t.prerequisitesModal.ncbiPlaceholder}
              className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 font-mono text-xs focus:outline-none focus:border-indigo-600"
            />

            <p className="text-[11px] text-slate-500 leading-relaxed">
              {t.prerequisitesModal.ncbiHelp}
            </p>
          </div>

          {/* Bloc 3 : Identifiants HeTOP / CISMeF (Optionnel) */}
          <div className="p-4 rounded-xl bg-slate-50/70 border border-slate-200 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-bold text-slate-800">
                  {t.prerequisitesModal.hetopBlockTitle}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-[10px] font-semibold">
                  {t.prerequisitesModal.badgeOptional}
                </span>
                {hasHetopInput && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold">
                    {t.prerequisitesModal.hetopStatusConfigured}
                  </span>
                )}
              </div>

              <a
                href="https://www.hetop.eu/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
              >
                <span>{t.prerequisitesModal.hetopPortalLink}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div className="space-y-1">
                <label className="block text-[11px] font-medium text-slate-600">
                  {t.prerequisitesModal.hetopUsernameLabel}
                </label>
                <input
                  type="text"
                  value={hetopUser}
                  onChange={(e) => {
                    setHetopUser(e.target.value);
                    setHetopStatus(null);
                  }}
                  placeholder={t.prerequisitesModal.hetopUsernamePlaceholder}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs focus:outline-none focus:border-indigo-600"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-[11px] font-medium text-slate-600">
                  {t.prerequisitesModal.hetopPasswordLabel}
                </label>
                <input
                  type="password"
                  value={hetopPass}
                  onChange={(e) => {
                    setHetopPass(e.target.value);
                    setHetopStatus(null);
                  }}
                  placeholder={t.prerequisitesModal.hetopPasswordPlaceholder}
                  className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs focus:outline-none focus:border-indigo-600"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-slate-500 flex-1 min-w-[200px]">
                {t.prerequisitesModal.hetopHelp}
              </p>
              {hasHetopInput && (
                <button
                  type="button"
                  disabled={isTestingHetop}
                  onClick={() => void handleTestHetop()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-50 text-slate-700 text-[11px] font-semibold cursor-pointer shrink-0"
                >
                  <RefreshCw className={`w-3 h-3 ${isTestingHetop ? 'animate-spin' : ''}`} />
                  <span>
                    {isTestingHetop ? t.prerequisitesModal.hetopTestingBtn : t.prerequisitesModal.hetopTestBtn}
                  </span>
                </button>
              )}
            </div>

            {hetopStatus && (
              <p
                className={`text-[11px] font-medium ${
                  hetopStatus.ok ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                {hetopStatus.message}
              </p>
            )}
          </div>
        </div>

        {/* Pied de modale */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <span className="text-[11px] text-slate-500">
            {canEnterStudio
              ? t.prerequisitesModal.footerHintReady
              : t.prerequisitesModal.footerHintMissingAi}
          </span>

          <button
            type="button"
            disabled={!canEnterStudio}
            onClick={handleSaveAndEnter}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-semibold shadow-2xs transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
          >
            <span>{t.prerequisitesModal.enterStudioBtn}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
