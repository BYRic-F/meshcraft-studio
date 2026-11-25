import { useState, useMemo } from 'react';
import { Database, ExternalLink, BookOpen, ChevronDown, ChevronUp, AlertCircle, ArrowDown, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { PubMedArticle } from '../services/rustEngineService';

interface PubMedResultsProps {
  liveResult?: {
    count: number;
    articles: PubMedArticle[];
    queryTranslation?: string;
  };
  isGenerating: boolean;
  pubmedQuery?: string;
  usedFallback?: boolean;
}

export default function PubMedResults({ liveResult, isGenerating, pubmedQuery: _pubmedQuery, usedFallback }: PubMedResultsProps) {
  const [expandedPmid, setExpandedPmid] = useState<string | null>(null);
  const [isSectionCollapsed, setIsSectionCollapsed] = useState<boolean>(false);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(5);
  const [searchTerm, setSearchTerm] = useState<string>('');

  const count = liveResult?.count || 0;
  const articles = liveResult?.articles || [];

  const filteredArticles = useMemo(() => {
    if (!searchTerm.trim()) return articles;
    const q = searchTerm.toLowerCase();
    return articles.filter(a => 
      a.title.toLowerCase().includes(q) ||
      a.authors.toLowerCase().includes(q) ||
      a.pmid.includes(q) ||
      (a.source && a.source.toLowerCase().includes(q))
    );
  }, [articles, searchTerm]);

  const totalPages = Math.ceil(filteredArticles.length / pageSize) || 1;
  const paginatedArticles = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredArticles.slice(start, start + pageSize);
  }, [filteredArticles, currentPage, pageSize]);

  if (!liveResult && !isGenerating) return null;

  const scrollToPrisma = () => {
    const el = document.getElementById('prisma-section');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="med-card p-6 space-y-4">
      
      {/* En-tête de section PubMed */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-slate-900 border border-slate-800 text-sky-400">
            <Database className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
              <span>Validation en direct sur PubMed (NCBI Entrez E-Utilities)</span>
            </h3>
            <p className="text-xs text-slate-400">
              Résultats réels et résumés structurés extraits des serveurs officiels de la National Library of Medicine.
            </p>
          </div>
        </div>

        {liveResult && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400">Indexé :</span>
              <span className="px-2.5 py-1 rounded bg-slate-950 border border-slate-700 text-sky-300 font-mono font-bold text-xs">
                {count.toLocaleString('fr-FR')} articles
              </span>
            </div>

            <button
              type="button"
              onClick={scrollToPrisma}
              className="px-3 py-1 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-700 text-sky-300 hover:text-sky-200 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
              title="Aller directement au diagramme de flux PRISMA 2020"
            >
              <span>Diagramme PRISMA</span>
              <ArrowDown className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setIsSectionCollapsed(!isSectionCollapsed)}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
              title={isSectionCollapsed ? "Déplier la liste des résumés" : "Replier pour réduire le défilement"}
            >
              {isSectionCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
            </button>
          </div>
        )}
      </div>

      {/* Alerte Repli Automatique */}
      {usedFallback && (
        <div className="p-3.5 rounded-lg bg-amber-950/40 border border-amber-800/60 text-xs text-amber-200 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <span className="font-semibold text-amber-300">Ajustement de sensibilité automatique :</span> L'équation initiale complète a retourné 0 résultat. Le moteur a automatiquement relancé la recherche en retirant l'axe Comparaison pour préserver la sensibilité de la recherche.
          </div>
        </div>
      )}

      {/* État de chargement ou contenu replié */}
      {isGenerating ? (
        <div className="py-10 text-center space-y-3">
          <div className="inline-block w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs font-medium text-slate-300">Interrogation des serveurs NCBI E-Utilities...</p>
        </div>
      ) : isSectionCollapsed ? (
        <div className="py-2 flex items-center justify-between text-xs text-slate-400 bg-slate-950/40 px-3 py-2 rounded-lg border border-slate-800/60">
          <span>Liste PubMed masquée ({articles.length} résumés chargés en mémoire).</span>
          <button
            type="button"
            onClick={() => setIsSectionCollapsed(false)}
            className="text-sky-400 hover:text-sky-300 font-medium underline cursor-pointer"
          >
            Déplier les résumés
          </button>
        </div>
      ) : articles.length === 0 ? (
        <div className="py-8 text-center space-y-1">
          <p className="text-slate-400 text-xs">Aucun article ne correspond exactement à ces critères de recherche sur PubMed.</p>
          <p className="text-slate-500 text-[11px]">Essayez d'élargir la stratégie en mode « Revue systématique » ou de désactiver l'axe Comparaison.</p>
        </div>
      ) : (
        <div className="space-y-3">
          
          {/* Barre d'outils compacte : recherche + pagination */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 text-xs bg-slate-950 p-2.5 rounded-lg border border-slate-800">
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded px-2.5 py-1 flex-1">
              <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <input
                type="text"
                value={searchTerm}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder="Filtrer parmi les résumés (titre, auteur, PMID)..."
                className="bg-transparent text-xs text-slate-200 placeholder-slate-500 focus:outline-none w-full"
              />
            </div>

            <div className="flex items-center justify-between sm:justify-end gap-3 text-slate-400">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px]">Par page :</span>
                {[5, 10, 25].map(size => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => {
                      setPageSize(size);
                      setCurrentPage(1);
                    }}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                      pageSize === size ? 'bg-sky-950 text-sky-300 border border-sky-700' : 'hover:text-slate-200'
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>

              {/* Sélecteur de page */}
              <div className="flex items-center gap-1 font-mono text-[11px]">
                <span>{currentPage} / {totalPages}</span>
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  className="p-1 rounded bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  title="Page précédente"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  className="p-1 rounded bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                  title="Page suivante"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* Conteneur scrollable avec hauteur maximale maîtrisée */}
          <div className="max-h-[500px] overflow-y-auto pr-1.5 space-y-3 custom-scrollbar">
            {paginatedArticles.map((article, idx) => {
              const isExpanded = expandedPmid === article.pmid;
              const globalIndex = (currentPage - 1) * pageSize + idx + 1;
              return (
                <div
                  key={article.pmid}
                  className="p-3.5 rounded-lg bg-slate-950 border border-slate-800/80 hover:border-slate-700 transition-colors space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-slate-500 font-bold">#{globalIndex}</span>
                        <a
                          href={article.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs sm:text-sm font-semibold text-slate-100 hover:text-sky-400 transition-colors flex items-center gap-1.5 group leading-snug"
                        >
                          <span>{article.title}</span>
                          <ExternalLink className="w-3 h-3 text-slate-500 group-hover:text-sky-400 transition-colors shrink-0" />
                        </a>
                      </div>
                      
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                        <span className="text-slate-300 font-medium">{article.authors}</span>
                        <span>•</span>
                        <span className="text-slate-400">{article.source}</span>
                        <span>•</span>
                        <span>{article.pubDate}</span>
                        {article.doi && (
                          <>
                            <span>•</span>
                            <span className="font-mono text-slate-500 text-[10px]">DOI: {article.doi}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <span className="px-2 py-0.5 rounded bg-slate-900 text-[10px] font-mono text-slate-400 shrink-0 border border-slate-800">
                      PMID: {article.pmid}
                    </span>
                  </div>

                  {/* Descripteurs MeSH indexés sur l'article */}
                  {article.meshHeadings && article.meshHeadings.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {article.meshHeadings.slice(0, 5).map((mesh, mIdx) => (
                        <span
                          key={mIdx}
                          className="px-2 py-0.5 rounded bg-slate-900 text-sky-300 border border-slate-800 text-[10px] font-medium"
                        >
                          {mesh}
                        </span>
                      ))}
                      {article.meshHeadings.length > 5 && (
                        <span className="text-[10px] text-slate-500 self-center">
                          +{article.meshHeadings.length - 5} MeSH
                        </span>
                      )}
                    </div>
                  )}

                  {/* Actions de lecture */}
                  <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-xs">
                    <button
                      type="button"
                      onClick={() => setExpandedPmid(isExpanded ? null : article.pmid)}
                      className="text-sky-400 hover:text-sky-300 flex items-center gap-1 font-medium transition-colors cursor-pointer"
                    >
                      <BookOpen className="w-3 h-3" />
                      <span>{isExpanded ? "Masquer le résumé structuré" : "Lire le résumé PubMed"}</span>
                      {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>

                    <a
                      href={article.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-400 hover:text-slate-200 flex items-center gap-1 text-[11px]"
                    >
                      <span>Consulter sur PubMed</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>

                  {/* Résumé structuré déplié */}
                  {isExpanded && (
                    <div
                      className="p-3.5 rounded bg-slate-900 border border-slate-800 text-xs text-slate-300 leading-relaxed space-y-2 font-sans"
                      dangerouslySetInnerHTML={{ __html: article.abstract }}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Pied de page pagination */}
          <div className="flex items-center justify-between text-xs text-slate-500 pt-1 border-t border-slate-800/60 px-1">
            <span>
              Affichage des articles <strong>{Math.min(filteredArticles.length, (currentPage - 1) * pageSize + 1)}</strong> à <strong>{Math.min(filteredArticles.length, currentPage * pageSize)}</strong> sur <strong>{filteredArticles.length}</strong>
            </span>
            <button
              type="button"
              onClick={scrollToPrisma}
              className="text-sky-400 hover:text-sky-300 flex items-center gap-1 transition-colors cursor-pointer"
            >
              <span>Accéder au dépouillement PRISMA</span>
              <ArrowDown className="w-3 h-3" />
            </button>
          </div>

        </div>
      )}

    </div>
  );
}
