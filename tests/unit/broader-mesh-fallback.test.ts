import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/services/hetopService', () => ({
  isHetopConfigured: () => false,
  searchHetopMesh: vi.fn(async () => null)
}));

import {
  searchNcbiMesh,
  clearMeshResolutionCaches
} from '../../src/services/meshDatabase';
import { buildQuerySyntax, MappedBlock } from '../../src/services/multiAgentWorkflow';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Résolution MeSH exact-first + repli contrôlé sur broaderMeshRoot (hors-ligne)', () => {
  beforeEach(() => {
    clearMeshResolutionCaches();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMeshResolutionCaches();
  });

  it('Exact-first : préserve un descripteur pré-coordonné exact ("Renal Insufficiency, Chronic") sans appeler broaderMeshRoot', async () => {
    const queriedTerms: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        if (url.pathname.endsWith('esearch.fcgi')) {
          const term = url.searchParams.get('term') || '';
          queriedTerms.push(term);
          if (term.toLowerCase().includes('renal insufficiency, chronic')) {
            return jsonResponse({ esearchresult: { idlist: ['68051436'] } });
          }
          return jsonResponse({ esearchresult: { idlist: [] } });
        }
        if (url.pathname.endsWith('esummary.fcgi')) {
          return jsonResponse({
            result: {
              '68051436': {
                uid: '68051436',
                ds_recordtype: 'descriptor',
                ds_meshui: 'D051436',
                ds_meshterms: [
                  'Renal Insufficiency, Chronic',
                  'Chronic Kidney Disease',
                  'Chronic Renal Insufficiency'
                ],
                ds_subheading: ['diagnosis', 'epidemiology', 'therapy'],
                ds_idxlinks: [{ treenum: 'C12.050.351.968.419.780.750' }]
              }
            }
          });
        }
        throw new Error(`Unexpected URL in mock: ${url.toString()}`);
      })
    );

    const details = await searchNcbiMesh('Insuffisance rénale chronique', 'O', undefined, [
      {
        conceptFr: 'insuffisance rénale chronique',
        conceptEn: 'Renal Insufficiency, Chronic',
        broaderMeshRoot: 'Renal Insufficiency',
        synonymsTiab: ['chronic kidney disease', 'CKD']
      }
    ]);

    expect(details).not.toBeNull();
    expect(details!.meshId).toBe('D051436');
    expect(details!.descriptor).toBe('Renal Insufficiency, Chronic');
    expect(details!.descriptors?.map((d) => d.descriptor)).toEqual(['Renal Insufficiency, Chronic']);
    expect(details!.unresolvedMeshTerms).toBeUndefined();

    // Vérifie qu'aucun appel n'a été déclenché pour la racine plus large "Renal Insufficiency" seule
    expect(
      queriedTerms.some((t) => t.toLowerCase() === '"renal insufficiency"[mesh terms]')
    ).toBe(false);
  });

  it('Fallback : quand "chronic low back pain" renvoie 0 MeSH, résout broaderMeshRoot ("Low Back Pain") en [Mesh] tout en conservant "chronic low back pain"[tiab]', async () => {
    const queriedTerms: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
        if (url.pathname.endsWith('esearch.fcgi')) {
          const term = url.searchParams.get('term') || '';
          queriedTerms.push(term);
          if (term.toLowerCase().includes('chronic low back pain')) {
            return jsonResponse({ esearchresult: { idlist: [] } });
          }
          if (term.toLowerCase().includes('low back pain')) {
            return jsonResponse({ esearchresult: { idlist: ['68017116'] } });
          }
          return jsonResponse({ esearchresult: { idlist: [] } });
        }
        if (url.pathname.endsWith('esummary.fcgi')) {
          return jsonResponse({
            result: {
              '68017116': {
                uid: '68017116',
                ds_recordtype: 'descriptor',
                ds_meshui: 'D017116',
                ds_meshterms: ['Low Back Pain', 'Lumbago', 'Lower Back Pain'],
                ds_subheading: ['rehabilitation', 'therapy'],
                ds_idxlinks: [{ treenum: 'C10.597.617.152.500' }]
              }
            }
          });
        }
        throw new Error(`Unexpected URL in mock: ${url.toString()}`);
      })
    );

    const details = await searchNcbiMesh('Lombalgie chronique non spécifique', 'P', undefined, [
      {
        conceptFr: 'lombalgie chronique non spécifique',
        conceptEn: 'chronic low back pain',
        broaderMeshRoot: 'Low Back Pain',
        synonymsTiab: ['chronic non-specific low back pain', 'nonspecific low back pain']
      }
    ]);

    expect(details).not.toBeNull();
    expect(details!.meshId).toBe('D017116');
    expect(details!.descriptor).toBe('Low Back Pain');
    expect(details!.descriptors?.map((d) => d.descriptor)).toEqual(['Low Back Pain']);
    expect(details!.entryTerms).toContain('chronic low back pain');
    expect(details!.unresolvedMeshTerms).toContain('chronic low back pain');

    // Vérifie que l'appel exact a bien eu lieu avant le repli sur broaderMeshRoot
    const firstExactIdx = queriedTerms.findIndex((t) =>
      t.toLowerCase().includes('chronic low back pain')
    );
    const firstBroaderIdx = queriedTerms.findIndex(
      (t) => t.toLowerCase() === '"low back pain"[mesh terms]'
    );
    expect(firstExactIdx).toBeGreaterThanOrEqual(0);
    expect(firstBroaderIdx).toBeGreaterThan(firstExactIdx);

    // Vérifie la compilation PubMed finale : "Low Back Pain"[Mesh] ET "chronic low back pain"[tiab]
    const block: MappedBlock = {
      picoType: 'P',
      originalText: 'Lombalgie chronique non spécifique',
      descriptor: details!.descriptor,
      meshId: details!.meshId,
      descriptors: details!.descriptors || [],
      entryTerms: details!.entryTerms,
      truncationTerms: details!.truncationTerms || [],
      allowedSubheadings: details!.allowedSubheadings || [],
      unresolvedMeshTerms: details!.unresolvedMeshTerms
    };

    const { pubmedQuery } = buildQuerySyntax([block], {
      strategy: 'balanced',
      useTruncation: true,
      filters: []
    });

    expect(pubmedQuery).toContain('"Low Back Pain"[Mesh]');
    expect(pubmedQuery.toLowerCase()).toContain('"chronic low back pain"[tiab]');
  });
});
