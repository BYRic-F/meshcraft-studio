/**
 * Service de génération et de modélisation du flux PRISMA 2020
 * Conforme aux standards internationaux (Page MJ, et al. BMJ 2021;372:n71)
 * et aux exigences des revues systématiques de la littérature.
 */

export interface PrismaFlowData {
  identification: {
    pubmedHits: number;
    embaseEstimatedHits: number;
    cochraneEstimatedHits: number;
    totalIdentified: number;
    duplicatesRemoved: number;
  };
  screening: {
    recordsScreened: number;
    recordsExcluded: number;
    reasonsScreening: string[];
  };
  eligibility: {
    fullTextAssessed: number;
    pendingFullText?: number;
    fullTextExcluded: number;
    exclusionBreakdown: Array<{ reason: string; count: number }>;
  };
  included: {
    studiesIncluded: number;
    meshDescriptorsUsed: number;
  };
}

import { ScreenedArticle, computeScreeningMetrics } from './agentScreener';

export function generatePrismaSummaryData(
  liveResult: { readonly count?: number } | null | undefined,
  mappedBlocks: readonly unknown[],
  _pico?: { p: string; i: string; c: string; o: string },
  customScreenedArticles?: ScreenedArticle[]
): PrismaFlowData {
  const pubmedHits = liveResult?.count || 0;
  const meshCount = mappedBlocks?.length || 0;

  // Si l'IA ou le lecteur a dépouillé des articles
  if (customScreenedArticles && customScreenedArticles.length > 0) {
    const metrics = computeScreeningMetrics(customScreenedArticles);

    return {
      identification: {
        pubmedHits,
        embaseEstimatedHits: 0,
        cochraneEstimatedHits: 0,
        totalIdentified: pubmedHits,
        duplicatesRemoved: 0,
      },
      screening: {
        recordsScreened: metrics.totalScreened,
        recordsExcluded: metrics.totalExcluded,
        reasonsScreening: metrics.exclusionBreakdown.map(b => b.reason)
      },
      eligibility: {
        fullTextAssessed: metrics.totalIncluded + metrics.totalMaybe,
        pendingFullText: metrics.totalMaybe,
        fullTextExcluded: 0,
        exclusionBreakdown: metrics.exclusionBreakdown.map(b => ({
          reason: b.reason,
          count: b.count
        }))
      },
      included: {
        studiesIncluded: metrics.totalIncluded,
        meshDescriptorsUsed: meshCount,
      }
    };
  }

  // Par défaut : aucun screening automatique, tout est identifié et prêt pour le dépouillement IA
  return {
    identification: {
      pubmedHits,
      embaseEstimatedHits: 0,
      cochraneEstimatedHits: 0,
      totalIdentified: pubmedHits,
      duplicatesRemoved: 0,
    },
    screening: {
      recordsScreened: 0,
      recordsExcluded: 0,
      reasonsScreening: []
    },
    eligibility: {
      fullTextAssessed: 0,
      pendingFullText: 0,
      fullTextExcluded: 0,
      exclusionBreakdown: []
    },
    included: {
      studiesIncluded: 0,
      meshDescriptorsUsed: meshCount,
    }
  };
}

