import { PubMedArticle, PubMedResponse, StratifiedTitleSample } from './rustEngineService';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const NCBI_API_KEY_STORAGE = 'meshcraft_ncbi_api_key';

export function getNcbiApiKey(): string | null {
  try {
    const key = localStorage.getItem(NCBI_API_KEY_STORAGE);
    return key && key.trim().length > 0 ? key.trim() : null;
  } catch {
    return null;
  }
}

export function setNcbiApiKey(key: string): void {
  try {
    if (key && key.trim()) {
      localStorage.setItem(NCBI_API_KEY_STORAGE, key.trim());
    } else {
      localStorage.removeItem(NCBI_API_KEY_STORAGE);
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
}

export function hasNcbiApiKey(): boolean {
  return getNcbiApiKey() !== null;
}

let sharedLastNcbiCallTimestamp = 0;

/**
 * Construit une URL NCBI E-Utilities normalisée avec tool, email et clé API optionnelle
 */
export function buildNcbiUrl(base: string, params: Record<string, string>): string {
  const apiKey = getNcbiApiKey();
  const query = new URLSearchParams({
    ...params,
    retmode: 'json',
    tool: 'MeshCraftStudio',
    email: 'contact@meshcraft-studio.org'
  });
  if (apiKey) {
    query.set('api_key', apiKey);
  }
  return `${base}?${query.toString()}`;
}

/**
 * Paced fetch partagé entre pubmedApi et meshDatabase respectant les quotas NCBI Entrez :
 * - 3 requêtes/seconde max sans clé API (intervalle 340ms)
 * - 10 requêtes/seconde max avec clé API (intervalle 110ms)
 */
export async function pacedNcbiFetch(url: string, timeoutMs = 7000, maxRetries = 2): Promise<Response> {
  const apiKey = getNcbiApiKey();
  const minInterval = apiKey ? 110 : 340;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const now = Date.now();
    const elapsed = now - sharedLastNcbiCallTimestamp;
    if (elapsed < minInterval) {
      await delay(minInterval - elapsed);
    }
    sharedLastNcbiCallTimestamp = Date.now();

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status === 503) {
        if (attempt < maxRetries) {
          await delay(1200 * Math.pow(2, attempt));
          continue;
        }
      }
      return res;
    } catch (err) {
      if (attempt < maxRetries) {
        await delay(800);
        continue;
      }
      throw err;
    }
  }
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

function appendNcbiParams(endpoint: string): string {
  const apiKey = getNcbiApiKey();
  const sep = endpoint.includes('?') ? '&' : '?';
  let enriched = `${endpoint}${sep}tool=MeshCraftStudio&email=contact@meshcraft-studio.org`;
  if (apiKey) {
    enriched += `&api_key=${encodeURIComponent(apiKey)}`;
  }
  return enriched;
}

function combineFetchSignals(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!externalSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, externalSignal]);
  }
  return externalSignal;
}

