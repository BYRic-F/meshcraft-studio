import { useState, useRef } from 'react';
import {
  X,
  FolderOpen,
  Save,
  Upload,
  Download,
  Trash2,
  Plus,
  Play,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import {
  SavedReviewSnapshot,
  serializeReviewToJson
} from '../services/reviewStorageService';
import { useTranslation } from '../i18n';

export interface HistoryDrawerProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly reviews: readonly SavedReviewSnapshot[];
  readonly activeReviewId: string | null;
  readonly defaultTitle: string;
  readonly canSaveCurrent: boolean;
  readonly hasActiveSession: boolean;
  readonly onSaveCurrent: (customTitle: string) => Promise<void>;
  readonly onResumeReview: (snapshot: SavedReviewSnapshot) => void;
  readonly onDeleteReview: (id: string) => Promise<void>;
  readonly onImportReviewJson: (rawJson: string) => Promise<{ ok: boolean; error?: string }>;
  readonly onNewReview: () => Promise<void>;
}

export default function HistoryDrawer({
  isOpen,
  onClose,
  reviews,
  activeReviewId,
  defaultTitle,
  canSaveCurrent,
  hasActiveSession,
  onSaveCurrent,
  onResumeReview,
  onDeleteReview,
  onImportReviewJson,
  onNewReview
}: HistoryDrawerProps) {
  const { locale, t } = useTranslation();
  const [titleInput, setTitleInput] = useState<string>(defaultTitle);
  const [prevIsOpen, setPrevIsOpen] = useState<boolean>(isOpen);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [confirmNew, setConfirmNew] = useState<boolean>(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setTitleInput(defaultTitle);
      setConfirmNew(false);
      setConfirmDeleteId(null);
      setFeedback(null);
    }
  }

  if (!isOpen) return null;

  const formatDateTime = (ts: number): string => {
    try {
      return new Date(ts).toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  };

  const handleSaveClick = async () => {
    if (!canSaveCurrent || isSaving) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      await onSaveCurrent(titleInput.trim() || defaultTitle);
      setFeedback({ kind: 'success', text: t.reviewsDrawer.savedFeedback });
    } finally {
      setIsSaving(false);
    }
  };

  const handleExportJson = (snapshot: SavedReviewSnapshot) => {
    const json = serializeReviewToJson(snapshot);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const safeSlug = snapshot.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'revue_meshcraft';
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeSlug}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedback(null);
    try {
      const rawText = await file.text();
      const res = await onImportReviewJson(rawText);
      if (res.ok) {
        setFeedback({ kind: 'success', text: t.reviewsDrawer.importSuccessFeedback });
        setTimeout(() => onClose(), 600);
      } else {
        setFeedback({ kind: 'error', text: res.error || 'Fichier JSON invalide.' });
      }
    } catch {
      setFeedback({ kind: 'error', text: 'Impossible de lire le fichier sélectionné.' });
    } finally {
      e.target.value = '';
    }
  };

  const handleNewReviewClick = async () => {
    if (hasActiveSession && !confirmNew) {
      setConfirmNew(true);
      return;
    }
    setConfirmNew(false);
    await onNewReview();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-xs">
      <div className="bg-white border-l border-slate-200 w-full max-w-md h-full flex flex-col shadow-xl">
        {/* En-tête tiroir */}
        <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/70 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-200 flex items-center justify-center text-indigo-600 shrink-0 mt-0.5">
              <FolderOpen className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 leading-tight">
                {t.reviewsDrawer.title}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 leading-snug">
                {t.reviewsDrawer.subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Zone d'actions en haut du tiroir */}
        <div className="p-5 border-b border-slate-200 space-y-3 bg-slate-50/40">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-slate-700">
              {t.reviewsDrawer.reviewTitleLabel}
            </label>
            <input
              type="text"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder={t.reviewsDrawer.reviewTitlePlaceholder}
              className="w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-slate-900 text-xs focus:outline-none focus:border-indigo-600"
            />
          </div>

          <button
            type="button"
            disabled={!canSaveCurrent || isSaving}
            onClick={() => void handleSaveClick()}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>
              {activeReviewId ? t.reviewsDrawer.updateCurrentBtn : t.reviewsDrawer.saveCurrentBtn}
            </span>
          </button>

          <div className="grid grid-cols-2 gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={(e) => void handleImportFileChange(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-slate-500" />
              <span>{t.reviewsDrawer.importJsonBtn}</span>
            </button>

            <button
              type="button"
              onClick={() => void handleNewReviewClick()}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 text-slate-500" />
              <span>{t.reviewsDrawer.newReviewBtn}</span>
            </button>
          </div>

          {confirmNew && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 space-y-2 text-xs text-amber-950">
              <p className="font-medium">{t.reviewsDrawer.confirmNewReviewText}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleNewReviewClick()}
                  className="px-3 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold cursor-pointer"
                >
                  {t.reviewsDrawer.confirmNewReviewApply}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmNew(false)}
                  className="px-3 py-1 rounded-lg border border-amber-300 bg-white hover:bg-amber-100 text-amber-900 font-semibold cursor-pointer"
                >
                  {t.reviewsDrawer.confirmNewReviewCancel}
                </button>
              </div>
            </div>
          )}

          {feedback && (
            <div
              className={`p-2.5 rounded-xl border text-xs flex items-start gap-2 ${
                feedback.kind === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-rose-50 border-rose-200 text-rose-900'
              }`}
            >
              {feedback.kind === 'success' ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
              )}
              <span className="font-medium leading-snug">{feedback.text}</span>
            </div>
          )}
        </div>

        {/* Liste des revues sauvegardées */}
        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            {t.reviewsDrawer.savedListTitle} ({reviews.length})
          </div>

          {reviews.length === 0 ? (
            <div className="py-12 px-4 text-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 space-y-1.5">
              <FolderOpen className="w-7 h-7 text-slate-300 mx-auto" />
              <p className="text-xs font-semibold text-slate-700">{t.reviewsDrawer.emptyTitle}</p>
              <p className="text-[11px] text-slate-500 max-w-xs mx-auto leading-relaxed">
                {t.reviewsDrawer.emptyDesc}
              </p>
            </div>
          ) : (
            reviews.map((item) => {
              const isActive = item.id === activeReviewId;
              const isConfirmingDelete = confirmDeleteId === item.id;
              const statsLine = t.reviewsDrawer.statsSummary
                .replace('{hits}', item.summary.pubmedHits.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-US'))
                .replace('{screened}', String(item.summary.screenedCount))
                .replace('{rob}', String(item.summary.robAssessedCount));

              return (
                <div
                  key={item.id}
                  className={`p-3.5 rounded-xl border space-y-2.5 transition-colors ${
                    isActive
                      ? 'bg-indigo-50/40 border-indigo-200'
                      : 'bg-white border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h3 className="text-xs font-bold text-slate-900 break-words leading-snug">
                          {item.title}
                        </h3>
                        {isActive && (
                          <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-semibold">
                            {t.reviewsDrawer.activeBadge}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {formatDateTime(item.updatedAt)}
                      </div>
                    </div>

                    <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-700 text-[10px] font-semibold whitespace-nowrap shrink-0">
                      {t.reviewsDrawer.stepBadge.replace('{step}', String(item.wizardStep))}
                    </span>
                  </div>

                  <div className="text-[11px] font-mono text-slate-600 bg-slate-50 px-2.5 py-1.5 rounded-lg border border-slate-100">
                    {statsLine}
                  </div>

                  {isConfirmingDelete ? (
                    <div className="flex items-center justify-end gap-2 pt-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmDeleteId(null);
                          void onDeleteReview(item.id);
                        }}
                        className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-semibold cursor-pointer"
                      >
                        {t.reviewsDrawer.confirmDeleteBtn}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold cursor-pointer"
                      >
                        {t.reviewsDrawer.cancelDeleteBtn}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-2 pt-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          onResumeReview(item);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold cursor-pointer transition-colors"
                      >
                        <Play className="w-3 h-3" />
                        <span>{t.reviewsDrawer.resumeBtn}</span>
                      </button>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleExportJson(item)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold cursor-pointer transition-colors"
                        >
                          <Download className="w-3 h-3 text-slate-500" />
                          <span>{t.reviewsDrawer.exportJsonBtn}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(item.id)}
                          className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-rose-50 hover:border-rose-200 text-slate-500 hover:text-rose-700 cursor-pointer transition-colors"
                          title={t.reviewsDrawer.deleteBtn}
                          aria-label={t.reviewsDrawer.deleteBtn}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
