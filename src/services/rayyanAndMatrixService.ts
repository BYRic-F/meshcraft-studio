/**
 * Service d'Interopérabilité Rayyan (rayyan.ai), Contrôle des PMID Repères (PRESS / PRISMA-S)
 * et Générateur de Matrice de Lecture Académique (Synthèse Critique des Études Incluses).
 *
 * Conforme à la Constitution gemini.md : Typage strict (Zéro any), logique pure et déterministe.
 */

import { ScreenedArticle } from './agentScreener';
import { Rob2ArticleEvaluation, inferStudyDesignFromText, StudyDesignType } from './localAiService';

export interface RayyanImportedDecision {
  readonly key: string; // PMID ou titre normalisé
  readonly status: 'included' | 'maybe' | 'excluded';
  readonly exclusionReason?: string;
  readonly evaluatedBy: 'rayyan';
}

export interface BenchmarkCoverageResult {
  readonly totalBenchmark: number;
  readonly foundPmids: readonly string[];
  readonly missingPmids: readonly string[];
  readonly coveragePercent: number;
}

export interface ReadingMatrixRow {
  readonly pmid: string;
  readonly url: string;
  readonly firstAuthorYear: string;
  readonly journal: string;
  readonly title: string;
  readonly screeningStatus: 'included' | 'maybe';
  readonly studyDesign: StudyDesignType;
  readonly studyDesignLabel: string;
  readonly abstractSummary: string;
  readonly riskOfBiasOverall: 'low' | 'moderate' | 'high' | 'unassessed' | 'na';
  readonly limitationsAndNotes: string;
}

export interface BuildReadingMatrixOptions {
  readonly includeMaybe?: boolean;
}

function escapeCsvCell(value: string): string {
  const clean = (value || '').replace(/\r?\n/g, ' ').trim();
  if (clean.includes('"') || clean.includes(',') || clean.includes(';')) {
    return `"${clean.replace(/"/g, '""')}"`;
  }
  return `"${clean}"`;
}