async function fetchNcbi(
  endpoint: string,
  maxRetries = 3,
  timeoutMs = 8000,
  externalSignal?: AbortSignal,
  postParams?: Readonly<Record<string, string>>
): Promise<Response> {
  const isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  const useDevProxy = isBrowser && Boolean(import.meta.env?.DEV);
  const apiKey = getNcbiApiKey();
  const minInterval = apiKey ? 110 : 340;
  const isPost = Boolean(postParams);

  const requestPath = isPost ? endpoint : appendNcbiParams(endpoint);
  const proxyUrl = `/ncbi-api/${requestPath}`;
  const directUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${requestPath}`;

  let encodedPostBody: string | undefined;
  if (postParams) {
    const bodyParams = new URLSearchParams();
    for (const [k, v] of Object.entries(postParams)) {
      bodyParams.set(k, v);
    }
    bodyParams.set('tool', 'MeshCraftStudio');
    bodyParams.set('email', 'contact@meshcraft-studio.org');
    if (apiKey) {
      bodyParams.set('api_key', apiKey);
    }
    encodedPostBody = bodyParams.toString();
  }

  const buildFetchInit = (): RequestInit => {
    const signal = combineFetchSignals(timeoutMs, externalSignal);
    if (isPost && encodedPostBody !== undefined) {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: encodedPostBody,
        signal
      };
    }
    return { signal };
  };

  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (externalSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const now = Date.now();
    const elapsed = now - sharedLastNcbiCallTimestamp;
    if (elapsed < minInterval) {
      await delay(minInterval - elapsed);
    }
    sharedLastNcbiCallTimestamp = Date.now();

    let shouldRetry = false;

    // 1. Essai prioritaire via proxy local Vite uniquement en développement (évite un 404 en production statique)
    if (useDevProxy) {
      try {
        const res = await fetch(proxyUrl, buildFetchInit());
        if (res.ok) {
          return res;
        }
        lastResponse = res;
        if (res.status === 429 || res.status === 503 || res.status >= 500) {
          shouldRetry = true;
        }
      } catch (err: unknown) {
        if (externalSignal?.aborted || (err instanceof DOMException && err.name === 'AbortError' && externalSignal?.aborted)) {
          throw err;
        }
        shouldRetry = true;
      }
    }

    // 2. Fallback direct vers NCBI
    try {
      const res = await fetch(directUrl, buildFetchInit());
      if (res.ok) {
        return res;
      }
      lastResponse = res;
      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        shouldRetry = true;
      } else {
        // Erreur HTTP client non transitoire (ex: 400, 404, 414) : inutile de réessayer
        return res;
      }
    } catch (err: unknown) {
      if (externalSignal?.aborted || (err instanceof DOMException && err.name === 'AbortError' && externalSignal?.aborted)) {
        throw err;
      }
      shouldRetry = true;
    }

    if (shouldRetry && attempt < maxRetries) {
      await delay(1800 * Math.pow(2, attempt));
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  // Remonte un statut 503 explicite au lieu de maquiller l'échec en 200 OK vide
  return new Response(
    JSON.stringify({ error: 'NCBI E-Utilities unreachable after retries' }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
}

export interface StratifiedPmidSelection {
  readonly selectedIds: readonly string[];
  readonly topIds: readonly string[];
  readonly middleIds: readonly string[];
  readonly tailIds: readonly string[];
}

/**
 * Prélève jusqu'à 30 PMIDs en 3 strates explicites (10 Tête / 10 Milieu / 10 Queue)
 * sur le classement PubMed Best Match, ou la totalité si le corpus comporte ≤ 30 notices.
 */
export function selectStratifiedPmids(
  idList: readonly string[],
  perStratum = 10
): StratifiedPmidSelection {
  if (!idList || idList.length === 0) {
    return { selectedIds: [], topIds: [], middleIds: [], tailIds: [] };
  }

  const maxTotal = perStratum * 3;
  if (idList.length <= maxTotal) {
    const topIds = idList.slice(0, Math.min(perStratum, idList.length));
    const middleIds =
      idList.length > perStratum ? idList.slice(perStratum, Math.min(perStratum * 2, idList.length)) : [];
    const tailIds = idList.length > perStratum * 2 ? idList.slice(perStratum * 2) : [];
    return {
      selectedIds: [...idList],
      topIds,
      middleIds,
      tailIds
    };
  }

  const topIds = idList.slice(0, perStratum);
  const midStart = Math.max(perStratum, Math.floor((idList.length - perStratum) / 2));
  const middleIds = idList.slice(midStart, midStart + perStratum);
  const tailIds = idList.slice(idList.length - perStratum);

  const seen = new Set<string>();
  const selectedIds: string[] = [];
  for (const id of [...topIds, ...middleIds, ...tailIds]) {
    if (!seen.has(id)) {
      seen.add(id);
      selectedIds.push(id);
    }
  }

  return { selectedIds, topIds, middleIds, tailIds };
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripInlineXmlTags(xmlFragment: string): string {
  return decodeXmlEntities(xmlFragment.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstTagText(xml: string, tagName: string): string {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = re.exec(xml);
  return match ? stripInlineXmlTags(match[1]) : '';
}

function extractAttrValue(attrs: string, attrName: string): string {
  const re = new RegExp(`${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = re.exec(attrs);
  return match ? decodeXmlEntities((match[1] ?? match[2] ?? '').trim()) : '';
}

function parseAuthorsFromXml(xmlFragment: string): string {
  const authorListMatch =
    /<AuthorList\s+[^>]*Type\s*=\s*(?:"authors"|'authors')[^>]*>([\s\S]*?)<\/AuthorList>/i.exec(xmlFragment) ||
    /<AuthorList(?:\s[^>]*)?>([\s\S]*?)<\/AuthorList>/i.exec(xmlFragment);
  const parsedAuthors: string[] = [];
  if (authorListMatch) {
    const authorRe = /<Author(?:\s[^>]*)?>([\s\S]*?)<\/Author>/gi;
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = authorRe.exec(authorListMatch[1])) !== null) {
      const aXml = authorMatch[1];
      const collective = extractFirstTagText(aXml, 'CollectiveName');
      if (collective) {
        parsedAuthors.push(collective);
        continue;
      }
      const lastName = extractFirstTagText(aXml, 'LastName');
      const initials = extractFirstTagText(aXml, 'Initials') || extractFirstTagText(aXml, 'ForeName');
      if (lastName) {
        parsedAuthors.push(initials ? `${lastName} ${initials}` : lastName);
      }
    }
  }
  return parsedAuthors.length > 0
    ? parsedAuthors.slice(0, 3).join(', ') + (parsedAuthors.length > 3 ? ' et al.' : '')
    : 'Auteurs PubMed';
}

