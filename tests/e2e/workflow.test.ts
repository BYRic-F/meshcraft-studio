import { describe, it, expect } from 'vitest';
import { runMultiAgentPipeline } from '../../src/services/multiAgentWorkflow';
import { generatePrismaReportText } from '../../src/services/prismaReport';

describe('4. Tests de Bout en Bout (End-to-End Workflow Tests)', () => {
  it('doit exécuter le parcours utilisateur complet : PICO -> Résolution -> Équations -> Validation PubMed -> Export Thèse', async () => {
    // Étape 1 : Saisie utilisateur
    const userInputs = {
      p: 'Adultes en surpoids ou obésité',
      i: 'Jeûne intermittent (Intermittent Fasting)',
      c: 'Alimentation habituelle',
      o: 'Perte de poids'
    };

    // Étape 2 : Exécution du pipeline
    const pipelineOutput = await runMultiAgentPipeline(
      userInputs,
      {
        strategy: 'balanced',
        activePico: { p: true, i: true, c: true, o: true },
        filters: ['humans']
      }
    );

    // Étape 3 : Contrôle de la génération multi-bases
    expect(pipelineOutput.pubmedQuery).toBeDefined();
    expect(pipelineOutput.embaseQuery).toBeDefined();
    expect(pipelineOutput.cochraneQuery).toBeDefined();

    // Étape 4 : Contrôle de l'audit PubMed
    expect(pipelineOutput.liveResult.articles.length).toBeGreaterThan(0);
    const topArticle = pipelineOutput.liveResult.articles[0];
    expect(topArticle.title).toBeDefined();
    expect(topArticle.pmid).toBeDefined();

    // Étape 5 : Compilation de l'export Thèse (Chapitre Méthodes)
    const thesisDocument = generatePrismaReportText(
      pipelineOutput.pubmedQuery,
      {
        identifiedTotal: pipelineOutput.liveResult.count,
        pubmedCount: pipelineOutput.liveResult.count,
        embaseCount: Math.round(pipelineOutput.liveResult.count * 1.5),
        duplicatesRemoved: Math.round(pipelineOutput.liveResult.count * 0.1),
        screened: Math.round(pipelineOutput.liveResult.count * 0.9),
        excludedScreening: Math.round(pipelineOutput.liveResult.count * 0.8),
        fullTextAssessed: 45,
        excludedFullText: 36,
        includedFinal: 9
      }
    );

    expect(thesisDocument).toContain('RAPPORT MÉTHODOLOGIQUE PRISMA 2020');
    expect(thesisDocument).toContain(pipelineOutput.pubmedQuery);
    expect(thesisDocument).toContain('ÉQUATION DE RECHERCHE PRINCIPALE (PUBMED)');
    expect(thesisDocument).toContain('FLUX DE SÉLECTION DÉTAILLÉ');
    expect(thesisDocument).toContain('Articles inclus définitivement dans la synthèse qualitative / quantitative : 9');
  }, 60000);

  it('doit résoudre et évaluer avec pertinence une question de thèse réelle hors presets même avec PICO narratif verbeux (Colchicine en post-infarctus du myocarde)', async () => {
    const externalThesisPico = {
      p: 'Patients en prévention secondaire après un infarctus du myocarde (Myocardial Infarction) ou un syndrome coronarien aigu (Acute Coronary Syndrome)',
      i: 'Traitement par colchicine à faible dose (0,5 mg/j) (Colchicine)',
      c: 'Placebo',
      o: 'Mortalité cardiovasculaire ou récidive d\'infarctus',
      not: 'Péricardite aiguë'
    };

    const output = await runMultiAgentPipeline(
      externalThesisPico,
      {
        strategy: 'balanced',
        activePico: { p: true, i: true, c: false, o: true, not: true },
        filters: ['rct', 'humans']
      }
    );

    console.log('=== TEST THÈSE RÉELLE HORS PRESET (COLCHICINE POST-IDM) ===');
    console.log('Descripteurs résolus :', output.mappedBlocks.map(b => `${b.picoType}: ${b.descriptor} (${b.meshId})`));
    console.log('Équation PubMed :\n', output.pubmedQuery);
    console.log('Volume PubMed :', output.liveResult.count);
    console.log('Top 3 articles :', output.liveResult.articles.slice(0, 3).map(a => `[PMID ${a.pmid}] ${a.title}`));
    console.log('Score Audit :', output.critiqueReport.score, '| Source :', output.critiqueReport.evaluatorModel);

    expect(output.pubmedQuery).toContain('"Colchicine"[Mesh]');
    expect(output.pubmedQuery).toContain('"Myocardial Infarction"[Mesh]');
    expect(output.pubmedQuery).toContain('"Acute Coronary Syndrome"[Mesh]');
    expect(output.pubmedQuery).not.toContain('"Secondary Prevention"[Mesh]');
    expect(output.pubmedQuery).toContain('NOT');
    expect(output.liveResult.count).toBeGreaterThan(5);
    expect(output.liveResult.articles.length).toBeGreaterThan(0);
  }, 60000);
});