export function generateThesisMethodologyText(
  pico: { p: string; i: string; c: string; o: string; not?: string },
  pubmedQuery: string,
  embaseQuery: string,
  prisma: PrismaFlowData,
  inclusionCriteria?: string[],
  exclusionCriteria?: string[],
  cochraneQuery?: string
): string {
  const dateStr = new Date().toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });
  const pendingFullText = prisma.eligibility.pendingFullText ?? 0;
  const topScreeningReasons = prisma.eligibility.exclusionBreakdown
    .filter(item => item.count > 0)
    .slice(0, 5)
    .map(item => `     * ${item.reason} (n = ${item.count})`)
    .join('\n');

  const embaseSection = embaseQuery && embaseQuery.trim().length > 0
    ? embaseQuery
    : 'Non renseignée dans cet export.';

  const cochraneSection = cochraneQuery && cochraneQuery.trim().length > 0
    ? `\n\nÉquation de recherche Cochrane CENTRAL :\n${cochraneQuery}`
    : '';

  const hasEmbase = prisma.identification.embaseEstimatedHits > 0;
  const hasCochrane = prisma.identification.cochraneEstimatedHits > 0;

  let databasesParagraph = '';
  if (!hasEmbase && !hasCochrane) {
    databasesParagraph =
      "La base de données PubMed / MEDLINE (National Library of Medicine) a été interrogée. L'équation combine les descripteurs contrôlés MeSH et les termes libres correspondants dans le titre et le résumé [TiAb], reliés par les opérateurs booléens AND, OR et NOT. Les équations traduites pour Embase (Elsevier) et Cochrane CENTRAL sont fournies ci-dessous pour une extension multi-bases.";
  } else {
    const queriedDbs = [
      'PubMed / MEDLINE (National Library of Medicine)',
      ...(hasEmbase ? ['Embase (Elsevier)'] : []),
      ...(hasCochrane ? ['Cochrane CENTRAL'] : [])
    ];
    const joinedDbs =
      queriedDbs.length === 2
        ? `${queriedDbs[0]} et ${queriedDbs[1]}`
        : `${queriedDbs.slice(0, -1).join(', ')} et ${queriedDbs[queriedDbs.length - 1]}`;
    const remainingNote =
      !hasEmbase
        ? " L'équation traduite pour Embase (Elsevier) est fournie ci-dessous pour une extension ultérieure."
        : !hasCochrane
          ? " L'équation traduite pour Cochrane CENTRAL est fournie ci-dessous pour une extension ultérieure."
          : '';
    databasesParagraph = `Les bases de données ${joinedDbs} ont été interrogées. Les équations combinent les descripteurs contrôlés (MeSH pour PubMed${hasEmbase ? ', Emtree pour Embase' : ''}) et les termes libres correspondants dans le titre et le résumé [TiAb], reliés par les opérateurs booléens AND, OR et NOT.${remainingNote}`;
  }

  return `========================================================================
CHAPITRE : MATÉRIEL ET MÉTHODES — REVUE SYSTÉMATIQUE DE LA LITTÉRATURE
Protocole méthodologique : Standards PRISMA 2020 & Guide Cochrane
Date de réalisation : ${dateStr}
========================================================================

A. CADRAGE ET QUESTION DE RECHERCHE CLINIQUE (MODÈLE PICO / PECO)
------------------------------------------------------------------------
• Population (P)                  : ${pico.p || 'Non spécifiée'}
• Intervention / Exposition (I/E) : ${pico.i || 'Non spécifiée'}
• Comparateur (C)                 : ${pico.c || 'Sans restriction / Soins habituels / Placebo'}
• Outcome (O)                     : ${pico.o || 'Critère de jugement principal et secondaire'}
• Exclusion (NOT)                 : ${pico.not || 'Aucun critère clinique spécifique'}

Question de recherche formulée :
"Chez les patients présentant [${pico.p || 'la pathologie'}], quel est l'effet ou l'association de [${pico.i || "l'intervention ou l'exposition"}] comparé à [${pico.c || 'la prise en charge standard ou absence d\'exposition'}] sur [${pico.o || 'les critères de jugement'}] ?"
${pico.not ? `Critères formels d'exclusion clinique : [${pico.not}]\n` : ''}

B. CRITÈRES D'ÉLIGIBILITÉ
------------------------------------------------------------------------
1. Critères d'inclusion :
${(inclusionCriteria && inclusionCriteria.length > 0) 
  ? inclusionCriteria.map(c => `   - ${c}`).join('\n') 
  : `   - Études cliniques originales répondant au cadrage PICO/PECO défini ci-dessus (essais contrôlés, cohortes ou études comparatives selon la question clinique)
   - Population cible (P) : ${pico.p || 'Selon définition clinique du protocole'}
   - Intervention / Exposition ciblée (I/E) : ${pico.i || 'Selon définition clinique du protocole'}
   - Comparateur (C) : ${pico.c || 'Sans restriction / Soins habituels / Placebo'}
   - Critère de jugement (O) : ${pico.o || 'Outcomes principaux d\'efficacité ou de sécurité'}
   - Texte intégral accessible en langue française ou anglaise`}