function parseAbstractFromXml(xmlFragment: string): string {
  const abstractMatch = /<Abstract(?:\s[^>]*)?>([\s\S]*?)<\/Abstract>/i.exec(xmlFragment);
  const abstractSections: string[] = [];
  if (abstractMatch) {
    const absPartRe = /<AbstractText(\s[^>]*)?>([\s\S]*?)<\/AbstractText>/gi;
    let absMatch: RegExpExecArray | null;
    while ((absMatch = absPartRe.exec(abstractMatch[1])) !== null) {
      const attrs = absMatch[1] || '';
      const label = extractAttrValue(attrs, 'Label');
      const text = stripInlineXmlTags(absMatch[2]);
      if (!text) continue;
      if (label && label.toUpperCase() !== 'UNLABELLED') {
        abstractSections.push(`${label}: ${text}`);
      } else {
        abstractSections.push(text);
      }
    }
  }
  return abstractSections.join('\n\n');
}

function parseDoiFromXml(fullBlock: string, articleXml: string): string | null {
  const articleIdRe = /<ArticleId\s+([^>]*)>([\s\S]*?)<\/ArticleId>/gi;
  let aidMatch: RegExpExecArray | null;
  while ((aidMatch = articleIdRe.exec(fullBlock)) !== null) {
    if (extractAttrValue(aidMatch[1], 'IdType').toLowerCase() === 'doi') {
      const cleanDoi = stripInlineXmlTags(aidMatch[2]);
      if (cleanDoi) return cleanDoi;
    }
  }
  const eLocRe = /<ELocationID\s+([^>]*)>([\s\S]*?)<\/ELocationID>/gi;
  let eLocMatch: RegExpExecArray | null;
  while ((eLocMatch = eLocRe.exec(articleXml)) !== null) {
    if (extractAttrValue(eLocMatch[1], 'EIdType').toLowerCase() === 'doi') {
      const cleanDoi = stripInlineXmlTags(eLocMatch[2]);
      if (cleanDoi) return cleanDoi;
    }
  }
  return null;
}

function parsePublicationTypesFromXml(xmlFragment: string): string[] {
  const types: string[] = [];
  const pubTypeListMatch = /<PublicationTypeList(?:\s[^>]*)?>([\s\S]*?)<\/PublicationTypeList>/i.exec(xmlFragment);
  const targetXml = pubTypeListMatch ? pubTypeListMatch[1] : xmlFragment;
  const pubTypeRe = /<PublicationType(?:\s[^>]*)?>([\s\S]*?)<\/PublicationType>/gi;
  let match: RegExpExecArray | null;
  while ((match = pubTypeRe.exec(targetXml)) !== null) {
    const label = stripInlineXmlTags(match[1]);
    if (label && !types.includes(label)) {
      types.push(label);
    }
  }
  return types;
}