function extractYearFromPubDate(pubDate: string): string {
  const match = (pubDate || '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : pubDate || 'N/A';
}

function formatRayyanAiNote(art: ScreenedArticle, includeAiNotes: boolean): string {
  if (!includeAiNotes || art.status === 'pending') return '';
  const statusTag = art.status === 'included'
    ? 'AI-PreScreen: INCLUDE'
    : art.status === 'maybe'
      ? 'AI-PreScreen: MAYBE (Full-text check)'
      : 'AI-PreScreen: EXCLUDE';
  const reasonPart = art.exclusionReason ? ` | Reason: ${art.exclusionReason}` : '';
  const snippetPart = art.evidenceSnippet ? ` | Note: ${art.evidenceSnippet}` : '';
  return `${statusTag}${reasonPart}${snippetPart}`;
}

/**
 * Génère un fichier au format standard RIS (.ris) compatible avec Rayyan, Zotero, EndNote et Covidence.
 */
export function exportToRayyanRis(articles: readonly ScreenedArticle[], includeAiNotes = true): string {
  const records: string[] = [];

  for (const art of articles) {
    const lines: string[] = [];
    lines.push('TY  - JOUR');
    lines.push(`AN  - ${art.pmid}`);
    lines.push(`ID  - ${art.pmid}`);
    if (art.title) lines.push(`TI  - ${art.title}`);

    const authorsList = (art.authors || '')
      .split(',')
      .map(a => a.replace(/\bet al\.?/i, '').trim())
      .filter(Boolean);
    if (authorsList.length > 0) {
      for (const au of authorsList) {
        lines.push(`AU  - ${au}`);
      }
    } else {
      lines.push('AU  - Anonymous');
    }

    if (art.source) lines.push(`JO  - ${art.source}`);
    const year = extractYearFromPubDate(art.pubDate);
    if (year) lines.push(`PY  - ${year}`);
    if (art.doi) lines.push(`DO  - ${art.doi}`);
    if (art.abstract) lines.push(`AB  - ${art.abstract.replace(/\r?\n/g, ' ')}`);
    if (art.url) lines.push(`UR  - ${art.url}`);

    for (const mh of art.meshHeadings || []) {
      lines.push(`KW  - ${mh}`);
    }

    const aiNote = formatRayyanAiNote(art, includeAiNotes);
    if (aiNote) {
      lines.push(`N1  - ${aiNote}`);
    }

    lines.push('ER  - ');
    records.push(lines.join('\r\n'));
  }

  return records.join('\r\n\r\n') + '\r\n';
}

/**
 * Génère un fichier CSV standard (.csv) directement importable dans Rayyan (colonnes officielles Rayyan : key, title, authors, journal, year, pmid, doi, url, abstract, notes).
 */
export function exportToRayyanCsv(articles: readonly ScreenedArticle[], includeAiNotes = true): string {
  const header = ['key', 'title', 'authors', 'journal', 'year', 'pmid', 'doi', 'url', 'abstract', 'notes'].join(',');
  const rows: string[] = [header];

  for (const art of articles) {
    const year = extractYearFromPubDate(art.pubDate);
    const notes = formatRayyanAiNote(art, includeAiNotes);
    const row = [
      escapeCsvCell(art.pmid),
      escapeCsvCell(art.title),
      escapeCsvCell(art.authors),
      escapeCsvCell(art.source),
      escapeCsvCell(year),
      escapeCsvCell(art.pmid),
      escapeCsvCell(art.doi || ''),
      escapeCsvCell(art.url),
      escapeCsvCell(art.abstract),
      escapeCsvCell(notes)
    ].join(',');
    rows.push(row);
  }

  return rows.join('\r\n');
}

/**
 * Analyse une chaîne de notes Rayyan (ex: `RAYYAN-INCLUSION: {"DrA"=>"Included", "DrB"=>"Included"} | RAYYAN-EXCLUSION-REASONS: Wrong population`)
 * et détermine le statut consensuel selon les règles de double lecture humaine.
 */
function parseRayyanNoteField(noteText: string): { status: 'included' | 'maybe' | 'excluded'; exclusionReason?: string } | null {
  if (!noteText) return null;

  const inclusionMatch = noteText.match(/RAYYAN-INCLUSION:\s*\{([^}]+)\}/i);
  const reasonMatch = noteText.match(/RAYYAN-EXCLUSION-REASONS:\s*([^|;\r\n]+)/i);
  const extractedReason = reasonMatch ? reasonMatch[1].trim() : undefined;

  if (inclusionMatch) {
    const votesBlock = inclusionMatch[1];
    const hasIncluded = /\bIncluded\b/i.test(votesBlock);
    const hasExcluded = /\bExcluded\b/i.test(votesBlock);
    const hasMaybe = /\bMaybe\b/i.test(votesBlock);

    // En cas de désaccord entre les 2 lecteurs (Included + Excluded) ou de vote Maybe -> 'maybe' (À vérifier / Arbitrage)
    if ((hasIncluded && hasExcluded) || hasMaybe) {
      return { status: 'maybe', exclusionReason: extractedReason };
    }
    if (hasIncluded) {
      return { status: 'included' };
    }
    if (hasExcluded) {
      return {
        status: 'excluded',
        exclusionReason: extractedReason || 'Exclu lors de la double lecture sur Rayyan'
      };
    }
  }

  // Fallback si l'export contient un label direct
  if (/\bIncluded\b/i.test(noteText) && !/\bExcluded\b/i.test(noteText)) {
    return { status: 'included' };
  }
  if (/\bExcluded\b/i.test(noteText) && !/\bIncluded\b/i.test(noteText)) {
    return { status: 'excluded', exclusionReason: extractedReason || 'Exclu sur Rayyan' };
  }
  if (/\bMaybe\b/i.test(noteText)) {
    return { status: 'maybe' };
  }

  return null;
}

/**
 * Importe un fichier d'export Rayyan (.ris ou .csv) et extrait les décisions humaines par PMID.
 */
export function parseRayyanImport(rawContent: string): Map<string, RayyanImportedDecision> {
  const decisions = new Map<string, RayyanImportedDecision>();
  if (!rawContent || !rawContent.trim()) return decisions;

  const trimmed = rawContent.trim();

  // Cas 1 : Format RIS (TY  - ... ER  -)
  if (/^TY\s+-/m.test(trimmed)) {
    const blocks = trimmed.split(/\bER\s+-[^\r\n]*/);
    for (const block of blocks) {
      const anMatch = block.match(/^(?:AN|ID)\s+-\s*(\d+)/m) || block.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
      const n1Matches = Array.from(block.matchAll(/^N1\s+-\s*(.+)$/gm)).map(m => m[1]).join(' | ');
      if (anMatch && n1Matches) {
        const pmid = anMatch[1].trim();
        const parsed = parseRayyanNoteField(n1Matches);
        if (parsed) {
          decisions.set(pmid, {
            key: pmid,
            status: parsed.status,
            exclusionReason: parsed.exclusionReason,
            evaluatedBy: 'rayyan'
          });
        }
      }
    }
    return decisions;
  }

  // Cas 2 : Format CSV Rayyan
  const lines = trimmed.split(/\r?\n/).filter(l => l.trim().length > 0);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const pmidMatch = line.match(/\b(\d{7,9})\b/);
    const parsed = parseRayyanNoteField(line);
    if (pmidMatch && parsed) {
      const pmid = pmidMatch[1];
      decisions.set(pmid, {
        key: pmid,
        status: parsed.status,
        exclusionReason: parsed.exclusionReason,
        evaluatedBy: 'rayyan'
      });
    }
  }

  return decisions;
}

