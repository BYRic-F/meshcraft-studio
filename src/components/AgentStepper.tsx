import { CheckCircle2, Loader2, Search, Cpu, BarChart2, ShieldCheck, ClipboardCheck } from 'lucide-react';

export interface AgentStepperProps {
  readonly currentStep: number;
  readonly stepLogs: Readonly<Record<number, { readonly status: string; readonly message: string }>>;
}

const AGENTS = [
  { id: 1, name: '1. Cadrage PICO', icon: ClipboardCheck },
  { id: 2, name: '2. Résolution MeSH', icon: Search },
  { id: 3, name: '3. Syntaxe Multi-Bases', icon: Cpu },
  { id: 4, name: '4. Requête NCBI Live', icon: BarChart2 },
  { id: 5, name: '5. Audit PRISMA-S', icon: ShieldCheck }
] as const;

export default function AgentStepper({ currentStep, stepLogs }: AgentStepperProps) {
  if (currentStep === 0) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
        {AGENTS.map(agent => {
          const log = stepLogs[agent.id];
          const isDone = currentStep > agent.id || log?.status === 'completed';
          const isCurrent = currentStep === agent.id && !isDone;
          const Icon = agent.icon;

          return (
            <div
              key={agent.id}
              className={`px-3 py-2.5 rounded-lg border text-xs transition-all flex flex-col justify-between ${
                isCurrent
                  ? 'bg-indigo-50/70 border-indigo-400 text-indigo-950 shadow-2xs'
                  : isDone
                    ? 'bg-emerald-50/40 border-emerald-200 text-slate-800'
                    : 'bg-slate-50 border-slate-200/70 text-slate-400 opacity-60'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold leading-snug">
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${isCurrent ? 'text-indigo-600' : isDone ? 'text-emerald-600' : 'text-slate-400'}`} />
                  <span>{agent.name}</span>
                </div>
                {isCurrent && <Loader2 className="w-3.5 h-3.5 text-indigo-600 animate-spin shrink-0" />}
                {isDone && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
              </div>

              {log?.message && (
                <div className="mt-1.5 text-[11px] text-slate-600 whitespace-normal break-words leading-relaxed font-mono">
                  {log.message}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