function parsePubDateFromXml(xmlFragment: string): string {
  const pubDateMatch =
    /<PubDate(?:\s[^>]*)?>([\s\S]*?)<\/PubDate>/i.exec(xmlFragment) ||
    /<ContributionDate(?:\s[^>]*)?>([\s\S]*?)<\/ContributionDate>/i.exec(xmlFragment);
  if (!pubDateMatch) return 'Date récente';
  const year = extractFirstTagText(pubDateMatch[1], 'Year');
  const month = extractFirstTagText(pubDateMatch[1], 'Month');
  const medlineDate = extractFirstTagText(pubDateMatch[1], 'MedlineDate');
  if (year) return month ? `${year} ${month}` : year;
  if (medlineDate) return medlineDate;
  return 'Date récente';
}

/**
 * Parse directement une réponse `efetch.fcgi?db=pubmed&retmode=xml` en notices complètes `PubMedArticle`
 * (articles classiques `<PubmedArticle>` ET chapitres NCBI Bookshelf `<PubmedBookArticle>`),
 * avec extraction des `<PublicationType>`, DOI et résumés structurés sans balises HTML brutes.
 * Compatible navigateur et Node/Vitest (aucune dépendance à DOMParser).
 */
export function parsePubMedEfetchXml(xmlText: string): PubMedArticle[] {
  if (!xmlText || (!xmlText.includes('<PubmedArticle') && !xmlText.includes('<PubmedBookArticle'))) {
    return [];
  }

  const articles: PubMedArticle[] = [];
  const recordRe = /<(PubmedArticle|PubmedBookArticle)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let recordMatch: RegExpExecArray | null;

  while ((recordMatch = recordRe.exec(xmlText)) !== null) {
    const recordTag = recordMatch[1].toLowerCase();
    const block = recordMatch[2];

    if (recordTag === 'pubmedbookarticle') {
      const bookDocMatch = /<BookDocument(?:\s[^>]*)?>([\s\S]*?)<\/BookDocument>/i.exec(block);
      const bookDocXml = bookDocMatch ? bookDocMatch[1] : block;
      const pmid = extractFirstTagText(bookDocXml, 'PMID');
      if (!pmid) continue;

      const title =
        extractFirstTagText(bookDocXml, 'ArticleTitle') ||
        extractFirstTagText(bookDocXml, 'BookTitle') ||
        `Article PMID: ${pmid}`;
      const authors = parseAuthorsFromXml(bookDocXml);
      const source =
        extractFirstTagText(bookDocXml, 'BookTitle') ||
        extractFirstTagText(bookDocXml, 'PublisherName') ||
        'NCBI Bookshelf';
      const pubDate = parsePubDateFromXml(bookDocXml);
      const doi = parseDoiFromXml(block, bookDocXml);
      const abstractText = parseAbstractFromXml(bookDocXml);
      const publicationTypes = parsePublicationTypesFromXml(bookDocXml);

      const meshHeadings: string[] = [];
      const meshRe = /<MeshHeading(?:\s[^>]*)?>([\s\S]*?)<\/MeshHeading>/gi;
      let meshMatch: RegExpExecArray | null;
      while ((meshMatch = meshRe.exec(bookDocXml)) !== null) {
        const desc = extractFirstTagText(meshMatch[1], 'DescriptorName');
        if (desc && !meshHeadings.includes(desc)) {
          meshHeadings.push(desc);
        }
      }

      articles.push({
        pmid,
        title,
        authors,
        source,
        pubDate,
        doi,
        abstract: abstractText,
        meshHeadings,
        publicationTypes,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      });
      continue;
    }

    const citationMatch = /<MedlineCitation(?:\s[^>]*)?>([\s\S]*?)<\/MedlineCitation>/i.exec(block);
    const citationXml = citationMatch ? citationMatch[1] : block;
    const pmid = extractFirstTagText(citationXml, 'PMID');
    if (!pmid) continue;

    const articleNodeMatch = /<Article(?:\s[^>]*)?>([\s\S]*?)<\/Article>/i.exec(citationXml);
    const articleXml = articleNodeMatch ? articleNodeMatch[1] : citationXml;

    const title = extractFirstTagText(articleXml, 'ArticleTitle') || `Article PMID: ${pmid}`;
    const authors = parseAuthorsFromXml(articleXml);

    // Revue & Date de publication (<Year> + <Month> ou repli <MedlineDate>)
    const journalMatch = /<Journal(?:\s[^>]*)?>([\s\S]*?)<\/Journal>/i.exec(articleXml);
    const journalXml = journalMatch ? journalMatch[1] : '';
    const source =
      extractFirstTagText(journalXml, 'ISOAbbreviation') ||
      extractFirstTagText(citationXml, 'MedlineTA') ||
      extractFirstTagText(journalXml, 'Title') ||
      'Journal Médical';

    const pubDate = parsePubDateFromXml(journalXml || articleXml);
    const doi = parseDoiFromXml(block, articleXml);
    const abstractText = parseAbstractFromXml(articleXml);
    const publicationTypes = parsePublicationTypesFromXml(articleXml);

    // Descripteurs MeSH indexés
    const meshHeadings: string[] = [];
    const meshRe = /<MeshHeading(?:\s[^>]*)?>([\s\S]*?)<\/MeshHeading>/gi;
    let meshMatch: RegExpExecArray | null;
    while ((meshMatch = meshRe.exec(citationXml)) !== null) {
      const desc = extractFirstTagText(meshMatch[1], 'DescriptorName');
      if (desc && !meshHeadings.includes(desc)) {
        meshHeadings.push(desc);
      }
    }

    articles.push({
      pmid,
      title,
      authors,
      source,
      pubDate,
      doi,
      abstract: abstractText,
      meshHeadings,
      publicationTypes,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
    });
  }

  return articles;
}