/**
 * Applique les décisions importées depuis Rayyan à la cohorte d'articles locale.
 */
export function applyRayyanDecisions(
  articles: readonly ScreenedArticle[],
  decisions: Map<string, RayyanImportedDecision>
): ScreenedArticle[] {
  return articles.map(art => {
    const dec = decisions.get(String(art.pmid));
    if (!dec) return art;
    return {
      ...art,
      status: dec.status,
      exclusionReason: dec.status === 'excluded' ? (dec.exclusionReason || art.exclusionReason || 'Exclu sur Rayyan') : undefined,
      evidenceSnippet: dec.status === 'included'
        ? 'Validé par double lecture humaine (Import Rayyan).'
        : dec.status === 'maybe'
          ? 'Conflit ou incertitude sur Rayyan : retenu pour vérification sur texte intégral.'
          : `Exclu sur Rayyan (${dec.exclusionReason || 'Critère non conforme'}).`,
      evaluatedBy: 'rayyan'
    };
  });
}

/**
 * Extrait proprement une liste d'identifiants PMID à partir d'une saisie libre (espaces, virgules, retours à la ligne).
 */
export function parseBenchmarkPmids(rawInput: string): string[] {
  if (!rawInput) return [];
  const matches = rawInput.match(/\b\d{5,10}\b/g);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

/**
 * Contrôle le taux de couverture d'une liste de PMID repères (Gold-Standard Benchmark — PRISMA-S / PRESS).
 */
export function evaluateBenchmarkCoverage(
  benchmarkPmids: readonly string[],
  retrievedPmids: readonly string[]
): BenchmarkCoverageResult {
  const retrievedSet = new Set(retrievedPmids.map(p => String(p).trim()));
  const uniqueBench = Array.from(new Set(benchmarkPmids.map(p => String(p).trim()).filter(Boolean)));

  const foundPmids: string[] = [];
  const missingPmids: string[] = [];

  for (const pmid of uniqueBench) {
    if (retrievedSet.has(pmid)) {
      foundPmids.push(pmid);
    } else {
      missingPmids.push(pmid);
    }
  }

  const coveragePercent = uniqueBench.length > 0
    ? Math.round((foundPmids.length / uniqueBench.length) * 100)
    : 0;

  return {
    totalBenchmark: uniqueBench.length,
    foundPmids,
    missingPmids,
    coveragePercent
  };
}

function getStudyDesignFrenchLabel(design: StudyDesignType): string {
  if (design === 'rct') return 'Essai contrôlé randomisé (ECR)';
  if (design === 'review') return 'Revue systématique / Méta-analyse';
  if (design === 'observational') return 'Étude observationnelle / Cohorte';
  return 'Revue narrative / Recommandation / Autre';
}

function formatRobFrenchLabel(level: ReadingMatrixRow['riskOfBiasOverall']): string {
  if (level === 'low') return 'Faible';
  if (level === 'moderate') return 'Modéré';
  if (level === 'high') return 'Élevé';
  if (level === 'na') return 'Hors grille (N/A)';
  return 'Non évalué';
}

function buildPerStudyAbstractSummary(art: ScreenedArticle): string {
  const snippet = (art.evidenceSnippet || '').trim();
  const isGenericNote =
    /^(Inclus manuellement par le lecteur|Retenu manuellement pour vérification|Validé par double lecture humaine)/i.test(snippet);
  if (snippet && !isGenericNote) {
    return snippet;
  }
  const cleanAbstract = (art.abstract || '').replace(/\s+/g, ' ').trim();
  if (cleanAbstract.length > 0) {
    return cleanAbstract.length > 220 ? `${cleanAbstract.slice(0, 220).trim()}…` : cleanAbstract;
  }
  return 'À compléter sur texte intégral.';
}

/**
 * Construit les lignes de la Matrice de Synthèse (Tableau des études retenues)
 * sans répétition du PICO global statique : chaque colonne porte une information propre à l'étude.
 */
export function buildReadingMatrixRows(
  articles: readonly ScreenedArticle[],
  robEvaluations: Record<string, Rob2ArticleEvaluation> = {},
  options: BuildReadingMatrixOptions = {}
): ReadingMatrixRow[] {
  const includeMaybe = options.includeMaybe === true;
  const eligible = articles.filter(a =>
    includeMaybe ? (a.status === 'included' || a.status === 'maybe') : a.status === 'included'
  );

  return eligible.map(art => {
    const rob = robEvaluations[art.pmid];
    const studyDesign: StudyDesignType =
      rob?.studyDesign || inferStudyDesignFromText(art.title, art.abstract, art.publicationTypes);
    const firstAuthor = (art.authors || 'Auteur inconnu').split(',')[0].trim();
    const year = extractYearFromPubDate(art.pubDate);
    const screeningStatus: 'included' | 'maybe' = art.status === 'maybe' ? 'maybe' : 'included';
    const abstractSummary = buildPerStudyAbstractSummary(art);
    const robLevel: ReadingMatrixRow['riskOfBiasOverall'] =
      studyDesign === 'other'
        ? 'na'
        : rob
          ? rob.overall
          : 'unassessed';
    const notes =
      rob?.justification ||
      (studyDesign === 'other'
        ? 'Format hors grille d\'évaluation des biais (revue narrative, recommandation ou autre)'
        : screeningStatus === 'maybe'
          ? 'À confirmer après lecture du texte intégral'
          : 'Étude incluse après tri titre/résumé');

    return {
      pmid: art.pmid,
      url: art.url || `https://pubmed.ncbi.nlm.nih.gov/${art.pmid}/`,
      firstAuthorYear: `${firstAuthor} (${year})`,
      journal: art.source || 'N/A',
      title: art.title,
      screeningStatus,
      studyDesign,
      studyDesignLabel: getStudyDesignFrenchLabel(studyDesign),
      abstractSummary,
      riskOfBiasOverall: robLevel,
      limitationsAndNotes: notes
    };
  });
}

/**
 * Exporte la Matrice de Synthèse au format CSV compatible Excel (avec BOM UTF-8).
 */
export function exportReadingMatrixCsv(rows: readonly ReadingMatrixRow[]): string {
  const headers = [
    'PMID',
    'Auteur (Année)',
    'Revue',
    'Titre',
    'Plan d\'étude',
    'Statut',
    'Synthèse titre/résumé',
    'Risque de biais',
    'Notes méthodologiques'
  ].map(escapeCsvCell).join(',');

  const lines = rows.map(r => [
    escapeCsvCell(r.pmid),
    escapeCsvCell(r.firstAuthorYear),
    escapeCsvCell(r.journal),
    escapeCsvCell(r.title),
    escapeCsvCell(r.studyDesignLabel),
    escapeCsvCell(r.screeningStatus === 'included' ? 'Incluse' : 'À vérifier'),
    escapeCsvCell(r.abstractSummary),
    escapeCsvCell(formatRobFrenchLabel(r.riskOfBiasOverall)),
    escapeCsvCell(r.limitationsAndNotes)
  ].join(','));

  return '\uFEFF' + [headers, ...lines].join('\r\n');
}

/**
 * Exporte la Matrice de Synthèse au format tableau Markdown pour intégration directe dans un chapitre Résultats de thèse.
 */
export function exportReadingMatrixMarkdown(rows: readonly ReadingMatrixRow[]): string {
  if (rows.length === 0) {
    return '_Aucune étude retenue dans la matrice de synthèse._';
  }
  const header = '| PMID | Auteur (Année) | Plan d\'étude & Statut | Synthèse titre/résumé | Risque de biais |\n| :--- | :--- | :--- | :--- | :--- |';
  const body = rows.map(r => {
    const cleanSummary = r.abstractSummary.replace(/\|/g, '/').replace(/\r?\n/g, ' ');
    const statusLabel = r.screeningStatus === 'included' ? 'Incluse' : 'À vérifier';
    const robLabel = formatRobFrenchLabel(r.riskOfBiasOverall);
    return `| ${r.pmid} | **${r.firstAuthorYear}** (_${r.journal}_) | ${r.studyDesignLabel} · ${statusLabel} | ${cleanSummary} | ${robLabel} |`;
  }).join('\n');

  return `${header}\n${body}\n`;
}
