import { describe, it, expect } from 'vitest';
import { runMultiAgentPipeline } from '../../src/services/multiAgentWorkflow';

describe('Vérification du fonctionnement des sous-rubriques MeSH et des filtres méthodologiques', () => {

  const samplePico = {
    p: 'Hypertension',
    i: 'Amlodipine',
    c: 'Placebo',
    o: 'Blood Pressure'
  };

  describe('1. Sous-rubriques MeSH (Subheadings / Qualifiers)', () => {
    it('doit injecter la sous-rubrique /drug therapy sur le descripteur de pathologie P', async () => {
      const result = await runMultiAgentPipeline(
        samplePico,
        {
          strategy: 'balanced',
          qualifiers: ['drug therapy'],
          filters: [],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      expect(result.pubmedQuery).toContain('/drug therapy');
      expect(result.pubmedQuery).toMatch(/"Hypertension\/drug therapy"\[Mesh/);
    });

    it('doit injecter plusieurs sous-rubriques simultanément (/therapy et /prevention & control)', async () => {
      const result = await runMultiAgentPipeline(
        samplePico,
        {
          strategy: 'balanced',
          qualifiers: ['therapy', 'prevention & control'],
          filters: [],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      expect(result.pubmedQuery).toContain('/therapy');
      expect(result.pubmedQuery).toContain('/prevention and control');
      expect(result.pubmedQuery).toMatch(/"Hypertension\/therapy"\[Mesh/);
      expect(result.pubmedQuery).toMatch(/"Hypertension\/prevention and control"\[Mesh/);
      expect(result.cochraneQuery).toContain('/PC');
    });

    it('ne doit JAMAIS injecter de sous-rubriques sur l\'axe Intervention (I) ou Outcome (O)', async () => {
      const result = await runMultiAgentPipeline(
        samplePico,
        {
          strategy: 'balanced',
          qualifiers: ['drug therapy', 'therapy'],
          filters: [],
          activePico: { p: true, i: true, c: false, o: true }
        }
      );

      // Amlodipine est l'intervention, elle ne doit pas avoir /drug therapy
      expect(result.pubmedQuery).not.toContain('Amlodipine/drug therapy');
      expect(result.pubmedQuery).not.toContain('Amlodipine/therapy');
    });
  });

  describe('2. Filtres Méthodologiques d\'Éligibilité', () => {
    it('doit ajouter le filtre Humains [mh] avec opérateur AND', async () => {
      const result = await runMultiAgentPipeline(
        samplePico,
        {
          strategy: 'balanced',
          qualifiers: [],
          filters: ['humans'],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      expect(result.pubmedQuery).toContain('"Humans"[mh]');
      expect(result.pubmedQuery).toMatch(/AND\s+"Humans"\[mh\]/);
    });

    it('doit ajouter le filtre Essais RCT [pt] avec opérateur AND', async () => {
      const result = await runMultiAgentPipeline(
        samplePico,
        {
          strategy: 'balanced',
          qualifiers: [],
          filters: ['rct'],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      expect(result.pubmedQuery).toContain('"Randomized Controlled Trial"[pt]');
    });

    it('doit ajouter le filtre Revues systématiques [pt]', async () => {
      const result = await runMultiAgentPipeline(
        samplePico,
        {
          strategy: 'balanced',
          qualifiers: [],
          filters: ['systematic'],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      expect(result.pubmedQuery).toContain('"Systematic Review"[pt]');
      expect(result.pubmedQuery).toContain('"Meta-Analysis"[pt]');
    });

    it('doit combiner RCT et Revues Systématiques avec un OR logique selon les standards Cochrane', async () => {
      const result = await runMultiAgentPipeline(
        samplePico,
        {
          strategy: 'balanced',
          qualifiers: [],
          filters: ['rct', 'systematic', 'humans'],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      expect(result.pubmedQuery).toContain('"Humans"[mh]');
      // Les types d'études doivent être en OR dans une parenthèse commune
      expect(result.pubmedQuery).toMatch(/\("Randomized Controlled Trial"\[pt\] OR \("Systematic Review"\[pt\] OR "Meta-Analysis"\[pt\]\)\)/);
    });
  });

  describe('3. Combinaison Conjointe Sous-rubriques + Filtres Méthodologiques', () => {
    it('doit générer une équation PubMed parfaitement syntaxée et équilibrée', async () => {
      const result = await runMultiAgentPipeline(
        samplePico,
        {
          strategy: 'balanced',
          qualifiers: ['drug therapy', 'mortality'],
          filters: ['humans', 'rct'],
          activePico: { p: true, i: true, c: false, o: false }
        }
      );

      expect(result.pubmedQuery).toContain('/drug therapy');
      expect(result.pubmedQuery).toContain('/mortality');
      expect(result.pubmedQuery).toContain('"Humans"[mh]');
      expect(result.pubmedQuery).toContain('"Randomized Controlled Trial"[pt]');

      // Vérification de l'équilibre des parenthèses
      const openP = (result.pubmedQuery.match(/\(/g) || []).length;
      const closeP = (result.pubmedQuery.match(/\)/g) || []).length;
      expect(openP).toBe(closeP);

      // Vérification des guillemets
      const quotes = (result.pubmedQuery.match(/"/g) || []).length;
      expect(quotes % 2).toBe(0);
    });
  });

});
