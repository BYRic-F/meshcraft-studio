/**
 * Service d'Intelligence Artificielle Cloud Multi-Fournisseurs pour MeSHcraft Studio
 *
 * Supporte :
 * 1. Google Gemini Cloud (gemini-pro-latest + gemini-flash-latest + gemini-flash-lite-latest)
 * 2. OpenAI Cloud (gpt-4o + gpt-4o-mini)
 * 3. Anthropic Claude Cloud (claude-3-5-sonnet-latest + claude-3-5-haiku-latest)
 * 4. Routage Intelligent par Tâche (Smart Routing : Pro/Sonnet/GPT-4o pour Raisonnement/Audit, Flash/Mini/Haiku pour Dépouillement)
 * 5. Optimisations : Compression des résumés, Cache d'idempotence (PMID + PICO) et Traitement par lots
 */

import {
  AuditObservationEntry,
  AuditObservationItem,
  CritiqueReport,
  StratifiedTitleSample,
  extractInnLikeTokens,
  normalizeAuditObservations,
  stripLeadingObservationEmojis
} from './rustEngineService';

export type AiProvider = 'gemini' | 'openai' | 'anthropic';
export type AiRoutingMode = 'smart' | 'pro_only' | 'economy';
export type AiTaskTier = 'reasoning' | 'batch' | 'fast';
export type AiRateLimitMode = 'payg' | 'free_tier';

export interface AiConfig {
  provider: AiProvider;
  routingMode: AiRoutingMode;
  rateLimitMode: AiRateLimitMode;
  geminiApiKey: string;
  geminiModel: string;
  geminiBatchModel: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiBatchModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicBatchModel: string;
}

export const GEMINI_FALLBACK_MODELS: readonly string[] = [
  'gemini-pro-latest',
  'gemini-flash-lite-latest',
  'gemini-flash-latest'
];

export const OPENAI_MODELS: readonly string[] = [
  'gpt-4o',
  'gpt-4o-mini'
];

export const ANTHROPIC_MODELS: readonly string[] = [
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest'
];

const DEFAULT_CONFIG: AiConfig = {
  provider: 'gemini',
  routingMode: 'smart',
  rateLimitMode: 'payg',
  geminiApiKey: '',
  geminiModel: 'gemini-pro-latest',
  geminiBatchModel: 'gemini-flash-lite-latest',
  openaiApiKey: '',
  openaiModel: 'gpt-4o',
  openaiBatchModel: 'gpt-4o-mini',
  anthropicApiKey: '',
  anthropicModel: 'claude-3-5-sonnet-latest',
  anthropicBatchModel: 'claude-3-5-haiku-latest'
};

const CONFIG_STORAGE_KEY = 'meshcraft_ai_config';

export function cleanApiKey(key?: string): string {
  if (!key) return '';
  return key.trim().replace(/^["']|["']$/g, '').trim();
}

export function normalizeGeminiModel(model?: string, tier: AiTaskTier = 'reasoning'): string {
  if (!model) {
    return tier === 'batch' ? 'gemini-flash-lite-latest' : 'gemini-pro-latest';
  }
  const trimmed = model.trim().replace(/^models\//, '');
  if (trimmed === 'gemini-1.5-pro' || trimmed === 'gemini-1.5-pro-latest') {
    return 'gemini-pro-latest';
  }
  if (
    trimmed === 'gemini-3.5-flash-lite' ||
    trimmed === 'gemini-1.5-flash-8b' ||
    trimmed === 'gemini-2.5-flash-lite'
  ) {
    return 'gemini-flash-lite-latest';
  }
  if (
    trimmed === 'gemini-1.5-flash' ||
    trimmed === 'gemini-1.5-flash-latest' ||
    trimmed === 'gemini-2.0-flash' ||
    trimmed === 'gemini-2.5-flash' ||
    trimmed === 'gemini-3.8-flash'
  ) {
    return tier === 'batch' ? 'gemini-flash-lite-latest' : 'gemini-flash-latest';
  }
  return trimmed;
}

function normalizeProvider(rawProvider?: string): AiProvider {
  if (rawProvider === 'openai' || rawProvider === 'anthropic') {
    return rawProvider;
  }
  return 'gemini';
}

/**
 * Sélectionne automatiquement le modèle optimal selon la criticité cognitive de la tâche (Smart Routing) :
 * - 'reasoning' (Audit PRESS) -> Modèle Pro / Sonnet / GPT-4o
 * - 'fast' (Structuration PICO/PECO) -> Modèle Flash / Mini / Haiku
 * - 'batch' (Screening massif Titre/Résumé & RoB 2) -> Modèle Flash-Lite / Mini / Haiku
 */
export function resolveActiveModelForTask(config: AiConfig, taskTier: AiTaskTier = 'reasoning'): string {
  const effectiveTier: AiTaskTier =
    config.routingMode === 'pro_only'
      ? 'reasoning'
      : config.routingMode === 'economy'
        ? 'batch'
        : taskTier;

  if (config.provider === 'openai') {
    return effectiveTier === 'reasoning'
      ? (config.openaiModel || 'gpt-4o')
      : (config.openaiBatchModel || 'gpt-4o-mini');
  }

  if (config.provider === 'anthropic') {
    return effectiveTier === 'reasoning'
      ? (config.anthropicModel || 'claude-3-5-sonnet-latest')
      : (config.anthropicBatchModel || 'claude-3-5-haiku-latest');
  }

  if (effectiveTier === 'reasoning') {
    return normalizeGeminiModel(config.geminiModel || 'gemini-pro-latest', 'reasoning');
  }
  if (effectiveTier === 'fast') {
    return 'gemini-flash-latest';
  }
  return normalizeGeminiModel(config.geminiBatchModel || 'gemini-flash-lite-latest', 'batch');
}

export function getActiveProviderLabel(config?: AiConfig, taskTier: AiTaskTier = 'reasoning'): string {
  const active = config || getAiConfig();
  const modelName = resolveActiveModelForTask(active, taskTier);
  if (active.provider === 'openai') {
    return `OpenAI (${modelName})`;
  }
  if (active.provider === 'anthropic') {
    return `Anthropic Claude (${modelName})`;
  }
  return `Google Gemini (${modelName})`;
}

let geminiDiscoveredModelsCache: { models: string[]; timestamp: number } | null = null;

export async function fetchDiscoveredGeminiModels(apiKey: string): Promise<string[]> {
  const cleanKey = cleanApiKey(apiKey);
  if (!cleanKey || cleanKey.length < 10) return [];

  const now = Date.now();
  if (geminiDiscoveredModelsCache && (now - geminiDiscoveredModelsCache.timestamp < 120000)) {
    return geminiDiscoveredModelsCache.models;
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`, {
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const rawModels: Array<{ name?: string; supportedGenerationMethods?: string[] }> = Array.isArray(data?.models)
        ? data.models
        : [];
      const models: string[] = rawModels
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => (m.name || '').replace(/^models\//, ''))
        .filter((n: string) => {
          const lower = n.toLowerCase();
          return (
            lower.includes('gemini') &&
            !lower.includes('embedding') &&
            !lower.includes('tts') &&
            !lower.includes('live') &&
            !lower.includes('transcribe') &&
            !lower.includes('robotics') &&
            !lower.includes('banana') &&
            !lower.includes('omni') &&
            !lower.includes('vision')
          );
        });

      if (models.length > 0) {
        models.sort((a, b) => {
          const idxA = GEMINI_FALLBACK_MODELS.indexOf(a);
          const idxB = GEMINI_FALLBACK_MODELS.indexOf(b);
          if (idxA !== -1 && idxB !== -1) return idxA - idxB;
          if (idxA !== -1) return -1;
          if (idxB !== -1) return 1;
          if (a.endsWith('-latest') && !b.endsWith('-latest')) return -1;
          if (b.endsWith('-latest') && !a.endsWith('-latest')) return 1;
          return b.localeCompare(a);
        });

        geminiDiscoveredModelsCache = { models, timestamp: now };
        return models;
      }
    }
  } catch {}

  return [...GEMINI_FALLBACK_MODELS];
}

export function getAiConfig(): AiConfig {
  try {
    const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Record<string, unknown>;
      return {
        ...DEFAULT_CONFIG,
        provider: normalizeProvider(typeof parsed.provider === 'string' ? parsed.provider : undefined),
        routingMode:
          parsed.routingMode === 'pro_only' || parsed.routingMode === 'economy' || parsed.routingMode === 'smart'
            ? parsed.routingMode
            : DEFAULT_CONFIG.routingMode,
        rateLimitMode:
          parsed.rateLimitMode === 'free_tier' || parsed.rateLimitMode === 'payg'
            ? parsed.rateLimitMode
            : DEFAULT_CONFIG.rateLimitMode,
        geminiApiKey: cleanApiKey(typeof parsed.geminiApiKey === 'string' ? parsed.geminiApiKey : ''),
        geminiModel: normalizeGeminiModel(
          typeof parsed.geminiModel === 'string' ? parsed.geminiModel : DEFAULT_CONFIG.geminiModel,
          'reasoning'
        ),
        geminiBatchModel: normalizeGeminiModel(
          typeof parsed.geminiBatchModel === 'string' ? parsed.geminiBatchModel : DEFAULT_CONFIG.geminiBatchModel,
          'batch'
        ),
        openaiApiKey: cleanApiKey(typeof parsed.openaiApiKey === 'string' ? parsed.openaiApiKey : ''),
        openaiModel: typeof parsed.openaiModel === 'string' && parsed.openaiModel.trim() ? parsed.openaiModel.trim() : DEFAULT_CONFIG.openaiModel,
        openaiBatchModel:
          typeof parsed.openaiBatchModel === 'string' && parsed.openaiBatchModel.trim()
            ? parsed.openaiBatchModel.trim()
            : DEFAULT_CONFIG.openaiBatchModel,
        anthropicApiKey: cleanApiKey(typeof parsed.anthropicApiKey === 'string' ? parsed.anthropicApiKey : ''),
        anthropicModel:
          typeof parsed.anthropicModel === 'string' && parsed.anthropicModel.trim()
            ? parsed.anthropicModel.trim()
            : DEFAULT_CONFIG.anthropicModel,
        anthropicBatchModel:
          typeof parsed.anthropicBatchModel === 'string' && parsed.anthropicBatchModel.trim()
            ? parsed.anthropicBatchModel.trim()
            : DEFAULT_CONFIG.anthropicBatchModel
      };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

export function saveAiConfig(config: Partial<AiConfig>): AiConfig {
  const current = getAiConfig();
  const cleaned: Partial<AiConfig> = { ...config };
  if (cleaned.provider !== undefined) {
    cleaned.provider = normalizeProvider(cleaned.provider);
  }
  if (cleaned.geminiApiKey !== undefined) {
    cleaned.geminiApiKey = cleanApiKey(cleaned.geminiApiKey);
  }
  if (cleaned.openaiApiKey !== undefined) {
    cleaned.openaiApiKey = cleanApiKey(cleaned.openaiApiKey);
  }
  if (cleaned.anthropicApiKey !== undefined) {
    cleaned.anthropicApiKey = cleanApiKey(cleaned.anthropicApiKey);
  }
  const updated: AiConfig = { ...current, ...cleaned };
  try {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(updated));
  } catch {}
  return updated;
}

export interface LocalModelStatus {
  online: boolean;
  provider: string;
  models: string[];
  activeModel: string;
  batchModel?: string;
  routingMode?: AiRoutingMode;
  message: string;
}

/**
 * Calcul du délai de réessai avec Exponential Backoff + Full Jitter
 * Gère les erreurs HTTP 429 (Quota/Rate Limit), 500, 502, 503 (High Demand / Overloaded), 504 et TimeoutError.
 */
export function computeBackoffDelayMs(attempt: number, baseDelayMs = 1500, maxDelayMs = 30000): number {
  const safeAttempt = Math.max(0, Math.min(10, attempt));
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, safeAttempt));
  const jitter = Math.floor(Math.random() * 1000);
  return exponential + jitter;
}

/**
 * Traduit toute erreur technique (réseau, timeout, HTTP 503/429, JSON) en un message utilisateur clair et professionnel,
 * sans jamais exposer de stacktrace brute à l'écran (Constitution § 4.4).
 */
export function mapErrorToUserMessage(err: unknown): string {
  if (!err) return "Une erreur inattendue est survenue. Veuillez réessayer.";
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('503') || lower.includes('529') || lower.includes('overloaded') || lower.includes('high demand') || lower.includes('unavailable')) {
    return "Le serveur IA Cloud est momentanément très sollicité (forte demande). Le basculement automatique sur le modèle de secours a été effectué ; veuillez réessayer dans quelques secondes.";
  }
  if (lower.includes('429') || lower.includes('quota') || lower.includes('rate limit') || lower.includes('resource has been exhausted') || lower.includes('insufficient_quota')) {
    return "Limite de requêtes ou de crédit atteinte sur l'API Cloud. Vérifiez votre quota Pay-As-You-Go ou patientez quelques secondes.";
  }
  if (lower.includes('api key') || lower.includes('invalid x-api-key') || lower.includes('incorrect api key') || lower.includes('401') || lower.includes('403') || lower.includes('non configurée')) {
    return "Clé API Cloud manquante ou invalide. Ouvrez les Paramètres IA (en haut à droite) pour configurer votre clé Google Gemini, OpenAI ou Anthropic.";
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return "Le serveur Cloud a mis trop de temps à répondre (délai dépassé). Le système a automatiquement basculé sur le modèle de secours.";
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed')) {
    return "Connexion réseau interrompue ou serveur distant injoignable. Vérifiez votre connexion Internet.";
  }
  return raw.replace(/^Error:\s*/i, '');
}

/**
 * Construit la cascade ordonnée de modèles Gemini pour basculer automatiquement en cas de 503 (High Demand), 429 ou 404
 */
async function buildGeminiModelCascade(primaryModel: string, apiKey: string, taskTier: AiTaskTier = 'reasoning'): Promise<string[]> {
  const discovered = await fetchDiscoveredGeminiModels(apiKey).catch(() => []);
  const orderedDefaults =
    taskTier === 'batch'
      ? ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-pro-latest']
      : taskTier === 'fast'
        ? ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest']
        : ['gemini-pro-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest'];

  const fallbacks = [
    normalizeGeminiModel(primaryModel, taskTier),
    ...orderedDefaults,
    ...discovered
  ];
  const unique: string[] = [];
  for (const m of fallbacks) {
    const clean = m.replace(/^models\//, '').trim();
    if (clean && clean !== 'auto' && !unique.includes(clean)) {
      unique.push(clean);
    }
  }
  // Borner la cascade à 4 modèles maximum pour éviter les boucles de latence cumulée sur l'API
  return unique.length > 0 ? unique.slice(0, 4) : [...orderedDefaults];
}

export interface LiveAiConnectionResult extends LocalModelStatus {
  readonly latencyMs?: number;
  readonly httpStatus?: number;
}

function formatHttpConnectionError(providerLabel: string, modelName: string, status: number, detail?: string): string {
  const cleanDetail = (detail || '').trim();
  if (status === 400 || status === 401 || status === 403) {
    return `Clé API ${providerLabel} invalide ou refusée (HTTP ${status})${cleanDetail ? ` — ${cleanDetail.slice(0, 120)}` : ''}.`;
  }
  if (status === 404) {
    return `Modèle introuvable sur ${providerLabel} : ${modelName} (HTTP 404).`;
  }
  if (status === 429) {
    return `Quota ou limite de requêtes atteinte sur ${providerLabel} (HTTP 429).`;
  }
  if (status >= 500) {
    return `Serveur ${providerLabel} temporairement indisponible (HTTP ${status}).`;
  }
  return `Erreur ${providerLabel} (HTTP ${status})${cleanDetail ? ` — ${cleanDetail.slice(0, 120)}` : ''}.`;
}

/**
 * Effectue un véritable appel léger de vérification de la connexion IA (clé + modèle d'analyse)
 * pour Google Gemini, OpenAI ou Anthropic, en mesurant la latence et en remontant toute erreur HTTP/réseau réelle.
 * Ne renvoie jamais `online: true` si la clé est absente ou si le test échoue.
 */
export async function testAiConnectionLive(
  overrideConfig?: Partial<AiConfig>
): Promise<LiveAiConnectionResult> {
  const baseConfig = getAiConfig();
  const config: AiConfig = { ...baseConfig, ...(overrideConfig || {}) };
  const activeReasoningModel = resolveActiveModelForTask(config, 'reasoning');
  const activeBatchModel = resolveActiveModelForTask(config, 'batch');
  const startMs = Date.now();

  if (config.provider === 'gemini') {
    const cleanKey = cleanApiKey(config.geminiApiKey);
    if (!cleanKey || cleanKey.length < 10) {
      return {
        online: false,
        provider: 'Google Gemini',
        models: [...GEMINI_FALLBACK_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        message: 'Clé API Google Gemini manquante.'
      };
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeReasoningModel)}?key=${encodeURIComponent(cleanKey)}`;
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
      const latencyMs = Math.max(1, Date.now() - startMs);

      if (res.ok) {
        return {
          online: true,
          provider: 'Google Gemini',
          models: [...GEMINI_FALLBACK_MODELS],
          activeModel: activeReasoningModel,
          batchModel: activeBatchModel,
          routingMode: config.routingMode,
          latencyMs,
          httpStatus: res.status,
          message: `Connecté · ${activeReasoningModel} (${latencyMs} ms)`
        };
      }

      let errDetail = '';
      try {
        const errJson = (await res.json()) as { error?: { message?: string } };
        errDetail = errJson?.error?.message || '';
      } catch {
        errDetail = '';
      }

      return {
        online: false,
        provider: 'Google Gemini',
        models: [...GEMINI_FALLBACK_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        latencyMs,
        httpStatus: res.status,
        message: formatHttpConnectionError('Google Gemini', activeReasoningModel, res.status, errDetail)
      };
    } catch (err: unknown) {
      const latencyMs = Math.max(1, Date.now() - startMs);
      return {
        online: false,
        provider: 'Google Gemini',
        models: [...GEMINI_FALLBACK_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        latencyMs,
        message: mapErrorToUserMessage(err)
      };
    }
  }

  if (config.provider === 'openai') {
    const cleanKey = cleanApiKey(config.openaiApiKey);
    if (!cleanKey || cleanKey.length < 10) {
      return {
        online: false,
        provider: 'OpenAI',
        models: [...OPENAI_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        message: 'Clé API OpenAI manquante.'
      };
    }

    try {
      const url = `https://api.openai.com/v1/models/${encodeURIComponent(activeReasoningModel)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cleanKey}` },
        signal: AbortSignal.timeout(8000)
      });
      const latencyMs = Math.max(1, Date.now() - startMs);

      if (res.ok) {
        return {
          online: true,
          provider: 'OpenAI',
          models: [...OPENAI_MODELS],
          activeModel: activeReasoningModel,
          batchModel: activeBatchModel,
          routingMode: config.routingMode,
          latencyMs,
          httpStatus: res.status,
          message: `Connecté · ${activeReasoningModel} (${latencyMs} ms)`
        };
      }

      let errDetail = '';
      try {
        const errJson = (await res.json()) as { error?: { message?: string } };
        errDetail = errJson?.error?.message || '';
      } catch {
        errDetail = '';
      }

      return {
        online: false,
        provider: 'OpenAI',
        models: [...OPENAI_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        latencyMs,
        httpStatus: res.status,
        message: formatHttpConnectionError('OpenAI', activeReasoningModel, res.status, errDetail)
      };
    } catch (err: unknown) {
      const latencyMs = Math.max(1, Date.now() - startMs);
      return {
        online: false,
        provider: 'OpenAI',
        models: [...OPENAI_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        latencyMs,
        message: mapErrorToUserMessage(err)
      };
    }
  }

  if (config.provider === 'anthropic') {
    const cleanKey = cleanApiKey(config.anthropicApiKey);
    if (!cleanKey || cleanKey.length < 10) {
      return {
        online: false,
        provider: 'Anthropic',
        models: [...ANTHROPIC_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        message: 'Clé API Anthropic manquante.'
      };
    }

    try {
      const url = `https://api.anthropic.com/v1/models/${encodeURIComponent(activeReasoningModel)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': cleanKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        signal: AbortSignal.timeout(8000)
      });
      const latencyMs = Math.max(1, Date.now() - startMs);

      if (res.ok) {
        return {
          online: true,
          provider: 'Anthropic',
          models: [...ANTHROPIC_MODELS],
          activeModel: activeReasoningModel,
          batchModel: activeBatchModel,
          routingMode: config.routingMode,
          latencyMs,
          httpStatus: res.status,
          message: `Connecté · ${activeReasoningModel} (${latencyMs} ms)`
        };
      }

      let errDetail = '';
      try {
        const errJson = (await res.json()) as { error?: { message?: string } };
        errDetail = errJson?.error?.message || '';
      } catch {
        errDetail = '';
      }

      return {
        online: false,
        provider: 'Anthropic',
        models: [...ANTHROPIC_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        latencyMs,
        httpStatus: res.status,
        message: formatHttpConnectionError('Anthropic', activeReasoningModel, res.status, errDetail)
      };
    } catch (err: unknown) {
      const latencyMs = Math.max(1, Date.now() - startMs);
      return {
        online: false,
        provider: 'Anthropic',
        models: [...ANTHROPIC_MODELS],
        activeModel: activeReasoningModel,
        batchModel: activeBatchModel,
        routingMode: config.routingMode,
        latencyMs,
        message: mapErrorToUserMessage(err)
      };
    }
  }

  return {
    online: false,
    provider: 'Google Gemini',
    models: [...GEMINI_FALLBACK_MODELS],
    activeModel: activeReasoningModel,
    batchModel: activeBatchModel,
    routingMode: config.routingMode,
    message: 'Clé API Google Gemini manquante.'
  };
}

export async function checkLocalAiStatus(overrideConfig?: Partial<AiConfig>): Promise<LocalModelStatus> {
  return testAiConnectionLive(overrideConfig);
}

export function canUnlockPrerequisitesModal(params: {
  readonly activeKey: string;
  readonly testedStatus: LiveAiConnectionResult | null;
}): boolean {
  if (params.testedStatus?.online) return true;
  if (params.testedStatus && !params.testedStatus.online && params.testedStatus.httpStatus) {
    return false;
  }
  return params.activeKey.trim().length >= 10;
}

type CloudProvider = 'gemini' | 'openai' | 'anthropic';

class AuthFailFastError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthFailFastError';
  }
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function isExternalAbortError(err: unknown, externalSignal?: AbortSignal): boolean {
  if (externalSignal?.aborted) return true;
  return err instanceof DOMException && err.name === 'AbortError' && Boolean(externalSignal?.aborted);
}

function combineAbortSignals(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!externalSignal) return timeoutSignal;
  return AbortSignal.any([externalSignal, timeoutSignal]);
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timerId = setTimeout(() => {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    if (abortSignal) {
      onAbort = () => {
        clearTimeout(timerId);
        reject(createAbortError());
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function hasConfiguredProviderKey(config: AiConfig, provider: CloudProvider): boolean {
  if (provider === 'gemini') return Boolean(cleanApiKey(config.geminiApiKey));
  if (provider === 'openai') return Boolean(cleanApiKey(config.openaiApiKey));
  return Boolean(cleanApiKey(config.anthropicApiKey));
}

export interface GeminiSchemaProperty {
  readonly type: 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT';
  readonly enum?: readonly string[];
  readonly nullable?: boolean;
  readonly items?: GeminiSchemaProperty;
  readonly properties?: Readonly<Record<string, GeminiSchemaProperty>>;
  readonly required?: readonly string[];
}

export interface AiQueryOptions {
  readonly maxOutputTokens?: number;
  readonly geminiResponseSchema?: GeminiSchemaProperty;
}

export class ScreeningJsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreeningJsonParseError';
  }
}

async function runGeminiProvider(
  config: AiConfig,
  prompt: string,
  systemPrompt: string | undefined,
  taskTier: AiTaskTier,
  abortSignal?: AbortSignal,
  options?: AiQueryOptions
): Promise<string | null> {
  const cleanKey = cleanApiKey(config.geminiApiKey);
  if (!cleanKey) {
    throw new AuthFailFastError(mapErrorToUserMessage('Clé API Google Gemini non configurée.'));
  }
  if (abortSignal?.aborted) {
    throw createAbortError();
  }

  let primaryModel = resolveActiveModelForTask(config, taskTier);
  if (primaryModel === 'auto') {
    const discovered = await fetchDiscoveredGeminiModels(cleanKey);
    primaryModel =
      taskTier === 'batch' || taskTier === 'fast'
        ? (discovered.find((m) => m.includes('flash')) || discovered[0] || 'gemini-flash-latest')
        : (discovered.find((m) => m.includes('pro')) || discovered.find((m) => m.includes('flash')) || 'gemini-pro-latest');
  }

  const cascadeModels = await buildGeminiModelCascade(primaryModel, cleanKey, taskTier);
  const timeoutMs = taskTier === 'batch' ? 60000 : 35000;

  const makeGeminiRequest = async (m: string) => {
    const cleanModel = m.replace(/^models\//, '').trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${cleanKey}`;
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: `${systemPrompt ? systemPrompt + '\n\n' : ''}${prompt}` }]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          ...(options?.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options?.geminiResponseSchema ? { responseSchema: options.geminiResponseSchema } : {})
        }
      }),
      signal: combineAbortSignals(timeoutMs, abortSignal)
    });
  };

  let lastErrorMessage = 'Serveur Gemini indisponible';

  for (let modelIdx = 0; modelIdx < cascadeModels.length; modelIdx++) {
    const currentModel = cascadeModels[modelIdx];
    const hasFallback = modelIdx + 1 < cascadeModels.length;
    const maxAttemptsPerModel = 2;

    for (let attempt = 0; attempt < maxAttemptsPerModel; attempt++) {
      if (abortSignal?.aborted) {
        throw createAbortError();
      }
      try {
        const res = await makeGeminiRequest(currentModel);

        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
        }

        if (res.status === 404) {
          break;
        }

        const errJson = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        const errMsg = errJson?.error?.message || `HTTP ${res.status}`;
        lastErrorMessage = `Google Gemini (${res.status}) : ${errMsg}`;

        if (res.status === 401 || res.status === 403 || (res.status === 400 && errMsg.toLowerCase().includes('api key'))) {
          throw new AuthFailFastError(mapErrorToUserMessage(lastErrorMessage));
        }

        if (res.status === 429 && hasFallback) {
          break;
        }

        if (res.status === 503 || res.status === 500 || res.status === 502 || res.status === 504 || res.status === 429) {
          const retryMatch = errMsg.match(/retry in ([0-9.]+)s/i);
          const delayMs =
            res.status === 429 && retryMatch
              ? Math.min(15000, Math.ceil(parseFloat(retryMatch[1]) * 1000) + 500)
              : computeBackoffDelayMs(attempt, res.status === 503 ? 800 : 1200, 5000);

          if (attempt + 1 < maxAttemptsPerModel) {
            await sleepWithAbort(delayMs, abortSignal);
            continue;
          } else if (hasFallback) {
            break;
          }
        } else {
          break;
        }
      } catch (err: unknown) {
        if (err instanceof AuthFailFastError) throw err;
        if (isExternalAbortError(err, abortSignal)) {
          throw createAbortError();
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Clé API')) {
          throw new AuthFailFastError(msg);
        }
        lastErrorMessage = msg;
        if (attempt + 1 < maxAttemptsPerModel) {
          const delayMs = computeBackoffDelayMs(attempt, 800, 4000);
          await sleepWithAbort(delayMs, abortSignal);
          continue;
        }
      }
    }
  }

  throw new Error(lastErrorMessage);
}

