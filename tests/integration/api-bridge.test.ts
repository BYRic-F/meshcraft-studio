import { describe, it, expect } from 'vitest';
import { searchNcbiMesh } from '../../src/services/meshDatabase';
import { queryPubMedLive } from '../../src/services/pubmedApi';
import { runMultiAgentPipeline } from '../../src/services/multiAgentWorkflow';

describe('2. Tests d\'Intégration (Integration Tests)', () => {
  describe('Passerelle Résolution MeSH & API NLM (searchNcbiMesh)', () => {
    it('doit résoudre un descripteur nutritionnel officiel avec code D0xxxxx et synonymes', async () => {
      const result = await searchNcbiMesh('Jeûne intermittent');
      expect(result).not.toBeNull();
      expect(result?.descriptor).toBeDefined();
      expect(['Fasting', 'Intermittent Fasting']).toContain(result?.descriptor);
      expect(result?.meshId.startsWith('D')).toBe(true);
      expect(result?.entryTerms.length).toBeGreaterThan(0);
    });

    it('doit extraire et résoudre les termes médicaux anglophones entre parenthèses', async () => {
      const result = await searchNcbiMesh('Excès de poids (Overweight, Obesity)');
      expect(result).not.toBeNull();
      expect(['Overweight', 'Obesity']).toContain(result?.descriptor);
    });
  });

  describe('Pont API PubMed Entrez (queryPubMedLive)', () => {
    it('doit interroger les serveurs NCBI et retourner un compte et des métadonnées valides', async () => {
      const query = '("Intermittent Fasting"[Mesh]) AND ("Humans"[mh])';
      const result = await queryPubMedLive(query, { maxResults: 3 });

      expect(result.error).toBeNull();
      expect(result.count).toBeGreaterThan(0);
      expect(Array.isArray(result.articles)).toBe(true);
      if (result.articles.length > 0) {
        expect(result.articles[0].pmid).toBeDefined();
        expect(result.articles[0].title.length).toBeGreaterThan(0);
      }
    }, 15000);
  });

  describe('Orchestration Multi-Agents (runMultiAgentPipeline)', () => {
    it('doit exécuter les 5 étapes séquentielles avec logs de progression', async () => {
      const stepsCalled: number[] = [];
      const res = await runMultiAgentPipeline(
        {
          p: 'Adultes en excès pondéral',
          i: 'Fasting',
          c: '',
          o: 'Poids'
        },
        {
          strategy: 'balanced',
          activePico: { p: true, i: true, c: false, o: true },
          filters: ['humans']
        },
        (stepId) => {
          if (!stepsCalled.includes(stepId)) stepsCalled.push(stepId);
        }
      );

      expect(stepsCalled).toContain(1);
      expect(stepsCalled).toContain(2);
      expect(stepsCalled).toContain(3);
      expect(stepsCalled).toContain(4);
      expect(stepsCalled).toContain(5);
      expect(res.pubmedQuery).toContain('AND');
      expect(res.liveResult).toBeDefined();
    }, 15000);
  });
});
