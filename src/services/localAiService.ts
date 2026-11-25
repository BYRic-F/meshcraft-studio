/**
 * Service d'Intelligence Artificielle Cloud Multi-Fournisseurs & FinOps pour MeSHcraft Studio
 *
 * Supporte :
 * 1. Google Gemini Cloud (Pay-As-You-Go Tier 1 / Gratuit : gemini-1.5-pro + gemini-1.5-flash)
 * 2. OpenAI Cloud (Pay-As-You-Go : gpt-4o + gpt-4o-mini)
 * 3. Anthropic Claude Cloud (Pay-As-You-Go : claude-3-5-sonnet-latest + claude-3-5-haiku-latest)
 * 4. Routage Intelligent par Tâche (Smart Routing : Modèle Pro pour Cadrage PICO/Audit, Modèle Flash/Mini/Haiku pour Screening par lots)
 * 5. Optimisations FinOps : Compression des résumés, Cache d'idempotence (PMID + PICO) et Mega-Batching
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

export type AiProvider = 'gemini' | 'openai' | 'anthropic' | 'deterministic';
export type AiRoutingMode = 'smart' | 'pro_only' | 'economy';
export type AiTaskTier = 'reasoning' | 'batch';
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
  if (rawProvider === 'openai' || rawProvider === 'anthropic' || rawProvider === 'deterministic') {
    return rawProvider;
  }
  return 'gemini';
}

/**
 * Sélectionne automatiquement le modèle optimal selon la criticité cognitive de la tâche (FinOps Smart Routing) :
 * - 'reasoning' (Extraction PICO Agent 1 & Audit PRESS Agent 2) -> Modèle Pro / Sonnet / GPT-4o
 * - 'batch' (Screening massif Titre/Résumé Agent 3 & RoB 2 Agent 4) -> Modèle Flash / Mini / Haiku
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

  if (config.provider === 'gemini') {
    return effectiveTier === 'reasoning'
      ? normalizeGeminiModel(config.geminiModel || 'gemini-pro-latest', 'reasoning')
      : normalizeGeminiModel(config.geminiBatchModel || 'gemini-flash-lite-latest', 'batch');
  }

  return 'Règles PRISMA / NLM';
}

export function getActiveProviderLabel(config?: AiConfig, taskTier: AiTaskTier = 'reasoning'): string {
  const active = config || getAiConfig();
  if (active.provider === 'deterministic') {
    return 'Règles PRISMA (Déterministe)';
  }
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
    provider: 'Moteur Déterministe (Sans LLM)',
    models: [],
    activeModel: 'Règles MeSH / NLM',
    routingMode: config.routingMode,
    message: 'Aucun fournisseur IA configuré.'
  };
}

export async function checkLocalAiStatus(overrideConfig?: Partial<AiConfig>): Promise<LocalModelStatus> {
  return testAiConnectionLive(overrideConfig);
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

async function runGeminiProvider(
  config: AiConfig,
  prompt: string,
  systemPrompt: string | undefined,
  taskTier: AiTaskTier,
  abortSignal?: AbortSignal
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
      taskTier === 'batch'
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
          responseMimeType: 'application/json'
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
            temperature: 0.1
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
  abortSignal?: AbortSignal
): Promise<string | null> {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }

  const config = getAiConfig();
  if (config.provider === 'deterministic') {
    return null;
  }

  // En environnement de test unitaire sans clé API configurée, basculer immédiatement sur le repli déterministe
  const isTestEnv =
    typeof process !== 'undefined' &&
    Boolean((process as unknown as { env?: Record<string, unknown> }).env?.VITEST);
  const activeKey =
    config.provider === 'gemini'
      ? cleanApiKey(config.geminiApiKey)
      : config.provider === 'openai'
        ? cleanApiKey(config.openaiApiKey)
        : cleanApiKey(config.anthropicApiKey);

  if (isTestEnv && !activeKey) {
    return null;
  }

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
        return await runGeminiProvider(effectiveConfig, prompt, systemPrompt, taskTier, abortSignal);
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

/**
 * Qualification morpho-sémantique d'un axe PICO/PECO produite par l'orchestrateur LLM
 * ou par l'analyseur morphosyntaxique déterministe.
 */