async function runOpenAiProvider(
  config: AiConfig,
  prompt: string,
  systemPrompt: string | undefined,
  taskTier: AiTaskTier,
  abortSignal?: AbortSignal
): Promise<string | null> {
  const cleanKey = cleanApiKey(config.openaiApiKey);
  if (!cleanKey) {
    throw new AuthFailFastError(mapErrorToUserMessage('Clé API OpenAI non configurée.'));
  }

  const primaryModel = resolveActiveModelForTask(config, taskTier);
  const cascadeModels = Array.from(new Set([primaryModel, 'gpt-4o-mini', 'gpt-4o']));
  const timeoutMs = taskTier === 'batch' ? 60000 : 35000;
  let lastErrorMessage = 'Serveur OpenAI indisponible';

  for (let modelIdx = 0; modelIdx < cascadeModels.length; modelIdx++) {
    const currentModel = cascadeModels[modelIdx];
    const hasFallback = modelIdx + 1 < cascadeModels.length;
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (abortSignal?.aborted) {
        throw createAbortError();
      }
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cleanKey}`
          },
          body: JSON.stringify({
            model: currentModel,
            messages: [
              ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
              { role: 'user', content: prompt }
            ],
            temperature: 0.1,
            ...(/json/i.test(`${systemPrompt || ''} ${prompt}`) ? { response_format: { type: 'json_object' } } : {})
          }),
          signal: combineAbortSignals(timeoutMs, abortSignal)
        });

        if (res.ok) {
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          return data?.choices?.[0]?.message?.content || null;
        }

        if (res.status === 404) {
          break;
        }

        const errJson = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        const errMsg = errJson?.error?.message || `HTTP ${res.status}`;
        lastErrorMessage = `OpenAI (${res.status}) : ${errMsg}`;

        if (res.status === 401 || res.status === 403) {
          throw new AuthFailFastError(mapErrorToUserMessage(lastErrorMessage));
        }

        if (res.status === 429 && hasFallback) {
          break;
        }

        if (res.status === 429 || res.status >= 500) {
          if (attempt + 1 < maxAttempts) {
            const delayMs = computeBackoffDelayMs(attempt, 1500, 10000);
            await sleepWithAbort(delayMs, abortSignal);
            continue;
          }
          break;
        }
        break;
      } catch (err: unknown) {
        if (err instanceof AuthFailFastError) throw err;
        if (isExternalAbortError(err, abortSignal)) {
          throw createAbortError();
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Clé API')) {
          throw new AuthFailFastError(msg);
        }
        lastErrorMessage = msg;
        if (attempt + 1 < maxAttempts) {
          const delayMs = computeBackoffDelayMs(attempt, 1500, 8000);
          await sleepWithAbort(delayMs, abortSignal);
          continue;
        }
      }
    }
  }

  throw new Error(lastErrorMessage);
}

async function runAnthropicProvider(
  config: AiConfig,
  prompt: string,
  systemPrompt: string | undefined,
  taskTier: AiTaskTier,
  abortSignal?: AbortSignal
): Promise<string | null> {
  const cleanKey = cleanApiKey(config.anthropicApiKey);
  if (!cleanKey) {
    throw new AuthFailFastError(mapErrorToUserMessage('Clé API Anthropic Claude non configurée.'));
  }

  const primaryModel = resolveActiveModelForTask(config, taskTier);
  const cascadeModels = Array.from(new Set([primaryModel, 'claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest']));
  const timeoutMs = taskTier === 'batch' ? 60000 : 35000;
  let lastErrorMessage = 'Serveur Anthropic indisponible';

  for (let modelIdx = 0; modelIdx < cascadeModels.length; modelIdx++) {
    const currentModel = cascadeModels[modelIdx];
    const hasFallback = modelIdx + 1 < cascadeModels.length;
    const maxAttempts = 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (abortSignal?.aborted) {
        throw createAbortError();
      }
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': cleanKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model: currentModel,
            max_tokens: 4096,
            temperature: 0.1,
            ...(systemPrompt ? { system: systemPrompt } : {}),
            messages: [{ role: 'user', content: prompt }]
          }),
          signal: combineAbortSignals(timeoutMs, abortSignal)
        });

        if (res.ok) {
          const data = (await res.json()) as {
            content?: Array<{ text?: string }>;
          };
          return data?.content?.[0]?.text || null;
        }

        if (res.status === 404) {
          break;
        }

        const errJson = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        const errMsg = errJson?.error?.message || `HTTP ${res.status}`;
        lastErrorMessage = `Anthropic (${res.status}) : ${errMsg}`;

        if (res.status === 401 || res.status === 403) {
          throw new AuthFailFastError(mapErrorToUserMessage(lastErrorMessage));
        }

        if (res.status === 429 && hasFallback) {
          break;
        }

        if (res.status === 429 || res.status === 529 || res.status >= 500) {
          if (attempt + 1 < maxAttempts) {
            const delayMs = computeBackoffDelayMs(attempt, 1500, 10000);
            await sleepWithAbort(delayMs, abortSignal);
            continue;
          }
          break;
        }
        break;
      } catch (err: unknown) {
        if (err instanceof AuthFailFastError) throw err;
        if (isExternalAbortError(err, abortSignal)) {
          throw createAbortError();
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Clé API')) {
          throw new AuthFailFastError(msg);
        }
        lastErrorMessage = msg;
        if (attempt + 1 < maxAttempts) {
          const delayMs = computeBackoffDelayMs(attempt, 1500, 8000);
          await sleepWithAbort(delayMs, abortSignal);
          continue;
        }
      }
    }
  }

  throw new Error(lastErrorMessage);
}

/**
 * Envoie une requête au fournisseur Cloud sélectionné (Gemini, OpenAI ou Anthropic)
 * avec routage intelligent par tâche ('reasoning' vs 'batch'), Exponential Backoff,
 * Model Cascade, propagation AbortSignal et failover automatique inter-fournisseurs.
 */
export async function queryAiModel(
  prompt: string,
  systemPrompt?: string,
  taskTier: AiTaskTier = 'reasoning',
  abortSignal?: AbortSignal,
  options?: AiQueryOptions
): Promise<string | null> {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }

  const config = getAiConfig();
  const orderedProviders: CloudProvider[] = [config.provider];
  const candidateFallbacks: readonly CloudProvider[] = ['gemini', 'openai', 'anthropic'];
  for (const fallbackProvider of candidateFallbacks) {
    if (!orderedProviders.includes(fallbackProvider) && hasConfiguredProviderKey(config, fallbackProvider)) {
      orderedProviders.push(fallbackProvider);
    }
  }

  let lastProviderError: unknown = null;

  for (const activeProvider of orderedProviders) {
    if (abortSignal?.aborted) {
      throw createAbortError();
    }

    const effectiveConfig: AiConfig =
      activeProvider === config.provider ? config : { ...config, provider: activeProvider };

    try {
      if (activeProvider === 'gemini') {
        return await runGeminiProvider(effectiveConfig, prompt, systemPrompt, taskTier, abortSignal, options);
      }
      if (activeProvider === 'openai') {
        return await runOpenAiProvider(effectiveConfig, prompt, systemPrompt, taskTier, abortSignal);
      }
      return await runAnthropicProvider(effectiveConfig, prompt, systemPrompt, taskTier, abortSignal);
    } catch (err: unknown) {
      if (err instanceof AuthFailFastError) {
        throw new Error(err.message);
      }
      if (isExternalAbortError(err, abortSignal)) {
        throw createAbortError();
      }
      lastProviderError = err;
    }
  }

  throw new Error(mapErrorToUserMessage(lastProviderError));
}

function recoverTruncatedJsonArray(text: string): unknown[] | null {
  const arrStart = text.indexOf('[');
  if (arrStart === -1) return null;

  const recovered: unknown[] = [];
  let inString = false;
  let escaped = false;
  let braceDepth = 0;
  let objStart = -1;

  for (let i = arrStart + 1; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (braceDepth === 0) {
        objStart = i;
      }
      braceDepth++;
      continue;
    }

    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      if (braceDepth === 0 && objStart !== -1) {
        const candidateObj = text.slice(objStart, i + 1);
        try {
          const parsedObj: unknown = JSON.parse(candidateObj);
          if (parsedObj && typeof parsedObj === 'object' && !Array.isArray(parsedObj)) {
            recovered.push(parsedObj);
          }
        } catch {
          // Ignorer un objet malformé sans jamais deviner ou fermer un objet incomplet
        }
        objStart = -1;
      }
    }
  }

  return recovered.length > 0 ? recovered : null;
}

/**
 * Extraction robuste de JSON depuis une réponse de LLM
 */
export function extractJsonFromLlmResponse<T = unknown>(rawText: string): T | null {
  if (!rawText || !rawText.trim()) return null;
  const trimmed = rawText.trim();

  // 1. Essai direct (si pur JSON)
  try {
    return JSON.parse(trimmed) as T;
  } catch {}

  // 2. Extraction prioritaire du contenu strict à l'intérieur des blocs ```json ... ``` ou ``` ... ```
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fenceRegex)) {
    const inner = (match[1] || '').trim();
    if (!inner) continue;
    try {
      return JSON.parse(inner) as T;
    } catch {}
    if (inner.includes('[')) {
      const recoveredInner = recoverTruncatedJsonArray(inner);
      if (recoveredInner) {
        return recoveredInner as unknown as T;
      }
    }
  }

  // 3. Extraction par délimiteurs de crochets [ ... ] ou d'accolades { ... }
  const startBracket = trimmed.indexOf('[');
  const endBracket = trimmed.lastIndexOf(']');
  const startBrace = trimmed.indexOf('{');
  const endBrace = trimmed.lastIndexOf('}');

  // Si un tableau commence avant un objet (ou s'il n'y a pas d'objet)
  if (startBracket !== -1 && endBracket > startBracket && (startBrace === -1 || startBracket < startBrace)) {
    const candidate = trimmed.slice(startBracket, endBracket + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch {}
  }

  // Si un objet commence avant un tableau
  if (startBrace !== -1 && endBrace > startBrace) {
    const candidate = trimmed.slice(startBrace, endBrace + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch {}
  }

  // Fallback si tableau présent
  if (startBracket !== -1 && endBracket > startBracket) {
    const candidate = trimmed.slice(startBracket, endBracket + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch {}
  }

  // 4. Récupération sûre des objets complets d'un tableau JSON tronqué (max_tokens)
  if (startBracket !== -1) {
    const recovered = recoverTruncatedJsonArray(trimmed);
    if (recovered) {
      return recovered as unknown as T;
    }
  }

  return null;
}

/**
 * Rôles sémantiques universels d'un axe PICO/PECO pour le compilateur booléen PRISMA-S
 */
export type PicoAxisRole =
  | 'drug_inn_list'
  | 'iatrogenic_generic'
  | 'induced_syndrome'
  | 'clinical_condition'
  | 'passive_comparator'
  | 'demographic_unrestricted';

export interface NormalizedAtomicConcept {
  readonly conceptFr: string;
  readonly conceptEn: string;
  readonly broaderMeshRoot?: string;
  readonly synonymsTiab: readonly string[];
}

export type NormalizedPicoConceptsMap = Partial<
  Record<'p' | 'i' | 'c' | 'o' | 'not', readonly NormalizedAtomicConcept[]>
>;

/**
 * Qualification morpho-sémantique d'un axe PICO/PECO produite par l'orchestrateur LLM
 * ou par l'analyseur morphosyntaxique déterministe.
 */
export interface AxisSemanticQualification {
  readonly axisRole: PicoAxisRole;
  readonly impliedSubheadings: readonly string[];
  readonly coreClinicalConcept: string;
  readonly englishCoreTerms: readonly string[];
  readonly atomicConcepts?: readonly NormalizedAtomicConcept[];
}

export interface PicoSemanticQualifications {
  readonly p?: AxisSemanticQualification;
  readonly i?: AxisSemanticQualification;
  readonly c?: AxisSemanticQualification;
  readonly o?: AxisSemanticQualification;
  readonly not?: AxisSemanticQualification;
  readonly recommendedActivePico?: {
    readonly p: boolean;
    readonly i: boolean;
    readonly c: boolean;
    readonly o: boolean;
    readonly not: boolean;
  };
}

/**
 * AGENT 1 AUGMENTÉ : Extraction Clinique PICO Experte
 */
export interface ClinicalPicoExtractionResult {
  approach?: 'pico' | 'peco';
  p: string;
  i: string;
  c: string;
  o: string;
  not: string;
  qualifications?: PicoSemanticQualifications;
  source?: 'gemini' | 'openai' | 'anthropic' | 'rules';
  modelUsed?: string;
  confidence?: number;
  reasoning?: string;
}

const ALLOWED_NLM_SUBHEADINGS = new Set<string>([
  'chemically induced',
  'adverse effects',
  'poisoning',
  'toxicity',
  'drug therapy',
  'therapy',
  'diet therapy',
  'diagnosis',
  'diagnostic imaging',
  'prevention and control',
  'epidemiology',
  'mortality',
  'etiology',
  'complications',
  'surgery',
  'therapeutic use',
  'pharmacology',
  'administration and dosage'
]);

/**
 * Purge stricte de tout terme d'iatrogénie / pharmacovigilance égaré dans l'Axe O (Outcome).
 * L'Axe O ne doit contenir QUE le phénotype ou la maladie clinique cible.
 */
export function stripIatrogenicTermsFromOutcome(rawOutcome: string): string {
  if (!rawOutcome) return '';
  const clauses = rawOutcome
    .split(/[,;]/)
    .map((c) => c.trim())
    .filter(
      (c) =>
        c.length > 0 &&
        !/^(?:pharmacovigilance|iatrog[ée]n(?:ie|ique)s?|effets?\s+ind[ée]sirables?(?:\s+m[ée]dicamenteux)?|drug[\s-]+related\s+side\s+effects?(?:\s+and\s+adverse\s+reactions?)?|adverse\s+drug\s+reactions?)$/i.test(
          c
        )
    );
  return clauses.join(', ').trim();
}

/**
 * Détecte de façon déterministe si un texte correspond à un comparateur passif non discriminant
 * (ex: "Absence d'exposition", "Placebo", "Soins courants", "Alimentation habituelle").
 */
export function isPassiveComparatorConcept(rawText: string): boolean {
  const clean = (rawText || '').trim();
  if (!clean) return true;
  return /\b(?:absence\s+d['’]\s*(?:exposition|intervention|restriction|traitement)|sans\s+(?:exposition|intervention|traitement)|non[\s-]+expos[ée]s?|no\s+exposure|unexposed|alimentation\s+habituelle|r[ée]gime\s+habituel|soins?\s+(?:habituels?|courants?|standards?)|prise\s+en\s+charge\s+(?:habituelle|standard)|traitement\s+(?:habituel|standard)|apprentissage\s+traditionnel|traditional\s+learning|usual\s+care|standard\s+care|placebo|groupe\s+(?:t[ée]moin|contr[ôo]le)|control\s+group|aucun\s+traitement|no\s+treatment|abstention|watchful\s+waiting)\b/i.test(
    clean
  );
}

/**
 * Détecte de façon déterministe si un texte de Population correspond à une démographie générale
 * non restreinte à une pathologie spécifique (ex: "Adultes en soins primaires", "Population générale").
 */
export function isUnrestrictedDemographicConcept(rawText: string): boolean {
  const clean = (rawText || '').trim();
  if (!clean) return true;
  return /^(?:adultes?(?:\s+(?:de\s+)?(?:18\s+ans\s+(?:et|ou)\s+plus|[≥>=]+\s*18\s+ans))?(?:\s+en\s+soins?\s+primaires?|\s+en\s+m[ée]decine\s+g[ée]n[ée]rale|\s+ambulatoires?|\s+tout\s+pays)?|population\s+g[ée]n[ée]rale(?:\s+adulte)?|patients?(?:\s+adultes?)?(?:\s+en\s+soins?\s+primaires?|\s+en\s+m[ée]decine\s+g[ée]n[ée]rale|\s+expos[ée]s?|\s+trait[ée]s?)?|sujets?\s+adultes?|tout\s+[âa]ge|humains?)$/i.test(
    clean
  );
}

/**
 * Inférence morphosyntaxique déterministe de la qualification d'un axe PICO/PECO
 * (Zéro dictionnaire médical en dur : repose exclusivement sur les marqueurs grammaticaux
 * de causalité iatrogène, d'arité d'énumération et de comparateurs passifs).
 */
export function inferDeterministicAxisQualification(
  axisType: 'P' | 'I' | 'C' | 'O' | 'NOT',
  rawText: string
): AxisSemanticQualification {
  const baseText = axisType === 'O' ? stripIatrogenicTermsFromOutcome(rawText) : rawText;
  const clean = (baseText || '').trim();
  if (!clean) {
    return {
      axisRole: axisType === 'C' ? 'passive_comparator' : 'clinical_condition',
      impliedSubheadings: [],
      coreClinicalConcept: '',
      englishCoreTerms: []
    };
  }

  // 1. Court-circuit strict des comparateurs passifs (Cochrane Handbook chap. 4)
  if (axisType === 'C' && isPassiveComparatorConcept(clean)) {
    return {
      axisRole: 'passive_comparator',
      impliedSubheadings: [],
      coreClinicalConcept: '',
      englishCoreTerms: []
    };
  }

  // 2. Court-circuit strict d'une population démographique générale non restreinte à une pathologie
  if (axisType === 'P' && isUnrestrictedDemographicConcept(clean)) {
    return {
      axisRole: 'demographic_unrestricted',
      impliedSubheadings: [],
      coreClinicalConcept: '',
      englishCoreTerms: []
    };
  }

  // 3. Détection grammaticale d'une exposition générique d'iatrogénie / pharmacovigilance (Voie 2 de rattrapage)
  const isGenericIatrogenicAxis =
    axisType === 'I' &&
    (/\b(?:pharmacovigilance|iatrog[ée]n(?:ie|ique)s?|effets?\s+ind[ée]sirables?\s+m[ée]dicamenteux|exposition\s+m[ée]dicamenteuse|m[ée]dicaments?\s+(?:commercialis[ée]s?|[àa]\s+usage\s+th[ée]rapeutique|prescrits?(?:\s+en\s+soins?\s+primaires?)?)|drug[\s-]+related\s+side\s+effects?|adverse\s+drug\s+reactions?)\b/i.test(clean) ||
      /^(?:les?\s+|des?\s+|tous\s+les\s+)?m[ée]dicaments?$/i.test(clean)) &&
    clean.split(/[,;]/).length <= 4;

  if (isGenericIatrogenicAxis) {
    return {
      axisRole: 'iatrogenic_generic',
      impliedSubheadings: ['adverse effects'],
      coreClinicalConcept: 'Effets indésirables médicamenteux, Pharmacovigilance',
      englishCoreTerms: ['Drug-Related Side Effects and Adverse Reactions', 'Pharmacovigilance']
    };
  }

  // 4. Détection grammaticale d'une liste d'énumération de substances / DCI sur l'axe I/E
  const commaParts = clean
    .split(/[,;]|\s+(?:ou|or)\s+/i)
    .map(p => p.trim())
    .filter(Boolean);

  const looksLikeMoleculeToken = (token: string): boolean => {
    const t = token.replace(/^["']+|["']+$/g, '').trim();
    // Acide <X>ique / <X>ic acid ou lexème unique de 5 à 25 lettres
    if (/^(?:acide\s+[a-zàâäéèêëîïôöùûü]{4,20}|[a-z]{4,20}\s+acid)$/i.test(t)) return true;
    return /^[a-zàâäéèêëîïôöùûü]{5,25}$/i.test(t) && !/\b(?:adultes?|patients?|syndrome|maladie|troubles?|poids|surpoids|ob[ée]sit[ée]|mortalit[ée]|survie)\b/i.test(t);
  };

  if (
    axisType === 'I' &&
    commaParts.length >= 2 &&
    commaParts.filter(looksLikeMoleculeToken).length >= Math.ceil(commaParts.length * 0.7)
  ) {
    return {
      axisRole: 'drug_inn_list',
      impliedSubheadings: [],
      coreClinicalConcept: clean,
      englishCoreTerms: commaParts
    };
  }

  // 5. Détection morphosyntaxique d'un événement / syndrome induit chimiquement ou par un médicament
  const causalChemicallyInducedPattern =
    /\b(?:induits?\s+chimiquement|chimiquement\s+induits?|induits?\s+par\s+(?:les?\s+|des?\s+|un\s+)?m[ée]dicaments?|d['’]origine\s+m[ée]dicamenteuse|m[ée]dicamenteux|m[ée]dicamenteuses|iatrog[èe]nes?|secondaires?\s+(?:[àa]\s+la\s+prise\s+de\s+m[ée]dicaments?|aux\s+m[ée]dicaments?)|chemically\s+induced|drug[\s-]+induced|medication[\s-]+induced)\b/i;

  if (causalChemicallyInducedPattern.test(clean)) {
    // Isoler le noyau nosologique pur en retirant les modificateurs causaux et les doublons génériques d'effets indésirables
    const clauses = clean
      .split(/[,;]/)
      .map(c => c.trim())
      .filter(c => !/^(?:effets?\s+ind[ée]sirables?(?:\s+m[ée]dicamenteux)?|pharmacovigilance|iatrog[ée]nie)$/i.test(c));

    const strippedClauses = (clauses.length > 0 ? clauses : [clean])
      .map(c =>
        c
          .replace(/\b(?:induits?\s+chimiquement|chimiquement\s+induits?|induits?\s+par\s+(?:les?\s+|des?\s+|un\s+)?m[ée]dicaments?|d['’]origine\s+m[ée]dicamenteuse|m[ée]dicamenteux|m[ée]dicamenteuses|iatrog[èe]nes?|chemically\s+induced|drug[\s-]+induced|medication[\s-]+induced)\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter(Boolean);

    const coreConcept = strippedClauses.join(', ') || clean;

    return {
      axisRole: 'induced_syndrome',
      impliedSubheadings: ['chemically induced'],
      coreClinicalConcept: coreConcept,
      englishCoreTerms: []
    };
  }

  return {
    axisRole: 'clinical_condition',
    impliedSubheadings: [],
    coreClinicalConcept: clean,
    englishCoreTerms: []
  };
}

function sanitizeAxisQualification(
  rawQual: unknown,
  axisType: 'P' | 'I' | 'C' | 'O' | 'NOT',
  fallbackConceptText: string
): AxisSemanticQualification {
  const deterministic = inferDeterministicAxisQualification(axisType, fallbackConceptText);
  if (!rawQual || typeof rawQual !== 'object') {
    return deterministic;
  }

  const candidate = rawQual as Record<string, unknown>;
  const validRoles: readonly PicoAxisRole[] = [
    'drug_inn_list',
    'iatrogenic_generic',
    'induced_syndrome',
    'clinical_condition',
    'passive_comparator',
    'demographic_unrestricted'
  ];

  const rawRole = String(candidate.axisRole || '').trim() as PicoAxisRole;
  // Priorité absolue au détecteur déterministe pour les court-circuits (passive_comparator / demographic_unrestricted)
  const axisRole: PicoAxisRole =
    deterministic.axisRole === 'passive_comparator' ||
    deterministic.axisRole === 'demographic_unrestricted'
      ? deterministic.axisRole
      : validRoles.includes(rawRole)
        ? rawRole
        : deterministic.axisRole;

  if (axisRole === 'passive_comparator' || axisRole === 'demographic_unrestricted') {
    return {
      axisRole,
      impliedSubheadings: [],
      coreClinicalConcept: '',
      englishCoreTerms: []
    };
  }

  const rawSubheadings = Array.isArray(candidate.impliedSubheadings)
    ? candidate.impliedSubheadings
        .map((s) =>
          String(s || '')
            .toLowerCase()
            .replace(/\s*&\s*/g, ' and ')
            .replace(/\s+/g, ' ')
            .trim()
        )
        .filter((s) => ALLOWED_NLM_SUBHEADINGS.has(s))
    : [];

  const impliedSubheadings = Array.from(
    new Set([...rawSubheadings, ...deterministic.impliedSubheadings])
  );

  const rawCore =
    typeof candidate.coreClinicalConcept === 'string' &&
    candidate.coreClinicalConcept.trim().length > 1
      ? sanitizePicoConcept(candidate.coreClinicalConcept.replace(/\([^)]*\)/g, ' ').trim())
      : deterministic.coreClinicalConcept;

  const coreClinicalConcept =
    axisType === 'O'
      ? stripIatrogenicTermsFromOutcome(rawCore)
      : axisRole === 'iatrogenic_generic' && /^(?:les?\s+|des?\s+|tous\s+les\s+)?m[ée]dicaments?$/i.test(rawCore)
        ? deterministic.coreClinicalConcept
        : rawCore;

  const filteredEnglishTerms = Array.isArray(candidate.englishCoreTerms)
    ? candidate.englishCoreTerms
        .map((t) => String(t || '').trim())
        .filter(
          (t) =>
            t.length > 1 &&
            !(
              axisType === 'O' &&
              /\b(?:pharmacovigilance|iatrogen|side\s+effects?|adverse\s+reactions?)\b/i.test(t)
            ) &&
            !(
              axisType === 'I' &&
              /^(?:pharmaceutical\s+preparations?|surgical\s+instruments?|drugs?)$/i.test(t)
            )
        )
    : [];

  const englishCoreTerms =
    filteredEnglishTerms.length > 0 ? filteredEnglishTerms : deterministic.englishCoreTerms;

  return {
    axisRole,
    impliedSubheadings,
    coreClinicalConcept: coreClinicalConcept || fallbackConceptText,
    englishCoreTerms
  };
}

/**
 * AGENT 1 AUGMENTÉ : Extraction Clinique PICO/PECO & Qualification Morpho-Sémantique par LLM
 * Respecte rigoureusement la Constitution gemini.md, PRISMA-S et le Cochrane Handbook.
 */
export async function aiExtractClinicalPico(rawText: string): Promise<ClinicalPicoExtractionResult> {
  const config = getAiConfig();
  const activeKey =
    config.provider === 'gemini'
      ? cleanApiKey(config.geminiApiKey)
      : config.provider === 'openai'
        ? cleanApiKey(config.openaiApiKey)
        : config.provider === 'anthropic'
          ? cleanApiKey(config.anthropicApiKey)
          : '';

  const hasAnyKey =
    hasConfiguredProviderKey(config, 'gemini') ||
    hasConfiguredProviderKey(config, 'openai') ||
    hasConfiguredProviderKey(config, 'anthropic');

  if (!activeKey && !hasAnyKey) {
    throw new Error(
      "Aucune clé API IA n'est configurée. Veuillez renseigner une clé Google Gemini, OpenAI ou Anthropic dans les Paramètres pour structurer votre question clinique."
    );
  }

  const resolvedProvider: CloudProvider =
    activeKey
      ? config.provider
      : hasConfiguredProviderKey(config, 'gemini')
        ? 'gemini'
        : hasConfiguredProviderKey(config, 'openai')
          ? 'openai'
          : 'anthropic';
  const modelUsed = resolveActiveModelForTask({ ...config, provider: resolvedProvider }, 'fast');

  const system = `Tu es un médecin méthodologiste expert du thésaurus NLM MeSH et de PRISMA-S.
Extrais les axes PICO/PECO d'une question clinique en concepts atomiques concis dans la langue d'origine (sans balises [Mesh]/[tiab] ni traductions entre parenthèses, avec sigles développés en toutes lettres).
Règles strictes :
- Détermine "approach": "peco" (exposition/étiologie/risque observationnel) ou "pico" (intervention thérapeutique/préventive/diagnostique).
- Sépare l'exposition (I/E) de l'événement clinique (O) : ne mets jamais "Pharmacovigilance" ou "Effet indésirable" dans O.
- Pour une pathologie induite par une substance, mets axisRole "induced_syndrome" et impliedSubheadings ["chemically induced"] dans O, avec le noyau nosologique pur dans coreClinicalConcept.
- Mets recommendedActivePico.c=false pour un comparateur passif (placebo, soins courants, absence d'exposition) et c=true pour un comparateur actif nommé. Mets p=false uniquement si la population est purement démographique sans pathologie.
- Fournis 2 à 5 "englishCoreTerms" concis par axe actif pour la résolution NCBI Entrez.
Réponds EXCLUSIVEMENT en JSON valide.`;

  const prompt = `Extrais la structure PICO/PECO au format JSON strict :
{
  "approach": "pico | peco",
  "p": "Population / pathologie cible (ou chaîne vide)",
  "i": "Intervention ou exposition (ou chaîne vide)",
  "c": "Comparateur actif ou passif (ou chaîne vide)",
  "o": "Critère(s) de jugement / pathologie cible (ou chaîne vide)",
  "not": "Critères d'exclusion explicites (ou chaîne vide)",
  "qualifications": {
    "p": { "axisRole": "clinical_condition | demographic_unrestricted", "impliedSubheadings": [], "coreClinicalConcept": "", "englishCoreTerms": [] },
    "i": { "axisRole": "drug_inn_list | iatrogenic_generic | clinical_condition", "impliedSubheadings": [], "coreClinicalConcept": "", "englishCoreTerms": [] },
    "c": { "axisRole": "passive_comparator | clinical_condition", "impliedSubheadings": [], "coreClinicalConcept": "", "englishCoreTerms": [] },
    "o": { "axisRole": "induced_syndrome | clinical_condition", "impliedSubheadings": [], "coreClinicalConcept": "", "englishCoreTerms": [] },
    "not": { "axisRole": "clinical_condition", "impliedSubheadings": [], "coreClinicalConcept": "", "englishCoreTerms": [] },
    "recommendedActivePico": { "p": true, "i": true, "c": false, "o": true, "not": false }
  },
  "confidence": 95,
  "reasoning": "Justification méthodologique concise en 1 phrase."
}

Texte clinique :
"""
${rawText}
"""`;

  const rawResponse = await queryAiModel(prompt, system, 'fast');
  if (!rawResponse || !rawResponse.trim()) {
    throw new Error(
      mapErrorToUserMessage(
        !activeKey
          ? 'Clé API Cloud non configurée.'
          : "Le modèle IA a renvoyé une réponse vide lors de la structuration PICO/PECO."
      )
    );
  }

  const stripParensFromExtractedPico = (val: string) =>
    sanitizePicoConcept((val || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());

  const parsed = extractJsonFromLlmResponse<Record<string, unknown>>(rawResponse);
  if (!parsed || (!parsed.p && !parsed.i && !parsed.o)) {
    throw new Error(
      "La réponse du modèle IA n'a pas pu être interprétée comme une structure JSON PICO/PECO valide. Veuillez réessayer."
    );
  }

  const approach: 'pico' | 'peco' | undefined =
    typeof parsed.approach === 'string' && parsed.approach.toLowerCase() === 'peco'
      ? 'peco'
      : typeof parsed.approach === 'string' && parsed.approach.toLowerCase() === 'pico'
        ? 'pico'
        : undefined;

  const pClean = stripParensFromExtractedPico(String(parsed.p || ''));
  let iClean = stripParensFromExtractedPico(String(parsed.i || ''));
  const cClean = stripParensFromExtractedPico(String(parsed.c || ''));
  const rawOClean = stripParensFromExtractedPico(String(parsed.o || ''));
  const oClean = stripIatrogenicTermsFromOutcome(rawOClean);
  const notClean = stripParensFromExtractedPico(String(parsed.not || ''));

  // Si l'axe I est vide alors que l'axe O contenait un terme d'iatrogénie/pharmacovigilance, le transférer dans I
  if (!iClean && /\b(?:pharmacovigilance|iatrog[ée]n(?:ie|ique)|effets?\s+ind[ée]sirables?)\b/i.test(rawOClean)) {
    iClean = 'Effets indésirables médicamenteux, Pharmacovigilance';
  }

  const rawQuals =
    parsed.qualifications && typeof parsed.qualifications === 'object'
      ? (parsed.qualifications as Record<string, unknown>)
      : {};

  const pQual = sanitizeAxisQualification(rawQuals.p, 'P', pClean);
  const iQual = sanitizeAxisQualification(rawQuals.i, 'I', iClean);
  const cQual = sanitizeAxisQualification(rawQuals.c, 'C', cClean);
  const oQual = sanitizeAxisQualification(rawQuals.o, 'O', oClean);
  const notQual = sanitizeAxisQualification(rawQuals.not, 'NOT', notClean);

  const rawRecActive =
    rawQuals.recommendedActivePico && typeof rawQuals.recommendedActivePico === 'object'
      ? (rawQuals.recommendedActivePico as Record<string, unknown>)
      : null;

  // COURT-CIRCUIT FORCÉ (Hard Drop) : passive_comparator et demographic_unrestricted forcent l'inactivation
  const recommendedActivePico = {
    p:
      pQual.axisRole === 'demographic_unrestricted'
        ? false
        : rawRecActive && typeof rawRecActive.p === 'boolean'
          ? rawRecActive.p
          : Boolean(pClean),
    i: Boolean(iClean),
    c:
      cQual.axisRole === 'passive_comparator'
        ? false
        : rawRecActive && typeof rawRecActive.c === 'boolean'
          ? rawRecActive.c && Boolean(cClean)
          : Boolean(cClean),
    o: Boolean(oClean),
    not: Boolean(notClean)
  };

  return {
    ...(approach ? { approach } : {}),
    p: pClean,
    i: iClean,
    c: cClean,
    o: oClean,
    not: notClean,
    qualifications: {
      p: pQual,
      i: iQual,
      c: cQual,
      o: oQual,
      not: notQual,
      recommendedActivePico
    },
    source: resolvedProvider,
    modelUsed,
    confidence: typeof parsed.confidence === 'number' ? Math.min(100, Math.max(50, parsed.confidence)) : 95,
    reasoning:
      typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
        ? parsed.reasoning.trim()
        : 'Structuration PICO/PECO générée par IA'
  };
}

const AUDIT_AGENT_SYSTEM_PROMPT = `Tu es un méthodologiste senior en recherche documentaire biomédicale, expert des référentiels PRISMA 2020, PRISMA-S, de la grille PRESS 2015 et du Cochrane Handbook.
Tes évaluations et recommandations doivent respecter SANS EXCEPTION les critères méthodologiques suivants :

1. COMPARATEUR PASSIF & DÉMOGRAPHIE OUVERTE (Cochrane Handbook, Chap. 4) :
   - Il est FORMELLEMENT INTERDIT de reprocher à une équation l'absence de l'axe Comparateur (C) lorsqu'il s'agit d'un comparateur passif ("Absence d'exposition", "Placebo", "Soins courants", "Alimentation habituelle").
   - Il est FORMELLEMENT INTERDIT de reprocher l'absence de restriction démographique ("Adult"[Mesh], "Primary Health Care"[Mesh], "France"[Mesh]) dans une revue d'épidémiologie ou de pharmacovigilance : ces critères d'éligibilité se vérifient lors du dépouillement (screening) et jamais par un opérateur AND restrictif.

2. PRÉSERVATION DES NOTICES RÉCENTES & FILTRE ANIMAL NON DESTRUCTIF (Cochrane Handbook) :
   - Ne recommande JAMAIS d'ajouter 'AND "Humans"[Mesh]' ou 'AND "Adult"[Mesh]', car cela supprime les articles récents In-Process / Publisher non encore indexés par la NLM. Si une exclusion animale est nécessaire, seule la formule Cochrane 'NOT ("Animals"[Mesh] NOT "Humans"[Mesh])' ou le tri au dépouillement est autorisé.

3. SÉPARATION ONTOLOGIQUE PAR TREE NUMBER NLM (Axe I ≠ Axe O) :
   - L'Axe O (Outcome/Pathologie) ne doit contenir QUE des descripteurs de maladies ou syndromes (Tree Numbers C ou F03, ex: "Parkinson Disease, Secondary/chemically induced"[Mesh]).
   - L'Axe I/E (Intervention/Exposition) ne doit contenir QUE des substances en [tw], classes thérapeutiques, techniques ou concepts d'iatrogénie/pharmacovigilance (Tree Numbers D, E, N, I02).
   - Signale immédiatement toute incohérence ontologique (ex: "Exhibitions"[Mesh], ou présence de "Pharmacovigilance" dans le bloc O).

4. HIÉRARCHIE DES SOUS-DESCRIPTEURS & TRONCATURES DÉRIVATIONNELLES (PRESS 2015) :
   - Lorsqu'un descripteur qualifié est utilisé (ex: "Parkinson Disease, Secondary/chemically induced"[Mesh]), le descripteur parent nu ("Parkinson Disease, Secondary"[Mesh]) NE DOIT PAS apparaître en OR dans le même bloc ($D \\lor D/q \\equiv D$).
   - Sur un syndrome secondaire ou éponyme (ex: parkinsonisme), seules les troncatures dérivées (parkinsonis*[tiab], parkinsonian*[tiab]) sont valides ; une troncature trop large sur le nom propre (parkinson*[tiab]) génère du bruit idiopathique.
   - Toute troncature < 5 caractères ou placée entre guillemets ("terme*"[tiab]) est invalide selon les recommandations PRESS 2015.

5. PRÉCAUTION SUR L'OPÉRATEUR D'EXCLUSION 'NOT' (Cochrane Handbook) :
   - Ne recommande JAMAIS d'exclure par 'NOT' d'anciens médicaments ou la maladie idiopathique, car cela éliminerait les études comparatives mixtes pertinentes.

6. RÉDACTION SOBRE, ACADÉMIQUE ET CALIBRATION STRICTE DES SÉVÉRITÉS :
   - Rédige toutes tes observations et recommandations dans un style scientifique sobre, neutre et académique, en t'appuyant exclusivement sur les référentiels méthodologiques reconnus (Cochrane Handbook, grille PRESS 2015, PRISMA-S, PRISMA 2020).
   - Ne mentionne JAMAIS de nom d'application logicielle, de fichier interne, ni de règles ou numéros de lois internes (interdiction absolue d'écrire « Loi 1 », « Loi 2 », « Loi 4 », « constitution », etc.).
   - N'insère JAMAIS d'emojis (✅, ⚠️, 🔴, ❌, 💡) dans le champ "text" des observations ni dans "recommendations" : exprime la criticité uniquement via "severity" ("ok" | "info" | "warning").
   - INTERDICTION D'HALLUCINER DES DÉFAUTS DÉJÀ GARANTIS PAR LE MOTEUR : Ne commente JAMAIS la longueur des troncatures (le moteur garantit >= 5 caractères), ni l'équilibre des parenthèses ou guillemets. L'association "[Mesh]" OR "[tiab]" est une exigence méthodologique PRESS 2015 / PRISMA-S pour capter les notices récentes non indexées : ne la qualifie JAMAIS de redondance.
   - Calibration stricte des 3 niveaux de sévérité :
     * "ok" : critère méthodologique validé.
     * "info" : toute remarque de dépouillement / vigilance au screening (ex. présence de revues narratives, d'études médico-économiques, hétérogénéité attendue d'une stratégie à haute sensibilité) ou suggestion facultative.
     * "warning" : UNIQUEMENT un défaut objectif et corrigible dans l'équation (concept clinique majeur ou DCI explicite manquant, bruit massif sur une troncature ambiguë, opérateur NOT destructif sur études mixtes, formule chimique IUPAC brute en [tiab]).

7. INTERDICTION STRICTE D'HALLUCINER DES DESCRIPTEURS [Mesh] (Conformité NLM / HeTOP) :
   - Ne cite et ne recommande JAMAIS une chaîne '...'[Mesh] ou "..."[Mesh] comme descripteur NLM existant à ajouter si elle ne figure PAS dans la liste des descripteurs MeSH validés fournis dans le contexte, ou si le terme figure dans les échecs de résolution (0 résultat NLM).
   - Si un axe actif ne possède aucun descripteur MeSH validé, diagnostique une probable sur-spécification du concept (ex. adjectifs de chronicité, sévérité, caractère non spécifique ou localisation fine non pré-coordonnés dans le thésaurus MeSH) et recommande d'élargir vers la racine conceptuelle parente à faire résoudre via NLM, sans jamais fabriquer de balise [Mesh] non vérifiée.
   - INTERDICTION ABSOLUE de répéter une recommandation portant sur un terme déjà signalé comme introuvable dans NLM (0 résultat NLM).

8. CONTRAT DE SORTIE :
   - Réponds EXCLUSIVEMENT en JSON valide respectant le schéma attendu, avec temperature: 0.1.`;

export interface PreviousAuditContext {
  readonly iteration: number;
  readonly previousWarnings: readonly string[];
  readonly changesSummary?: string;
}

export interface AxisMeshResolutionSummary {
  readonly axis: 'P' | 'I' | 'C' | 'O' | 'NOT';
  readonly validatedDescriptors: readonly string[];
  readonly unresolvedTerms: readonly string[];
}

/**
 * AGENT D'AUDIT MÉTHODOLOGIQUE : Évaluation qualitative selon PRESS 2015, PRISMA-S et Cochrane Handbook
 */
export async function aiAuditAndCritiqueQuery(
  pico: { p: string; i: string; c: string; o: string; not?: string },
  pubmedQuery: string,
  mappedDescriptors: string[],
  articleCount: number,
  sampleArticleTitles: string[],
  previousAudit?: PreviousAuditContext,
  stratifiedTitles?: StratifiedTitleSample,
  meshResolutionByAxis?: readonly AxisMeshResolutionSummary[]
): Promise<(CritiqueReport & { observations: AuditObservationItem[] }) | null> {
  const hasStratified =
    Boolean(stratifiedTitles) &&
    ((stratifiedTitles?.top.length ?? 0) > 0 ||
      (stratifiedTitles?.middle.length ?? 0) > 0 ||
      (stratifiedTitles?.tail.length ?? 0) > 0);

  const formattedSampleSection = hasStratified && stratifiedTitles
    ? [
        `ÉCHANTILLON STRATIFIÉ BEST MATCH (Tête / Milieu / Queue — 30 titres max) :`,
        `[Strate Tête — cœur le plus pertinent (${stratifiedTitles.top.length} titres)]`,
        ...stratifiedTitles.top.map((t, idx) => `  ${idx + 1}. ${t}`),
        ...(stratifiedTitles.middle.length > 0
          ? [
              `[Strate Milieu — milieu du classement (${stratifiedTitles.middle.length} titres)]`,
              ...stratifiedTitles.middle.map((t, idx) => `  ${idx + 1}. ${t}`)
            ]
          : []),
        ...(stratifiedTitles.tail.length > 0
          ? [
              `[Strate Queue — fin de classement (${stratifiedTitles.tail.length} titres)]`,
              ...stratifiedTitles.tail.map((t, idx) => `  ${idx + 1}. ${t}`)
            ]
          : []),
        `Règle d'interprétation des strates : une hétérogénéité résiduelle uniquement dans la strate Queue est normale pour une requête sensible (vigilance de screening) et relève impérativement de "info", jamais de "warning", dès lors que les strates Tête et Milieu sont cohérentes avec le PICO.`
      ].join('\n')
    : `ÉCHANTILLON DES TITRES REMONTÉS :\n${sampleArticleTitles.slice(0, 10).map((t, idx) => `${idx + 1}. ${t}`).join('\n')}`;

  const deltaSection =
    previousAudit && previousAudit.iteration >= 2
      ? `
MODE AUDIT DELTA (ITÉRATION ${previousAudit.iteration}) :
Un audit précédent (V1) a déjà été effectué.
${
  previousAudit.changesSummary
    ? `Modifications appliquées entre V1 et V2 :\n${previousAudit.changesSummary}\n`
    : ''
}${
  previousAudit.previousWarnings.length > 0
    ? `Warnings signalés en V1 :\n${previousAudit.previousWarnings.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n`
    : 'Aucun warning critique signalé en V1.\n'
}RÈGLE STRICTE EN MODE DELTA :
- Vérifie en priorité si les warnings de V1 ont été corrigés.
- Ne signale en "warning" QUE d'éventuels warnings de V1 non résolus ou une régression réelle introduite par V2 (ex. perte d'un concept ou DCI présent en V1, chute brutale de sensibilité).
- INTERDICTION D'INVENTER DE NOUVEAUX WARNINGS COSMÉTIQUES sur des éléments déjà présents et valides en V1 (les remarques générales de dépouillement doivent impérativement être classées en "info").
`
      : '';

  const meshResolutionSection =
    meshResolutionByAxis && meshResolutionByAxis.length > 0
      ? [
          `ÉTAT DE LA RÉSOLUTION OFFICIELLE HeTOP / NCBI MeSH PAR AXE :`,
          ...meshResolutionByAxis.map((entry) => {
            const validList =
              entry.validatedDescriptors.length > 0
                ? entry.validatedDescriptors.map((d) => `"${d}"`).join(', ')
                : 'AUCUN (axe en texte libre uniquement)';
            const failedList =
              entry.unresolvedTerms.length > 0
                ? entry.unresolvedTerms.map((t) => `"${t}"`).join(', ')
                : 'aucun';
            return `- Axe ${entry.axis} : MeSH validés = [${validList}] | Termes introuvables dans NLM (0 résultat) = [${failedList}]`;
          }),
          `Règle anti-hallucination : ne recommande JAMAIS un descripteur [Mesh] absent des MeSH validés ci-dessus ni un terme listé en 0 résultat NLM.`
        ].join('\n')
      : '';

  const prompt = `Audite la stratégie de recherche PubMed ci-dessous selon la grille PRESS 2015, les recommandations PRISMA-S et le Cochrane Handbook.

CADRAGE CLINIQUE PICO/PECO :
- Population (P) : "${pico.p}"
- Intervention / Exposition (I/E) : "${pico.i}"
- Comparateur (C) : "${pico.c}"
- Critère de jugement (O) : "${pico.o}"
- Exclusion (NOT) : "${pico.not || 'Aucun'}"

ÉQUATION PUBMED ÉVALUÉE :
"""
${pubmedQuery}
"""

DESCRIPTEURS MeSH ACTIFS : [${mappedDescriptors.join(', ')}]
${meshResolutionSection ? `${meshResolutionSection}\n` : ''}VOLUMÉTRIE PUBMED : ${articleCount} notices
${formattedSampleSection}
${deltaSection}
GRILLE D'AUDIT QUALITATIF (PRESS 2015 / PRISMA-S / Cochrane Handbook) :
1. Cohérence ontologique (Tree Numbers NLM C/F03 sur O ; D/E/N sur I ; absence d'intrus sémantiques).
2. Hiérarchie des sous-descripteurs (/chemically induced, /adverse effects) sans redondance avec le descripteur parent nu.
3. Couverture exacte des substances actives en texte libre ([tw]/[tiab]) et absence de formules chimiques IUPAC brutes.
4. Pertinence clinique des titres remontés au regard du volume (${articleCount} articles) et des axes ACTIFS uniquement (ne jamais reprocher l'absence d'un axe vide ou désactivé).
5. Vérification qu'aucun filtre restrictif ("Humans"[Mesh], "Adult"[Mesh], comparateur passif en AND, ou NOT excessif) n'entrave la sensibilité de la recherche.

Note : Les contrôles techniques déterministes (longueur >= 5 car. des troncatures, équilibre syntaxique) sont déjà garantis. Concentre-toi exclusivement sur l'analyse qualitative clinique et méthodologique, avec une rédaction sobre et académique appuyée uniquement sur le Cochrane Handbook, la grille PRESS 2015 et PRISMA-S.
Interdiction absolue d'insérer des emojis (✅, ⚠️, 🔴, ❌, 💡) dans "text" ou "recommendations" : utilise "severity": "ok", "info" ou "warning".

Réponds STRICTEMENT au format JSON suivant :
{
  "observations": [
    {
      "severity": "ok",
      "text": "Observation méthodologique sobre validant un point conforme aux standards PRESS 2015, PRISMA-S ou Cochrane Handbook."
    },
    {
      "severity": "info",
      "text": "Remarque de vigilance au dépouillement (ex. présence de revues narratives ou hétérogénéité normale d'une requête sensible) ou suggestion facultative."
    },
    {
      "severity": "warning",
      "text": "Défaut objectif et corrigible dans l'équation (uniquement si un problème réel subsiste)."
    }
  ],
  "recommendations": [
    "Recommandation actionnable sobre conforme au Cochrane Handbook et à PRESS 2015 (laisser vide [] si aucun warning)."
  ]
}`;

  const rawResponse = await queryAiModel(prompt, AUDIT_AGENT_SYSTEM_PROMPT, 'reasoning');
  if (!rawResponse || !rawResponse.trim()) {
    throw new Error("Le modèle IA a renvoyé une réponse vide lors de l'audit méthodologique.");
  }

  const parsed = extractJsonFromLlmResponse<{
    score?: number;
    observations?: unknown[];
    recommendations?: unknown[];
  }>(rawResponse);
  if (!parsed || !Array.isArray(parsed.observations)) {
    throw new Error("La réponse de l'audit IA n'a pas pu être interprétée comme un JSON valide.");
  }

  const config = getAiConfig();
  const evaluatorModel = resolveActiveModelForTask(config, 'reasoning');
  const normalizedObservations = normalizeAuditObservations(parsed.observations);
  const cleanRecommendations = Array.isArray(parsed.recommendations)
    ? parsed.recommendations
        .map((r) => stripLeadingObservationEmojis(String(r || '')))
        .filter((r) => r.length > 0)
    : [];

  return {
    score: typeof parsed.score === 'number' ? Math.min(100, Math.max(0, parsed.score)) : 0,
    observations: normalizedObservations,
    recommendations: cleanRecommendations,
    source: config.provider,
    evaluatorModel
  };
}

