// Tasks card on the case detail page. Sequential lock: a task is locked
// until previous tasks are completed. Row click opens the TaskDrawer.
//
// Slice E (payer-and-cases screen 6): ONE list — the step-at-a-time wizard is
// retired. Each task shows its execution type and due date, and its ordered
// steps render beneath it. The CURRENT step (the first incomplete step of the
// first unfinished task) is marked with an amber dot; on an Auto-fill task whose
// step is a configured portal it also carries an inline "Work in portal" — the
// same launch the drawer offers, one click from the list. Everything else
// (step bodies, Mark-step-done, recovery guidance) lives in the drawer, which
// opens on a row click.
import { useRef, useState } from "react";
import { differenceInDays, parseISO } from "date-fns";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";
import { CheckCircle2, Circle, Lock, Zap } from "lucide-react";
import { fmtDate } from "@/lib/format";
import { useUpdateTaskStatus } from "@/hooks/useTasks";
import { useCanWrite } from "@/lib/permissions";
import { TaskDrawer } from "@/components/cases/TaskDrawer";
import { PortalStepLink, type PortalHandoffContext } from "@/components/portals/PortalStepLink";
import { PayerFormActionRow } from "@/components/cases/PayerFormActionRow";
import { isPayerFormRemoved, taskPayerFormPointer } from "@/lib/payerForms";
import {
  currentStepPointer,
  orderedSteps,
  resolveOpenTaskDrawer,
  summarizeTasks,
} from "@/lib/caseDetailView";
import { EXECUTION_TYPE_LABELS, resolveExecutionType } from "@/lib/executionTypes";
import {
  resolveHandoffFacility,
  shouldShowCaseFacilityPicker,
  stepPortalHandoff,
  type HandoffFacilityLoadState,
  type HandoffFacilityOption,
} from "@/lib/casePortals";
import type { RefreshPdfTokenValues } from "@/hooks/useFreshPdfTokenValues";
import type { Task, TaskStatus } from "@/types";

export interface CasePortalHandoffData {
  caseId: string;
  providerId: string;
  orgId: string;
  caseType?: string | null;
  caseStatus?: PortalHandoffContext["caseStatus"];
  contextVersion?: number;
  payerId?: string;
  caseFacilityId: string | null;
  facilityLoadState: HandoffFacilityLoadState;
  facilities: HandoffFacilityOption[];
  selectedFacilityId: string | undefined;
  onSelectFacility: (facilityId: string) => void;
}

function ExecutionTypeLabel({ executionType }: { executionType: Task["executionType"] }) {
  const type = resolveExecutionType(executionType);
  const label = EXECUTION_TYPE_LABELS[type];
  if (type !== "extension_fill") {
    return <span className="text-[12px] font-medium text-muted-foreground">{label}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex items-center gap-1 rounded-sm text-[12px] font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Zap className="h-3 w-3" aria-hidden />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>The Minted extension can fill this form.</TooltipContent>
    </Tooltip>
  );
}

function taskStatusIcon(status: Task["status"], locked: boolean) {
  if (locked) return <Lock className="w-4 h-4 text-muted-foreground" />;
  if (status === "completed") return <CheckCircle2 className="w-4 h-4 text-[#059669]" />;
  if (status === "in_progress") return <Circle className="w-4 h-4 text-[#D97706] fill-[#FEF3C7]" />;
  if (status === "blocked") return <Lock className="w-4 h-4 text-[#DC2626]" />;
  return <Circle className="w-4 h-4 text-muted-foreground" />;
}

