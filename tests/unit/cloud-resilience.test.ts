import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onRequest as hetopPagesProxyOnRequest } from '../../functions/api/hetop/[[path]]';
import {
  queryAiModel,
  extractJsonFromLlmResponse,
  aiScreenBatchArticles,
  aiRefinePicoFromAudit,
  saveAiConfig,
  clearAiScreeningCache,
  mapErrorToUserMessage
} from '../../src/services/localAiService';
import {
  runAgentScreeningDeep,
  ScreeningReport
} from '../../src/services/agentScreener';

interface TestArticleInput {
  pmid: string;
  title: string;
  authors: string;
  source: string;
  pubDate: string;
  abstract: string;
  meshHeadings: string[];
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    }
  };
}

function makeJsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {})
    }
  });
}

function makeGeminiOk(text: string): Response {
  return makeJsonResponse(200, {
    candidates: [{ content: { parts: [{ text }] } }]
  });
}

function makeOpenAiOk(text: string): Response {
  return makeJsonResponse(200, {
    choices: [{ message: { content: text } }]
  });
}

function makeAnthropicOk(text: string): Response {
  return makeJsonResponse(200, {
    content: [{ text }]
  });
}

function makeSampleArticles(count: number, startPmid = 50000001): TestArticleInput[] {
  return Array.from({ length: count }, (_, idx) => {
    const pmid = String(startPmid + idx);
    return {
      pmid,
      title: `Clinical study #${idx + 1} on drug-induced parkinsonism`,
      authors: `Bayen S, Author ${idx + 1}`,
      source: 'Mov Disord',
      pubDate: '2025',
      abstract: `Randomized observational evaluation of antipsychotic exposure and secondary parkinsonism in adult primary care cohort #${idx + 1}.`,
      meshHeadings: ['Humans', 'Parkinson Disease, Secondary', 'Antipsychotic Agents']
    };
  });
}

function extractGeminiModelFromUrl(url: string): string {
  const match = url.match(/\/models\/([^:]+):generateContent/);
  return match ? match[1] : url;
}