interface ESearchResponseJson {
  readonly esearchresult?: {
    readonly count?: string;
    readonly querytranslation?: string;
    readonly idlist?: readonly string[];
    readonly ERROR?: string;
  };
}

interface ESummaryAuthor {
  readonly name?: string;
}

interface ESummaryArticleId {
  readonly idtype?: string;
  readonly value?: string;
}

interface ESummaryRecord {
  readonly title?: string;
  readonly authors?: readonly ESummaryAuthor[];
  readonly source?: string;
  readonly fulljournalname?: string;
  readonly pubdate?: string;
  readonly articleids?: readonly ESummaryArticleId[];
}

interface ESummaryResponseJson {
  readonly result?: Record<string, ESummaryRecord | readonly string[]>;
}

/**
 * Récupère les titres et métadonnées légères d'un échantillon de PMIDs en 1 seul appel `esummary`
 * (zéro `efetch` XML — utilisé aux Étapes 1 et 2 pour un audit rapide et non biaisé).
 */
async function fetchSummarySampleForIds(
  idList: readonly string[],
  signal?: AbortSignal
): Promise<PubMedArticle[]> {
  if (!idList || idList.length === 0) return [];

  const summaryEndpoint = `esummary.fcgi?db=pubmed&id=${idList.join(',')}&retmode=json`;
  const sumRes = await fetchNcbi(summaryEndpoint, 3, 10000, signal);
  let summaryDict: Record<string, ESummaryRecord | readonly string[]> = {};
  if (sumRes.ok) {
    try {
      const sumData = (await sumRes.json()) as ESummaryResponseJson;
      summaryDict = sumData.result || {};
    } catch {
      summaryDict = {};
    }
  }

  return idList.map((pmid) => {
    const rawItem = summaryDict[pmid];
    const item = rawItem && !Array.isArray(rawItem) ? (rawItem as ESummaryRecord) : undefined;
    const authorsList = item?.authors || [];
    const authors = authorsList
      .slice(0, 3)
      .map((a) => a.name || '')
      .filter(Boolean)
      .join(', ');
    const moreAuthors = authorsList.length > 3 ? ' et al.' : '';
    const doi = item?.articleids?.find((id) => id.idtype === 'doi')?.value || null;

    return {
      pmid,
      title: item?.title ? stripInlineXmlTags(item.title) : `Article PMID: ${pmid}`,
      authors: authors ? authors + moreAuthors : 'Auteurs PubMed',
      source: item?.source || item?.fulljournalname || 'Journal Médical',
      pubDate: item?.pubdate || 'Date récente',
      doi,
      abstract: '',
      meshHeadings: [],
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
    };
  });
}