2. Critères d'exclusion :
${(exclusionCriteria && exclusionCriteria.length > 0) 
  ? exclusionCriteria.map(c => `   - ${c}`).join('\n') 
  : `${pico.not ? `   - Critère d'exclusion clinique spécifique (Axe NOT) : ${pico.not}\n` : ''}   - Études hors périmètre clinique, résumés de congrès isolés sans article complet, éditoriaux d'opinion et protocoles sans résultats exploitables
   - Modèles précliniques exclusivement animaux ou in vitro / cellulaires`}


C. STRATÉGIE DE RECHERCHE DOCUMENTAIRE
------------------------------------------------------------------------
${databasesParagraph}

Équation de recherche PubMed :
${pubmedQuery}

Équation de recherche Embase :
${embaseSection}${cochraneSection}


D. PROCESSUS DE SÉLECTION & DIAGRAMME DE FLUX PRISMA 2020
------------------------------------------------------------------------
La sélection des études a suivi les recommandations PRISMA 2020 :
1. Identification :
   - PubMed : ${prisma.identification.pubmedHits.toLocaleString('fr-FR')} références
   - Embase (estimation) : ${prisma.identification.embaseEstimatedHits.toLocaleString('fr-FR')} références
   - Cochrane Library (estimation) : ${prisma.identification.cochraneEstimatedHits.toLocaleString('fr-FR')} références
   - Total identifié : ${prisma.identification.totalIdentified.toLocaleString('fr-FR')} références
2. Dédoublonnage :
   - ${prisma.identification.duplicatesRemoved.toLocaleString('fr-FR')} doublons éliminés
3. Sélection sur titre et résumé (Screening) :
   - ${prisma.screening.recordsScreened.toLocaleString('fr-FR')} références examinées
   - ${prisma.screening.recordsExcluded.toLocaleString('fr-FR')} références exclues sur titre/résumé${topScreeningReasons ? `\n   - Principaux motifs d'exclusion (Titre/Résumé) :\n${topScreeningReasons}` : ''}
4. Éligibilité sur texte intégral :
   - ${prisma.eligibility.fullTextAssessed.toLocaleString('fr-FR')} articles retenus pour évaluation sur texte intégral
   - ${pendingFullText.toLocaleString('fr-FR')} articles en attente de vérification sur texte intégral (À vérifier)
   - ${prisma.eligibility.fullTextExcluded.toLocaleString('fr-FR')} articles exclus après lecture intégrale
5. Inclusion finale :
   - ${prisma.included.studiesIncluded.toLocaleString('fr-FR')} études incluses dans la revue systématique


E. ÉVALUATION DU RISQUE DE BIAIS
------------------------------------------------------------------------
La qualité méthodologique des études incluses est évaluée selon les grilles de référence internationales :
• Pour les essais contrôlés randomisés : Outil Cochrane RoB 2 (Risk of Bias 2) évaluant 5 domaines (processus de randomisation, déviation des interventions, données manquantes, mesure du critère de jugement, sélection des résultats rapportés).
• Pour les études non randomisées : Outil ROBINS-I (Risk Of Bias In Non-randomized Studies of Interventions).
• Pour les revues systématiques : Grille AMSTAR 2.
========================================================================`;
}

export interface PrismaReportStatsInput {
  readonly identifiedTotal: number;
  readonly pubmedCount: number;
  readonly embaseCount: number;
  readonly duplicatesRemoved: number;
  readonly screened: number;
  readonly excludedScreening: number;
  readonly fullTextAssessed: number;
  readonly pendingFullText?: number;
  readonly excludedFullText: number;
  readonly includedFinal: number;
  readonly exclusionBreakdown?: ReadonlyArray<{ readonly reason: string; readonly count: number }>;
}

export interface PrismaReportContextInput {
  readonly pico?: {
    readonly p: string;
    readonly i: string;
    readonly c: string;
    readonly o: string;
    readonly not?: string;
  };
  readonly embaseQuery?: string;
  readonly cochraneQuery?: string;
  readonly meshDescriptorsUsed?: number;
}

export function generatePrismaReportText(
  pubmedQuery: string,
  stats: PrismaReportStatsInput,
  context?: PrismaReportContextInput
): string {
  const pendingFullText = stats.pendingFullText ?? 0;
  const exclusionBreakdown = (stats.exclusionBreakdown || []).map(item => ({
    reason: item.reason,
    count: item.count
  }));

  const prismaData: PrismaFlowData = {
    identification: {
      pubmedHits: stats.pubmedCount,
      embaseEstimatedHits: stats.embaseCount,
      cochraneEstimatedHits: 0, // Zéro extrapolation : à saisir par le candidat s'il a accès à Cochrane
      totalIdentified: stats.identifiedTotal,
      duplicatesRemoved: stats.duplicatesRemoved
    },
    screening: {
      recordsScreened: stats.screened,
      recordsExcluded: stats.excludedScreening,
      reasonsScreening: exclusionBreakdown.map(b => b.reason)
    },
    eligibility: {
      fullTextAssessed: stats.fullTextAssessed,
      pendingFullText,
      fullTextExcluded: stats.excludedFullText,
      exclusionBreakdown
    },
    included: {
      studiesIncluded: stats.includedFinal,
      meshDescriptorsUsed: context?.meshDescriptorsUsed ?? 0
    }
  };

  const picoInput = context?.pico ?? { p: '', i: '', c: '', o: '' };
  const topReasonsBlock = exclusionBreakdown.length > 0
    ? `\n${exclusionBreakdown.slice(0, 5).map(b => `   - ${b.reason} (n = ${b.count})`).join('\n')}`
    : '';

  return `========================================================================
RAPPORT MÉTHODOLOGIQUE PRISMA 2020 — REVUE SYSTÉMATIQUE DE LA LITTÉRATURE
========================================================================

ÉQUATION DE RECHERCHE PRINCIPALE (PUBMED) :
${pubmedQuery}

FLUX DE SÉLECTION DÉTAILLÉ :
1. Références identifiées au total : ${stats.identifiedTotal}
   - PubMed : ${stats.pubmedCount}
   - Embase : ${stats.embaseCount}
2. Doublons retirés : ${stats.duplicatesRemoved}
3. Références examinées sur titre/résumé : ${stats.screened}
4. Références exclues sur titre/résumé : ${stats.excludedScreening}${topReasonsBlock}
5. Textes intégraux évalués / retenus pour éligibilité : ${stats.fullTextAssessed}
   - En attente de vérification sur texte intégral (À vérifier) : ${pendingFullText}
6. Textes intégraux exclus : ${stats.excludedFullText}
7. Articles inclus définitivement dans la synthèse qualitative / quantitative : ${stats.includedFinal}

${generateThesisMethodologyText(
    picoInput,
    pubmedQuery,
    context?.embaseQuery || '',
    prismaData,
    undefined,
    undefined,
    context?.cochraneQuery
  )}`;
}