export function CaseTasksPanel({
  tasks: allTasks,
  tokenValues,
  refreshPdfTokenValues,
  pdfContextKey,
  groupId = null,
  providerName = "this provider",
  groupName = null,
  payerName = null,
  state = null,
  portalHandoff,
}: {
  tasks: Task[];
  /** token -> value map for the drawer's pdf-step filler (built by the case page). */
  tokenValues?: Record<string, string>;
  refreshPdfTokenValues?: RefreshPdfTokenValues;
  pdfContextKey?: string;
  /** ASD — the case's group, threaded to the drawer's step-artifact panel
   * and Active Documents rail. */
  groupId?: string | null;
  providerName?: string;
  groupName?: string | null;
  payerName?: string | null;
  state?: string | null;
  portalHandoff?: CasePortalHandoffData;
}) {
  const canEdit = useCanWrite();
  const updateStatusM = useUpdateTaskStatus();
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reopenTask, setReopenTask] = useState<Task | null>(null);
  const undoRef = useRef<Set<string>>(new Set());
  const drawerPortalHandoff: PortalHandoffContext | undefined = portalHandoff
    ? portalHandoff
    : undefined;
  const caseFacilityResolution = portalHandoff
    ? resolveHandoffFacility(
        portalHandoff.facilityLoadState,
        portalHandoff.facilities,
        portalHandoff.caseFacilityId,
        portalHandoff.selectedFacilityId,
      )
    : null;
  const showCaseFacilityPicker = Boolean(
    portalHandoff &&
    caseFacilityResolution &&
    shouldShowCaseFacilityPicker(
      portalHandoff.facilityLoadState,
      portalHandoff.facilities,
      caseFacilityResolution,
    ),
  );
  // Payer PDF — a removed payer form is off this case for good, so it drops out
  // BEFORE anything derives from the list: the summary counts, the sequential
  // lock, and the current-step pointer must all behave as though it was never
  // attached. The row itself is untouched (status blocked + a removal marker on
  // its own sop_content), which is where the "who removed it, when, and why"
  // record lives.
  const tasks = allTasks.filter((t) => !isPayerFormRemoved(t.sopContent));
  const summary = summarizeTasks(tasks);
  const currentStep = currentStepPointer(tasks);
  const drawerTask = resolveOpenTaskDrawer(tasks, drawerTaskId);

  const openDrawer = (task: Task) => {
    setDrawerTaskId(task.id);
    setDrawerOpen(true);
  };

  const reopenConfirm = () => {
    const t = reopenTask;
    if (!t) return;
    setReopenTask(null);
    updateStatusM.mutate(
      { id: t.id, status: "in_progress" },
      {
        onSuccess: () => toast.success(`Reopened "${t.title}"`),
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "Could not reopen task"),
      },
    );
  };

  const completeWithUndo = (task: Task) => {
    if (!canEdit) return;
    if (task.status === "completed") return;
    const previous: TaskStatus = task.status;
    updateStatusM.mutate(
      { id: task.id, status: "completed" },
      {
        onSuccess: () => {
          toast.success(`Completed "${task.title}"`, {
            action: {
              label: "Undo",
              onClick: () => {
                if (undoRef.current.has(task.id)) return;
                undoRef.current.add(task.id);
                updateStatusM.mutate(
                  { id: task.id, status: previous },
                  {
                    onSettled: () => undoRef.current.delete(task.id),
                    onError: (err: unknown) =>
                      toast.error(err instanceof Error ? err.message : "Could not undo"),
                  },
                );
              },
            },
          });
        },
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "Could not complete task"),
      },
    );
  };

  return (
    <>
      <Card className="shadow-none border-border">
        <CardHeader className="p-4 pb-2 border-b border-border flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-[14px] font-semibold">Tasks</CardTitle>
          <div className="flex min-w-0 items-center gap-3">
            {showCaseFacilityPicker && portalHandoff ? (
              <div className="flex items-center gap-2">
                <label className="text-[12px] font-medium text-muted-foreground">
                  Fill location
                </label>
                <Select
                  value={
                    caseFacilityResolution?.status === "ready"
                      ? caseFacilityResolution.facilityId
                      : undefined
                  }
                  onValueChange={portalHandoff.onSelectFacility}
                >
                  <SelectTrigger className="h-8 w-[190px] shadow-none" aria-label="Fill location">
                    <SelectValue placeholder="Choose a location" />
                  </SelectTrigger>
                  <SelectContent>
                    {portalHandoff.facilities.map((facility) => (
                      <SelectItem key={facility.id} value={facility.id}>
                        {facility.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {summary.completed} of {summary.total} completed
              {summary.nextDueDate ? ` · next due ${fmtDate(summary.nextDueDate)}` : ""}
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {tasks.length === 0 ? (
            <div className="p-6">
              <EmptyState message="No tasks yet" />
            </div>
          ) : (
            <div className="divide-y divide-border">
              {tasks.map((t, idx) => {
                const previousIncomplete = tasks
                  .slice(0, idx)
                  .some((p) => p.status !== "completed");
                const locked = previousIncomplete && t.status !== "completed";
                const overdue =
                  t.status !== "completed" &&
                  t.dueDate &&
                  differenceInDays(new Date(), parseISO(t.dueDate)) > 0;

                const canComplete = canEdit && !locked && t.status !== "completed";
                const canReopen = canEdit && t.status === "completed";
                const circleInteractive = canComplete || canReopen;

                const row = (
                  <div
                    className={`p-3 flex items-center gap-3 text-[13px] ${
                      locked ? "opacity-60 cursor-not-allowed" : "hover:bg-muted/30 cursor-pointer"
                    }`}
                    onClick={() => {
                      if (locked) {
                        openDrawer(t);
                        return;
                      }
                      openDrawer(t);
                    }}
                  >
                    <button
                      type="button"
                      className={`flex-shrink-0 -m-1 p-1 rounded ${
                        circleInteractive
                          ? "hover:bg-[#1B4D3E]/10 cursor-pointer"
                          : "cursor-default"
                      }`}
                      aria-label={
                        canComplete
                          ? `Complete ${t.title}`
                          : canReopen
                            ? `Reopen ${t.title}`
                            : `Status ${t.status}`
                      }
                      disabled={!circleInteractive || updateStatusM.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (canComplete) {
                          completeWithUndo(t);
                          return;
                        }
                        if (canReopen) {
                          setReopenTask(t);
                        }
                      }}
                    >
                      {taskStatusIcon(t.status, locked)}
                    </button>
                    <div
                      className={`flex-1 min-w-0 ${
                        t.status === "completed"
                          ? "text-muted-foreground"
                          : "text-foreground font-medium"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={t.status === "completed" ? "line-through" : ""}>
                          {t.title}
                        </span>
                        {/* The execution type rides every task row as a plain
                            label — no border or fill, so it can't read as a
                            button. Auto-fill explains itself on hover/focus. */}
                        <ExecutionTypeLabel executionType={t.executionType} />
                        {t.status === "blocked" ? (
                          <StatusPill status="red" label="Blocked" />
                        ) : null}
                      </div>
                      {t.status === "completed" && t.completedDate ? (
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          Completed {fmtDate(t.completedDate)}
                        </div>
                      ) : null}
                    </div>
                    <span
                      className={`w-20 text-right tabular-nums text-[12px] ${
                        overdue ? "text-[#DC2626] font-semibold" : "text-muted-foreground"
                      }`}
                    >
                      {t.dueDate ? fmtDate(t.dueDate) : "TBD"}
                    </span>
                  </div>
                );

                const steps = orderedSteps(t);
                // A Payer PDF action gets its own controls instead of the step
                // list: its single step would read "Send payer form" and carry
                // no affordance, while what the coordinator actually needs is
                // the file, a way to say it went out, and a way to drop it.
                const payerFormPointer = taskPayerFormPointer(t.sopContent);
                const body = (
                  <div>
                    {row}
                    {payerFormPointer && !locked ? (
                      <PayerFormActionRow
                        task={t}
                        pointer={payerFormPointer}
                        canEdit={canEdit}
                        tokenValues={tokenValues}
                        refreshTokenValues={refreshPdfTokenValues}
                        pdfContextKey={pdfContextKey ?? ""}
                      />
                    ) : null}
                    {!payerFormPointer && steps.length > 0 && !locked ? (
                      <ul className="space-y-1.5 px-3 pb-3 pl-11">
                        {steps.map((s, stepIndex) => {
                          const isCurrent =
                            currentStep?.taskId === t.id && currentStep?.stepId === s.id;
                          return (
                            <li
                              key={s.id}
                              className="flex flex-wrap items-center gap-2 text-[13px]"
                            >
                              <span
                                aria-hidden
                                className={`h-1.5 w-1.5 flex-none rounded-full ${
                                  s.isCompleted
                                    ? "bg-[#059669]"
                                    : isCurrent
                                      ? "bg-[#D97706]"
                                      : "bg-border"
                                }`}
                              />
                              <span
                                className={
                                  s.isCompleted ? "text-muted-foreground" : "text-foreground"
                                }
                              >
                                {s.label}
                              </span>
                              {isCurrent &&
                              resolveExecutionType(t.executionType) === "extension_fill" ? (
                                <PortalStepLink
                                  portalKey={s.portalKey}
                                  handoff={stepPortalHandoff(
                                    drawerPortalHandoff,
                                    t,
                                    steps,
                                    stepIndex,
                                    locked,
                                  )}
                                  presentation="inline"
                                  onOpenTask={() => openDrawer(t)}
                                />
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                );

                return locked ? (
                  <Tooltip key={t.id}>
                    <TooltipTrigger asChild>
                      <div>{body}</div>
                    </TooltipTrigger>
                    <TooltipContent>Complete previous task first</TooltipContent>
                  </Tooltip>
                ) : (
                  <div key={t.id}>{body}</div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <TaskDrawer
        taskId={drawerTask?.task.id ?? null}
        fallbackTask={drawerTask?.task ?? null}
        locked={drawerTask?.locked ?? false}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        tokenValues={tokenValues}
        refreshTokenValues={refreshPdfTokenValues}
        pdfContextKey={pdfContextKey}
        groupId={groupId}
        caseTasks={tasks}
        providerName={providerName}
        groupName={groupName}
        payerName={payerName}
        state={state}
        portalHandoff={drawerPortalHandoff}
      />

      <Dialog
        open={reopenTask !== null}
        onOpenChange={(o) => {
          if (!o) setReopenTask(null);
        }}
      >
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Reopen this task?</DialogTitle>
            <DialogDescription>It will move back to In progress.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenTask(null)}>
              Cancel
            </Button>
            <Button
              className="bg-[#1B4D3E] hover:bg-[#1B4D3E]/90 text-white"
              onClick={reopenConfirm}
              disabled={updateStatusM.isPending}
            >
              Reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
