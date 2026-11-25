import { useState, useEffect, useRef } from 'react';
import { Settings, RefreshCw, X, Key, ExternalLink, CheckCircle2 } from 'lucide-react';
import {
  getAiConfig,
  saveAiConfig,
  testAiConnectionLive,
  LocalModelStatus,
  AiConfig,
  AiProvider
} from '../services/localAiService';
import { getNcbiApiKey, setNcbiApiKey } from '../services/pubmedApi';
import {
  getHetopCredentials,
  setHetopCredentials,
  clearHetopCredentials,
  isHetopConfigured,
  testHetopConnection
} from '../services/hetopService';
import { useTranslation } from '../i18n';

interface AiSettingsModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onStatusChange?: (status: LocalModelStatus) => void;
}

export default function AiSettingsModal({ isOpen, onClose, onStatusChange }: AiSettingsModalProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<AiConfig>(() => getAiConfig());
  const [ncbiKey, setNcbiKeyInput] = useState<string>(() => getNcbiApiKey() || '');
  const [hetopUser, setHetopUser] = useState<string>(() => getHetopCredentials()?.username || '');
  const [hetopPass, setHetopPass] = useState<string>(() => getHetopCredentials()?.password || '');
  const [hetopStatus, setHetopStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [isCheckingHetop, setIsCheckingHetop] = useState<boolean>(false);

  const [prevIsOpen, setPrevIsOpen] = useState<boolean>(isOpen);
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setConfig({ ...getAiConfig(), routingMode: 'smart' });
      setNcbiKeyInput(getNcbiApiKey() || '');
      const creds = getHetopCredentials();
      setHetopUser(creds?.username || '');
      setHetopPass(creds?.password || '');
      setHetopStatus(null);
      setSavedSuccess(false);
    }
  }

  const handleTestConnection = async (confToTest?: AiConfig) => {
    setIsChecking(true);
    const activeConf: AiConfig = { ...(confToTest || config), routingMode: 'smart' };
    try {
      const res = await testAiConnectionLive(activeConf);
      setStatus(res);
      onStatusChangeRef.current?.(res);
    } finally {
      setIsChecking(false);
    }
  };

  const handleTestHetop = async () => {
    setIsCheckingHetop(true);
    try {
      const res = await testHetopConnection(hetopUser.trim(), hetopPass.trim());
      setHetopStatus({ ok: res.success, message: res.message });
    } finally {
      setIsCheckingHetop(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    const current: AiConfig = { ...getAiConfig(), routingMode: 'smart' };

    const runCheck = async () => {
      setIsChecking(true);
      try {
        const res = await testAiConnectionLive(current);
        if (active) {
          setStatus(res);
          onStatusChangeRef.current?.(res);
        }
      } finally {
        if (active) {
          setIsChecking(false);
        }
      }
    };

    void runCheck();
    return () => {
      active = false;
    };
  }, [isOpen]);

  const handleSave = () => {
    const updated = saveAiConfig({
      ...config,
      routingMode: 'smart'
    });
    setConfig(updated);
    setNcbiApiKey(ncbiKey.trim());
    if (hetopUser.trim() && hetopPass.trim()) {
      setHetopCredentials(hetopUser.trim(), hetopPass.trim());
    } else if (!hetopUser.trim() && !hetopPass.trim()) {
      clearHetopCredentials();
    }
    setSavedSuccess(true);
    void handleTestConnection(updated);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  if (!isOpen) return null;

  const providerTabs: ReadonlyArray<{ readonly id: AiProvider; readonly label: string }> = [
    { id: 'gemini', label: 'Google Gemini' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'anthropic', label: 'Anthropic' }
  ];

  const activeProvider: AiProvider =
    config.provider === 'openai' || config.provider === 'anthropic' ? config.provider : 'gemini';

  const statusText = isChecking
    ? t.settingsModal.testingStatus
    : (status?.message || t.settingsModal.checkingStatus)
        .replace(/^(?:🟢|🟡|🔴|✅|⚠️|\s)+/u, '')
        .trim();

  const isStatusOnline = Boolean(!isChecking && status?.online);
  const isStatusError = Boolean(!isChecking && status && !status.online);
  const hetopConfigured = Boolean((hetopUser.trim() && hetopPass.trim()) || isHetopConfigured());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-xl overflow-hidden shadow-xl flex flex-col max-h-[90vh]">
        {/* En-tête sobre */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-600 shrink-0">
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 leading-tight">
                {t.settingsModal.title}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {t.settingsModal.subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Corps de la modale */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-sm text-slate-700">
          {/* Bandeau d'état discret avec test réel sur les valeurs courantes du formulaire */}
          <div
            className={`px-4 py-3 rounded-xl border flex items-center justify-between gap-3 ${
              isStatusOnline
                ? 'bg-emerald-50/60 border-emerald-200'
                : isStatusError
                  ? 'bg-rose-50/60 border-rose-200'
                  : 'bg-slate-50 border-slate-200'
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  isChecking
                    ? 'bg-indigo-500 animate-pulse'
                    : isStatusOnline
                      ? 'bg-emerald-500'
                      : isStatusError
                        ? 'bg-rose-500'
                        : 'bg-amber-500'
                }`}
              />
              <span
                className={`text-xs font-medium break-words ${
                  isStatusOnline
                    ? 'text-emerald-900'
                    : isStatusError
                      ? 'text-rose-900'
                      : 'text-slate-800'
                }`}
              >
                {statusText}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleTestConnection()}
              disabled={isChecking}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold transition-colors disabled:opacity-60 cursor-pointer shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              <span>
                {isChecking ? t.settingsModal.testingConnectionBtn : t.settingsModal.testConnectionBtn}
              </span>
            </button>
          </div>

          {/* Section 1 : Fournisseur IA */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              {t.settingsModal.sectionProvider}
            </label>
            <div className="grid grid-cols-3 gap-2 p-1 rounded-xl bg-slate-100 border border-slate-200">
              {providerTabs.map((tab) => {
                const isSelected = activeProvider === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      const next: AiConfig = { ...config, provider: tab.id, routingMode: 'smart' };
                      setConfig(next);
                      void handleTestConnection(next);
                    }}
                    className={`py-2 px-3 rounded-lg text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
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
          </div>

          {/* Section 2 : Clé API et modèles (empilés pleine largeur pour zéro troncature) */}
          <div className="p-4 rounded-xl bg-slate-50/70 border border-slate-200 space-y-4">
            <div className="text-xs font-semibold text-slate-800">
              {t.settingsModal.sectionApiAndModels}
            </div>

            {activeProvider === 'gemini' && (
              <>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-slate-700">
                      {t.settingsModal.apiKeyLabelGemini}
                    </label>
                    <a
                      href="https://aistudio.google.com/app/apikey"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
                    >
                      <Key className="w-3 h-3" />
                      <span>{t.settingsModal.getApiKeyLink}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <input
                    type="password"
                    value={config.geminiApiKey}
                    onChange={(e) => setConfig({ ...config, geminiApiKey: e.target.value.trim() })}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    placeholder="AIzaSy..."
                  />
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-slate-700">
                      {t.settingsModal.analysisModelLabel}
                    </label>
                    <select
                      value={config.geminiModel || 'gemini-pro-latest'}
                      onChange={(e) => setConfig({ ...config, geminiModel: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    >
                      <option value="gemini-pro-latest">gemini-pro-latest</option>
                      <option value="gemini-flash-latest">gemini-flash-latest</option>
                      <option value="gemini-flash-lite-latest">gemini-flash-lite-latest</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-slate-700">
                      {t.settingsModal.batchModelLabel}
                    </label>
                    <select
                      value={config.geminiBatchModel || 'gemini-flash-lite-latest'}
                      onChange={(e) => setConfig({ ...config, geminiBatchModel: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    >
                      <option value="gemini-flash-lite-latest">gemini-flash-lite-latest</option>
                      <option value="gemini-flash-latest">gemini-flash-latest</option>
                      <option value="gemini-pro-latest">gemini-pro-latest</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            {activeProvider === 'openai' && (
              <>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-slate-700">
                      {t.settingsModal.apiKeyLabelOpenai}
                    </label>
                    <a
                      href="https://platform.openai.com/api-keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
                    >
                      <Key className="w-3 h-3" />
                      <span>{t.settingsModal.getApiKeyLink}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <input
                    type="password"
                    value={config.openaiApiKey}
                    onChange={(e) => setConfig({ ...config, openaiApiKey: e.target.value.trim() })}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    placeholder="sk-proj-..."
                  />
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-slate-700">
                      {t.settingsModal.analysisModelLabel}
                    </label>
                    <select
                      value={config.openaiModel || 'gpt-4o'}
                      onChange={(e) => setConfig({ ...config, openaiModel: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    >
                      <option value="gpt-4o">gpt-4o</option>
                      <option value="gpt-4o-mini">gpt-4o-mini</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-slate-700">
                      {t.settingsModal.batchModelLabel}
                    </label>
                    <select
                      value={config.openaiBatchModel || 'gpt-4o-mini'}
                      onChange={(e) => setConfig({ ...config, openaiBatchModel: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    >
                      <option value="gpt-4o-mini">gpt-4o-mini</option>
                      <option value="gpt-4o">gpt-4o</option>
                    </select>
                  </div>
                </div>
              </>
            )}

            {activeProvider === 'anthropic' && (
              <>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-slate-700">
                      {t.settingsModal.apiKeyLabelAnthropic}
                    </label>
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
                    >
                      <Key className="w-3 h-3" />
                      <span>{t.settingsModal.getApiKeyLink}</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  <input
                    type="password"
                    value={config.anthropicApiKey}
                    onChange={(e) => setConfig({ ...config, anthropicApiKey: e.target.value.trim() })}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    placeholder="sk-ant-api03-..."
                  />
                </div>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-slate-700">
                      {t.settingsModal.analysisModelLabel}
                    </label>
                    <select
                      value={config.anthropicModel || 'claude-3-5-sonnet-latest'}
                      onChange={(e) => setConfig({ ...config, anthropicModel: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    >
                      <option value="claude-3-5-sonnet-latest">claude-3-5-sonnet-latest</option>
                      <option value="claude-3-5-haiku-latest">claude-3-5-haiku-latest</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-slate-700">
                      {t.settingsModal.batchModelLabel}
                    </label>
                    <select
                      value={config.anthropicBatchModel || 'claude-3-5-haiku-latest'}
                      onChange={(e) => setConfig({ ...config, anthropicBatchModel: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                    >
                      <option value="claude-3-5-haiku-latest">claude-3-5-haiku-latest</option>
                      <option value="claude-3-5-sonnet-latest">claude-3-5-sonnet-latest</option>
                    </select>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Section 3 : Cadencement des lots au dépouillement (valeurs réelles agentScreener.ts) */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              {t.settingsModal.sectionPacing}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setConfig({ ...config, rateLimitMode: 'payg' })}
                className={`px-3 py-2.5 rounded-xl border text-left text-xs font-medium transition-colors cursor-pointer ${
                  config.rateLimitMode !== 'free_tier'
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-900 font-semibold'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {t.settingsModal.pacingPaygLabel}
              </button>
              <button
                type="button"
                onClick={() => setConfig({ ...config, rateLimitMode: 'free_tier' })}
                className={`px-3 py-2.5 rounded-xl border text-left text-xs font-medium transition-colors cursor-pointer ${
                  config.rateLimitMode === 'free_tier'
                    ? 'bg-amber-50 border-amber-300 text-amber-950 font-semibold'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                {t.settingsModal.pacingFreeTierLabel}
              </button>
            </div>
          </div>

          {/* Section 4 : Accès aux bases médicales (optionnels) — NCBI PubMed + HeTOP */}
          <div className="p-4 rounded-xl bg-slate-50/70 border border-slate-200 space-y-4">
            <div className="text-xs font-semibold text-slate-800">
              {t.settingsModal.sectionMedicalBases}
            </div>

            {/* 4a. Clé API NCBI PubMed */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-700">
                  {t.settingsModal.ncbiKeyLabel}
                </label>
                <a
                  href="https://www.ncbi.nlm.nih.gov/account/settings/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
                >
                  <Key className="w-3 h-3" />
                  <span>{t.settingsModal.ncbiKeyLink}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <input
                type="password"
                aria-label={t.settingsModal.ncbiKeyLabel}
                value={ncbiKey}
                onChange={(e) => setNcbiKeyInput(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs font-mono focus:outline-none focus:border-indigo-600"
                placeholder={t.settingsModal.ncbiKeyPlaceholder}
              />
              <p className="text-[11px] text-slate-500">
                {t.settingsModal.ncbiKeyHelp}
              </p>
            </div>

            {/* 4b. Compte HeTOP / CISMeF */}
            <div className="pt-3 border-t border-slate-200 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-700">
                    {t.settingsModal.hetopTitle}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                      hetopStatus
                        ? hetopStatus.ok
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-rose-50 text-rose-700 border border-rose-200'
                        : hetopConfigured
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-slate-100 text-slate-500 border border-slate-200'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        hetopStatus
                          ? hetopStatus.ok
                            ? 'bg-emerald-500'
                            : 'bg-rose-500'
                          : hetopConfigured
                            ? 'bg-emerald-500'
                            : 'bg-slate-400'
                      }`}
                    />
                    <span>
                      {hetopStatus
                        ? hetopStatus.ok
                          ? t.settingsModal.hetopStatusConfigured
                          : t.step2.pubmedUnavailableValue
                        : hetopConfigured
                          ? t.settingsModal.hetopStatusConfigured
                          : t.settingsModal.hetopStatusUnconfigured}
                    </span>
                  </span>
                </div>
                <a
                  href="https://www.hetop.eu/hetop/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline"
                >
                  <span>{t.settingsModal.hetopLink}</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-slate-600">
                    {t.settingsModal.hetopUsernameLabel}
                  </label>
                  <input
                    type="text"
                    value={hetopUser}
                    onChange={(e) => setHetopUser(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs focus:outline-none focus:border-indigo-600"
                    placeholder={t.settingsModal.hetopUsernamePlaceholder}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[11px] font-medium text-slate-600">
                    {t.settingsModal.hetopPasswordLabel}
                  </label>
                  <input
                    type="password"
                    value={hetopPass}
                    onChange={(e) => setHetopPass(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs focus:outline-none focus:border-indigo-600"
                    placeholder={t.settingsModal.hetopPasswordPlaceholder}
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-slate-500">
                  {t.settingsModal.hetopHelp}
                </p>
                <button
                  type="button"
                  disabled={isCheckingHetop || !hetopUser.trim() || !hetopPass.trim()}
                  onClick={() => void handleTestHetop()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-50 text-slate-700 text-[11px] font-semibold cursor-pointer shrink-0"
                >
                  <RefreshCw className={`w-3 h-3 ${isCheckingHetop ? 'animate-spin' : ''}`} />
                  <span>{t.settingsModal.hetopTestBtn}</span>
                </button>
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
        </div>

        {/* Pied de modale */}
        <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50/70 flex items-center justify-between gap-3">
          <div className="text-xs text-slate-500 flex items-center gap-1.5">
            {savedSuccess ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span className="font-semibold text-emerald-700">
                  {t.settingsModal.footerSavedFeedback}
                </span>
              </>
            ) : (
              <span>{t.settingsModal.footerLocalNote}</span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold transition-colors cursor-pointer"
            >
              {t.settingsModal.closeBtn}
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
            >
              {t.settingsModal.saveBtn}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