export interface AxisSemanticQualification {
  readonly axisRole: PicoAxisRole;
  readonly impliedSubheadings: readonly string[];
  readonly coreClinicalConcept: string;
  readonly englishCoreTerms: readonly string[];
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
  p: string;
  i: string;
  c: string;
  o: string;
  not: string;
  qualifications?: PicoSemanticQualifications;
  source?: 'gemini' | 'openai' | 'anthropic' | 'rules';
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
export async function aiExtractClinicalPico(rawText: string): Promise<ClinicalPicoExtractionResult | null> {
  const config = getAiConfig();
  const providerSource: 'gemini' | 'openai' | 'anthropic' | 'rules' =
    config.provider === 'deterministic' ? 'rules' : config.provider;

  const system = `Tu es un médecin méthodologiste senior et ingénieur en informatique médicale expert du thésaurus NLM MeSH, de PRISMA-S et du Cochrane Handbook.
Ta mission est double :
1. Extraire les concepts cliniques PICO/PECO atomiques dans la langue d'origine (sans jamais inventer de balises [Mesh]/[tiab] ni mettre de traductions anglaises entre parenthèses dans les champs p, i, c, o, not) et développer systématiquement les sigles et abréviations cliniques en toutes lettres dans ces champs (ex: IDM -> Infarctus du myocarde, AVC -> Accident vasculaire cérébral, ICFEp/FEVG -> Insuffisance cardiaque à fraction d'éjection préservée, IMC -> Indice de masse corporelle, EI -> Effet indésirable).
2. Qualifier sémantiquement et morphologiquement chaque axe dans l'objet "qualifications" (axisRole, impliedSubheadings NLM officiels, coreClinicalConcept épuré de son adjectif causal, et englishCoreTerms pour chaque axe actif en vue d'une validation stricte contre NCBI Entrez Dxxxxxx) pour piloter le compilateur booléen Rust/WASM.
3. DIRECTIVE PUNITIVE STRICTE : INTERDICTION ABSOLUE de placer le mot "Pharmacovigilance", "Iatrogénie" ou "Effet indésirable" dans l'Axe O. L'Axe O ne reçoit QUE la maladie (ex: Syndrome parkinsonien). Tout concept d'iatrogénie DOIT aller dans l'Axe I.
4. COURT-CIRCUIT DES COMPARATEURS PASSIFS ET DÉMOGRAPHIES NON RESTREINTES : Force OBLIGATOIREMENT "c": false dès que le comparateur est de type "passive_comparator" ("Absence d'exposition", "Soins courants") et "p": false si la population est "demographic_unrestricted".
5. RÉSOLUTION DE LA GRANULARITÉ DE L'EXPOSITION (AXE I) :
- Niveau Spécifique : Si le texte énumère des entités précises (liste de molécules, vaccins nommés, implants spécifiques), extrais-les intégralement dans l'axe I.
- Niveau Générique (Concept Parapluie) : Si le texte désigne l'exposition par un terme générique de classe (ex: 'les médicaments', 'la chirurgie', 'les pesticides') comme CAUSE d'un effet indésirable, NE LE TRADUIS JAMAIS par le produit commercial (interdit d'utiliser 'Pharmaceutical Preparations' ou 'Surgical Instruments'). Tu DOIS le traduire par le concept de sécurité ou d'iatrogénie associé (ex: 'Effets indésirables médicamenteux', 'Pharmacovigilance', 'Complications post-opératoires').
- Sous-descripteur de Causalité : Dans tous les cas, si la pathologie (Axe O) est induite par une exposition, tu DOIS impérativement ajouter le sous-descripteur étiologique pertinent (ex: 'chemically induced', 'etiology', 'adverse effects') dans son tableau impliedSubheadings.
Réponds EXCLUSIVEMENT avec un objet JSON strictement conforme au contrat demandé.`;

  const prompt = `Analyse le protocole, la question de recherche ou le résumé clinique ci-dessous et extrais la structure PICO/PECO ainsi que les qualifications morpho-sémantiques de chaque axe.

PRINCIPES MÉTHODOLOGIQUES IMPÉRATIFS (RIGUEUR TERMINOLOGIQUE MeSH & LOGIQUE BOOLÉENNE PURE) :
1. SÉPARATION STRICTE EXPOSITION (I/E) != ÉVÉNEMENT CLINIQUE (O) :
   - INTERDICTION ABSOLUE de placer le mot "Pharmacovigilance", "Iatrogénie" ou "Effet indésirable" dans l'Axe O. L'Axe O ne reçoit QUE la maladie (ex: Syndrome parkinsonien). Tout concept d'iatrogénie DOIT aller dans l'Axe I.
   - Si le texte étudie une pathologie causée par des médicaments :
     * L'axe "i" reçoit soit la liste complète des molécules (DCI) mentionnées dans le texte (sans la tronquer !), soit le concept générique "Effets indésirables médicamenteux, Pharmacovigilance" si aucune liste de DCI n'est fournie.
     * L'axe "o" reçoit UNIQUEMENT le phénotype ou la pathologie clinique cible (ex: "Syndrome parkinsonien secondaire induit chimiquement").
2. ISOLATION DU NOYAU NOSOLOGIQUE ("coreClinicalConcept") ET DES SOUS-DESCRIPTEURS ("impliedSubheadings") :
   - Lorsqu'un axe mentionne une pathologie induite par un médicament ou une substance (ex: "Syndrome parkinsonien médicamenteux", "Pancréatite aiguë induite chimiquement"), qualifie son axisRole en "induced_syndrome", ajoute "chemically induced" dans "impliedSubheadings", et place dans "coreClinicalConcept" le noyau nosologique pur débarrassé de l'adjectif causal (ex: "Syndrome parkinsonien secondaire").
   - Fournis dans "englishCoreTerms" les descripteurs ou radicaux nosologiques anglais correspondants (ex: ["Parkinson Disease, Secondary", "Parkinsonian Disorders", "parkinsonism", "parkinsonian"]).
3. QUALIFICATION DES RÔLES D'AXES ("axisRole") :
   - "drug_inn_list" : Énumération de dénominations communes internationales (DCI / molécules pharmacologiques).
   - "iatrogenic_generic" : Exposition médicamenteuse générique / pharmacovigilance / effets indésirables sans liste de molécules.
   - "induced_syndrome" : Pathologie ou syndrome induit chimiquement / d'origine médicamenteuse (requiert impliedSubheadings: ["chemically induced"]).
   - "clinical_condition" : Pathologie, population clinique spécifique, intervention non pharmacologique ou critère de jugement standard.
   - "passive_comparator" : Comparateur passif non discriminant documentairement ("Alimentation habituelle", "Absence d'exposition", "Soins courants", "Placebo ou comparateur actif").
   - "demographic_unrestricted" : Population générale adulte non restreinte à une maladie spécifique ("Adultes >= 18 ans", "Adultes en soins primaires").
4. COURT-CIRCUIT DES COMPARATEURS PASSIFS ET DÉMOGRAPHIES NON RESTREINTES ("recommendedActivePico") :
   - Force OBLIGATOIREMENT "c": false dès que le comparateur est de type "passive_comparator" (ne jamais envoyer "Absence d'exposition" ou "Soins courants" dans l'équation).
   - Force OBLIGATOIREMENT "p": false si la population est "demographic_unrestricted".
5. RÉSOLUTION DE LA GRANULARITÉ DE L'EXPOSITION (AXE I) :
   - Niveau Spécifique : Si le texte énumère des entités précises (liste de molécules, vaccins nommés, implants spécifiques), extrais-les intégralement dans l'axe I.
   - Niveau Générique (Concept Parapluie) : Si le texte désigne l'exposition par un terme générique de classe (ex: 'les médicaments', 'la chirurgie', 'les pesticides') comme CAUSE d'un effet indésirable, NE LE TRADUIS JAMAIS par le produit commercial (interdit d'utiliser 'Pharmaceutical Preparations' ou 'Surgical Instruments'). Tu DOIS le traduire par le concept de sécurité ou d'iatrogénie associé (ex: 'Effets indésirables médicamenteux', 'Pharmacovigilance', 'Complications post-opératoires').
   - Sous-descripteur de Causalité : Dans tous les cas, si la pathologie (Axe O) est induite par une exposition, tu DOIS impérativement ajouter le sous-descripteur étiologique pertinent (ex: 'chemically induced', 'etiology', 'adverse effects') dans son tableau impliedSubheadings.
6. DÉVELOPPEMENT DES SIGLES ET CANDIDATS ANGLOPHONES NLM :
   - Développe systématiquement en toutes lettres tous les sigles et abréviations cliniques dans les champs français p, i, c, o, not (ex: IDM -> Infarctus du myocarde, AVC -> Accident vasculaire cérébral, ICFEp/FEVG -> Insuffisance cardiaque à fraction d'éjection préservée, IMC -> Indice de masse corporelle, EI -> Effet indésirable).
   - Pour chaque axe actif (p, i, c, o, not), renseigne dans "englishCoreTerms" des concepts cliniques anglais atomiques concis (2 à 5 mots max) servant de candidats secondaires pour interrogation officielle NCBI Entrez (db=mesh).

Réponds STRICTEMENT au format JSON suivant :
{
  "p": "Concepts cliniques concis de la population en français, sigles développés (sans parenthèses anglaises)",
  "i": "Liste intégrale des molécules (DCI) ou concept d'intervention/exposition en français, sigles développés",
  "c": "Comparateur concis en français",
  "o": "UNIQUEMENT la maladie / phénotype clinique cible en français, sigles développés (SANS Pharmacovigilance ni Iatrogénie)",
  "not": "Critères d'exclusion explicites en français, sigles développés (ou chaîne vide si aucun)",
  "qualifications": {
    "p": {
      "axisRole": "clinical_condition | demographic_unrestricted",
      "impliedSubheadings": [],
      "coreClinicalConcept": "Noyau clinique pur en français",
      "englishCoreTerms": ["English Descriptor 1", "English Term 2"]
    },
    "i": {
      "axisRole": "drug_inn_list | iatrogenic_generic | clinical_condition",
      "impliedSubheadings": [],
      "coreClinicalConcept": "Noyau de l'intervention/exposition",
      "englishCoreTerms": ["English INN or Mesh 1", "English INN or Mesh 2"]
    },
    "c": {
      "axisRole": "passive_comparator | clinical_condition",
      "impliedSubheadings": [],
      "coreClinicalConcept": "Noyau du comparateur",
      "englishCoreTerms": []
    },
    "o": {
      "axisRole": "induced_syndrome | clinical_condition",
      "impliedSubheadings": ["chemically induced"],
      "coreClinicalConcept": "Noyau nosologique pur sans adjectif causal ni pharmacovigilance",
      "englishCoreTerms": ["Official NLM Descriptor 1", "Official NLM Descriptor 2", "derived_stem_ism", "derived_stem_ian"]
    },
    "not": {
      "axisRole": "clinical_condition",
      "impliedSubheadings": [],
      "coreClinicalConcept": "Noyau du critère d'exclusion",
      "englishCoreTerms": ["English Exclusion Term 1"]
    },
    "recommendedActivePico": {
      "p": true,
      "i": true,
      "c": false,
      "o": true,
      "not": false
    }
  },
  "confidence": 95,
  "reasoning": "Justification méthodologique concise en 1 phrase."
}

Texte clinique à analyser :
"""
${rawText}
"""`;

  const rawResponse = await queryAiModel(prompt, system, 'reasoning');
  if (!rawResponse) return null;

  const stripParensFromExtractedPico = (val: string) =>
    sanitizePicoConcept((val || "").replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());

  try {
    const parsed = extractJsonFromLlmResponse<Record<string, unknown>>(rawResponse);
    if (!parsed || (!parsed.p && !parsed.i && !parsed.o)) return null;

    const pClean = stripParensFromExtractedPico(String(parsed.p || ""));
    let iClean = stripParensFromExtractedPico(String(parsed.i || ""));
    const cClean = stripParensFromExtractedPico(String(parsed.c || ""));
    const rawOClean = stripParensFromExtractedPico(String(parsed.o || ""));
    const oClean = stripIatrogenicTermsFromOutcome(rawOClean);
    const notClean = stripParensFromExtractedPico(String(parsed.not || ""));

    // Si l'axe I est vide alors que l'axe O contenait un terme d'iatrogénie/pharmacovigilance, le transférer dans I
    if (!iClean && /\b(?:pharmacovigilance|iatrog[ée]n(?:ie|ique)|effets?\s+ind[ée]sirables?)\b/i.test(rawOClean)) {
      iClean = 'Effets indésirables médicamenteux, Pharmacovigilance';
    }

    const rawQuals = (parsed.qualifications && typeof parsed.qualifications === 'object')
      ? (parsed.qualifications as Record<string, unknown>)
      : {};

    const pQual = sanitizeAxisQualification(rawQuals.p, 'P', pClean);
    const iQual = sanitizeAxisQualification(rawQuals.i, 'I', iClean);
    const cQual = sanitizeAxisQualification(rawQuals.c, 'C', cClean);
    const oQual = sanitizeAxisQualification(rawQuals.o, 'O', oClean);
    const notQual = sanitizeAxisQualification(rawQuals.not, 'NOT', notClean);

    const rawRecActive = (rawQuals.recommendedActivePico && typeof rawQuals.recommendedActivePico === 'object')
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
      source: providerSource,
      confidence: typeof parsed.confidence === 'number' ? Math.min(100, Math.max(50, parsed.confidence)) : 95,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : "Extraction et qualification morpho-sémantique par IA médicale"
    };
  } catch {
    return null;
  }
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

7. CONTRAT DE SORTIE :
   - Réponds EXCLUSIVEMENT en JSON valide respectant le schéma attendu, avec temperature: 0.1.`;

export interface PreviousAuditContext {
  readonly iteration: number;
  readonly previousWarnings: readonly string[];
  readonly changesSummary?: string;
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
  stratifiedTitles?: StratifiedTitleSample
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
VOLUMÉTRIE PUBMED : ${articleCount} notices
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
  if (!rawResponse) return null;

  try {
    const parsed = extractJsonFromLlmResponse<{
      score?: number;
      observations?: unknown[];
      recommendations?: unknown[];
    }>(rawResponse);
    if (parsed && Array.isArray(parsed.observations)) {
      const config = getAiConfig();
      const source: 'gemini' | 'openai' | 'anthropic' | 'rules' =
        config.provider === 'deterministic' ? 'rules' : config.provider;
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
        source,
        evaluatorModel
      };
    }
  } catch (err) {
    console.warn('Échec parsing rapport audit IA:', err);
  }

  return null;
}

export interface BatchScreenItemResult {
  pmid: string;
  status: 'included' | 'maybe' | 'excluded';
  exclusionReason?: string;
  evidenceSnippet?: string;
}

/**
 * OPTIMISATION FINOPS #1 : Compression sans perte clinique des résumés PubMed avant envoi au LLM.
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
 * OPTIMISATION FINOPS #2 : Empreinte déterministe du PICO et Cache d'Idempotence de Screening.
 * Évite de refacturer un appel API si le même PMID est ré-évalué avec le même cadrage PICO.
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
 * Évaluation clinique simultanée des articles PubMed avec cache d'idempotence FinOps.
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
4. Résume de manière ultra-concise en français (max 10-12 mots) la preuve clinique dans "evidenceSnippet" ; ne remplis "exclusionReason" QUE si status === "excluded".

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
  }
]`;