export async function queryPubMedLive(
  query: string,
  options: { maxResults?: number; sort?: 'relevance' | 'pub_date' | string } = {}
): Promise<PubMedResponse> {
  if (!query || query.trim() === '') {
    return { count: 0, queryTranslation: '', articles: [], idList: [], error: null };
  }

  const retmax = options.maxResults ?? 2500;
  const sort = options.sort === 'pub_date' ? 'pub_date' : 'relevance';

  try {
    // Envoi systématique en POST (application/x-www-form-urlencoded) pour éviter tout HTTP 414 URI Too Long
    const res = await fetchNcbi('esearch.fcgi', 3, 10000, undefined, {
      db: 'pubmed',
      term: query,
      retmode: 'json',
      retmax: String(retmax),
      sort
    });

    if (!res.ok) {
      return {
        count: 0,
        queryTranslation: query,
        articles: [],
        idList: [],
        error: `Erreur lors de l'interrogation PubMed (HTTP ${res.status}). Réessayez ou vérifiez la longueur/syntaxe de l'équation.`
      };
    }

    let searchData: ESearchResponseJson | null = null;
    try {
      searchData = (await res.json()) as ESearchResponseJson;
    } catch {
      searchData = null;
    }

    const result = searchData?.esearchresult;
    if (!result || typeof result.count === 'undefined') {
      const apiErr = result?.ERROR;
      return {
        count: 0,
        queryTranslation: query,
        articles: [],
        idList: [],
        error: apiErr
          ? `Erreur PubMed E-Utilities : ${apiErr}`
          : "Réponse PubMed incomplète ou invalide lors de l'interrogation esearch."
      };
    }

    if (result.ERROR) {
      return {
        count: 0,
        queryTranslation: result.querytranslation || query,
        articles: [],
        idList: [],
        error: `Erreur PubMed E-Utilities : ${result.ERROR}`
      };
    }

    const count = parseInt(result.count, 10);
    if (!Number.isFinite(count)) {
      return {
        count: 0,
        queryTranslation: result.querytranslation || query,
        articles: [],
        idList: [],
        error: "Effectif PubMed illisible dans la réponse esearch."
      };
    }

    const queryTranslation = result.querytranslation || query;
    const idList: readonly string[] = result.idlist || [];

    if (idList.length === 0) {
      return {
        count,
        queryTranslation,
        articles: [],
        idList: [],
        stratifiedSample: { top: [], middle: [], tail: [] },
        error: null
      };
    }

    // Échantillonnage stratifié 10 Tête / 10 Milieu / 10 Queue (30 max) en 1 seul appel esummary (zéro efetch XML)
    const selection = selectStratifiedPmids(idList, 10);
    const sampledArticles = await fetchSummarySampleForIds(selection.selectedIds);
    const titleByPmid = new Map<string, string>(
      sampledArticles.map((a) => [a.pmid, a.title])
    );

    const stratifiedSample: StratifiedTitleSample = {
      top: selection.topIds.map((id) => titleByPmid.get(id) || '').filter(Boolean),
      middle: selection.middleIds.map((id) => titleByPmid.get(id) || '').filter(Boolean),
      tail: selection.tailIds.map((id) => titleByPmid.get(id) || '').filter(Boolean)
    };

    return {
      count,
      queryTranslation,
      articles: sampledArticles,
      idList,
      stratifiedSample,
      error: null
    };
  } catch (err) {
    console.error('PubMed Advanced Fetch Error:', err);
    return {
      count: 0,
      queryTranslation: query,
      articles: [],
      idList: [],
      error: 'Erreur de connexion à PubMed API.'
    };
  }
}

/**
 * Récupère les métadonnées complètes, DOI et résumés XML via `efetch`-only par lots de 100 PMIDs
 * (timeout 15 000 ms, zéro appel `esummary` redondant).
 */
