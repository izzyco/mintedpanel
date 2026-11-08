// Provider intake hooks. Not org-scoped: the provider has no org context, and
// these keys never enter a persisted cache.
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntakeAnswers, IntakePortal } from "@/lib/intakeAnswers";
import type { DraftStep, HelpReason } from "@/lib/intakeFlow";
import {
  openIntakeSession,
  readIntakeLink,
  readIntakeState,
  removeIntakeDocument,
  requestIntakeCode,
  requestIntakeHelp,
  saveIntakeDraft,
  saveIntakeLogin,
  saveIntakeSsn,
  setIntakeDocumentExpiry,
  signIntakeConsent,
  signOutIntake,
  submitIntake,
  uploadIntakeDocument,
} from "@/services/intake";

export function useIntakeLink(token: string) {
  return useQuery({
    queryKey: ["intake-link", token],
    queryFn: () => readIntakeLink(token),
    retry: false,
    staleTime: Infinity,
  });
}

// Her saved state, read when the form opens and again after a conflict. It
// holds her answers, so it leaves the cache as soon as it is read.
export function useLoadIntakeState(token: string) {
  const qc = useQueryClient();
  return useCallback(
    () =>
      qc.fetchQuery({
        queryKey: ["intake-state", token],
        queryFn: () => readIntakeState(token),
        retry: false,
        staleTime: 0,
        gcTime: 0,
      }),
    [qc, token],
  );
}

export function useRequestIntakeCode() {
  return useMutation({ mutationFn: (token: string) => requestIntakeCode(token) });
}

export function useOpenIntakeSession() {
  return useMutation({
    mutationFn: (vars: { token: string; code: string }) => openIntakeSession(vars.token, vars.code),
  });
}

export function useSaveIntakeDraft() {
  return useMutation({
    mutationFn: (vars: {
      token: string;
      answers: IntakeAnswers;
      step: DraftStep;
      version: number;
    }) => saveIntakeDraft(vars.token, vars.answers, vars.step, vars.version),
  });
}

export function useSignIntakeConsent() {
  return useMutation({
    mutationFn: (vars: { token: string; typedName: string }) =>
      signIntakeConsent(vars.token, vars.typedName),
  });
}

// The full SSN and passwords go straight into the request. A mutation would
// keep them in its variables, so these are plain callbacks.
export function useSaveIntakeSecrets(token: string) {
  return useMemo(
    () => ({
      saveSsn: (ssn: string) => saveIntakeSsn(token, ssn),
      saveLogin: (portal: IntakePortal, username: string, password: string) =>
        saveIntakeLogin(token, portal, username, password),
    }),
    [token],
  );
}

// A mutation would keep each File in its variables after the upload, so
// these are plain callbacks too.
export function useIntakeDocuments(token: string) {
  return useMemo(
    () => ({
      uploadDocument: (
        slot: { key: string; kind: string },
        file: File,
        expiresOn?: string | null,
      ) => uploadIntakeDocument(token, slot, file, expiresOn ?? null),
      removeDocument: (uploadId: string) => removeIntakeDocument(token, uploadId),
      setDocumentExpiry: (uploadId: string, expiresOn: string | null) =>
        setIntakeDocumentExpiry(token, uploadId, expiresOn),
    }),
    [token],
  );
}

export function useSubmitIntake() {
  return useMutation({
    mutationFn: (vars: { token: string; version: number }) =>
      submitIntake(vars.token, vars.version),
  });
}

export function useRequestIntakeHelp() {
  return useMutation({
    mutationFn: (vars: { token: string; reason: HelpReason }) =>
      requestIntakeHelp(vars.token, vars.reason),
  });
}

export function useSignOutIntake() {
  return useMutation({ mutationFn: signOutIntake });
}