  const system = "Tu es un évaluateur clinique strict pour une revue systématique médicale. Réponds exclusivement en JSON valide sous la forme d'un tableau d'objets.";
  const rawResponse = await queryAiModel(prompt, system, 'batch', abortSignal);
  if (abortSignal?.aborted) {
    throw createAbortError();
  }
  if (!rawResponse) return cachedResults;

  const parsed = extractJsonFromLlmResponse<unknown>(rawResponse);
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

  if (rawItems.length > 0) {
    const validFresh: BatchScreenItemResult[] = [];
    for (const item of rawItems) {
      const rawPmid = String(item?.pmid || '').trim();
      const normalizedPmid = rawPmid.replace(/\D+/g, '') || rawPmid;
      const normalizedStatus = String(item?.status || '').toLowerCase().trim();
      if (
        normalizedPmid &&
        (normalizedStatus === 'included' || normalizedStatus === 'maybe' || normalizedStatus === 'excluded')
      ) {
        const cleanItem: BatchScreenItemResult = {
          pmid: normalizedPmid,
          status: normalizedStatus,
          exclusionReason: typeof item.exclusionReason === 'string' ? item.exclusionReason.trim() : undefined,
          evidenceSnippet: typeof item.evidenceSnippet === 'string' ? item.evidenceSnippet.trim() : undefined
        };
        validFresh.push(cleanItem);
        screeningDecisionCache.set(`${normalizedPmid}::${picoFp}`, cleanItem);
      }
    }
    return [...cachedResults, ...validFresh];
  }

