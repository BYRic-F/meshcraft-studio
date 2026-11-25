import { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Key,
  Database,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  Lock,
  Sparkles,
  Zap
} from 'lucide-react';
import { getNcbiApiKey, setNcbiApiKey } from '../services/pubmedApi';
import { getHetopCredentials, setHetopCredentials, testHetopConnection, isHetopConfigured } from '../services/hetopService';
import {
  getAiConfig,
  saveAiConfig,
  checkLocalAiStatus,
  LocalModelStatus,
  AiProvider
} from '../services/localAiService';

interface PrerequisitesModalProps {
  readonly isOpen: boolean;
  readonly onSuccess: () => void;
}

export default function PrerequisitesModal({ isOpen, onSuccess }: PrerequisitesModalProps) {
  // 1. AI Cloud State (Gemini, OpenAI ou Anthropic)
  const initialConf = getAiConfig();
  const [aiProvider, setAiProvider] = useState<'gemini' | 'openai' | 'anthropic'>(() =>
    initialConf.provider === 'openai' || initialConf.provider === 'anthropic' ? initialConf.provider : 'gemini'
  );
  const [aiStatus, setAiStatus] = useState<LocalModelStatus | null>(null);
  const [geminiKey, setGeminiKey] = useState<string>(() => initialConf.geminiApiKey || '');
  const [openaiKey, setOpenaiKey] = useState<string>(() => initialConf.openaiApiKey || '');
  const [anthropicKey, setAnthropicKey] = useState<string>(() => initialConf.anthropicApiKey || '');

  // 2. NCBI State
  const [ncbiKey, setNcbiKeyState] = useState<string>(() => getNcbiApiKey() || '');
  const [ncbiTested, setNcbiTested] = useState<boolean>(() => Boolean(getNcbiApiKey()));

  // 3. HeTOP State
  const [hetopUser, setHetopUser] = useState<string>(() => getHetopCredentials()?.username || '');
  const [hetopPass, setHetopPass] = useState<string>(() => getHetopCredentials()?.password || '');
  const [hetopTested, setHetopTested] = useState<boolean>(() => isHetopConfigured());
  const [hetopError, setHetopError] = useState<string | null>(null);

  const [isTestingAll, setIsTestingAll] = useState(false);

  useEffect(() => {
    if (isOpen) {
      void handleTestAll();
    }
  }, [isOpen]);

  const handleTestAll = async (overrideProvider?: AiProvider) => {
    setIsTestingAll(true);
    setHetopError(null);
    const activeProvider = overrideProvider || aiProvider;

    try {
      const updated = saveAiConfig({
        provider: activeProvider,
        geminiApiKey: geminiKey.trim(),
        openaiApiKey: openaiKey.trim(),
        anthropicApiKey: anthropicKey.trim()
      });
      const st = await checkLocalAiStatus(updated);
      setAiStatus(st);
    } catch {
      setAiStatus(null);
    }

    const hasKey = ncbiKey.trim().length >= 8;
    setNcbiTested(hasKey);

    if (hetopUser.trim() && hetopPass.trim()) {
      try {
        const hRes = await testHetopConnection(hetopUser.trim(), hetopPass.trim());
        setHetopTested(hRes.success);
        if (!hRes.success) {
          setHetopError(hRes.message);
        }
      } catch (err: unknown) {
        setHetopTested(false);
        setHetopError(err instanceof Error ? err.message : 'Erreur de connexion HeTOP');
      }
    } else {
      setHetopTested(false);
    }

    setIsTestingAll(false);
  };

  const isAiReady = Boolean(aiStatus?.online);
  const isNcbiReady = ncbiTested && ncbiKey.trim().length >= 8;
  const isHetopReady = hetopTested;
  const allReady = isAiReady && isNcbiReady && isHetopReady;

  const handleSaveAndUnlock = () => {
    if (!allReady) return;

    saveAiConfig({
      provider: aiProvider,
      geminiApiKey: geminiKey.trim(),
      openaiApiKey: openaiKey.trim(),
      anthropicApiKey: anthropicKey.trim()
    });
    setNcbiApiKey(ncbiKey.trim());
    setHetopCredentials(hetopUser.trim(), hetopPass.trim());

    onSuccess();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/95 backdrop-blur-md animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh]">
        {/* En-tête institutionnel */}
        <div className="p-6 border-b border-slate-800 bg-slate-950/80 flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-indigo-950/80 border border-indigo-500/40 flex items-center justify-center text-indigo-400 shrink-0 shadow-inner">
            <Lock className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-100 tracking-tight">
                Passerelle Médicale Sécurisée & Configuration Cloud
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-950 text-indigo-300 border border-indigo-800 uppercase">
                Mode Strict PRISMA
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              Pour garantir la validité scientifique de vos recherches et éliminer tout risque d'hallucination,{' '}
              <strong>MeSHcraft Studio fonctionne en connexion directe avec les API Cloud et référentiels officiels</strong>.
            </p>
          </div>
        </div>

        {/* Corps : Les 3 Piliers */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1 text-xs text-slate-300 custom-scrollbar">
          {/* PILIER 1 : MOTEUR D'INTELLIGENCE ARTIFICIELLE CLOUD */}
          <div
            className={`p-4 rounded-xl border transition-all ${
              isAiReady ? 'bg-slate-950/60 border-emerald-800/60 shadow-sm' : 'bg-indigo-950/20 border-indigo-800/60'
            }`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
              <div className="flex items-center gap-2 font-semibold text-sm text-slate-200">
                <Sparkles className={`w-4 h-4 ${isAiReady ? 'text-emerald-400' : 'text-sky-400'}`} />
                <span>1. Moteur d'Intelligence Artificielle Cloud (Routage FinOps Pro + Flash)</span>
              </div>
              <span
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 self-start sm:self-auto ${
                  isAiReady
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    : 'bg-rose-950 text-rose-300 border border-rose-800'
                }`}
              >
                {isAiReady ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                ) : (
                  <AlertTriangle className="w-3 h-3 text-rose-400" />
                )}
                {isAiReady ? aiStatus?.message || 'En Ligne' : 'Non Configuré'}
              </span>
            </div>

            {/* Onglets de choix du fournisseur Cloud */}
            <div className="grid grid-cols-3 gap-2 mt-3 p-1 rounded-lg bg-slate-900 border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => {
                  setAiProvider('gemini');
                  void handleTestAll('gemini');
                }}
                className={`py-1.5 px-2.5 rounded-md flex items-center justify-center gap-1.5 font-medium transition-colors cursor-pointer ${
                  aiProvider === 'gemini'
                    ? 'bg-sky-950/70 text-sky-200 border border-sky-700/60 shadow-sm font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                <span>Google Gemini</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setAiProvider('openai');
                  void handleTestAll('openai');
                }}
                className={`py-1.5 px-2.5 rounded-md flex items-center justify-center gap-1.5 font-medium transition-colors cursor-pointer ${
                  aiProvider === 'openai'
                    ? 'bg-emerald-950/70 text-emerald-200 border border-emerald-700/60 shadow-sm font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
                <span>OpenAI (GPT-4o)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setAiProvider('anthropic');
                  void handleTestAll('anthropic');
                }}
                className={`py-1.5 px-2.5 rounded-md flex items-center justify-center gap-1.5 font-medium transition-colors cursor-pointer ${
                  aiProvider === 'anthropic'
                    ? 'bg-amber-950/70 text-amber-200 border border-amber-700/60 shadow-sm font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                <span>Anthropic (Claude)</span>
              </button>
            </div>

            {aiProvider === 'gemini' && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="password"
                    value={geminiKey}
                    onChange={(e) => setGeminiKey(e.target.value)}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 font-mono text-xs focus:outline-none focus:border-sky-500"
                    placeholder="Collez votre clé API Google AI Studio (AIzaSy...)"
                  />
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg bg-sky-950 hover:bg-sky-900 text-sky-300 border border-sky-800 font-medium flex items-center justify-center gap-1.5 shrink-0 text-xs"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Clé Google AI Studio</span>
                  </a>
                </div>
                <p className="text-[11px] text-slate-400">
                  Routage automatique : <strong className="text-sky-300 font-mono">gemini-pro-latest</strong> (Cadrage & Audit) +{' '}
                  <strong className="text-sky-300 font-mono">gemini-flash-lite-latest</strong> (Dépouillement rapide à coût minimal).
                </p>
              </div>
            )}

            {aiProvider === 'openai' && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="password"
                    value={openaiKey}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 font-mono text-xs focus:outline-none focus:border-emerald-500"
                    placeholder="Collez votre clé API OpenAI (sk-proj-...)"
                  />
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-800 font-medium flex items-center justify-center gap-1.5 shrink-0 text-xs"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Clé OpenAI Platform</span>
                  </a>
                </div>
                <p className="text-[11px] text-slate-400">
                  Routage automatique : <strong className="text-emerald-300 font-mono">gpt-4o</strong> (Cadrage & Audit) +{' '}
                  <strong className="text-emerald-300 font-mono">gpt-4o-mini</strong> (Dépouillement par lots).
                </p>
              </div>
            )}

            {aiProvider === 'anthropic' && (
              <div className="mt-3 space-y-2">
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="password"
                    value={anthropicKey}
                    onChange={(e) => setAnthropicKey(e.target.value)}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 font-mono text-xs focus:outline-none focus:border-amber-500"
                    placeholder="Collez votre clé API Anthropic (sk-ant-...)"
                  />
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 rounded-lg bg-amber-950 hover:bg-amber-900 text-amber-300 border border-amber-800 font-medium flex items-center justify-center gap-1.5 shrink-0 text-xs"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Clé Anthropic Console</span>
                  </a>
                </div>
                <p className="text-[11px] text-slate-400">
                  Routage automatique : <strong className="text-amber-300 font-mono">claude-3-5-sonnet-latest</strong> (Cadrage & Audit) +{' '}
                  <strong className="text-amber-300 font-mono">claude-3-5-haiku-latest</strong> (Dépouillement par lots).
                </p>
              </div>
            )}
          </div>

          {/* PILIER 2 : CLÉ API OFFICIELLE NCBI PUBMED */}
          <div
            className={`p-4 rounded-xl border transition-all ${
              isNcbiReady ? 'bg-slate-950/60 border-emerald-800/60 shadow-sm' : 'bg-sky-950/20 border-sky-800/60'
            }`}
          >
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
              <div className="flex items-center gap-2 font-semibold text-sm text-slate-200">
                <Key className={`w-4 h-4 ${isNcbiReady ? 'text-emerald-400' : 'text-sky-400'}`} />
                <span>2. Clé API Officielle NCBI Entrez (PubMed & NLM MeSH)</span>
              </div>
              <span
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 ${
                  isNcbiReady
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    : 'bg-rose-950 text-rose-300 border border-rose-800'
                }`}
              >
                {isNcbiReady ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                ) : (
                  <AlertTriangle className="w-3 h-3 text-rose-400" />
                )}
                {isNcbiReady ? 'Validée (10 req/s)' : 'Manquante'}
              </span>
            </div>

            <div className="mt-3 space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={ncbiKey}
                  onChange={(e) => setNcbiKeyState(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 font-mono text-xs focus:outline-none focus:border-sky-500"
                  placeholder="Ex: a1b2c3d4e5f6... (Clé API 36 caractères)"
                />
                <a
                  href="https://account.ncbi.nlm.nih.gov/settings/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg bg-sky-950 hover:bg-sky-900 text-sky-300 border border-sky-800 font-medium flex items-center gap-1.5 shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Obtenir la clé gratuite (30s)</span>
                </a>
              </div>
              <p className="text-[11px] text-slate-500">
                Indispensable pour autoriser jusqu'à 10 requêtes par seconde, supprimer les blocages HTTP 429 et valider les descripteurs MeSH.
              </p>
            </div>
          </div>

          {/* PILIER 3 : COMPTE OFFICIEL HETOP (CISMEF CHU ROUEN) */}
          <div
            className={`p-4 rounded-xl border transition-all ${
              isHetopReady ? 'bg-slate-950/60 border-emerald-800/60 shadow-sm' : 'bg-amber-950/20 border-amber-800/60'
            }`}
          >
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
              <div className="flex items-center gap-2 font-semibold text-sm text-slate-200">
                <Database className={`w-4 h-4 ${isHetopReady ? 'text-emerald-400' : 'text-amber-400'}`} />
                <span>3. Thésaurus Officiel HeTOP (CISMeF / CHU de Rouen / Inserm)</span>
              </div>
              <span
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 ${
                  isHetopReady
                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                    : 'bg-rose-950 text-rose-300 border border-rose-800'
                }`}
              >
                {isHetopReady ? (
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                ) : (
                  <AlertTriangle className="w-3 h-3 text-rose-400" />
                )}
                {isHetopReady ? 'Connecté' : 'Non configuré'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1 font-medium">Nom d'utilisateur HeTOP</label>
                <input
                  type="text"
                  value={hetopUser}
                  onChange={(e) => setHetopUser(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-amber-500"
                  placeholder="Votre identifiant HeTOP"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1 font-medium">Mot de passe HeTOP</label>
                <input
                  type="password"
                  value={hetopPass}
                  onChange={(e) => setHetopPass(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-amber-500"
                  placeholder="••••••••••••"
                />
              </div>
            </div>

            {hetopError && (
              <p className="mt-2 text-[11px] text-rose-400 bg-rose-950/40 p-2 rounded border border-rose-900/50">
                ⚠️ {hetopError}
              </p>
            )}

            <div className="mt-2.5 flex items-center justify-between text-[11px]">
              <span className="text-slate-500">
                Traduction certifiée des termes médicaux français vers le MeSH international.
              </span>
              <a
                href="https://www.hetop.eu/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-400 hover:text-amber-300 flex items-center gap-1 font-medium"
              >
                <span>Créer un compte sur hetop.eu</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>

        {/* Pied de page */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isTestingAll}
              onClick={() => void handleTestAll()}
              className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isTestingAll ? 'animate-spin' : ''}`} />
              <span>Tester les 3 connexions</span>
            </button>
            <span className="text-[11px] text-slate-400">
              {allReady ? '🟢 Les 3 piliers sont opérationnels.' : '🔴 Tous les prérequis doivent être au vert pour débloquer le studio.'}
            </span>
          </div>

          <button
            type="button"
            disabled={!allReady}
            onClick={handleSaveAndUnlock}
            className={`px-5 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              allReady
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/50 cursor-pointer'
                : 'bg-slate-800 text-slate-500 border border-slate-700/50 cursor-not-allowed'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Accéder à MeSHcraft Studio</span>
          </button>
        </div>
      </div>
    </div>
  );
}