function parseBodyJson(init?: RequestInit): Record<string, unknown> {
  if (!init || typeof init.body !== 'string') return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function getHeaderValue(init: RequestInit | undefined, name: string): string | null {
  if (!init?.headers) return null;
  if (init.headers instanceof Headers) {
    return init.headers.get(name);
  }
  if (Array.isArray(init.headers)) {
    const found = init.headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return found ? found[1] : null;
  }
  const record = init.headers as Record<string, string>;
  const matchedKey = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
  return matchedKey ? record[matchedKey] : null;
}

type SettledOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function settleWithFakeTimers<T>(promise: Promise<T>): Promise<SettledOutcome<T>> {
  const wrapped: Promise<SettledOutcome<T>> = promise.then(
    (value): SettledOutcome<T> => ({ ok: true, value }),
    (error: unknown): SettledOutcome<T> => ({ ok: false, error })
  );
  await vi.runAllTimersAsync();
  return await wrapped;
}

describe('Suite TDD · Résilience Cloud Multi-Fournisseurs, Parsing JSON, Cache FinOps & Annulation (0 €)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    clearAiScreeningCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ===========================================================================
  // BLOC 1 : Cascade de Fallback HTTP 404 / 429 / 503 & Failover Inter-Fournisseurs
  // ===========================================================================
  describe('1. Cascade de fallback HTTP 404 / 429 / 503 (Gemini, OpenAI, Anthropic)', () => {
    it('Gemini : doit basculer sur 404 -> 429 -> 503 -> 200 selon l’ordre gemini-pro-latest -> gemini-flash-latest -> gemini-flash-lite-latest', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      saveAiConfig({
        provider: 'gemini',
        routingMode: 'smart',
        geminiApiKey: 'test-gemini-key-0001'
      });

      const postModelsSequence: string[] = [];
      let flashLiteCalls = 0;

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();

        if (method === 'GET' && url.includes('generativelanguage.googleapis.com/v1beta/models?key=')) {
          return makeJsonResponse(200, { models: [] });
        }

        if (method === 'POST' && url.includes('generativelanguage.googleapis.com/v1beta/models/')) {
          const model = extractGeminiModelFromUrl(url);
          postModelsSequence.push(model);

          if (model === 'gemini-pro-latest') {
            return makeJsonResponse(404, { error: { message: 'Model not found' } });
          }
          if (model === 'gemini-flash-latest') {
            return makeJsonResponse(429, { error: { message: 'Quota exceeded, retry in 20s' } });
          }
          if (model === 'gemini-flash-lite-latest') {
            flashLiteCalls++;
            if (flashLiteCalls === 1) {
              return makeJsonResponse(503, { error: { message: 'Service Unavailable: high demand' } });
            }
            return makeGeminiOk('{"ok":true}');
          }
        }

        throw new Error(`Appel réseau inattendu dans le test mocké : ${method} ${url}`);
      });

      vi.stubGlobal('fetch', fetchMock);

      const outcome = await settleWithFakeTimers(queryAiModel('Test prompt', 'System', 'reasoning'));
      if (!outcome.ok) throw outcome.error;

      expect(outcome.value).toBe('{"ok":true}');
      expect(postModelsSequence).toEqual([
        'gemini-pro-latest',
        'gemini-flash-latest',
        'gemini-flash-lite-latest',
        'gemini-flash-lite-latest'
      ]);
    });

    it('OpenAI (404 + 503 -> 200) : doit envoyer Bearer token, ignorer le 404 et réessayer le 503 sur gpt-4o-mini', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-openai-0001'
      });

      const requestedModels: string[] = [];
      let miniCalls = 0;

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url !== 'https://api.openai.com/v1/chat/completions') {
          throw new Error(`URL inattendue : ${url}`);
        }
        expect(getHeaderValue(init, 'Authorization')).toBe('Bearer sk-test-openai-0001');

        const body = parseBodyJson(init);
        const model = String(body.model ?? '');
        requestedModels.push(model);

        if (model === 'gpt-4o') {
          return makeJsonResponse(404, { error: { message: 'The model gpt-4o does not exist' } });
        }
        if (model === 'gpt-4o-mini') {
          miniCalls++;
          if (miniCalls === 1) {
            return makeJsonResponse(503, { error: { message: 'Server overloaded' } });
          }
          return makeOpenAiOk('{"provider":"openai"}');
        }

        throw new Error(`Modèle OpenAI inattendu : ${model}`);
      });

      vi.stubGlobal('fetch', fetchMock);

      const outcome = await settleWithFakeTimers(queryAiModel('Test OpenAI', 'System', 'reasoning'));
      if (!outcome.ok) throw outcome.error;

      expect(outcome.value).toBe('{"provider":"openai"}');
      expect(requestedModels).toEqual(['gpt-4o', 'gpt-4o-mini', 'gpt-4o-mini']);
    });

    it('OpenAI (429 avec fallback disponible) : doit basculer immédiatement de gpt-4o vers gpt-4o-mini sans 3 tentatives bloquantes', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-openai-429'
      });

      const requestedModels: string[] = [];

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url !== 'https://api.openai.com/v1/chat/completions') {
          throw new Error(`URL inattendue : ${url}`);
        }
        const body = parseBodyJson(init);
        const model = String(body.model ?? '');
        requestedModels.push(model);

        if (model === 'gpt-4o') {
          return makeJsonResponse(429, { error: { message: 'Rate limit reached for gpt-4o' } });
        }
        if (model === 'gpt-4o-mini') {
          return makeOpenAiOk('{"switched":"gpt-4o-mini"}');
        }
        throw new Error(`Modèle OpenAI inattendu : ${model}`);
      });

      vi.stubGlobal('fetch', fetchMock);

      const outcome = await settleWithFakeTimers(queryAiModel('Test 429 OpenAI', 'System', 'reasoning'));
      if (!outcome.ok) throw outcome.error;

      expect(outcome.value).toBe('{"switched":"gpt-4o-mini"}');
      expect(requestedModels).toEqual(['gpt-4o', 'gpt-4o-mini']);
    });

    it('Anthropic (429 / 529 -> 200) : doit envoyer les headers officiels et basculer dès le premier 429 vers claude-3-5-haiku-latest', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      saveAiConfig({
        provider: 'anthropic',
        routingMode: 'smart',
        anthropicApiKey: 'sk-ant-test-0001'
      });

      const requestedModels: string[] = [];
      let haikuCalls = 0;

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url !== 'https://api.anthropic.com/v1/messages') {
          throw new Error(`URL inattendue : ${url}`);
        }
        expect(getHeaderValue(init, 'x-api-key')).toBe('sk-ant-test-0001');
        expect(getHeaderValue(init, 'anthropic-version')).toBe('2023-06-01');

        const body = parseBodyJson(init);
        const model = String(body.model ?? '');
        requestedModels.push(model);

        if (model === 'claude-3-5-sonnet-latest') {
          return makeJsonResponse(429, { error: { message: 'rate_limit_error' } });
        }
        if (model === 'claude-3-5-haiku-latest') {
          haikuCalls++;
          if (haikuCalls === 1) {
            return makeJsonResponse(529, { error: { message: 'overloaded_error' } });
          }
          return makeAnthropicOk('{"provider":"anthropic"}');
        }
        throw new Error(`Modèle Anthropic inattendu : ${model}`);
      });

      vi.stubGlobal('fetch', fetchMock);

      const outcome = await settleWithFakeTimers(queryAiModel('Test Claude', 'System', 'reasoning'));
      if (!outcome.ok) throw outcome.error;

      expect(outcome.value).toBe('{"provider":"anthropic"}');
      expect(requestedModels).toEqual([
        'claude-3-5-sonnet-latest',
        'claude-3-5-haiku-latest',
        'claude-3-5-haiku-latest'
      ]);
    });

    it('Failover inter-fournisseurs : doit basculer automatiquement Gemini (503) -> OpenAI (429) -> Anthropic (200) si leurs clés sont configurées', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      saveAiConfig({
        provider: 'gemini',
        routingMode: 'smart',
        geminiApiKey: 'test-gemini-key-0002',
        openaiApiKey: 'sk-test-openai-0002',
        anthropicApiKey: 'sk-ant-test-0002'
      });

      const providersVisited = new Set<string>();

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();

        if (method === 'GET' && url.includes('generativelanguage.googleapis.com/v1beta/models?key=')) {
          return makeJsonResponse(200, { models: [] });
        }
        if (url.includes('generativelanguage.googleapis.com')) {
          providersVisited.add('gemini');
          return makeJsonResponse(503, { error: { message: 'Gemini high demand' } });
        }
        if (url.includes('api.openai.com')) {
          providersVisited.add('openai');
          return makeJsonResponse(429, { error: { message: 'OpenAI rate limit' } });
        }
        if (url.includes('api.anthropic.com')) {
          providersVisited.add('anthropic');
          return makeAnthropicOk('{"fallback":"anthropic"}');
        }
        throw new Error(`URL inattendue : ${url}`);
      });

      vi.stubGlobal('fetch', fetchMock);

      const outcome = await settleWithFakeTimers(queryAiModel('Failover multi-cloud', 'System', 'reasoning'));
      if (!outcome.ok) throw outcome.error;

      expect(outcome.value).toBe('{"fallback":"anthropic"}');
      expect(Array.from(providersVisited)).toEqual(['gemini', 'openai', 'anthropic']);
    });

    it('Fail-Fast sur erreur d’authentification (401 / 403) : aucun retry ni cascade et message utilisateur clair', async () => {
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-invalid-key'
      });

      const openAiCalls: string[] = [];
      const fetchOpenAi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        openAiCalls.push(String(input));
        void init;
        return makeJsonResponse(401, { error: { message: 'Incorrect API key provided' } });
      });
      vi.stubGlobal('fetch', fetchOpenAi);

      await expect(queryAiModel('Auth test OpenAI', 'System', 'reasoning')).rejects.toThrow(/Clé API/i);
      expect(openAiCalls).toHaveLength(1);

      saveAiConfig({
        provider: 'gemini',
        routingMode: 'smart',
        geminiApiKey: 'AIza-invalid-key-0000'
      });

      const geminiPostCalls: string[] = [];
      const fetchGemini = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.includes('/v1beta/models?key=')) {
          return makeJsonResponse(200, { models: [] });
        }
        if (method === 'POST') {
          geminiPostCalls.push(url);
          return makeJsonResponse(403, { error: { message: 'Permission denied for API key' } });
        }
        throw new Error(`Appel inattendu : ${method} ${url}`);
      });
      vi.stubGlobal('fetch', fetchGemini);

      let caughtError: unknown = null;
      try {
        await queryAiModel('Auth test Gemini', 'System', 'reasoning');
      } catch (err: unknown) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(mapErrorToUserMessage(caughtError)).toMatch(/Clé API/i);
      expect(geminiPostCalls).toHaveLength(1);
    });
  });

  // ===========================================================================
  // BLOC 2 : Parsing Défensif JSON
  // ===========================================================================
  describe('2. Parsing défensif JSON (markdown, wrappers, malformé, tronqué)', () => {
    it('doit extraire un tableau JSON depuis un bloc ```json ... ``` même suivi de texte contenant des crochets [1] [Cochrane]', () => {
      const raw = [
        'Voici l’analyse demandée :',
        '```json',
        '[{"pmid":"1001","status":"included","evidenceSnippet":"ECR conforme"}]',
        '```',
        'Référence méthodologique [1] selon [Cochrane].'
      ].join('\n');

      const parsed = extractJsonFromLlmResponse<Array<{ pmid: string; status: string }>>(raw);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed?.[0].pmid).toBe('1001');
      expect(parsed?.[0].status).toBe('included');
    });

    it('doit déballer les wrappers objets ({"results": [...]}) et normaliser les PMIDs/statuts dans aiScreenBatchArticles', async () => {
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-json-wrapper'
      });

      const fetchMock = vi.fn(async (): Promise<Response> => {
        return makeOpenAiOk(
          JSON.stringify({
            results: [
              {
                pmid: 'PMID: 50000001',
                status: 'INCLUDED',
                evidenceSnippet: 'Conforme aux critères PICO'
              }
            ]
          })
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const articles = makeSampleArticles(1, 50000001);
      const res = await aiScreenBatchArticles(articles, {
        p: 'Adultes',
        i: 'Antipsychotiques',
        c: '',
        o: 'Syndrome parkinsonien'
      });

      expect(res).toHaveLength(1);
      expect(res[0].pmid).toBe('50000001');
      expect(res[0].status).toBe('included');
    });

    it('doit retourner null dans extractJsonFromLlmResponse et propager une erreur explicite dans aiScreenBatchArticles sur JSON malformé', async () => {
      expect(extractJsonFromLlmResponse('Désolé, je ne peux pas répondre à cette demande.')).toBeNull();

      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-malformed'
      });

      const fetchMock = vi.fn(async (): Promise<Response> => {
        return makeOpenAiOk('Réponse textuelle non structurée { cassé [');
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        aiScreenBatchArticles(makeSampleArticles(2, 50000010), {
          p: 'Adultes',
          i: 'Halopéridol',
          c: '',
          o: 'Parkinsonisme'
        })
      ).rejects.toThrow(/JSON de dépouillement valide/i);
    });

    it('doit récupérer les objets JSON complets d’un tableau tronqué en fin de réponse (max_tokens)', async () => {
      const truncatedJson =
        '[{"pmid":"50000001","status":"included","evidenceSnippet":"ECR valide"},{"pmid":"50000002","status":"excluded","exclusionReason":"Modèle animal","evidenceSnippet":"Étude chez le rat"},{"pmid":"50000003","status":"inc';

      const directParsed = extractJsonFromLlmResponse<Array<{ pmid: string; status: string }>>(truncatedJson);
      expect(Array.isArray(directParsed)).toBe(true);
      expect(directParsed).toHaveLength(2);
      expect(directParsed?.map(item => item.pmid)).toEqual(['50000001', '50000002']);

      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-truncated'
      });

      const fetchMock = vi.fn(async (): Promise<Response> => makeOpenAiOk(truncatedJson));
      vi.stubGlobal('fetch', fetchMock);

      const batchRes = await aiScreenBatchArticles(makeSampleArticles(3, 50000001), {
        p: 'Adultes',
        i: 'Halopéridol',
        c: '',
        o: 'Parkinsonisme'
      });

      expect(batchRes).toHaveLength(2);
      expect(batchRes.map(item => item.pmid)).toEqual(['50000001', '50000002']);
    });
  });

  // ===========================================================================
  // BLOC 3 : Cache d'Idempotence PICO / PMID
  // ===========================================================================
  describe('3. Cache d’idempotence PICO / PMID', () => {
    it('Hit total (0 appel réseau) quand le PICO ne diffère que par la casse ou les espaces', async () => {
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-cache-1'
      });

      let networkCalls = 0;
      const fetchMock = vi.fn(async (): Promise<Response> => {
        networkCalls++;
        return makeOpenAiOk(
          JSON.stringify([
            { pmid: '50000001', status: 'included', evidenceSnippet: 'Pertinent' },
            { pmid: '50000002', status: 'excluded', exclusionReason: 'Hors sujet', evidenceSnippet: 'Exclu' }
          ])
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const articles = makeSampleArticles(2, 50000001);
      const first = await aiScreenBatchArticles(articles, {
        p: 'Adultes',
        i: 'Halopéridol',
        c: 'Placebo',
        o: 'Parkinsonisme'
      });
      expect(first).toHaveLength(2);
      expect(networkCalls).toBe(1);

      const second = await aiScreenBatchArticles(articles, {
        p: '  adultes ',
        i: 'HALOPÉRIDOL',
        c: ' placebo ',
        o: 'parkinsonisme'
      });
      expect(second).toHaveLength(2);
      expect(second).toEqual(first);
      expect(networkCalls).toBe(1);
    });

    it('Hit partiel (déduplication différentielle) : n’envoie que les PMIDs absents du cache et fusionne les résultats', async () => {
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-cache-2'
      });

      const sentBodies: string[] = [];
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const bodyStr = typeof init?.body === 'string' ? init.body : '';
        sentBodies.push(bodyStr);

        if (sentBodies.length === 1) {
          return makeOpenAiOk(
            JSON.stringify([
              { pmid: '50000001', status: 'included', evidenceSnippet: 'Notice 1 OK' },
              { pmid: '50000002', status: 'maybe', evidenceSnippet: 'Notice 2 à vérifier' }
            ])
          );
        }
        return makeOpenAiOk(
          JSON.stringify([
            { pmid: '50000003', status: 'excluded', exclusionReason: 'Modèle animal', evidenceSnippet: 'Notice 3 exclue' }
          ])
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const pico = { p: 'Adultes', i: 'Halopéridol', c: '', o: 'Parkinsonisme' };
      const allThree = makeSampleArticles(3, 50000001);

      await aiScreenBatchArticles(allThree.slice(0, 2), pico);
      const merged = await aiScreenBatchArticles(allThree, pico);

      expect(sentBodies).toHaveLength(2);
      expect(sentBodies[1]).toContain('50000003');
      expect(sentBodies[1]).not.toContain('50000001');
      expect(sentBodies[1]).not.toContain('50000002');
      expect(merged).toHaveLength(3);
      expect(merged.map(m => m.pmid)).toEqual(['50000001', '50000002', '50000003']);
    });

    it('Invalidation sur modification du PICO (ex: ajout d’un critère NOT) : déclenche un nouvel appel API', async () => {
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        openaiApiKey: 'sk-test-cache-3'
      });

      let networkCalls = 0;
      const fetchMock = vi.fn(async (): Promise<Response> => {
        networkCalls++;
        return makeOpenAiOk(
          JSON.stringify([
            {
              pmid: '50000001',
              status: networkCalls === 1 ? 'included' : 'excluded',
              exclusionReason: networkCalls === 1 ? undefined : 'Exclu par critère NOT',
              evidenceSnippet: 'Évalué'
            }
          ])
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const art = makeSampleArticles(1, 50000001);
      const res1 = await aiScreenBatchArticles(art, {
        p: 'Adultes',
        i: 'Halopéridol',
        c: '',
        o: 'Parkinsonisme',
        not: ''
      });
      const res2 = await aiScreenBatchArticles(art, {
        p: 'Adultes',
        i: 'Halopéridol',
        c: '',
        o: 'Parkinsonisme',
        not: 'Pédiatrie'
      });

      expect(networkCalls).toBe(2);
      expect(res1[0].status).toBe('included');
      expect(res2[0].status).toBe('excluded');
    });
  });

  // ===========================================================================
  // BLOC 4 : Annulation Propre d'un Lot Parallèle en Étape 3 via AbortController
  // ===========================================================================
  describe('4. Annulation propre d’un lot parallèle en Étape 3 via AbortController', () => {
    it('doit annuler proprement entre deux vagues parallèles (45 articles : vague 1 complète, vague 2 jamais envoyée et 5 derniers en pending)', async () => {
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        rateLimitMode: 'payg',
        openaiApiKey: 'sk-test-cancel-1'
      });

      const controller = new AbortController();
      const articles = makeSampleArticles(45, 50000001);
      let fetchCalls = 0;

      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        fetchCalls++;
        const callIndex = fetchCalls;
        const startOffset = (callIndex - 1) * 20;
        const payload = articles.slice(startOffset, startOffset + 20).map(a => ({
          pmid: a.pmid,
          status: 'included',
          evidenceSnippet: 'Conforme'
        }));

        if (callIndex === 2) {
          // Déclenche l'annulation juste à la fin de la vague 1 (2 lots de 20)
          controller.abort();
        }
        void init;
        return makeOpenAiOk(JSON.stringify(payload));
      });
      vi.stubGlobal('fetch', fetchMock);

      const report = await runAgentScreeningDeep(
        articles,
        { p: 'Adultes', i: 'Antipsychotiques', c: '', o: 'Syndrome parkinsonien' },
        undefined,
        undefined,
        () => controller.signal.aborted
      );

      expect(fetchCalls).toBe(2);
      expect(report.screenedArticles).toHaveLength(45);
      expect(report.totalIncluded).toBe(40);
      expect(report.totalPending).toBe(5);
      expect(report.screenedArticles.slice(40).every(a => a.status === 'pending')).toBe(true);
    });

    it('doit propager AbortSignal aux appels fetch en plein vol et laisser les 40 articles en statut pending lors de controller.abort()', async () => {
      saveAiConfig({
        provider: 'openai',
        routingMode: 'smart',
        rateLimitMode: 'payg',
        openaiApiKey: 'sk-test-cancel-2'
      });

      const controller = new AbortController();
      const articles = makeSampleArticles(40, 60000001);
      const capturedSignals: Array<AbortSignal | undefined> = [];
      let waveStartedResolve: (() => void) | null = null;
      const waveStarted = new Promise<void>(resolve => {
        waveStartedResolve = resolve;
      });

      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal ?? undefined;
        capturedSignals.push(signal);
        if (capturedSignals.length === 2 && waveStartedResolve) {
          waveStartedResolve();
        }

        return new Promise<Response>((resolve, reject) => {
          const fallbackGuard = setTimeout(() => {
            // Garde-fou : évite de bloquer Vitest 35s si l'AbortSignal appelant n'est pas propagé à fetch
            resolve(
              makeOpenAiOk(
                JSON.stringify(
                  articles.slice(0, 20).map(a => ({
                    pmid: a.pmid,
                    status: 'included',
                    evidenceSnippet: 'Traité car signal non propagé'
                  }))
                )
              )
            );
          }, 1500);

          if (signal) {
            const onAbort = () => {
              clearTimeout(fallbackGuard);
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            };
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener('abort', onAbort, { once: true });
            }
          }
        });
      });

      vi.stubGlobal('fetch', fetchMock);

      type ScreeningWithSignalFn = (
        arts: TestArticleInput[],
        pico: { p: string; i: string; c: string; o: string; not?: string },
        onProgress?: (current: number, total: number, articleTitle: string) => void,
        onArticleScreened?: (article: unknown, index: number, total: number) => void,
        shouldCancel?: () => boolean,
        abortSignal?: AbortSignal
      ) => Promise<ScreeningReport>;

      const invokeWithSignal = runAgentScreeningDeep as unknown as ScreeningWithSignalFn;
      const runPromise = invokeWithSignal(
        articles,
        { p: 'Adultes', i: 'Antipsychotiques', c: '', o: 'Syndrome parkinsonien' },
        undefined,
        undefined,
        () => controller.signal.aborted,
        controller.signal
      );

      await waveStarted;
      controller.abort();

      const report = await runPromise;

      expect(capturedSignals.length).toBeGreaterThanOrEqual(2);
      expect(capturedSignals.some(sig => Boolean(sig?.aborted))).toBe(true);
      expect(report.totalPending).toBe(40);
      expect(report.screenedArticles.every(a => a.status === 'pending')).toBe(true);
    });
  });

  // ===========================================================================
  // BLOC 5 : Affinage PICO (aiRefinePicoFromAudit) — Conservation englishCoreTerms & garde C/NOT
  // ===========================================================================
  describe('5. Affinage PICO depuis audit (englishCoreTerms & garde-fou C/NOT)', () => {
    it('doit préserver englishCoreTerms sur les axes inchangés et empêcher la réactivation non justifiée de C (passif) / NOT', async () => {
      saveAiConfig({
        provider: 'gemini',
        routingMode: 'economy',
        geminiApiKey: 'test-gemini-key-refine'
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com/v1beta/models?key=')) {
          return makeJsonResponse(200, { models: [] });
        }
        return makeGeminiOk(
          JSON.stringify({
            refinedPico: {
              p: 'Adultes en excès pondéral ou obésité',
              i: 'Jeûne intermittent et alimentation en temps restreint',
              c: 'Alimentation habituelle',
              o: 'Variation du poids corporel',
              not: 'Diabète de type 2'
            },
            activePico: {
              p: true,
              i: true,
              c: true,
              o: true,
              not: true
            },
            englishCoreTerms: {
              i: ['Intermittent Fasting', 'Time Restricted Eating']
            },
            strategy: 'balanced',
            explanation: 'Précision de l’intervention.'
          })
        );
      });

      vi.stubGlobal('fetch', fetchMock);

      const refined = await aiRefinePicoFromAudit(
        {
          p: 'Adultes en excès pondéral ou obésité',
          i: 'Jeûne intermittent',
          c: 'Alimentation habituelle',
          o: 'Variation du poids corporel',
          not: 'Diabète de type 2'
        },
        { p: true, i: true, c: false, o: true, not: false },
        {
          score: 95,
          observations: ['✅ Bonne structure PICO.'],
          recommendations: ['Vérifier les synonymes en colonne gauche.']
        },
        {
          p: {
            axisRole: 'clinical_condition',
            impliedSubheadings: [],
            coreClinicalConcept: 'Adultes en excès pondéral ou obésité',
            englishCoreTerms: ['Overweight', 'Obesity']
          },
          o: {
            axisRole: 'clinical_condition',
            impliedSubheadings: [],
            coreClinicalConcept: 'Variation du poids corporel',
            englishCoreTerms: ['Body Weight']
          }
        }
      );

      expect(refined).not.toBeNull();
      // C (passif) et NOT décochés par l'utilisateur sans recommandation de bruit restent désactivés
      expect(refined?.activePico?.c).toBe(false);
      expect(refined?.activePico?.not).toBe(false);
      // englishCoreTerms conservés pour P et O inchangés, et mis à jour pour I
      expect(refined?.qualifications?.p?.englishCoreTerms).toEqual(['Overweight', 'Obesity']);
      expect(refined?.qualifications?.o?.englishCoreTerms).toEqual(['Body Weight']);
      expect(refined?.qualifications?.i?.englishCoreTerms).toEqual([
        'Intermittent Fasting',
        'Time Restricted Eating'
      ]);
    });

    it('préserve par union les DCI explicites et les englishCoreTerms de V1 lorsque le raffinement V2 en omet une partie', async () => {
      saveAiConfig({
        provider: 'gemini',
        routingMode: 'economy',
        geminiApiKey: 'test-gemini-key-refine-union'
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com/v1beta/models?key=')) {
          return makeJsonResponse(200, { models: [] });
        }
        return makeGeminiOk(
          JSON.stringify({
            refinedPico: {
              p: 'Diabète de type 2 et maladie rénale chronique',
              i: 'Inhibiteurs du SGLT2 (dapagliflozine, canagliflozine)',
              c: 'Placebo',
              o: 'Insuffisance rénale terminale',
              not: ''
            },
            activePico: { p: true, i: true, c: false, o: true, not: false },
            englishCoreTerms: {
              p: ['Diabetes Mellitus, Type 2'],
              i: ['Sodium-Glucose Transporter 2 Inhibitors', 'dapagliflozin'],
              o: ['Kidney Failure, Chronic']
            },
            strategy: 'balanced',
            explanation: 'Raffinement ciblé.'
          })
        );
      });

      vi.stubGlobal('fetch', fetchMock);

      const refined = await aiRefinePicoFromAudit(
        {
          p: 'Diabète de type 2 et maladie rénale chronique',
          i: 'Inhibiteurs du SGLT2 (empagliflozine, dapagliflozine, canagliflozine)',
          c: 'Placebo',
          o: 'Insuffisance rénale terminale'
        },
        { p: true, i: true, c: false, o: true, not: false },
        {
          score: 90,
          observations: [{ severity: 'warning', text: 'Préciser le critère rénal.' }],
          recommendations: []
        },
        {
          p: {
            axisRole: 'clinical_condition',
            impliedSubheadings: [],
            coreClinicalConcept: 'Diabète de type 2',
            englishCoreTerms: ['Diabetes Mellitus, Type 2', 'Renal Insufficiency, Chronic']
          },
          i: {
            axisRole: 'therapeutic_class',
            impliedSubheadings: [],
            coreClinicalConcept: 'Inhibiteurs du SGLT2',
            englishCoreTerms: ['Sodium-Glucose Transporter 2 Inhibitors', 'empagliflozin', 'canagliflozin']
          },
          o: {
            axisRole: 'clinical_condition',
            impliedSubheadings: [],
            coreClinicalConcept: 'Insuffisance rénale terminale',
            englishCoreTerms: ['Kidney Failure, Chronic']
          }
        }
      );

      expect(refined).not.toBeNull();
      expect(refined?.refinedPico.i.toLowerCase()).toContain('empagliflozine');
      expect(refined?.qualifications?.i?.englishCoreTerms).toContain('empagliflozin');
      expect(refined?.qualifications?.i?.englishCoreTerms).toContain('dapagliflozin');
      expect(refined?.qualifications?.p?.englishCoreTerms).toContain('Renal Insufficiency, Chronic');
    });
  });

  describe('6. Relais Cloudflare Pages HeTOP (functions/api/hetop/[[path]].ts)', () => {
    it('doit relayer GET vers https://www.hetop.eu/CISMeFhetopservice/REST/... avec query params, Authorization et CORS', async () => {
      let capturedUrl = '';
      let capturedAuth = '';
      let capturedAccept = '';

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        capturedUrl = String(input);
        const hdrs = new Headers(init?.headers);
        capturedAuth = hdrs.get('Authorization') || '';
        capturedAccept = hdrs.get('Accept') || '';
        return new Response(JSON.stringify({ totalResults: 3, concepts: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const req = new Request('https://meshcraft.pages.dev/api/hetop/searchConcepts/asthme/fr/*?max=10', {
        method: 'GET',
        headers: {
          Authorization: 'Basic dXNlcjpwYXNz',
          Accept: 'application/json'
        }
      });

      const res = await hetopPagesProxyOnRequest({
        request: req,
        params: { path: ['searchConcepts', 'asthme', 'fr', '*'] }
      });

      expect(capturedUrl).toBe('https://www.hetop.eu/CISMeFhetopservice/REST/searchConcepts/asthme/fr/*?max=10');
      expect(capturedAuth).toBe('Basic dXNlcjpwYXNz');
      expect(capturedAccept).toBe('application/json');
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
      const json = (await res.json()) as { totalResults?: number };
      expect(json.totalResults).toBe(3);

      // Préflight OPTIONS
      const optRes = await hetopPagesProxyOnRequest({
        request: new Request('https://meshcraft.pages.dev/api/hetop/searchConcepts/asthme/fr/*', {
          method: 'OPTIONS'
        }),
        params: { path: ['searchConcepts', 'asthme', 'fr', '*'] }
      });
      expect(optRes.status).toBe(204);
      expect(optRes.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(optRes.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });
  });
});