  return cachedResults;
}

/**
 * AGENT DE SCREENING AUGMENTÉ : Évaluation clinique profonde d'un article PubMed (Tier 'batch')
 */
export async function aiScreenSingleArticle(
  article: { pmid: string; title: string; abstract: string; meshHeadings?: string[] },
  pico: { p: string; i: string; c: string; o: string; not?: string }
): Promise<{ status: 'included' | 'maybe' | 'excluded'; exclusionReason?: string; evidenceSnippet?: string } | null> {
  const picoFp = computePicoFingerprint(pico);
  const cacheKey = `${String(article.pmid).trim()}::${picoFp}`;
  const cached = screeningDecisionCache.get(cacheKey);
  if (cached) {
    return {
      status: cached.status,
      exclusionReason: cached.exclusionReason,
      evidenceSnippet: cached.evidenceSnippet
    };
  }

  const prompt = `Tu es un médecin méthodologiste expert en revues systématiques (directives PRISMA 2020 et Cochrane Handbook).
Évalue l'éligibilité de cet article PubMed pour la sélection d'une revue systématique.

CRITÈRES D'ÉLIGIBILITÉ (PICO/PECO) :
- Population cible (P) : "${pico.p}"
- Intervention / Exposition cible (I/E) : "${pico.i}"
- Comparateur (C) : "${pico.c || 'Non spécifié'}"
- Critère de jugement (O) : "${pico.o || 'Non spécifié'}"
- Critères d'exclusion formels (NOT) : "${pico.not || 'Aucun'}"

ARTICLE PUBMED À ÉVALUER :
Titre : ${article.title}
Résumé (Abstract) :
${compressAbstractForLlm(article.abstract, 1200)}
Termes MeSH indexés : ${(article.meshHeadings || []).join(', ') || "Non indexé"}

DIRECTIVES DE DÉCISION :
1. "excluded" : Modèle animal/in vitro, éditorial sans données originales, ou non-conformité certaine au PICO/NOT.
2. "maybe" : Résumé absent ou information insuffisante nécessitant la lecture du texte intégral (principe de précaution Cochrane).
3. "included" : Conformité claire aux critères PICO.

Réponds STRICTEMENT au format JSON avec cette structure :
{
  "status": "included" | "maybe" | "excluded",
  "exclusionReason": "Motif médical d'exclusion en français (laisse vide si inclus ou maybe)",
  "evidenceSnippet": "Courte justification clinique en français"
}`;

  const system = "Tu es un évaluateur clinique strict pour une revue systématique médicale. Réponds exclusivement en JSON valide.";
  const rawResponse = await queryAiModel(prompt, system, 'batch');
  if (!rawResponse) return null;

  try {
    const parsed = extractJsonFromLlmResponse<{ status?: string; exclusionReason?: string; evidenceSnippet?: string }>(rawResponse);
    if (parsed && (parsed.status === 'included' || parsed.status === 'maybe' || parsed.status === 'excluded')) {
      const result: BatchScreenItemResult = {
        pmid: String(article.pmid).trim(),
        status: parsed.status,
        exclusionReason: parsed.exclusionReason || (parsed.status === 'excluded' ? "Non-conformité aux critères d'éligibilité PICO" : undefined),
        evidenceSnippet: parsed.evidenceSnippet || (parsed.status === 'included' ? "Conforme aux critères d'éligibilité PICO." : parsed.status === 'maybe' ? "À vérifier sur texte intégral." : "Critère d'exclusion identifié.")
      };
      screeningDecisionCache.set(cacheKey, result);
      return result;
    }
  } catch {}

  return null;
}