export type PrismaExclusionCategory =
  | 'population'
  | 'intervention'
  | 'comparator'
  | 'outcome'
  | 'study_design'
  | 'preclinical'
  | 'other';

export const PRISMA_EXCLUSION_CATEGORY_KEYS: readonly PrismaExclusionCategory[] = [
  'population',
  'intervention',
  'comparator',
  'outcome',
  'study_design',
  'preclinical',
  'other'
];

export const PRISMA_EXCLUSION_LABELS_FR: Readonly<Record<PrismaExclusionCategory, string>> = {
  population: 'Population hors périmètre',
  intervention: 'Intervention / Exposition non conforme',
  comparator: 'Comparateur non conforme',
  outcome: 'Critère de jugement absent ou hors périmètre',
  study_design: 'Plan d\'étude exclu (revue narrative, éditorial, protocole, cas isolé)',
  preclinical: 'Modèle préclinique (animal ou in vitro)',
  other: 'Autre motif d\'exclusion'
};

/**
 * Résout une clé ou un motif d'exclusion brut vers l'une des 7 catégories PRISMA standardisées.
 */
export function resolvePrismaExclusionCategory(
  rawCategory?: string,
  rawReason?: string
): PrismaExclusionCategory {
  const catNorm = (rawCategory || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (
    catNorm === 'population' ||
    catNorm === 'intervention' ||
    catNorm === 'comparator' ||
    catNorm === 'outcome' ||
    catNorm === 'study_design' ||
    catNorm === 'preclinical' ||
    catNorm === 'other'
  ) {
    return catNorm;
  }

  const combined = `${rawCategory || ''} ${rawReason || ''}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/\b(?:animal|murin|rat|mouse|mice|in\s+vitro|preclin|cellul|ex\s+vivo|cadaver)\b/.test(combined)) {
    return 'preclinical';
  }
  if (/\b(?:editorial|lettre|letter|revue\s+narrative|narrative\s+review|protocole|protocol|cas\s+clinique|case\s+report|plan\s+d['’]etude|study\s+design|comment|hors\s+format|sans\s+donnees\s+originales|congres)\b/.test(combined)) {
    return 'study_design';
  }
  if (/\b(?:comparateur|comparator|temoin|controle|control\s+group)\b/.test(combined)) {
    return 'comparator';
  }
  if (/\b(?:critere\s+de\s+jugement|outcome|endpoint)\b/.test(combined)) {
    return 'outcome';
  }
  if (/\b(?:intervention|exposition|exposure|traitement|molecule|medicament|dispositif|non\s+conforme)\b/.test(combined)) {
    return 'intervention';
  }
  if (/\b(?:population|pediatri|enfant|age|pathologie\s+hors|hors\s+perimetre)\b/.test(combined)) {
    return 'population';
  }
  return 'other';
}

export function formatPrismaExclusionReason(rawCategory?: string, rawReason?: string): string {
  return PRISMA_EXCLUSION_LABELS_FR[resolvePrismaExclusionCategory(rawCategory, rawReason)];
}

export const SCREENING_GEMINI_RESPONSE_SCHEMA: GeminiSchemaProperty = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      pmid: { type: 'STRING' },
      status: { type: 'STRING', enum: ['included', 'maybe', 'excluded'] },
      exclusionCategory: {
        type: 'STRING',
        enum: [...PRISMA_EXCLUSION_CATEGORY_KEYS],
        nullable: true
      },
      evidenceSnippet: { type: 'STRING' }
    },
    required: ['pmid', 'status', 'evidenceSnippet']
  }
};

/**
 * Parseur JSON défensif dédié au pré-dépouillement par lot :
 * - retire les éventuels blocs Markdown (```json / ```) et caractères de contrôle non échappés ;
 * - isole la sous-chaîne entre le premier `[` et le dernier `]` (avec repli objet wrapper / tableau tronqué) ;
 * - valide strictement chaque entrée (`pmid` non vide et `status` parmi included | maybe | excluded).
 */
export function parseScreeningResponse(rawResponse: string): BatchScreenItemResult[] {
  if (!rawResponse || !rawResponse.trim()) {
    return [];
  }

  // 1. Nettoyage défensif : blocs Markdown et caractères de contrôle non échappés
  const withoutFences = rawResponse
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  let cleaned = '';
  for (let idx = 0; idx < withoutFences.length; idx++) {
    const code = withoutFences.charCodeAt(idx);
    const isUnsafeControl = (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
    cleaned += isUnsafeControl ? ' ' : withoutFences[idx];
  }
  cleaned = cleaned.trim();

  let parsed: unknown = null;

  // 2. Extraction prioritaire de la sous-chaîne entre le premier `[` et le dernier `]`
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const arraySlice = cleaned.slice(firstBracket, lastBracket + 1);
    try {
      parsed = JSON.parse(arraySlice);
    } catch {
      // Si un retour à la ligne brut subsiste dans une chaîne, le remplacer par un espace
      try {
        parsed = JSON.parse(arraySlice.replace(/\r?\n/g, ' '));
      } catch {
        parsed = null;
      }
    }
  }

  // 3. Repli sur le parseur générique (gère les wrappers objets OpenAI {"results": [...]} et tableaux tronqués)
  if (parsed === null) {
    cleaned = cleaned.replace(/\r?\n/g, ' ');
    parsed = extractJsonFromLlmResponse<unknown>(cleaned);
  }

  let rawItems: Array<Record<string, unknown>> = [];
  if (Array.isArray(parsed)) {
    rawItems = parsed as Array<Record<string, unknown>>;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const candidateArray =
      obj.results ?? obj.articles ?? obj.evaluations ?? obj.decisions ?? obj.items ?? obj.data;
    if (Array.isArray(candidateArray)) {
      rawItems = candidateArray as Array<Record<string, unknown>>;
    } else if ('pmid' in obj && 'status' in obj) {
      rawItems = [obj];
    }
  }

  const validItems: BatchScreenItemResult[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const rawPmid = String(item.pmid ?? '').trim();
    const normalizedPmid = rawPmid.replace(/\D+/g, '') || rawPmid;
    const normalizedStatus = String(item.status ?? '').toLowerCase().trim();
    if (
      !normalizedPmid ||
      (normalizedStatus !== 'included' && normalizedStatus !== 'maybe' && normalizedStatus !== 'excluded')
    ) {
      continue;
    }

    const rawCat = typeof item.exclusionCategory === 'string' ? item.exclusionCategory.trim() : undefined;
    const rawReason = typeof item.exclusionReason === 'string' ? item.exclusionReason.trim() : undefined;
    const exclusionCategory =
      normalizedStatus === 'excluded'
        ? resolvePrismaExclusionCategory(rawCat, rawReason)
        : undefined;
    const snippetClean =
      typeof item.evidenceSnippet === 'string'
        ? item.evidenceSnippet.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
        : undefined;

    validItems.push({
      pmid: normalizedPmid,
      status: normalizedStatus,
      exclusionCategory,
      exclusionReason:
        normalizedStatus === 'excluded' && exclusionCategory
          ? PRISMA_EXCLUSION_LABELS_FR[exclusionCategory]
          : undefined,
      evidenceSnippet: snippetClean || undefined
    });
  }

  return validItems;
}

export interface BatchScreenItemResult {
  pmid: string;
  status: 'included' | 'maybe' | 'excluded';
  exclusionCategory?: PrismaExclusionCategory;
  exclusionReason?: string;
  evidenceSnippet?: string;
}

/**
 * Compression clinique des résumés PubMed avant envoi au LLM.
 * Supprime les déclarations administratives (conflits d'intérêts, financements, droits d'auteur, affiliations)
 * pour économiser ~20 % de tokens d'entrée tout en préservant les numéros NCT/PROSPERO utiles au RoB 2.
 */
export function compressAbstractForLlm(rawAbstract: string, maxChars = 1200): string {
  if (!rawAbstract) return 'Aucun résumé disponible.';
  let cleaned = rawAbstract
    .replace(/\r?\n/g, ' ')
    .replace(/\b(?:conflict(?:s)?\s+of\s+interest|competing\s+interests?|funding\s+statement|disclosures?|acknowledg(?:e)?ments?|author\s+contributions?)\s*:[^.]*\./gi, ' ')
    .replace(/©\s*\d{4}[^.]*\./g, ' ')
    .replace(/\b(?:copyright|all\s+rights\s+reserved)\b[^.]*\./gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Aucun résumé disponible.';
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned;
}

/**
 * Empreinte déterministe du PICO et Cache d'Idempotence de Screening.
 * Évite de relancer un appel API si le même PMID est ré-évalué avec le même cadrage PICO.
 */
export function computePicoFingerprint(pico: { p: string; i: string; c: string; o: string; not?: string }): string {
  return [
    (pico.p || '').trim().toLowerCase(),
    (pico.i || '').trim().toLowerCase(),
    (pico.c || '').trim().toLowerCase(),
    (pico.o || '').trim().toLowerCase(),
    (pico.not || '').trim().toLowerCase()
  ].join('|');
}

const screeningDecisionCache = new Map<string, BatchScreenItemResult>();

export function clearAiScreeningCache(): void {
  screeningDecisionCache.clear();
}

/**
 * AGENT DE SCREENING PAR LOTS (Routé sur le tier 'batch' : Flash / GPT-4o-mini / Haiku) :
 * Évaluation clinique simultanée des articles PubMed avec cache d'idempotence.
 * Respecte le principe de précaution Cochrane : l'absence de résumé ou une incertitude au stade titre/résumé
 * classe la référence en 'maybe' (À vérifier sur texte intégral) plutôt qu'en exclusion abusive.
 */
export async function aiScreenBatchArticles(
  articles: Array<{ pmid: string; title: string; abstract: string; meshHeadings?: string[] }>,
  pico: { p: string; i: string; c: string; o: string; not?: string },
  abortSignal?: AbortSignal
): Promise<BatchScreenItemResult[]> {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
  if (!articles || articles.length === 0) return [];

  const picoFp = computePicoFingerprint(pico);
  const cachedResults: BatchScreenItemResult[] = [];
  const uncachedArticles: Array<{ pmid: string; title: string; abstract: string; meshHeadings?: string[] }> = [];

  for (const art of articles) {
    const key = `${String(art.pmid).trim()}::${picoFp}`;
    const hit = screeningDecisionCache.get(key);
    if (hit) {
      cachedResults.push(hit);
    } else {
      uncachedArticles.push(art);
    }
  }

  if (uncachedArticles.length === 0) {
    return cachedResults;
  }

  const prompt = `Tu es un médecin méthodologiste senior expert en revues systématiques (directives PRISMA 2020 et Cochrane Handbook).
Évalue l'éligibilité clinique de cette série de ${uncachedArticles.length} articles PubMed pour notre revue systématique.

CRITÈRES D'ÉLIGIBILITÉ (PICO/PECO) :
- Population cible (P) : "${pico.p}"
- Intervention / Exposition cible (I/E) : "${pico.i}"
- Comparateur (C) : "${pico.c || 'Non spécifié'}"
- Critère de jugement (O) : "${pico.o || 'Non spécifié'}"
- Critères d'exclusion formels (NOT) : "${pico.not || 'Aucun'}"

DIRECTIVES MÉDICALES D'ÉVALUATION (3 STATUTS : included, maybe, excluded) :
1. "excluded" : Uniquement si une cause d'inéligibilité formelle est établie avec certitude dès le titre/résumé (modèle exclusivement animal/in vitro, hors sujet manifeste, critère NOT présent, éditorial sans données originales).
2. "maybe" (À vérifier sur texte intégral) : Principe de précaution Cochrane — si le résumé est absent ou si l'information au stade titre/résumé est insuffisante pour trancher avec certitude sur un sous-groupe ou un critère.
3. "included" : Si la population, l'intervention/exposition et le critère concordent clairement avec le PICO.
4. Résume de manière ultra-concise en français (max 10-12 mots) la preuve clinique dans "evidenceSnippet".
5. UNIQUEMENT si status === "excluded", renseigne "exclusionCategory" avec EXACTEMENT l'une de ces 7 clés PRISMA standardisées :
   - "population" (population ou pathologie hors périmètre)
   - "intervention" (intervention / exposition non conforme)
   - "comparator" (comparateur non conforme)
   - "outcome" (critère de jugement absent ou hors périmètre)
   - "study_design" (revue narrative, éditorial, lettre, protocole sans résultats, cas clinique isolé)
   - "preclinical" (modèle animal, in vitro ou cellulaire)
   - "other" (autre motif d'exclusion)

ARTICLES PUBMED À ÉVALUER :
${uncachedArticles.map((a, idx) => `
--- NOTICE [${idx + 1}/${uncachedArticles.length}] ---
PMID: ${a.pmid}
Titre: ${a.title}
Résumé: ${compressAbstractForLlm(a.abstract, 850)}
MeSH: ${(a.meshHeadings || []).slice(0, 8).join(', ') || "Non indexé"}
`).join('\n')}

Réponds STRICTEMENT par un tableau JSON valide contenant exactement un objet pour chaque PMID évalué :
[
  {
    "pmid": "${uncachedArticles[0]?.pmid || '12345'}",
    "status": "included",
    "evidenceSnippet": "ECR évaluant la population cible avec résultats concordants."
  },
  {
    "pmid": "99999999",
    "status": "excluded",
    "exclusionCategory": "preclinical",
    "evidenceSnippet": "Étude exclusivement animale sur modèle murin."
  }
]`;

  const system =
    "Tu es un évaluateur clinique strict pour une revue systématique médicale. Réponds exclusivement en JSON valide sous la forme d'un tableau d'objets. Rédige chaque evidenceSnippet en une seule ligne courte, sans retour à la ligne et sans guillemets doubles à l'intérieur du texte.";
  const rawResponse = await queryAiModel(prompt, system, 'batch', abortSignal, {
    maxOutputTokens: 8192,
    geminiResponseSchema: SCREENING_GEMINI_RESPONSE_SCHEMA
  });
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
  if (!rawResponse || !rawResponse.trim()) {
    throw new ScreeningJsonParseError("Le modèle IA a renvoyé une réponse vide lors du dépouillement.");
  }

  const validFresh = parseScreeningResponse(rawResponse);
  if (validFresh.length > 0) {
    for (const cleanItem of validFresh) {
      screeningDecisionCache.set(`${cleanItem.pmid}::${picoFp}`, cleanItem);
    }
    return [...cachedResults, ...validFresh];
  }

  throw new ScreeningJsonParseError("La réponse du modèle IA n'a pas pu être interprétée comme un JSON de dépouillement valide.");
}

export interface AuditRefinementResult {
  refinedPico: { p: string; i: string; c: string; o: string; not?: string };
  activePico?: { p?: boolean; i?: boolean; c?: boolean; o?: boolean; not?: boolean };
  qualifications?: PicoSemanticQualifications;
  strategy?: 'sensitive' | 'balanced' | 'specific';
  explanation: string;
}

function sanitizeAtomicConceptList(raw: unknown): NormalizedAtomicConcept[] {
  if (!Array.isArray(raw)) return [];
  const results: NormalizedAtomicConcept[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const conceptEn = String(obj.conceptEn || '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/["“”«»]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const conceptFr = String(obj.conceptFr || '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/["“”«»]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const broaderMeshRoot = String(obj.broaderMeshRoot || '')
      .replace(/\[[^\]]+\]/g, '')
      .replace(/["“”«»*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!conceptEn || conceptEn.length < 2) continue;

    const dedupKey = conceptEn.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const rawSyns = Array.isArray(obj.synonymsTiab) ? obj.synonymsTiab : [];
    const synonymsTiab = Array.from(
      new Set(
        rawSyns
          .map((s) =>
            String(s || '')
              .replace(/\[[^\]]+\]/g, '')
              .replace(/["“”«»*]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
          )
          .filter((s) => s.length >= 2)
      )
    ).slice(0, 6);

    const hasDistinctBroaderRoot =
      broaderMeshRoot.length >= 2 &&
      broaderMeshRoot.toLowerCase() !== conceptEn.toLowerCase();

    results.push({
      conceptFr: conceptFr || conceptEn,
      conceptEn,
      ...(hasDistinctBroaderRoot ? { broaderMeshRoot } : {}),
      synonymsTiab
    });
  }

  return results;
}

/**
 * Normalise directement chaque axe PICO/PECO actif en concepts biomédicaux atomiques
 * (`{ conceptFr, conceptEn, synonymsTiab }`) via le modèle rapide configuré :
 * - `conceptFr` court (1 à 4 mots) pour l'interrogation officielle HeTOP / CISMeF
 * - `conceptEn` en anglais pour la validation officielle NCBI Entrez (`db=mesh`)
 * - `synonymsTiab` pour les variantes texte libre `[tiab]`
 */
export async function aiNormalizePicoConcepts(
  axes: ReadonlyArray<{ readonly key: 'p' | 'i' | 'c' | 'o' | 'not'; readonly text: string }>
): Promise<NormalizedPicoConceptsMap> {
  const activeAxes = (axes || []).filter((a) => a.text && a.text.trim().length > 0);
  if (activeAxes.length === 0) return {};

  const axesBlock = activeAxes
    .map((a) => `- ${a.key.toUpperCase()} : "${a.text.trim()}"`)
    .join('\n');

  const system = `Tu es un médecin méthodologiste expert du thésaurus NLM MeSH, d'HeTOP/CISMeF et du Cochrane Handbook.
Décompose chaque axe PICO/PECO fourni en concepts biomédicaux atomiques prêts pour la validation officielle HeTOP (français court) et NCBI Entrez db=mesh (anglais).
Règles méthodologiques PRISMA / Cochrane impératives :
1. Pour chaque concept atomique, renvoie :
   - "conceptFr" : terme médical français court (1 à 4 mots maximum, sans phrase narrative ni posologie) adapté à HeTOP.
   - "conceptEn" : concept biomédical anglais canonique (sans balises [Mesh]/[tiab] ni opérateurs booléens) adapté à NCBI Entrez.
   - "broaderMeshRoot" (optionnel, chaîne anglaise courte) : lorsque le concept clinique comporte des qualificatifs (chronicité, stade, sévérité, caractère non spécifique, étiologie secondaire, localisation fine), renseigne la racine nosologique ou thérapeutique canonique anglaise la plus directe susceptible d'exister comme descripteur officiel NLM (ex. "Low Back Pain" pour "chronic non-specific low back pain", "Heart Failure" pour "severe refractory heart failure"), tout en conservant les variantes précises dans "conceptEn" et "synonymsTiab". Si "conceptEn" est déjà une racine simple sans qualificatif, omets "broaderMeshRoot" ou laisse "".
   - "synonymsTiab" : 1 à 5 synonymes ou abréviations anglaises utiles en texte libre [tiab] (incluant les variantes précises qualifiées).
2. Axe P (Population / Pathologie cible) — Règles Cochrane / PRESS :
   - Lorsqu'une pathologie ou condition clinique est présente dans P, n'émets AUCUN critère démographique générique ni check tag non discriminant (population adulte générale, humains, âge moyen) : ils relèvent du dépouillement, et l'exclusion animale est déjà gérée par le filtre Cochrane.
   - Comme tous les concepts retournés dans un même axe P sont reliés par OR dans l'équation, si une sous-population clinique spécifique est mentionnée (ex. pédiatrie, gériatrie, grossesse), ne l'émets JAMAIS comme concept séparé dans le même groupe OR que la pathologie (ce qui détruirait la spécificité de la recherche) : n'émets que la pathologie ou condition clinique cible dans P et reporte ce critère d'âge ou de sous-population au dépouillement.
3. Axes I (Intervention/Exposition) et C (Comparateur) : extrais UNIQUEMENT la substance active, le produit biologique, le dispositif ou la procédure spécifique. N'émets JAMAIS un concept séparé pour une simple voie d'administration ou un terme générique (ex. pas de "Injections, Intra-Articular", "Oral Administration", "Therapeutics", "Treatment", "Therapy" ou "Pharmaceutical Preparations") qui polluerait le bloc OR.
4. Axe O (Outcome) : sépare chaque critère de jugement distinct en un concept atomique dédié (ex. douleur vs fonction articulaire).
5. Ne mets jamais de balises techniques ([Mesh], [tiab], *) ni d'opérateurs AND/OR dans les chaînes.
Réponds EXCLUSIVEMENT en JSON valide.`;

  const prompt = `Normalise les axes PICO/PECO suivants au format JSON strict :
${axesBlock}

Format JSON attendu (inclure uniquement les clés d'axes fournies ci-dessus) :
{
  "p": [
    { "conceptFr": "terme français court", "conceptEn": "Canonical English Concept", "broaderMeshRoot": "Broader NLM Root if qualified (optional)", "synonymsTiab": ["english synonym 1", "abbreviation"] }
  ],
  "i": [
    { "conceptFr": "substance ou procédure spécifique", "conceptEn": "Specific Active Concept", "broaderMeshRoot": "", "synonymsTiab": ["synonym 1", "abbrev"] }
  ],
  "o": [
    { "conceptFr": "critère 1", "conceptEn": "Outcome 1", "broaderMeshRoot": "", "synonymsTiab": ["synonym 1"] }
  ]
}`;

  const rawResponse = await queryAiModel(prompt, system, 'fast');
  if (!rawResponse || !rawResponse.trim()) {
    throw new Error("Le modèle IA a renvoyé une réponse vide lors de la normalisation des concepts MeSH.");
  }

  const parsed = extractJsonFromLlmResponse<Record<string, unknown>>(rawResponse);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error("La réponse de normalisation des concepts par l'IA n'est pas un JSON valide.");
  }

  const output: Record<'p' | 'i' | 'c' | 'o' | 'not', NormalizedAtomicConcept[]> = {
    p: [],
    i: [],
    c: [],
    o: [],
    not: []
  };

  let totalNormalized = 0;
  for (const axis of activeAxes) {
    const rawList = parsed[axis.key] ?? parsed[axis.key.toUpperCase()];
    const cleanList = sanitizeAtomicConceptList(rawList);
    if (cleanList.length > 0) {
      output[axis.key] = cleanList;
      totalNormalized += cleanList.length;
    }
  }

  if (totalNormalized === 0) {
    throw new Error("Aucun concept biomédical exploitable n'a pu être extrait par le modèle IA.");
  }

  const result: Partial<Record<'p' | 'i' | 'c' | 'o' | 'not', readonly NormalizedAtomicConcept[]>> = {};
  for (const axis of activeAxes) {
    if (output[axis.key].length > 0) {
      result[axis.key] = output[axis.key];
    }
  }
  return result;
}

/**
 * Découpe une chaîne par virgules ou points-virgules de premier niveau
 * sans jamais couper à l'intérieur de parenthèses équilibrées (ex: "(Diabetes Mellitus, Type 2)")
 * ni devant un qualificatif ", Type 2".
 */
function splitTopLevelPicoChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (depth === 0 && (ch === ';' || ch === '\n' || ch === ',')) {
      // Ne pas couper sur ", Type 2" ou ", Type II"
      const rest = text.slice(i + 1);
      if (ch === ',' && /^\s*Type\s+(?:\d+|[IVX]+)\b/i.test(rest)) {
        current += ch;
        continue;
      }
      if (current.trim()) chunks.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Nettoie une chaîne destinée à un champ PICO pour s'assurer qu'elle reste
 * en langage médical naturel et ne contient AUCUNE balise de recherche [Mesh], [TiAb]
 * ni opérateurs booléens complexes, tout en préservant les parenthèses MeSH équilibrées (ex: "(Myocardial Infarction)").
 */
export function sanitizePicoConcept(text: string): string {
  if (!text) return "";
  let s = text.trim();

  // 1. Supprimer les balises de champs PubMed / Embase / Cochrane : [Mesh], [TiAb], [pt], /exp, etc.
  s = s.replace(/\[(?:mesh|tiab|ti|majr|mh|pt|pdat|dp|sh)(?::noexp)?\]/gi, '');
  s = s.replace(/\/(?:exp|de)\b/gi, '');
  s = s.replace(/:(?:ti,ab,kw|ti,ab)\b/gi, '');

  // 2. Remplacer les opérateurs booléens isolés s'ils séparent des termes
  s = s.replace(/\b(?:OR|AND|NOT)\b/g, ',');

  // 3. Supprimer uniquement les guillemets (et les parenthèses vides ou déséquilibrées)
  s = s.replace(/["“”«»]/g, '');
  s = s.replace(/\(\s*\)/g, '');
  const openCount = (s.match(/\(/g) || []).length;
  const closeCount = (s.match(/\)/g) || []).length;
  if (openCount !== closeCount) {
    s = s.replace(/[()]/g, ' ');
  }

  // 4. Nettoyer les doublons et les périphrases narratives lourdes tout en respectant les parenthèses MeSH
  const rawChunks = splitTopLevelPicoChunks(s);
  const cleanedChunks: string[] = [];

  const heavyNarrativePrefix = /^(?:(?:chez\s+(?:les|des)\s+)?(?:patients?|adultes?|sujets?)\s+)?(?:en\s+pr[ée]vention\s+(?:primaire|secondaire|tertiaire)\s+(?:apr[èe]s|post[\s-]*|suite\s+[àa]|d['’]|de\s+l['’]|du|de\s+la|des|pour)\s+(?:un[e]?\s+|des\s+|l['’])?)/i;

  for (const rawChunk of rawChunks) {
    let chunk = rawChunk.replace(heavyNarrativePrefix, '').trim();
    // Si la chaîne contient plusieurs clauses annotées avec parenthèses séparées par " ou " / " or ", nettoyer chaque membre
    if (/\([^)]+\)\s+(?:ou|or)\s+/i.test(chunk)) {
      const subParts = chunk
        .split(/\s+(?:ou|or)\s+(?![^(]*\))/i)
        .map(p => p.replace(heavyNarrativePrefix, '').replace(/^(?:un[e]?\s+|des\s+)/i, '').trim())
        .filter(Boolean);
      for (const sp of subParts) {
        if (!cleanedChunks.some(c => c.toLowerCase() === sp.toLowerCase())) {
          cleanedChunks.push(sp);
        }
      }
    } else if (chunk && !cleanedChunks.some(c => c.toLowerCase() === chunk.toLowerCase())) {
      cleanedChunks.push(chunk);
    }
  }

  return cleanedChunks.join(', ');
}

/**
 * Optimisation itérative du workflow : l'IA locale (Ollama Qwen 2.5) ou Gemini intègre
 * les conseils de son propre audit pour perfectionner le cadrage PICO et les paramètres.
 */
export async function aiRefinePicoFromAudit(
  pico: { p: string; i: string; c: string; o: string; not?: string },
  activePico: { p?: boolean; i?: boolean; c?: boolean; o?: boolean; not?: boolean },
  critiqueReport: { score: number; observations: readonly AuditObservationEntry[]; recommendations: readonly string[] },
  currentQualifications?: PicoSemanticQualifications
): Promise<AuditRefinementResult | null> {
  const formattedObservations = normalizeAuditObservations(critiqueReport.observations)
    .map(o => `- [${o.severity.toUpperCase()}] ${o.text}`)
    .join('\n');
  const prompt = `Tu es un médecin méthodologiste expert en recherche clinique et revues systématiques.
Un audit critique vient d'évaluer la stratégie documentaire actuelle (Indice PRESS : ${critiqueReport.score}/100).

OBSERVATIONS DE L'AUDIT :
${formattedObservations}

RECOMMANDATIONS DE L'AUDIT :
${critiqueReport.recommendations.map(r => `- ${r}`).join('\n')}

PICO ACTUEL :
- P : "${pico.p}" (Actif: ${activePico.p !== false})
- I : "${pico.i}" (Actif: ${activePico.i !== false})
- C : "${pico.c}" (Actif: ${Boolean(activePico.c)})
- O : "${pico.o}" (Actif: ${activePico.o !== false})
- NOT : "${pico.not || ''}" (Actif: ${Boolean(activePico.not)})

MISSION D'OPTIMISATION DU CADRAGE CLINIQUE (PICO) :
Propose une version optimisée du PICO et de l'activation des axes pour répondre rigoureusement aux recommandations de l'audit, SANS dégrader le rappel ni ajouter de termes redondants si un axe est déjà bien ciblé.

RÈGLES STRICTES :
1. Rédige les champs 'refinedPico' UNIQUEMENT en langage médical naturel français (sigles développés, SANS balises [Mesh]/[TiAb]/[pt], SANS opérateurs AND/OR/NOT).
2. INTERDICTION STRICTE d'activer un axe C (comparateur passif) ou un axe NOT que l'utilisateur a laissé désactivé (Actif: false), SAUF en cas de bruit bibliographique manifeste explicitement signalé dans les recommandations d'audit.
3. Pour chaque axe actif modifié ou conservé, fournis dans "atomicConcepts" les concepts biomédicaux atomiques normalisés ({ conceptFr court 1-4 mots pour HeTOP, conceptEn en anglais pour NCBI Entrez, broaderMeshRoot optionnel pour la racine canonique anglaise si le concept comporte des qualificatifs de chronicité/sévérité/non-spécificité, synonymsTiab pour le texte libre }) et dans "englishCoreTerms" les concepts anglais correspondants. Sur les axes I et C, extrais UNIQUEMENT la substance active, le dispositif ou la procédure spécifique (sans émettre de concept séparé pour une simple voie d'administration ou un terme générique comme Therapeutics/Treatment). Sur O, sépare chaque critère distinct. Ne fabrique jamais de balise [Mesh] non vérifiée.

Réponds STRICTEMENT au format JSON avec cette structure :
{
  "refinedPico": {
    "p": "Concepts cliniques de la population (en texte naturel, sans syntaxe ni balise)",
    "i": "Concepts cliniques de l'intervention (en texte naturel, sans syntaxe ni balise)",
    "c": "Concepts cliniques du comparateur (en texte naturel, sans syntaxe ni balise)",
    "o": "Concepts cliniques du critère de jugement (en texte naturel, sans syntaxe ni balise)",
    "not": "Critères d'exclusion clinique (en texte naturel, sans syntaxe ni balise)"
  },
  "activePico": {
    "p": true,
    "i": true,
    "c": false,
    "o": true,
    "not": false
  },
  "atomicConcepts": {
    "p": [{ "conceptFr": "terme court", "conceptEn": "English Concept", "synonymsTiab": ["synonym 1"] }],
    "i": [{ "conceptFr": "substance ou procédure", "conceptEn": "Active Concept", "synonymsTiab": ["synonym 1"] }],
    "c": [],
    "o": [{ "conceptFr": "critère 1", "conceptEn": "Outcome 1", "synonymsTiab": ["synonym 1"] }],
    "not": []
  },
  "englishCoreTerms": {
    "p": ["English Descriptor 1"],
    "i": ["English Descriptor 2"],
    "c": [],
    "o": ["English Descriptor 3"],
    "not": []
  },
  "strategy": "balanced",
  "explanation": "Explication claire en 1 ou 2 phrases en français de l'ajustement apporté."
}`;

  const rawResponse = await queryAiModel(prompt, AUDIT_AGENT_SYSTEM_PROMPT, 'reasoning');
  if (!rawResponse || !rawResponse.trim()) {
    throw new Error("Le modèle IA a renvoyé une réponse vide lors de la suggestion d'affinage PICO.");
  }

  const parsed = extractJsonFromLlmResponse<{
    refinedPico?: { p?: string; i?: string; c?: string; o?: string; not?: string };
    activePico?: { p?: boolean; i?: boolean; c?: boolean; o?: boolean; not?: boolean };
    atomicConcepts?: {
      p?: unknown;
      i?: unknown;
      c?: unknown;
      o?: unknown;
      not?: unknown;
    };
    englishCoreTerms?: {
      p?: unknown;
      i?: unknown;
      c?: unknown;
      o?: unknown;
      not?: unknown;
    };
    strategy?: 'sensitive' | 'balanced' | 'specific';
    explanation?: string;
  }>(rawResponse);
  if (!parsed || !parsed.refinedPico) {
    throw new Error("La suggestion d'affinage PICO renvoyée par l'IA n'est pas un JSON valide.");
  }

  const pRefined = sanitizePicoConcept(parsed.refinedPico.p || pico.p);
      let iRefined = sanitizePicoConcept(parsed.refinedPico.i || pico.i);
      const cRefined = sanitizePicoConcept(parsed.refinedPico.c ?? pico.c);
      const oRefined = stripIatrogenicTermsFromOutcome(
        sanitizePicoConcept(parsed.refinedPico.o || pico.o)
      );
      const notRefined = sanitizePicoConcept(parsed.refinedPico.not ?? pico.not ?? '');

      // Verrou déterministe de non-régression V1 -> V2 : préserver toute DCI explicite présente dans pico.i
      // que le raffinement IA aurait omise involontairement.
      if (iRefined && pico.i) {
        const originalInns = extractInnLikeTokens(pico.i);
        const normIRefined = iRefined
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        const missingInns = originalInns.filter((inn) => {
          const normInn = inn
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
          return !normIRefined.includes(normInn.slice(0, Math.min(6, normInn.length)));
        });
        if (missingInns.length > 0) {
          iRefined = iRefined.includes(')')
            ? iRefined.replace(/\)\s*$/, `, ${missingInns.join(', ')})`)
            : `${iRefined}, ${missingInns.join(', ')}`;
        }
      }

      const recsJoined = critiqueReport.recommendations.join(' ');
      const auditExplicitlyRequestsNot = /\b(?:bruit|exclu|exclusion|not\b|noise|exclude)\b/i.test(recsJoined);
      const auditExplicitlyRequestsC = /\b(?:comparateur\s+actif|comparaison\s+directe|active\s+comparator)\b/i.test(recsJoined);

      const rawActive = parsed.activePico || activePico;
      const cRequested = Boolean(rawActive?.c && cRefined);
      const notRequested = Boolean(rawActive?.not && notRefined);

      const safeActivePico = {
        p: isUnrestrictedDemographicConcept(pRefined)
          ? false
          : Boolean(rawActive?.p ?? activePico.p !== false),
        i: Boolean(iRefined),
        c: isPassiveComparatorConcept(cRefined)
          ? false
          : activePico.c
            ? cRequested
            : auditExplicitlyRequestsC && cRequested,
        o: Boolean(oRefined),
        not: activePico.not
          ? notRequested
          : auditExplicitlyRequestsNot && notRequested
      };

      const isFrenchCandidate = (term: string): boolean =>
        /[éèêëàâäôöùûüçîïœæ]/i.test(term) ||
        /\b(?:de|du|des|ou|et|le|la|les|avec|sans|chez|pour|dans)\b/i.test(term);

      const buildAxisQual = (
        axisKey: 'p' | 'i' | 'c' | 'o' | 'not',
        axisType: 'P' | 'I' | 'C' | 'O' | 'NOT',
        originalText: string,
        refinedText: string
      ): AxisSemanticQualification => {
        const deterministic = inferDeterministicAxisQualification(axisType, refinedText);
        const rawHintList = parsed.englishCoreTerms?.[axisKey];
        const parsedHints = Array.isArray(rawHintList)
          ? rawHintList
              .map((h) => String(h || '').replace(/[()[\]"]/g, '').trim())
              .filter((h) => h.length > 2 && !h.includes('*') && !h.includes('_') && !isFrenchCandidate(h))
              .slice(0, 6)
          : [];

        const isUnchanged =
          originalText.trim().toLowerCase() === refinedText.trim().toLowerCase();
        const preservedHints = currentQualifications?.[axisKey]?.englishCoreTerms ?? [];
        const unionHints: string[] = [];
        const seenLower = new Set<string>();
        const pushUnique = (term: string) => {
          const low = term.trim().toLowerCase();
          if (low && !seenLower.has(low)) {
            seenLower.add(low);
            unionHints.push(term.trim());
          }
        };
        for (const h of parsedHints) pushUnique(h);
        // Fusion par union des englishCoreTerms de V1 pour empêcher l'effondrement de couverture en V2
        for (const h of preservedHints) pushUnique(h);

        const parsedAtomics = sanitizeAtomicConceptList(parsed.atomicConcepts?.[axisKey]);
        const preservedAtomics = currentQualifications?.[axisKey]?.atomicConcepts;
        const atomicConcepts =
          parsedAtomics.length > 0
            ? parsedAtomics
            : isUnchanged && preservedAtomics && preservedAtomics.length > 0
              ? preservedAtomics
              : undefined;

        const englishCoreTerms =
          unionHints.length > 0
            ? unionHints.slice(0, 8)
            : atomicConcepts && atomicConcepts.length > 0
              ? atomicConcepts.map((c) => c.conceptEn)
              : deterministic.englishCoreTerms;

        return {
          axisRole: deterministic.axisRole,
          impliedSubheadings:
            currentQualifications?.[axisKey]?.impliedSubheadings && isUnchanged
              ? currentQualifications[axisKey]!.impliedSubheadings
              : deterministic.impliedSubheadings,
          coreClinicalConcept: deterministic.coreClinicalConcept,
          englishCoreTerms,
          ...(atomicConcepts ? { atomicConcepts } : {})
        };
      };

      const qualifications: PicoSemanticQualifications = {
        p: buildAxisQual('p', 'P', pico.p, pRefined),
        i: buildAxisQual('i', 'I', pico.i, iRefined),
        c: buildAxisQual('c', 'C', pico.c, cRefined),
        o: buildAxisQual('o', 'O', pico.o, oRefined),
        not: buildAxisQual('not', 'NOT', pico.not || '', notRefined),
        recommendedActivePico: {
          p: safeActivePico.p,
          i: safeActivePico.i,
          c: safeActivePico.c,
          o: safeActivePico.o,
          not: safeActivePico.not
        }
      };

      return {
        refinedPico: {
          p: pRefined,
          i: iRefined,
          c: cRefined,
          o: oRefined,
          not: notRefined
        },
        activePico: safeActivePico,
        qualifications,
        strategy: parsed.strategy || 'balanced',
        explanation:
          parsed.explanation || "Stratégie optimisée selon les recommandations de l'audit qualité."
      };
}

export type StudyDesignType = 'rct' | 'observational' | 'review' | 'other';

export interface Rob2ArticleEvaluation {
  pmid: string;
  d1: 'low' | 'moderate' | 'high'; // Biais lié à la randomisation / confusion
  d2: 'low' | 'moderate' | 'high'; // Déviations d'intervention (insu)
  d3: 'low' | 'moderate' | 'high'; // Données manquantes (ITT / perdus de vue)
  d4: 'low' | 'moderate' | 'high'; // Mesure du critère (objectif / aveugle)
  d5: 'low' | 'moderate' | 'high'; // Sélection du résultat rapporté (enregistrement NCT/PROSPERO)
  overall: 'low' | 'moderate' | 'high'; // Jugement global Cochrane
  studyDesign?: StudyDesignType; // Grille applicable : ECR (RoB 2), Observationnel (ROBINS-I), Revue (AMSTAR 2), Autre
  justification?: string;
  evaluatedBy?: string;
}

/**
 * Infère le schéma d'étude (ECR, étude observationnelle, revue systématique ou autre)
 * en donnant la priorité aux types de publication officiels NLM (`<PublicationType>`),
 * puis en repliant sur l'analyse lexicale du titre et du résumé.
 * Le repli par défaut est `'other'` (jamais `'rct'`) afin de ne pas classer par erreur
 * une revue narrative ou une recommandation en essai contrôlé randomisé.
 */
export function inferStudyDesignFromText(
  title: string,
  abstract: string = '',
  publicationTypes?: readonly string[]
): StudyDesignType {
  if (publicationTypes && publicationTypes.length > 0) {
    const normalizedTypes = new Set(
      publicationTypes.map(pt => pt.trim().toLowerCase()).filter(Boolean)
    );

    // 1. Revues systématiques & méta-analyses (prioritaires devant "Review" générique)
    if (
      normalizedTypes.has('systematic review') ||
      normalizedTypes.has('meta-analysis') ||
      normalizedTypes.has('network meta-analysis')
    ) {
      return 'review';
    }

    // 2. Essais contrôlés randomisés / cliniques contrôlés
    if (
      normalizedTypes.has('randomized controlled trial') ||
      normalizedTypes.has('controlled clinical trial') ||
      normalizedTypes.has('pragmatic clinical trial')
    ) {
      return 'rct';
    }

    // 3. Études observationnelles / comparatives / multicentriques
    if (
      normalizedTypes.has('observational study') ||
      normalizedTypes.has('comparative study') ||
      normalizedTypes.has('multicenter study')
    ) {
      return 'observational';
    }

    // 4. Recommandations, consensus, cas cliniques, éditoriaux, lettres ou revues narratives ("Review" seul)
    if (
      normalizedTypes.has('practice guideline') ||
      normalizedTypes.has('guideline') ||
      normalizedTypes.has('consensus development conference') ||
      normalizedTypes.has('case reports') ||
      normalizedTypes.has('editorial') ||
      normalizedTypes.has('letter') ||
      normalizedTypes.has('comment') ||
      normalizedTypes.has('review')
    ) {
      return 'other';
    }
  }

  const combined = `${title} ${abstract}`.toLowerCase();
  if (/\b(?:systematic\s+review|meta-analysis|meta\s+analysis|umbrella\s+review|scoping\s+review|prospero)\b/.test(combined)) {
    return 'review';
  }
  if (/\b(?:randomi[sz]ed|double-blind|single-blind|placebo-controlled|crossover\s+trial|clinical\s+trial|rct)\b/.test(combined)) {
    return 'rct';
  }
  if (/\b(?:cohort|retrospective|case-control|cross-sectional|observational|registry|real-world)\b/.test(combined)) {
    return 'observational';
  }
  return 'other';
}

/**
 * Applique l'algorithme officiel Cochrane RoB 2 pour calculer le jugement global à partir des 5 domaines :
 * - 'high' dès qu'au moins un domaine est 'high' (ou >= 3 domaines 'moderate' avec réserves méthodologiques)
 * - 'low' uniquement si TOUS les 5 domaines sont 'low'
 * - 'moderate' ("Some concerns") dans tous les autres cas
 */
export function computeCochraneOverallRating(
  d1: 'low' | 'moderate' | 'high',
  d2: 'low' | 'moderate' | 'high',
  d3: 'low' | 'moderate' | 'high',
  d4: 'low' | 'moderate' | 'high',
  d5: 'low' | 'moderate' | 'high'
): 'low' | 'moderate' | 'high' {
  const domains = [d1, d2, d3, d4, d5];
  if (domains.includes('high')) return 'high';
  if (domains.includes('moderate')) return 'moderate';
  return 'low';
}

/**
 * Sélectionne strictement les études éligibles non encore évaluées pour le pré-repérage des biais :
 * - exclut toute étude déjà évaluée (manuelle ou IA) afin de ne jamais écraser un travail existant,
 * - exclut les formats de type `'other'` (revues narratives, recommandations, éditoriaux, cas cliniques).
 */
export function selectUnassessedRobBatch<
  T extends { readonly pmid: string; readonly title: string; readonly abstract: string; readonly publicationTypes?: readonly string[] }
>(
  articles: readonly T[],
  existingEvaluations: Readonly<Record<string, Rob2ArticleEvaluation>>,
  limit?: number
): T[] {
  const eligible = (articles || []).filter(art => {
    if (existingEvaluations[art.pmid]) return false;
    const design = inferStudyDesignFromText(art.title, art.abstract, art.publicationTypes);
    return design !== 'other';
  });
  if (typeof limit === 'number' && limit > 0) {
    return eligible.slice(0, limit);
  }
  return eligible;
}

/**
 * Pré-évaluation par lots (Batch) du risque de biais Cochrane RoB 2 / ROBINS-I.
 * Permet d'évaluer jusqu'à 20 études incluses en 1 seul appel API (évite les erreurs HTTP 429).
 * Prend en charge l'interruption immédiate via `abortSignal`.
 * Règle stricte sur résumé : tout élément non documenté dans l'abstract = "moderate".
 */
export async function aiEvaluateBatchRoB2(
  articles: ReadonlyArray<{ pmid: string; title: string; abstract: string; publicationTypes?: readonly string[] }>,
  abortSignal?: AbortSignal
): Promise<Map<string, Rob2ArticleEvaluation>> {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }

  const resultMap = new Map<string, Rob2ArticleEvaluation>();
  if (!articles || articles.length === 0) return resultMap;

  const aiConfig = getAiConfig();
  const evaluatedBy = getActiveProviderLabel(aiConfig, 'batch');

  const articlesPayload = articles.map((art, idx) => {
    const abs = compressAbstractForLlm(art.abstract || '', 1200);
    const pubTypesLine = art.publicationTypes && art.publicationTypes.length > 0
      ? `\nTypes de publication NLM : ${art.publicationTypes.join(', ')}`
      : '';
    return `[ÉTUDE #${idx + 1} | PMID: "${art.pmid}"]
Titre : ${art.title}${pubTypesLine}
Résumé : ${abs}`;
  }).join('\n\n---\n\n');

  const prompt = `Tu es un médecin méthodologiste expert de la collaboration Cochrane (outils RoB 2 pour les essais randomisés, ROBINS-I pour les études observationnelles, AMSTAR 2 pour les revues).
Analyse le lot de ${articles.length} étude(s) ci-dessous à partir de leur titre et résumé pour pré-évaluer le risque de biais.

LOT D'ÉTUDES À ÉVALUER :
${articlesPayload}

RÈGLES MÉTHODOLOGIQUES STRICTES (PRUDENCE SUR RÉSUMÉ) :
1. INTERDICTION D'INVENTER UN FAIBLE RISQUE ("low") SANS PREUVE TEXTUELLE : Un résumé PubMed est court. Si un domaine n'est PAS explicitement documenté dans le résumé, tu DOIS impérativement le coter "moderate" ("Préoccupations / À vérifier sur texte intégral") et JAMAIS "low".
2. Critères de cotation par domaine :
   - D1 (Randomisation / Confusion) : "low" uniquement si randomisation explicite (et séquence/dissimulation mentionnée) ; "moderate" si randomisé sans détail d'assignation ; "high" si non randomisé ou biais de sélection manifeste.
   - D2 (Déviations / Insu des participants et cliniciens) : "low" si double-insu / double-blind explicite ; "moderate" si essai ouvert (ex: nutrition, chirurgie, mode de vie) sans déviation majeure signalée ou insu non précisé ; "high" si étude ouverte avec contamination/non-adhérence majeure.
   - D3 (Données manquantes / Attrition) : "low" si analyse en intention de traiter (ITT) ou faible attrition (< 10%) explicitement mentionnée ; "moderate" si non précisé dans l'abstract ; "high" si forte attrition (> 20%) ou per-protocol exclusif biaisé.
   - D4 (Mesure du critère de jugement) : "low" si le critère principal est objectif (ex: mortalité, poids mesuré, biologie, imagerie en aveugle) ou évaluateur en aveugle ; "moderate" si critère partiellement déclaratif sans mention d'aveugle ; "high" si critère purement subjectif auto-déclaré en ouvert.
   - D5 (Sélection du résultat rapporté) : "low" uniquement si un numéro d'enregistrement de protocole (NCT..., ISRCTN..., PROSPERO, EudraCT) ou analyse pré-spécifiée est mentionné ; "moderate" si aucun enregistrement n'est mentionné dans le résumé ; "high" si changement de critère primaire suspecté.
3. Identifie également "studyDesign" : "rct" (essai contrôlé randomisé), "observational" (cohorte, cas-témoins, rétrospectif), "review" (revue systématique / méta-analyse) ou "other" (revue narrative, recommandation/guideline, consensus, cas clinique, éditorial, autre).
4. Rédige dans "justification" 1 phrase concise en français citant les éléments factuels du résumé (ex: "Essai ouvert sans mention d'ITT ni d'enregistrement NCT dans le résumé, mais critère pondéral objectif").

Réponds STRICTEMENT au format JSON sous forme d'un tableau d'objets :
[
  {
    "pmid": "identifiant PMID numérique exact (ex: 42429418)",
    "studyDesign": "rct" ou "observational" ou "review" ou "other",
    "d1": "low" ou "moderate" ou "high",
    "d2": "low" ou "moderate" ou "high",
    "d3": "low" ou "moderate" ou "high",
    "d4": "low" ou "moderate" ou "high",
    "d5": "low" ou "moderate" ou "high",
    "justification": "Justification méthodologique factuelle en 1 phrase en français"
  }
]`;

  const system = "Tu es un méthodologiste Cochrane strict. Tout domaine non documenté dans le résumé doit être coté 'moderate'. Réponds exclusivement avec un tableau JSON valide.";
  const rawResponse = await queryAiModel(prompt, system, 'batch', abortSignal);
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
  if (!rawResponse || !rawResponse.trim()) {
    throw new Error("Le modèle IA a renvoyé une réponse vide lors de l'évaluation du risque de biais.");
  }

  const validRatings = ['low', 'moderate', 'high'];
  const safeRating = (val: unknown): 'low' | 'moderate' | 'high' => {
    const normalized = String(val || '').toLowerCase().trim();
    return validRatings.includes(normalized) ? (normalized as 'low' | 'moderate' | 'high') : 'moderate';
  };
  const safeDesign = (val: unknown, fallback: StudyDesignType): StudyDesignType => {
    const normalized = String(val || '').toLowerCase().trim();
    return ['rct', 'observational', 'review', 'other'].includes(normalized)
      ? (normalized as StudyDesignType)
      : fallback;
  };

  const parsed = extractJsonFromLlmResponse<unknown>(rawResponse);
  let items: Array<Record<string, unknown>> = [];
  if (Array.isArray(parsed)) {
    items = parsed as Array<Record<string, unknown>>;
  } else if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.evaluations)) items = obj.evaluations as Array<Record<string, unknown>>;
    else if (Array.isArray(obj.results)) items = obj.results as Array<Record<string, unknown>>;
    else if (Array.isArray(obj.studies)) items = obj.studies as Array<Record<string, unknown>>;
    else if ('d1' in obj) items = [obj];
  }

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const rawPmid = String(item?.pmid || '').replace(/\D+/g, '').trim();
    const matchedArticle =
      articles.find(a => String(a.pmid).trim() === rawPmid) ||
      (items.length === articles.length ? articles[idx] : undefined) ||
      (articles.length === 1 ? articles[0] : undefined);

    if (!matchedArticle) continue;
    const pmid = String(matchedArticle.pmid).trim();
    const fallbackDesign = inferStudyDesignFromText(
      matchedArticle.title || '',
      matchedArticle.abstract || '',
      matchedArticle.publicationTypes
    );

    const d1 = safeRating(item.d1);
    const d2 = safeRating(item.d2);
    const d3 = safeRating(item.d3);
    const d4 = safeRating(item.d4);
    const d5 = safeRating(item.d5);
    const overall = computeCochraneOverallRating(d1, d2, d3, d4, d5);

    resultMap.set(pmid, {
      pmid,
      d1,
      d2,
      d3,
      d4,
      d5,
      overall,
      studyDesign: safeDesign(item.studyDesign, fallbackDesign),
      justification: typeof item.justification === 'string' && item.justification.trim().length > 0
        ? item.justification.trim()
        : "Pré-évaluation sur résumé (domaines non documentés cotés 'Modéré' à vérifier sur texte intégral)",
      evaluatedBy
    });
  }

  if (resultMap.size === 0) {
    throw new Error("La réponse du modèle IA n'a pas pu être interprétée comme un JSON RoB 2 valide.");
  }
  if (resultMap.size < articles.length) {
    throw new Error(
      `Évaluation du risque de biais incomplète : ${resultMap.size} / ${articles.length} étude(s) couverte(s) par le modèle IA.`
    );
  }

  return resultMap;
}