export async function fetchArticlesDetailsForIds(
  idList: readonly string[],
  options: {
    readonly chunkSize?: number;
    readonly onProgress?: (current: number, total: number) => void;
    readonly signal?: AbortSignal;
  } = {}
): Promise<PubMedArticle[]> {
  if (!idList || idList.length === 0) return [];

  const results: PubMedArticle[] = [];
  const chunkSize = options.chunkSize ?? 100;
  const total = idList.length;

  for (let i = 0; i < total; i += chunkSize) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const chunk = idList.slice(i, i + chunkSize);
    const fetchEndpoint = `efetch.fcgi?db=pubmed&id=${chunk.join(',')}&retmode=xml`;
    const fetchRes = await fetchNcbi(fetchEndpoint, 3, 15000, options.signal);

    if (!fetchRes.ok) {
      throw new Error(`Erreur PubMed efetch (HTTP ${fetchRes.status}).`);
    }

    const xmlText = await fetchRes.text();
    if (xmlText && (xmlText.includes('<PubmedArticle') || xmlText.includes('<PubmedBookArticle'))) {
      const parsed = parsePubMedEfetchXml(xmlText);
      results.push(...parsed);
    }

    options.onProgress?.(Math.min(results.length, total), total);
  }

  return results;
}

/**
 * Récupère le corpus complet à la demande pour l'Étape 3 (jusqu'à 2 500 notices exhaustives,
 * ou aperçu plafonné à 1 000 notices si le corpus dépasse 2 500).
 * Réutilise directement `knownIdList` issu de l'Étape 2 pour éviter un `esearch` redondant.
 */
export async function fetchExtendedPubMedArticles(
  query: string,
  targetCount: number,
  existingArticles: readonly PubMedArticle[] = [],
  onProgress?: (current: number, total: number) => void,
  knownIdList?: readonly string[],
  signal?: AbortSignal
): Promise<PubMedArticle[]> {
  if (!query) return [...existingArticles];

  const maxToFetch = Math.min(2500, Math.max(0, targetCount));
  if (maxToFetch === 0) return [...existingArticles];

  let allIds: readonly string[] =
    knownIdList && knownIdList.length > 0 ? knownIdList.slice(0, maxToFetch) : [];

  if (allIds.length === 0) {
    const res = await fetchNcbi('esearch.fcgi', 3, 10000, signal, {
      db: 'pubmed',
      term: query,
      retmode: 'json',
      retmax: String(maxToFetch),
      sort: 'relevance'
    });
    if (!res.ok) {
      throw new Error(`PubMed esearch HTTP ${res.status}`);
    }
    const searchData = (await res.json().catch(() => ({}))) as ESearchResponseJson;
    allIds = (searchData?.esearchresult?.idlist || []).slice(0, maxToFetch);
  }

  if (allIds.length === 0) return [...existingArticles];

  // Ne réutiliser que les articles déjà chargés avec leurs métadonnées complètes (efetch)
  const completeExistingMap = new Map<string, PubMedArticle>();
  for (const art of existingArticles) {
    if (art.abstract && art.abstract.trim().length > 0) {
      completeExistingMap.set(art.pmid, art);
    }
  }

  const missingIds = allIds.filter((id) => !completeExistingMap.has(id));
  if (missingIds.length === 0) {
    return allIds
      .map((id) => completeExistingMap.get(id))
      .filter((a): a is PubMedArticle => Boolean(a));
  }

  const fetchedMap = new Map<string, PubMedArticle>(completeExistingMap);
  const alreadyCount = completeExistingMap.size;
  onProgress?.(alreadyCount, allIds.length);

  const fetchedArticles = await fetchArticlesDetailsForIds(missingIds, {
    chunkSize: 100,
    signal,
    onProgress: (loadedMissing) => {
      onProgress?.(Math.min(alreadyCount + loadedMissing, allIds.length), allIds.length);
    }
  });

  for (const art of fetchedArticles) {
    fetchedMap.set(art.pmid, art);
  }

  const ordered: PubMedArticle[] = [];
  for (const id of allIds) {
    const found = fetchedMap.get(id);
    if (found) ordered.push(found);
  }

  return ordered;
}