export interface AuditRefinementResult {
  refinedPico: { p: string; i: string; c: string; o: string; not?: string };
  activePico?: { p?: boolean; i?: boolean; c?: boolean; o?: boolean; not?: boolean };
  qualifications?: PicoSemanticQualifications;
  strategy?: 'sensitive' | 'balanced' | 'specific';
  explanation: string;
}

/**
 * Supprime les périphrases narratives d'introduction clinique (ex: "Patients en prévention secondaire après un...")
 * et les posologies chiffrées (ex: "(0,5 mg/j)", "à faible dose") pour isoler le concept médical pur.
 */
export function stripClinicalNarrativeFraming(rawClause: string): string {
  if (!rawClause) return "";
  let s = rawClause.trim();

  // 1. Supprimer les parenthèses purement numériques ou posologiques : ex "(0,5 mg/j)", "(> 18 ans)", "(n=120)"
  s = s.replace(/\(\s*(?:[<>≤≥=~+-]?\s*\d+[^)]*|n\s*=\s*\d+[^)]*)\)/gi, ' ').trim();

  // 2. Supprimer les compléments de posologie ou voie d'administration en fin de syntagme
  s = s.replace(/\s+(?:[àa]\s+(?:faible|forte|haute|basse|pleine)s?\s+doses?|par\s+voie\s+(?:orale|intraveineuse|sous-cutan[ée]e|parent[ée]rale)|per\s+os)\b/gi, '');

  // 3. Éplucher itérativement les préfixes narratifs de population/intervention/outcome (jusqu'à 4 passes)
  const narrativePrefixPatterns: RegExp[] = [
    // Préfixes de population + prévention + préposition ("Patients en prévention secondaire après un ...")
    /^(?:(?:chez\s+(?:les|des)\s+)?(?:patients?|adultes?|sujets?|enfants?|personnes?|femmes?|hommes?|individus?|population|participants?)\s+(?:adultes?\s+|âg[ée]s?\s+|p[ée]diatriques?\s+)?)?(?:en\s+pr[ée]vention\s+(?:primaire|secondaire|tertiaire)\s+(?:apr[èe]s|post[\s-]*|suite\s+[àa]|d['’]|de\s+l['’]|du|de\s+la|des|pour)\s+(?:un[e]?\s+|des\s+|l['’])?)/i,
    // Préfixes de population génériques suivis d'un participe ou préposition ("Patients adultes atteints de ...", "Patients ayant présenté un ...")
    /^(?:chez\s+(?:les|des)\s+)?(?:patients?|adultes?|sujets?|enfants?|personnes?|femmes?|hommes?|individus?|population|participants?)\s+(?:adultes?\s+|âg[ée]s?\s+|p[ée]diatriques?\s+)?(?:atteints?\s+(?:de|d['’]|du|de\s+la|des)\s*|souffrant\s+(?:de|d['’]|du|de\s+la|des)\s*|pr[ée]sentant\s+(?:un[e]?\s+|des\s+|l['’])?|ayant\s+(?:pr[ée]sent[ée]|eu|subi|fait)\s+(?:un[e]?\s+|des\s+|l['’])?|hospitalis[ée]s?\s+pour\s+(?:un[e]?\s+|des\s+|l['’])?|pris\s+en\s+charge\s+pour\s+(?:un[e]?\s+|des\s+|l['’])?|trait[ée]s?\s+(?:par|pour)\s+(?:un[e]?\s+|des\s+|l['’])?|avec\s+(?:un[e]?\s+|des\s+|l['’])?|en\s+(?=surpoids|ob[ée]sit[ée]|insuffisance|choc|r[ée]mission|phase)|apr[èe]s\s+(?:un[e]?\s+|des\s+|l['’])?|suite\s+[àa]\s+(?:un[e]?\s+|des\s+|l['’])?|post[\s-]+(?=[a-zàâäéèêëîïôöùûüç]{4}))/i,
    // Préfixes d'intervention ou de critère de jugement ("Traitement par ...", "Évaluation de ...")
    /^(?:traitement\s+par\s+|administration\s+(?:de|d['’]|du|des)\s*|prise\s+en\s+charge\s+par\s+|th[ée]rapie\s+par\s+|suppl[ée]mentation\s+en\s+|[ée]valuation\s+(?:de|d['’]|du|de\s+la|des)\s*|mesure\s+(?:de|d['’]|du|de\s+la|des)\s*|incidence\s+(?:de|d['’]|du|de\s+la|des)\s*|risque\s+(?:de|d['’]|du|de\s+la|des)\s*|survenue\s+(?:de|d['’]|du|de\s+la|des)\s*)/i,
    // Prépositions d'antécédent isolées en début de second membre ("... ou après un syndrome coronarien aigu")
    /^(?:apr[èe]s\s+(?:un[e]?\s+|des\s+|l['’])?|suite\s+[àa]\s+(?:un[e]?\s+|des\s+|l['’])?)/i,
    // Articles résiduels en début de syntagme ("un syndrome coronarien aigu" -> "syndrome coronarien aigu")
    /^(?:un[e]?\s+|des\s+|le\s+|la\s+|les\s+|l['’]|du\s+|de\s+la\s+|de\s+l['’]|d['’])/i
  ];

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const pat of narrativePrefixPatterns) {
      const next = s.replace(pat, '').trim();
      if (next && next.length >= 2 && next !== s) {
        s = next;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return s.replace(/\s+/g, ' ').trim();
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
3. Pour chaque axe actif modifié ou conservé, fournis dans "englishCoreTerms" 1 à 4 concepts anglais NLM concis candidats à la validation NCBI Entrez (db=mesh), afin de préserver une résolution MeSH exacte.

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
  if (!rawResponse) return null;

  try {
    const parsed = extractJsonFromLlmResponse<{
      refinedPico?: { p?: string; i?: string; c?: string; o?: string; not?: string };
      activePico?: { p?: boolean; i?: boolean; c?: boolean; o?: boolean; not?: boolean };
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
    if (parsed && parsed.refinedPico) {
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

        const englishCoreTerms =
          unionHints.length > 0
            ? unionHints.slice(0, 8)
            : deterministic.englishCoreTerms;

        return {
          axisRole: deterministic.axisRole,
          impliedSubheadings:
            currentQualifications?.[axisKey]?.impliedSubheadings && isUnchanged
              ? currentQualifications[axisKey]!.impliedSubheadings
              : deterministic.impliedSubheadings,
          coreClinicalConcept: deterministic.coreClinicalConcept,
          englishCoreTerms
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
  } catch {}

  return null;
}

/**
 * Optimisation directe de la syntaxe de l'équation de recherche par l'IA
 * SANS modifier les champs PICO de l'utilisateur.
 */
export async function aiCleanAndOptimizeQuery(
  currentQuery: string,
  critiqueReport?: { observations?: readonly AuditObservationEntry[]; recommendations?: readonly string[] }
): Promise<string | null> {
  const observationsText = normalizeAuditObservations(critiqueReport?.observations || [])
    .map(o => `- [${o.severity.toUpperCase()}] ${o.text}`)
    .join('\n');
  const recommendationsText = (critiqueReport?.recommendations || []).map(r => `- ${r}`).join('\n');

  const prompt = `Tu es un expert mondial en syntaxe documentaire PubMed/MEDLINE pour les revues systématiques (PRISMA 2020 / Cochrane).
Voici l'équation de recherche PubMed actuelle :
${currentQuery}

${observationsText ? `OBSERVATIONS DE L'AUDIT :\n${observationsText}\n` : ''}
${recommendationsText ? `RECOMMANDATIONS MÉTHODOLOGIQUES :\n${recommendationsText}\n` : ''}

MISSION DE NETTOYAGE TECHNIQUE DE L'ÉQUATION :
1. Corrige toute erreur de syntaxe PubMed (guillemets imbriqués, doubles guillemets "", balises [TiAb] ou [Mesh] mal placées ou doublées à l'extérieur des parenthèses).
2. Supprime les termes parasites ou hors-sujet identifiés par l'audit (ex: faux-amis comme "hunger strike", troncatures trop courtes générant du bruit).
3. Assure-toi que les parenthèses booléennes sont rigoureusement équilibrées (AND entre les blocs majeurs, OR au sein de chaque bloc).
4. Respecte scrupuleusement la question clinique initiale.

Réponds STRICTEMENT au format JSON avec cette structure :
{
  "cleanedQuery": "L'équation PubMed corrigée prête à l'emploi"
}`;

  const system = "Tu es un spécialiste de la syntaxe PubMed. Réponds exclusivement en JSON valide contenant la clé cleanedQuery.";
  const rawResponse = await queryAiModel(prompt, system, 'reasoning');
  if (!rawResponse) return null;

  const parsed = extractJsonFromLlmResponse<{ cleanedQuery?: string }>(rawResponse);
  if (parsed?.cleanedQuery && typeof parsed.cleanedQuery === 'string' && parsed.cleanedQuery.trim().length > 0) {
    return parsed.cleanedQuery.trim();
  }

  let cleaned = rawResponse.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }
  return cleaned || null;
}

const meshSuggestionCache = new Map<string, string[]>();

/**
 * Traduit un concept médical en descripteurs MeSH NLM anglophones candidats via l'IA active,
 * utilisé en secours lorsque les traducteurs lexicaux classiques échouent à résoudre un descripteur NLM.
 */
export async function aiSuggestMeshCandidates(concept: string): Promise<string[]> {
  const clean = concept.trim();
  if (!clean) return [];
  const cacheKey = clean.toLowerCase();
  if (meshSuggestionCache.has(cacheKey)) {
    return meshSuggestionCache.get(cacheKey)!;
  }

  const config = getAiConfig();
  if (config.provider === 'deterministic') return [];

  const prompt = `Concept clinique : "${clean}". Donne 1 à 2 descripteurs MeSH NLM officiels en anglais (ex: "Diet", "Overweight"). Réponds en JSON : {"candidates": ["MeSH 1"]}`;
  const system = "Expert NLM MeSH. Réponds uniquement en JSON valide.";
  try {
    const raw = await queryAiModel(prompt, system, 'batch');
    if (!raw) return [];
    const parsed = extractJsonFromLlmResponse<{ candidates?: string[] }>(raw);
    if (parsed && Array.isArray(parsed.candidates)) {
      const list = parsed.candidates.map(c => String(c).trim()).filter(Boolean);
      meshSuggestionCache.set(cacheKey, list);
      return list;
    }
  } catch {}
  return [];
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
 * Pré-évaluation déterministe Cochrane RoB 2 / ROBINS-I / AMSTAR 2 basée sur l'analyse lexicale
 * du titre et du résumé (utilisée en mode Règles PRISMA ou en secours si un article du lot est omis par le LLM).
 * Respecte la règle stricte Cochrane : tout domaine non explicitement documenté dans l'abstract = 'moderate'.
 */
export function evaluateArticleRoB2Deterministic(
  article: { pmid: string; title: string; abstract: string; publicationTypes?: readonly string[] },
  evaluatedByLabel = 'Règles méthodologiques Cochrane (Analyse du résumé)'
): Rob2ArticleEvaluation {
  const pmid = String(article.pmid).trim();
  const title = article.title || '';
  const abstract = article.abstract || '';
  const combined = `${title} ${abstract}`.toLowerCase();
  const studyDesign = inferStudyDesignFromText(title, abstract, article.publicationTypes);

  // D1 : Randomisation / Sélection / Confusion
  let d1: 'low' | 'moderate' | 'high' = 'moderate';
  if (/\b(?:computer-generated|allocation\s+concealment|block\s+randomi[sz]ation|stratified\s+randomi[sz]ation|propensity\s+score|multivariable\s+adjusted)\b/.test(combined)) {
    d1 = 'low';
  } else if (studyDesign === 'observational' && /\b(?:unadjusted|case\s+series|retrospective\s+chart)\b/.test(combined)) {
    d1 = 'high';
  }

  // D2 : Déviations / Insu (Blinding)
  let d2: 'low' | 'moderate' | 'high' = 'moderate';
  if (/\b(?:double-blind|double\s+blind|triple-blind|placebo-controlled)\b/.test(combined)) {
    d2 = 'low';
  } else if (/\b(?:open-label|open\s+label|unblinded)\b/.test(combined) && /\b(?:non-adherence|crossover\s+contamination)\b/.test(combined)) {
    d2 = 'high';
  }

  // D3 : Données manquantes / Attrition (ITT)
  let d3: 'low' | 'moderate' | 'high' = 'moderate';
  if (/\b(?:intention-to-treat|intent-to-treat|\bitt\b|complete\s+follow-up|no\s+loss\s+to\s+follow-up)\b/.test(combined)) {
    d3 = 'low';
  } else if (/\b(?:high\s+dropout|high\s+attrition|per-protocol\s+only)\b/.test(combined)) {
    d3 = 'high';
  }

  // D4 : Mesure du critère de jugement
  let d4: 'low' | 'moderate' | 'high' = 'moderate';
  if (/\b(?:body\s+weight|bmi|mortality|blood\s+markers|hormones|biochemical|blinded\s+assessor|laboratory|fecal\s+microbiota|liver)\b/.test(combined)) {
    d4 = 'low';
  } else if (/\b(?:self-reported|subjective\s+questionnaire)\b/.test(combined) && !/\b(?:double-blind)\b/.test(combined)) {
    d4 = 'high';
  }

  // D5 : Sélection du résultat rapporté (Enregistrement NCT / PROSPERO)
  let d5: 'low' | 'moderate' | 'high' = 'moderate';
  if (/\b(?:nct\d{6,10}|isrctn\d+|prospero|crd\d+|eudract|registered\s+at\s+clinicaltrials)\b/.test(combined)) {
    d5 = 'low';
  }

  const overall = computeCochraneOverallRating(d1, d2, d3, d4, d5);

  const notes: string[] = [];
  if (studyDesign === 'rct') notes.push('Essai contrôlé randomisé');
  else if (studyDesign === 'review') notes.push('Revue systématique');
  else if (studyDesign === 'observational') notes.push('Étude observationnelle');
  else notes.push('Revue narrative / Recommandation / Autre format');

  if (d2 === 'low') notes.push('double-insu documenté');
  else notes.push('insu non documenté dans le résumé (coté Modéré par précaution Cochrane)');

  if (d4 === 'low') notes.push('critère de jugement objectif/biologique');
  if (d5 === 'low') notes.push('protocole enregistré');

  return {
    pmid,
    d1,
    d2,
    d3,
    d4,
    d5,
    overall,
    studyDesign,
    justification: `${notes.join(', ')}.`,
    evaluatedBy: evaluatedByLabel
  };
}

/**
 * Évalue le risque de biais d'une étude incluse selon les 5 domaines Cochrane RoB 2 / ROBINS-I
 * avec règle stricte anti-hallucination sur résumé (tout élément non documenté dans l'abstract = "moderate").
 */
export async function aiEvaluateArticleRoB2(
  article: { pmid: string; title: string; abstract: string; publicationTypes?: readonly string[] }
): Promise<Rob2ArticleEvaluation | null> {
  const batchRes = await aiEvaluateBatchRoB2([article]);
  return batchRes.get(String(article.pmid)) || null;
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
  if (aiConfig.provider === 'deterministic') {
    for (const art of articles) {
      if (abortSignal?.aborted) {
        throw createAbortError();
      }
      const det = evaluateArticleRoB2Deterministic(art);
      resultMap.set(det.pmid, det);
    }
    return resultMap;
  }

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

RÈGLES MÉTHODOLOGIQUES STRICTES (ANTI-HALLUCINATION SUR RÉSUMÉ) :
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

  if (rawResponse) {
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
  }

  // Garantie de complétude : tout article du lot non couvert par la réponse LLM reçoit l'évaluation déterministe Cochrane
  for (const art of articles) {
    const key = String(art.pmid).trim();
    if (!resultMap.has(key)) {
      resultMap.set(key, evaluateArticleRoB2Deterministic(art));
    }
  }

  return resultMap;
}


